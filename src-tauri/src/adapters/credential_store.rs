//! Zugangsdaten im Speicher des Systems: unter Windows der Anmeldeinformationsspeicher
//! (Credential Manager), unter Linux der Schlüsselbund über Secret Service (GNOME Keyring, `KWallet`).
//! Je Profil ein Eintrag; Access Key, Secret und Session-Token liegen als JSON im Secret.

use crate::domain::credentials::Credentials;
use crate::domain::error::CredentialError;
use crate::ports::CredentialStore;
use keyring_core::api::CredentialStoreApi;
use std::sync::Arc;

/// Dienstname der Einträge, sichtbar in der Windows-Anmeldeinformationsverwaltung. Bleibt seit der
/// Umbenennung in „S3 Commander“ unverändert, damit gespeicherte Zugangsdaten gefunden werden.
pub const DEFAULT_SERVICE: &str = "S3 Client";

type SharedStore = Arc<dyn CredentialStoreApi + Send + Sync>;

pub struct KeyringCredentialStore {
    /// Der Speicher oder der Grund, warum er beim Start nicht erreichbar war.
    store: Result<SharedStore, CredentialError>,
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
    /// Speicher des Betriebssystems. Ist er nicht erreichbar, startet die App trotzdem; jeder
    /// Zugriff meldet dann `Unavailable`.
    #[must_use]
    pub fn native(service: &str) -> Self {
        let store = native_store().map_err(|error| CredentialError::Unavailable(error.to_string()));
        if let Err(error) = &store {
            log::warn!("{error}");
        }
        Self::from_result(store, service)
    }

    #[must_use]
    pub fn with_store(store: SharedStore, service: &str) -> Self {
        Self::from_result(Ok(store), service)
    }

    fn from_result(store: Result<SharedStore, CredentialError>, service: &str) -> Self {
        Self {
            store,
            service: service.to_owned(),
        }
    }

    fn entry(&self, profile_id: &str) -> Result<keyring_core::Entry, CredentialError> {
        let store = self.store.as_ref().map_err(Clone::clone)?;
        store.build(&self.service, profile_id, None).map_err(platform)
    }
}

#[cfg(windows)]
fn native_store() -> keyring_core::Result<SharedStore> {
    Ok(windows_native_keyring_store::Store::new()?)
}

#[cfg(target_os = "linux")]
fn native_store() -> keyring_core::Result<SharedStore> {
    Ok(zbus_secret_service_keyring_store::Store::new()?)
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

/// Tests am echten Speicher laufen nacheinander: Windows liefert parallel gelegentlich direkt
/// nach dem Schreiben "kein Eintrag" (beobachtet am 11.10.2026).
#[cfg(test)]
pub(crate) static NATIVE_STORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
pub(crate) fn lock_native_store() -> std::sync::MutexGuard<'static, ()> {
    NATIVE_STORE_LOCK
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
    fn round_trips_credentials_in_the_native_store() {
        let _guard = lock_native_store();
        let store = KeyringCredentialStore::native(&test_service());
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
        let _guard = lock_native_store();
        let store = KeyringCredentialStore::native(&test_service());
        let id = "profil-kaputt";
        store.entry(id).unwrap().set_password("kein json").unwrap();
        let loaded = store.load(id);
        assert!(matches!(loaded, Err(CredentialError::Corrupt(_))), "{loaded:?}");
        store.delete(id).unwrap();
    }

    #[test]
    fn debug_output_names_only_the_service() {
        let _guard = lock_native_store();
        let store = KeyringCredentialStore::native("Dienst");
        assert!(format!("{store:?}").contains("Dienst"));
    }

    #[test]
    fn reports_an_unreachable_store_on_every_access() {
        let reason = CredentialError::Unavailable("kein D-Bus".into());
        let store = KeyringCredentialStore::from_result(Err(reason.clone()), "Dienst");
        let credentials = Credentials::new("HZK7Q2M4XW9PL3RT8VN1", "w8Kq2LmZr4Tn9Xb1", None).unwrap();
        assert_eq!(store.load("p"), Err(reason.clone()));
        assert_eq!(store.save("p", &credentials), Err(reason.clone()));
        assert_eq!(store.delete("p"), Err(reason));
    }
}
