//! Anwendungsfall: eine Datei hochladen.
//!
//! - Kleine Dateien mit einem PUT, große als Multipart mit parallelen Teilen.
//! - Vorübergehende Fehler werden je Teil mit wachsender Pause wiederholt.
//! - Die `UploadId` bleibt nach Pause oder Fehler erhalten; ein neuer Versuch fragt mit
//!   `ListParts` die fertigen Teile ab und lädt nur den Rest.
//! - Abbruch wirkt sofort, auch mitten in einem laufenden Request.

use super::cancel::CancelFlag;
use super::parts::{PartProgress, PartSettings, part_numbers, part_range, with_retries};
use crate::domain::error::StoreError;
use crate::domain::multipart::PartPlan;
use crate::domain::transfer::{ByteCounter, CompletedPart, FileRange, ObjectRef};
use crate::ports::ObjectStore;
use futures_util::{StreamExt, TryStreamExt, stream};
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadJob {
    pub target: ObjectRef,
    pub file: PathBuf,
    pub size: u64,
}

/// Über Versuche hinweg gemerkte `UploadId`, damit ein neuer Versuch fortsetzen kann.
#[derive(Debug, Default)]
pub struct ResumeState(Mutex<Option<String>>);

impl ResumeState {
    #[must_use]
    pub fn upload_id(&self) -> Option<String> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    pub fn set(&self, upload_id: Option<String>) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = upload_id;
    }
}

/// Lädt die Datei hoch und liefert das `ETag` des Objekts.
///
/// # Errors
///
/// `Cancelled` nach Abbruch, sonst der letzte Fehler, wenn die Wiederholungen ausgeschöpft
/// oder der Fehler nicht vorübergehend ist.
pub async fn upload<S: ObjectStore>(
    store: &S,
    job: &UploadJob,
    settings: &PartSettings,
    resume: &ResumeState,
    progress: &PartProgress,
    cancel: &CancelFlag,
) -> Result<String, StoreError> {
    let work = async {
        let plan = PartPlan::for_upload(job.size, settings.part_size, settings.multipart_threshold)?;
        progress.reset(plan.part_count());
        match plan {
            PartPlan::Single => upload_single(store, job, settings, progress, cancel).await,
            PartPlan::Multipart { .. } => upload_multipart(store, job, plan, settings, resume, progress, cancel).await,
        }
    };
    tokio::select! {
        result = work => result,
        () = cancel.cancelled() => Err(StoreError::Cancelled),
    }
}

async fn upload_single<S: ObjectStore>(
    store: &S,
    job: &UploadJob,
    settings: &PartSettings,
    progress: &PartProgress,
    cancel: &CancelFlag,
) -> Result<String, StoreError> {
    let source = FileRange {
        path: job.file.clone(),
        offset: 0,
        length: job.size,
    };
    let source = &source;
    with_retries(&settings.retry, cancel, || {
        progress.track(1, job.size, |counter| async move {
            store
                .put_object(&job.target, source, &counter, settings.checksums)
                .await
        })
    })
    .await
}

async fn upload_multipart<S: ObjectStore>(
    store: &S,
    job: &UploadJob,
    plan: PartPlan,
    settings: &PartSettings,
    resume: &ResumeState,
    progress: &PartProgress,
    cancel: &CancelFlag,
) -> Result<String, StoreError> {
    let object = MultipartObject {
        target: &job.target,
        size: job.size,
        plan,
    };
    let context = PartContext {
        settings,
        resume,
        progress,
        cancel,
    };
    upload_parts(
        store,
        &object,
        &context,
        |number, (offset, length), upload_id, counter| {
            let source = FileRange {
                path: job.file.clone(),
                offset,
                length,
            };
            async move {
                store
                    .upload_part(&job.target, &upload_id, number, &source, &counter, settings.checksums)
                    .await
            }
        },
    )
    .await
}

/// Ziel eines Multipart-Uploads: Objekt, Größe und Aufteilung.
#[derive(Debug, Clone, Copy)]
pub struct MultipartObject<'a> {
    pub target: &'a ObjectRef,
    pub size: u64,
    pub plan: PartPlan,
}

/// Was jeder Teil eines Vorgangs braucht: Einstellungen, Fortsetzen, Fortschritt, Abbruch.
#[derive(Debug, Clone, Copy)]
pub struct PartContext<'a> {
    pub settings: &'a PartSettings,
    pub resume: &'a ResumeState,
    pub progress: &'a PartProgress,
    pub cancel: &'a CancelFlag,
}

/// Gemeinsamer Ablauf aller Multipart-Uploads: fortsetzen oder starten, fehlende Teile parallel
/// hochladen (mit Wiederholungen), zusammenfügen. `send_part(nummer, (offset, länge), upload_id,
/// zähler)` lädt einen Teil hoch und liefert ihn mit `ETag` und Prüfsumme; woher die Daten kommen,
/// entscheidet der Aufrufer (Datei oder Speicher).
///
/// # Errors
/// Der letzte Fehler, wenn die Wiederholungen ausgeschöpft sind.
pub async fn upload_parts<S, F, Fut>(
    store: &S,
    object: &MultipartObject<'_>,
    context: &PartContext<'_>,
    send_part: F,
) -> Result<String, StoreError>
where
    S: ObjectStore,
    F: Fn(u32, (u64, u64), String, ByteCounter) -> Fut,
    Fut: Future<Output = Result<CompletedPart, StoreError>>,
{
    let PartContext {
        settings,
        resume,
        progress,
        cancel,
    } = *context;
    let (upload_id, mut done) = resume_or_start(store, object, context).await?;
    for part in done.values() {
        progress.credit(part_range(&object.plan, object.size, part.part_number).1);
    }

    let send_part = &send_part;
    let upload_id_ref = &upload_id;
    let pending: Vec<u32> = part_numbers(&object.plan).filter(|n| !done.contains_key(n)).collect();
    let uploaded: Vec<CompletedPart> = stream::iter(pending)
        .map(|number| async move {
            let range = part_range(&object.plan, object.size, number);
            with_retries(&settings.retry, cancel, || {
                progress.track(number, range.1, |counter| {
                    send_part(number, range, upload_id_ref.clone(), counter)
                })
            })
            .await
        })
        .buffer_unordered(settings.parts_parallel.max(1))
        .try_collect()
        .await?;
    done.extend(uploaded.into_iter().map(|p| (p.part_number, p)));

    let mut parts: Vec<CompletedPart> = done.into_values().collect();
    parts.sort_by_key(|p| p.part_number);
    let etag = with_retries(&settings.retry, cancel, || {
        store.complete_multipart_upload(object.target, &upload_id, &parts)
    })
    .await?;
    resume.set(None);
    Ok(etag)
}

/// Setzt einen gemerkten Upload fort oder startet einen neuen. Teile mit falscher Größe
/// (Quelle geändert oder andere Teilgröße) werden neu hochgeladen.
async fn resume_or_start<S: ObjectStore>(
    store: &S,
    object: &MultipartObject<'_>,
    context: &PartContext<'_>,
) -> Result<(String, HashMap<u32, CompletedPart>), StoreError> {
    let PartContext {
        settings,
        resume,
        cancel,
        ..
    } = *context;
    if let Some(upload_id) = resume.upload_id() {
        match with_retries(&settings.retry, cancel, || store.list_parts(object.target, &upload_id)).await {
            Ok(parts) => {
                let done = parts
                    .into_iter()
                    .filter(|p| part_range(&object.plan, object.size, p.part_number).1 == p.size)
                    .map(|p| {
                        (
                            p.part_number,
                            CompletedPart {
                                part_number: p.part_number,
                                etag: p.etag,
                                checksum_crc32c: p.checksum_crc32c,
                            },
                        )
                    })
                    .collect();
                return Ok((upload_id, done));
            }
            // Upload abgelaufen oder bereits abgebrochen: neu beginnen.
            Err(StoreError::Service(e)) if e.code == "NoSuchUpload" => resume.set(None),
            Err(other) => return Err(other),
        }
    }
    let upload_id = with_retries(&settings.retry, cancel, || {
        store.create_multipart_upload(object.target, settings.checksums)
    })
    .await?;
    resume.set(Some(upload_id.clone()));
    Ok((upload_id, HashMap::new()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::parts::RetryPolicy;
    use crate::application::test_support::{FakeStore, TransferCall};
    use crate::domain::error::ServiceError;
    use crate::domain::multipart::MIB;
    use crate::domain::transfer::Checksums;
    use std::time::Duration;

    fn job(size: u64) -> UploadJob {
        UploadJob {
            target: ObjectRef {
                bucket: "b".into(),
                key: "k".into(),
                content_type: None,
            },
            file: PathBuf::from("C:\\daten\\datei.bin"),
            size,
        }
    }

    fn settings() -> PartSettings {
        PartSettings {
            part_size: 5 * MIB,
            multipart_threshold: 8 * MIB,
            parts_parallel: 2,
            retry: RetryPolicy {
                retries: 2,
                delay: Duration::from_millis(1),
            },
            ..PartSettings::default()
        }
    }

    async fn run(store: &FakeStore, size: u64, resume: &ResumeState) -> (Result<String, StoreError>, PartProgress) {
        let progress = PartProgress::default();
        let result = upload(
            store,
            &job(size),
            &settings(),
            resume,
            &progress,
            &CancelFlag::default(),
        )
        .await;
        (result, progress)
    }

    #[tokio::test]
    async fn asks_the_service_to_verify_every_request_unless_disabled() {
        let store = FakeStore::default();
        run(&store, 12 * MIB, &ResumeState::default()).await.0.unwrap();
        run(&store, 1000, &ResumeState::default()).await.0.unwrap();
        let modes = store.checksum_modes();
        assert_eq!(modes.len(), 5, "Create, drei Teile, ein PUT");
        assert!(modes.iter().all(|m| *m == Checksums::Verify));

        let unchecked = FakeStore::default();
        let settings = PartSettings {
            checksums: Checksums::Off,
            ..settings()
        };
        let progress = PartProgress::default();
        upload(
            &unchecked,
            &job(12 * MIB),
            &settings,
            &ResumeState::default(),
            &progress,
            &CancelFlag::default(),
        )
        .await
        .unwrap();
        assert!(unchecked.checksum_modes().iter().all(|m| *m == Checksums::Off));
    }

    fn timeout() -> StoreError {
        StoreError::Timeout
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
    async fn uploads_small_files_with_a_single_put() {
        let store = FakeStore::default();
        let (result, progress) = run(&store, 1000, &ResumeState::default()).await;
        assert_eq!(result.unwrap(), "\"etag-put\"");
        assert_eq!(store.upload_calls(), [TransferCall::Put { length: 1000 }]);
        assert_eq!(progress.done_bytes(), 1000);
        assert_eq!((progress.parts_done(), progress.part_count()), (1, 1));
    }

    #[tokio::test]
    async fn uploads_large_files_in_parts_and_completes_in_order() {
        let store = FakeStore::default();
        let size = 12 * MIB + 7;
        let resume = ResumeState::default();
        let (result, progress) = run(&store, size, &resume).await;
        assert_eq!(result.unwrap(), "\"etag-complete\"");
        let calls = store.upload_calls();
        assert_eq!(calls[0], TransferCall::Create);
        let mut parts: Vec<_> = calls
            .iter()
            .filter_map(|c| match c {
                TransferCall::Part { number, offset, length } => Some((*number, *offset, *length)),
                _ => None,
            })
            .collect();
        parts.sort_unstable();
        assert_eq!(
            parts,
            [(1, 0, 5 * MIB), (2, 5 * MIB, 5 * MIB), (3, 10 * MIB, 2 * MIB + 7)]
        );
        assert_eq!(calls.last(), Some(&TransferCall::Complete { parts: vec![1, 2, 3] }));
        assert_eq!(progress.done_bytes(), size);
        assert_eq!((progress.parts_done(), progress.part_count()), (3, 3));
        assert_eq!(
            resume.upload_id(),
            None,
            "abgeschlossene Uploads werden nicht fortgesetzt"
        );
    }

    #[tokio::test]
    async fn retries_transient_errors_and_discards_partial_progress() {
        let store = FakeStore::default();
        store.fail_next(vec![timeout(), timeout()]);
        let (result, progress) = run(&store, 1000, &ResumeState::default()).await;
        assert!(result.is_ok());
        assert_eq!(store.upload_calls().len(), 3);
        assert_eq!(progress.done_bytes(), 1000);
    }

    #[tokio::test]
    async fn gives_up_after_the_configured_retries() {
        let store = FakeStore::default();
        store.fail_next(vec![timeout(), timeout(), timeout()]);
        let (result, progress) = run(&store, 1000, &ResumeState::default()).await;
        assert_eq!(result, Err(StoreError::Timeout));
        assert_eq!(progress.done_bytes(), 0);
    }

    #[tokio::test]
    async fn does_not_retry_permanent_errors_and_keeps_the_upload_id() {
        let store = FakeStore::default();
        store.fail_next(vec![denied()]);
        // Create gelingt, der erste Teil scheitert dauerhaft.
        store.succeed_first(1);
        let resume = ResumeState::default();
        let (result, _) = run(&store, 12 * MIB, &resume).await;
        assert_eq!(result, Err(denied()));
        assert_eq!(resume.upload_id().as_deref(), Some("upload-1"));
    }

    #[tokio::test]
    async fn resumes_with_list_parts_and_uploads_only_missing_parts() {
        let store = FakeStore::default();
        store.set_listed_parts(vec![(1, 5 * MIB), (2, 4 * MIB)]);
        let resume = ResumeState::default();
        resume.set(Some("upload-alt".into()));
        let (result, progress) = run(&store, 12 * MIB, &resume).await;
        assert!(result.is_ok());
        let calls = store.upload_calls();
        assert_eq!(calls[0], TransferCall::ListParts);
        let uploaded: Vec<u32> = calls
            .iter()
            .filter_map(|c| {
                if let TransferCall::Part { number, .. } = c {
                    Some(*number)
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(uploaded.len(), 2, "Teil 2 hatte die falsche Größe und wird neu geladen");
        assert!(!uploaded.contains(&1));
        assert_eq!(progress.done_bytes(), 12 * MIB);
    }

    #[tokio::test]
    async fn starts_over_when_the_remembered_upload_is_gone() {
        let store = FakeStore::default();
        store.fail_next(vec![StoreError::Service(ServiceError {
            code: "NoSuchUpload".into(),
            message: String::new(),
            http_status: 404,
            request_id: None,
        })]);
        let resume = ResumeState::default();
        resume.set(Some("abgelaufen".into()));
        let (result, _) = run(&store, 12 * MIB, &resume).await;
        assert!(result.is_ok());
        assert_eq!(store.upload_calls()[1], TransferCall::Create);
    }

    #[tokio::test]
    async fn passes_other_list_parts_errors_through() {
        let store = FakeStore::default();
        store.fail_next(vec![denied()]);
        let resume = ResumeState::default();
        resume.set(Some("upload".into()));
        assert_eq!(run(&store, 12 * MIB, &resume).await.0, Err(denied()));
    }

    #[tokio::test]
    async fn stops_immediately_when_cancelled() {
        let store = FakeStore::default();
        store.hang_uploads();
        let cancel = CancelFlag::default();
        let progress = PartProgress::default();
        let resume = ResumeState::default();
        let (job, settings) = (job(12 * MIB), settings());
        let task = upload(&store, &job, &settings, &resume, &progress, &cancel);
        let (result, ()) = tokio::join!(task, async { cancel.cancel() });
        assert_eq!(result, Err(StoreError::Cancelled));
    }

    #[tokio::test]
    async fn rejects_files_over_5_tib() {
        let store = FakeStore::default();
        let (result, _) = run(&store, 6 * 1024 * 1024 * MIB, &ResumeState::default()).await;
        assert!(matches!(result, Err(StoreError::InvalidConfig(_))));
    }
}
