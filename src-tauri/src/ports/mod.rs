//! Ports: Schnittstellen, über die Anwendungsfälle mit der Außenwelt sprechen.

use crate::application::error::AppError;
use crate::domain::credentials::Credentials;
use crate::domain::deletion::DeleteFailure;
use crate::domain::details::{MetadataEntry, ObjectAcl, ObjectHead, ObjectTag, ObjectVersion};
use crate::domain::error::{CacheError, CredentialError, RepositoryError, StoreError};
use crate::domain::listing_cache::{CacheStats, FolderKey};
use crate::domain::local_dir::LocalEntry;
use crate::domain::object::{BucketInfo, ListPage, ListRequest};
use crate::domain::profile::ConnectionProfile;
use crate::domain::settings::AppSettings;
use crate::domain::share::{ShareError, SharedLink};
use crate::domain::timestamp::unix_ms;
use crate::domain::transfer::{
    ByteCounter, Checksums, CompletedPart, FileRange, LocalFile, ObjectRef, TransferUpdate, UploadedPart,
};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Instant;
use time::OffsetDateTime;

/// Zugriff auf einen S3-kompatiblen Object Store.
pub trait ObjectStore: Send + Sync {
    fn list_buckets(&self) -> impl Future<Output = Result<Vec<BucketInfo>, StoreError>> + Send;
    fn list_objects(&self, request: &ListRequest) -> impl Future<Output = Result<ListPage, StoreError>> + Send;

    /// Einzelner PUT; der Körper wird aus der Datei gestreamt. Liefert das `ETag`.
    fn put_object(
        &self,
        target: &ObjectRef,
        source: &FileRange,
        progress: &ByteCounter,
        checksums: Checksums,
    ) -> impl Future<Output = Result<String, StoreError>> + Send;

    /// Startet einen Multipart-Upload und liefert die `UploadId`. Mit `Verify` meldet der Adapter
    /// CRC32C an, wenn der Anbieter es kann; die Teile müssen dann mit `Verify` folgen.
    fn create_multipart_upload(
        &self,
        target: &ObjectRef,
        checksums: Checksums,
    ) -> impl Future<Output = Result<String, StoreError>> + Send;

    /// Lädt einen Teil hoch und liefert ihn für `CompleteMultipartUpload`.
    fn upload_part(
        &self,
        target: &ObjectRef,
        upload_id: &str,
        part_number: u32,
        source: &FileRange,
        progress: &ByteCounter,
        checksums: Checksums,
    ) -> impl Future<Output = Result<CompletedPart, StoreError>> + Send;

    /// Fügt die Teile zum Objekt zusammen und liefert dessen `ETag`.
    fn complete_multipart_upload(
        &self,
        target: &ObjectRef,
        upload_id: &str,
        parts: &[CompletedPart],
    ) -> impl Future<Output = Result<String, StoreError>> + Send;

    fn abort_multipart_upload(
        &self,
        target: &ObjectRef,
        upload_id: &str,
    ) -> impl Future<Output = Result<(), StoreError>> + Send;

    /// Bereits hochgeladene Teile eines laufenden Multipart-Uploads (zum Fortsetzen).
    fn list_parts(
        &self,
        target: &ObjectRef,
        upload_id: &str,
    ) -> impl Future<Output = Result<Vec<UploadedPart>, StoreError>> + Send;

    /// Kopfdaten und Metadaten eines Objekts (`HeadObject`).
    fn head_object(&self, bucket: &str, key: &str) -> impl Future<Output = Result<ObjectHead, StoreError>> + Send;

    fn get_object_tagging(
        &self,
        bucket: &str,
        key: &str,
    ) -> impl Future<Output = Result<Vec<ObjectTag>, StoreError>> + Send;

    /// Ersetzt alle Tags des Objekts.
    fn put_object_tagging(
        &self,
        bucket: &str,
        key: &str,
        tags: &[ObjectTag],
    ) -> impl Future<Output = Result<(), StoreError>> + Send;

    /// Alle Versionen und Delete Marker genau dieses Keys, neueste zuerst.
    fn list_object_versions(
        &self,
        bucket: &str,
        key: &str,
    ) -> impl Future<Output = Result<Vec<ObjectVersion>, StoreError>> + Send;

    /// Kopiert eine bestimmte Version der Quelle (bis 5 GiB), z. B. um sie wiederherzustellen.
    fn copy_version(
        &self,
        source: &ObjectRef,
        version_id: &str,
        target: &ObjectRef,
    ) -> impl Future<Output = Result<(), StoreError>> + Send;

    /// Löscht eine Version oder einen Delete Marker endgültig.
    fn delete_version(
        &self,
        bucket: &str,
        key: &str,
        version_id: &str,
    ) -> impl Future<Output = Result<(), StoreError>> + Send;

    /// Ersetzt die Metadaten durch eine Kopie des Objekts auf sich selbst (bis 5 GiB).
    /// Content-Type steht in `object`, die Storage Class bleibt erhalten.
    fn replace_metadata(
        &self,
        object: &ObjectRef,
        metadata: &[MetadataEntry],
        storage_class: Option<&str>,
    ) -> impl Future<Output = Result<(), StoreError>> + Send;

    /// Startet einen Multipart-Upload mit Metadaten und Storage Class; liefert die `UploadId`.
    fn create_multipart_upload_with_metadata(
        &self,
        target: &ObjectRef,
        metadata: &[MetadataEntry],
        storage_class: Option<&str>,
    ) -> impl Future<Output = Result<String, StoreError>> + Send;

    fn get_object_acl(&self, bucket: &str, key: &str) -> impl Future<Output = Result<ObjectAcl, StoreError>> + Send;

    /// Vorsignierter Link zum Herunterladen, gültig für `expires_secs` Sekunden.
    ///
    /// # Errors
    /// `InvalidConfig`, wenn sich keine URL bilden lässt.
    fn presign_get(&self, bucket: &str, key: &str, expires_secs: u32) -> Result<String, StoreError>;

    /// Legt ein leeres Objekt an, z. B. den Platzhalter `name/` eines neuen Ordners.
    fn put_empty(&self, bucket: &str, key: &str) -> impl Future<Output = Result<(), StoreError>> + Send;

    /// Kopiert ein Objekt bis 5 GiB auf dem Server; Metadaten werden mitkopiert.
    fn copy_object(
        &self,
        source: &ObjectRef,
        target: &ObjectRef,
    ) -> impl Future<Output = Result<(), StoreError>> + Send;

    /// Kopiert den Byte-Bereich `(offset, length)` der Quelle als Teil eines Multipart-Uploads
    /// und liefert sein `ETag` (für Objekte über 5 GiB).
    fn upload_part_copy(
        &self,
        target: &ObjectRef,
        upload_id: &str,
        part_number: u32,
        source: &ObjectRef,
        range: (u64, u64),
    ) -> impl Future<Output = Result<String, StoreError>> + Send;

    /// Löscht bis zu 1.000 Keys mit einer Anfrage (`DeleteObjects`) und liefert die Keys,
    /// die der Dienst nicht löschen konnte.
    fn delete_objects(
        &self,
        bucket: &str,
        keys: &[String],
    ) -> impl Future<Output = Result<Vec<DeleteFailure>, StoreError>> + Send;

    /// Ob die Versionierung im Bucket aktiv ist oder war; dann bleiben ältere Versionen erhalten.
    fn is_versioned(&self, bucket: &str) -> impl Future<Output = Result<bool, StoreError>> + Send;

    /// Liest den Byte-Bereich `(offset, length)` eines Objekts in den Speicher, für Kopien
    /// zwischen Verbindungen. Mit `if_match` scheitert der Request, wenn sich das Objekt geändert hat.
    fn get_range(
        &self,
        object: &ObjectRef,
        if_match: Option<&str>,
        range: (u64, u64),
    ) -> impl Future<Output = Result<Vec<u8>, StoreError>> + Send;

    /// Einzelner PUT aus dem Speicher; liefert das `ETag`.
    fn put_object_bytes(
        &self,
        target: &ObjectRef,
        body: Vec<u8>,
        progress: &ByteCounter,
        checksums: Checksums,
    ) -> impl Future<Output = Result<String, StoreError>> + Send;

    /// Teil eines Multipart-Uploads aus dem Speicher.
    fn upload_part_bytes(
        &self,
        target: &ObjectRef,
        upload_id: &str,
        part_number: u32,
        body: Vec<u8>,
        progress: &ByteCounter,
        checksums: Checksums,
    ) -> impl Future<Output = Result<CompletedPart, StoreError>> + Send;

    /// Lädt den Byte-Bereich `part` des Objekts und schreibt ihn an dieselbe Stelle der lokalen
    /// Datei `part.path`. Mit `if_match` scheitert der Request, wenn sich das Objekt geändert hat.
    fn download_range(
        &self,
        object: &ObjectRef,
        if_match: Option<&str>,
        part: &FileRange,
        progress: &ByteCounter,
    ) -> impl Future<Output = Result<(), StoreError>> + Send;
}

/// Erzeugt Object Stores aus Profil und Zugangsdaten.
pub trait StoreFactory: Send + Sync {
    type Store: ObjectStore + 'static;

    /// # Errors
    /// `InvalidConfig` bei ungültigem Profil, unlesbarer CA-Datei oder ungültigem Proxy.
    fn create(&self, profile: &ConnectionProfile, credentials: Credentials) -> Result<Self::Store, StoreError>;
}

/// Liefert den Object Store eines gespeicherten Verbindungsprofils.
pub trait StoreProvider: Send + Sync {
    type Store: ObjectStore + 'static;

    /// # Errors
    /// Unbekanntes Profil, fehlende Zugangsdaten oder ungültige Konfiguration.
    fn store_for(&self, profile_id: &str) -> Result<Arc<Self::Store>, AppError>;
}

/// Dauerhafte Ablage der Verbindungsprofile (ohne Zugangsdaten).
pub trait ProfileRepository: Send + Sync {
    /// # Errors
    /// Lese- oder Formatfehler.
    fn list(&self) -> Result<Vec<ConnectionProfile>, RepositoryError>;
    /// Legt an oder ersetzt das Profil mit derselben ID.
    ///
    /// # Errors
    /// Lese- oder Schreibfehler.
    fn save(&self, profile: &ConnectionProfile) -> Result<(), RepositoryError>;
    /// Entfernt das Profil; unbekannte IDs sind kein Fehler.
    ///
    /// # Errors
    /// Lese- oder Schreibfehler.
    fn delete(&self, id: &str) -> Result<(), RepositoryError>;
}

/// Dauerhafte Ablage der Einstellungen.
pub trait SettingsRepository: Send + Sync {
    /// Fehlt die Ablage, gelten die Standardwerte.
    ///
    /// # Errors
    /// Lese- oder Formatfehler.
    fn load(&self) -> Result<AppSettings, RepositoryError>;
    /// # Errors
    /// Schreibfehler.
    fn save(&self, settings: &AppSettings) -> Result<(), RepositoryError>;
}

/// Sichere Ablage von Zugangsdaten je Verbindungsprofil.
pub trait CredentialStore: Send + Sync {
    /// # Errors
    /// Plattformfehler oder beschädigte Daten.
    fn load(&self, profile_id: &str) -> Result<Option<Credentials>, CredentialError>;
    /// # Errors
    /// Plattformfehler.
    fn save(&self, profile_id: &str, credentials: &Credentials) -> Result<(), CredentialError>;
    /// Löscht die Zugangsdaten; fehlende Einträge sind kein Fehler.
    ///
    /// # Errors
    /// Plattformfehler.
    fn delete(&self, profile_id: &str) -> Result<(), CredentialError>;
}

/// Lokales Dateisystem: Dateien für Uploads auflösen, Teildateien für Downloads verwalten.
pub trait LocalFiles: Send + Sync {
    /// Ordner werden rekursiv aufgelöst; relative Pfade behalten den Ordnernamen.
    ///
    /// # Errors
    /// `LocalFile`, wenn ein Pfad nicht gelesen werden kann.
    fn expand(&self, paths: &[PathBuf]) -> Result<Vec<LocalFile>, StoreError>;

    /// Legt die Teildatei `partial` mit der Größe `size` samt fehlender Ordner an. Eine vorhandene
    /// Teildatei derselben Größe behält ihren Inhalt; dann ist das Ergebnis `true` und der
    /// Download kann fortsetzen.
    ///
    /// # Errors
    /// `LocalFile`, wenn Ordner oder Datei nicht angelegt werden können.
    fn prepare_download(&self, partial: &Path, size: u64) -> Result<bool, StoreError>;

    /// Benennt die fertige Teildatei in `target` um. Mit `overwrite` wird ein vorhandenes Ziel
    /// ersetzt, sonst ein freier Name gewählt. Liefert den endgültigen Pfad.
    ///
    /// # Errors
    /// `LocalFile`, wenn das Umbenennen scheitert.
    fn complete_download(&self, partial: &Path, target: &Path, overwrite: bool) -> Result<PathBuf, StoreError>;

    /// Änderungszeit einer lokalen Datei in Millisekunden seit Epoch; None, wenn sie fehlt.
    ///
    /// # Errors
    /// `LocalFile`, wenn sie nicht gelesen werden kann.
    fn modified_ms(&self, path: &Path) -> Result<Option<i64>, StoreError>;

    /// Setzt die Änderungszeit einer Datei, z. B. auf die des Objekts nach einem Abgleich.
    ///
    /// # Errors
    /// `LocalFile`, wenn die Datei nicht geändert werden kann.
    fn set_modified_ms(&self, path: &Path, modified_ms: i64) -> Result<(), StoreError>;

    /// MD5 der ganzen Datei als Hex, um einen Download mit seinem `ETag` zu vergleichen.
    ///
    /// # Errors
    /// `LocalFile`, wenn die Datei nicht gelesen werden kann.
    fn md5_hex(&self, path: &Path) -> impl Future<Output = Result<String, StoreError>> + Send;

    /// Löscht die Teildatei eines abgebrochenen Downloads; fehlt sie, ist das kein Fehler.
    ///
    /// # Errors
    /// `LocalFile`, wenn die Datei nicht gelöscht werden kann.
    fn discard_download(&self, partial: &Path) -> Result<(), StoreError>;
}

/// Lokale Ordner durchsuchen (linke Seite der Zwei-Panel-Ansicht).
pub trait LocalDirectories: Send + Sync {
    /// Verfügbare Laufwerke.
    fn roots(&self) -> Vec<LocalEntry>;

    /// Inhalt eines Ordners ohne versteckte und Systemdateien.
    ///
    /// # Errors
    /// `LocalFile`, wenn der Ordner nicht gelesen werden kann.
    fn list(&self, dir: &Path) -> Result<Vec<LocalEntry>, StoreError>;
}

/// Kennung eines begonnenen Schreibvorgangs im Listing-Cache.
pub type CacheWrite = i64;

/// Gespeicherte Ordner-Listings. Ein neues Listing wird seitenweise geschrieben und ersetzt das
/// alte erst beim Abschluss; abgebrochene Listings hinterlassen nichts.
pub trait ListingCache: Send + Sync {
    /// Liefert die gespeicherten Seiten in Key-Reihenfolge mit dem Zeitpunkt des Listings an
    /// `on_page`; `false`, wenn der Ordner nicht im Cache liegt.
    ///
    /// # Errors
    /// `Storage`, wenn die Cache-Datei nicht gelesen werden kann.
    fn load(&self, folder: &FolderKey, on_page: &mut dyn FnMut(i64, ListPage)) -> Result<bool, CacheError>;

    /// # Errors
    /// `Storage` bei Schreibfehlern.
    fn begin(&self, folder: &FolderKey) -> Result<CacheWrite, CacheError>;

    /// # Errors
    /// `Storage` bei Schreibfehlern.
    fn append(&self, write: CacheWrite, page: &ListPage) -> Result<(), CacheError>;

    /// Macht das neue Listing gültig und verwirft das bisherige des Ordners.
    ///
    /// # Errors
    /// `Storage` bei Schreibfehlern.
    fn commit(&self, write: CacheWrite, fetched_ms: i64) -> Result<(), CacheError>;

    /// # Errors
    /// `Storage` bei Schreibfehlern.
    fn discard(&self, write: CacheWrite) -> Result<(), CacheError>;

    /// Entfernt alle Listings einer Verbindung.
    ///
    /// # Errors
    /// `Storage` bei Schreibfehlern.
    fn forget_profile(&self, profile_id: &str) -> Result<(), CacheError>;

    /// # Errors
    /// `Storage` bei Schreibfehlern.
    fn clear(&self) -> Result<(), CacheError>;

    /// # Errors
    /// `Storage`, wenn die Cache-Datei nicht gelesen werden kann.
    fn stats(&self) -> Result<CacheStats, CacheError>;
}

/// Meldet den Stand aller Transfers an die Oberfläche.
pub trait TransferEvents: Send + Sync {
    fn publish(&self, update: TransferUpdate);
}

pub type BoxFuture = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

/// Startet Hintergrundaufgaben auf der Laufzeit der Anwendung.
pub trait Spawner: Send + Sync {
    fn spawn(&self, task: BoxFuture);
}

/// Uhr: Weltzeit für Signaturen und Zeitstempel, monotone Zeit für Messungen.
pub trait Clock: Send + Sync {
    fn utc_now(&self) -> OffsetDateTime;
    fn monotonic(&self) -> Instant;

    /// Jetzt in Millisekunden seit Epoch.
    fn unix_ms(&self) -> i64 {
        unix_ms(self.utc_now()).unwrap_or(i64::MAX)
    }
}

// Geteilte Dienste (Arc) erfüllen dieselben Ports wie der Dienst selbst.

impl<T: StoreProvider + ?Sized> StoreProvider for Arc<T> {
    type Store = T::Store;

    fn store_for(&self, profile_id: &str) -> Result<Arc<Self::Store>, AppError> {
        (**self).store_for(profile_id)
    }
}

impl<T: TransferEvents + ?Sized> TransferEvents for Arc<T> {
    fn publish(&self, update: TransferUpdate) {
        (**self).publish(update);
    }
}

impl<T: ListingCache + ?Sized> ListingCache for Arc<T> {
    fn load(&self, folder: &FolderKey, on_page: &mut dyn FnMut(i64, ListPage)) -> Result<bool, CacheError> {
        (**self).load(folder, on_page)
    }

    fn begin(&self, folder: &FolderKey) -> Result<CacheWrite, CacheError> {
        (**self).begin(folder)
    }

    fn append(&self, write: CacheWrite, page: &ListPage) -> Result<(), CacheError> {
        (**self).append(write, page)
    }

    fn commit(&self, write: CacheWrite, fetched_ms: i64) -> Result<(), CacheError> {
        (**self).commit(write, fetched_ms)
    }

    fn discard(&self, write: CacheWrite) -> Result<(), CacheError> {
        (**self).discard(write)
    }

    fn forget_profile(&self, profile_id: &str) -> Result<(), CacheError> {
        (**self).forget_profile(profile_id)
    }

    fn clear(&self) -> Result<(), CacheError> {
        (**self).clear()
    }

    fn stats(&self) -> Result<CacheStats, CacheError> {
        (**self).stats()
    }
}

impl<T: Clock + ?Sized> Clock for Arc<T> {
    fn utc_now(&self) -> OffsetDateTime {
        (**self).utc_now()
    }

    fn monotonic(&self) -> Instant {
        (**self).monotonic()
    }
}

/// Teilen-Dialog des Betriebssystems.
pub trait ShareSheet: Send + Sync {
    /// Zeigt den Dialog mit dem Link; die Auswahl des Ziels trifft der Nutzer dort.
    ///
    /// # Errors
    /// `Platform`, wenn der Dialog nicht geöffnet werden kann.
    fn show(&self, link: &SharedLink) -> Result<(), ShareError>;
}
