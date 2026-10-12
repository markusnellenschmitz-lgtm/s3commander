//! Löschen: Grenzen der S3-API und was die Oberfläche vor, während und nach dem Löschen sieht.

use serde::Serialize;

/// `DeleteObjects` nimmt höchstens 1.000 Keys je Anfrage an.
pub const MAX_DELETE_BATCH: usize = 1000;

/// So viele Fehlschläge listet das Ergebnis einzeln auf; der Rest wird nur gezählt.
pub const MAX_REPORTED_FAILURES: usize = 100;

/// Key, den der Dienst nicht löschen konnte, mit seinem Fehlercode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFailure {
    pub key: String,
    pub code: String,
    pub message: String,
}

/// Was gelöscht würde; Grundlage des Bestätigungsdialogs („Ziel und Menge“).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePreview {
    /// Kennung des vorbereiteten Plans; nur genau diese Keys werden gelöscht.
    pub plan_id: String,
    pub objects: u64,
    pub bytes: u64,
    /// Versionierung im Bucket: aktiv oder ausgesetzt, aus, oder unbekannt (`None`).
    pub versioned: Option<bool>,
}

/// Fortschritt während des Löschens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteProgress {
    /// Gelöschte und abgelehnte Keys zusammen
    pub processed: u64,
    pub total: u64,
}

/// Ergebnis eines Löschvorgangs.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOutcome {
    pub deleted: u64,
    /// Anzahl aller Fehlschläge; einzeln aufgeführt sind höchstens `MAX_REPORTED_FAILURES`.
    pub failed_count: u64,
    pub failures: Vec<DeleteFailure>,
    /// Abgebrochen, bevor alle Pakete gesendet waren.
    pub cancelled: bool,
}

impl DeleteOutcome {
    /// Übernimmt das Ergebnis eines Pakets.
    pub fn record(&mut self, batch_size: usize, failures: Vec<DeleteFailure>) {
        let failed = failures.len();
        self.deleted += to_u64(batch_size.saturating_sub(failed));
        self.failed_count += to_u64(failed);
        let room = MAX_REPORTED_FAILURES.saturating_sub(self.failures.len());
        self.failures.extend(failures.into_iter().take(room));
    }
}

fn to_u64(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failure(key: &str) -> DeleteFailure {
        DeleteFailure {
            key: key.into(),
            code: "AccessDenied".into(),
            message: "nein".into(),
        }
    }

    #[test]
    fn records_batches_and_caps_the_listed_failures() {
        let mut outcome = DeleteOutcome::default();
        outcome.record(1000, vec![failure("a")]);
        outcome.record(500, (0..150).map(|i| failure(&format!("k{i}"))).collect());
        assert_eq!(outcome.deleted, 999 + 350);
        assert_eq!(outcome.failed_count, 151);
        assert_eq!(outcome.failures.len(), MAX_REPORTED_FAILURES);
        assert_eq!(outcome.failures[0].key, "a");
    }

    #[test]
    fn serializes_for_the_frontend() {
        let preview = DeletePreview {
            plan_id: "delete-1".into(),
            objects: 2,
            bytes: 3,
            versioned: None,
        };
        assert_eq!(
            serde_json::to_string(&preview).unwrap(),
            r#"{"planId":"delete-1","objects":2,"bytes":3,"versioned":null}"#
        );
        let outcome = serde_json::to_string(&DeleteOutcome::default()).unwrap();
        assert_eq!(
            outcome,
            r#"{"deleted":0,"failedCount":0,"failures":[],"cancelled":false}"#
        );
    }
}
