//! Fehler der Anwendungsfälle: fasst die Fehler aller Ports zusammen.

use crate::domain::details::DetailsError;
use crate::domain::error::{CacheError, CredentialError, ErrorReport, RepositoryError, StoreError};
use crate::domain::naming::NameError;
use crate::domain::settings::SettingsError;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AppError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Credential(#[from] CredentialError),
    #[error(transparent)]
    Repository(#[from] RepositoryError),
    #[error("Verbindungsprofil {0} gibt es nicht mehr")]
    ProfileNotFound(String),
    #[error("Für dieses Profil sind keine Zugangsdaten gespeichert")]
    MissingCredentials,
    #[error("Der Löschauftrag {0} ist nicht mehr gültig; bitte die Auswahl erneut löschen")]
    DeletePlanNotFound(String),
    #[error("Der Abgleich {0} ist nicht mehr gültig; bitte erneut vergleichen")]
    SyncPlanNotFound(String),
    #[error(transparent)]
    InvalidName(#[from] NameError),
    #[error("„{0}“ gibt es in diesem Ordner schon")]
    NameTaken(String),
    #[error("„{0}“ kann nicht in sich selbst eingefügt werden")]
    CopyIntoItself(String),
    #[error(transparent)]
    InvalidDetails(#[from] DetailsError),
    #[error(transparent)]
    InvalidSettings(#[from] SettingsError),
    #[error(transparent)]
    Cache(#[from] CacheError),
}

impl From<AppError> for ErrorReport {
    fn from(error: AppError) -> Self {
        let kind = match &error {
            AppError::Store(store) => return Self::from(store),
            AppError::Credential(_) => "credential",
            AppError::Repository(_) => "repository",
            AppError::ProfileNotFound(_) => "profileNotFound",
            AppError::MissingCredentials => "missingCredentials",
            AppError::DeletePlanNotFound(_) => "deletePlanNotFound",
            AppError::SyncPlanNotFound(_) => "syncPlanNotFound",
            AppError::InvalidName(_) => "invalidName",
            AppError::NameTaken(_) => "nameTaken",
            AppError::CopyIntoItself(_) => "copyIntoItself",
            AppError::InvalidDetails(_) => "invalidDetails",
            AppError::InvalidSettings(_) => "invalidSettings",
            AppError::Cache(_) => "cache",
        };
        Self {
            kind,
            message: error.to_string(),
            service: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_application_errors_with_their_kind() {
        let cases = [
            (
                AppError::Credential(CredentialError::Platform("x".into())),
                "credential",
            ),
            (AppError::Repository(RepositoryError::Io("x".into())), "repository"),
            (AppError::ProfileNotFound("p".into()), "profileNotFound"),
            (AppError::MissingCredentials, "missingCredentials"),
            (AppError::DeletePlanNotFound("d".into()), "deletePlanNotFound"),
            (AppError::SyncPlanNotFound("s".into()), "syncPlanNotFound"),
            (AppError::InvalidName(NameError::Empty), "invalidName"),
            (AppError::NameTaken("x".into()), "nameTaken"),
            (AppError::CopyIntoItself("x".into()), "copyIntoItself"),
            (AppError::InvalidDetails(DetailsError::TooManyTags), "invalidDetails"),
            (
                AppError::InvalidSettings(SettingsError::OutOfRange {
                    field: "x",
                    min: 1,
                    max: 2,
                }),
                "invalidSettings",
            ),
            (AppError::Cache(CacheError::Storage("x".into())), "cache"),
            (AppError::Store(StoreError::Timeout), "timeout"),
        ];
        for (error, kind) in cases {
            let message = error.to_string();
            let report = ErrorReport::from(error);
            assert_eq!((report.kind, report.message), (kind, message));
        }
    }

    #[test]
    fn wraps_port_errors_transparently() {
        assert_eq!(
            AppError::from(StoreError::Timeout).to_string(),
            StoreError::Timeout.to_string()
        );
        let repo = RepositoryError::Io("gesperrt".into());
        assert_eq!(AppError::from(repo.clone()).to_string(), repo.to_string());
        let cred = CredentialError::Platform("x".into());
        assert_eq!(AppError::from(cred.clone()).to_string(), cred.to_string());
    }

    #[test]
    fn explains_missing_profiles_and_credentials() {
        assert!(AppError::ProfileNotFound("p1".into()).to_string().contains("p1"));
        assert!(AppError::MissingCredentials.to_string().contains("Zugangsdaten"));
    }
}
