//! Erzeugt HTTP-Object-Stores aus Verbindungsprofilen.

use super::client::{HttpObjectStore, HttpOptions, S3Config};
use crate::domain::credentials::Credentials;
use crate::domain::error::StoreError;
use crate::domain::profile::ConnectionProfile;
use crate::ports::{Clock, StoreFactory};
use std::time::Duration;

#[derive(Debug, Clone, Default)]
pub struct HttpStoreFactory<C> {
    clock: C,
}

impl<C> HttpStoreFactory<C> {
    pub fn new(clock: C) -> Self {
        Self { clock }
    }
}

/// Liest die Transport-Einstellungen eines Profils, inklusive CA-Datei.
///
/// # Errors
///
/// `InvalidConfig`, wenn die CA-Datei nicht gelesen werden kann.
pub fn http_options(profile: &ConnectionProfile) -> Result<HttpOptions, StoreError> {
    let ca_certificate_pem = profile
        .ca_path()
        .map(|path| std::fs::read(path).map_err(|e| StoreError::InvalidConfig(format!("CA-Datei {path}: {e}"))))
        .transpose()?;
    Ok(HttpOptions {
        timeout: Duration::from_secs(u64::from(profile.timeout_secs)),
        verify_tls: profile.verify_tls,
        proxy: profile.proxy_url().map(str::to_owned),
        ca_certificate_pem,
    })
}

impl<C: Clock + Clone + 'static> StoreFactory for HttpStoreFactory<C> {
    type Store = HttpObjectStore<C>;

    fn create(&self, profile: &ConnectionProfile, credentials: Credentials) -> Result<Self::Store, StoreError> {
        let config = S3Config {
            endpoint: profile.validate()?,
            credentials,
            quirks: profile.quirks,
            http: http_options(profile)?,
        };
        HttpObjectStore::new(config, self.clock.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::clock::SystemClock;
    use crate::domain::profile::fixtures::hetzner;

    fn credentials() -> Credentials {
        Credentials::new("a", "b", None).unwrap()
    }

    #[test]
    fn maps_profile_settings_to_http_options() {
        let profile = ConnectionProfile {
            timeout_secs: 30,
            verify_tls: false,
            proxy: Some(" http://proxy.intern:3128 ".into()),
            ..hetzner()
        };
        let options = http_options(&profile).unwrap();
        assert_eq!(options.timeout, Duration::from_secs(30));
        assert!(!options.verify_tls);
        assert_eq!(options.proxy.as_deref(), Some("http://proxy.intern:3128"));
        assert_eq!(options.ca_certificate_pem, None);
    }

    #[test]
    fn creates_stores_for_valid_profiles() {
        let factory = HttpStoreFactory::new(SystemClock);
        assert!(factory.create(&hetzner(), credentials()).is_ok());
    }

    #[test]
    fn rejects_invalid_profiles_proxies_and_ca_files() {
        let factory = HttpStoreFactory::new(SystemClock);
        let cases = [
            ConnectionProfile {
                endpoint: "ftp://x".into(),
                ..hetzner()
            },
            ConnectionProfile {
                proxy: Some("kein proxy".into()),
                ..hetzner()
            },
            ConnectionProfile {
                ca_file: Some("C:\\gibt\\es\\nicht.pem".into()),
                ..hetzner()
            },
        ];
        for profile in cases {
            assert!(
                matches!(
                    factory.create(&profile, credentials()),
                    Err(StoreError::InvalidConfig(_))
                ),
                "{profile:?}"
            );
        }
    }

    #[test]
    fn rejects_files_that_are_no_certificates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("kaputt.pem");
        std::fs::write(
            &path,
            "-----BEGIN CERTIFICATE-----\nkaputt\n-----END CERTIFICATE-----\n",
        )
        .unwrap();
        let profile = ConnectionProfile {
            ca_file: Some(path.display().to_string()),
            ..hetzner()
        };
        let options = http_options(&profile).unwrap();
        assert!(options.ca_certificate_pem.is_some());
        let result = HttpStoreFactory::new(SystemClock).create(&profile, credentials());
        assert!(matches!(result, Err(StoreError::InvalidConfig(_))));
    }
}
