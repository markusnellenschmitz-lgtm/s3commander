//! Kopieren zwischen zwei Verbindungen (andere Dienste oder andere Zugangsdaten).
//!
//! Ohne gemeinsamen Dienst gibt es keine Server-Kopie: Jeder Teil wird aus der Quelle in den
//! Speicher gelesen und sofort ins Ziel hochgeladen. Gleichzeitig liegen höchstens
//! `parts_parallel` Teile im Speicher, eine Zwischendatei gibt es nicht. Ändert sich die Quelle
//! während der Kopie, scheitert sie (`If-Match`). Pausierte Kopien setzen wie Uploads fort;
//! Verschieben löscht das Original erst nach bestätigter Kopie. Benutzer-Metadaten bleiben in
//! der Quelle, mitkopiert wird der Content-Type.

use super::cancel::CancelFlag;
use super::copy::{CopyJob, delete_original};
use super::parts::with_retries;
use super::upload::{MultipartObject, PartContext, upload_parts};
use crate::domain::error::StoreError;
use crate::domain::multipart::PartPlan;
use crate::domain::transfer::ObjectRef;
use crate::ports::ObjectStore;

/// Kopiert `job` von `source` nach `target`; Abbruch wirkt sofort.
///
/// # Errors
/// `Cancelled` nach Abbruch, sonst der letzte Fehler beim Lesen, Hochladen oder Löschen.
pub async fn relay<S: ObjectStore, T: ObjectStore>(
    source: &S,
    target: &T,
    job: &CopyJob,
    context: &PartContext<'_>,
) -> Result<(), StoreError> {
    let cancel: &CancelFlag = context.cancel;
    let work = async {
        relay_object(source, target, job, context).await?;
        if job.delete_source {
            delete_original(source, &job.source, &context.settings.retry, cancel).await?;
        }
        Ok(())
    };
    tokio::select! {
        result = work => result,
        () = cancel.cancelled() => Err(StoreError::Cancelled),
    }
}

async fn relay_object<S: ObjectStore, T: ObjectStore>(
    source: &S,
    target: &T,
    job: &CopyJob,
    context: &PartContext<'_>,
) -> Result<(), StoreError> {
    let PartContext {
        settings,
        progress,
        cancel,
        ..
    } = *context;
    let head = with_retries(&settings.retry, cancel, || {
        source.head_object(&job.source.bucket, &job.source.key)
    })
    .await?;
    let destination = &ObjectRef {
        content_type: head.content_type.clone(),
        ..job.target.clone()
    };
    let if_match = head.etag.as_deref();
    let plan = PartPlan::for_upload(head.size, settings.part_size, settings.multipart_threshold)?;
    progress.reset(plan.part_count());
    if plan == PartPlan::Single {
        let size = head.size;
        with_retries(&settings.retry, cancel, || {
            progress.track(1, size, |counter| async move {
                let body = source.get_range(&job.source, if_match, (0, size)).await?;
                target
                    .put_object_bytes(destination, body, &counter, settings.checksums)
                    .await
            })
        })
        .await?;
        return Ok(());
    }
    let object = MultipartObject {
        target: destination,
        size: head.size,
        plan,
    };
    upload_parts(
        target,
        &object,
        context,
        |number, range, upload_id, counter| async move {
            let body = source.get_range(&job.source, if_match, range).await?;
            target
                .upload_part_bytes(destination, &upload_id, number, body, &counter, settings.checksums)
                .await
        },
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::parts::{PartProgress, PartSettings, RetryPolicy};
    use crate::application::test_support::{FakeStore, TransferCall};
    use crate::application::upload::ResumeState;
    use crate::domain::details::ObjectHead;
    use crate::domain::multipart::MIB;
    use std::time::Duration;

    fn settings() -> PartSettings {
        PartSettings {
            part_size: 5 * MIB,
            multipart_threshold: 8 * MIB,
            parts_parallel: 1,
            retry: RetryPolicy {
                retries: 0,
                delay: Duration::from_millis(1),
            },
            ..PartSettings::default()
        }
    }

    fn source_with(size: u64) -> FakeStore {
        let store = FakeStore::default();
        store.set_head(ObjectHead {
            size,
            content_type: Some("video/mp4".into()),
            etag: Some("\"quelle\"".into()),
            ..ObjectHead::default()
        });
        store
    }

    fn job(delete_source: bool) -> CopyJob {
        let object = |bucket: &str, key: &str| ObjectRef {
            bucket: bucket.into(),
            key: key.into(),
            content_type: None,
        };
        CopyJob {
            source: object("quelle", "film.mp4"),
            target: object("ziel", "neu/film.mp4"),
            size: 0,
            delete_source,
            relay_from: Some("aws".into()),
        }
    }

    async fn run(
        source: &FakeStore,
        target: &FakeStore,
        job: &CopyJob,
        resume: &ResumeState,
    ) -> Result<u64, StoreError> {
        let settings = settings();
        let progress = PartProgress::default();
        let cancel = CancelFlag::default();
        let context = PartContext {
            settings: &settings,
            resume,
            progress: &progress,
            cancel: &cancel,
        };
        relay(source, target, job, &context).await?;
        Ok(progress.done_bytes())
    }

    fn range(offset: u64, length: u64) -> TransferCall {
        TransferCall::Range {
            offset,
            length,
            if_match: Some("\"quelle\"".into()),
        }
    }

    #[tokio::test]
    async fn copies_small_objects_with_one_put() {
        let (source, target) = (source_with(3 * MIB), FakeStore::default());
        let done = run(&source, &target, &job(false), &ResumeState::default())
            .await
            .unwrap();
        assert_eq!(done, 3 * MIB);
        assert_eq!(source.upload_calls(), [TransferCall::Read("head"), range(0, 3 * MIB)]);
        assert_eq!(target.upload_calls(), [TransferCall::Put { length: 3 * MIB }]);
        let put = target.put_targets();
        assert_eq!(
            (put[0].key.as_str(), put[0].content_type.as_deref()),
            ("neu/film.mp4", Some("video/mp4"))
        );
    }

    #[tokio::test]
    async fn streams_large_objects_part_by_part_and_moves() {
        let (source, target) = (source_with(12 * MIB), FakeStore::default());
        let done = run(&source, &target, &job(true), &ResumeState::default())
            .await
            .unwrap();
        assert_eq!(done, 12 * MIB);
        let reads: Vec<_> = source
            .upload_calls()
            .into_iter()
            .filter(|c| matches!(c, TransferCall::Range { .. }))
            .collect();
        assert_eq!(
            reads,
            [range(0, 5 * MIB), range(5 * MIB, 5 * MIB), range(10 * MIB, 2 * MIB)]
        );
        assert_eq!(source.deleted_batches(), [vec!["film.mp4".to_owned()]]);
        let parts: Vec<_> = target
            .upload_calls()
            .into_iter()
            .filter_map(|c| match c {
                TransferCall::PartBytes { number, length } => Some((number, length)),
                _ => None,
            })
            .collect();
        assert_eq!(parts, [(1, 5 * MIB), (2, 5 * MIB), (3, 2 * MIB)]);
    }

    #[tokio::test]
    async fn resumes_a_paused_copy_with_the_remaining_parts() {
        let (source, target) = (source_with(12 * MIB), FakeStore::default());
        target.set_listed_parts(vec![(1, 5 * MIB)]);
        let resume = ResumeState::default();
        resume.set(Some("upload-1".into()));
        run(&source, &target, &job(false), &resume).await.unwrap();
        let reads = source
            .upload_calls()
            .into_iter()
            .filter(|c| matches!(c, TransferCall::Range { .. }))
            .count();
        assert_eq!(reads, 2, "Teil 1 liegt schon im Ziel");
        assert_eq!(resume.upload_id(), None);
    }

    #[tokio::test]
    async fn fails_when_the_source_cannot_be_read() {
        let source = source_with(3 * MIB);
        source.fail_next(vec![StoreError::Timeout]);
        let result = run(&source, &FakeStore::default(), &job(false), &ResumeState::default()).await;
        assert_eq!(result, Err(StoreError::Timeout));
    }

    #[tokio::test]
    async fn stops_immediately_when_cancelled() {
        let source = source_with(3 * MIB);
        source.hang_uploads();
        let settings = settings();
        let progress = PartProgress::default();
        let cancel = CancelFlag::default();
        let resume = ResumeState::default();
        let context = PartContext {
            settings: &settings,
            resume: &resume,
            progress: &progress,
            cancel: &cancel,
        };
        cancel.cancel();
        let result = relay(&source, &FakeStore::default(), &job(false), &context).await;
        assert_eq!(result, Err(StoreError::Cancelled));
    }
}
