// Verhindert im Release ein zusätzliches Konsolenfenster unter Windows. Nicht entfernen.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::ExitCode;

fn main() -> ExitCode {
    match s3_commander_lib::run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("S3 Commander konnte nicht starten: {error}");
            ExitCode::FAILURE
        }
    }
}
