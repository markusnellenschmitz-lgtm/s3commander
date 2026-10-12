//! Verbindungsprofile als JSON-Datei im App-Konfigurationsordner (atomar geschrieben).

use super::json_file::{read_json, write_json_atomically};
use crate::domain::error::RepositoryError;
use crate::domain::profile::ConnectionProfile;
use crate::ports::ProfileRepository;
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

pub const PROFILE_FILE_NAME: &str = "profiles.json";

#[derive(Debug)]
pub struct JsonProfileRepository {
    path: PathBuf,
    /// Serialisiert Lesen-Ändern-Schreiben innerhalb des Prozesses.
    write_lock: Mutex<()>,
}

impl JsonProfileRepository {
    #[must_use]
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            write_lock: Mutex::new(()),
        }
    }

    fn update(&self, change: impl FnOnce(&mut Vec<ConnectionProfile>)) -> Result<(), RepositoryError> {
        let _guard = self.write_lock.lock().unwrap_or_else(PoisonError::into_inner);
        let mut profiles = self.list()?;
        change(&mut profiles);
        write_json_atomically(&self.path, &profiles)
    }
}

impl ProfileRepository for JsonProfileRepository {
    fn list(&self) -> Result<Vec<ConnectionProfile>, RepositoryError> {
        read_json(&self.path)
    }

    fn save(&self, profile: &ConnectionProfile) -> Result<(), RepositoryError> {
        self.update(|profiles| match profiles.iter_mut().find(|p| p.id == profile.id) {
            Some(existing) => *existing = profile.clone(),
            None => profiles.push(profile.clone()),
        })
    }

    fn delete(&self, id: &str) -> Result<(), RepositoryError> {
        self.update(|profiles| profiles.retain(|p| p.id != id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::profile::fixtures::hetzner;
    use std::fs;

    fn repo() -> (tempfile::TempDir, JsonProfileRepository) {
        let dir = tempfile::tempdir().unwrap();
        let repo = JsonProfileRepository::new(dir.path().join("sub").join(PROFILE_FILE_NAME));
        (dir, repo)
    }

    #[test]
    fn starts_empty_without_a_file() {
        let (_dir, repo) = repo();
        assert_eq!(repo.list().unwrap(), Vec::new());
    }

    #[test]
    fn saves_replaces_and_deletes_profiles() {
        let (_dir, repo) = repo();
        let mut second = hetzner();
        second.id = "zwei".into();
        repo.save(&hetzner()).unwrap();
        repo.save(&second).unwrap();
        let renamed = ConnectionProfile {
            name: "Neu".into(),
            ..hetzner()
        };
        repo.save(&renamed).unwrap();

        let profiles = repo.list().unwrap();
        assert_eq!(profiles.len(), 2);
        assert_eq!(profiles[0].name, "Neu", "Reihenfolge bleibt beim Ersetzen erhalten");

        repo.delete("zwei").unwrap();
        repo.delete("unbekannt").unwrap();
        assert_eq!(repo.list().unwrap(), vec![renamed]);
    }

    #[test]
    fn leaves_no_temporary_file_and_never_stores_secrets() {
        let (dir, repo) = repo();
        repo.save(&hetzner()).unwrap();
        let sub = dir.path().join("sub");
        let names: Vec<_> = fs::read_dir(&sub).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, [PROFILE_FILE_NAME]);
        let content = fs::read_to_string(sub.join(PROFILE_FILE_NAME)).unwrap();
        assert!(!content.to_lowercase().contains("secret"));
    }

    #[test]
    fn reports_corrupt_files() {
        let (dir, repo) = repo();
        fs::create_dir_all(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub").join(PROFILE_FILE_NAME), "{kaputt").unwrap();
        assert!(matches!(repo.list(), Err(RepositoryError::Corrupt(_))));
        assert!(matches!(repo.save(&hetzner()), Err(RepositoryError::Corrupt(_))));
    }

    #[test]
    fn reports_io_errors() {
        let dir = tempfile::tempdir().unwrap();
        // Ein Verzeichnis an Stelle der Datei lässt Lesen und Schreiben scheitern.
        let path = dir.path().join(PROFILE_FILE_NAME);
        fs::create_dir(&path).unwrap();
        let repo = JsonProfileRepository::new(path);
        assert!(matches!(repo.list(), Err(RepositoryError::Io(_))));
    }
}
