//! Zugangsdaten. Das Secret erscheint nie in Debug-Ausgaben oder Logs.

use super::error::StoreError;
use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    access_key_id: String,
    secret_access_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_token: Option<String>,
}

impl Credentials {
    /// Legt Zugangsdaten an. Leerzeichen am Rand werden entfernt, weil sie beim
    /// Kopieren aus Konsolen häufig mitkommen und zu `SignatureDoesNotMatch` führen.
    ///
    /// # Errors
    ///
    /// `InvalidConfig`, wenn Access Key oder Secret leer sind.
    pub fn new(access_key_id: &str, secret_access_key: &str, session_token: Option<&str>) -> Result<Self, StoreError> {
        let access_key_id = access_key_id.trim();
        let secret_access_key = secret_access_key.trim();
        if access_key_id.is_empty() || secret_access_key.is_empty() {
            return Err(StoreError::InvalidConfig(
                "Access Key und Secret Key sind Pflicht".into(),
            ));
        }
        Ok(Self {
            access_key_id: access_key_id.to_owned(),
            secret_access_key: secret_access_key.to_owned(),
            session_token: session_token
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(str::to_owned),
        })
    }

    #[must_use]
    pub fn access_key_id(&self) -> &str {
        &self.access_key_id
    }

    #[must_use]
    pub fn secret_access_key(&self) -> &str {
        &self.secret_access_key
    }

    #[must_use]
    pub fn session_token(&self) -> Option<&str> {
        self.session_token.as_deref()
    }
}

impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credentials")
            .field("access_key_id", &self.access_key_id)
            .field("secret_access_key", &"***")
            .field("session_token", &self.session_token.as_ref().map(|_| "***"))
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_values_and_drops_empty_session_token() {
        let c = Credentials::new(" AKID ", "\tsecret\n", Some("  ")).unwrap();
        assert_eq!(c.access_key_id(), "AKID");
        assert_eq!(c.secret_access_key(), "secret");
        assert_eq!(c.session_token(), None);
    }

    #[test]
    fn keeps_session_token() {
        let c = Credentials::new("a", "b", Some("token")).unwrap();
        assert_eq!(c.session_token(), Some("token"));
    }

    #[test]
    fn rejects_missing_keys() {
        assert!(matches!(
            Credentials::new("", "b", None),
            Err(StoreError::InvalidConfig(_))
        ));
        assert!(matches!(
            Credentials::new("a", "  ", None),
            Err(StoreError::InvalidConfig(_))
        ));
    }

    #[test]
    fn debug_output_hides_secrets() {
        let text = format!("{:?}", Credentials::new("AKID", "geheim", Some("tok")).unwrap());
        assert!(text.contains("AKID"));
        assert!(!text.contains("geheim"));
        assert!(!text.contains("tok\""));
    }

    #[test]
    fn round_trips_through_json_without_empty_token() {
        let c = Credentials::new("a", "b", None).unwrap();
        let json = serde_json::to_string(&c).unwrap();
        assert_eq!(json, r#"{"accessKeyId":"a","secretAccessKey":"b"}"#);
        assert_eq!(serde_json::from_str::<Credentials>(&json).unwrap(), c);
    }
}
