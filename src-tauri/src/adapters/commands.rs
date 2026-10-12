//! Tauri-Befehle: treibender Adapter zwischen Oberfläche und Anwendungsdienst.
//! Die Befehle übersetzen nur Ein- und Ausgaben, die Logik steckt im `ConnectionService`.
// Tauri übergibt Argumente als Werte, und alle Fehler beschreibt `CommandError`.
#![allow(clippy::needless_pass_by_value, clippy::missing_errors_doc)]

use super::clock::SystemClock;
use super::credential_store::KeyringCredentialStore;
use super::local_files::StdLocalFiles;
use super::profile_file::JsonProfileRepository;
use super::s3::factory::HttpStoreFactory;
use super::settings_file::JsonSettingsRepository;
use super::sqlite_cache::SqliteListingCache;
use super::tauri_runtime::{TauriSpawner, TauriTransferEvents};
use crate::application::connection::ConnectionTest;
use crate::application::connections::ConnectionService;
use crate::application::copy::{CopySource, CopyTarget};
use crate::application::deletion::DeleteService;
use crate::application::details::{DetailsService, ObjectAddressRef};
use crate::application::folders::FolderService;
use crate::application::listing::ListingSummary;
use crate::application::local_browse::list_local;
use crate::application::naming::NamingService;
use crate::application::settings::SettingsService;
use crate::application::sync::{SyncPreview, SyncRequest, SyncService, SyncWork};
use crate::application::transfers::{TransferManager, TransferSettings};
use crate::domain::credentials::Credentials;
use crate::domain::deletion::{DeleteOutcome, DeletePreview, DeleteProgress};
use crate::domain::details::{MetadataEntry, ObjectAcl, ObjectHead, ObjectTag, ObjectVersion};
use crate::domain::error::{ErrorReport, StoreError};
use crate::domain::listing_cache::{CacheStats, FolderKey, FolderPage, ListingMode};
use crate::domain::local_dir::LocalEntry;
use crate::domain::naming::{RenameOutcome, RenameProgress};
use crate::domain::object::BucketInfo;
use crate::domain::profile::ConnectionProfile;
use crate::domain::provider::{PRESETS, ProviderPreset};
use crate::domain::settings::AppSettings;
use crate::domain::sync::SyncDirection;
use crate::domain::transfer::{SelectedItem, TransferId, TransferSnapshot};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;
use tauri::ipc::Channel;

pub type AppService =
    ConnectionService<JsonProfileRepository, KeyringCredentialStore, HttpStoreFactory<SystemClock>, SystemClock>;

/// Der Verbindungsdienst wird mit der Transfer-Verwaltung geteilt.
pub type SharedService = Arc<AppService>;

/// Transfer-Verwaltung für eine Tauri-Laufzeit (in Tests die Mock-Laufzeit).
pub type Transfers<R> =
    TransferManager<SharedService, StdLocalFiles, TauriTransferEvents<R>, TauriSpawner, SystemClock>;
pub type AppTransfers = Transfers<tauri::Wry>;

/// Löschaufträge; teilen sich die S3-Clients mit dem Verbindungsdienst.
pub type AppDeletes = DeleteService<SharedService>;

/// Ordner anlegen und umbenennen.
pub type AppNaming = NamingService<SharedService>;

/// Objekt-Details (Screen 5).
pub type AppDetails = DetailsService<SharedService>;

/// Ordner listen mit Listing-Cache.
pub type AppFolders = FolderService<SharedService, SqliteListingCache, SystemClock>;

/// Abgleich lokal ↔ Bucket.
pub type AppSync = SyncService<SharedService, StdLocalFiles>;

/// Einstellungen (Screen 7).
pub type AppSettingsService = SettingsService<JsonSettingsRepository>;

/// Fehler, wie die Oberfläche ihn anzeigt (Fehlerleiste, Formularhinweis).
pub type CommandError = ErrorReport;

/// Zugangsdaten aus dem Formular; werden in der Domäne geprüft und bereinigt.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialsInput {
    pub access_key_id: String,
    pub secret_access_key: String,
    #[serde(default)]
    pub session_token: Option<String>,
}

impl CredentialsInput {
    /// # Errors
    /// `InvalidConfig` bei leeren Schlüsseln.
    pub fn into_credentials(self) -> Result<Credentials, StoreError> {
        Credentials::new(
            &self.access_key_id,
            &self.secret_access_key,
            self.session_token.as_deref(),
        )
    }
}

fn credentials(input: Option<CredentialsInput>) -> Result<Option<Credentials>, CommandError> {
    Ok(input.map(CredentialsInput::into_credentials).transpose()?)
}

#[tauri::command]
#[must_use]
pub fn list_presets() -> Vec<ProviderPreset> {
    PRESETS.to_vec()
}

#[tauri::command]
pub fn list_profiles(service: State<'_, SharedService>) -> Result<Vec<ConnectionProfile>, CommandError> {
    Ok(service.list_profiles()?)
}

#[tauri::command]
pub fn save_profile(
    service: State<'_, SharedService>,
    profile: ConnectionProfile,
    credentials: Option<CredentialsInput>,
) -> Result<(), CommandError> {
    let credentials = self::credentials(credentials)?;
    Ok(service.save_profile(&profile, credentials.as_ref())?)
}

#[tauri::command]
pub fn delete_profile(
    service: State<'_, SharedService>,
    folders: State<'_, AppFolders>,
    id: String,
) -> Result<(), CommandError> {
    service.delete_profile(&id)?;
    folders.forget_profile(&id);
    Ok(())
}

#[tauri::command]
pub async fn test_connection(
    service: State<'_, SharedService>,
    profile: ConnectionProfile,
    credentials: Option<CredentialsInput>,
) -> Result<ConnectionTest, CommandError> {
    let credentials = self::credentials(credentials)?;
    Ok(service.test_connection(&profile, credentials).await?)
}

#[tauri::command]
pub async fn list_buckets(
    service: State<'_, SharedService>,
    profile_id: String,
) -> Result<Vec<BucketInfo>, CommandError> {
    Ok(service.list_buckets(&profile_id).await?)
}

/// Listet einen Ordner; jede Seite geht sofort über `on_page` an die Oberfläche. Ohne `fresh`
/// kommen zuerst die gespeicherten Seiten aus dem Listing-Cache.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri-Befehl: jedes Argument kommt einzeln aus dem Aufruf
pub async fn list_folder(
    folders: State<'_, AppFolders>,
    profile_id: String,
    bucket: String,
    prefix: String,
    listing_id: String,
    fresh: bool,
    on_page: Channel<FolderPage>,
) -> Result<ListingSummary, CommandError> {
    let folder = FolderKey::new(&profile_id, &bucket, &prefix);
    let mode = if fresh {
        ListingMode::Fresh
    } else {
        ListingMode::CachedFirst
    };
    let send = |page: FolderPage| {
        if let Err(error) = on_page.send(page) {
            log::warn!("Listing {listing_id}: Seite nicht zugestellt: {error}");
        }
    };
    Ok(folders.list_folder(&folder, mode, &listing_id, send).await?)
}

#[tauri::command]
#[must_use]
pub fn cancel_listing(folders: State<'_, AppFolders>, listing_id: String) -> bool {
    folders.cancel_listing(&listing_id)
}

/// Vergleicht einen lokalen Ordner mit einem Ordner im Bucket und liefert die Vorschau.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri-Befehl: jedes Argument kommt einzeln aus dem Aufruf
pub async fn plan_sync(
    syncs: State<'_, AppSync>,
    profile_id: String,
    bucket: String,
    prefix: String,
    local_dir: PathBuf,
    direction: SyncDirection,
) -> Result<SyncPreview, CommandError> {
    let request = SyncRequest {
        profile_id: &profile_id,
        bucket: &bucket,
        prefix: &prefix,
        local_root: &local_dir,
        direction,
    };
    Ok(syncs.plan(request).await?)
}

/// Reiht die Transfers eines Abgleichs ein.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri übergibt Argumente als Wert
pub fn start_sync(
    syncs: State<'_, AppSync>,
    transfers: State<'_, AppTransfers>,
    plan_id: String,
) -> Result<Vec<TransferId>, CommandError> {
    let plan = syncs.take(&plan_id)?;
    Ok(match plan.work {
        SyncWork::Uploads(files) => transfers.enqueue_upload_files(&plan.profile_id, &plan.bucket, files),
        SyncWork::Downloads(jobs) => transfers.enqueue_download_jobs(&plan.profile_id, jobs),
    })
}

/// Laufwerke (ohne Pfad) oder Inhalt eines lokalen Ordners für die Zwei-Panel-Ansicht.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri übergibt Argumente als Wert
pub fn list_local_dir(path: Option<String>) -> Result<Vec<LocalEntry>, CommandError> {
    Ok(list_local(&StdLocalFiles, path.as_deref())?)
}

/// Umfang des Listing-Caches für Einstellungen › Cache.
#[tauri::command]
pub fn cache_stats(folders: State<'_, AppFolders>) -> Result<CacheStats, CommandError> {
    Ok(folders.cache_stats()?)
}

#[tauri::command]
pub fn clear_listing_cache(folders: State<'_, AppFolders>) -> Result<(), CommandError> {
    Ok(folders.clear_cache()?)
}

// ---------- Löschen ----------

/// Ermittelt, was die Auswahl löschen würde, für den Bestätigungsdialog.
#[tauri::command]
pub async fn prepare_delete(
    deletes: State<'_, AppDeletes>,
    profile_id: String,
    bucket: String,
    items: Vec<SelectedItem>,
) -> Result<DeletePreview, CommandError> {
    Ok(deletes.prepare(&profile_id, &bucket, &items).await?)
}

/// Löscht einen vorbereiteten Plan; der Fortschritt geht über `on_progress` an die Oberfläche.
#[tauri::command]
pub async fn delete_objects(
    deletes: State<'_, AppDeletes>,
    plan_id: String,
    on_progress: Channel<DeleteProgress>,
) -> Result<DeleteOutcome, CommandError> {
    let send = |progress: DeleteProgress| {
        if let Err(error) = on_progress.send(progress) {
            log::warn!("Löschauftrag {plan_id}: Fortschritt nicht zugestellt: {error}");
        }
    };
    Ok(deletes.execute(&plan_id, send).await?)
}

#[tauri::command]
#[must_use]
pub fn cancel_delete(deletes: State<'_, AppDeletes>, plan_id: String) -> bool {
    deletes.cancel(&plan_id)
}

#[tauri::command]
pub fn discard_delete(deletes: State<'_, AppDeletes>, plan_id: String) {
    deletes.discard(&plan_id);
}

// ---------- Einstellungen ----------

#[tauri::command]
#[must_use]
pub fn get_settings(settings: State<'_, AppSettingsService>) -> AppSettings {
    settings.current()
}

/// Speichert die Einstellungen; Transfers und Listing-Cache übernehmen sie sofort.
#[tauri::command]
pub fn save_settings(
    settings: State<'_, AppSettingsService>,
    transfers: State<'_, AppTransfers>,
    folders: State<'_, AppFolders>,
    value: AppSettings,
) -> Result<AppSettings, CommandError> {
    let saved = settings.save(value)?;
    transfers.apply_settings(TransferSettings::from(&saved.transfers));
    folders.set_cache_enabled(saved.cache.enabled);
    Ok(saved)
}

// ---------- Objekt-Details ----------

fn at<'a>(profile_id: &'a str, bucket: &'a str, key: &'a str) -> ObjectAddressRef<'a> {
    ObjectAddressRef {
        profile_id,
        bucket,
        key,
    }
}

#[tauri::command]
pub async fn object_head(
    details: State<'_, AppDetails>,
    profile_id: String,
    bucket: String,
    key: String,
) -> Result<ObjectHead, CommandError> {
    Ok(details.head(at(&profile_id, &bucket, &key)).await?)
}

/// Ersetzt die Metadaten; das Objekt wird dafür auf sich selbst kopiert.
#[tauri::command]
pub async fn save_object_metadata(
    details: State<'_, AppDetails>,
    profile_id: String,
    bucket: String,
    key: String,
    metadata: Vec<MetadataEntry>,
) -> Result<(), CommandError> {
    Ok(details.save_metadata(at(&profile_id, &bucket, &key), &metadata).await?)
}

#[tauri::command]
pub async fn object_tags(
    details: State<'_, AppDetails>,
    profile_id: String,
    bucket: String,
    key: String,
) -> Result<Vec<ObjectTag>, CommandError> {
    Ok(details.tags(at(&profile_id, &bucket, &key)).await?)
}

#[tauri::command]
pub async fn save_object_tags(
    details: State<'_, AppDetails>,
    profile_id: String,
    bucket: String,
    key: String,
    tags: Vec<ObjectTag>,
) -> Result<(), CommandError> {
    Ok(details.save_tags(at(&profile_id, &bucket, &key), &tags).await?)
}

#[tauri::command]
pub async fn object_versions(
    details: State<'_, AppDetails>,
    profile_id: String,
    bucket: String,
    key: String,
) -> Result<Vec<ObjectVersion>, CommandError> {
    Ok(details.versions(at(&profile_id, &bucket, &key)).await?)
}

#[tauri::command]
pub async fn restore_object_version(
    details: State<'_, AppDetails>,
    profile_id: String,
    bucket: String,
    key: String,
    version_id: String,
) -> Result<(), CommandError> {
    Ok(details
        .restore_version(at(&profile_id, &bucket, &key), &version_id)
        .await?)
}

#[tauri::command]
pub async fn delete_object_version(
    details: State<'_, AppDetails>,
    profile_id: String,
    bucket: String,
    key: String,
    version_id: String,
) -> Result<(), CommandError> {
    Ok(details
        .delete_version(at(&profile_id, &bucket, &key), &version_id)
        .await?)
}

#[tauri::command]
pub async fn object_acl(
    details: State<'_, AppDetails>,
    profile_id: String,
    bucket: String,
    key: String,
) -> Result<ObjectAcl, CommandError> {
    Ok(details.acl(at(&profile_id, &bucket, &key)).await?)
}

#[tauri::command]
pub fn presign_object(
    details: State<'_, AppDetails>,
    profile_id: String,
    bucket: String,
    key: String,
    expires_secs: u32,
) -> Result<String, CommandError> {
    Ok(details.presign(at(&profile_id, &bucket, &key), expires_secs)?)
}

// ---------- Neuer Ordner, Umbenennen ----------

/// Legt im Ordner `prefix` einen neuen Ordner an und liefert seinen Key.
#[tauri::command]
pub async fn create_folder(
    naming: State<'_, AppNaming>,
    profile_id: String,
    bucket: String,
    prefix: String,
    name: String,
) -> Result<String, CommandError> {
    Ok(naming.create_folder(&profile_id, &bucket, &prefix, &name).await?)
}

/// Benennt eine Datei oder einen Ordner um; der Fortschritt geht über `on_progress`.
#[tauri::command]
pub async fn rename_object(
    naming: State<'_, AppNaming>,
    profile_id: String,
    bucket: String,
    item: SelectedItem,
    new_name: String,
    on_progress: Channel<RenameProgress>,
) -> Result<RenameOutcome, CommandError> {
    let send = |progress: RenameProgress| {
        if let Err(error) = on_progress.send(progress) {
            log::warn!("Umbenennen von {}: Fortschritt nicht zugestellt: {error}", item.key);
        }
    };
    Ok(naming.rename(&profile_id, &bucket, &item, &new_name, send).await?)
}

// ---------- Transfers ----------

/// Reiht Uploads der gewählten oder hineingezogenen Dateien und Ordner ein.
#[tauri::command]
pub fn enqueue_uploads(
    transfers: State<'_, AppTransfers>,
    profile_id: String,
    bucket: String,
    prefix: String,
    paths: Vec<PathBuf>,
) -> Result<Vec<TransferId>, CommandError> {
    Ok(transfers.enqueue_uploads(&profile_id, &bucket, &prefix, &paths)?)
}

/// Reiht Downloads der gewählten Objekte und Ordner in den Zielordner ein.
#[tauri::command]
pub async fn enqueue_downloads(
    transfers: State<'_, AppTransfers>,
    profile_id: String,
    bucket: String,
    prefix: String,
    items: Vec<SelectedItem>,
    target_dir: PathBuf,
) -> Result<Vec<TransferId>, CommandError> {
    Ok(transfers
        .enqueue_downloads(&profile_id, &bucket, &prefix, &items, &target_dir)
        .await?)
}

/// Reiht Kopien der Auswahl in den Zielordner ein, auch in eine andere Verbindung
/// (`target_profile_id`); `move_items` verschiebt (Strg+X, Strg+V).
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri-Befehl: jedes Argument kommt einzeln aus dem Aufruf
pub async fn enqueue_copies(
    transfers: State<'_, AppTransfers>,
    profile_id: String,
    source_bucket: String,
    items: Vec<SelectedItem>,
    target_profile_id: Option<String>,
    target_bucket: String,
    target_prefix: String,
    move_items: bool,
) -> Result<Vec<TransferId>, CommandError> {
    let source = CopySource {
        profile_id: &profile_id,
        bucket: &source_bucket,
        items: &items,
    };
    let target = CopyTarget {
        profile_id: target_profile_id.as_deref().unwrap_or(&profile_id),
        bucket: &target_bucket,
        prefix: &target_prefix,
    };
    Ok(transfers.enqueue_copies(source, target, move_items).await?)
}

#[tauri::command]
#[must_use]
pub fn list_transfers(transfers: State<'_, AppTransfers>) -> Vec<TransferSnapshot> {
    transfers.snapshots()
}

#[tauri::command]
pub fn pause_transfer(transfers: State<'_, AppTransfers>, id: TransferId) {
    transfers.pause(id);
}

#[tauri::command]
pub fn resume_transfer(transfers: State<'_, AppTransfers>, id: TransferId) {
    transfers.resume(id);
}

#[tauri::command]
pub fn cancel_transfer(transfers: State<'_, AppTransfers>, id: TransferId) {
    transfers.cancel(id);
}

#[tauri::command]
pub fn retry_transfer(transfers: State<'_, AppTransfers>, id: TransferId) {
    transfers.retry(id);
}

#[tauri::command]
pub fn pause_all_transfers(transfers: State<'_, AppTransfers>) {
    transfers.pause_all();
}

#[tauri::command]
pub fn resume_all_transfers(transfers: State<'_, AppTransfers>) {
    transfers.resume_all();
}

#[tauri::command]
pub fn remove_finished_transfers(transfers: State<'_, AppTransfers>) {
    transfers.remove_finished();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_errors_without_empty_service() {
        let json = serde_json::to_string(&CommandError::from(StoreError::Timeout)).unwrap();
        assert_eq!(
            json,
            r#"{"kind":"timeout","message":"Zeitüberschreitung beim Warten auf den Endpunkt"}"#
        );
    }

    #[test]
    fn converts_and_validates_credential_input() {
        let input: CredentialsInput = serde_json::from_str(r#"{"accessKeyId":" a ","secretAccessKey":"b"}"#).unwrap();
        let converted = credentials(Some(input)).unwrap().unwrap();
        assert_eq!(converted.access_key_id(), "a");
        assert_eq!(credentials(None).unwrap(), None);
        let empty = CredentialsInput {
            access_key_id: String::new(),
            secret_access_key: "b".into(),
            session_token: None,
        };
        assert_eq!(credentials(Some(empty)).unwrap_err().kind, "invalidConfig");
    }

    #[test]
    fn lists_all_presets() {
        assert_eq!(list_presets().len(), PRESETS.len());
    }
}
