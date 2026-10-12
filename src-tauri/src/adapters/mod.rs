//! Adapter: Implementierungen der Ports für die echte Außenwelt.

pub mod checksum;
pub mod clock;
pub mod commands;
pub mod credential_store;
pub mod json_file;
pub mod local_files;
pub mod profile_file;
pub mod s3;
pub mod settings_file;
#[cfg(windows)]
pub mod share_sheet;
pub mod sqlite_cache;
pub mod tauri_runtime;
pub mod unsupported_share_sheet;

/// Teilen-Dialog des Systems: unter Windows der echte, sonst einer, der ablehnt.
#[cfg(windows)]
pub type NativeShareSheet = share_sheet::WindowsShareSheet;
#[cfg(not(windows))]
pub type NativeShareSheet = unsupported_share_sheet::UnsupportedShareSheet;
