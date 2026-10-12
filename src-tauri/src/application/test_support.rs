//! Fakes der Ports für Unit-Tests der Anwendungsfälle.

use crate::application::error::AppError;
use crate::domain::credentials::Credentials;
use crate::domain::deletion::DeleteFailure;
use crate::domain::details::{MetadataEntry, ObjectAcl, ObjectHead, ObjectTag, ObjectVersion};
use crate::domain::error::{CacheError, CredentialError, RepositoryError, StoreError};
use crate::domain::listing_cache::{CacheStats, FolderKey};
use crate::domain::object::{BucketInfo, ListPage, ListRequest, ObjectEntry};
use crate::domain::profile::ConnectionProfile;
use crate::domain::transfer::{ByteCounter, Checksums, CompletedPart, FileRange, ObjectRef, UploadedPart};
use crate::domain::transfer::{LocalFile, TransferUpdate};
use crate::ports::{
    BoxFuture, CacheWrite, Clock, CredentialStore, ListingCache, LocalFiles, ObjectStore, ProfileRepository, Spawner,
    StoreFactory, StoreProvider, TransferEvents,
};
use std::collections::{HashMap, VecDeque};
use std::future::{Future, ready};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use time::OffsetDateTime;

/// Aufgezeichneter Transfer-Aufruf am Store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransferCall {
    /// Lesender Aufruf der Objekt-Details (head, tags, versions, acl).
    Read(&'static str),
    PutTags {
        tags: Vec<ObjectTag>,
    },
    CopyVersion {
        version_id: String,
    },
    DeleteVersion {
        version_id: String,
    },
    ReplaceMetadata {
        metadata: Vec<MetadataEntry>,
        storage_class: Option<String>,
        content_type: Option<String>,
    },
    CreateWithMetadata {
        metadata: Vec<MetadataEntry>,
    },
    PutEmpty {
        key: String,
    },
    Copy {
        from: String,
        to: String,
    },
    /// Teil aus dem Speicher (Kopie zwischen Verbindungen).
    PartBytes {
        number: u32,
        length: u64,
    },
    PartCopy {
        number: u32,
        offset: u64,
        length: u64,
    },
    Delete {
        keys: Vec<String>,
    },
    Range {
        offset: u64,
        length: u64,
        if_match: Option<String>,
    },
    Put {
        length: u64,
    },
    Create,
    Part {
        number: u32,
        offset: u64,
        length: u64,
    },
    Complete {
        parts: Vec<u32>,
    },
    Abort,
    ListParts,
}

/// Liefert vorbereitete Seiten nacheinander und merkt sich alle Anfragen.
#[derive(Debug, Default)]
pub struct FakeStore {
    pages: Mutex<VecDeque<ListPage>>,
    buckets: Vec<BucketInfo>,
    error: Option<StoreError>,
    requests: Mutex<Vec<ListRequest>>,
    upload_calls: Mutex<Vec<TransferCall>>,
    /// Ergebnis der nächsten Upload-Aufrufe: `None` = Erfolg, `Some` = dieser Fehler.
    upload_outcomes: Mutex<VecDeque<Option<StoreError>>>,
    listed_parts: Mutex<Vec<UploadedPart>>,
    hang: AtomicBool,
    hang_after_create: AtomicBool,
    /// Keys, die `delete_objects` als nicht löschbar meldet.
    undeletable: Mutex<Vec<String>>,
    /// Ergebnis von `is_versioned`; `None` = Fehler wie bei fehlender Berechtigung.
    versioned: Mutex<Option<bool>>,
    head: Mutex<ObjectHead>,
    /// Ziele von PUTs aus dem Speicher.
    put_targets: Mutex<Vec<ObjectRef>>,
    /// Verlangte Prüfung je Upload-Aufruf (PUT, Create, Teil).
    checksum_modes: Mutex<Vec<Checksums>>,
    tags: Mutex<Vec<ObjectTag>>,
    versions: Mutex<Vec<ObjectVersion>>,
    acl: Mutex<ObjectAcl>,
}

impl FakeStore {
    pub fn with_pages(pages: Vec<ListPage>) -> Self {
        Self {
            pages: Mutex::new(pages.into()),
            ..Self::default()
        }
    }

    pub fn with_buckets(names: &[&str]) -> Self {
        let buckets = names
            .iter()
            .map(|n| BucketInfo {
                name: (*n).to_owned(),
                created_ms: None,
            })
            .collect();
        Self {
            buckets,
            ..Self::default()
        }
    }

    pub fn failing(error: StoreError) -> Self {
        Self {
            error: Some(error),
            ..Self::default()
        }
    }

    pub fn object(key: &str) -> ObjectEntry {
        ObjectEntry {
            key: key.to_owned(),
            size: 1,
            last_modified_ms: None,
            etag: None,
            storage_class: None,
        }
    }

    pub fn requests(&self) -> Vec<ListRequest> {
        self.requests.lock().unwrap().clone()
    }

    fn fail_or<T>(&self, value: impl FnOnce() -> T) -> Result<T, StoreError> {
        self.error.clone().map_or_else(|| Ok(value()), Err)
    }

    pub fn upload_calls(&self) -> Vec<TransferCall> {
        self.upload_calls.lock().unwrap().clone()
    }

    /// Die nächsten Upload-Aufrufe scheitern mit diesen Fehlern.
    pub fn fail_next(&self, errors: Vec<StoreError>) {
        self.upload_outcomes
            .lock()
            .unwrap()
            .extend(errors.into_iter().map(Some));
    }

    /// Die ersten `count` Upload-Aufrufe gelingen, erst danach greifen eingeplante Fehler.
    pub fn succeed_first(&self, count: usize) {
        let mut outcomes = self.upload_outcomes.lock().unwrap();
        for _ in 0..count {
            outcomes.push_front(None);
        }
    }

    /// `ListParts` meldet diese Teile (Nummer, Größe) als bereits hochgeladen.
    pub fn set_listed_parts(&self, parts: Vec<(u32, u64)>) {
        *self.listed_parts.lock().unwrap() = parts
            .into_iter()
            .map(|(part_number, size)| UploadedPart {
                part_number,
                etag: format!("\"etag-{part_number}\""),
                size,
                checksum_crc32c: None,
            })
            .collect();
    }

    /// Upload-Aufrufe kehren nie zurück (zum Testen von Abbruch und Pause).
    pub fn hang_uploads(&self) {
        self.hang.store(true, Ordering::Relaxed);
    }

    /// Neue Upload-Aufrufe kehren wieder normal zurück.
    pub fn release_uploads(&self) {
        self.hang.store(false, Ordering::Relaxed);
        self.hang_after_create.store(false, Ordering::Relaxed);
    }

    pub fn put_targets(&self) -> Vec<ObjectRef> {
        self.put_targets.lock().unwrap().clone()
    }

    pub fn checksum_modes(&self) -> Vec<Checksums> {
        self.checksum_modes.lock().unwrap().clone()
    }

    fn record_checksums(&self, checksums: Checksums) {
        self.checksum_modes.lock().unwrap().push(checksums);
    }

    /// Antwort von `head_object`.
    pub fn set_head(&self, head: ObjectHead) {
        *self.head.lock().unwrap() = head;
    }

    pub fn set_tags(&self, tags: Vec<ObjectTag>) {
        *self.tags.lock().unwrap() = tags;
    }

    pub fn set_versions(&self, versions: Vec<ObjectVersion>) {
        *self.versions.lock().unwrap() = versions;
    }

    pub fn set_acl(&self, acl: ObjectAcl) {
        *self.acl.lock().unwrap() = acl;
    }

    /// `delete_objects` meldet diese Keys als nicht löschbar.
    pub fn refuse_deleting(&self, keys: &[&str]) {
        *self.undeletable.lock().unwrap() = keys.iter().map(|k| (*k).to_owned()).collect();
    }

    pub fn set_versioned(&self, versioned: Option<bool>) {
        *self.versioned.lock().unwrap() = versioned;
    }

    /// Alle Pakete, die `delete_objects` erhalten hat.
    pub fn deleted_batches(&self) -> Vec<Vec<String>> {
        self.upload_calls()
            .into_iter()
            .filter_map(|c| match c {
                TransferCall::Delete { keys } => Some(keys),
                _ => None,
            })
            .collect()
    }

    /// `CreateMultipartUpload` gelingt, alle weiteren Aufrufe hängen.
    pub fn hang_after_create(&self) {
        self.hang_after_create.store(true, Ordering::Relaxed);
    }

    /// Zeichnet den Aufruf auf und liefert Erfolg oder den eingeplanten Fehler.
    async fn upload_op<T>(&self, call: TransferCall, value: T) -> Result<T, StoreError> {
        let hang = self.hang.load(Ordering::Relaxed)
            || (self.hang_after_create.load(Ordering::Relaxed) && call != TransferCall::Create);
        self.upload_calls.lock().unwrap().push(call);
        if hang {
            std::future::pending::<()>().await;
        }
        match self.upload_outcomes.lock().unwrap().pop_front().flatten() {
            Some(error) => Err(error),
            None => Ok(value),
        }
    }
}

impl ObjectStore for FakeStore {
    fn list_buckets(&self) -> impl Future<Output = Result<Vec<BucketInfo>, StoreError>> + Send {
        ready(self.fail_or(|| self.buckets.clone()))
    }

    fn list_objects(&self, request: &ListRequest) -> impl Future<Output = Result<ListPage, StoreError>> + Send {
        self.requests.lock().unwrap().push(request.clone());
        ready(self.fail_or(|| self.pages.lock().unwrap().pop_front().unwrap_or_default()))
    }

    async fn put_object(
        &self,
        _: &ObjectRef,
        source: &FileRange,
        progress: &ByteCounter,
        checksums: Checksums,
    ) -> Result<String, StoreError> {
        self.record_checksums(checksums);
        let etag = self
            .upload_op(TransferCall::Put { length: source.length }, "\"etag-put\"".to_owned())
            .await?;
        progress.add(source.length);
        Ok(etag)
    }

    async fn create_multipart_upload(&self, _: &ObjectRef, checksums: Checksums) -> Result<String, StoreError> {
        self.record_checksums(checksums);
        self.upload_op(TransferCall::Create, "upload-1".to_owned()).await
    }

    async fn upload_part(
        &self,
        _: &ObjectRef,
        _: &str,
        part_number: u32,
        source: &FileRange,
        progress: &ByteCounter,
        checksums: Checksums,
    ) -> Result<CompletedPart, StoreError> {
        self.record_checksums(checksums);
        let call = TransferCall::Part {
            number: part_number,
            offset: source.offset,
            length: source.length,
        };
        let etag = self.upload_op(call, format!("\"etag-{part_number}\"")).await?;
        progress.add(source.length);
        Ok(CompletedPart::new(part_number, etag))
    }

    async fn complete_multipart_upload(
        &self,
        _: &ObjectRef,
        _: &str,
        parts: &[CompletedPart],
    ) -> Result<String, StoreError> {
        let numbers = parts.iter().map(|p| p.part_number).collect();
        self.upload_op(
            TransferCall::Complete { parts: numbers },
            "\"etag-complete\"".to_owned(),
        )
        .await
    }

    async fn abort_multipart_upload(&self, _: &ObjectRef, _: &str) -> Result<(), StoreError> {
        self.upload_op(TransferCall::Abort, ()).await
    }

    async fn list_parts(&self, _: &ObjectRef, _: &str) -> Result<Vec<UploadedPart>, StoreError> {
        let parts = self.listed_parts.lock().unwrap().clone();
        self.upload_op(TransferCall::ListParts, parts).await
    }

    async fn head_object(&self, _: &str, _: &str) -> Result<ObjectHead, StoreError> {
        let head = self.head.lock().unwrap().clone();
        self.upload_op(TransferCall::Read("head"), head).await
    }

    async fn get_object_tagging(&self, _: &str, _: &str) -> Result<Vec<ObjectTag>, StoreError> {
        let tags = self.tags.lock().unwrap().clone();
        self.upload_op(TransferCall::Read("tags"), tags).await
    }

    async fn put_object_tagging(&self, _: &str, _: &str, tags: &[ObjectTag]) -> Result<(), StoreError> {
        self.upload_op(TransferCall::PutTags { tags: tags.to_vec() }, ()).await
    }

    async fn list_object_versions(&self, _: &str, _: &str) -> Result<Vec<ObjectVersion>, StoreError> {
        let versions = self.versions.lock().unwrap().clone();
        self.upload_op(TransferCall::Read("versions"), versions).await
    }

    async fn copy_version(&self, _: &ObjectRef, version_id: &str, _: &ObjectRef) -> Result<(), StoreError> {
        let call = TransferCall::CopyVersion {
            version_id: version_id.to_owned(),
        };
        self.upload_op(call, ()).await
    }

    async fn delete_version(&self, _: &str, _: &str, version_id: &str) -> Result<(), StoreError> {
        let call = TransferCall::DeleteVersion {
            version_id: version_id.to_owned(),
        };
        self.upload_op(call, ()).await
    }

    async fn replace_metadata(
        &self,
        object: &ObjectRef,
        metadata: &[MetadataEntry],
        storage_class: Option<&str>,
    ) -> Result<(), StoreError> {
        let call = TransferCall::ReplaceMetadata {
            metadata: metadata.to_vec(),
            storage_class: storage_class.map(str::to_owned),
            content_type: object.content_type.clone(),
        };
        self.upload_op(call, ()).await
    }

    async fn create_multipart_upload_with_metadata(
        &self,
        _: &ObjectRef,
        metadata: &[MetadataEntry],
        _: Option<&str>,
    ) -> Result<String, StoreError> {
        let call = TransferCall::CreateWithMetadata {
            metadata: metadata.to_vec(),
        };
        self.upload_op(call, "upload-meta".to_owned()).await
    }

    async fn get_object_acl(&self, _: &str, _: &str) -> Result<ObjectAcl, StoreError> {
        let acl = self.acl.lock().unwrap().clone();
        self.upload_op(TransferCall::Read("acl"), acl).await
    }

    fn presign_get(&self, bucket: &str, key: &str, expires_secs: u32) -> Result<String, StoreError> {
        Ok(format!("https://fake/{bucket}/{key}?X-Amz-Expires={expires_secs}"))
    }

    async fn put_empty(&self, _: &str, key: &str) -> Result<(), StoreError> {
        self.upload_op(TransferCall::PutEmpty { key: key.to_owned() }, ()).await
    }

    async fn copy_object(&self, source: &ObjectRef, target: &ObjectRef) -> Result<(), StoreError> {
        let call = TransferCall::Copy {
            from: source.key.clone(),
            to: target.key.clone(),
        };
        self.upload_op(call, ()).await
    }

    async fn upload_part_copy(
        &self,
        _: &ObjectRef,
        _: &str,
        part_number: u32,
        _: &ObjectRef,
        (offset, length): (u64, u64),
    ) -> Result<String, StoreError> {
        let call = TransferCall::PartCopy {
            number: part_number,
            offset,
            length,
        };
        self.upload_op(call, format!("copy-{part_number}")).await
    }

    async fn delete_objects(&self, _: &str, keys: &[String]) -> Result<Vec<DeleteFailure>, StoreError> {
        let call = TransferCall::Delete { keys: keys.to_vec() };
        self.upload_op(call, ()).await?;
        let refused = self.undeletable.lock().unwrap().clone();
        Ok(keys
            .iter()
            .filter(|k| refused.contains(k))
            .map(|key| DeleteFailure {
                key: key.clone(),
                code: "AccessDenied".into(),
                message: "Zugriff verweigert".into(),
            })
            .collect())
    }

    fn is_versioned(&self, _: &str) -> impl Future<Output = Result<bool, StoreError>> + Send {
        let versioned = *self.versioned.lock().unwrap();
        ready(versioned.ok_or_else(|| StoreError::Network("kein Zugriff auf die Versionierung".into())))
    }

    async fn get_range(&self, _: &ObjectRef, if_match: Option<&str>, range: (u64, u64)) -> Result<Vec<u8>, StoreError> {
        let call = TransferCall::Range {
            offset: range.0,
            length: range.1,
            if_match: if_match.map(str::to_owned),
        };
        self.upload_op(call, ()).await?;
        Ok(vec![0; usize::try_from(range.1).unwrap()])
    }

    async fn put_object_bytes(
        &self,
        target: &ObjectRef,
        body: Vec<u8>,
        progress: &ByteCounter,
        checksums: Checksums,
    ) -> Result<String, StoreError> {
        self.record_checksums(checksums);
        self.put_targets.lock().unwrap().push(target.clone());
        let length = body.len() as u64;
        let etag = self
            .upload_op(TransferCall::Put { length }, "\"etag-put\"".to_owned())
            .await?;
        progress.add(length);
        Ok(etag)
    }

    async fn upload_part_bytes(
        &self,
        _: &ObjectRef,
        _: &str,
        part_number: u32,
        body: Vec<u8>,
        progress: &ByteCounter,
        checksums: Checksums,
    ) -> Result<CompletedPart, StoreError> {
        self.record_checksums(checksums);
        let length = body.len() as u64;
        let call = TransferCall::PartBytes {
            number: part_number,
            length,
        };
        let etag = self.upload_op(call, format!("\"etag-{part_number}\"")).await?;
        progress.add(length);
        Ok(CompletedPart::new(part_number, etag))
    }

    async fn download_range(
        &self,
        _: &ObjectRef,
        if_match: Option<&str>,
        part: &FileRange,
        progress: &ByteCounter,
    ) -> Result<(), StoreError> {
        let call = TransferCall::Range {
            offset: part.offset,
            length: part.length,
            if_match: if_match.map(str::to_owned),
        };
        self.upload_op(call, ()).await?;
        progress.add(part.length);
        Ok(())
    }
}

/// Monotone Uhr, die bei jedem Ablesen um `step` weiterläuft.
#[derive(Debug)]
pub struct FakeClock {
    now: Mutex<Instant>,
    step: Duration,
    utc: OffsetDateTime,
}

impl FakeClock {
    pub fn stepping(step: Duration) -> Self {
        Self {
            now: Mutex::new(Instant::now()),
            step,
            utc: OffsetDateTime::UNIX_EPOCH,
        }
    }
}

impl Clock for FakeClock {
    fn utc_now(&self) -> OffsetDateTime {
        self.utc
    }

    fn monotonic(&self) -> Instant {
        let mut now = self.now.lock().unwrap();
        let current = *now;
        *now += self.step;
        current
    }
}

/// Profilablage im Speicher.
#[derive(Debug, Default)]
pub struct FakeProfiles(Mutex<Vec<ConnectionProfile>>);

impl ProfileRepository for FakeProfiles {
    fn list(&self) -> Result<Vec<ConnectionProfile>, RepositoryError> {
        Ok(self.0.lock().unwrap().clone())
    }

    fn save(&self, profile: &ConnectionProfile) -> Result<(), RepositoryError> {
        let mut profiles = self.0.lock().unwrap();
        profiles.retain(|p| p.id != profile.id);
        profiles.push(profile.clone());
        Ok(())
    }

    fn delete(&self, id: &str) -> Result<(), RepositoryError> {
        self.0.lock().unwrap().retain(|p| p.id != id);
        Ok(())
    }
}

/// Ablage für Zugangsdaten im Speicher.
#[derive(Debug, Default)]
pub struct FakeCredentials(Mutex<HashMap<String, Credentials>>);

impl CredentialStore for FakeCredentials {
    fn load(&self, profile_id: &str) -> Result<Option<Credentials>, CredentialError> {
        Ok(self.0.lock().unwrap().get(profile_id).cloned())
    }

    fn save(&self, profile_id: &str, credentials: &Credentials) -> Result<(), CredentialError> {
        self.0
            .lock()
            .unwrap()
            .insert(profile_id.to_owned(), credentials.clone());
        Ok(())
    }

    fn delete(&self, profile_id: &str) -> Result<(), CredentialError> {
        self.0.lock().unwrap().remove(profile_id);
        Ok(())
    }
}

/// Erzeugt bei jedem Aufruf einen neuen `FakeStore` und zählt mit.
#[derive(Debug)]
pub struct FakeFactory {
    make: fn() -> FakeStore,
    created: AtomicUsize,
}

impl FakeFactory {
    pub fn new(make: fn() -> FakeStore) -> Self {
        Self {
            make,
            created: AtomicUsize::new(0),
        }
    }

    pub fn created(&self) -> usize {
        self.created.load(Ordering::Relaxed)
    }
}

impl StoreFactory for FakeFactory {
    type Store = FakeStore;

    fn create(&self, _: &ConnectionProfile, _: Credentials) -> Result<FakeStore, StoreError> {
        self.created.fetch_add(1, Ordering::Relaxed);
        Ok((self.make)())
    }
}

/// Liefert immer denselben `FakeStore`, auf Wunsch einen Fehler wie bei gelöschtem Profil.
#[derive(Debug)]
pub struct FakeProvider {
    store: Arc<FakeStore>,
    unavailable: AtomicBool,
}

impl FakeProvider {
    pub fn new(store: Arc<FakeStore>) -> Self {
        Self {
            store,
            unavailable: AtomicBool::new(false),
        }
    }

    pub fn make_unavailable(&self) {
        self.unavailable.store(true, Ordering::Relaxed);
    }
}

impl StoreProvider for FakeProvider {
    type Store = FakeStore;

    fn store_for(&self, profile_id: &str) -> Result<Arc<FakeStore>, AppError> {
        if self.unavailable.load(Ordering::Relaxed) {
            return Err(AppError::ProfileNotFound(profile_id.to_owned()));
        }
        Ok(Arc::clone(&self.store))
    }
}

const FAKE_FILE_ERROR: &str = r"X:\fehlt: nicht gefunden";

/// Aufgezeichnete Operation an einer Teildatei.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileCall {
    Prepare(PathBuf, u64),
    SetModified(PathBuf, i64),
    /// Teildatei, Ziel, überschreiben
    Complete(PathBuf, PathBuf, bool),
    Discard(PathBuf),
}

/// Lokale Dateien `upload/datei-<n>.bin` mit vorgegebenen Größen; Teildateien nur im Protokoll.
#[derive(Debug, Default)]
pub struct FakeFiles {
    sizes: Vec<u64>,
    failing: AtomicBool,
    partial_exists: AtomicBool,
    calls: Mutex<Vec<FileCall>>,
    /// Lokal vorhandene Dateien mit Änderungszeit.
    existing: Mutex<HashMap<PathBuf, i64>>,
    /// Ergebnis von `md5_hex`.
    md5: Mutex<String>,
    /// Änderungszeit der Dateien aus `expand`.
    file_time: Mutex<Option<i64>>,
}

impl FakeFiles {
    pub fn with_sizes(sizes: &[u64]) -> Self {
        Self {
            sizes: sizes.to_vec(),
            ..Self::default()
        }
    }

    pub fn set_file_time(&self, modified_ms: Option<i64>) {
        *self.file_time.lock().unwrap() = modified_ms;
    }

    /// MD5, die `md5_hex` für jede Datei meldet.
    pub fn set_md5(&self, md5: &str) {
        md5.clone_into(&mut self.md5.lock().unwrap());
    }

    /// Alle Operationen scheitern mit `LocalFile`.
    pub fn fail(&self) {
        self.failing.store(true, Ordering::Relaxed);
    }

    /// Die Datei gibt es lokal schon, mit dieser Änderungszeit.
    pub fn set_existing(&self, path: &str, modified_ms: i64) {
        self.existing.lock().unwrap().insert(PathBuf::from(path), modified_ms);
    }

    /// `prepare_download` meldet eine weiterverwendbare Teildatei.
    pub fn keep_partial_files(&self) {
        self.partial_exists.store(true, Ordering::Relaxed);
    }

    pub fn calls(&self) -> Vec<FileCall> {
        self.calls.lock().unwrap().clone()
    }

    fn check(&self) -> Result<(), StoreError> {
        if self.failing.load(Ordering::Relaxed) {
            return Err(StoreError::LocalFile(FAKE_FILE_ERROR.into()));
        }
        Ok(())
    }

    fn record(&self, call: FileCall) -> Result<(), StoreError> {
        if self.failing.load(Ordering::Relaxed) {
            return Err(StoreError::LocalFile(FAKE_FILE_ERROR.into()));
        }
        self.calls.lock().unwrap().push(call);
        Ok(())
    }
}

impl LocalFiles for FakeFiles {
    fn prepare_download(&self, partial: &Path, size: u64) -> Result<bool, StoreError> {
        self.record(FileCall::Prepare(partial.to_path_buf(), size))?;
        Ok(self.partial_exists.load(Ordering::Relaxed))
    }

    fn complete_download(&self, partial: &Path, target: &Path, overwrite: bool) -> Result<PathBuf, StoreError> {
        self.record(FileCall::Complete(
            partial.to_path_buf(),
            target.to_path_buf(),
            overwrite,
        ))?;
        Ok(target.to_path_buf())
    }

    fn modified_ms(&self, path: &Path) -> Result<Option<i64>, StoreError> {
        self.check()?;
        Ok(self.existing.lock().unwrap().get(path).copied())
    }

    fn set_modified_ms(&self, path: &Path, modified_ms: i64) -> Result<(), StoreError> {
        self.record(FileCall::SetModified(path.to_path_buf(), modified_ms))
    }

    fn md5_hex(&self, _: &Path) -> impl Future<Output = Result<String, StoreError>> + Send {
        ready(self.check().map(|()| self.md5.lock().unwrap().clone()))
    }

    fn discard_download(&self, partial: &Path) -> Result<(), StoreError> {
        self.record(FileCall::Discard(partial.to_path_buf()))
    }

    fn expand(&self, _: &[PathBuf]) -> Result<Vec<LocalFile>, StoreError> {
        if self.failing.load(Ordering::Relaxed) {
            return Err(StoreError::LocalFile(FAKE_FILE_ERROR.into()));
        }
        Ok(self
            .sizes
            .iter()
            .enumerate()
            .map(|(i, size)| LocalFile {
                path: PathBuf::from(format!(r"C:\upload\datei-{i}.bin")),
                relative: format!("upload/datei-{i}.bin"),
                size: *size,
                content_type: "application/octet-stream".into(),
                modified_ms: *self.file_time.lock().unwrap(),
            })
            .collect())
    }
}

/// Merkt sich alle gemeldeten Transfer-Änderungen.
#[derive(Debug, Default)]
pub struct RecordingEvents(Mutex<Vec<TransferUpdate>>);

impl RecordingEvents {
    pub fn count(&self) -> usize {
        self.0.lock().unwrap().len()
    }

    pub fn last(&self) -> Option<TransferUpdate> {
        self.0.lock().unwrap().last().cloned()
    }
}

impl TransferEvents for RecordingEvents {
    fn publish(&self, update: TransferUpdate) {
        self.0.lock().unwrap().push(update);
    }
}

/// Startet Aufgaben auf der Tokio-Laufzeit des Tests.
#[derive(Debug, Clone, Copy)]
pub struct TokioSpawner;

impl Spawner for TokioSpawner {
    fn spawn(&self, task: BoxFuture) {
        tokio::spawn(task);
    }
}

/// Listing-Cache im Speicher; kann ab einem Zeitpunkt oder nur beim Schreiben von Seiten scheitern.
#[derive(Debug, Default)]
pub struct FakeListingCache {
    listings: Mutex<HashMap<FolderKey, (i64, Vec<ListPage>)>>,
    writes: Mutex<HashMap<CacheWrite, (FolderKey, Vec<ListPage>)>>,
    next_write: AtomicUsize,
    failing: AtomicBool,
    failing_appends: AtomicBool,
}

impl FakeListingCache {
    pub fn put(&self, folder: &FolderKey, pages: Vec<ListPage>, fetched_ms: i64) {
        self.listings
            .lock()
            .unwrap()
            .insert(folder.clone(), (fetched_ms, pages));
    }

    /// Zeitpunkt und Anzahl der Einträge des gespeicherten Listings.
    pub fn stored(&self, folder: &FolderKey) -> Option<(i64, usize)> {
        let listings = self.listings.lock().unwrap();
        let (fetched, pages) = listings.get(folder)?;
        Some((*fetched, pages.iter().map(ListPage::entry_count).sum()))
    }

    pub fn open_writes(&self) -> usize {
        self.writes.lock().unwrap().len()
    }

    pub fn fail_from_now(&self) {
        self.failing.store(true, Ordering::Relaxed);
    }

    pub fn fail_appends(&self) {
        self.failing_appends.store(true, Ordering::Relaxed);
    }

    fn check(&self) -> Result<(), CacheError> {
        if self.failing.load(Ordering::Relaxed) {
            return Err(CacheError::Storage("Datei gesperrt".into()));
        }
        Ok(())
    }
}

impl ListingCache for FakeListingCache {
    fn load(&self, folder: &FolderKey, on_page: &mut dyn FnMut(i64, ListPage)) -> Result<bool, CacheError> {
        self.check()?;
        let Some((fetched, pages)) = self.listings.lock().unwrap().get(folder).cloned() else {
            return Ok(false);
        };
        for page in pages {
            on_page(fetched, page);
        }
        Ok(true)
    }

    fn begin(&self, folder: &FolderKey) -> Result<CacheWrite, CacheError> {
        self.check()?;
        let id = i64::try_from(self.next_write.fetch_add(1, Ordering::Relaxed)).unwrap();
        self.writes.lock().unwrap().insert(id, (folder.clone(), Vec::new()));
        Ok(id)
    }

    fn append(&self, write: CacheWrite, page: &ListPage) -> Result<(), CacheError> {
        self.check()?;
        if self.failing_appends.load(Ordering::Relaxed) {
            return Err(CacheError::Storage("Platte voll".into()));
        }
        self.writes
            .lock()
            .unwrap()
            .get_mut(&write)
            .unwrap()
            .1
            .push(page.clone());
        Ok(())
    }

    fn commit(&self, write: CacheWrite, fetched_ms: i64) -> Result<(), CacheError> {
        self.check()?;
        let (folder, pages) = self.writes.lock().unwrap().remove(&write).unwrap();
        self.put(&folder, pages, fetched_ms);
        Ok(())
    }

    fn discard(&self, write: CacheWrite) -> Result<(), CacheError> {
        self.writes.lock().unwrap().remove(&write);
        self.check()
    }

    fn forget_profile(&self, profile_id: &str) -> Result<(), CacheError> {
        self.check()?;
        self.listings
            .lock()
            .unwrap()
            .retain(|folder, _| folder.profile_id != profile_id);
        Ok(())
    }

    fn clear(&self) -> Result<(), CacheError> {
        self.check()?;
        self.listings.lock().unwrap().clear();
        Ok(())
    }

    fn stats(&self) -> Result<CacheStats, CacheError> {
        self.check()?;
        let listings = self.listings.lock().unwrap();
        Ok(CacheStats {
            folders: listings.len() as u64,
            entries: listings
                .values()
                .flat_map(|(_, p)| p)
                .map(|p| p.entry_count() as u64)
                .sum(),
            bytes: 0,
        })
    }
}
