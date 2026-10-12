//! Adapter: Implementierungen der Ports für die echte Außenwelt.

pub mod checksum;
pub mod clock;
#[cfg(windows)]
pub mod commands;
#[cfg(windows)]
pub mod credential_store;
pub mod json_file;
pub mod local_files;
pub mod profile_file;
pub mod s3;
pub mod settings_file;
pub mod sqlite_cache;
pub mod tauri_runtime;
