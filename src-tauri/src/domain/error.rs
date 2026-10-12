//! Fehler der Domäne. Texte sind deutsch, weil sie direkt in der Oberfläche erscheinen.

use serde::Serialize;
use std::fmt;

/// Fehlerantwort eines S3-Dienstes, z. B. `AccessDenied` mit HTTP 403.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceError {
    pub code: String,
    pub message: String,
    pub http_status: u16,
    pub request_id: Option<String>,
}

impl fmt::Display for ServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {} (HTTP {})", self.code, self.message, self.http_status)
    }
}

/// Fehler beim Zugriff auf einen Object Store.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, Serialize)]
#[serde(tag = "kind", content = "detail", rename_all = "camelCase")]
pub enum StoreError {
    #[error("{0}")]
    Service(ServiceError),
    #[error("Netzwerkfehler: {0}")]
    Network(String),
    #[error("Zeitüberschreitung beim Warten auf den Endpunkt")]
    Timeout,
    #[error("Ungültige Antwort des Endpunkts: {0}")]
    InvalidResponse(String),
    #[error("Ungültige Konfiguration: {0}")]
    InvalidConfig(String),
    #[error("Vorgang abgebrochen")]
    Cancelled,
    #[error("Lokale Datei: {0}")]
    LocalFile(String),
    #[error("Prüfsumme stimmt nicht: {0}")]
    Integrity(String),
}

impl StoreError {
    /// Art des Fehlers für die Oberfläche (Fehlerleiste, Transfer-Zeile).
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Service(_) => "service",
            Self::Network(_) => "network",
            Self::Timeout => "timeout",
            Self::InvalidResponse(_) => "invalidResponse",
            Self::InvalidConfig(_) => "invalidConfig",
            Self::Cancelled => "cancelled",
            Self::LocalFile(_) => "localFile",
            Self::Integrity(_) => "integrity",
        }
    }
}

/// Fehler, wie die Oberfläche ihn anzeigt: Art, lesbare Meldung und bei S3-Fehlern die Details
/// (Code, HTTP-Status, Request-ID). Gemeinsame Form für Befehle und Transfers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorReport {
    pub kind: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<ServiceError>,
}

impl From<&StoreError> for ErrorReport {
    fn from(error: &StoreError) -> Self {
        let service = match error {
            StoreError::Service(service) => Some(service.clone()),
            _ => None,
        };
        Self {
            kind: error.kind(),
            message: error.to_string(),
            service,
        }
    }
}

impl From<StoreError> for ErrorReport {
    fn from(error: StoreError) -> Self {
        Self::from(&error)
    }
}

/// Fehler des Speichers für Zugangsdaten.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CredentialError {
    #[error("Zugriff auf den Windows-Anmeldeinformationsspeicher fehlgeschlagen: {0}")]
    Platform(String),
    #[error("Gespeicherte Zugangsdaten sind beschädigt: {0}")]
    Corrupt(String),
}

/// Fehler des Listing-Caches. Listings laufen trotzdem weiter, nur ohne Cache.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CacheError {
    #[error("Listing-Cache nicht verfügbar: {0}")]
    Storage(String),
}

/// Fehler der Ablage für Verbindungsprofile.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RepositoryError {
    #[error("Profildatei konnte nicht gelesen oder geschrieben werden: {0}")]
    Io(String),
    #[error("Profildatei ist beschädigt: {0}")]
    Corrupt(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_error_names_code_message_and_status() {
        let error = StoreError::Service(ServiceError {
            code: "AccessDenied".into(),
            message: "Access Denied".into(),
            http_status: 403,
            request_id: Some("ABC".into()),
        });
        assert_eq!(error.to_string(), "AccessDenied: Access Denied (HTTP 403)");
    }

    #[test]
    fn errors_serialize_with_kind_for_the_frontend() {
        let json = serde_json::to_string(&StoreError::Timeout).unwrap();
        assert_eq!(json, r#"{"kind":"timeout"}"#);
        let json = serde_json::to_string(&StoreError::Network("weg".into())).unwrap();
        assert_eq!(json, r#"{"kind":"network","detail":"weg"}"#);
    }

    #[test]
    fn reports_kind_message_and_service_details() {
        let service = ServiceError {
            code: "SlowDown".into(),
            message: "langsamer".into(),
            http_status: 503,
            request_id: None,
        };
        let report = ErrorReport::from(StoreError::Service(service.clone()));
        assert_eq!(
            report,
            ErrorReport {
                kind: "service",
                message: "SlowDown: langsamer (HTTP 503)".into(),
                service: Some(service)
            }
        );
        assert_eq!(ErrorReport::from(&StoreError::Integrity("x".into())).kind, "integrity");
        let json = serde_json::to_string(&ErrorReport::from(&StoreError::Timeout)).unwrap();
        assert_eq!(
            json,
            r#"{"kind":"timeout","message":"Zeitüberschreitung beim Warten auf den Endpunkt"}"#
        );
        let kinds: Vec<_> = [
            StoreError::Network(String::new()),
            StoreError::InvalidResponse(String::new()),
            StoreError::InvalidConfig(String::new()),
            StoreError::Cancelled,
            StoreError::LocalFile(String::new()),
        ]
        .iter()
        .map(StoreError::kind)
        .collect();
        assert_eq!(
            kinds,
            ["network", "invalidResponse", "invalidConfig", "cancelled", "localFile"]
        );
    }

    #[test]
    fn credential_errors_explain_the_cause() {
        assert!(CredentialError::Corrupt("x".into()).to_string().contains("beschädigt"));
    }
}
