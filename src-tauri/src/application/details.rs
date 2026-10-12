//! Anwendungsfälle der Objekt-Details (Screen 5): Kopfdaten, Metadaten ändern, Tags, Versionen
//! wiederherstellen und löschen, Berechtigungen und vorsignierte Links.
//!
//! Metadaten lassen sich bei S3 nur durch eine Kopie des Objekts auf sich selbst ändern. Bis 5 GiB
//! reicht eine Anfrage, darüber wird in Teilen kopiert; Content-Type und Storage Class bleiben.

use super::cancel::CancelFlag;
use super::copy::{CopySettings, copy_parts};
use super::error::AppError;
use super::parts::{PartProgress, with_retries};
use crate::domain::details::{
    MetadataEntry, ObjectAcl, ObjectHead, ObjectTag, ObjectVersion, clamp_presign_secs, validate_metadata,
    validate_tags,
};
use crate::domain::multipart::{MAX_SINGLE_PUT_SIZE, PartPlan};
use crate::domain::transfer::ObjectRef;
use crate::ports::{ObjectStore, StoreProvider};

/// Storage Class, die S3 ohne Angabe verwendet; sie wird beim Kopieren nicht mitgeschickt.
const DEFAULT_STORAGE_CLASS: &str = "STANDARD";

/// Ein Objekt einer gespeicherten Verbindung.
#[derive(Debug, Clone, Copy)]
pub struct ObjectAddressRef<'a> {
    pub profile_id: &'a str,
    pub bucket: &'a str,
    pub key: &'a str,
}

/// Ersetzt die Metadaten eines Objekts; Content-Type und Storage Class bleiben erhalten.
///
/// # Errors
/// Ungültige Metadaten oder Fehler des Stores.
pub async fn save_metadata<S: ObjectStore>(
    store: &S,
    bucket: &str,
    key: &str,
    metadata: &[MetadataEntry],
    settings: &CopySettings,
) -> Result<(), AppError> {
    let metadata = validate_metadata(metadata)?;
    let head = store.head_object(bucket, key).await?;
    let object = ObjectRef {
        bucket: bucket.to_owned(),
        key: key.to_owned(),
        content_type: head.content_type.clone(),
    };
    let storage_class = head
        .storage_class
        .as_deref()
        .filter(|class| *class != DEFAULT_STORAGE_CLASS);
    let cancel = CancelFlag::default();
    let plan = PartPlan::for_upload(head.size, settings.part_size, MAX_SINGLE_PUT_SIZE + 1)?;
    if plan == PartPlan::Single {
        with_retries(&settings.retry, &cancel, || {
            store.replace_metadata(&object, &metadata, storage_class)
        })
        .await?;
        return Ok(());
    }
    let upload_id = with_retries(&settings.retry, &cancel, || {
        store.create_multipart_upload_with_metadata(&object, &metadata, storage_class)
    })
    .await?;
    let progress = PartProgress::default();
    let result = copy_parts(
        store, &object, &object, &upload_id, &plan, head.size, settings, &progress,
    )
    .await;
    if result.is_err() {
        // Bestmöglich aufräumen; der ursprüngliche Fehler ist wichtiger.
        let _ = store.abort_multipart_upload(&object, &upload_id).await;
    }
    Ok(result?)
}

/// Objekt-Details für gespeicherte Verbindungen.
#[derive(Debug)]
pub struct DetailsService<P> {
    provider: P,
    settings: CopySettings,
}

impl<P: StoreProvider> DetailsService<P> {
    pub fn new(provider: P, settings: CopySettings) -> Self {
        Self { provider, settings }
    }

    /// # Errors
    /// Unbekanntes Profil oder Fehler des Stores.
    pub async fn head(&self, at: ObjectAddressRef<'_>) -> Result<ObjectHead, AppError> {
        Ok(self.store(at)?.head_object(at.bucket, at.key).await?)
    }

    /// # Errors
    /// Ungültige Metadaten, unbekanntes Profil oder Fehler des Stores.
    pub async fn save_metadata(&self, at: ObjectAddressRef<'_>, metadata: &[MetadataEntry]) -> Result<(), AppError> {
        save_metadata(self.store(at)?.as_ref(), at.bucket, at.key, metadata, &self.settings).await
    }

    /// # Errors
    /// Unbekanntes Profil oder Fehler des Stores.
    pub async fn tags(&self, at: ObjectAddressRef<'_>) -> Result<Vec<ObjectTag>, AppError> {
        Ok(self.store(at)?.get_object_tagging(at.bucket, at.key).await?)
    }

    /// # Errors
    /// Ungültige Tags, unbekanntes Profil oder Fehler des Stores.
    pub async fn save_tags(&self, at: ObjectAddressRef<'_>, tags: &[ObjectTag]) -> Result<(), AppError> {
        validate_tags(tags)?;
        Ok(self.store(at)?.put_object_tagging(at.bucket, at.key, tags).await?)
    }

    /// # Errors
    /// Unbekanntes Profil oder Fehler des Stores.
    pub async fn versions(&self, at: ObjectAddressRef<'_>) -> Result<Vec<ObjectVersion>, AppError> {
        Ok(self.store(at)?.list_object_versions(at.bucket, at.key).await?)
    }

    /// Macht eine ältere Version wieder zur aktuellen, indem sie auf den Key kopiert wird.
    ///
    /// # Errors
    /// Unbekanntes Profil oder Fehler des Stores.
    pub async fn restore_version(&self, at: ObjectAddressRef<'_>, version_id: &str) -> Result<(), AppError> {
        let object = ObjectRef {
            bucket: at.bucket.to_owned(),
            key: at.key.to_owned(),
            content_type: None,
        };
        Ok(self.store(at)?.copy_version(&object, version_id, &object).await?)
    }

    /// # Errors
    /// Unbekanntes Profil oder Fehler des Stores.
    pub async fn delete_version(&self, at: ObjectAddressRef<'_>, version_id: &str) -> Result<(), AppError> {
        Ok(self.store(at)?.delete_version(at.bucket, at.key, version_id).await?)
    }

    /// # Errors
    /// Unbekanntes Profil oder Fehler des Stores.
    pub async fn acl(&self, at: ObjectAddressRef<'_>) -> Result<ObjectAcl, AppError> {
        Ok(self.store(at)?.get_object_acl(at.bucket, at.key).await?)
    }

    /// Vorsignierter Link; die Gültigkeit wird auf eine Sekunde bis sieben Tage begrenzt.
    ///
    /// # Errors
    /// Unbekanntes Profil oder eine URL, die sich nicht bilden lässt.
    pub fn presign(&self, at: ObjectAddressRef<'_>, expires_secs: u32) -> Result<String, AppError> {
        Ok(self
            .store(at)?
            .presign_get(at.bucket, at.key, clamp_presign_secs(expires_secs))?)
    }

    fn store(&self, at: ObjectAddressRef<'_>) -> Result<std::sync::Arc<P::Store>, AppError> {
        self.provider.store_for(at.profile_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::parts::RetryPolicy;
    use crate::application::test_support::{FakeProvider, FakeStore, TransferCall};
    use crate::domain::details::{AclGrant, DetailsError};
    use crate::domain::error::StoreError;
    use crate::domain::multipart::{MAX_PART_SIZE, MIB};
    use std::sync::Arc;
    use std::time::Duration;

    const AT: ObjectAddressRef<'static> = ObjectAddressRef {
        profile_id: "p1",
        bucket: "b",
        key: "a/x.bin",
    };

    fn settings() -> CopySettings {
        CopySettings {
            part_size: 2 * 1024 * MIB,
            retry: RetryPolicy {
                retries: 0,
                delay: Duration::from_millis(1),
            },
        }
    }

    fn service() -> (DetailsService<FakeProvider>, Arc<FakeStore>) {
        let store = Arc::new(FakeStore::default());
        (
            DetailsService::new(FakeProvider::new(Arc::clone(&store)), settings()),
            store,
        )
    }

    fn meta(name: &str, value: &str) -> MetadataEntry {
        MetadataEntry {
            name: name.into(),
            value: value.into(),
        }
    }

    fn head(size: u64, storage_class: &str) -> ObjectHead {
        ObjectHead {
            size,
            content_type: Some("application/zstd".into()),
            storage_class: Some(storage_class.into()),
            ..ObjectHead::default()
        }
    }

    #[tokio::test]
    async fn replaces_metadata_in_place_and_keeps_type_and_storage_class() {
        let (service, store) = service();
        store.set_head(head(10, "STANDARD_IA"));
        service
            .save_metadata(AT, &[meta("X-Amz-Meta-Retention", "90d")])
            .await
            .unwrap();
        assert_eq!(
            store.upload_calls().last(),
            Some(&TransferCall::ReplaceMetadata {
                metadata: vec![meta("x-amz-meta-retention", "90d")],
                storage_class: Some("STANDARD_IA".into()),
                content_type: Some("application/zstd".into()),
            })
        );
        store.set_head(head(10, "STANDARD"));
        service.save_metadata(AT, &[]).await.unwrap();
        let Some(TransferCall::ReplaceMetadata { storage_class, .. }) = store.upload_calls().last().cloned() else {
            panic!("Ersetzen erwartet")
        };
        assert_eq!(storage_class, None, "STANDARD wird nicht mitgeschickt");
    }

    #[tokio::test]
    async fn copies_objects_over_5_gib_in_parts_with_new_metadata() {
        let (service, store) = service();
        store.set_head(head(MAX_PART_SIZE + MIB, "STANDARD"));
        service
            .save_metadata(AT, &[meta("cache-control", "no-store")])
            .await
            .unwrap();
        let calls = store.upload_calls();
        assert_eq!(
            calls[1],
            TransferCall::CreateWithMetadata {
                metadata: vec![meta("cache-control", "no-store")]
            }
        );
        assert_eq!(calls.last(), Some(&TransferCall::Complete { parts: vec![1, 2, 3] }));
    }

    #[tokio::test]
    async fn aborts_failed_large_metadata_copies_and_rejects_invalid_metadata() {
        let (service, store) = service();
        store.set_head(head(MAX_PART_SIZE + MIB, "STANDARD"));
        store.succeed_first(2);
        store.fail_next(vec![StoreError::Timeout]);
        assert!(service.save_metadata(AT, &[]).await.is_err());
        assert_eq!(store.upload_calls().last(), Some(&TransferCall::Abort));
        let invalid = service.save_metadata(AT, &[meta("authorization", "x")]).await;
        assert_eq!(
            invalid,
            Err(AppError::InvalidDetails(DetailsError::MetadataName(
                "authorization".into()
            )))
        );
    }

    #[tokio::test]
    async fn reads_and_writes_tags_versions_and_acl() {
        let (service, store) = service();
        let tags = vec![ObjectTag {
            key: "env".into(),
            value: "prod".into(),
        }];
        store.set_tags(tags.clone());
        assert_eq!(service.tags(AT).await.unwrap(), tags);
        service.save_tags(AT, &tags).await.unwrap();
        assert_eq!(
            store.upload_calls().last(),
            Some(&TransferCall::PutTags { tags: tags.clone() })
        );
        let eleven: Vec<_> = (0..11)
            .map(|i| ObjectTag {
                key: format!("k{i}"),
                value: String::new(),
            })
            .collect();
        assert_eq!(
            service.save_tags(AT, &eleven).await,
            Err(AppError::InvalidDetails(DetailsError::TooManyTags))
        );

        let version = ObjectVersion {
            version_id: "v1".into(),
            is_latest: false,
            is_delete_marker: false,
            last_modified_ms: None,
            size: 3,
        };
        store.set_versions(vec![version.clone()]);
        assert_eq!(service.versions(AT).await.unwrap(), [version]);
        service.restore_version(AT, "v1").await.unwrap();
        service.delete_version(AT, "v2").await.unwrap();
        let calls = store.upload_calls();
        assert!(calls.contains(&TransferCall::CopyVersion {
            version_id: "v1".into()
        }));
        assert!(calls.contains(&TransferCall::DeleteVersion {
            version_id: "v2".into()
        }));

        let acl = ObjectAcl {
            owner: Some("ich".into()),
            grants: vec![AclGrant {
                grantee: "AllUsers".into(),
                is_public: true,
                permission: "READ".into(),
            }],
        };
        store.set_acl(acl.clone());
        assert_eq!(service.acl(AT).await.unwrap(), acl);
        assert_eq!(service.head(AT).await.unwrap(), ObjectHead::default());
    }

    #[tokio::test]
    async fn presigns_with_clamped_durations_and_reports_unknown_profiles() {
        let (service, _) = service();
        assert_eq!(
            service.presign(AT, 0).unwrap(),
            "https://fake/b/a/x.bin?X-Amz-Expires=1"
        );
        assert!(service.presign(AT, u32::MAX).unwrap().ends_with("=604800"));
        service.provider.make_unavailable();
        assert!(matches!(service.head(AT).await, Err(AppError::ProfileNotFound(_))));
        assert!(matches!(service.presign(AT, 60), Err(AppError::ProfileNotFound(_))));
    }
}
