//! Zugangsdaten im Windows-Anmeldeinformationsspeicher (Credential Manager).
//! Je Profil ein Eintrag; Access Key, Secret und Session-Token liegen als JSON im Secret.

use crate::domain::credentials::Credentials;
use crate::domain::error::CredentialError;
use crate::ports::CredentialStore;
use keyring_core::api::CredentialStoreApi;
use std::sync::Arc;

/// Dienstname der Einträge, sichtbar in der Windows-Anmeldeinformationsverwaltung. Bleibt seit der
/// Umbenennung in „S3 Commander“ unverändert, damit gespeicherte Zugangsdaten gefunden werden.
pub const DEFAULT_SERVICE: &str = "S3 Client";

pub struct KeyringCredentialStore {
    store: Arc<dyn CredentialStoreApi + Send + Sync>,
    service: String,
}

impl std::fmt::Debug for KeyringCredentialStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeyringCredentialStore")
            .field("service", &self.service)
            .finish_non_exhaustive()
    }
}

impl KeyringCredentialStore {
    /// Speicher des Betriebssystems.
    ///
    /// # Errors
    ///
    /// `Platform`, wenn der Anmeldeinformationsspeicher nicht verfügbar ist.
    pub fn native(service: &str) -> Result<Self, CredentialError> {
        let store = windows_native_keyring_store::Store::new().map_err(platform)?;
        Ok(Self::with_store(store, service))
    }

    #[must_use]
    pub fn with_store(store: Arc<dyn CredentialStoreApi + Send + Sync>, service: &str) -> Self {
        Self {
            store,
            service: service.to_owned(),
        }
    }

    fn entry(&self, profile_id: &str) -> Result<keyring_core::Entry, CredentialError> {
        self.store.build(&self.service, profile_id, None).map_err(platform)
    }
}

#[allow(clippy::needless_pass_by_value)] // Signatur passt zu map_err.
fn platform(error: keyring_core::Error) -> CredentialError {
    CredentialError::Platform(error.to_string())
}

impl CredentialStore for KeyringCredentialStore {
    fn load(&self, profile_id: &str) -> Result<Option<Credentials>, CredentialError> {
        match self.entry(profile_id)?.get_password() {
            Ok(secret) => serde_json::from_str(&secret)
                .map(Some)
                .map_err(|e| CredentialError::Corrupt(e.to_string())),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(other) => Err(platform(other)),
        }
    }

    fn save(&self, profile_id: &str, credentials: &Credentials) -> Result<(), CredentialError> {
        let secret = serde_json::to_string(credentials).map_err(|e| CredentialError::Corrupt(e.to_string()))?;
        self.entry(profile_id)?.set_password(&secret).map_err(platform)
    }

    fn delete(&self, profile_id: &str) -> Result<(), CredentialError> {
        match self.entry(profile_id)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(other) => Err(platform(other)),
        }
    }
}

/// Tests am echten Windows-Speicher laufen nacheinander: parallel liefert der Speicher
/// gelegentlich direkt nach dem Schreiben "kein Eintrag" (beobachtet am 11.10.2026).
#[cfg(test)]
pub(crate) static WINDOWS_STORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
pub(crate) fn lock_windows_store() -> std::sync::MutexGuard<'static, ()> {
    WINDOWS_STORE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Eigener Dienstname je Testlauf, damit echte Profile nie berührt werden.
    fn test_service() -> String {
        format!("S3 Client Test {}", std::process::id())
    }

    #[test]
    fn round_trips_credentials_in_the_windows_credential_manager() {
        let _guard = lock_windows_store();
        let store = KeyringCredentialStore::native(&test_service()).unwrap();
        let id = "profil-roundtrip";
        let credentials = Credentials::new("HZK7Q2M4XW9PL3RT8VN1", "w8Kq2LmZr4Tn9Xb1", Some("tok")).unwrap();

        assert_eq!(store.load(id).unwrap(), None);
        store.save(id, &credentials).unwrap();
        assert_eq!(store.load(id).unwrap(), Some(credentials));
        store.delete(id).unwrap();
        assert_eq!(store.load(id).unwrap(), None);
        store.delete(id).unwrap();
    }

    #[test]
    fn reports_corrupt_entries() {
        let _guard = lock_windows_store();
        let store = KeyringCredentialStore::native(&test_service()).unwrap();
        let id = "profil-kaputt";
        store.entry(id).unwrap().set_password("kein json").unwrap();
        let loaded = store.load(id);
        assert!(matches!(loaded, Err(CredentialError::Corrupt(_))), "{loaded:?}");
        store.delete(id).unwrap();
    }

    #[test]
    fn debug_output_names_only_the_service() {
        let _guard = lock_windows_store();
        let store = KeyringCredentialStore::native("Dienst").unwrap();
        assert!(format!("{store:?}").contains("Dienst"));
    }
}
