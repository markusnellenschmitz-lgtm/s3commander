//! Einstellungen › Transfers (Screen 7): Werte mit Grenzen und Standardwerten.
//! Unbekannte oder fehlende Felder in der Datei fallen auf die Standardwerte zurück.

use super::multipart::MIB;
use serde::{Deserialize, Serialize};
use std::ops::RangeInclusive;

pub const MAX_TRANSFERS_RANGE: RangeInclusive<u32> = 1..=32;
pub const PARTS_PARALLEL_RANGE: RangeInclusive<u32> = 1..=16;
/// S3 verlangt mindestens 5 MiB je Teil; mehr als 512 MiB bringt beim Fortsetzen nichts.
pub const PART_SIZE_MIB_RANGE: RangeInclusive<u32> = 5..=512;
pub const MULTIPART_THRESHOLD_MIB_RANGE: RangeInclusive<u32> = 5..=5 * 1024;
pub const RETRIES_RANGE: RangeInclusive<u32> = 0..=10;
pub const LIMIT_MIBPS_RANGE: RangeInclusive<u32> = 0..=10_000;

/// Was passiert, wenn eine heruntergeladene Datei lokal schon existiert.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictPolicy {
    /// Nicht herunterladen.
    Skip,
    /// Nur herunterladen, wenn das Objekt neuer ist als die lokale Datei.
    OverwriteIfNewer,
    Overwrite,
    /// Unter einem freien Namen wie `bild (2).jpg` speichern.
    #[default]
    Rename,
}

/// Was mit einer heruntergeladenen Datei geschieht, deren Ziel schon existiert.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictDecision {
    /// Herunterladen; mit `overwrite` ersetzt die Datei das Ziel, sonst bekommt sie einen freien Namen.
    Download {
        overwrite: bool,
    },
    Skip,
}

/// Entscheidet nach der Regel; ohne lokale Datei gibt es keinen Konflikt. Bei „wenn neuer“
/// wird heruntergeladen, wenn das Alter des Objekts unbekannt ist.
#[must_use]
pub fn decide_conflict(policy: ConflictPolicy, local_ms: Option<i64>, remote_ms: Option<i64>) -> ConflictDecision {
    let Some(local) = local_ms else {
        return ConflictDecision::Download { overwrite: false };
    };
    match policy {
        ConflictPolicy::Overwrite => ConflictDecision::Download { overwrite: true },
        ConflictPolicy::Rename => ConflictDecision::Download { overwrite: false },
        ConflictPolicy::OverwriteIfNewer if remote_ms.is_none_or(|remote| remote > local) => {
            ConflictDecision::Download { overwrite: true }
        }
        ConflictPolicy::Skip | ConflictPolicy::OverwriteIfNewer => ConflictDecision::Skip,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TransferPreferences {
    pub max_transfers: u32,
    pub parts_parallel: u32,
    pub part_size_mib: u32,
    pub multipart_threshold_mib: u32,
    pub retries: u32,
    /// 0 = unbegrenzt
    pub upload_limit_mibps: u32,
    /// 0 = unbegrenzt
    pub download_limit_mibps: u32,
    pub conflict: ConflictPolicy,
    /// „Prüfsumme nach dem Upload vergleichen“ (CRC32C, sonst MD5)
    pub verify_checksums: bool,
}

impl Default for TransferPreferences {
    fn default() -> Self {
        Self {
            max_transfers: 8,
            parts_parallel: 4,
            part_size_mib: 16,
            multipart_threshold_mib: 64,
            retries: 3,
            upload_limit_mibps: 0,
            download_limit_mibps: 0,
            conflict: ConflictPolicy::Rename,
            verify_checksums: true,
        }
    }
}

impl TransferPreferences {
    #[must_use]
    pub fn part_size(&self) -> u64 {
        u64::from(self.part_size_mib) * MIB
    }

    #[must_use]
    pub fn multipart_threshold(&self) -> u64 {
        u64::from(self.multipart_threshold_mib) * MIB
    }

    /// Bytes pro Sekunde; 0 = unbegrenzt.
    #[must_use]
    pub fn upload_limit(&self) -> u64 {
        u64::from(self.upload_limit_mibps) * MIB
    }

    /// Bytes pro Sekunde; 0 = unbegrenzt.
    #[must_use]
    pub fn download_limit(&self) -> u64 {
        u64::from(self.download_limit_mibps) * MIB
    }
}

/// Einstellungen › Cache.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CachePreferences {
    /// Ordner-Listings zwischenspeichern und beim Öffnen sofort zeigen.
    pub enabled: bool,
}

impl Default for CachePreferences {
    fn default() -> Self {
        Self { enabled: true }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub transfers: TransferPreferences,
    pub cache: CachePreferences,
}

/// Warum Einstellungen nicht gespeichert werden. Texte erscheinen im Dialog.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SettingsError {
    #[error("{field} muss zwischen {min} und {max} liegen")]
    OutOfRange { field: &'static str, min: u32, max: u32 },
}

impl AppSettings {
    /// # Errors
    /// `OutOfRange` für den ersten Wert außerhalb seiner Grenzen.
    pub fn validate(&self) -> Result<(), SettingsError> {
        let t = &self.transfers;
        check("Gleichzeitige Transfers", t.max_transfers, &MAX_TRANSFERS_RANGE)?;
        check("Teile pro Datei", t.parts_parallel, &PARTS_PARALLEL_RANGE)?;
        check("Teilgröße (MiB)", t.part_size_mib, &PART_SIZE_MIB_RANGE)?;
        check(
            "Multipart ab (MiB)",
            t.multipart_threshold_mib,
            &MULTIPART_THRESHOLD_MIB_RANGE,
        )?;
        check("Wiederholungen", t.retries, &RETRIES_RANGE)?;
        check("Upload-Limit (MiB/s)", t.upload_limit_mibps, &LIMIT_MIBPS_RANGE)?;
        check("Download-Limit (MiB/s)", t.download_limit_mibps, &LIMIT_MIBPS_RANGE)
    }
}

fn check(field: &'static str, value: u32, range: &RangeInclusive<u32>) -> Result<(), SettingsError> {
    if range.contains(&value) {
        Ok(())
    } else {
        Err(SettingsError::OutOfRange {
            field,
            min: *range.start(),
            max: *range.end(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn has_the_defaults_from_the_design() {
        let t = TransferPreferences::default();
        assert_eq!(
            (
                t.max_transfers,
                t.parts_parallel,
                t.part_size(),
                t.multipart_threshold()
            ),
            (8, 4, 16 * MIB, 64 * MIB)
        );
        assert_eq!(
            (t.upload_limit(), t.download_limit(), t.conflict),
            (0, 0, ConflictPolicy::Rename)
        );
        assert!(AppSettings::default().validate().is_ok());
    }

    #[test]
    fn decides_conflicts_by_policy() {
        use ConflictDecision::{Download, Skip};
        let rename = Download { overwrite: false };
        let overwrite = Download { overwrite: true };
        assert_eq!(
            decide_conflict(ConflictPolicy::Skip, None, Some(1)),
            rename,
            "ohne lokale Datei kein Konflikt"
        );
        assert_eq!(decide_conflict(ConflictPolicy::Skip, Some(1), Some(2)), Skip);
        assert_eq!(decide_conflict(ConflictPolicy::Overwrite, Some(5), Some(1)), overwrite);
        assert_eq!(decide_conflict(ConflictPolicy::Rename, Some(5), Some(9)), rename);
        assert_eq!(
            decide_conflict(ConflictPolicy::OverwriteIfNewer, Some(5), Some(9)),
            overwrite
        );
        assert_eq!(
            decide_conflict(ConflictPolicy::OverwriteIfNewer, Some(9), Some(5)),
            Skip
        );
        assert_eq!(
            decide_conflict(ConflictPolicy::OverwriteIfNewer, Some(9), Some(9)),
            Skip
        );
        assert_eq!(
            decide_conflict(ConflictPolicy::OverwriteIfNewer, Some(9), None),
            overwrite
        );
    }

    #[test]
    fn rejects_values_out_of_range() {
        let mut settings = AppSettings::default();
        settings.transfers.part_size_mib = 4;
        assert_eq!(
            settings.validate(),
            Err(SettingsError::OutOfRange {
                field: "Teilgröße (MiB)",
                min: 5,
                max: 512
            })
        );
        assert_eq!(
            settings.validate().unwrap_err().to_string(),
            "Teilgröße (MiB) muss zwischen 5 und 512 liegen"
        );
        settings.transfers.part_size_mib = 16;
        settings.transfers.max_transfers = 0;
        assert!(settings.validate().is_err());
    }

    #[test]
    fn reads_partial_files_with_defaults_and_writes_camel_case() {
        let partial: AppSettings =
            serde_json::from_str(r#"{"transfers":{"uploadLimitMibps":50,"conflict":"skip"}}"#).unwrap();
        assert_eq!(partial.transfers.upload_limit(), 50 * MIB);
        assert_eq!(partial.transfers.conflict, ConflictPolicy::Skip);
        assert_eq!(partial.transfers.max_transfers, 8);
        assert!(
            partial.cache.enabled,
            "ältere Dateien ohne Cache-Abschnitt lassen den Cache an"
        );
        let off: AppSettings = serde_json::from_str(r#"{"cache":{"enabled":false}}"#).unwrap();
        assert!(!off.cache.enabled);
        let empty: AppSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, AppSettings::default());
        let json = serde_json::to_string(&TransferPreferences::default()).unwrap();
        assert!(json.contains(r#""conflict":"rename""#) && json.contains("multipartThresholdMib"));
    }
}
