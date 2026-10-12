//! Einstellungen als JSON-Datei im App-Konfigurationsordner (atomar geschrieben).

use super::json_file::{read_json, write_json_atomically};
use crate::domain::error::RepositoryError;
use crate::domain::settings::AppSettings;
use crate::ports::SettingsRepository;
use std::path::PathBuf;

pub const SETTINGS_FILE_NAME: &str = "settings.json";

#[derive(Debug)]
pub struct JsonSettingsRepository {
    path: PathBuf,
}

impl JsonSettingsRepository {
    #[must_use]
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl SettingsRepository for JsonSettingsRepository {
    fn load(&self) -> Result<AppSettings, RepositoryError> {
        read_json(&self.path)
    }

    fn save(&self, settings: &AppSettings) -> Result<(), RepositoryError> {
        write_json_atomically(&self.path, settings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_with_defaults_and_keeps_saved_settings() {
        let dir = tempfile::tempdir().unwrap();
        let repo = JsonSettingsRepository::new(dir.path().join(SETTINGS_FILE_NAME));
        assert_eq!(repo.load().unwrap(), AppSettings::default());
        let mut settings = AppSettings::default();
        settings.transfers.max_transfers = 3;
        repo.save(&settings).unwrap();
        assert_eq!(repo.load().unwrap(), settings);
    }
}
