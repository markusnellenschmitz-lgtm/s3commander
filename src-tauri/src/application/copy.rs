//! Kopieren und Verschieben von Objekten. Innerhalb einer Verbindung auf dem Server, zwischen
//! zwei Verbindungen über den Rechner (siehe `relay`).
//!
//! - Bis 5 GiB kopiert eine Anfrage (`CopyObject`), darüber Teile per `UploadPartCopy`.
//!   Die Daten fließen nur innerhalb des Dienstes, nicht über den Rechner.
//! - Verschieben löscht jedes Original erst, nachdem seine Kopie bestätigt ist.
//! - Nichts wird überschrieben: Ist ein Name im Ziel belegt, bekommt die Kopie einen
//!   nummerierten Namen wie `bericht (2).pdf`.

use super::cancel::CancelFlag;
use super::error::AppError;
use super::listing::{key_taken, list_all};
use super::parts::{PartProgress, RetryPolicy, part_numbers, part_range, with_retries};
use super::upload::ResumeState;
use crate::domain::error::{ServiceError, StoreError};
use crate::domain::multipart::{MAX_SINGLE_PUT_SIZE, MIB, PartPlan};
use crate::domain::naming::{base_name, numbered_name, parent_prefix};
use crate::domain::object::ListRequest;
use crate::domain::transfer::{Checksums, CompletedPart, ObjectRef, SelectedItem};
use crate::ports::ObjectStore;

/// Teilgröße beim serverseitigen Kopieren großer Objekte; es fließen keine Daten über die Leitung.
pub const COPY_PART_SIZE: u64 = 512 * MIB;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CopySettings {
    pub part_size: u64,
    pub retry: RetryPolicy,
}

impl Default for CopySettings {
    fn default() -> Self {
        Self {
            part_size: COPY_PART_SIZE,
            retry: RetryPolicy::default(),
        }
    }
}

/// Ein zu kopierendes Objekt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyJob {
    pub source: ObjectRef,
    pub target: ObjectRef,
    pub size: u64,
    /// Verschieben: das Original nach der Kopie löschen.
    pub delete_source: bool,
    /// Verbindung der Quelle, wenn sie eine andere als die des Ziels ist; dann gibt es keine
    /// Server-Kopie, und die Daten laufen über den Rechner.
    pub relay_from: Option<String>,
}

/// Woher eingefügt wird: gewählte Einträge in einem Bucket einer Verbindung.
#[derive(Debug, Clone, Copy)]
pub struct CopySource<'a> {
    pub profile_id: &'a str,
    pub bucket: &'a str,
    pub items: &'a [SelectedItem],
}

/// Wohin eingefügt wird: ein Ordner (Präfix) in einem Bucket einer Verbindung.
#[derive(Debug, Clone, Copy)]
pub struct CopyTarget<'a> {
    pub profile_id: &'a str,
    pub bucket: &'a str,
    pub prefix: &'a str,
}

/// Löst die Auswahl in einzelne Kopien auf. Ordner werden in `sources` rekursiv gelistet; belegte
/// Namen in `targets` werden nummeriert. Verschieben in den eigenen Ordner ist nichts zu tun.
///
/// # Errors
/// `CopyIntoItself`, wenn ein Ordner in sich selbst eingefügt würde, sonst Fehler des Stores.
pub async fn resolve_copies<S: ObjectStore, T: ObjectStore>(
    sources: &S,
    targets: &T,
    source: CopySource<'_>,
    target: CopyTarget<'_>,
    delete_source: bool,
) -> Result<Vec<CopyJob>, AppError> {
    let same_connection = source.profile_id == target.profile_id;
    let same_bucket = same_connection && source.bucket == target.bucket;
    let relay_from = (!same_connection).then(|| source.profile_id.to_owned());
    let mut jobs = Vec::new();
    for item in source.items {
        if same_bucket && delete_source && parent_prefix(&item.key) == target.prefix {
            continue;
        }
        if same_bucket && item.is_folder && target.prefix.starts_with(&item.key) {
            return Err(AppError::CopyIntoItself(base_name(&item.key).to_owned()));
        }
        let top = free_key(targets, target, base_name(&item.key), item.is_folder).await?;
        let mut add = |key: String, size: u64| {
            let target_key = format!("{top}{}", &key[item.key.len()..]);
            jobs.push(CopyJob {
                source: object(source.bucket, key),
                target: object(target.bucket, target_key),
                size,
                delete_source,
                relay_from: relay_from.clone(),
            });
        };
        if item.is_folder {
            let request = ListRequest::recursive(source.bucket, &item.key);
            list_all(sources, request, &CancelFlag::default(), |page| {
                for entry in page.objects {
                    add(entry.key, entry.size);
                }
            })
            .await?;
        } else {
            add(item.key.clone(), item.size);
        }
    }
    Ok(jobs)
}

/// Erster freier Key für `name` im Ziel: `name`, sonst `name (2)`, `name (3)` …
async fn free_key<S: ObjectStore>(
    store: &S,
    target: CopyTarget<'_>,
    name: &str,
    is_folder: bool,
) -> Result<String, StoreError> {
    let suffix = if is_folder { "/" } else { "" };
    for number in 1..=u32::MAX {
        let candidate = if number == 1 {
            name.to_owned()
        } else {
            numbered_name(name, number)
        };
        let key = format!("{}{candidate}{suffix}", target.prefix);
        if !key_taken(store, target.bucket, &key).await? {
            return Ok(key);
        }
    }
    Err(StoreError::InvalidConfig(format!("Kein freier Name für {name}")))
}

/// Kopiert (und verschiebt) ein Objekt; Abbruch wirkt sofort.
///
/// # Errors
/// `Cancelled` nach Abbruch, sonst der letzte Fehler von Kopie oder Löschen.
pub async fn run_copy<S: ObjectStore>(
    store: &S,
    job: &CopyJob,
    settings: &CopySettings,
    progress: &PartProgress,
    uploads: &ResumeState,
    cancel: &CancelFlag,
) -> Result<(), StoreError> {
    let work = async {
        copy_object_any(store, &job.source, &job.target, job.size, settings, progress, uploads).await?;
        if job.delete_source {
            delete_original(store, &job.source, &settings.retry, cancel).await?;
        }
        Ok(())
    };
    tokio::select! {
        result = work => result,
        () = cancel.cancelled() => Err(StoreError::Cancelled),
    }
}

/// Kopiert auf dem Server: bis 5 GiB mit einer Anfrage, darüber per Multipart-Copy.
/// Die `UploadId` einer laufenden Multipart-Kopie steht in `uploads`, damit ein Abbruch sie
/// verwerfen kann.
///
/// # Errors
/// Der letzte Fehler, wenn die Wiederholungen ausgeschöpft sind.
pub async fn copy_object_any<S: ObjectStore>(
    store: &S,
    source: &ObjectRef,
    target: &ObjectRef,
    size: u64,
    settings: &CopySettings,
    progress: &PartProgress,
    uploads: &ResumeState,
) -> Result<(), StoreError> {
    let cancel = CancelFlag::default();
    let plan = PartPlan::for_upload(size, settings.part_size, MAX_SINGLE_PUT_SIZE + 1)?;
    progress.reset(plan.part_count());
    if plan == PartPlan::Single {
        with_retries(&settings.retry, &cancel, || store.copy_object(source, target)).await?;
        progress.credit(size);
        return Ok(());
    }
    // Server-Kopien prüft der Dienst selbst; die Teile tragen keine eigenen Prüfsummen.
    let upload_id = with_retries(&settings.retry, &cancel, || {
        store.create_multipart_upload(target, Checksums::Off)
    })
    .await?;
    uploads.set(Some(upload_id.clone()));
    let result = copy_parts(store, source, target, &upload_id, &plan, size, settings, progress).await;
    if result.is_err() {
        // Bestmöglich aufräumen; der ursprüngliche Fehler ist wichtiger.
        let _ = store.abort_multipart_upload(target, &upload_id).await;
    }
    uploads.set(None);
    result
}

#[allow(clippy::too_many_arguments)] // Bündelt nur Referenzen auf den Kopier-Kontext.
pub(crate) async fn copy_parts<S: ObjectStore>(
    store: &S,
    source: &ObjectRef,
    target: &ObjectRef,
    upload_id: &str,
    plan: &PartPlan,
    size: u64,
    settings: &CopySettings,
    progress: &PartProgress,
) -> Result<(), StoreError> {
    let cancel = CancelFlag::default();
    let mut parts = Vec::new();
    for number in part_numbers(plan) {
        let range = part_range(plan, size, number);
        let etag = with_retries(&settings.retry, &cancel, || {
            store.upload_part_copy(target, upload_id, number, source, range)
        })
        .await?;
        progress.credit(range.1);
        parts.push(CompletedPart::new(number, etag));
    }
    with_retries(&settings.retry, &cancel, || {
        store.complete_multipart_upload(target, upload_id, &parts)
    })
    .await?;
    Ok(())
}

/// Löscht das Original nach einer bestätigten Kopie.
pub(crate) async fn delete_original<S: ObjectStore>(
    store: &S,
    source: &ObjectRef,
    retry: &RetryPolicy,
    cancel: &CancelFlag,
) -> Result<(), StoreError> {
    let keys = [source.key.clone()];
    let failures = with_retries(retry, cancel, || store.delete_objects(&source.bucket, &keys)).await?;
    match failures.into_iter().next() {
        // DeleteObjects meldet Teilfehler mit HTTP 200.
        Some(failure) => Err(StoreError::Service(ServiceError {
            code: failure.code,
            message: format!(
                "Kopiert, aber das Original ließ sich nicht löschen: {}",
                failure.message
            ),
            http_status: 200,
            request_id: None,
        })),
        None => Ok(()),
    }
}

fn object(bucket: &str, key: String) -> ObjectRef {
    ObjectRef {
        bucket: bucket.to_owned(),
        key,
        content_type: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::test_support::{FakeStore, TransferCall};
    use crate::domain::multipart::MAX_PART_SIZE;
    use crate::domain::object::{ListPage, ObjectEntry};
    use std::time::Duration;

    fn page(keys: &[&str]) -> ListPage {
        ListPage {
            objects: keys.iter().map(|k| FakeStore::object(k)).collect(),
            ..ListPage::default()
        }
    }

    fn free() -> ListPage {
        ListPage::default()
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

    fn settings() -> CopySettings {
        CopySettings {
            part_size: 2 * 1024 * MIB,
            retry: RetryPolicy {
                retries: 1,
                delay: Duration::from_millis(1),
            },
        }
    }

    fn pairs(jobs: &[CopyJob]) -> Vec<(String, String)> {
        jobs.iter()
            .map(|j| {
                (
                    format!("{}/{}", j.source.bucket, j.source.key),
                    format!("{}/{}", j.target.bucket, j.target.key),
                )
            })
            .collect()
    }

    async fn resolve(
        store: &FakeStore,
        items: &[SelectedItem],
        target: (&str, &str),
        delete: bool,
    ) -> Result<Vec<CopyJob>, AppError> {
        let source = CopySource {
            profile_id: "p1",
            bucket: "quelle",
            items,
        };
        let target = CopyTarget {
            profile_id: "p1",
            bucket: target.0,
            prefix: target.1,
        };
        resolve_copies(store, store, source, target, delete).await
    }

    #[tokio::test]
    async fn resolves_files_and_folders_into_the_target_folder() {
        let folder = ListPage {
            objects: vec![
                ObjectEntry {
                    size: 3,
                    ..FakeStore::object("a/d/x.txt")
                },
                FakeStore::object("a/d/u/y.txt"),
            ],
            ..ListPage::default()
        };
        let store = FakeStore::with_pages(vec![free(), free(), folder]);
        let jobs = resolve(&store, &[item("a/c.txt", 7), item("a/d/", 0)], ("ziel", "z/"), false)
            .await
            .unwrap();
        assert_eq!(
            pairs(&jobs),
            [
                ("quelle/a/c.txt".to_owned(), "ziel/z/c.txt".to_owned()),
                ("quelle/a/d/x.txt".to_owned(), "ziel/z/d/x.txt".to_owned()),
                ("quelle/a/d/u/y.txt".to_owned(), "ziel/z/d/u/y.txt".to_owned()),
            ]
        );
        assert_eq!((jobs[0].size, jobs[1].size, jobs[0].delete_source), (7, 3, false));
    }

    #[tokio::test]
    async fn numbers_taken_names_instead_of_overwriting() {
        let store = FakeStore::with_pages(vec![page(&["a/c.txt"]), page(&["a/c (2).txt"]), free()]);
        let jobs = resolve(&store, &[item("a/c.txt", 1)], ("quelle", "a/"), false)
            .await
            .unwrap();
        assert_eq!(jobs[0].target.key, "a/c (3).txt");
    }

    #[tokio::test]
    async fn skips_moves_into_the_same_folder_and_refuses_copies_into_itself() {
        let store = FakeStore::default();
        let jobs = resolve(&store, &[item("a/c.txt", 1)], ("quelle", "a/"), true)
            .await
            .unwrap();
        assert_eq!(jobs, Vec::new());
        let into_itself = resolve(&store, &[item("a/d/", 0)], ("quelle", "a/d/sub/"), false).await;
        assert_eq!(into_itself, Err(AppError::CopyIntoItself("d".into())));
        let other_bucket = FakeStore::with_pages(vec![free()]);
        let jobs = resolve(&other_bucket, &[item("a/c.txt", 1)], ("ziel", "a/"), true)
            .await
            .unwrap();
        assert!(jobs[0].delete_source);
    }

    fn job(size: u64, delete_source: bool) -> CopyJob {
        CopyJob {
            source: object("b", "a/c.txt".into()),
            target: object("b", "z/c.txt".into()),
            size,
            delete_source,
            relay_from: None,
        }
    }

    #[tokio::test]
    async fn marks_copies_between_connections_and_never_treats_them_as_the_same_folder() {
        let sources = FakeStore::with_pages(vec![page(&["a/d/x.txt"])]);
        let targets = FakeStore::with_pages(vec![free()]);
        let items = [item("a/d/", 0)];
        let source = CopySource {
            profile_id: "aws",
            bucket: "b",
            items: &items,
        };
        let target = CopyTarget {
            profile_id: "hetzner",
            bucket: "b",
            prefix: "a/d/sub/",
        };
        let jobs = resolve_copies(&sources, &targets, source, target, true).await.unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].target.key, "a/d/sub/d/x.txt");
        assert_eq!(jobs[0].relay_from.as_deref(), Some("aws"));
        assert_eq!(targets.requests().len(), 1, "freie Namen werden im Ziel gesucht");
        assert_eq!(sources.requests().len(), 1, "Ordner werden in der Quelle gelistet");
    }

    async fn run(store: &FakeStore, job: &CopyJob) -> (Result<(), StoreError>, PartProgress) {
        let progress = PartProgress::default();
        let result = run_copy(
            store,
            job,
            &settings(),
            &progress,
            &ResumeState::default(),
            &CancelFlag::default(),
        )
        .await;
        (result, progress)
    }

    #[tokio::test]
    async fn copies_and_moves_small_objects() {
        let store = FakeStore::default();
        let (result, progress) = run(&store, &job(10, true)).await;
        result.unwrap();
        assert_eq!(
            store.upload_calls(),
            [
                TransferCall::Copy {
                    from: "a/c.txt".into(),
                    to: "z/c.txt".into()
                },
                TransferCall::Delete {
                    keys: vec!["a/c.txt".into()]
                },
            ]
        );
        assert_eq!((progress.done_bytes(), progress.parts_done()), (10, 1));
    }

    #[tokio::test]
    async fn copies_large_objects_in_parts_with_progress() {
        let store = FakeStore::default();
        let size = MAX_PART_SIZE + 3 * MIB;
        let (result, progress) = run(&store, &job(size, false)).await;
        result.unwrap();
        assert_eq!(
            (progress.done_bytes(), progress.parts_done(), progress.part_count()),
            (size, 3, 3)
        );
        assert_eq!(
            store.upload_calls().last(),
            Some(&TransferCall::Complete { parts: vec![1, 2, 3] })
        );
    }

    #[tokio::test]
    async fn aborts_failed_multipart_copies_and_forgets_the_upload() {
        let store = FakeStore::default();
        store.fail_next(vec![StoreError::Service(ServiceError {
            code: "AccessDenied".into(),
            message: String::new(),
            http_status: 403,
            request_id: None,
        })]);
        store.succeed_first(1);
        let uploads = ResumeState::default();
        let result = copy_object_any(
            &store,
            &job(0, false).source,
            &job(0, false).target,
            MAX_PART_SIZE + 1,
            &settings(),
            &PartProgress::default(),
            &uploads,
        )
        .await;
        assert!(result.is_err());
        assert_eq!(store.upload_calls().last(), Some(&TransferCall::Abort));
        assert_eq!(uploads.upload_id(), None);
    }

    #[tokio::test]
    async fn reports_originals_that_could_not_be_deleted() {
        let store = FakeStore::default();
        store.refuse_deleting(&["a/c.txt"]);
        let (result, _) = run(&store, &job(1, true)).await;
        let Err(StoreError::Service(error)) = result else {
            panic!("Fehler erwartet")
        };
        assert_eq!(error.code, "AccessDenied");
        assert!(error.message.starts_with("Kopiert, aber das Original"));
    }

    #[tokio::test]
    async fn stops_immediately_when_cancelled() {
        let store = FakeStore::default();
        store.hang_uploads();
        let cancel = CancelFlag::default();
        let (job, settings) = (job(1, false), settings());
        let (progress, uploads) = (PartProgress::default(), ResumeState::default());
        let task = run_copy(&store, &job, &settings, &progress, &uploads, &cancel);
        let (result, ()) = tokio::join!(task, async { cancel.cancel() });
        assert_eq!(result, Err(StoreError::Cancelled));
    }
}
