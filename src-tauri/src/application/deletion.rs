//! Anwendungsfall: Objekte löschen.
//!
//! Zweistufig, damit der Bestätigungsdialog Ziel und Menge nennen kann (DESIGN-SYSTEM.md):
//! 1. `prepare` löst die Auswahl in Keys auf (Ordner rekursiv), fragt die Versionierung ab und
//!    merkt sich diesen Plan.
//! 2. `execute` löscht genau diese Keys in Paketen zu 1.000, mehrere Pakete parallel.
//!
//! Objekte, die zwischen Vorschau und Bestätigung hinzukommen, bleiben unberührt.

use super::cancel::CancelFlag;
use super::error::AppError;
use super::listing::list_all;
use super::parts::{RetryPolicy, with_retries};
use crate::domain::deletion::{DeleteFailure, DeleteOutcome, DeletePreview, DeleteProgress, MAX_DELETE_BATCH};
use crate::domain::error::StoreError;
use crate::domain::object::ListRequest;
use crate::domain::transfer::SelectedItem;
use crate::ports::{ObjectStore, StoreProvider};
use futures_util::{StreamExt, stream};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

/// Einstellungen für das Löschen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeleteSettings {
    /// Gleichzeitig laufende `DeleteObjects`-Anfragen
    pub batches_parallel: usize,
    pub retry: RetryPolicy,
}

impl Default for DeleteSettings {
    fn default() -> Self {
        Self {
            batches_parallel: 4,
            retry: RetryPolicy::default(),
        }
    }
}

/// Aufgelöste Auswahl: genau diese Keys werden gelöscht.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeletePlan {
    pub bucket: String,
    pub keys: Vec<String>,
    pub bytes: u64,
    pub versioned: Option<bool>,
}

/// Löst die Auswahl in Keys auf; Ordner samt allem darunter, auch ihre Platzhalter-Objekte.
///
/// # Errors
/// Fehler des Listings.
pub async fn plan_delete<S: ObjectStore>(
    store: &S,
    bucket: &str,
    items: &[SelectedItem],
) -> Result<DeletePlan, StoreError> {
    let mut keys = Vec::new();
    let mut bytes = 0;
    for item in items {
        if item.is_folder {
            let request = ListRequest::recursive(bucket, &item.key);
            list_all(store, request, &CancelFlag::default(), |page| {
                for object in page.objects {
                    bytes += object.size;
                    keys.push(object.key);
                }
            })
            .await?;
        } else {
            bytes += item.size;
            keys.push(item.key.clone());
        }
    }
    // Ohne Berechtigung für die Abfrage bleibt die Versionierung unbekannt.
    let versioned = store.is_versioned(bucket).await.ok();
    Ok(DeletePlan {
        bucket: bucket.to_owned(),
        keys,
        bytes,
        versioned,
    })
}

/// Löscht die Keys des Plans paketweise und meldet nach jedem Paket den Fortschritt.
/// Nach einem Abbruch werden keine weiteren Pakete gesendet und laufende verworfen.
///
/// # Errors
/// Der Fehler eines Pakets, wenn die Wiederholungen ausgeschöpft sind; abgelehnte einzelne
/// Keys sind kein Fehler, sondern stehen im Ergebnis.
pub async fn execute_plan<S: ObjectStore>(
    store: &S,
    plan: &DeletePlan,
    settings: &DeleteSettings,
    cancel: &CancelFlag,
    on_progress: impl Fn(DeleteProgress),
) -> Result<DeleteOutcome, StoreError> {
    let total = u64::try_from(plan.keys.len()).unwrap_or(u64::MAX);
    let mut outcome = DeleteOutcome::default();
    let batch_count = plan.keys.len().div_ceil(MAX_DELETE_BATCH);
    let mut batches = stream::iter(0..batch_count)
        .map(|index| delete_batch(store, plan, index, settings, cancel))
        .buffer_unordered(settings.batches_parallel.max(1));
    while let Some(result) = batches.next().await {
        let (size, failures) = match result {
            Ok(batch) => batch,
            // Laufende Pakete werden verworfen; was der Dienst schon gelöscht hat, zeigt das Neuladen.
            Err(StoreError::Cancelled) => break,
            Err(error) => return Err(error),
        };
        outcome.record(size, failures);
        on_progress(DeleteProgress {
            processed: outcome.deleted + outcome.failed_count,
            total,
        });
    }
    outcome.cancelled = cancel.is_cancelled() && outcome.deleted + outcome.failed_count < total;
    Ok(outcome)
}

/// Löscht Paket `index` des Plans und liefert seine Größe und die abgelehnten Keys.
async fn delete_batch<S: ObjectStore>(
    store: &S,
    plan: &DeletePlan,
    index: usize,
    settings: &DeleteSettings,
    cancel: &CancelFlag,
) -> Result<(usize, Vec<DeleteFailure>), StoreError> {
    // Nach einem Abbruch startet kein weiteres Paket.
    if cancel.is_cancelled() {
        return Err(StoreError::Cancelled);
    }
    let start = index * MAX_DELETE_BATCH;
    let batch = &plan.keys[start..plan.keys.len().min(start + MAX_DELETE_BATCH)];
    tokio::select! {
        result = with_retries(&settings.retry, cancel, || store.delete_objects(&plan.bucket, batch)) => {
            result.map(|failures| (batch.len(), failures))
        }
        () = cancel.cancelled() => Err(StoreError::Cancelled),
    }
}

struct Prepared {
    profile_id: String,
    plan: DeletePlan,
}

/// Verwaltet vorbereitete und laufende Löschaufträge.
pub struct DeleteService<P> {
    provider: P,
    settings: DeleteSettings,
    next_id: AtomicU64,
    prepared: Mutex<HashMap<String, Prepared>>,
    running: Mutex<HashMap<String, CancelFlag>>,
}

impl<P> std::fmt::Debug for DeleteService<P> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeleteService").finish_non_exhaustive()
    }
}

impl<P: StoreProvider> DeleteService<P> {
    pub fn new(provider: P, settings: DeleteSettings) -> Self {
        Self {
            provider,
            settings,
            next_id: AtomicU64::new(0),
            prepared: Mutex::default(),
            running: Mutex::default(),
        }
    }

    /// Ermittelt, was gelöscht würde, und merkt sich den Plan bis zur Bestätigung.
    ///
    /// # Errors
    /// Unbekanntes Profil oder Fehler beim Listen.
    pub async fn prepare(
        &self,
        profile_id: &str,
        bucket: &str,
        items: &[SelectedItem],
    ) -> Result<DeletePreview, AppError> {
        let store = self.provider.store_for(profile_id)?;
        let plan = plan_delete(store.as_ref(), bucket, items).await?;
        let plan_id = format!("delete-{}", self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        let preview = DeletePreview {
            plan_id: plan_id.clone(),
            objects: u64::try_from(plan.keys.len()).unwrap_or(u64::MAX),
            bytes: plan.bytes,
            versioned: plan.versioned,
        };
        let prepared = Prepared {
            profile_id: profile_id.to_owned(),
            plan,
        };
        lock(&self.prepared).insert(plan_id, prepared);
        Ok(preview)
    }

    /// Löscht die Keys eines vorbereiteten Plans; jeder Plan lässt sich nur einmal ausführen.
    ///
    /// # Errors
    /// Unbekannter Plan, unbekanntes Profil oder ein gescheitertes Paket.
    pub async fn execute(
        &self,
        plan_id: &str,
        on_progress: impl Fn(DeleteProgress),
    ) -> Result<DeleteOutcome, AppError> {
        let Prepared { profile_id, plan } = lock(&self.prepared)
            .remove(plan_id)
            .ok_or_else(|| AppError::DeletePlanNotFound(plan_id.to_owned()))?;
        let store = self.provider.store_for(&profile_id)?;
        let cancel = CancelFlag::default();
        lock(&self.running).insert(plan_id.to_owned(), cancel.clone());
        let result = execute_plan(store.as_ref(), &plan, &self.settings, &cancel, on_progress).await;
        lock(&self.running).remove(plan_id);
        Ok(result?)
    }

    /// Bricht einen laufenden Löschvorgang ab; `false`, wenn keiner läuft.
    pub fn cancel(&self, plan_id: &str) -> bool {
        lock(&self.running).get(plan_id).inspect(|flag| flag.cancel()).is_some()
    }

    /// Verwirft einen vorbereiteten Plan, z. B. wenn der Dialog abgebrochen wird.
    pub fn discard(&self, plan_id: &str) {
        lock(&self.prepared).remove(plan_id);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::test_support::{FakeProvider, FakeStore};
    use crate::domain::error::ServiceError;
    use crate::domain::object::{ListPage, ObjectEntry};
    use std::sync::Arc;
    use std::time::Duration;

    fn entry(key: &str, size: u64) -> ObjectEntry {
        ObjectEntry {
            size,
            ..FakeStore::object(key)
        }
    }

    fn item(key: &str, is_folder: bool, size: u64) -> SelectedItem {
        SelectedItem {
            key: key.into(),
            is_folder,
            size,
            etag: None,
            last_modified_ms: None,
        }
    }

    fn settings() -> DeleteSettings {
        DeleteSettings {
            batches_parallel: 2,
            retry: RetryPolicy {
                retries: 1,
                delay: Duration::from_millis(1),
            },
        }
    }

    fn plan(count: usize) -> DeletePlan {
        DeletePlan {
            bucket: "b".into(),
            keys: (0..count).map(|i| format!("k{i}")).collect(),
            bytes: 0,
            versioned: Some(false),
        }
    }

    #[tokio::test]
    async fn plans_files_and_folders_with_their_placeholders() {
        let store = FakeStore::with_pages(vec![ListPage {
            objects: vec![entry("p/d/", 0), entry("p/d/a", 10), entry("p/d/x/b", 20)],
            prefixes: vec![],
            next_token: None,
        }]);
        store.set_versioned(Some(true));
        let items = [item("p/d/", true, 0), item("p/c.txt", false, 5)];
        let plan = plan_delete(&store, "b", &items).await.unwrap();
        assert_eq!(plan.keys, ["p/d/", "p/d/a", "p/d/x/b", "p/c.txt"]);
        assert_eq!((plan.bytes, plan.versioned), (35, Some(true)));
        assert_eq!(store.requests()[0], ListRequest::recursive("b", "p/d/"));
    }

    #[tokio::test]
    async fn leaves_the_versioning_unknown_without_permission() {
        let store = FakeStore::default();
        let plan = plan_delete(&store, "b", &[item("a", false, 1)]).await.unwrap();
        assert_eq!(plan.versioned, None);
    }

    #[tokio::test]
    async fn passes_listing_errors_through() {
        let store = FakeStore::failing(StoreError::Timeout);
        let result = plan_delete(&store, "b", &[item("d/", true, 0)]).await;
        assert_eq!(result, Err(StoreError::Timeout));
    }

    #[tokio::test]
    async fn deletes_in_batches_of_1000_and_reports_progress() {
        let store = FakeStore::default();
        store.refuse_deleting(&["k5", "k1500"]);
        let progress = Mutex::new(Vec::new());
        let outcome = execute_plan(&store, &plan(2500), &settings(), &CancelFlag::default(), |p| {
            progress.lock().unwrap().push(p);
        })
        .await
        .unwrap();
        let mut sizes: Vec<usize> = store.deleted_batches().iter().map(Vec::len).collect();
        sizes.sort_unstable();
        assert_eq!(sizes, [500, 1000, 1000]);
        assert_eq!(
            (outcome.deleted, outcome.failed_count, outcome.cancelled),
            (2498, 2, false)
        );
        assert_eq!(outcome.failures[0].code, "AccessDenied");
        let last = *progress.lock().unwrap().last().unwrap();
        assert_eq!(
            last,
            DeleteProgress {
                processed: 2500,
                total: 2500
            }
        );
    }

    #[tokio::test]
    async fn retries_failed_batches_and_reports_permanent_errors() {
        let store = FakeStore::default();
        store.fail_next(vec![StoreError::Timeout]);
        let outcome = execute_plan(&store, &plan(3), &settings(), &CancelFlag::default(), |_| {})
            .await
            .unwrap();
        assert_eq!(outcome.deleted, 3);

        let denied = StoreError::Service(ServiceError {
            code: "AccessDenied".into(),
            message: String::new(),
            http_status: 403,
            request_id: None,
        });
        store.fail_next(vec![denied.clone()]);
        let result = execute_plan(&store, &plan(3), &settings(), &CancelFlag::default(), |_| {}).await;
        assert_eq!(result, Err(denied));
    }

    #[tokio::test]
    async fn stops_sending_batches_after_cancelling() {
        let store = FakeStore::default();
        let cancel = CancelFlag::default();
        let single = DeleteSettings {
            batches_parallel: 1,
            ..settings()
        };
        let outcome = execute_plan(&store, &plan(3000), &single, &cancel, |_| cancel.cancel())
            .await
            .unwrap();
        assert_eq!(store.deleted_batches().len(), 1);
        assert_eq!(outcome.deleted, 1000);
        assert!(outcome.cancelled);
    }

    #[tokio::test]
    async fn handles_empty_plans() {
        let store = FakeStore::default();
        let outcome = execute_plan(&store, &plan(0), &settings(), &CancelFlag::default(), |_| {})
            .await
            .unwrap();
        assert_eq!(outcome, DeleteOutcome::default());
    }

    fn service(store: FakeStore) -> (DeleteService<FakeProvider>, Arc<FakeStore>) {
        let store = Arc::new(store);
        let service = DeleteService::new(FakeProvider::new(Arc::clone(&store)), settings());
        (service, store)
    }

    #[tokio::test]
    async fn prepares_once_and_executes_exactly_the_prepared_keys() {
        let (service, store) = service(FakeStore::default());
        store.set_versioned(Some(false));
        let preview = service
            .prepare("p1", "b", &[item("a", false, 4), item("c", false, 6)])
            .await
            .unwrap();
        assert_eq!(
            preview,
            DeletePreview {
                plan_id: "delete-1".into(),
                objects: 2,
                bytes: 10,
                versioned: Some(false)
            }
        );
        let outcome = service.execute("delete-1", |_| {}).await.unwrap();
        assert_eq!(outcome.deleted, 2);
        assert_eq!(store.deleted_batches(), [vec!["a".to_owned(), "c".to_owned()]]);
        let again = service.execute("delete-1", |_| {}).await;
        assert_eq!(again, Err(AppError::DeletePlanNotFound("delete-1".into())));
    }

    #[tokio::test]
    async fn discards_plans_and_cancels_running_deletes() {
        let (service, store) = service(FakeStore::default());
        let preview = service.prepare("p1", "b", &[item("a", false, 1)]).await.unwrap();
        service.discard(&preview.plan_id);
        assert!(service.execute(&preview.plan_id, |_| {}).await.is_err());
        assert!(!service.cancel("delete-9"));

        store.hang_uploads();
        let preview = service.prepare("p1", "b", &[item("a", false, 1)]).await.unwrap();
        let id = preview.plan_id.clone();
        let canceller = async {
            while !service.cancel(&id) {
                tokio::task::yield_now().await;
            }
        };
        let (result, ()) = tokio::join!(service.execute(&preview.plan_id, |_| {}), canceller);
        let outcome = result.unwrap();
        assert!(outcome.cancelled);
        assert_eq!(outcome.deleted, 0);
        assert_eq!(format!("{service:?}"), "DeleteService { .. }");
    }

    #[tokio::test]
    async fn reports_unknown_profiles() {
        let (service, _) = service(FakeStore::default());
        service.provider.make_unavailable();
        let result = service.prepare("p1", "b", &[]).await;
        assert!(matches!(result, Err(AppError::ProfileNotFound(_))));
    }
}
