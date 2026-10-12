//! Namen von Ordnern und Objekten: Regeln für neue Namen und die daraus gebildeten Keys.

use serde::Serialize;

/// S3 erlaubt Keys bis 1.024 Bytes (UTF-8).
pub const MAX_KEY_BYTES: usize = 1024;

/// Warum ein Name nicht verwendet werden kann. Texte erscheinen direkt im Dialog.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NameError {
    #[error("Bitte einen Namen eingeben")]
    Empty,
    #[error("Der Name darf keinen Schrägstrich enthalten")]
    Slash,
    #[error("„.“ und „..“ sind als Name nicht erlaubt")]
    DotSegment,
    #[error("Der Name darf keine Steuerzeichen enthalten")]
    Control,
    #[error("Der vollständige Key darf höchstens 1.024 Bytes lang sein")]
    TooLong,
}

/// Fortschritt beim Umbenennen: kopierte Objekte von allen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameProgress {
    pub copied: u64,
    pub total: u64,
}

/// Ergebnis des Umbenennens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameOutcome {
    pub new_key: String,
    /// Originale, die nach dem Kopieren nicht gelöscht werden konnten.
    pub undeleted: u64,
}

/// Key für `name` im Ordner `prefix`; Ordner enden auf `/`.
///
/// # Errors
/// Leerer Name, Schrägstrich, `.`/`..`, Steuerzeichen oder ein Key über 1.024 Bytes.
pub fn child_key(prefix: &str, name: &str, is_folder: bool) -> Result<String, NameError> {
    if name.trim().is_empty() {
        return Err(NameError::Empty);
    }
    if name.contains('/') {
        return Err(NameError::Slash);
    }
    if name == "." || name == ".." {
        return Err(NameError::DotSegment);
    }
    if name.chars().any(char::is_control) {
        return Err(NameError::Control);
    }
    let key = format!("{prefix}{name}{}", if is_folder { "/" } else { "" });
    if key.len() > MAX_KEY_BYTES {
        return Err(NameError::TooLong);
    }
    Ok(key)
}

/// Ordner, in dem ein Key liegt: `a/b/c.txt` → `a/b/`, `a/b/` → `a/`, `c.txt` → leer (Bucket-Wurzel).
#[must_use]
pub fn parent_prefix(key: &str) -> &str {
    let trimmed = key.strip_suffix('/').unwrap_or(key);
    trimmed.rfind('/').map_or("", |slash| &key[..=slash])
}

/// Letztes Segment eines Keys ohne abschließenden Schrägstrich: `a/b/` → `b`, `a/c.txt` → `c.txt`.
#[must_use]
pub fn base_name(key: &str) -> &str {
    let trimmed = key.strip_suffix('/').unwrap_or(key);
    trimmed.rsplit('/').next().unwrap_or(trimmed)
}

/// Freier Name bei Konflikten: `bild.jpg` → `bild (2).jpg`, `liesmich` → `liesmich (2)`.
/// Ein Punkt am Anfang (`.env`) gilt nicht als Endung.
#[must_use]
pub fn numbered_name(name: &str, number: u32) -> String {
    match name.rfind('.') {
        Some(dot) if dot > 0 => format!("{} ({number}){}", &name[..dot], &name[dot..]),
        _ => format!("{name} ({number})"),
    }
}

/// Neuer Key nach dem Umbenennen im selben Ordner; Ordner bleiben Ordner.
///
/// # Errors
/// Wie `child_key`.
pub fn renamed_key(key: &str, new_name: &str) -> Result<String, NameError> {
    child_key(parent_prefix(key), new_name, key.ends_with('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_keys_for_files_and_folders() {
        assert_eq!(child_key("a/", "neu", true).unwrap(), "a/neu/");
        assert_eq!(child_key("", "bericht 2026.pdf", false).unwrap(), "bericht 2026.pdf");
        assert_eq!(child_key("a/", "ümlaut", false).unwrap(), "a/ümlaut");
    }

    #[test]
    fn rejects_unusable_names() {
        assert_eq!(child_key("", "  ", true), Err(NameError::Empty));
        assert_eq!(child_key("", "a/b", true), Err(NameError::Slash));
        assert_eq!(child_key("", "..", true), Err(NameError::DotSegment));
        assert_eq!(child_key("", ".", false), Err(NameError::DotSegment));
        assert_eq!(child_key("", "tab\tname", false), Err(NameError::Control));
        assert_eq!(child_key("", &"x".repeat(1024), true), Err(NameError::TooLong));
        assert!(child_key("", &"x".repeat(1023), true).is_ok());
        assert_eq!(
            NameError::Slash.to_string(),
            "Der Name darf keinen Schrägstrich enthalten"
        );
    }

    #[test]
    fn finds_the_parent_folder() {
        assert_eq!(parent_prefix("a/b/c.txt"), "a/b/");
        assert_eq!(parent_prefix("a/b/"), "a/");
        assert_eq!(parent_prefix("a/"), "");
        assert_eq!(parent_prefix("c.txt"), "");
    }

    #[test]
    fn names_keys_and_numbers_conflicts() {
        assert_eq!(base_name("a/b/"), "b");
        assert_eq!(base_name("a/c.txt"), "c.txt");
        assert_eq!(base_name("c.txt"), "c.txt");
        assert_eq!(numbered_name("bild.jpg", 2), "bild (2).jpg");
        assert_eq!(numbered_name("liesmich", 3), "liesmich (3)");
        assert_eq!(numbered_name(".env", 2), ".env (2)");
        assert_eq!(numbered_name("a.tar.gz", 2), "a.tar (2).gz");
    }

    #[test]
    fn renames_within_the_same_folder() {
        assert_eq!(renamed_key("a/b/c.txt", "d.txt").unwrap(), "a/b/d.txt");
        assert_eq!(renamed_key("a/b/", "x").unwrap(), "a/x/");
        assert_eq!(renamed_key("c.txt", "/"), Err(NameError::Slash));
    }

    #[test]
    fn serializes_for_the_frontend() {
        let outcome = RenameOutcome {
            new_key: "a/x/".into(),
            undeleted: 0,
        };
        assert_eq!(
            serde_json::to_string(&outcome).unwrap(),
            r#"{"newKey":"a/x/","undeleted":0}"#
        );
        let progress = RenameProgress { copied: 1, total: 2 };
        assert_eq!(serde_json::to_string(&progress).unwrap(), r#"{"copied":1,"total":2}"#);
    }
}
