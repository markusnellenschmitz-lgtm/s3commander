//! Anwendungsfall: Einstellungen laden, prüfen und speichern.
//! Eine unlesbare Datei führt zu Standardwerten statt zu einem Startfehler.

use super::error::AppError;
use crate::domain::settings::AppSettings;
use crate::ports::SettingsRepository;
use std::sync::{Mutex, PoisonError};

#[derive(Debug)]
pub struct SettingsService<R> {
    repo: R,
    current: Mutex<AppSettings>,
}

impl<R: SettingsRepository> SettingsService<R> {
    pub fn new(repo: R) -> Self {
        let current = repo.load().unwrap_or_else(|error| {
            log::warn!("Einstellungen nicht lesbar, Standardwerte gelten: {error}");
            AppSettings::default()
        });
        Self {
            repo,
            current: Mutex::new(current),
        }
    }

    #[must_use]
    pub fn current(&self) -> AppSettings {
        *self.current.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Prüft, speichert und übernimmt die Einstellungen.
    ///
    /// # Errors
    /// `InvalidSettings` bei Werten außerhalb der Grenzen, `Repository` bei Schreibfehlern.
    pub fn save(&self, settings: AppSettings) -> Result<AppSettings, AppError> {
        settings.validate()?;
        self.repo.save(&settings)?;
        *self.current.lock().unwrap_or_else(PoisonError::into_inner) = settings;
        Ok(settings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::error::RepositoryError;
    use crate::domain::settings::SettingsError;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[derive(Default)]
    struct FakeRepo {
        stored: Mutex<Option<AppSettings>>,
        broken: AtomicBool,
    }

    impl SettingsRepository for FakeRepo {
        fn load(&self) -> Result<AppSettings, RepositoryError> {
            if self.broken.load(Ordering::Relaxed) {
                return Err(RepositoryError::Corrupt("kaputt".into()));
            }
            Ok(self.stored.lock().unwrap().unwrap_or_default())
        }

        fn save(&self, settings: &AppSettings) -> Result<(), RepositoryError> {
            if self.broken.load(Ordering::Relaxed) {
                return Err(RepositoryError::Io("voll".into()));
            }
            *self.stored.lock().unwrap() = Some(*settings);
            Ok(())
        }
    }

    #[test]
    fn loads_saves_and_validates() {
        let service = SettingsService::new(FakeRepo::default());
        assert_eq!(service.current(), AppSettings::default());
        let mut settings = AppSettings::default();
        settings.transfers.max_transfers = 2;
        assert_eq!(service.save(settings).unwrap(), settings);
        assert_eq!(service.current().transfers.max_transfers, 2);
        settings.transfers.max_transfers = 0;
        assert!(matches!(
            service.save(settings),
            Err(AppError::InvalidSettings(SettingsError::OutOfRange { .. }))
        ));
        assert_eq!(service.current().transfers.max_transfers, 2);
    }

    #[test]
    fn falls_back_to_defaults_and_reports_write_errors() {
        let repo = FakeRepo::default();
        repo.broken.store(true, Ordering::Relaxed);
        let service = SettingsService::new(repo);
        assert_eq!(service.current(), AppSettings::default());
        assert!(matches!(
            service.save(AppSettings::default()),
            Err(AppError::Repository(RepositoryError::Io(_)))
        ));
    }
}
