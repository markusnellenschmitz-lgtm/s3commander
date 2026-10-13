//! Fensterweises Laden sehr großer Ordner: Regeln für Sortierung, Filter und Dateityp, mit denen
//! das Backend sortierte Ausschnitte eines gespeicherten Listings liefert.
//!
//! Die Regeln entsprechen denen der Oberfläche (`src/lib/features/objects/entry.ts` und
//! `objectFilter.ts`), damit sich die Liste gleich verhält, egal wer sortiert und filtert.

use serde::{Deserialize, Serialize};
use std::fmt::Write as _;

/// Ab so vielen Einträgen hält die Oberfläche einen Ordner nicht mehr selbst, sondern lädt
/// sichtbare Fenster aus dem Listing im SQLite-Cache.
pub const WINDOW_THRESHOLD: u64 = 50_000;

/// Höchstens so viele Einträge liefert eine einzelne Fensterabfrage.
pub const MAX_WINDOW_ENTRIES: u64 = 10_000;

/// Kennung eines Listings im Cache (vollständig oder noch im Aufbau).
pub type ListingId = i64;

/// Kennung einer sortierten und gefilterten Sicht auf ein Listing.
pub type ViewId = u64;

/// Dateityp für Icons und den Typfilter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    Folder,
    Archive,
    Text,
    Lock,
    File,
}

const ARCHIVED_CLASSES: [&str; 2] = ["GLACIER", "DEEP_ARCHIVE"];
const ENCRYPTED_SUFFIXES: [&str; 2] = [".gpg", ".age"];
const ARCHIVE_EXTENSIONS: [&str; 8] = ["zst", "gz", "zip", "tar", "7z", "xz", "bz2", "tgz"];
const TEXT_EXTENSIONS: [&str; 11] = [
    "txt", "log", "sql", "json", "csv", "md", "sha256", "yaml", "yml", "xml", "conf",
];

/// Dateityp eines Eintrags; `name` ist das letzte Segment des Keys.
#[must_use]
pub fn kind_of(name: &str, is_prefix: bool, storage_class: Option<&str>) -> EntryKind {
    if is_prefix {
        return EntryKind::Folder;
    }
    let name = name.to_lowercase();
    if ENCRYPTED_SUFFIXES.iter().any(|suffix| name.ends_with(suffix))
        || storage_class.is_some_and(|class| ARCHIVED_CLASSES.contains(&class))
    {
        return EntryKind::Lock;
    }
    let extension = name.rsplit_once('.').map(|(_, extension)| extension);
    match extension {
        Some(ext) if ARCHIVE_EXTENSIONS.contains(&ext) => EntryKind::Archive,
        Some(ext) if TEXT_EXTENSIONS.contains(&ext) => EntryKind::Text,
        _ => EntryKind::File,
    }
}

/// Suchtext wie in der Oberfläche: Teil des Namens, `*` steht für beliebig viele Zeichen,
/// ohne Unterschied zwischen Groß- und Kleinschreibung.
#[must_use]
pub fn name_matches(name: &str, pattern: &str) -> bool {
    let name = name.to_lowercase();
    let pattern = pattern.trim().to_lowercase();
    let mut rest = name.as_str();
    for part in pattern.split('*').filter(|part| !part.is_empty()) {
        match rest.find(part) {
            Some(at) => rest = &rest[at + part.len()..],
            None => return false,
        }
    }
    true
}

/// Sortierschlüssel für die natürliche Namenssortierung wie
/// `Intl.Collator('de', { numeric: true, sensitivity: 'base' })`: Zahlen zählen als Zahlen,
/// Groß- und Kleinschreibung sowie Akzente nicht. Byteweise verglichen ergeben die Schlüssel diese
/// Reihenfolge, damit SQLite ohne Rückruf sortieren kann. Eine Ziffernfolge wird zu `0`, ihrer
/// dreistelligen Länge ohne führende Nullen und den Ziffern; die `0` vorn hält Ziffern wie im
/// Collator vor Buchstaben und hinter Satzzeichen wie `-` und `.`.
#[must_use]
pub fn natural_key(name: &str) -> String {
    let mut key = String::with_capacity(name.len() + 8);
    let mut chars = name.chars().peekable();
    while let Some(c) = chars.next() {
        if c.is_ascii_digit() {
            let mut digits = String::from(c);
            while let Some(digit) = chars.next_if(char::is_ascii_digit) {
                digits.push(digit);
            }
            let number = digits.trim_start_matches('0');
            // In einen String zu schreiben scheitert nie.
            let _ = write!(key, "0{:03}{number}", number.len());
        } else {
            key.push(base_char(c));
        }
    }
    key
}

/// Grundbuchstabe ohne Akzent und Großschreibung, für den Vergleich auf Basisebene.
fn base_char(c: char) -> char {
    let lower = c.to_lowercase().next().unwrap_or(c);
    match lower {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => 'a',
        'ç' => 'c',
        'è' | 'é' | 'ê' | 'ë' => 'e',
        'ì' | 'í' | 'î' | 'ï' => 'i',
        'ñ' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' => 'o',
        'ù' | 'ú' | 'û' | 'ü' => 'u',
        'ý' | 'ÿ' => 'y',
        other => other,
    }
}

/// Spalte, nach der eine Sicht sortiert ist; Ordner stehen immer vorn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SortColumn {
    Name,
    Size,
    Modified,
    StorageClass,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSort {
    pub column: SortColumn,
    /// 1 aufsteigend, -1 absteigend (wie `SortState.dir` der Oberfläche).
    pub dir: i8,
}

impl WindowSort {
    #[must_use]
    pub fn descending(&self) -> bool {
        self.dir < 0
    }
}

/// Filter einer Sicht mit absoluten Grenzen (die Oberfläche rechnet „letzte 7 Tage“ um).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowFilter {
    pub text: String,
    pub kind: Option<EntryKind>,
    /// Größe mindestens (einschließlich); Ordner fallen bei einem Größenfilter heraus.
    pub min_size: Option<u64>,
    /// Größe unter (ausschließlich).
    pub max_size: Option<u64>,
    /// Geändert frühestens (einschließlich); Einträge ohne Datum fallen dann heraus.
    pub modified_from: Option<i64>,
    /// Geändert spätestens (einschließlich).
    pub modified_to: Option<i64>,
}

impl WindowFilter {
    #[must_use]
    pub fn filters_size(&self) -> bool {
        self.min_size.is_some() || self.max_size.is_some()
    }

    #[must_use]
    pub fn filters_date(&self) -> bool {
        self.modified_from.is_some() || self.modified_to.is_some()
    }

    #[must_use]
    pub fn is_active(&self) -> bool {
        !self.text.trim().is_empty() || self.kind.is_some() || self.filters_size() || self.filters_date()
    }
}

/// Ein Eintrag eines Fensters, in Anzeigereihenfolge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowEntry {
    pub key: String,
    pub is_prefix: bool,
    pub size: u64,
    pub last_modified_ms: Option<i64>,
    pub etag: Option<String>,
    pub storage_class: Option<String>,
}

/// Umfang einer Sicht: Treffer, davon Ordner, Bytes der Treffer und alle Einträge des Listings.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowStats {
    pub count: u64,
    pub folders: u64,
    pub bytes: u64,
    pub total: u64,
}

/// Eine geöffnete Sicht mit ihrem Umfang.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewInfo {
    pub view_id: ViewId,
    pub stats: WindowStats,
}

/// Verweis auf das Listing, aus dem die Oberfläche Fenster lädt; `loaded` zählt die bisher
/// gelisteten Einträge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowRef {
    pub listing_id: ListingId,
    pub loaded: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_entries_like_the_user_interface() {
        let cases = [
            ("ordner/", true, None, EntryKind::Folder),
            ("keys.tar.zst.gpg", false, None, EntryKind::Lock),
            ("geheim.AGE", false, None, EntryKind::Lock),
            ("alt.bin", false, Some("DEEP_ARCHIVE"), EntryKind::Lock),
            ("db.tar.zst", false, Some("STANDARD"), EntryKind::Archive),
            ("Fotos.ZIP", false, None, EntryKind::Archive),
            ("restore.log", false, None, EntryKind::Text),
            ("checksums.sha256", false, None, EntryKind::Text),
            ("bild.jpg", false, None, EntryKind::File),
            ("liesmich", false, None, EntryKind::File),
            ("punkt.", false, None, EntryKind::File),
        ];
        for (name, is_prefix, class, kind) in cases {
            assert_eq!(kind_of(name, is_prefix, class), kind, "{name}");
        }
    }

    #[test]
    fn matches_names_with_wildcards_ignoring_case() {
        assert!(name_matches("db-full-20261011.tar.zst", "FULL"));
        assert!(name_matches("db-full-20261011.tar.zst", "db*2026*zst"));
        assert!(name_matches("Übersicht.pdf", "über"));
        assert!(name_matches("egal", "  "));
        assert!(!name_matches("db-full.tar", "zst*db"));
        assert!(!name_matches("abc", "abcd"));
    }

    #[test]
    fn sort_keys_order_names_naturally() {
        let mut names = vec![
            "datei10.txt",
            "Datei2.txt",
            "datei1.txt",
            "Äpfel",
            "apfel2",
            "zebra",
            "datei-x",
            "datei.txt",
        ];
        names.sort_by_key(|name| natural_key(name));
        assert_eq!(
            names,
            [
                "Äpfel",
                "apfel2",
                "datei-x",
                "datei.txt",
                "datei1.txt",
                "Datei2.txt",
                "datei10.txt",
                "zebra"
            ]
        );
        assert_eq!(natural_key("a"), natural_key("A"));
        assert_eq!(natural_key("v02"), natural_key("v2"));
        assert_eq!(natural_key("n0"), natural_key("n000"));
        assert!(natural_key("a") < natural_key("ab"));
        assert!(natural_key("x99999999999999999999") < natural_key("x100000000000000000000"));
    }

    #[test]
    fn knows_which_filters_are_active() {
        assert!(!WindowFilter::default().is_active());
        assert!(
            !WindowFilter {
                text: "  ".into(),
                ..WindowFilter::default()
            }
            .is_active()
        );
        let size = WindowFilter {
            min_size: Some(0),
            ..WindowFilter::default()
        };
        assert!(size.filters_size() && size.is_active() && !size.filters_date());
        let date = WindowFilter {
            modified_to: Some(5),
            ..WindowFilter::default()
        };
        assert!(date.filters_date() && date.is_active());
        let kind = WindowFilter {
            kind: Some(EntryKind::Text),
            ..WindowFilter::default()
        };
        assert!(kind.is_active());
    }

    #[test]
    fn reads_sort_and_filter_from_the_user_interface() {
        let sort: WindowSort = serde_json::from_str(r#"{"column":"storageClass","dir":-1}"#).unwrap();
        assert_eq!(sort.column, SortColumn::StorageClass);
        assert!(sort.descending());
        let filter: WindowFilter = serde_json::from_str(
            r#"{"text":"db","kind":"archive","minSize":1,"maxSize":null,"modifiedFrom":null,"modifiedTo":9}"#,
        )
        .unwrap();
        assert_eq!(filter.kind, Some(EntryKind::Archive));
        assert_eq!(
            (filter.min_size, filter.max_size, filter.modified_to),
            (Some(1), None, Some(9))
        );
    }
}
