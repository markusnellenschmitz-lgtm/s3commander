//! Transfers: Zustände, Ziele, Fortschritt und Regeln für Wiederholungen.

use super::bandwidth::BandwidthLimit;
use super::error::{ErrorReport, StoreError};
use super::object::ListRequest;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

pub type TransferId = u64;

/// Zustände laut UI-SPEC §5 "Transfer-State-Machine".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferState {
    Waiting,
    Active,
    Paused,
    Done,
    /// Nach der Konfliktregel nicht heruntergeladen, weil die lokale Datei bleiben soll.
    Skipped,
    Failed,
    Cancelled,
}

impl TransferState {
    /// Abgeschlossene Transfers lassen sich aus der Liste entfernen.
    #[must_use]
    pub fn is_finished(self) -> bool {
        matches!(self, Self::Done | Self::Skipped | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Upload,
    Download,
    Copy,
}

/// Objekt eines Transfers: Ziel eines Uploads oder Quelle eines Downloads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectRef {
    pub bucket: String,
    pub key: String,
    pub content_type: Option<String>,
}

/// Byte-Bereich einer lokalen Datei, der als Körper gestreamt wird.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRange {
    pub path: PathBuf,
    pub offset: u64,
    pub length: u64,
}

/// Fertig hochgeladener Teil eines Multipart-Uploads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletedPart {
    pub part_number: u32,
    pub etag: String,
    /// CRC32C des Teils (Base64), wenn der Upload mit CRC32C geprüft wird.
    pub checksum_crc32c: Option<String>,
}

impl CompletedPart {
    /// Teil ohne eigene Prüfsumme (MD5-geprüft, Server-Kopie oder Prüfung aus).
    #[must_use]
    pub fn new(part_number: u32, etag: String) -> Self {
        Self {
            part_number,
            etag,
            checksum_crc32c: None,
        }
    }
}

/// Ob Uploads ihre Daten vom Dienst prüfen lassen (Einstellungen › Transfers › Prüfung).
/// Der Adapter nimmt CRC32C, wo der Anbieter es kann, sonst `Content-MD5`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Checksums {
    Off,
    #[default]
    Verify,
}

/// Teil, den der Dienst für einen laufenden Multipart-Upload bereits kennt (`ListParts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadedPart {
    pub part_number: u32,
    pub etag: String,
    pub size: u64,
    /// CRC32C des Teils, wenn der Upload mit CRC32C begonnen wurde.
    pub checksum_crc32c: Option<String>,
}

/// Zähler für übertragene Bytes; günstig klonbar, alle Klone teilen den Wert.
/// Mit einem Bandbreitenlimit sagt er, wie lange vor dem nächsten Stück zu warten ist.
#[derive(Debug, Clone, Default)]
pub struct ByteCounter {
    count: Arc<AtomicU64>,
    limit: Option<Arc<BandwidthLimit>>,
}

impl ByteCounter {
    #[must_use]
    pub fn limited(limit: Option<Arc<BandwidthLimit>>) -> Self {
        Self {
            count: Arc::default(),
            limit,
        }
    }

    pub fn add(&self, bytes: u64) {
        self.count.fetch_add(bytes, Ordering::Relaxed);
    }

    #[must_use]
    pub fn get(&self) -> u64 {
        self.count.load(Ordering::Relaxed)
    }

    /// Wartezeit, bevor `bytes` übertragen werden dürfen; ohne Limit null.
    #[must_use]
    pub fn throttle(&self, bytes: u64, now: Instant) -> Duration {
        self.limit
            .as_ref()
            .map_or(Duration::ZERO, |limit| limit.reserve(bytes, now))
    }
}

/// Lokale Datei, die hochgeladen werden soll.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalFile {
    pub path: PathBuf,
    /// Pfad relativ zur gewählten Wurzel, mit `/` getrennt (Ordner bleiben erhalten).
    pub relative: String,
    pub size: u64,
    pub content_type: String,
    /// Änderungszeit in Millisekunden seit Epoch, für den Abgleich.
    pub modified_ms: Option<i64>,
}

/// Im Objektbrowser gewählter Eintrag, z. B. zum Herunterladen oder Löschen.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedItem {
    pub key: String,
    /// Ordner (Präfixe) gelten mit allem, was darunter liegt.
    pub is_folder: bool,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub etag: Option<String>,
    /// Millisekunden seit Epoch; für „Überschreiben, wenn neuer“.
    #[serde(default)]
    pub last_modified_ms: Option<i64>,
}

impl SelectedItem {
    /// Rekursives Listing des gewählten Ordners, Grundlage für Löschen, Verschieben und Herunterladen.
    ///
    /// # Errors
    /// `InvalidConfig`, wenn der Eintrag kein Ordner-Präfix mit abschließendem `/` ist. Sonst träfe
    /// `a/b` auch `a/bild.jpg`, und ein leerer Key den ganzen Bucket.
    pub fn folder_listing(&self, bucket: &str) -> Result<ListRequest, StoreError> {
        let is_prefix = self.key.ends_with('/') && !self.key.trim_matches('/').is_empty();
        if !self.is_folder || !is_prefix {
            return Err(StoreError::InvalidConfig(format!(
                "Kein gültiger Ordner: „{}“",
                self.key
            )));
        }
        Ok(ListRequest::recursive(bucket, &self.key))
    }
}

/// Bucket und Key eines Objekts, wie die Oberfläche sie anzeigt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ObjectAddress {
    pub bucket: String,
    pub key: String,
}

/// Momentaufnahme eines Transfers für die Oberfläche (Screen 4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSnapshot {
    pub id: TransferId,
    pub direction: Direction,
    pub profile_id: String,
    pub name: String,
    /// Lokale Datei: Quelle eines Uploads, Ziel eines Downloads; leer beim Kopieren.
    pub local_path: String,
    /// Quelle einer Kopie.
    pub copy_source: Option<ObjectAddress>,
    /// Verbindung der Quelle, wenn eine Kopie aus einer anderen Verbindung kommt.
    pub source_profile_id: Option<String>,
    pub bucket: String,
    pub key: String,
    pub total_bytes: u64,
    pub done_bytes: u64,
    pub state: TransferState,
    pub bytes_per_sec: u64,
    pub part_count: u64,
    pub parts_done: u64,
    pub error: Option<ErrorReport>,
    /// Millisekunden seit Epoch
    pub finished_ms: Option<i64>,
}

/// Meldung an die Oberfläche: nur Transfers, die sich seit der letzten Meldung geändert haben,
/// und die IDs entfernter Transfers. So bleibt jede Meldung klein, auch bei Hunderttausenden.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferUpdate {
    pub changed: Vec<TransferSnapshot>,
    pub removed: Vec<TransferId>,
}

impl TransferUpdate {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.changed.is_empty() && self.removed.is_empty()
    }
}

/// Objekt-Key aus Zielpräfix und relativem lokalen Pfad. Windows-Trenner werden zu `/`.
#[must_use]
pub fn upload_key(prefix: &str, relative: &str) -> String {
    let relative = relative.replace('\\', "/");
    let relative = relative.trim_start_matches('/');
    match prefix {
        "" => relative.to_owned(),
        p if p.ends_with('/') => format!("{p}{relative}"),
        p => format!("{p}/{relative}"),
    }
}

/// HTTP-Status, bei denen S3 ausdrücklich zu einem neuen Versuch rät.
const RETRYABLE_STATUS: [u16; 2] = [408, 429];
/// `BadDigest`: Der Dienst hat einen Teil mit falscher Prüfsumme abgelehnt; ein neuer Versuch
/// liest die Daten neu.
const RETRYABLE_CODES: [&str; 5] = [
    "RequestTimeout",
    "SlowDown",
    "InternalError",
    "ServiceUnavailable",
    "BadDigest",
];

/// MD5 als Hex, wenn der `ETag` eine ist: 32 Hex-Zeichen in Anführungszeichen. Multipart-ETags
/// (`"…-12"`) sind keine MD5-Summe des Objekts.
#[must_use]
pub fn md5_from_etag(etag: &str) -> Option<String> {
    let value = etag.trim_matches('"');
    (value.len() == 32 && value.chars().all(|c| c.is_ascii_hexdigit())).then(|| value.to_ascii_lowercase())
}

/// Vorübergehende Fehler lohnen einen neuen Versuch, Berechtigungs- und Konfigurationsfehler nicht.
#[must_use]
pub fn is_retryable(error: &StoreError) -> bool {
    match error {
        StoreError::Network(_) | StoreError::Timeout => true,
        StoreError::Service(e) => {
            e.http_status >= 500
                || RETRYABLE_STATUS.contains(&e.http_status)
                || RETRYABLE_CODES.contains(&e.code.as_str())
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::error::ServiceError;

    fn selected(key: &str, is_folder: bool) -> SelectedItem {
        SelectedItem {
            key: key.into(),
            is_folder,
            size: 0,
            etag: None,
            last_modified_ms: None,
        }
    }

    #[test]
    fn lists_only_real_folders_recursively() {
        assert_eq!(
            selected("p/d/", true).folder_listing("b"),
            Ok(ListRequest::recursive("b", "p/d/"))
        );
        // Ohne `/` träfe das Präfix auch Geschwister wie `p/dateien.txt`, leer den ganzen Bucket.
        for key in ["p/d", "", "/"] {
            assert!(
                matches!(
                    selected(key, true).folder_listing("b"),
                    Err(StoreError::InvalidConfig(_))
                ),
                "{key:?}"
            );
        }
        assert!(selected("p/d/", false).folder_listing("b").is_err());
    }

    #[test]
    fn builds_keys_from_prefix_and_relative_paths() {
        assert_eq!(upload_key("", "a.txt"), "a.txt");
        assert_eq!(upload_key("backups/2026/", "db.tar"), "backups/2026/db.tar");
        assert_eq!(
            upload_key("backups", "ordner\\unter\\x.bin"),
            "backups/ordner/unter/x.bin"
        );
        assert_eq!(upload_key("p/", "/führend.txt"), "p/führend.txt");
    }

    #[test]
    fn counters_share_their_value() {
        let counter = ByteCounter::default();
        let clone = counter.clone();
        counter.add(5);
        clone.add(7);
        assert_eq!(counter.get(), 12);
    }

    #[test]
    fn counters_throttle_only_with_a_limit() {
        let now = Instant::now();
        assert_eq!(ByteCounter::default().throttle(u64::MAX, now), Duration::ZERO);
        let limit = Arc::new(BandwidthLimit::default());
        limit.set_rate(100);
        let counter = ByteCounter::limited(Some(limit));
        assert_eq!(counter.throttle(100, now), Duration::ZERO);
        assert_eq!(counter.clone().throttle(50, now), Duration::from_millis(500));
    }

    #[test]
    fn marks_done_and_cancelled_as_finished() {
        assert!(TransferState::Done.is_finished());
        assert!(TransferState::Cancelled.is_finished());
        assert!(TransferState::Skipped.is_finished());
        assert!(!TransferState::Failed.is_finished());
        assert!(!TransferState::Paused.is_finished());
    }

    #[test]
    fn update_without_changes_or_removals_is_empty() {
        assert!(TransferUpdate::default().is_empty());
        let removed = TransferUpdate {
            removed: vec![1],
            ..TransferUpdate::default()
        };
        assert!(!removed.is_empty());
    }

    fn service(code: &str, status: u16) -> StoreError {
        StoreError::Service(ServiceError {
            code: code.into(),
            message: String::new(),
            http_status: status,
            request_id: None,
        })
    }

    #[test]
    fn retries_only_transient_errors() {
        assert!(is_retryable(&StoreError::Timeout));
        assert!(is_retryable(&StoreError::Network("weg".into())));
        assert!(is_retryable(&service("InternalError", 500)));
        assert!(is_retryable(&service("SlowDown", 503)));
        assert!(is_retryable(&service("RequestTimeout", 400)));
        assert!(is_retryable(&service("TooManyRequests", 429)));
        assert!(!is_retryable(&service("AccessDenied", 403)));
        assert!(!is_retryable(&service("NoSuchBucket", 404)));
        assert!(!is_retryable(&StoreError::Cancelled));
        assert!(!is_retryable(&StoreError::InvalidConfig("x".into())));
        assert!(
            is_retryable(&service("BadDigest", 400)),
            "Teil mit falscher Prüfsumme neu senden"
        );
        assert!(!is_retryable(&StoreError::Integrity("x".into())));
    }

    #[test]
    fn reads_md5_only_from_simple_etags() {
        assert_eq!(
            md5_from_etag("\"D41D8CD98F00B204E9800998ECF8427E\"").as_deref(),
            Some("d41d8cd98f00b204e9800998ecf8427e")
        );
        assert_eq!(md5_from_etag("\"d41d8cd98f00b204e9800998ecf8427e-12\""), None);
        assert_eq!(md5_from_etag("\"abc\""), None);
        assert_eq!(md5_from_etag("\"zz1d8cd98f00b204e9800998ecf8427e\""), None);
    }

    #[test]
    fn reads_download_items_from_the_frontend() {
        let item: SelectedItem = serde_json::from_str(r#"{"key":"a/","isFolder":true}"#).unwrap();
        assert_eq!(
            item,
            SelectedItem {
                key: "a/".into(),
                is_folder: true,
                size: 0,
                etag: None,
                last_modified_ms: None,
            }
        );
    }

    #[test]
    fn serializes_states_in_camel_case() {
        assert_eq!(
            serde_json::to_string(&TransferState::Cancelled).unwrap(),
            r#""cancelled""#
        );
        assert_eq!(serde_json::to_string(&Direction::Upload).unwrap(), r#""upload""#);
        assert_eq!(serde_json::to_string(&Direction::Download).unwrap(), r#""download""#);
    }
}
