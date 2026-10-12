//! Einträge eines lokalen Ordners für die linke Seite der Zwei-Panel-Ansicht (Screen 3).

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry {
    /// Anzeigename; bei Laufwerken „D:“.
    pub name: String,
    /// Vollständiger Pfad, bei Laufwerken „D:\“.
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// Millisekunden seit Epoch
    pub modified_ms: Option<i64>,
}

impl LocalEntry {
    /// Laufwerk `letter` als Eintrag der obersten Ebene („Dieser PC“).
    #[must_use]
    pub fn drive(letter: char) -> Self {
        Self {
            name: format!("{letter}:"),
            path: format!("{letter}:\\"),
            is_dir: true,
            size: 0,
            modified_ms: None,
        }
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
}
