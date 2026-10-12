//! Verbindungsprofil (UI-SPEC §7 `ConnectionProfile`). Zugangsdaten gehören nicht hierher,
//! sie liegen im Windows-Anmeldeinformationsspeicher unter der Profil-ID.

use super::endpoint::{Addressing, Endpoint};
use super::error::StoreError;
use super::provider::{Provider, Quirks};
use serde::{Deserialize, Serialize};
use std::ops::RangeInclusive;

pub const TIMEOUT_RANGE_SECS: RangeInclusive<u32> = 1..=600;
pub const CONCURRENCY_RANGE: RangeInclusive<u32> = 1..=64;
pub const DEFAULT_TIMEOUT_SECS: u32 = 60;
pub const DEFAULT_CONCURRENCY: u32 = 8;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub provider: Provider,
    pub endpoint: String,
    pub region: String,
    #[serde(default)]
    pub default_bucket: Option<String>,
    pub addressing: Addressing,
    pub quirks: Quirks,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u32,
    #[serde(default = "default_concurrency")]
    pub concurrency: u32,
    #[serde(default = "default_true")]
    pub verify_tls: bool,
    #[serde(default)]
    pub ca_file: Option<String>,
    #[serde(default)]
    pub proxy: Option<String>,
}

const fn default_timeout() -> u32 {
    DEFAULT_TIMEOUT_SECS
}

const fn default_concurrency() -> u32 {
    DEFAULT_CONCURRENCY
}

const fn default_true() -> bool {
    true
}

impl ConnectionProfile {
    /// Prüft das Profil und liefert den daraus gebildeten Endpunkt.
    ///
    /// # Errors
    ///
    /// `InvalidConfig` mit einer Meldung, die direkt im Formular angezeigt werden kann.
    pub fn validate(&self) -> Result<Endpoint, StoreError> {
        let invalid = |message: &str| Err(StoreError::InvalidConfig(message.to_owned()));
        if self.id.trim().is_empty() {
            return invalid("Profil-ID fehlt");
        }
        if self.name.trim().is_empty() {
            return invalid("Profilname ist Pflicht");
        }
        if !TIMEOUT_RANGE_SECS.contains(&self.timeout_secs) {
            return invalid("Timeout muss zwischen 1 und 600 Sekunden liegen");
        }
        if !CONCURRENCY_RANGE.contains(&self.concurrency) {
            return invalid("Parallelität muss zwischen 1 und 64 liegen");
        }
        Endpoint::new(&self.endpoint, &self.region, self.addressing)
    }

    /// Standard-Bucket ohne Leerzeichen; leer gilt als nicht gesetzt.
    #[must_use]
    pub fn bucket(&self) -> Option<&str> {
        self.default_bucket.as_deref().map(str::trim).filter(|b| !b.is_empty())
    }

    /// Proxy ohne Leerzeichen; leer gilt als nicht gesetzt.
    #[must_use]
    pub fn proxy_url(&self) -> Option<&str> {
        self.proxy.as_deref().map(str::trim).filter(|p| !p.is_empty())
    }

    /// CA-Datei ohne Leerzeichen; leer gilt als nicht gesetzt.
    #[must_use]
    pub fn ca_path(&self) -> Option<&str> {
        self.ca_file.as_deref().map(str::trim).filter(|p| !p.is_empty())
    }
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    /// Gültiges Hetzner-Profil aus dem Mockup des Verbindungsdialogs.
    pub fn hetzner() -> ConnectionProfile {
        ConnectionProfile {
            id: "hetzner-fsn1".into(),
            name: "Hetzner Produktion".into(),
            provider: Provider::Hetzner,
            endpoint: "https://fsn1.your-objectstorage.com".into(),
            region: "fsn1".into(),
            default_bucket: Some("gtg-mods".into()),
            addressing: Addressing::VirtualHosted,
            quirks: Quirks::CONSERVATIVE,
            timeout_secs: DEFAULT_TIMEOUT_SECS,
            concurrency: DEFAULT_CONCURRENCY,
            verify_tls: true,
            ca_file: None,
            proxy: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::hetzner;
    use super::*;

    #[test]
    fn valid_profiles_yield_their_endpoint() {
        let endpoint = hetzner().validate().unwrap();
        assert_eq!(endpoint.region(), "fsn1");
        assert_eq!(endpoint.service_url().as_str(), "https://fsn1.your-objectstorage.com/");
    }

    #[test]
    fn rejects_invalid_fields_with_readable_messages() {
        type Case = (fn(&mut ConnectionProfile), &'static str);
        let cases: [Case; 6] = [
            (|p| p.id = " ".into(), "Profil-ID"),
            (|p| p.name = String::new(), "Profilname"),
            (|p| p.timeout_secs = 0, "Timeout"),
            (|p| p.concurrency = 65, "Parallelität"),
            (|p| p.endpoint = "ftp://x".into(), "Endpoint-URL"),
            (|p| p.region = String::new(), "Region"),
        ];
        for (mutate, expected) in cases {
            let mut profile = hetzner();
            mutate(&mut profile);
            let Err(StoreError::InvalidConfig(message)) = profile.validate() else {
                panic!("{expected}")
            };
            assert!(message.contains(expected), "{message}");
        }
    }

    #[test]
    fn treats_blank_optional_values_as_missing() {
        let mut profile = hetzner();
        assert_eq!(profile.bucket(), Some("gtg-mods"));
        profile.default_bucket = Some("  ".into());
        profile.proxy = Some(" http://proxy.intern:3128 ".into());
        profile.ca_file = Some(String::new());
        assert_eq!(profile.bucket(), None);
        assert_eq!(profile.proxy_url(), Some("http://proxy.intern:3128"));
        assert_eq!(profile.ca_path(), None);
    }

    #[test]
    fn fills_defaults_when_reading_older_profile_files() {
        let json = r#"{"id":"a","name":"A","provider":"minio","endpoint":"http://localhost:9000","region":"us-east-1",
            "addressing":"path-style","quirks":{"urlEncodedListing":true,"crc32cChecksums":true}}"#;
        let profile: ConnectionProfile = serde_json::from_str(json).unwrap();
        assert_eq!(profile.timeout_secs, DEFAULT_TIMEOUT_SECS);
        assert_eq!(profile.concurrency, DEFAULT_CONCURRENCY);
        assert!(profile.verify_tls);
        assert_eq!(profile.default_bucket, None);
    }

    #[test]
    fn round_trips_through_json() {
        let profile = hetzner();
        let json = serde_json::to_string(&profile).unwrap();
        assert!(json.contains(r#""defaultBucket":"gtg-mods""#));
        assert_eq!(serde_json::from_str::<ConnectionProfile>(&json).unwrap(), profile);
    }
}
