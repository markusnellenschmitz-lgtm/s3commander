//! Anwendungsfall: Objekte herunterladen.
//!
//! - Kleine Objekte mit einem GET, große mit parallelen Range-Requests.
//! - Jeder Teil landet direkt an seiner Stelle in einer Teildatei (`.s3part`). Erst der fertige
//!   Download bekommt seinen Namen; eine halbe Datei unter dem endgültigen Namen gibt es nie.
//! - Fertige Teile bleiben über Pause und Fehler hinweg gemerkt; ein neuer Versuch lädt nur den Rest.
//! - Mit dem `ETag` aus dem Listing scheitert ein Teil, wenn sich das Objekt inzwischen geändert hat.
//! - Ist der `ETag` eine MD5-Summe, wird die fertige Datei damit verglichen (Einstellung „Prüfung“).

use super::cancel::CancelFlag;
use super::listing::list_all;
use super::parts::{PartProgress, PartSettings, part_numbers, part_range, with_retries};
use crate::domain::error::StoreError;
use crate::domain::local_path::{download_relative_path, numbered_path, partial_path};
use crate::domain::multipart::PartPlan;
use crate::domain::object::ListRequest;
use crate::domain::settings::{ConflictDecision, ConflictPolicy, decide_conflict};
use crate::domain::transfer::{Checksums, FileRange, ObjectRef, SelectedItem, md5_from_etag};
use crate::ports::{LocalFiles, ObjectStore};
use futures_util::{StreamExt, TryStreamExt, stream};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadJob {
    pub source: ObjectRef,
    /// `ETag` aus dem Listing; schützt vor gemischten Versionen beim Fortsetzen.
    pub etag: Option<String>,
    pub size: u64,
    /// Gewünschter lokaler Pfad; was bei einer vorhandenen Datei geschieht, regelt `ConflictPolicy`.
    pub target: PathBuf,
    /// Änderungszeit des Objekts in Millisekunden seit Epoch, für „Überschreiben, wenn neuer“.
    pub modified_ms: Option<i64>,
    /// Vorhandene Datei ersetzen statt der Konfliktregel zu folgen (Abgleich hat entschieden).
    pub replace_existing: bool,
    /// Der fertigen Datei die Änderungszeit des Objekts geben (Abgleich).
    pub keep_remote_time: bool,
}

/// Einstellungen eines Downloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DownloadOptions {
    pub parts: PartSettings,
    pub conflict: ConflictPolicy,
}

/// Ergebnis eines Downloads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadOutcome {
    /// Gespeichert unter diesem Pfad.
    Saved(PathBuf),
    /// Nach der Konfliktregel nicht heruntergeladen.
    Skipped,
}

/// Über Versuche hinweg gemerkte fertige Teile, damit ein neuer Versuch fortsetzen kann.
#[derive(Debug, Default)]
pub struct DownloadResume(Mutex<HashSet<u32>>);

impl DownloadResume {
    #[must_use]
    pub fn done_parts(&self) -> HashSet<u32> {
        self.lock().clone()
    }

    pub fn clear(&self) {
        self.lock().clear();
    }

    fn mark_done(&self, part_number: u32) {
        self.lock().insert(part_number);
    }

    fn lock(&self) -> MutexGuard<'_, HashSet<u32>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Löst die Auswahl in einzelne Downloads auf. Ordner werden rekursiv gelistet; die lokale
/// Struktur unter `target_dir` entspricht den Keys unterhalb von `base_prefix`.
///
/// # Errors
/// Fehler des Listings.
pub async fn resolve_downloads<S: ObjectStore>(
    store: &S,
    bucket: &str,
    base_prefix: &str,
    items: &[SelectedItem],
    target_dir: &Path,
) -> Result<Vec<DownloadJob>, StoreError> {
    let mut plan = TargetPlan::new(bucket, base_prefix, target_dir);
    for item in items {
        if item.is_folder {
            let request = ListRequest::recursive(bucket, &item.key);
            list_all(store, request, &CancelFlag::default(), |page| {
                for object in page.objects {
                    plan.add(object.key, object.size, object.etag, object.last_modified_ms);
                }
            })
            .await?;
        } else {
            plan.add(item.key.clone(), item.size, item.etag.clone(), item.last_modified_ms);
        }
    }
    Ok(plan.jobs)
}

/// Sammelt Downloads und sorgt dafür, dass keine zwei dieselbe lokale Datei beschreiben.
struct TargetPlan<'a> {
    bucket: &'a str,
    base_prefix: &'a str,
    target_dir: &'a Path,
    taken: HashSet<PathBuf>,
    jobs: Vec<DownloadJob>,
}

impl<'a> TargetPlan<'a> {
    fn new(bucket: &'a str, base_prefix: &'a str, target_dir: &'a Path) -> Self {
        Self {
            bucket,
            base_prefix,
            target_dir,
            taken: HashSet::new(),
            jobs: Vec::new(),
        }
    }

    /// Ordner-Platzhalter haben keinen Dateinamen und werden übersprungen.
    fn add(&mut self, key: String, size: u64, etag: Option<String>, modified_ms: Option<i64>) {
        let Some(relative) = download_relative_path(self.base_prefix, &key) else {
            return;
        };
        let wanted = self.target_dir.join(relative);
        let target = std::iter::once(wanted.clone())
            .chain((2..=u32::MAX).map(|n| numbered_path(&wanted, n)))
            .find(|candidate| !self.taken.contains(candidate))
            .unwrap_or(wanted);
        self.taken.insert(target.clone());
        self.jobs.push(DownloadJob {
            source: ObjectRef {
                bucket: self.bucket.to_owned(),
                key,
                content_type: None,
            },
            etag,
            size,
            target,
            modified_ms,
            replace_existing: false,
            keep_remote_time: false,
        });
    }
}

/// Lädt das Objekt herunter, sofern die Konfliktregel es erlaubt.
///
/// # Errors
///
/// `Cancelled` nach Abbruch, `LocalFile` bei Fehlern im Dateisystem, sonst der letzte Fehler,
/// wenn die Wiederholungen ausgeschöpft oder der Fehler nicht vorübergehend ist.
pub async fn download<S: ObjectStore, L: LocalFiles>(
    store: &S,
    files: &L,
    job: &DownloadJob,
    options: &DownloadOptions,
    resume: &DownloadResume,
    progress: &PartProgress,
    cancel: &CancelFlag,
) -> Result<DownloadOutcome, StoreError> {
    let settings = &options.parts;
    let work = async {
        let policy = if job.replace_existing {
            ConflictPolicy::Overwrite
        } else {
            options.conflict
        };
        let overwrite = match decide_conflict(policy, files.modified_ms(&job.target)?, job.modified_ms) {
            ConflictDecision::Skip => return Ok(DownloadOutcome::Skipped),
            ConflictDecision::Download { overwrite } => overwrite,
        };
        let plan = PartPlan::for_download(job.size, settings.part_size, settings.multipart_threshold);
        progress.reset(plan.part_count());
        let partial = partial_path(&job.target);
        if !files.prepare_download(&partial, job.size)? {
            // Ohne alte Teildatei sind gemerkte Teile wertlos.
            resume.clear();
        }
        let done = resume.done_parts();
        for number in &done {
            progress.credit(part_range(&plan, job.size, *number).1);
        }
        let pending: Vec<u32> = part_numbers(&plan).filter(|n| !done.contains(n)).collect();
        stream::iter(pending)
            .map(|number| download_part(store, job, &plan, &partial, number, settings, resume, progress, cancel))
            .buffer_unordered(settings.parts_parallel.max(1))
            .try_collect::<Vec<()>>()
            .await?;
        if settings.checksums == Checksums::Verify {
            verify_download(store, files, job, &partial, resume).await?;
        }
        let path = files.complete_download(&partial, &job.target, overwrite)?;
        resume.clear();
        if let (true, Some(modified_ms)) = (job.keep_remote_time, job.modified_ms) {
            files.set_modified_ms(&path, modified_ms)?;
        }
        Ok(DownloadOutcome::Saved(path))
    };
    tokio::select! {
        result = work => result,
        () = cancel.cancelled() => Err(StoreError::Cancelled),
    }
}

/// Vergleicht die fertige Teildatei mit dem `ETag`, wenn er eine MD5-Summe ist. Weicht sie ab,
/// fragt ein HEAD nach der Verschlüsselung: Bei KMS- und Kundenschlüsseln ist der `ETag` keine
/// MD5-Summe, sonst ist die Datei verfälscht und wird verworfen; ein neuer Versuch lädt neu.
async fn verify_download<S: ObjectStore, L: LocalFiles>(
    store: &S,
    files: &L,
    job: &DownloadJob,
    partial: &Path,
    resume: &DownloadResume,
) -> Result<(), StoreError> {
    let Some(expected) = job.etag.as_deref().and_then(md5_from_etag) else {
        return Ok(());
    };
    let actual = files.md5_hex(partial).await?;
    if actual == expected
        || !store
            .head_object(&job.source.bucket, &job.source.key)
            .await?
            .etag_is_md5()
    {
        return Ok(());
    }
    resume.clear();
    files.discard_download(partial)?;
    Err(StoreError::Integrity(format!(
        "{} hat MD5 {actual}, erwartet {expected}",
        job.source.key
    )))
}

#[allow(clippy::too_many_arguments)] // Bündelt nur Referenzen auf den Download-Kontext.
async fn download_part<S: ObjectStore>(
    store: &S,
    job: &DownloadJob,
    plan: &PartPlan,
    partial: &Path,
    number: u32,
    settings: &PartSettings,
    resume: &DownloadResume,
    progress: &PartProgress,
    cancel: &CancelFlag,
) -> Result<(), StoreError> {
    let (offset, length) = part_range(plan, job.size, number);
    let part = &FileRange {
        path: partial.to_path_buf(),
        offset,
        length,
    };
    with_retries(&settings.retry, cancel, || {
        progress.track(number, length, |counter| async move {
            store
                .download_range(&job.source, job.etag.as_deref(), part, &counter)
                .await
        })
    })
    .await?;
    resume.mark_done(number);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::parts::RetryPolicy;
    use crate::application::test_support::{FakeFiles, FakeStore, FileCall, TransferCall};
    use crate::domain::details::ObjectHead;
    use crate::domain::error::ServiceError;
    use crate::domain::multipart::MIB;
    use crate::domain::object::{ListPage, ObjectEntry};
    use std::time::Duration;

    const TARGET: &str = r"D:\Exporte\daten.bin";
    const PARTIAL: &str = r"D:\Exporte\daten.bin.s3part";

    fn job(size: u64) -> DownloadJob {
        DownloadJob {
            source: ObjectRef {
                bucket: "b".into(),
                key: "exporte/daten.bin".into(),
                content_type: None,
            },
            etag: Some("\"abc\"".into()),
            size,
            target: PathBuf::from(TARGET),
            modified_ms: Some(2000),
            replace_existing: false,
            keep_remote_time: false,
        }
    }

    fn settings() -> DownloadOptions {
        DownloadOptions {
            parts: PartSettings {
                part_size: 5 * MIB,
                multipart_threshold: 8 * MIB,
                parts_parallel: 2,
                retry: RetryPolicy {
                    retries: 1,
                    delay: Duration::from_millis(1),
                },
                ..PartSettings::default()
            },
            conflict: ConflictPolicy::Rename,
        }
    }

    struct Run {
        result: Result<DownloadOutcome, StoreError>,
        progress: PartProgress,
    }

    fn saved(path: &str) -> DownloadOutcome {
        DownloadOutcome::Saved(PathBuf::from(path))
    }

    async fn run(store: &FakeStore, files: &FakeFiles, size: u64, resume: &DownloadResume) -> Run {
        let progress = PartProgress::default();
        let result = download(
            store,
            files,
            &job(size),
            &settings(),
            resume,
            &progress,
            &CancelFlag::default(),
        )
        .await;
        Run { result, progress }
    }

    fn ranges(store: &FakeStore) -> Vec<(u64, u64)> {
        let mut ranges: Vec<_> = store
            .upload_calls()
            .into_iter()
            .filter_map(|c| match c {
                TransferCall::Range { offset, length, .. } => Some((offset, length)),
                _ => None,
            })
            .collect();
        ranges.sort_unstable();
        ranges
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
    async fn downloads_small_objects_with_one_request_into_a_partial_file() {
        let (store, files) = (FakeStore::default(), FakeFiles::default());
        let run = run(&store, &files, 1000, &DownloadResume::default()).await;
        assert_eq!(run.result, Ok(saved(TARGET)));
        assert_eq!(
            store.upload_calls(),
            [TransferCall::Range {
                offset: 0,
                length: 1000,
                if_match: Some("\"abc\"".into())
            }]
        );
        assert_eq!(
            files.calls(),
            [
                FileCall::Prepare(PARTIAL.into(), 1000),
                FileCall::Complete(PARTIAL.into(), TARGET.into(), false)
            ]
        );
        assert_eq!((run.progress.done_bytes(), run.progress.part_count()), (1000, 1));
    }

    #[tokio::test]
    async fn downloads_large_objects_in_parallel_ranges() {
        let (store, files) = (FakeStore::default(), FakeFiles::default());
        let resume = DownloadResume::default();
        let size = 12 * MIB + 7;
        let run = run(&store, &files, size, &resume).await;
        assert!(run.result.is_ok());
        assert_eq!(
            ranges(&store),
            [(0, 5 * MIB), (5 * MIB, 5 * MIB), (10 * MIB, 2 * MIB + 7)]
        );
        assert_eq!((run.progress.done_bytes(), run.progress.parts_done()), (size, 3));
        assert!(resume.done_parts().is_empty(), "fertige Downloads merken sich nichts");
    }

    #[tokio::test]
    async fn resumes_with_the_remembered_parts_of_an_existing_partial_file() {
        let (store, files) = (FakeStore::default(), FakeFiles::default());
        files.keep_partial_files();
        let resume = DownloadResume::default();
        resume.mark_done(1);
        resume.mark_done(3);
        let run = run(&store, &files, 12 * MIB, &resume).await;
        assert!(run.result.is_ok());
        assert_eq!(ranges(&store), [(5 * MIB, 5 * MIB)]);
        assert_eq!(run.progress.done_bytes(), 12 * MIB);
    }

    #[tokio::test]
    async fn starts_over_when_the_partial_file_is_gone() {
        let (store, files) = (FakeStore::default(), FakeFiles::default());
        let resume = DownloadResume::default();
        resume.mark_done(1);
        let run = run(&store, &files, 12 * MIB, &resume).await;
        assert!(run.result.is_ok());
        assert_eq!(ranges(&store).len(), 3);
    }

    #[tokio::test]
    async fn keeps_finished_parts_after_a_failure() {
        let (store, files) = (FakeStore::default(), FakeFiles::default());
        store.fail_next(vec![denied()]);
        store.succeed_first(1);
        let resume = DownloadResume::default();
        let settings = DownloadOptions {
            parts: PartSettings {
                parts_parallel: 1,
                ..settings().parts
            },
            ..settings()
        };
        let result = download(
            &store,
            &files,
            &job(12 * MIB),
            &settings,
            &resume,
            &PartProgress::default(),
            &CancelFlag::default(),
        )
        .await;
        assert_eq!(result, Err(denied()));
        assert_eq!(resume.done_parts(), HashSet::from([1]));
        assert!(!files.calls().iter().any(|c| matches!(c, FileCall::Complete(..))));
    }

    async fn run_with(files: &FakeFiles, conflict: ConflictPolicy) -> (Result<DownloadOutcome, StoreError>, FakeStore) {
        let store = FakeStore::default();
        let options = DownloadOptions { conflict, ..settings() };
        let result = download(
            &store,
            files,
            &job(10),
            &options,
            &DownloadResume::default(),
            &PartProgress::default(),
            &CancelFlag::default(),
        )
        .await;
        (result, store)
    }

    #[tokio::test]
    async fn applies_the_conflict_policy_to_existing_files() {
        let files = FakeFiles::default();
        files.set_existing(TARGET, 1000);
        let (skip, store) = run_with(&files, ConflictPolicy::Skip).await;
        assert_eq!(skip, Ok(DownloadOutcome::Skipped));
        assert_eq!(
            store.upload_calls(),
            Vec::new(),
            "übersprungene Dateien werden nicht geladen"
        );

        let (newer, _) = run_with(&files, ConflictPolicy::OverwriteIfNewer).await;
        assert_eq!(newer, Ok(saved(TARGET)));
        assert_eq!(
            files.calls().last(),
            Some(&FileCall::Complete(PARTIAL.into(), TARGET.into(), true))
        );

        files.set_existing(TARGET, 5000);
        let (older, _) = run_with(&files, ConflictPolicy::OverwriteIfNewer).await;
        assert_eq!(older, Ok(DownloadOutcome::Skipped));
        let (rename, _) = run_with(&files, ConflictPolicy::Rename).await;
        assert_eq!(rename, Ok(saved(TARGET)));
        assert_eq!(
            files.calls().last(),
            Some(&FileCall::Complete(PARTIAL.into(), TARGET.into(), false))
        );
    }

    #[tokio::test]
    async fn retries_transient_errors() {
        let (store, files) = (FakeStore::default(), FakeFiles::default());
        store.fail_next(vec![StoreError::Timeout]);
        let run = run(&store, &files, 1000, &DownloadResume::default()).await;
        assert!(run.result.is_ok());
        assert_eq!(store.upload_calls().len(), 2);
    }

    #[tokio::test]
    async fn reports_local_file_errors() {
        let (store, files) = (FakeStore::default(), FakeFiles::default());
        files.fail();
        let run = run(&store, &files, 1000, &DownloadResume::default()).await;
        assert!(matches!(run.result, Err(StoreError::LocalFile(_))));
        assert_eq!(store.upload_calls(), Vec::new());
    }

    #[tokio::test]
    async fn stops_immediately_when_cancelled() {
        let (store, files) = (FakeStore::default(), FakeFiles::default());
        store.hang_uploads();
        let cancel = CancelFlag::default();
        let (job, settings) = (job(12 * MIB), settings());
        let (resume, progress) = (DownloadResume::default(), PartProgress::default());
        let task = download(&store, &files, &job, &settings, &resume, &progress, &cancel);
        let (result, ()) = tokio::join!(task, async { cancel.cancel() });
        assert_eq!(result, Err(StoreError::Cancelled));
    }

    fn entry(key: &str, size: u64) -> ObjectEntry {
        ObjectEntry {
            size,
            etag: Some(format!("\"{key}\"")),
            ..FakeStore::object(key)
        }
    }

    fn item(key: &str, is_folder: bool) -> SelectedItem {
        SelectedItem {
            key: key.into(),
            is_folder,
            size: 7,
            etag: None,
            last_modified_ms: None,
        }
    }

    fn targets(jobs: &[DownloadJob]) -> Vec<String> {
        jobs.iter().map(|j| j.target.to_string_lossy().into_owned()).collect()
    }

    #[tokio::test]
    async fn resolves_files_and_folders_below_the_open_prefix() {
        let store = FakeStore::with_pages(vec![
            ListPage {
                objects: vec![entry("backups/daily/", 0), entry("backups/daily/a.tar", 10)],
                prefixes: vec![],
                next_token: Some("t".into()),
            },
            ListPage {
                objects: vec![entry("backups/daily/2026/b.tar", 20)],
                prefixes: vec![],
                next_token: None,
            },
        ]);
        let items = [item("backups/daily/", true), item("backups/liesmich.txt", false)];
        let jobs = resolve_downloads(&store, "b", "backups/", &items, Path::new(r"D:\Ziel"))
            .await
            .unwrap();
        assert_eq!(
            targets(&jobs),
            [
                r"D:\Ziel\daily\a.tar",
                r"D:\Ziel\daily\2026\b.tar",
                r"D:\Ziel\liesmich.txt"
            ]
        );
        let sizes: Vec<u64> = jobs.iter().map(|j| j.size).collect();
        assert_eq!(sizes, [10, 20, 7]);
        assert_eq!(jobs[0].source.key, "backups/daily/a.tar");
        assert_eq!(jobs[0].etag.as_deref(), Some("\"backups/daily/a.tar\""));
        assert_eq!(store.requests()[0], ListRequest::recursive("b", "backups/daily/"));
    }

    #[tokio::test]
    async fn gives_colliding_keys_distinct_local_files() {
        let store = FakeStore::default();
        let items = [item("a:b.txt", false), item("a_b.txt", false), item("a?b.txt", false)];
        let jobs = resolve_downloads(&store, "b", "", &items, Path::new(r"D:\Ziel"))
            .await
            .unwrap();
        assert_eq!(
            targets(&jobs),
            [r"D:\Ziel\a_b.txt", r"D:\Ziel\a_b (2).txt", r"D:\Ziel\a_b (3).txt"]
        );
    }

    #[tokio::test]
    async fn passes_listing_errors_through() {
        let store = FakeStore::failing(StoreError::Timeout);
        let result = resolve_downloads(&store, "b", "", &[item("x/", true)], Path::new(r"D:\")).await;
        assert_eq!(result, Err(StoreError::Timeout));
    }

    const MD5: &str = "d41d8cd98f00b204e9800998ecf8427e";

    async fn verified(
        store: &FakeStore,
        files: &FakeFiles,
        checksums: Checksums,
    ) -> Result<DownloadOutcome, StoreError> {
        let job = DownloadJob {
            etag: Some(format!("\"{MD5}\"")),
            ..job(1000)
        };
        let mut options = settings();
        options.parts.checksums = checksums;
        let resume = DownloadResume::default();
        resume.mark_done(99);
        let result = download(
            store,
            files,
            &job,
            &options,
            &resume,
            &PartProgress::default(),
            &CancelFlag::default(),
        )
        .await;
        if result.is_err() {
            assert!(
                resume.done_parts().is_empty(),
                "verfälschte Teile werden nicht fortgesetzt"
            );
        }
        result
    }

    #[tokio::test]
    async fn replaces_existing_files_and_keeps_the_server_time_for_syncs() {
        let (store, files) = (FakeStore::default(), FakeFiles::default());
        files.set_existing(TARGET, 9_999_999);
        let job = DownloadJob {
            replace_existing: true,
            keep_remote_time: true,
            ..job(1000)
        };
        let result = download(
            &store,
            &files,
            &job,
            &settings(),
            &DownloadResume::default(),
            &PartProgress::default(),
            &CancelFlag::default(),
        )
        .await;
        assert_eq!(result, Ok(saved(TARGET)));
        assert!(
            files
                .calls()
                .contains(&FileCall::SetModified(PathBuf::from(TARGET), 2000))
        );
    }

    #[tokio::test]
    async fn accepts_downloads_whose_md5_matches_the_etag() {
        let (store, files) = (FakeStore::default(), FakeFiles::default());
        files.set_md5(MD5);
        assert_eq!(verified(&store, &files, Checksums::Verify).await, Ok(saved(TARGET)));
        assert!(!store.upload_calls().contains(&TransferCall::Read("head")));
    }

    #[tokio::test]
    async fn rejects_and_discards_corrupted_downloads() {
        let (store, files) = (FakeStore::default(), FakeFiles::default());
        files.set_md5("00000000000000000000000000000000");
        let result = verified(&store, &files, Checksums::Verify).await;
        assert!(
            matches!(result, Err(StoreError::Integrity(ref m)) if m.contains(MD5)),
            "{result:?}"
        );
        assert!(files.calls().contains(&FileCall::Discard(PathBuf::from(PARTIAL))));
        assert!(!files.calls().iter().any(|c| matches!(c, FileCall::Complete(..))));
    }

    #[tokio::test]
    async fn trusts_kms_encrypted_objects_and_skips_checks_when_disabled() {
        let (store, files) = (FakeStore::default(), FakeFiles::default());
        files.set_md5("00000000000000000000000000000000");
        store.set_head(ObjectHead {
            encryption: Some("aws:kms".into()),
            ..ObjectHead::default()
        });
        assert_eq!(verified(&store, &files, Checksums::Verify).await, Ok(saved(TARGET)));
        let plain = FakeStore::default();
        assert_eq!(verified(&plain, &files, Checksums::Off).await, Ok(saved(TARGET)));
        assert!(
            plain
                .upload_calls()
                .iter()
                .all(|c| matches!(c, TransferCall::Range { .. }))
        );
    }
}
