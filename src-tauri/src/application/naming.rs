//! Anwendungsfälle: neuen Ordner anlegen und Ordner oder Objekte umbenennen.
//!
//! S3 kennt kein Umbenennen. Ein neuer Name heißt: alles auf dem Server kopieren (über 5 GiB
//! per Multipart-Copy) und erst danach die Originale löschen. Scheitert eine Kopie, bleiben
//! alle Originale unangetastet.

use super::cancel::CancelFlag;
use super::copy::{CopySettings, copy_object_any};
use super::deletion::{DeletePlan, DeleteSettings, execute_plan};
use super::error::AppError;
use super::listing::{key_taken, list_all};
use super::parts::PartProgress;
use super::upload::ResumeState;
use crate::domain::error::StoreError;
use crate::domain::naming::{RenameOutcome, RenameProgress, child_key, renamed_key};
use crate::domain::transfer::{ObjectRef, SelectedItem};
use crate::ports::{ObjectStore, StoreProvider};
use futures_util::{StreamExt, TryStreamExt, stream};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NamingSettings {
    /// Gleichzeitige Kopien beim Umbenennen von Ordnern
    pub copies_parallel: usize,
    pub copy: CopySettings,
    pub delete: DeleteSettings,
}

impl Default for NamingSettings {
    fn default() -> Self {
        Self {
            copies_parallel: 8,
            copy: CopySettings::default(),
            delete: DeleteSettings::default(),
        }
    }
}

/// Legt im Ordner `prefix` den Ordner `name` an und liefert seinen Key.
///
/// # Errors
/// Ungültiger Name, Name schon vergeben oder Fehler des Stores.
pub async fn create_folder<S: ObjectStore>(
    store: &S,
    bucket: &str,
    prefix: &str,
    name: &str,
) -> Result<String, AppError> {
    let key = child_key(prefix, name, true)?;
    ensure_free(store, bucket, &key, name).await?;
    store.put_empty(bucket, &key).await?;
    Ok(key)
}

/// Benennt eine Datei oder einen Ordner im selben Ordner um.
///
/// # Errors
/// Ungültiger Name, Name schon vergeben oder eine gescheiterte Kopie. Originale, die sich
/// danach nicht löschen lassen, stehen im Ergebnis und sind kein Fehler.
pub async fn rename<S: ObjectStore>(
    store: &S,
    bucket: &str,
    item: &SelectedItem,
    new_name: &str,
    settings: &NamingSettings,
    on_progress: impl Fn(RenameProgress),
) -> Result<RenameOutcome, AppError> {
    let new_key = renamed_key(&item.key, new_name)?;
    if new_key == item.key {
        return Ok(RenameOutcome { new_key, undeleted: 0 });
    }
    ensure_free(store, bucket, &new_key, new_name).await?;
    let sources = sources(store, bucket, item).await?;
    let run = CopyRun {
        store,
        bucket,
        from: &item.key,
        to: &new_key,
        settings,
        copied: AtomicU64::new(0),
        total: u64::try_from(sources.len()).unwrap_or(u64::MAX),
        on_progress: &on_progress,
    };
    stream::iter(0..sources.len())
        .map(|index| run.copy(&sources[index]))
        .buffer_unordered(settings.copies_parallel.max(1))
        .try_collect::<Vec<()>>()
        .await?;
    let plan = DeletePlan {
        bucket: bucket.to_owned(),
        keys: sources.into_iter().map(|(key, _)| key).collect(),
        bytes: 0,
        versioned: None,
    };
    let outcome = execute_plan(store, &plan, &settings.delete, &CancelFlag::default(), |_| {}).await?;
    Ok(RenameOutcome {
        new_key,
        undeleted: outcome.failed_count,
    })
}

/// Kopiert die Objekte unter `from` nach `to` und zählt mit.
struct CopyRun<'a, S, F> {
    store: &'a S,
    bucket: &'a str,
    from: &'a str,
    to: &'a str,
    settings: &'a NamingSettings,
    copied: AtomicU64,
    total: u64,
    on_progress: &'a F,
}

impl<S: ObjectStore, F: Fn(RenameProgress)> CopyRun<'_, S, F> {
    async fn copy(&self, (key, size): &(String, u64)) -> Result<(), StoreError> {
        let source = object(self.bucket, key);
        let target = object(self.bucket, &format!("{}{}", self.to, &key[self.from.len()..]));
        let (progress, uploads) = (PartProgress::default(), ResumeState::default());
        copy_object_any(
            self.store,
            &source,
            &target,
            *size,
            &self.settings.copy,
            &progress,
            &uploads,
        )
        .await?;
        let copied = self.copied.fetch_add(1, Ordering::Relaxed) + 1;
        (self.on_progress)(RenameProgress {
            copied,
            total: self.total,
        });
        Ok(())
    }
}

/// Fehler, wenn unter `key` schon etwas liegt.
async fn ensure_free<S: ObjectStore>(store: &S, bucket: &str, key: &str, name: &str) -> Result<(), AppError> {
    if key_taken(store, bucket, key).await? {
        return Err(AppError::NameTaken(name.to_owned()));
    }
    Ok(())
}

/// Alle zu kopierenden Objekte mit Größe: die Datei selbst oder alles unter dem Ordner.
async fn sources<S: ObjectStore>(
    store: &S,
    bucket: &str,
    item: &SelectedItem,
) -> Result<Vec<(String, u64)>, StoreError> {
    if !item.is_folder {
        return Ok(vec![(item.key.clone(), item.size)]);
    }
    let mut sources = Vec::new();
    list_all(store, item.folder_listing(bucket)?, &CancelFlag::default(), |page| {
        sources.extend(page.objects.into_iter().map(|o| (o.key, o.size)));
    })
    .await?;
    Ok(sources)
}

fn object(bucket: &str, key: &str) -> ObjectRef {
    ObjectRef {
        bucket: bucket.to_owned(),
        key: key.to_owned(),
        content_type: None,
    }
}

/// Ordner anlegen und umbenennen für gespeicherte Verbindungen.
#[derive(Debug)]
pub struct NamingService<P> {
    provider: P,
    settings: NamingSettings,
}

impl<P: StoreProvider> NamingService<P> {
    pub fn new(provider: P, settings: NamingSettings) -> Self {
        Self { provider, settings }
    }

    /// # Errors
    /// Unbekanntes Profil oder wie `create_folder`.
    pub async fn create_folder(
        &self,
        profile_id: &str,
        bucket: &str,
        prefix: &str,
        name: &str,
    ) -> Result<String, AppError> {
        let store = self.provider.store_for(profile_id)?;
        create_folder(store.as_ref(), bucket, prefix, name).await
    }

    /// # Errors
    /// Unbekanntes Profil oder wie `rename`.
    pub async fn rename(
        &self,
        profile_id: &str,
        bucket: &str,
        item: &SelectedItem,
        new_name: &str,
        on_progress: impl Fn(RenameProgress),
    ) -> Result<RenameOutcome, AppError> {
        let store = self.provider.store_for(profile_id)?;
        rename(store.as_ref(), bucket, item, new_name, &self.settings, on_progress).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::parts::RetryPolicy;
    use crate::application::test_support::{FakeProvider, FakeStore, TransferCall};
    use crate::domain::error::ServiceError;
    use crate::domain::multipart::{MAX_PART_SIZE, MIB};
    use crate::domain::naming::NameError;
    use crate::domain::object::{ListPage, ObjectEntry};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    fn entry(key: &str, size: u64) -> ObjectEntry {
        ObjectEntry {
            size,
            ..FakeStore::object(key)
        }
    }

    fn page(objects: Vec<ObjectEntry>) -> ListPage {
        ListPage {
            objects,
            prefixes: vec![],
            next_token: None,
        }
    }

    fn item(key: &str, size: u64) -> SelectedItem {
        SelectedItem {
            key: key.into(),
            is_folder: key.ends_with('/'),
            size,
            etag: None,
            last_modified_ms: None,
        }
    }

    fn settings() -> NamingSettings {
        let retry = RetryPolicy {
            retries: 1,
            delay: Duration::from_millis(1),
        };
        NamingSettings {
            copies_parallel: 2,
            copy: CopySettings {
                part_size: 5 * MIB,
                retry,
            },
            delete: DeleteSettings {
                batches_parallel: 1,
                retry,
            },
        }
    }

    fn denied() -> StoreError {
        StoreError::Service(ServiceError {
            code: "AccessDenied".into(),
            message: String::new(),
            http_status: 403,
            request_id: None,
        })
    }

    #[tokio::test]
    async fn creates_folder_placeholders_when_the_name_is_free() {
        let store = FakeStore::with_pages(vec![page(vec![])]);
        let key = create_folder(&store, "b", "a/", "neu").await.unwrap();
        assert_eq!(key, "a/neu/");
        assert_eq!(store.upload_calls(), [TransferCall::PutEmpty { key: "a/neu/".into() }]);
        let check = &store.requests()[0];
        assert_eq!(
            (check.prefix.as_str(), check.max_keys, check.delimiter.as_deref()),
            ("a/neu/", Some(1), None)
        );
    }

    #[tokio::test]
    async fn refuses_taken_and_invalid_names() {
        let store = FakeStore::with_pages(vec![page(vec![entry("a/neu/x.txt", 1)])]);
        let taken = create_folder(&store, "b", "a/", "neu").await;
        assert_eq!(taken, Err(AppError::NameTaken("neu".into())));
        let invalid = create_folder(&store, "b", "a/", "x/y").await;
        assert_eq!(invalid, Err(AppError::InvalidName(NameError::Slash)));
        assert_eq!(store.upload_calls(), Vec::new());
    }

    #[tokio::test]
    async fn renames_files_by_copying_then_deleting() {
        let store = FakeStore::with_pages(vec![page(vec![entry("a/d.txt.bak", 1)])]);
        let outcome = rename(&store, "b", &item("a/c.txt", 10), "d.txt", &settings(), |_| {})
            .await
            .unwrap();
        assert_eq!(
            outcome,
            RenameOutcome {
                new_key: "a/d.txt".into(),
                undeleted: 0
            }
        );
        assert_eq!(
            store.upload_calls(),
            [
                TransferCall::Copy {
                    from: "a/c.txt".into(),
                    to: "a/d.txt".into()
                },
                TransferCall::Delete {
                    keys: vec!["a/c.txt".into()]
                },
            ]
        );
    }

    #[tokio::test]
    async fn renames_folders_with_everything_below_and_reports_progress() {
        let store = FakeStore::with_pages(vec![
            page(vec![]),
            page(vec![
                entry("a/alt/", 0),
                entry("a/alt/x.txt", 1),
                entry("a/alt/u/y.txt", 2),
            ]),
        ]);
        let progress = Mutex::new(Vec::new());
        let outcome = rename(&store, "b", &item("a/alt/", 0), "neu", &settings(), |p| {
            progress.lock().unwrap().push(p);
        })
        .await
        .unwrap();
        assert_eq!(outcome.new_key, "a/neu/");
        let mut copies: Vec<(String, String)> = store
            .upload_calls()
            .into_iter()
            .filter_map(|c| match c {
                TransferCall::Copy { from, to } => Some((from, to)),
                _ => None,
            })
            .collect();
        copies.sort();
        assert_eq!(
            copies,
            [
                ("a/alt/".to_owned(), "a/neu/".to_owned()),
                ("a/alt/u/y.txt".to_owned(), "a/neu/u/y.txt".to_owned()),
                ("a/alt/x.txt".to_owned(), "a/neu/x.txt".to_owned()),
            ]
        );
        assert_eq!(store.deleted_batches()[0].len(), 3);
        assert_eq!(
            progress.lock().unwrap().last(),
            Some(&RenameProgress { copied: 3, total: 3 })
        );
    }

    #[tokio::test]
    async fn keeps_all_originals_when_a_copy_fails() {
        let store = FakeStore::with_pages(vec![page(vec![])]);
        store.fail_next(vec![denied()]);
        let result = rename(&store, "b", &item("a/c.txt", 10), "d.txt", &settings(), |_| {}).await;
        assert_eq!(result, Err(AppError::Store(denied())));
        assert_eq!(store.deleted_batches(), Vec::<Vec<String>>::new());
    }

    #[tokio::test]
    async fn reports_originals_that_could_not_be_deleted() {
        let store = FakeStore::with_pages(vec![page(vec![])]);
        store.refuse_deleting(&["a/c.txt"]);
        let outcome = rename(&store, "b", &item("a/c.txt", 10), "d.txt", &settings(), |_| {})
            .await
            .unwrap();
        assert_eq!(outcome.undeleted, 1);
    }

    #[tokio::test]
    async fn treats_the_same_name_as_done_and_checks_taken_names() {
        let store = FakeStore::default();
        let same = rename(&store, "b", &item("a/c.txt", 1), "c.txt", &settings(), |_| {}).await;
        assert_eq!(same.unwrap().new_key, "a/c.txt");
        assert_eq!(store.upload_calls(), Vec::new());

        let store = FakeStore::with_pages(vec![page(vec![entry("a/d.txt", 1)])]);
        let taken = rename(&store, "b", &item("a/c.txt", 1), "d.txt", &settings(), |_| {}).await;
        assert_eq!(taken, Err(AppError::NameTaken("d.txt".into())));
    }

    #[tokio::test]
    async fn copies_objects_over_5_gib_in_parts() {
        let store = FakeStore::with_pages(vec![page(vec![])]);
        let size = MAX_PART_SIZE + 3 * MIB;
        let settings = NamingSettings {
            copy: CopySettings {
                part_size: 2 * 1024 * MIB,
                ..settings().copy
            },
            ..settings()
        };
        rename(&store, "b", &item("gross.iso", size), "neu.iso", &settings, |_| {})
            .await
            .unwrap();
        let calls = store.upload_calls();
        assert_eq!(calls[0], TransferCall::Create);
        let parts: Vec<(u32, u64, u64)> = calls
            .iter()
            .filter_map(|c| match c {
                TransferCall::PartCopy { number, offset, length } => Some((*number, *offset, *length)),
                _ => None,
            })
            .collect();
        let gib = 1024 * MIB;
        assert_eq!(
            parts,
            [(1, 0, 2 * gib), (2, 2 * gib, 2 * gib), (3, 4 * gib, gib + 3 * MIB)]
        );
        assert_eq!(calls[4], TransferCall::Complete { parts: vec![1, 2, 3] });
    }

    #[tokio::test]
    async fn aborts_failed_multipart_copies() {
        let store = FakeStore::with_pages(vec![page(vec![])]);
        store.fail_next(vec![denied()]);
        store.succeed_first(1);
        let result = rename(
            &store,
            "b",
            &item("gross.iso", MAX_PART_SIZE + 1),
            "x.iso",
            &settings(),
            |_| {},
        )
        .await;
        assert!(result.is_err());
        assert_eq!(store.upload_calls().last(), Some(&TransferCall::Abort));
    }

    #[tokio::test]
    async fn serves_saved_profiles() {
        let store = Arc::new(FakeStore::with_pages(vec![page(vec![]), page(vec![])]));
        let service = NamingService::new(FakeProvider::new(Arc::clone(&store)), settings());
        assert_eq!(service.create_folder("p1", "b", "", "x").await.unwrap(), "x/");
        let outcome = service.rename("p1", "b", &item("y", 1), "z", |_| {}).await.unwrap();
        assert_eq!(outcome.new_key, "z");
        service.provider.make_unavailable();
        assert!(matches!(
            service.create_folder("p1", "b", "", "x").await,
            Err(AppError::ProfileNotFound(_))
        ));
    }
}
