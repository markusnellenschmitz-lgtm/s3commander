//! S3 Commander – Backend.
//!
//! Architektur: hexagonal (Ports & Adapters), siehe `CONTRIBUTING.md` im Projektwurzelverzeichnis.
//! - `domain`: reine Typen und Regeln
//! - `ports`: Schnittstellen nach außen
//! - `application`: Anwendungsfälle
//! - `adapters`: Implementierungen der Ports (S3 über HTTP, Speicher für Zugangsdaten des Systems,
//!   Uhr, Profildatei, lokale Dateien, Tauri-Laufzeit) und die Tauri-Befehle als treibender Adapter
//!
//! Läuft unter Windows und Linux. Was sich unterscheidet, steckt in den Adaptern
//! (`credential_store`, `NativeShareSheet`, `local_files`) und in `build_share_sheet`.
//!
//! Diese Datei ist die Kompositionswurzel und verdrahtet Adapter mit Anwendungsfällen.

pub mod adapters;
pub mod application;
pub mod domain;
pub mod ports;

use adapters::NativeShareSheet;
use adapters::clock::SystemClock;
use adapters::commands::{
    self, AppDeletes, AppDetails, AppFolders, AppNaming, AppService, AppSettingsService, AppSync, SharedService,
    Transfers,
};
use adapters::credential_store::{DEFAULT_SERVICE, KeyringCredentialStore};
use adapters::local_files::StdLocalFiles;
use adapters::profile_file::{JsonProfileRepository, PROFILE_FILE_NAME};
use adapters::s3::factory::HttpStoreFactory;
use adapters::settings_file::{JsonSettingsRepository, SETTINGS_FILE_NAME};

use adapters::sqlite_cache::{CACHE_FILE_NAME, SqliteListingCache};
use adapters::tauri_runtime::{TauriSpawner, TauriTransferEvents};
use application::connections::ConnectionService;
use application::copy::CopySettings;
use application::deletion::{DeleteService, DeleteSettings};
use application::details::DetailsService;
use application::folders::FolderService;
use application::naming::{NamingService, NamingSettings};
use application::settings::SettingsService;
use application::sync::SyncService;
use application::transfers::{TransferManager, TransferSettings};
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime};

/// Baut den Anwendungsdienst mit den echten Adaptern.
#[must_use]
pub fn build_service(config_dir: &Path) -> AppService {
    ConnectionService::new(
        JsonProfileRepository::new(config_dir.join(PROFILE_FILE_NAME)),
        KeyringCredentialStore::native(DEFAULT_SERVICE),
        HttpStoreFactory::new(SystemClock),
        SystemClock,
    )
}

/// Baut den Einstellungsdienst; die Datei liegt neben den Profilen.
#[must_use]
pub fn build_settings(config_dir: &Path) -> AppSettingsService {
    SettingsService::new(JsonSettingsRepository::new(config_dir.join(SETTINGS_FILE_NAME)))
}

/// Baut die Transfer-Verwaltung; sie teilt sich die S3-Clients mit dem Verbindungsdienst.
#[must_use]
pub fn build_transfers<R: Runtime>(
    service: &SharedService,
    app: AppHandle<R>,
    settings: TransferSettings,
) -> Transfers<R> {
    TransferManager::new(
        Arc::clone(service),
        StdLocalFiles,
        TauriTransferEvents::new(app),
        TauriSpawner,
        SystemClock,
        settings,
    )
}

/// Baut den Dienst für Löschaufträge; er teilt sich die S3-Clients mit dem Verbindungsdienst.
#[must_use]
pub fn build_deletes(service: &SharedService) -> AppDeletes {
    DeleteService::new(Arc::clone(service), DeleteSettings::default())
}

/// Baut den Dienst zum Anlegen und Umbenennen von Ordnern und Objekten.
#[must_use]
pub fn build_naming(service: &SharedService) -> AppNaming {
    NamingService::new(Arc::clone(service), NamingSettings::default())
}

/// Baut den Ordner-Dienst mit Listing-Cache. Lässt sich die Cache-Datei nicht öffnen, läuft der
/// Cache bis zum nächsten Start nur im Arbeitsspeicher.
///
/// # Errors
/// Wenn auch der Cache im Arbeitsspeicher nicht startet.
pub fn build_folders(
    service: &SharedService,
    cache_dir: &Path,
    cache_enabled: bool,
) -> Result<AppFolders, domain::error::CacheError> {
    let cache = SqliteListingCache::open(&cache_dir.join(CACHE_FILE_NAME)).or_else(|error| {
        log::warn!("Listing-Cache nur im Arbeitsspeicher: {error}");
        SqliteListingCache::in_memory()
    })?;
    Ok(FolderService::new(
        Arc::clone(service),
        cache,
        SystemClock,
        cache_enabled,
    ))
}

/// Baut den Abgleich lokal ↔ Bucket; er teilt sich die S3-Clients mit dem Verbindungsdienst.
#[must_use]
pub fn build_sync(service: &SharedService) -> AppSync {
    SyncService::new(Arc::clone(service), StdLocalFiles)
}

/// Baut den Dienst für Objekt-Details.
#[must_use]
pub fn build_details(service: &SharedService) -> AppDetails {
    DetailsService::new(Arc::clone(service), CopySettings::default())
}

/// Name des Hauptfensters aus `tauri.conf.json`.
#[cfg(windows)]
const MAIN_WINDOW: &str = "main";

/// Teilen-Dialog für das Hauptfenster.
#[cfg(windows)]
fn build_share_sheet(app: &tauri::App) -> tauri::Result<NativeShareSheet> {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or(tauri::Error::WindowNotFound)?;
    Ok(NativeShareSheet::new(window.hwnd()?.0 as isize))
}

/// Ohne Teilen-Dialog des Systems.
#[cfg(not(windows))]
#[allow(clippy::unnecessary_wraps)] // Gleiche Signatur wie die Windows-Fassung.
fn build_share_sheet(_app: &tauri::App) -> tauri::Result<NativeShareSheet> {
    Ok(NativeShareSheet::default())
}

/// Startet die Anwendung und blockiert, bis das letzte Fenster geschlossen ist.
///
/// # Errors
///
/// Gibt den Fehler von Tauri zurück, wenn das Fenster oder die Laufzeit nicht starten.
pub fn run() -> tauri::Result<()> {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let config_dir = app.path().app_config_dir()?;
            let service: SharedService = Arc::new(build_service(&config_dir));
            let settings = build_settings(&config_dir);
            let settings_cache_enabled = settings.current().cache.enabled;
            let transfers = build_transfers(
                &service,
                app.handle().clone(),
                TransferSettings::from(&settings.current().transfers),
            );
            app.manage(settings);
            transfers.start_ticker();
            app.manage(build_deletes(&service));
            app.manage(build_naming(&service));
            app.manage(build_details(&service));
            app.manage(build_sync(&service));
            app.manage(build_share_sheet(app)?);
            let cache_dir = app.path().app_cache_dir()?;
            app.manage(build_folders(&service, &cache_dir, settings_cache_enabled)?);
            app.manage(service);
            app.manage(transfers);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_presets,
            commands::get_settings,
            commands::save_settings,
            commands::list_profiles,
            commands::save_profile,
            commands::delete_profile,
            commands::test_connection,
            commands::list_buckets,
            commands::list_folder,
            commands::cancel_listing,
            commands::cache_stats,
            commands::list_local_dir,
            commands::plan_sync,
            commands::start_sync,
            commands::clear_listing_cache,
            commands::prepare_delete,
            commands::delete_objects,
            commands::cancel_delete,
            commands::discard_delete,
            commands::create_folder,
            commands::rename_object,
            commands::object_head,
            commands::save_object_metadata,
            commands::object_tags,
            commands::save_object_tags,
            commands::object_versions,
            commands::restore_object_version,
            commands::delete_object_version,
            commands::object_acl,
            commands::presign_object,
            commands::share_link,
            commands::enqueue_uploads,
            commands::enqueue_downloads,
            commands::enqueue_copies,
            commands::list_transfers,
            commands::pause_transfer,
            commands::resume_transfer,
            commands::cancel_transfer,
            commands::retry_transfer,
            commands::pause_all_transfers,
            commands::resume_all_transfers,
            commands::remove_finished_transfers,
        ])
        .run(tauri::generate_context!())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_service_with_real_adapters() {
        let _guard = adapters::credential_store::lock_native_store();
        let dir = tempfile::tempdir().unwrap();
        let service = build_service(dir.path());
        assert_eq!(service.list_profiles().unwrap(), Vec::new());
    }

    #[test]
    fn builds_the_transfer_manager_sharing_the_service() {
        let _guard = adapters::credential_store::lock_native_store();
        let dir = tempfile::tempdir().unwrap();
        let service: SharedService = Arc::new(build_service(dir.path()));
        let app = tauri::test::mock_app();
        let transfers = build_transfers(&service, app.handle().clone(), TransferSettings::default());
        assert_eq!(transfers.snapshots(), Vec::new());
        assert_eq!(Arc::strong_count(&service), 2);
    }

    #[test]
    fn builds_the_settings_service_from_the_config_folder() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            build_settings(dir.path()).current(),
            domain::settings::AppSettings::default()
        );
    }

    #[test]
    fn builds_the_delete_service_sharing_the_service() {
        let _guard = adapters::credential_store::lock_native_store();
        let dir = tempfile::tempdir().unwrap();
        let service: SharedService = Arc::new(build_service(dir.path()));
        let deletes = build_deletes(&service);
        assert!(!deletes.cancel("delete-1"));
        let _naming = build_naming(&service);
        let _details = build_details(&service);
        assert_eq!(Arc::strong_count(&service), 4);
    }
}
