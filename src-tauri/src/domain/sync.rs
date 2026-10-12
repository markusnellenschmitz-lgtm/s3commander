//! Regeln für den Abgleich eines lokalen Ordners mit einem Ordner im Bucket (wie `aws s3 sync`).
//!
//! Übertragen wird, was im Ziel fehlt, eine andere Größe hat oder in der Quelle neuer ist. Zeiten
//! werden mit Toleranz verglichen: S3 speichert Sekunden, manche Dateisysteme zwei Sekunden.
//! Pfade werden genau verglichen; S3 unterscheidet Groß- und Kleinschreibung.

use serde::{Deserialize, Serialize};

/// Zeitunterschied, der noch als gleich gilt.
pub const TIME_TOLERANCE_MS: i64 = 2_000;

/// Höchstens so viele Einträge zeigt die Vorschau; gezählt wird alles.
pub const PREVIEW_LIMIT: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncDirection {
    /// Lokal → Bucket
    Upload,
    /// Bucket → Lokal
    Download,
}

/// Eine Datei auf einer Seite, mit Pfad relativ zum abgeglichenen Ordner (`/` getrennt).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncEntry {
    pub relative: String,
    pub size: u64,
    pub modified_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncReason {
    /// Fehlt im Ziel.
    New,
    /// Größe weicht ab.
    SizeDiffers,
    /// In der Quelle neuer.
    Newer,
}

/// Was der Abgleich tun würde; Indizes zeigen in die Quell- bzw. Zielliste.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncDecision {
    /// Zu übertragen: Index in der Quelle und Grund.
    pub transfers: Vec<(usize, SyncReason)>,
    /// Nur im Ziel vorhanden: Index im Ziel.
    pub extras: Vec<usize>,
    pub unchanged: usize,
}

/// Vergleicht Quelle und Ziel.
#[must_use]
pub fn decide(source: &[SyncEntry], target: &[SyncEntry]) -> SyncDecision {
    let by_path: std::collections::HashMap<&str, &SyncEntry> =
        target.iter().map(|e| (e.relative.as_str(), e)).collect();
    let mut decision = SyncDecision::default();
    for (index, entry) in source.iter().enumerate() {
        match reason(entry, by_path.get(entry.relative.as_str()).copied()) {
            Some(reason) => decision.transfers.push((index, reason)),
            None => decision.unchanged += 1,
        }
    }
    let sources: std::collections::HashSet<&str> = source.iter().map(|e| e.relative.as_str()).collect();
    decision.extras = target
        .iter()
        .enumerate()
        .filter(|(_, e)| !sources.contains(e.relative.as_str()))
        .map(|(index, _)| index)
        .collect();
    decision
}

fn reason(source: &SyncEntry, target: Option<&SyncEntry>) -> Option<SyncReason> {
    let Some(target) = target else {
        return Some(SyncReason::New);
    };
    if source.size != target.size {
        return Some(SyncReason::SizeDiffers);
    }
    match (source.modified_ms, target.modified_ms) {
        (Some(s), Some(t)) if s > t + TIME_TOLERANCE_MS => Some(SyncReason::Newer),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(relative: &str, size: u64, modified_ms: i64) -> SyncEntry {
        SyncEntry {
            relative: relative.into(),
            size,
            modified_ms: Some(modified_ms),
        }
    }

    #[test]
    fn transfers_new_resized_and_newer_files() {
        let source = [
            entry("neu.txt", 1, 0),
            entry("groesse.txt", 2, 0),
            entry("neuer.txt", 3, 10_000),
            entry("gleich.txt", 4, 10_000),
            entry("knapp.txt", 5, 11_500),
        ];
        let target = [
            entry("groesse.txt", 9, 0),
            entry("neuer.txt", 3, 5_000),
            entry("gleich.txt", 4, 10_000),
            entry("knapp.txt", 5, 10_000),
            entry("nur-ziel.txt", 6, 0),
        ];
        let decision = decide(&source, &target);
        assert_eq!(
            decision.transfers,
            [
                (0, SyncReason::New),
                (1, SyncReason::SizeDiffers),
                (2, SyncReason::Newer)
            ]
        );
        assert_eq!(decision.unchanged, 2, "gleich und innerhalb der Toleranz");
        assert_eq!(decision.extras, [4]);
    }

    #[test]
    fn keeps_files_without_time_and_compares_paths_exactly() {
        let source = [SyncEntry {
            relative: "a.txt".into(),
            size: 1,
            modified_ms: None,
        }];
        let target = [entry("a.txt", 1, 0), entry("A.txt", 1, 0)];
        let decision = decide(&source, &target);
        assert_eq!((decision.transfers.len(), decision.unchanged), (0, 1));
        assert_eq!(decision.extras, [1]);
    }
}
