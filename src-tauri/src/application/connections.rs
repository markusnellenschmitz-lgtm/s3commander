//! Anwendungsdienst für Verbindungen: Profile verwalten, Verbindungen testen, Buckets listen.
//! Hält je Profil einen Object Store, damit HTTP-Verbindungen wiederverwendet werden.

use super::connection::{ConnectionTest, test_connection};
use super::error::AppError;
use crate::domain::credentials::Credentials;
use crate::domain::object::BucketInfo;
use crate::domain::profile::ConnectionProfile;
use crate::ports::{Clock, CredentialStore, ObjectStore, ProfileRepository, StoreFactory, StoreProvider};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

pub struct ConnectionService<R, K, F: StoreFactory, C> {
    profiles: R,
    credentials: K,
    factory: F,
    clock: C,
    stores: Mutex<HashMap<String, Arc<F::Store>>>,
}

impl<R, K, F: StoreFactory, C> std::fmt::Debug for ConnectionService<R, K, F, C> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectionService").finish_non_exhaustive()
    }
}

/// Ein vergiftetes Mutex betrifft nur Caches; deren Inhalt bleibt brauchbar.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl<R, K, F, C> ConnectionService<R, K, F, C>
where
    R: ProfileRepository,
    K: CredentialStore,
    F: StoreFactory,
    C: Clock,
{
    pub fn new(profiles: R, credentials: K, factory: F, clock: C) -> Self {
        Self {
            profiles,
            credentials,
            factory,
            clock,
            stores: Mutex::default(),
        }
    }

    /// Alle Profile, nach Name sortiert.
    ///
    /// # Errors
    /// Fehler der Profilablage.
    pub fn list_profiles(&self) -> Result<Vec<ConnectionProfile>, AppError> {
        let mut profiles = self.profiles.list()?;
        profiles.sort_by_key(|p| p.name.to_lowercase());
        Ok(profiles)
    }

    /// Speichert ein Profil. Ohne neue Zugangsdaten bleiben die gespeicherten erhalten;
    /// ein neues Profil braucht Zugangsdaten.
    ///
    /// # Errors
    /// Ungültiges Profil, fehlende Zugangsdaten oder Fehler der Ablagen.
    pub fn save_profile(&self, profile: &ConnectionProfile, credentials: Option<&Credentials>) -> Result<(), AppError> {
        profile.validate()?;
        match credentials {
            Some(credentials) => self.credentials.save(&profile.id, credentials)?,
            None if self.credentials.load(&profile.id)?.is_none() => return Err(AppError::MissingCredentials),
            None => {}
        }
        self.profiles.save(profile)?;
        self.forget_store(&profile.id);
        Ok(())
    }

    /// Löscht Profil und Zugangsdaten.
    ///
    /// # Errors
    /// Fehler der Ablagen.
    pub fn delete_profile(&self, id: &str) -> Result<(), AppError> {
        self.profiles.delete(id)?;
        self.credentials.delete(id)?;
        self.forget_store(id);
        Ok(())
    }

    /// Testet ein Profil, auch ein noch nicht gespeichertes. Ohne Zugangsdaten werden die
    /// gespeicherten verwendet.
    ///
    /// # Errors
    /// Ungültiges Profil, fehlende Zugangsdaten oder Fehler des Object Stores.
    pub async fn test_connection(
        &self,
        profile: &ConnectionProfile,
        credentials: Option<Credentials>,
    ) -> Result<ConnectionTest, AppError> {
        profile.validate()?;
        let credentials = match credentials {
            Some(credentials) => credentials,
            None => self.stored_credentials(&profile.id)?,
        };
        let store = self.factory.create(profile, credentials)?;
        Ok(test_connection(&store, &self.clock, profile.bucket()).await?)
    }

    /// Buckets eines Profils. Ist ein Standard-Bucket gesetzt, wird nur dieser geliefert,
    /// weil auf einen Bucket beschränkte Schlüssel `ListBuckets` oft nicht dürfen.
    ///
    /// # Errors
    /// Unbekanntes Profil, fehlende Zugangsdaten oder Fehler des Object Stores.
    pub async fn list_buckets(&self, profile_id: &str) -> Result<Vec<BucketInfo>, AppError> {
        let profile = self.profile(profile_id)?;
        if let Some(bucket) = profile.bucket() {
            return Ok(vec![BucketInfo {
                name: bucket.to_owned(),
                created_ms: None,
            }]);
        }
        let store = self.store(&profile)?;
        Ok(store.list_buckets().await?)
    }

    fn profile(&self, id: &str) -> Result<ConnectionProfile, AppError> {
        self.profiles
            .list()?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| AppError::ProfileNotFound(id.to_owned()))
    }

    fn stored_credentials(&self, profile_id: &str) -> Result<Credentials, AppError> {
        self.credentials.load(profile_id)?.ok_or(AppError::MissingCredentials)
    }

    fn store(&self, profile: &ConnectionProfile) -> Result<Arc<F::Store>, AppError> {
        if let Some(store) = lock(&self.stores).get(&profile.id) {
            return Ok(Arc::clone(store));
        }
        let store = Arc::new(self.factory.create(profile, self.stored_credentials(&profile.id)?)?);
        lock(&self.stores).insert(profile.id.clone(), Arc::clone(&store));
        Ok(store)
    }

    fn forget_store(&self, profile_id: &str) {
        lock(&self.stores).remove(profile_id);
    }
}

/// Transfers holen sich den Object Store über die Profil-ID und teilen den Cache.
impl<R, K, F, C> StoreProvider for ConnectionService<R, K, F, C>
where
    R: ProfileRepository,
    K: CredentialStore,
    F: StoreFactory,
    C: Clock,
{
    type Store = F::Store;

    fn store_for(&self, profile_id: &str) -> Result<Arc<F::Store>, AppError> {
        self.store(&self.profile(profile_id)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::test_support::{FakeClock, FakeCredentials, FakeFactory, FakeProfiles, FakeStore};
    use crate::domain::error::StoreError;
    use crate::domain::profile::fixtures::hetzner;
    use std::time::Duration;

    type Service = ConnectionService<FakeProfiles, FakeCredentials, FakeFactory, FakeClock>;

    fn credentials() -> Credentials {
        Credentials::new("AKID", "secret", None).unwrap()
    }

    fn service(make_store: fn() -> FakeStore) -> Service {
        ConnectionService::new(
            FakeProfiles::default(),
            FakeCredentials::default(),
            FakeFactory::new(make_store),
            FakeClock::stepping(Duration::from_millis(10)),
        )
    }

    fn without_bucket() -> ConnectionProfile {
        ConnectionProfile {
            default_bucket: None,
            ..hetzner()
        }
    }

    fn saved(make_store: fn() -> FakeStore, profile: &ConnectionProfile) -> Service {
        let s = service(make_store);
        s.save_profile(profile, Some(&credentials())).unwrap();
        s
    }

    #[test]
    fn saves_lists_and_deletes_profiles_with_credentials() {
        let s = service(FakeStore::default);
        let mut second = hetzner();
        second.id = "b".into();
        second.name = "AWS Produktion".into();
        s.save_profile(&hetzner(), Some(&credentials())).unwrap();
        s.save_profile(&second, Some(&credentials())).unwrap();

        let names: Vec<_> = s.list_profiles().unwrap().into_iter().map(|p| p.name).collect();
        assert_eq!(names, ["AWS Produktion", "Hetzner Produktion"]);
        assert_eq!(s.credentials.load("hetzner-fsn1").unwrap(), Some(credentials()));

        s.delete_profile("hetzner-fsn1").unwrap();
        assert_eq!(s.list_profiles().unwrap().len(), 1);
        assert_eq!(s.credentials.load("hetzner-fsn1").unwrap(), None);
    }

    #[test]
    fn keeps_stored_credentials_when_editing_and_requires_them_for_new_profiles() {
        let s = service(FakeStore::default);
        assert_eq!(s.save_profile(&hetzner(), None), Err(AppError::MissingCredentials));
        s.save_profile(&hetzner(), Some(&credentials())).unwrap();
        let renamed = ConnectionProfile {
            name: "Umbenannt".into(),
            ..hetzner()
        };
        s.save_profile(&renamed, None).unwrap();
        assert_eq!(s.list_profiles().unwrap()[0].name, "Umbenannt");
    }

    #[test]
    fn rejects_invalid_profiles_before_storing_anything() {
        let s = service(FakeStore::default);
        let invalid = ConnectionProfile {
            endpoint: "ftp://x".into(),
            ..hetzner()
        };
        assert!(matches!(
            s.save_profile(&invalid, Some(&credentials())),
            Err(AppError::Store(StoreError::InvalidConfig(_)))
        ));
        assert_eq!(s.list_profiles().unwrap(), Vec::new());
        assert_eq!(s.credentials.load("hetzner-fsn1").unwrap(), None);
    }

    #[tokio::test]
    async fn tests_unsaved_profiles_with_given_credentials() {
        let s = service(|| FakeStore::with_buckets(&["a", "b"]));
        let result = s.test_connection(&without_bucket(), Some(credentials())).await.unwrap();
        assert_eq!(result.bucket_count, Some(2));
        assert_eq!(result.latency_ms, 10);
    }

    #[tokio::test]
    async fn tests_saved_profiles_with_stored_credentials() {
        let s = saved(|| FakeStore::with_buckets(&["a"]), &without_bucket());
        assert_eq!(
            s.test_connection(&without_bucket(), None).await.unwrap().bucket_count,
            Some(1)
        );
        let unknown = ConnectionProfile {
            id: "neu".into(),
            ..without_bucket()
        };
        assert_eq!(
            s.test_connection(&unknown, None).await,
            Err(AppError::MissingCredentials)
        );
    }

    #[tokio::test]
    async fn lists_buckets_or_returns_the_default_bucket() {
        let s = saved(|| FakeStore::with_buckets(&["x", "y"]), &without_bucket());
        let names: Vec<_> = s
            .list_buckets("hetzner-fsn1")
            .await
            .unwrap()
            .into_iter()
            .map(|b| b.name)
            .collect();
        assert_eq!(names, ["x", "y"]);

        let s = saved(|| FakeStore::failing(StoreError::Timeout), &hetzner());
        let names: Vec<_> = s
            .list_buckets("hetzner-fsn1")
            .await
            .unwrap()
            .into_iter()
            .map(|b| b.name)
            .collect();
        assert_eq!(names, ["gtg-mods"]);
        assert_eq!(s.factory.created(), 0);
    }

    #[tokio::test]
    async fn reports_unknown_profiles() {
        let s = service(FakeStore::default);
        assert_eq!(
            s.list_buckets("weg").await,
            Err(AppError::ProfileNotFound("weg".into()))
        );
    }

    #[tokio::test]
    async fn reuses_the_store_until_the_profile_changes() {
        let s = saved(|| FakeStore::with_buckets(&["a"]), &without_bucket());
        s.list_buckets("hetzner-fsn1").await.unwrap();
        s.list_buckets("hetzner-fsn1").await.unwrap();
        assert_eq!(s.factory.created(), 1);
        s.save_profile(&without_bucket(), None).unwrap();
        s.list_buckets("hetzner-fsn1").await.unwrap();
        assert_eq!(s.factory.created(), 2);
    }

    #[test]
    fn provides_cached_stores_for_transfers() {
        let s = saved(FakeStore::default, &without_bucket());
        let first = s.store_for("hetzner-fsn1").unwrap();
        let second = s.store_for("hetzner-fsn1").unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(s.store_for("weg").unwrap_err(), AppError::ProfileNotFound("weg".into()));
    }

    #[test]
    fn debug_output_hides_internals() {
        assert_eq!(format!("{:?}", service(FakeStore::default)), "ConnectionService { .. }");
    }
}
