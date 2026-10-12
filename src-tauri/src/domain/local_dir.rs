//! Einträge eines lokalen Ordners für die linke Seite der Zwei-Panel-Ansicht (Screen 3).
//! Die oberste Ebene sind unter Windows die Laufwerke, unter Linux persönlicher Ordner,
//! Dateisystem und eingehängte Datenträger.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry {
    /// Anzeigename; bei Laufwerken „D:“, bei Einträgen der obersten Ebene unter Linux z. B. „Dateisystem“.
    pub name: String,
    /// Vollständiger Pfad, bei Laufwerken „D:\“.
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// Millisekunden seit Epoch
    pub modified_ms: Option<i64>,
}

/// Anzeigename des persönlichen Ordners unter Linux.
pub const HOME_LABEL: &str = "Persönlicher Ordner";
/// Anzeigename der Wurzel `/` unter Linux.
pub const FILE_SYSTEM_LABEL: &str = "Dateisystem";

impl LocalEntry {
    /// Ordner der obersten Ebene („Dieser PC“) mit eigenem Anzeigenamen.
    #[must_use]
    pub fn root(name: &str, path: &str) -> Self {
        Self {
            name: name.to_owned(),
            path: path.to_owned(),
            is_dir: true,
            size: 0,
            modified_ms: None,
        }
    }

    /// Laufwerk `letter` als Eintrag der obersten Ebene.
    #[must_use]
    pub fn drive(letter: char) -> Self {
        Self::root(&format!("{letter}:"), &format!("{letter}:\\"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describes_drives_with_their_root_path() {
        let drive = LocalEntry::drive('D');
        assert_eq!(
            (drive.name.as_str(), drive.path.as_str(), drive.is_dir),
            ("D:", "D:\\", true)
        );
        let json = serde_json::to_value(&drive).unwrap();
        assert_eq!(json["isDir"], true);
        assert_eq!(json["modifiedMs"], serde_json::Value::Null);
    }

    #[test]
    fn names_other_roots_freely() {
        let root = LocalEntry::root(FILE_SYSTEM_LABEL, "/");
        assert_eq!(
            (root.name.as_str(), root.path.as_str(), root.is_dir, root.size),
            ("Dateisystem", "/", true, 0)
        );
    }
}
