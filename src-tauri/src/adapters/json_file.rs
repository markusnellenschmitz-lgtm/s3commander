//! JSON-Dateien im App-Konfigurationsordner (Profile, Einstellungen).
//! Geschrieben wird atomar über eine temporäre Datei, damit ein Absturz beim Speichern
//! nie eine halbe Datei hinterlässt.

use crate::domain::error::RepositoryError;
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;

fn io_error(error: &std::io::Error) -> RepositoryError {
    RepositoryError::Io(error.to_string())
}

/// Liest die Datei; fehlt sie, gilt `T::default()`.
///
/// # Errors
/// `Io` bei Lesefehlern, `Corrupt` bei ungültigem JSON.
pub fn read_json<T: DeserializeOwned + Default>(path: &Path) -> Result<T, RepositoryError> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| RepositoryError::Corrupt(e.to_string())),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(io_error(&e)),
    }
}

/// Schreibt atomar; fehlende Ordner werden angelegt.
///
/// # Errors
/// `Io` bei Schreibfehlern.
pub fn write_json_atomically<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<(), RepositoryError> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| io_error(&e))?;
    }
    let json = serde_json::to_vec_pretty(value).map_err(|e| RepositoryError::Corrupt(e.to_string()))?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, json).map_err(|e| io_error(&e))?;
    fs::rename(&temp, path).map_err(|e| io_error(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_defaults_writes_atomically_and_reports_errors() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("neu").join("werte.json");
        assert_eq!(read_json::<Vec<u32>>(&path).unwrap(), Vec::<u32>::new());
        write_json_atomically(&path, &[1, 2]).unwrap();
        assert_eq!(read_json::<Vec<u32>>(&path).unwrap(), [1, 2]);
        let names: Vec<_> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["werte.json"]);
        fs::write(&path, "{kaputt").unwrap();
        assert!(matches!(read_json::<Vec<u32>>(&path), Err(RepositoryError::Corrupt(_))));
        assert!(matches!(read_json::<Vec<u32>>(dir.path()), Err(RepositoryError::Io(_))));
        assert!(matches!(
            write_json_atomically(&path.join("x.json"), &1),
            Err(RepositoryError::Io(_))
        ));
    }
}
