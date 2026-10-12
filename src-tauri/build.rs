// Build-Skript: Tauri-Ressourcen und Windows-Manifest.
//
// tauri-build bettet sein Manifest nur in die App-EXE ein. Test-Binärdateien brauchen es aber
// ebenso (Common-Controls 6 für den Dateidialog). Deshalb übernimmt der Linker das Einbetten
// für alle Ziele, und tauri-build verzichtet auf sein eigenes Manifest.

const MANIFEST: &str = "windows-app-manifest.xml";

fn main() {
    let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
    if let Err(error) = tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows)) {
        panic!("tauri-build fehlgeschlagen: {error:#}");
    }
    embed_windows_manifest();
}

fn embed_windows_manifest() {
    let target_is_msvc = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if !target_is_msvc {
        return;
    }
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(MANIFEST);
    println!("cargo:rerun-if-changed={MANIFEST}");
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
}
