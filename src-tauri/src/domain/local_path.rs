//! Lokale Pfade für Downloads: S3-Keys sicher in Windows-Pfade übersetzen.
//!
//! Keys dürfen Zeichen enthalten, die Windows in Dateinamen verbietet, und Segmente wie `..`.
//! Jedes Segment wird deshalb bereinigt, damit ein Download nie außerhalb des Zielordners landet.

use super::naming::numbered_name;
use std::path::{Path, PathBuf};

/// Endung der Teildatei, solange ein Download läuft.
pub const PARTIAL_SUFFIX: &str = ".s3part";

/// Ersatz für Zeichen und Namen, die Windows nicht erlaubt.
const REPLACEMENT: char = '_';
const INVALID_CHARS: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2",
    "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Pfad relativ zum Zielordner für `key` unterhalb von `base_prefix`.
/// `None` für Ordner-Platzhalter (Key endet auf `/`) und Keys ohne Namen.
#[must_use]
pub fn download_relative_path(base_prefix: &str, key: &str) -> Option<PathBuf> {
    let relative = key.strip_prefix(base_prefix).unwrap_or(key);
    if relative.ends_with('/') {
        return None;
    }
    let path: PathBuf = relative
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(sanitize_segment)
        .collect();
    (!path.as_os_str().is_empty()).then_some(path)
}

/// Ersetzt verbotene Zeichen, entfernt Punkte und Leerzeichen am Ende (damit auch `.` und `..`)
/// und entschärft reservierte Gerätenamen wie `CON` oder `nul.txt`.
fn sanitize_segment(segment: &str) -> String {
    let replaced: String = segment
        .chars()
        .map(|c| {
            if c.is_control() || INVALID_CHARS.contains(&c) {
                REPLACEMENT
            } else {
                c
            }
        })
        .collect();
    let trimmed = replaced.trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        return REPLACEMENT.to_string();
    }
    let stem = trimmed.split('.').next().unwrap_or(trimmed);
    if RESERVED_NAMES.iter().any(|name| name.eq_ignore_ascii_case(stem)) {
        format!("{REPLACEMENT}{trimmed}")
    } else {
        trimmed.to_owned()
    }
}

/// Teildatei neben dem Ziel: `bild.jpg` → `bild.jpg.s3part`.
#[must_use]
pub fn partial_path(target: &Path) -> PathBuf {
    let mut name = target.file_name().unwrap_or_default().to_os_string();
    name.push(PARTIAL_SUFFIX);
    target.with_file_name(name)
}

/// Freier Name bei Konflikten: `bild.jpg` → `bild (2).jpg`, `liesmich` → `liesmich (2)`.
#[must_use]
pub fn numbered_path(target: &Path, number: u32) -> PathBuf {
    let name = target.file_name().unwrap_or_default().to_string_lossy();
    target.with_file_name(numbered_name(&name, number))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn relative(base: &str, key: &str) -> Option<String> {
        download_relative_path(base, key).map(|p| p.to_string_lossy().into_owned())
    }

    #[test]
    fn keeps_folders_below_the_base_prefix() {
        assert_eq!(relative("backups/", "backups/a.bin").as_deref(), Some("a.bin"));
        assert_eq!(
            relative("backups/", "backups/daily/2026/db.tar").as_deref(),
            Some(r"daily\2026\db.tar")
        );
        assert_eq!(relative("", "x/y.txt").as_deref(), Some(r"x\y.txt"));
        assert_eq!(relative("anders/", "x.txt").as_deref(), Some("x.txt"));
    }

    #[test]
    fn skips_folder_markers_and_empty_names() {
        assert_eq!(relative("p/", "p/ordner/"), None);
        assert_eq!(relative("p/", "p/"), None);
        assert_eq!(relative("", "//"), None);
        assert_eq!(relative("", "a//b").as_deref(), Some(r"a\b"));
    }

    #[test]
    fn never_leaves_the_target_folder() {
        assert_eq!(
            relative("", "../../windows/system32/x.dll").as_deref(),
            Some(r"_\_\windows\system32\x.dll")
        );
        assert_eq!(relative("", "./a").as_deref(), Some(r"_\a"));
        assert_eq!(relative("", r"C:\boot.ini").as_deref(), Some("C__boot.ini"));
    }

    #[test]
    fn replaces_characters_windows_does_not_allow() {
        assert_eq!(relative("", r#"a<b>c:d"e|f?g*h"#).as_deref(), Some("a_b_c_d_e_f_g_h"));
        assert_eq!(relative("", "tab\there").as_deref(), Some("tab_here"));
        assert_eq!(relative("", "ende. ").as_deref(), Some("ende"));
        assert_eq!(
            relative("", "fotos 2026/bild.jpg").as_deref(),
            Some(r"fotos 2026\bild.jpg")
        );
    }

    #[test]
    fn defuses_reserved_device_names() {
        assert_eq!(relative("", "CON").as_deref(), Some("_CON"));
        assert_eq!(relative("", "logs/nul.txt").as_deref(), Some(r"logs\_nul.txt"));
        assert_eq!(relative("", "console.txt").as_deref(), Some("console.txt"));
    }

    #[test]
    fn names_partial_and_numbered_files() {
        let target = Path::new(r"D:\Exporte\bild.jpg");
        assert_eq!(partial_path(target), Path::new(r"D:\Exporte\bild.jpg.s3part"));
        assert_eq!(numbered_path(target, 2), Path::new(r"D:\Exporte\bild (2).jpg"));
        assert_eq!(
            numbered_path(Path::new(r"D:\liesmich"), 3),
            Path::new(r"D:\liesmich (3)")
        );
        assert_eq!(numbered_path(Path::new(r"D:\.env"), 2), Path::new(r"D:\.env (2)"));
        assert_eq!(
            numbered_path(Path::new(r"D:\a.tar.gz"), 2),
            Path::new(r"D:\a.tar (2).gz")
        );
    }
}
