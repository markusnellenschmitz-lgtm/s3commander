//! Anwendungsdienst für Transfers: Warteschlange, Parallelität und Zustände laut
//! UI-SPEC §5 "Transfer-State-Machine", gemeinsam für Uploads, Downloads und Kopien.
//!
//! waiting → active → done; active → paused | failed | cancelled; paused/failed → waiting.
//! Pausierte Transfers setzen später fort: Uploads über ihre `UploadId`, Downloads über ihre
//! Teildatei, Kopien beginnen neu. Abbrechen räumt auf: Multipart-Uploads und -Kopien werden auf
//! dem Server verworfen, Teildateien von Downloads gelöscht.
//!
//! Gemeldet werden nur Änderungen: Bedienaktionen sofort, Fortschritt und Abschlüsse gesammelt im
//! Takt von [`TICK_INTERVAL`]. Warteschlange und Takt arbeiten über Indizes statt über alle Jobs.

use super::cancel::CancelFlag;
use super::copy::{CopyJob, CopySettings, CopySource, CopyTarget, resolve_copies, run_copy};
use super::download::{DownloadJob, DownloadOptions, DownloadOutcome, DownloadResume, download, resolve_downloads};
use super::error::AppError;
use super::parts::{PartProgress, PartSettings, RetryPolicy};
use super::relay::relay;
use super::upload::{PartContext, ResumeState, UploadJob, upload};
use crate::domain::bandwidth::BandwidthLimit;
use crate::domain::error::{ErrorReport, StoreError};
use crate::domain::local_path::partial_path;
use crate::domain::settings::{ConflictPolicy, TransferPreferences};
use crate::domain::transfer::{
    Checksums, Direction, LocalFile, ObjectAddress, ObjectRef, SelectedItem, TransferId, TransferSnapshot,
    TransferState, TransferUpdate, upload_key,
};
use crate::ports::{Clock, LocalFiles, ObjectStore, Spawner, StoreProvider, TransferEvents};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

/// Einstellungen › Transfers, wie die Transfer-Verwaltung sie braucht.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransferSettings {
    /// Gleichzeitige Transfers
    pub max_transfers: usize,
    pub parts: PartSettings,
    pub copy: CopySettings,
    pub conflict: ConflictPolicy,
    /// Bytes pro Sekunde; 0 = unbegrenzt.
    pub upload_limit: u64,
    /// Bytes pro Sekunde; 0 = unbegrenzt.
    pub download_limit: u64,
}

impl Default for TransferSettings {
    fn default() -> Self {
        Self::from(&TransferPreferences::default())
    }
}

impl From<&TransferPreferences> for TransferSettings {
    fn from(prefs: &TransferPreferences) -> Self {
        let retry = RetryPolicy {
            retries: prefs.retries,
            ..RetryPolicy::default()
        };
        let count = |value: u32| usize::try_from(value).unwrap_or(usize::MAX);
        Self {
            max_transfers: count(prefs.max_transfers),
            parts: PartSettings {
                part_size: prefs.part_size(),
                multipart_threshold: prefs.multipart_threshold(),
                parts_parallel: count(prefs.parts_parallel),
                retry,
                checksums: if prefs.verify_checksums {
                    Checksums::Verify
                } else {
                    Checksums::Off
                },
            },
            copy: CopySettings {
                retry,
                ..CopySettings::default()
            },
            conflict: prefs.conflict,
            upload_limit: prefs.upload_limit(),
            download_limit: prefs.download_limit(),
        }
    }
}

/// Ausgang eines Transfers, der nicht gescheitert ist.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Finished {
    /// Fertig; bei Downloads mit dem endgültigen lokalen Pfad.
    Done(Option<PathBuf>),
    /// Download nach der Konfliktregel übersprungen.
    Skipped,
}

/// Gewicht neuer Messungen im gleitenden Mittel des Tempos.
const SPEED_SMOOTHING: f64 = 0.3;
pub const TICK_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stop {
    Pause,
    Cancel,
}

#[derive(Debug, Default)]
struct Speed {
    last_bytes: u64,
    last_at: Option<Instant>,
    bytes_per_sec: f64,
}

impl Speed {
    fn sample(&mut self, bytes: u64, now: Instant) {
        if let Some(last_at) = self.last_at {
            let seconds = now.saturating_duration_since(last_at).as_secs_f64();
            if seconds > 0.0 {
                #[allow(clippy::cast_precision_loss)] // Bytes pro Sekunde, Genauigkeit reicht.
                let rate = bytes.saturating_sub(self.last_bytes) as f64 / seconds;
                self.bytes_per_sec = SPEED_SMOOTHING.mul_add(rate, (1.0 - SPEED_SMOOTHING) * self.bytes_per_sec);
            }
        }
        self.last_bytes = bytes;
        self.last_at = Some(now);
    }

    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // nie negativ, gerundet
    fn rounded(&self) -> u64 {
        self.bytes_per_sec.round() as u64
    }
}

/// Was ein Transfer überträgt, samt dem Zustand zum Fortsetzen.
#[derive(Debug, Clone)]
enum Work {
    Upload {
        job: UploadJob,
        resume: Arc<ResumeState>,
    },
    Download {
        job: DownloadJob,
        resume: Arc<DownloadResume>,
    },
    /// `uploads` hält die `UploadId` einer laufenden Multipart-Kopie für das Aufräumen.
    Copy {
        job: CopyJob,
        uploads: Arc<ResumeState>,
    },
}

impl Work {
    fn upload(job: UploadJob) -> Self {
        Self::Upload {
            job,
            resume: Arc::default(),
        }
    }

    fn download(job: DownloadJob) -> Self {
        Self::Download {
            job,
            resume: Arc::default(),
        }
    }

    fn copy(job: CopyJob) -> Self {
        Self::Copy {
            job,
            uploads: Arc::default(),
        }
    }

    fn direction(&self) -> Direction {
        match self {
            Self::Upload { .. } => Direction::Upload,
            Self::Download { .. } => Direction::Download,
            Self::Copy { .. } => Direction::Copy,
        }
    }

    /// Das Objekt im Bucket, um das es geht; bei Kopien das Ziel.
    fn object(&self) -> &ObjectRef {
        match self {
            Self::Upload { job, .. } => &job.target,
            Self::Download { job, .. } => &job.source,
            Self::Copy { job, .. } => &job.target,
        }
    }

    fn size(&self) -> u64 {
        match self {
            Self::Upload { job, .. } => job.size,
            Self::Download { job, .. } => job.size,
            Self::Copy { job, .. } => job.size,
        }
    }

    fn local_path(&self) -> String {
        match self {
            Self::Upload { job, .. } => job.file.display().to_string(),
            Self::Download { job, .. } => job.target.display().to_string(),
            Self::Copy { .. } => String::new(),
        }
    }

    /// Verbindung der Quelle bei Kopien zwischen zwei Verbindungen.
    fn source_profile(&self) -> Option<String> {
        match self {
            Self::Copy { job, .. } => job.relay_from.clone(),
            _ => None,
        }
    }

    fn copy_source(&self) -> Option<ObjectAddress> {
        match self {
            Self::Copy { job, .. } => Some(ObjectAddress {
                bucket: job.source.bucket.clone(),
                key: job.source.key.clone(),
            }),
            _ => None,
        }
    }
}

/// Aufräumen nach einem Abbruch.
#[derive(Debug)]
enum Cleanup {
    /// Begonnenen Multipart-Upload auf dem Server verwerfen.
    AbortUpload {
        profile_id: String,
        target: ObjectRef,
        upload_id: String,
    },
    /// Teildatei eines Downloads löschen.
    DiscardPartial(PathBuf),
}

#[derive(Debug)]
struct Job {
    id: TransferId,
    profile_id: String,
    name: String,
    local_path: String,
    work: Work,
    state: TransferState,
    error: Option<ErrorReport>,
    progress: Arc<PartProgress>,
    cancel: CancelFlag,
    stop: Option<Stop>,
    finished_ms: Option<i64>,
    speed: Speed,
}

impl Job {
    fn new(id: TransferId, profile_id: &str, work: Work, progress: PartProgress) -> Self {
        let key = &work.object().key;
        Self {
            id,
            profile_id: profile_id.to_owned(),
            name: key.rsplit('/').next().unwrap_or(key).to_owned(),
            local_path: work.local_path(),
            work,
            state: TransferState::Waiting,
            error: None,
            progress: Arc::new(progress),
            cancel: CancelFlag::default(),
            stop: None,
            finished_ms: None,
            speed: Speed::default(),
        }
    }

    fn snapshot(&self) -> TransferSnapshot {
        let active = self.state == TransferState::Active;
        let object = self.work.object();
        let size = self.work.size();
        TransferSnapshot {
            id: self.id,
            direction: self.work.direction(),
            profile_id: self.profile_id.clone(),
            name: self.name.clone(),
            local_path: self.local_path.clone(),
            copy_source: self.work.copy_source(),
            source_profile_id: self.work.source_profile(),
            bucket: object.bucket.clone(),
            key: object.key.clone(),
            total_bytes: size,
            done_bytes: if self.state == TransferState::Done {
                size
            } else {
                self.progress.done_bytes()
            },
            state: self.state,
            bytes_per_sec: if active { self.speed.rounded() } else { 0 },
            part_count: self.progress.part_count(),
            parts_done: self.progress.parts_done(),
            error: self.error.clone(),
            finished_ms: self.finished_ms,
        }
    }

    /// Was nach einem Abbruch aufzuräumen ist; der Zustand zum Fortsetzen wird verworfen.
    fn take_cleanup(&self) -> Option<Cleanup> {
        match &self.work {
            Work::Upload { job, resume } => {
                let upload_id = resume.upload_id()?;
                resume.set(None);
                Some(Cleanup::AbortUpload {
                    profile_id: self.profile_id.clone(),
                    target: job.target.clone(),
                    upload_id,
                })
            }
            Work::Download { job, resume } => {
                resume.clear();
                Some(Cleanup::DiscardPartial(partial_path(&job.target)))
            }
            Work::Copy { job, uploads } => {
                let upload_id = uploads.upload_id()?;
                uploads.set(None);
                Some(Cleanup::AbortUpload {
                    profile_id: self.profile_id.clone(),
                    target: job.target.clone(),
                    upload_id,
                })
            }
        }
    }
}

/// Alle Transfers samt Indizes, damit auch Hunderttausende nicht bei jedem Schritt
/// durchlaufen werden. Zustände ändern sich nur über [`Table::update`].
#[derive(Debug, Default)]
struct Table {
    next_id: TransferId,
    /// Aufsteigend nach `id`, neue Transfers kommen ans Ende.
    jobs: Vec<Job>,
    queue_paused: bool,
    waiting: BTreeSet<TransferId>,
    active: BTreeSet<TransferId>,
    /// Seit der letzten Meldung geändert.
    dirty: BTreeSet<TransferId>,
    /// Seit der letzten Meldung entfernt.
    removed: Vec<TransferId>,
}

impl Table {
    fn push(&mut self, job: Job) {
        self.dirty.insert(job.id);
        if let Some(index) = self.index_of(job.state) {
            index.insert(job.id);
        }
        self.jobs.push(job);
    }

    fn get(&self, id: TransferId) -> Option<&Job> {
        let position = self.jobs.binary_search_by_key(&id, |j| j.id).ok()?;
        Some(&self.jobs[position])
    }

    /// Ändert einen Transfer, hält die Indizes aktuell und merkt ihn für die nächste Meldung.
    fn update<T>(&mut self, id: TransferId, change: impl FnOnce(&mut Job) -> T) -> Option<T> {
        let position = self.jobs.binary_search_by_key(&id, |j| j.id).ok()?;
        let job = &mut self.jobs[position];
        let before = job.state;
        let result = change(job);
        let after = job.state;
        if before != after {
            if let Some(index) = self.index_of(before) {
                index.remove(&id);
            }
            if let Some(index) = self.index_of(after) {
                index.insert(id);
            }
        }
        self.dirty.insert(id);
        Some(result)
    }

    fn index_of(&mut self, state: TransferState) -> Option<&mut BTreeSet<TransferId>> {
        match state {
            TransferState::Waiting => Some(&mut self.waiting),
            TransferState::Active => Some(&mut self.active),
            _ => None,
        }
    }

    /// Wartende und laufende Transfers in Reihenfolge der IDs.
    fn queued(&self) -> Vec<TransferId> {
        self.waiting.union(&self.active).copied().collect()
    }

    /// Läuft über alle Transfers; nur für seltene Bedienaktionen.
    fn ids_in(&self, state: TransferState) -> Vec<TransferId> {
        self.jobs.iter().filter(|j| j.state == state).map(|j| j.id).collect()
    }

    fn remove_finished(&mut self) {
        let (removed, dirty) = (&mut self.removed, &mut self.dirty);
        self.jobs.retain(|job| {
            let finished = job.state.is_finished();
            if finished {
                removed.push(job.id);
                dirty.remove(&job.id);
            }
            !finished
        });
    }

    /// Änderungen seit der letzten Meldung; leert die Merklisten.
    fn take_update(&mut self) -> TransferUpdate {
        let dirty = std::mem::take(&mut self.dirty);
        TransferUpdate {
            changed: dirty
                .into_iter()
                .filter_map(|id| self.get(id).map(Job::snapshot))
                .collect(),
            removed: std::mem::take(&mut self.removed),
        }
    }
}

struct Inner<P, L, E, S, C> {
    provider: P,
    files: L,
    events: E,
    spawner: S,
    clock: C,
    settings: Mutex<TransferSettings>,
    upload_limit: Arc<BandwidthLimit>,
    download_limit: Arc<BandwidthLimit>,
    table: Mutex<Table>,
    /// Hält Meldungen in Reihenfolge: eine ältere darf keine neuere überholen.
    publishing: Mutex<()>,
}

pub struct TransferManager<P, L, E, S, C> {
    inner: Arc<Inner<P, L, E, S, C>>,
}

impl<P, L, E, S, C> Clone for TransferManager<P, L, E, S, C> {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl<P, L, E, S, C> std::fmt::Debug for TransferManager<P, L, E, S, C> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TransferManager").finish_non_exhaustive()
    }
}

impl<P, L, E, S, C> TransferManager<P, L, E, S, C>
where
    P: StoreProvider + 'static,
    L: LocalFiles + 'static,
    E: TransferEvents + 'static,
    S: Spawner + 'static,
    C: Clock + 'static,
{
    pub fn new(provider: P, files: L, events: E, spawner: S, clock: C, settings: TransferSettings) -> Self {
        let inner = Inner {
            provider,
            files,
            events,
            spawner,
            clock,
            settings: Mutex::new(settings),
            upload_limit: Arc::default(),
            download_limit: Arc::default(),
            table: Mutex::default(),
            publishing: Mutex::default(),
        };
        let manager = Self { inner: Arc::new(inner) };
        manager.apply_limits(&settings);
        manager
    }

    /// Übernimmt neue Einstellungen sofort: Limits gelten ab dem nächsten Datenstück, Teilgröße
    /// und Parallelität ab dem nächsten Start, mehr gleichzeitige Transfers starten sofort.
    pub fn apply_settings(&self, settings: TransferSettings) {
        *self.inner.settings.lock().unwrap_or_else(PoisonError::into_inner) = settings;
        self.apply_limits(&settings);
        self.pump();
    }

    #[must_use]
    pub fn settings(&self) -> TransferSettings {
        *self.inner.settings.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn apply_limits(&self, settings: &TransferSettings) {
        self.inner.upload_limit.set_rate(settings.upload_limit);
        self.inner.download_limit.set_rate(settings.download_limit);
    }

    /// Fortschritt mit dem Bandbreitenlimit der Richtung. Server-Kopien laufen im Dienst und sind
    /// frei; Kopien zwischen Verbindungen laden über den Rechner hoch und zählen als Upload.
    fn progress_for(&self, work: &Work) -> PartProgress {
        let limit = match work {
            Work::Upload { .. } => Some(Arc::clone(&self.inner.upload_limit)),
            Work::Download { .. } => Some(Arc::clone(&self.inner.download_limit)),
            Work::Copy { job, .. } if job.relay_from.is_some() => Some(Arc::clone(&self.inner.upload_limit)),
            Work::Copy { .. } => None,
        };
        PartProgress::limited(limit)
    }

    /// Reiht Uploads der gewählten Dateien und Ordner in das Präfix `prefix` ein.
    ///
    /// # Errors
    /// `LocalFile`, wenn ein Pfad nicht gelesen werden kann.
    pub fn enqueue_uploads(
        &self,
        profile_id: &str,
        bucket: &str,
        prefix: &str,
        paths: &[PathBuf],
    ) -> Result<Vec<TransferId>, AppError> {
        let files = self.inner.files.expand(paths)?.into_iter().map(|file| {
            let key = upload_key(prefix, &file.relative);
            (file, key)
        });
        Ok(self.enqueue_upload_files(profile_id, bucket, files))
    }

    /// Reiht Uploads einzelner Dateien unter genau diesen Keys ein (Abgleich).
    pub fn enqueue_upload_files(
        &self,
        profile_id: &str,
        bucket: &str,
        files: impl IntoIterator<Item = (LocalFile, String)>,
    ) -> Vec<TransferId> {
        let works = files.into_iter().map(|(file, key)| {
            Work::upload(UploadJob {
                target: ObjectRef {
                    bucket: bucket.to_owned(),
                    key,
                    content_type: Some(file.content_type),
                },
                file: file.path,
                size: file.size,
            })
        });
        self.enqueue(profile_id, works)
    }

    /// Reiht fertig geplante Downloads ein (Abgleich).
    pub fn enqueue_download_jobs(&self, profile_id: &str, jobs: Vec<DownloadJob>) -> Vec<TransferId> {
        self.enqueue(profile_id, jobs.into_iter().map(Work::download))
    }

    /// Reiht Downloads der gewählten Objekte und Ordner nach `target_dir` ein. Die Ordnerstruktur
    /// unterhalb des offenen Präfixes `prefix` bleibt erhalten.
    ///
    /// # Errors
    /// Unbekanntes Profil oder Fehler beim Listen der Ordner.
    pub async fn enqueue_downloads(
        &self,
        profile_id: &str,
        bucket: &str,
        prefix: &str,
        items: &[SelectedItem],
        target_dir: &Path,
    ) -> Result<Vec<TransferId>, AppError> {
        let store = self.inner.provider.store_for(profile_id)?;
        let jobs = resolve_downloads(store.as_ref(), bucket, prefix, items, target_dir).await?;
        Ok(self.enqueue_download_jobs(profile_id, jobs))
    }

    /// Reiht Kopien der Auswahl in den Zielordner ein, auch in eine andere Verbindung; mit
    /// `delete_source` werden die Originale nach erfolgreicher Kopie gelöscht (Verschieben).
    ///
    /// # Errors
    /// Unbekanntes Profil, ein Ordner würde in sich selbst eingefügt, oder Fehler beim Listen.
    pub async fn enqueue_copies(
        &self,
        source: CopySource<'_>,
        target: CopyTarget<'_>,
        delete_source: bool,
    ) -> Result<Vec<TransferId>, AppError> {
        let sources = self.inner.provider.store_for(source.profile_id)?;
        let targets = self.inner.provider.store_for(target.profile_id)?;
        let jobs = resolve_copies(sources.as_ref(), targets.as_ref(), source, target, delete_source).await?;
        Ok(self.enqueue(target.profile_id, jobs.into_iter().map(Work::copy)))
    }

    #[must_use]
    pub fn snapshots(&self) -> Vec<TransferSnapshot> {
        self.lock().jobs.iter().map(Job::snapshot).collect()
    }

    /// Wartende werden pausiert, laufende unterbrochen; der Stand zum Fortsetzen bleibt erhalten.
    pub fn pause(&self, id: TransferId) {
        self.lock().update(id, Self::pause_job);
        self.publish();
    }

    pub fn resume(&self, id: TransferId) {
        {
            let mut table = self.lock();
            table.queue_paused = false;
            table.update(id, |job| {
                if job.state == TransferState::Paused {
                    job.state = TransferState::Waiting;
                }
            });
        }
        self.publish();
        self.pump();
    }

    /// Bricht ab und räumt auf (Multipart-Upload verwerfen, Teildatei löschen).
    pub fn cancel(&self, id: TransferId) {
        let cleanup = self
            .lock()
            .update(id, |job| match job.state {
                TransferState::Active => {
                    job.stop = Some(Stop::Cancel);
                    job.cancel.cancel();
                    None
                }
                TransferState::Waiting | TransferState::Paused | TransferState::Failed => {
                    job.state = TransferState::Cancelled;
                    job.take_cleanup()
                }
                _ => None,
            })
            .flatten();
        self.clean_up(cleanup);
        self.publish();
    }

    /// "Erneut versuchen": setzt beim letzten bestätigten Teil fort.
    pub fn retry(&self, id: TransferId) {
        self.lock().update(id, |job| {
            if job.state == TransferState::Failed {
                job.state = TransferState::Waiting;
                job.error = None;
            }
        });
        self.publish();
        self.pump();
    }

    pub fn pause_all(&self) {
        {
            let mut table = self.lock();
            table.queue_paused = true;
            for id in table.queued() {
                table.update(id, Self::pause_job);
            }
        }
        self.publish();
    }

    pub fn resume_all(&self) {
        {
            let mut table = self.lock();
            table.queue_paused = false;
            for id in table.ids_in(TransferState::Paused) {
                table.update(id, |job| job.state = TransferState::Waiting);
            }
        }
        self.publish();
        self.pump();
    }

    /// "Fertige entfernen": fertige und abgebrochene Transfers aus der Liste nehmen.
    pub fn remove_finished(&self) {
        self.lock().remove_finished();
        self.publish();
    }

    /// Aktualisiert das Tempo der laufenden Transfers und meldet alles Geänderte.
    pub fn tick(&self) {
        let now = self.inner.clock.monotonic();
        {
            let mut table = self.lock();
            let active: Vec<TransferId> = table.active.iter().copied().collect();
            for id in active {
                table.update(id, |job| job.speed.sample(job.progress.done_bytes(), now));
            }
        }
        self.publish();
    }

    /// Startet die regelmäßige Fortschrittsmeldung.
    pub fn start_ticker(&self) {
        let manager = self.clone();
        self.inner.spawner.spawn(Box::pin(async move {
            let mut interval = tokio::time::interval(TICK_INTERVAL);
            loop {
                interval.tick().await;
                manager.tick();
            }
        }));
    }

    /// Nimmt neue Transfers in die Warteschlange und startet, was Platz hat.
    fn enqueue(&self, profile_id: &str, works: impl Iterator<Item = Work>) -> Vec<TransferId> {
        let ids = {
            let mut table = self.lock();
            let mut ids = Vec::new();
            for work in works {
                table.next_id += 1;
                let id = table.next_id;
                ids.push(id);
                let progress = self.progress_for(&work);
                table.push(Job::new(id, profile_id, work, progress));
            }
            ids
        };
        self.publish();
        self.pump();
        ids
    }

    fn pause_job(job: &mut Job) {
        match job.state {
            TransferState::Waiting => job.state = TransferState::Paused,
            TransferState::Active => {
                job.stop = Some(Stop::Pause);
                job.cancel.cancel();
            }
            _ => {}
        }
    }

    /// Startet wartende Transfers, bis die Parallelität erreicht ist. Der Start wird mit dem
    /// nächsten Takt gemeldet.
    fn pump(&self) {
        let max_transfers = self.settings().max_transfers;
        let started: Vec<TransferId> = {
            let mut table = self.lock();
            if table.queue_paused {
                return;
            }
            let free = max_transfers.saturating_sub(table.active.len());
            let started: Vec<TransferId> = table.waiting.iter().take(free).copied().collect();
            for &id in &started {
                table.update(id, |job| {
                    job.state = TransferState::Active;
                    job.stop = None;
                    job.cancel = CancelFlag::default();
                    job.speed = Speed::default();
                });
            }
            started
        };
        for id in started {
            let manager = self.clone();
            self.inner.spawner.spawn(Box::pin(async move { manager.run(id).await }));
        }
    }

    async fn run(&self, id: TransferId) {
        let Some((profile_id, work, progress, cancel)) = self.lock().get(id).map(|j| {
            (
                j.profile_id.clone(),
                j.work.clone(),
                Arc::clone(&j.progress),
                j.cancel.clone(),
            )
        }) else {
            return;
        };
        let result = match self.store_for(&profile_id) {
            Ok(store) => self.execute(store.as_ref(), &work, &progress, &cancel).await,
            Err(error) => Err(error),
        };
        self.finish(id, result);
    }

    /// Store einer Verbindung; Fehler werden zum Fehler des Transfers.
    fn store_for(&self, profile_id: &str) -> Result<Arc<P::Store>, StoreError> {
        self.inner.provider.store_for(profile_id).map_err(|error| match error {
            AppError::Store(error) => error,
            other => StoreError::InvalidConfig(other.to_string()),
        })
    }

    /// Überträgt und liefert bei Downloads den endgültigen lokalen Pfad.
    async fn execute(
        &self,
        store: &P::Store,
        work: &Work,
        progress: &PartProgress,
        cancel: &CancelFlag,
    ) -> Result<Finished, StoreError> {
        let settings = self.settings();
        match work {
            Work::Upload { job, resume } => upload(store, job, &settings.parts, resume, progress, cancel)
                .await
                .map(|_| Finished::Done(None)),
            Work::Download { job, resume } => {
                let options = DownloadOptions {
                    parts: settings.parts,
                    conflict: settings.conflict,
                };
                let outcome = download(store, &self.inner.files, job, &options, resume, progress, cancel).await?;
                Ok(match outcome {
                    DownloadOutcome::Saved(path) => Finished::Done(Some(path)),
                    DownloadOutcome::Skipped => Finished::Skipped,
                })
            }
            Work::Copy { job, uploads } => {
                match &job.relay_from {
                    Some(source_profile) => {
                        let source = self.store_for(source_profile)?;
                        let context = PartContext {
                            settings: &settings.parts,
                            resume: uploads,
                            progress,
                            cancel,
                        };
                        relay(source.as_ref(), store, job, &context).await?;
                    }
                    None => run_copy(store, job, &settings.copy, progress, uploads, cancel).await?,
                }
                Ok(Finished::Done(None))
            }
        }
    }

    /// Hält das Ergebnis fest; gemeldet wird es mit dem nächsten Takt, damit viele kleine
    /// Dateien nicht je eine Meldung auslösen.
    fn finish(&self, id: TransferId, result: Result<Finished, StoreError>) {
        let finished_ms = self.inner.clock.unix_ms();
        let cleanup = self
            .lock()
            .update(id, |job| match result {
                Ok(Finished::Done(local_path)) => {
                    job.state = TransferState::Done;
                    job.finished_ms = Some(finished_ms);
                    if let Some(path) = local_path {
                        job.local_path = path.display().to_string();
                    }
                    None
                }
                Ok(Finished::Skipped) => {
                    job.state = TransferState::Skipped;
                    job.finished_ms = Some(finished_ms);
                    None
                }
                Err(StoreError::Cancelled) if job.stop == Some(Stop::Pause) => {
                    job.state = TransferState::Paused;
                    None
                }
                Err(StoreError::Cancelled) => {
                    job.state = TransferState::Cancelled;
                    job.take_cleanup()
                }
                Err(error) => {
                    job.state = TransferState::Failed;
                    job.error = Some(ErrorReport::from(&error));
                    None
                }
            })
            .flatten();
        self.clean_up(cleanup);
        self.pump();
    }

    fn clean_up(&self, cleanup: Option<Cleanup>) {
        match cleanup {
            Some(Cleanup::AbortUpload {
                profile_id,
                target,
                upload_id,
            }) => self.abort_upload(&profile_id, target, upload_id),
            Some(Cleanup::DiscardPartial(partial)) => {
                if let Err(error) = self.inner.files.discard_download(&partial) {
                    log::warn!("Teildatei {} konnte nicht gelöscht werden: {error}", partial.display());
                }
            }
            None => {}
        }
    }

    fn abort_upload(&self, profile_id: &str, target: ObjectRef, upload_id: String) {
        let Ok(store) = self.inner.provider.store_for(profile_id) else {
            return;
        };
        self.inner.spawner.spawn(Box::pin(async move {
            if let Err(error) = store.abort_multipart_upload(&target, &upload_id).await {
                log::warn!("Multipart-Upload {upload_id} konnte nicht verworfen werden: {error}");
            }
        }));
    }

    /// Meldet alles seit der letzten Meldung Geänderte; ohne Änderungen nichts.
    fn publish(&self) {
        let _order = self.inner.publishing.lock().unwrap_or_else(PoisonError::into_inner);
        let update = self.lock().take_update();
        if !update.is_empty() {
            self.inner.events.publish(update);
        }
    }

    fn lock(&self) -> MutexGuard<'_, Table> {
        self.inner.table.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::parts::RetryPolicy;
    use crate::application::test_support::{
        FakeClock, FakeFiles, FakeProvider, FakeStore, FileCall, RecordingEvents, TokioSpawner, TransferCall,
        local_path,
    };
    use crate::domain::error::ServiceError;
    use crate::domain::multipart::MIB;

    type Manager = TransferManager<FakeProvider, FakeFiles, Arc<RecordingEvents>, TokioSpawner, Arc<FakeClock>>;

    struct Setup {
        manager: Manager,
        store: Arc<FakeStore>,
        events: Arc<RecordingEvents>,
    }

    fn setup(max_transfers: usize, sizes: &[u64]) -> Setup {
        setup_with(FakeStore::default(), max_transfers, sizes)
    }

    fn setup_with(store: FakeStore, max_transfers: usize, sizes: &[u64]) -> Setup {
        let store = Arc::new(store);
        let events = Arc::new(RecordingEvents::default());
        let settings = TransferSettings {
            max_transfers,
            parts: PartSettings {
                part_size: 5 * MIB,
                multipart_threshold: 8 * MIB,
                parts_parallel: 2,
                retry: RetryPolicy {
                    retries: 0,
                    delay: Duration::from_millis(1),
                },
                ..PartSettings::default()
            },
            copy: CopySettings {
                part_size: 5 * MIB,
                retry: RetryPolicy {
                    retries: 0,
                    delay: Duration::from_millis(1),
                },
            },
            ..TransferSettings::default()
        };
        let manager = TransferManager::new(
            FakeProvider::new(Arc::clone(&store)),
            FakeFiles::with_sizes(sizes),
            Arc::clone(&events),
            TokioSpawner,
            Arc::new(FakeClock::stepping(Duration::from_millis(100))),
            settings,
        );
        Setup { manager, store, events }
    }

    fn states(manager: &Manager) -> Vec<TransferState> {
        manager.snapshots().into_iter().map(|s| s.state).collect()
    }

    async fn wait_for(manager: &Manager, done: impl Fn(&[TransferState]) -> bool) {
        for _ in 0..500 {
            if done(&states(manager)) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        panic!("Zustand nicht erreicht: {:?}", states(manager));
    }

    fn all(state: TransferState) -> impl Fn(&[TransferState]) -> bool {
        move |s| !s.is_empty() && s.iter().all(|x| *x == state)
    }

    fn enqueue(s: &Setup) -> Vec<TransferId> {
        let paths = [PathBuf::from("C:\\upload")];
        s.manager.enqueue_uploads("p1", "media", "video/", &paths).unwrap()
    }

    #[tokio::test]
    async fn uploads_files_into_the_target_prefix() {
        let s = setup(2, &[1000, 12 * MIB]);
        let ids = enqueue(&s);
        assert_eq!(ids, [1, 2]);
        wait_for(&s.manager, all(TransferState::Done)).await;

        let snapshots = s.manager.snapshots();
        assert_eq!(snapshots[0].key, "video/upload/datei-0.bin");
        assert_eq!(snapshots[0].name, "datei-0.bin");
        assert_eq!(snapshots[0].bucket, "media");
        assert_eq!(snapshots[1].done_bytes, 12 * MIB);
        assert_eq!(snapshots[1].part_count, 3);
        assert!(
            snapshots
                .iter()
                .all(|t| t.finished_ms.is_some() && t.bytes_per_sec == 0)
        );
        assert_eq!(s.events.count(), 1, "Abschlüsse warten auf den Takt");
        s.manager.tick();
        let update = s.events.last().unwrap();
        assert_eq!(
            update.changed.iter().map(|t| t.state).collect::<Vec<_>>(),
            [TransferState::Done; 2]
        );
        s.manager.tick();
        assert_eq!(s.events.count(), 2, "ohne Änderung keine Meldung");
    }

    #[tokio::test]
    async fn reports_only_what_changed() {
        let s = setup(1, &[12 * MIB, 10, 20]);
        s.store.hang_uploads();
        enqueue(&s);
        assert_eq!(s.events.last().unwrap().changed.len(), 3, "Einreihen meldet alle neuen");
        wait_for(&s.manager, |st| st[0] == TransferState::Active).await;
        s.manager.tick();
        assert_eq!(ids(&s.events.last().unwrap().changed), [1], "Takt meldet den laufenden");
        s.manager.pause(3);
        let update = s.events.last().unwrap();
        assert_eq!(
            (ids(&update.changed), update.changed[0].state),
            (vec![3], TransferState::Paused)
        );
        s.manager.cancel(2);
        s.manager.cancel(3);
        s.manager.remove_finished();
        assert_eq!(
            s.events.last().unwrap(),
            TransferUpdate {
                changed: Vec::new(),
                removed: vec![2, 3]
            }
        );
    }

    #[tokio::test]
    async fn keeps_the_queue_order_with_many_transfers() {
        let sizes = vec![10; 2000];
        let s = setup(4, &sizes);
        enqueue(&s);
        wait_for(&s.manager, all(TransferState::Done)).await;
        s.manager.tick();
        assert_eq!(s.events.last().unwrap().changed.len(), 2000);
        let finished: Vec<i64> = s.manager.snapshots().iter().filter_map(|t| t.finished_ms).collect();
        assert_eq!(finished.len(), 2000);
    }

    fn ids(transfers: &[TransferSnapshot]) -> Vec<TransferId> {
        transfers.iter().map(|t| t.id).collect()
    }

    #[tokio::test]
    async fn respects_the_parallel_limit() {
        let s = setup(2, &[10, 20, 30]);
        s.store.hang_uploads();
        enqueue(&s);
        wait_for(&s.manager, |st| {
            st == [TransferState::Active, TransferState::Active, TransferState::Waiting]
        })
        .await;
    }

    #[tokio::test]
    async fn pauses_and_resumes_running_and_waiting_transfers() {
        let s = setup(1, &[10, 20]);
        s.store.hang_uploads();
        let ids = enqueue(&s);
        wait_for(&s.manager, |st| st == [TransferState::Active, TransferState::Waiting]).await;
        s.manager.pause(ids[0]);
        s.manager.pause(ids[1]);
        wait_for(&s.manager, all(TransferState::Paused)).await;

        s.store.release_uploads();
        s.manager.resume(ids[0]);
        s.manager.resume(ids[1]);
        wait_for(&s.manager, all(TransferState::Done)).await;
    }

    #[tokio::test]
    async fn pauses_and_resumes_the_whole_queue() {
        let s = setup(1, &[10, 20]);
        s.store.hang_uploads();
        enqueue(&s);
        wait_for(&s.manager, |st| st[0] == TransferState::Active).await;
        s.manager.pause_all();
        wait_for(&s.manager, all(TransferState::Paused)).await;
        s.store.release_uploads();
        s.manager.resume_all();
        wait_for(&s.manager, all(TransferState::Done)).await;
    }

    #[tokio::test]
    async fn cancels_and_aborts_started_multipart_uploads() {
        let s = setup(1, &[12 * MIB, 10]);
        s.store.hang_after_create();
        let ids = enqueue(&s);
        wait_for(&s.manager, |st| st[0] == TransferState::Active).await;
        // Warten, bis die UploadId vergeben ist.
        for _ in 0..100 {
            if s.store.upload_calls().contains(&TransferCall::Create) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        s.manager.cancel(ids[1]);
        s.manager.cancel(ids[0]);
        wait_for(&s.manager, all(TransferState::Cancelled)).await;
        for _ in 0..100 {
            if s.store.upload_calls().contains(&TransferCall::Abort) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        panic!("Multipart-Upload wurde nicht verworfen: {:?}", s.store.upload_calls());
    }

    #[tokio::test]
    async fn marks_failures_and_retries_them() {
        let s = setup(1, &[10]);
        s.store.fail_next(vec![StoreError::Service(ServiceError {
            code: "AccessDenied".into(),
            message: "nein".into(),
            http_status: 403,
            request_id: None,
        })]);
        let ids = enqueue(&s);
        wait_for(&s.manager, all(TransferState::Failed)).await;
        assert!(s.manager.snapshots()[0].error.is_some());
        s.manager.retry(ids[0]);
        wait_for(&s.manager, all(TransferState::Done)).await;
        assert!(s.manager.snapshots()[0].error.is_none());
    }

    #[tokio::test]
    async fn fails_when_the_profile_is_unavailable() {
        let s = setup(1, &[10]);
        s.manager.inner.provider.make_unavailable();
        enqueue(&s);
        wait_for(&s.manager, all(TransferState::Failed)).await;
        let error = s.manager.snapshots()[0].error.clone().unwrap();
        assert_eq!(error.kind, "invalidConfig");
        assert!(error.message.contains("p1"), "{error:?}");
    }

    #[tokio::test]
    async fn removes_finished_transfers_and_ignores_invalid_actions() {
        let s = setup(1, &[10, 20]);
        let ids = enqueue(&s);
        wait_for(&s.manager, all(TransferState::Done)).await;
        s.manager.pause(ids[0]);
        s.manager.resume(ids[0]);
        s.manager.retry(ids[0]);
        s.manager.cancel(ids[0]);
        s.manager.pause(999);
        assert_eq!(states(&s.manager), [TransferState::Done, TransferState::Done]);
        s.manager.remove_finished();
        assert_eq!(s.manager.snapshots(), Vec::new());
    }

    #[tokio::test]
    async fn reports_speed_while_active() {
        let s = setup(1, &[12 * MIB]);
        s.store.hang_uploads();
        enqueue(&s);
        wait_for(&s.manager, all(TransferState::Active)).await;
        let before = s.events.count();
        s.manager.tick();
        s.manager.tick();
        assert_eq!(s.events.count(), before + 2);
        assert_eq!(s.manager.snapshots()[0].bytes_per_sec, 0, "ohne Fortschritt kein Tempo");
    }

    #[tokio::test]
    async fn does_not_publish_ticks_without_active_transfers() {
        let s = setup(1, &[]);
        s.manager.tick();
        assert_eq!(s.events.count(), 0);
    }

    #[tokio::test]
    async fn reports_local_file_errors_when_enqueueing() {
        let s = setup(1, &[]);
        s.manager.inner.files.fail();
        let result = s.manager.enqueue_uploads("p1", "b", "", &[PathBuf::from("X:\\fehlt")]);
        assert!(matches!(result, Err(AppError::Store(StoreError::LocalFile(_)))));
    }

    #[tokio::test]
    async fn runs_the_ticker_in_the_background() {
        let s = setup(1, &[12 * MIB]);
        s.store.hang_uploads();
        enqueue(&s);
        wait_for(&s.manager, all(TransferState::Active)).await;
        let before = s.events.count();
        s.manager.start_ticker();
        tokio::time::sleep(TICK_INTERVAL * 2).await;
        assert!(s.events.count() > before);
    }

    fn selected_item(key: &str, is_folder: bool) -> SelectedItem {
        SelectedItem {
            key: key.into(),
            is_folder,
            size: 12 * MIB,
            etag: None,
            last_modified_ms: None,
        }
    }

    async fn enqueue_download(s: &Setup, items: &[SelectedItem]) -> Vec<TransferId> {
        s.manager
            .enqueue_downloads("p1", "media", "video/", items, Path::new("Ziel"))
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn downloads_objects_and_folders_into_the_target_folder() {
        let store = FakeStore::with_pages(vec![crate::domain::object::ListPage {
            objects: vec![FakeStore::object("video/clips/a.mp4")],
            prefixes: vec![],
            next_token: None,
        }]);
        let s = setup_with(store, 2, &[]);
        let ids = enqueue_download(
            &s,
            &[
                selected_item("video/film.mkv", false),
                selected_item("video/clips/", true),
            ],
        )
        .await;
        assert_eq!(ids, [1, 2]);
        wait_for(&s.manager, all(TransferState::Done)).await;

        let snapshots = s.manager.snapshots();
        assert_eq!(snapshots[0].direction, Direction::Download);
        assert_eq!(snapshots[0].name, "film.mkv");
        assert_eq!(snapshots[0].local_path, local_path(&["Ziel", "film.mkv"]));
        assert_eq!((snapshots[0].done_bytes, snapshots[0].part_count), (12 * MIB, 3));
        assert_eq!(snapshots[1].key, "video/clips/a.mp4");
        assert_eq!(snapshots[1].local_path, local_path(&["Ziel", "clips", "a.mp4"]));
        let completed = s
            .manager
            .inner
            .files
            .calls()
            .into_iter()
            .filter(|c| matches!(c, FileCall::Complete(..)))
            .count();
        assert_eq!(completed, 2);
    }

    #[tokio::test]
    async fn cancelling_a_download_deletes_its_partial_file() {
        let s = setup(1, &[]);
        s.store.hang_uploads();
        let ids = enqueue_download(
            &s,
            &[selected_item("video/a.bin", false), selected_item("video/b.bin", false)],
        )
        .await;
        wait_for(&s.manager, |st| st == [TransferState::Active, TransferState::Waiting]).await;
        s.manager.cancel(ids[0]);
        s.manager.cancel(ids[1]);
        wait_for(&s.manager, all(TransferState::Cancelled)).await;
        let discarded: Vec<_> = s
            .manager
            .inner
            .files
            .calls()
            .into_iter()
            .filter_map(|c| match c {
                FileCall::Discard(path) => Some(path.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect();
        assert_eq!(
            discarded,
            [
                local_path(&["Ziel", "b.bin.s3part"]),
                local_path(&["Ziel", "a.bin.s3part"])
            ]
        );
    }

    #[tokio::test]
    async fn pausing_a_download_keeps_its_partial_file() {
        let s = setup(1, &[]);
        s.store.hang_uploads();
        let ids = enqueue_download(&s, &[selected_item("video/a.bin", false)]).await;
        wait_for(&s.manager, all(TransferState::Active)).await;
        s.manager.pause(ids[0]);
        wait_for(&s.manager, all(TransferState::Paused)).await;
        assert!(
            !s.manager
                .inner
                .files
                .calls()
                .iter()
                .any(|c| matches!(c, FileCall::Discard(_)))
        );
        s.store.release_uploads();
        s.manager.resume(ids[0]);
        wait_for(&s.manager, all(TransferState::Done)).await;
    }

    #[tokio::test]
    async fn reports_unknown_profiles_and_listing_errors_when_enqueueing_downloads() {
        let s = setup(1, &[]);
        s.manager.inner.provider.make_unavailable();
        let result = s
            .manager
            .enqueue_downloads("p1", "b", "", &[selected_item("x", false)], Path::new(r"D:\"))
            .await;
        assert!(matches!(result, Err(AppError::ProfileNotFound(_))));

        let failing = setup_with(FakeStore::failing(StoreError::Timeout), 1, &[]);
        let result = failing
            .manager
            .enqueue_downloads("p1", "b", "", &[selected_item("x/", true)], Path::new(r"D:\"))
            .await;
        assert!(matches!(result, Err(AppError::Store(StoreError::Timeout))));
    }

    #[tokio::test]
    async fn logs_partial_files_that_cannot_be_deleted() {
        let s = setup(1, &[]);
        s.store.hang_uploads();
        let ids = enqueue_download(&s, &[selected_item("video/a.bin", false)]).await;
        wait_for(&s.manager, all(TransferState::Active)).await;
        s.manager.pause(ids[0]);
        wait_for(&s.manager, all(TransferState::Paused)).await;
        s.manager.inner.files.fail();
        s.manager.cancel(ids[0]);
        assert_eq!(states(&s.manager)[0], TransferState::Cancelled);
    }

    fn copy_item(key: &str, size: u64) -> SelectedItem {
        SelectedItem {
            key: key.into(),
            is_folder: key.ends_with('/'),
            size,
            etag: None,
            last_modified_ms: None,
        }
    }

    async fn enqueue_copy(s: &Setup, items: &[SelectedItem], delete_source: bool) -> Vec<TransferId> {
        let source = CopySource {
            profile_id: "p1",
            bucket: "b",
            items,
        };
        let target = CopyTarget {
            profile_id: "p1",
            bucket: "b",
            prefix: "ziel/",
        };
        s.manager.enqueue_copies(source, target, delete_source).await.unwrap()
    }

    #[tokio::test]
    async fn copies_and_moves_objects_on_the_server() {
        let s = setup(2, &[]);
        let ids = enqueue_copy(&s, &[copy_item("a/x.txt", 10)], true).await;
        assert_eq!(ids, [1]);
        wait_for(&s.manager, all(TransferState::Done)).await;
        let snapshot = &s.manager.snapshots()[0];
        assert_eq!(snapshot.direction, Direction::Copy);
        assert_eq!((snapshot.key.as_str(), snapshot.name.as_str()), ("ziel/x.txt", "x.txt"));
        let source = snapshot.copy_source.clone().unwrap();
        assert_eq!((source.bucket.as_str(), source.key.as_str()), ("b", "a/x.txt"));
        assert_eq!((snapshot.local_path.as_str(), snapshot.done_bytes), ("", 10));
        assert_eq!(s.store.deleted_batches(), [vec!["a/x.txt".to_owned()]]);
    }

    #[tokio::test]
    async fn cancelling_a_multipart_copy_aborts_it_on_the_server() {
        let s = setup(1, &[]);
        s.store.hang_after_create();
        let ids = enqueue_copy(&s, &[copy_item("a/gross.iso", 6 * 1024 * MIB)], false).await;
        for _ in 0..200 {
            if s.store.upload_calls().contains(&TransferCall::Create) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        s.manager.cancel(ids[0]);
        wait_for(&s.manager, all(TransferState::Cancelled)).await;
        for _ in 0..200 {
            if s.store.upload_calls().contains(&TransferCall::Abort) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        panic!("Multipart-Kopie wurde nicht verworfen: {:?}", s.store.upload_calls());
    }

    #[tokio::test]
    async fn reports_copy_errors_when_enqueueing() {
        let s = setup(1, &[]);
        let source = CopySource {
            profile_id: "p1",
            bucket: "b",
            items: &[copy_item("a/d/", 0)],
        };
        let target = CopyTarget {
            profile_id: "p1",
            bucket: "b",
            prefix: "a/d/sub/",
        };
        let result = s.manager.enqueue_copies(source, target, false).await;
        assert_eq!(result, Err(AppError::CopyIntoItself("d".into())));
        s.manager.inner.provider.make_unavailable();
        let result = s.manager.enqueue_copies(source, target, false).await;
        assert!(matches!(result, Err(AppError::ProfileNotFound(_))));
    }

    #[tokio::test]
    async fn copies_between_connections_through_this_computer() {
        let s = setup(1, &[]);
        s.store.set_head(crate::domain::details::ObjectHead {
            size: 12 * MIB,
            etag: Some("\"q\"".into()),
            ..Default::default()
        });
        let items = [copy_item("a/film.mp4", 12 * MIB)];
        let source = CopySource {
            profile_id: "aws",
            bucket: "b",
            items: &items,
        };
        let target = CopyTarget {
            profile_id: "hetzner",
            bucket: "b",
            prefix: "ziel/",
        };
        s.manager.enqueue_copies(source, target, true).await.unwrap();
        wait_for(&s.manager, all(TransferState::Done)).await;
        let snapshot = &s.manager.snapshots()[0];
        assert_eq!(
            (snapshot.profile_id.as_str(), snapshot.source_profile_id.as_deref()),
            ("hetzner", Some("aws"))
        );
        let calls = s.store.upload_calls();
        assert!(calls.iter().any(|c| matches!(c, TransferCall::PartBytes { .. })));
        assert!(
            !calls
                .iter()
                .any(|c| matches!(c, TransferCall::PartCopy { .. } | TransferCall::Copy { .. }))
        );
        assert_eq!(s.store.deleted_batches(), [vec!["a/film.mp4".to_owned()]]);
    }

    #[tokio::test]
    async fn applies_new_settings_immediately() {
        let s = setup(1, &[10, 20, 30]);
        s.store.hang_uploads();
        enqueue(&s);
        wait_for(&s.manager, |st| {
            st == [TransferState::Active, TransferState::Waiting, TransferState::Waiting]
        })
        .await;
        let settings = TransferSettings {
            max_transfers: 3,
            upload_limit: 1024,
            ..s.manager.settings()
        };
        s.manager.apply_settings(settings);
        assert_eq!(s.manager.settings().max_transfers, 3);
        assert_eq!(s.manager.inner.upload_limit.rate(), 1024);
        wait_for(&s.manager, all(TransferState::Active)).await;
    }

    #[tokio::test]
    async fn skips_downloads_whose_target_exists_when_configured() {
        let s = setup(1, &[]);
        s.manager.apply_settings(TransferSettings {
            conflict: ConflictPolicy::Skip,
            ..s.manager.settings()
        });
        s.manager.inner.files.set_existing(&local_path(&["Ziel", "a.bin"]), 1);
        enqueue_download(
            &s,
            &[selected_item("video/a.bin", false), selected_item("video/b.bin", false)],
        )
        .await;
        wait_for(&s.manager, |st| st == [TransferState::Skipped, TransferState::Done]).await;
        let skipped = &s.manager.snapshots()[0];
        assert!(skipped.finished_ms.is_some());
        s.manager.remove_finished();
        assert_eq!(s.manager.snapshots(), Vec::new());
    }

    #[test]
    fn converts_preferences_into_transfer_settings() {
        let prefs = TransferPreferences {
            max_transfers: 3,
            parts_parallel: 2,
            part_size_mib: 32,
            multipart_threshold_mib: 128,
            retries: 5,
            upload_limit_mibps: 2,
            download_limit_mibps: 0,
            conflict: ConflictPolicy::Overwrite,
            ..TransferPreferences::default()
        };
        let settings = TransferSettings::from(&prefs);
        assert_eq!(settings.max_transfers, 3);
        assert_eq!(
            (settings.parts.part_size, settings.parts.multipart_threshold),
            (32 * MIB, 128 * MIB)
        );
        assert_eq!(
            (
                settings.parts.parts_parallel,
                settings.parts.retry.retries,
                settings.copy.retry.retries
            ),
            (2, 5, 5)
        );
        assert_eq!((settings.upload_limit, settings.download_limit), (2 * MIB, 0));
        assert_eq!(settings.conflict, ConflictPolicy::Overwrite);
        assert_eq!(settings.parts.checksums, Checksums::Verify);
        let unchecked = TransferPreferences {
            verify_checksums: false,
            ..prefs
        };
        assert_eq!(TransferSettings::from(&unchecked).parts.checksums, Checksums::Off);
        assert_eq!(TransferSettings::default().max_transfers, 8);
    }

    #[test]
    fn smooths_the_measured_speed() {
        let mut speed = Speed::default();
        let start = Instant::now();
        speed.sample(0, start);
        speed.sample(1000, start + Duration::from_secs(1));
        assert_eq!(speed.rounded(), 300);
        speed.sample(2000, start + Duration::from_secs(2));
        assert_eq!(speed.rounded(), 510);
        speed.sample(2000, start + Duration::from_secs(2));
        assert_eq!(speed.rounded(), 510, "ohne verstrichene Zeit keine neue Messung");
    }

    #[test]
    fn debug_output_hides_internals() {
        let s = setup(1, &[]);
        assert_eq!(format!("{:?}", s.manager), "TransferManager { .. }");
    }
}
