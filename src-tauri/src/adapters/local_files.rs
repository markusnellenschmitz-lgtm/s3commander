//! Lokales Dateisystem: gewählte oder hineingezogene Dateien und Ordner auflösen,
//! Teildateien von Downloads anlegen, fertigstellen und löschen, Ordner durchsuchen.
//! Symbolische Links und Verzeichnis-Abzweigungen werden übersprungen, damit Schleifen
//! nicht endlos laufen und nichts außerhalb der Auswahl hochgeladen wird.

use super::checksum::{DigestKind, digest_file};
use crate::domain::error::StoreError;
use crate::domain::local_dir::{FILE_SYSTEM_LABEL, HOME_LABEL, LocalEntry};
use crate::domain::local_path::numbered_path;
use crate::domain::transfer::{FileRange, LocalFile};
use crate::ports::{LocalDirectories, LocalFiles};
use std::fs::{self, Metadata, OpenOptions};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, Default)]
pub struct StdLocalFiles;

fn local_error(path: &Path, error: &std::io::Error) -> StoreError {
    StoreError::LocalFile(format!("{}: {error}", path.display()))
}

/// Millisekunden seit Epoch; Zeiten vor 1970 zählen als 0.
fn epoch_ms(time: SystemTime) -> i64 {
    let since_epoch = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    i64::try_from(since_epoch.as_millis()).unwrap_or(i64::MAX)
}

/// Versteckte und Systemdateien (z. B. `desktop.ini`, `System Volume Information`) bleiben unsichtbar.
#[cfg(windows)]
fn is_hidden(meta: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const HIDDEN: u32 = 0x2;
    const SYSTEM: u32 = 0x4;
    meta.file_attributes() & (HIDDEN | SYSTEM) != 0
}

#[cfg(not(windows))]
fn is_hidden(_meta: &Metadata) -> bool {
    false
}

fn local_entry(path: &Path, meta: &Metadata) -> LocalEntry {
    LocalEntry {
        name: file_name(path),
        path: path.display().to_string(),
        is_dir: meta.is_dir(),
        size: if meta.is_dir() { 0 } else { meta.len() },
        modified_ms: meta.modified().ok().map(epoch_ms),
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned())
}

fn local_file(path: &Path, relative: String, meta: &Metadata) -> LocalFile {
    LocalFile {
        path: path.to_path_buf(),
        relative,
        size: meta.len(),
        content_type: mime_guess::from_path(path)
            .first_or_octet_stream()
            .essence_str()
            .to_owned(),
        modified_ms: meta.modified().ok().map(epoch_ms),
    }
}

/// Sammelt alle Dateien unter `dir`; `relative` ist der Pfad von `dir` relativ zur Auswahl.
fn walk(dir: &Path, relative: &str, out: &mut Vec<LocalFile>) -> Result<(), StoreError> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| local_error(dir, &e))?
        .collect::<Result<_, _>>()
        .map_err(|e| local_error(dir, &e))?;
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(|e| local_error(&path, &e))?;
        let child = format!("{relative}/{}", file_name(&path));
        if meta.is_dir() {
            walk(&path, &child, out)?;
        } else if meta.is_file() {
            out.push(local_file(&path, child, &meta));
        }
    }
    Ok(())
}

/// Erster freier Name: das Ziel selbst, sonst `name (2).ext`, `name (3).ext` …
fn free_path(target: &Path) -> PathBuf {
    std::iter::once(target.to_path_buf())
        .chain((2..=u32::MAX).map(|n| numbered_path(target, n)))
        .find(|candidate| !candidate.exists())
        .unwrap_or_else(|| target.to_path_buf())
}

impl LocalFiles for StdLocalFiles {
    fn prepare_download(&self, partial: &Path, size: u64) -> Result<bool, StoreError> {
        let error = |e: std::io::Error| local_error(partial, &e);
        if let Some(parent) = partial.parent() {
            fs::create_dir_all(parent).map_err(|e| local_error(parent, &e))?;
        }
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(partial)
            .map_err(error)?;
        let reusable = file.metadata().map_err(error)?.len() == size && size > 0;
        file.set_len(size).map_err(error)?;
        Ok(reusable)
    }

    fn complete_download(&self, partial: &Path, target: &Path, overwrite: bool) -> Result<PathBuf, StoreError> {
        // rename ersetzt unter Windows ein vorhandenes Ziel (MoveFileEx mit REPLACE_EXISTING).
        let path = if overwrite {
            target.to_path_buf()
        } else {
            free_path(target)
        };
        fs::rename(partial, &path).map_err(|e| local_error(&path, &e))?;
        Ok(path)
    }

    fn modified_ms(&self, path: &Path) -> Result<Option<i64>, StoreError> {
        let modified = match fs::metadata(path) {
            Ok(meta) => meta.modified().map_err(|e| local_error(path, &e))?,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(local_error(path, &e)),
        };
        Ok(Some(epoch_ms(modified)))
    }

    fn set_modified_ms(&self, path: &Path, modified_ms: i64) -> Result<(), StoreError> {
        let since_epoch = std::time::Duration::from_millis(u64::try_from(modified_ms).unwrap_or(0));
        OpenOptions::new()
            .write(true)
            .open(path)
            .and_then(|file| file.set_modified(UNIX_EPOCH + since_epoch))
            .map_err(|e| local_error(path, &e))
    }

    async fn md5_hex(&self, path: &Path) -> Result<String, StoreError> {
        let length = tokio::fs::metadata(path)
            .await
            .map_err(|e| local_error(path, &e))?
            .len();
        let range = FileRange {
            path: path.to_path_buf(),
            offset: 0,
            length,
        };
        Ok(digest_file(DigestKind::Md5, &range).await?.hex())
    }

    fn discard_download(&self, partial: &Path) -> Result<(), StoreError> {
        match fs::remove_file(partial) {
            Err(e) if e.kind() != ErrorKind::NotFound => Err(local_error(partial, &e)),
            _ => Ok(()),
        }
    }

    fn expand(&self, paths: &[PathBuf]) -> Result<Vec<LocalFile>, StoreError> {
        let mut files = Vec::new();
        for path in paths {
            let meta = fs::symlink_metadata(path).map_err(|e| local_error(path, &e))?;
            if meta.is_dir() {
                walk(path, &file_name(path), &mut files)?;
            } else if meta.is_file() {
                files.push(local_file(path, file_name(path), &meta));
            }
        }
        Ok(files)
    }
}

/// Oberste Ebene unter Linux: persönlicher Ordner, Dateisystem `/` und jeder Unterordner der
/// Einhängeorte (`volume_dirs`), etwa USB-Sticks unter `/media/<Nutzer>`.
#[must_use]
pub fn unix_roots(home: Option<&Path>, volume_dirs: &[PathBuf]) -> Vec<LocalEntry> {
    let home = home
        .filter(|dir| dir.is_dir())
        .map(|dir| LocalEntry::root(HOME_LABEL, &dir.display().to_string()));
    let volumes = volume_dirs
        .iter()
        .filter_map(|dir| fs::read_dir(dir).ok())
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .map(|path| LocalEntry::root(&file_name(&path), &path.display().to_string()));
    home.into_iter()
        .chain(std::iter::once(LocalEntry::root(FILE_SYSTEM_LABEL, "/")))
        .chain(volumes)
        .collect()
}

/// Wo Linux-Desktops Datenträger einhängen.
#[cfg(not(windows))]
fn volume_dirs() -> Vec<PathBuf> {
    let user = std::env::var("USER").unwrap_or_default();
    let mut dirs = vec![PathBuf::from("/mnt")];
    if !user.is_empty() {
        dirs.push(Path::new("/media").join(&user));
        dirs.push(Path::new("/run/media").join(&user));
    }
    dirs
}

impl LocalDirectories for StdLocalFiles {
    #[cfg(windows)]
    fn roots(&self) -> Vec<LocalEntry> {
        ('A'..='Z')
            .filter(|letter| Path::new(&format!("{letter}:\\")).exists())
            .map(LocalEntry::drive)
            .collect()
    }

    #[cfg(not(windows))]
    fn roots(&self) -> Vec<LocalEntry> {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        unix_roots(home.as_deref(), &volume_dirs())
    }

    /// Einträge, deren Metadaten nicht lesbar sind (gesperrt, gerade gelöscht), fehlen still.
    fn list(&self, dir: &Path) -> Result<Vec<LocalEntry>, StoreError> {
        let entries = fs::read_dir(dir).map_err(|e| local_error(dir, &e))?;
        Ok(entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let meta = entry.metadata().ok()?;
                (!is_hidden(&meta)).then(|| local_entry(&entry.path(), &meta))
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sets_the_modification_time_and_reports_it_back() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("abgleich.txt");
        fs::write(&file, b"x").unwrap();
        StdLocalFiles.set_modified_ms(&file, 1_700_000_000_000).unwrap();
        assert_eq!(StdLocalFiles.modified_ms(&file).unwrap(), Some(1_700_000_000_000));
        let listed = StdLocalFiles.expand(&[file]).unwrap();
        assert_eq!(listed[0].modified_ms, Some(1_700_000_000_000));
        assert!(StdLocalFiles.set_modified_ms(&dir.path().join("fehlt"), 0).is_err());
    }

    #[tokio::test]
    async fn hashes_whole_files_as_hex_md5() {
        let dir = tempfile::tempdir().unwrap();
        let empty = dir.path().join("leer.bin");
        fs::write(&empty, b"").unwrap();
        assert_eq!(
            StdLocalFiles.md5_hex(&empty).await.unwrap(),
            "d41d8cd98f00b204e9800998ecf8427e"
        );
        assert!(StdLocalFiles.md5_hex(&dir.path().join("fehlt")).await.is_err());
    }

    #[test]
    fn lists_folder_contents_with_size_and_time() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("unterordner")).unwrap();
        fs::write(dir.path().join("datei.txt"), b"hallo").unwrap();
        let mut entries = StdLocalFiles.list(dir.path()).unwrap();
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        let summary: Vec<_> = entries.iter().map(|e| (e.name.as_str(), e.is_dir, e.size)).collect();
        assert_eq!(summary, [("datei.txt", false, 5), ("unterordner", true, 0)]);
        assert!(entries[0].modified_ms.is_some_and(|ms| ms > 0));
        assert!(entries[0].path.ends_with("datei.txt"));
        assert!(StdLocalFiles.list(&dir.path().join("fehlt")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn hides_hidden_files_and_finds_the_system_drive() {
        let dir = tempfile::tempdir().unwrap();
        let hidden = dir.path().join("versteckt.ini");
        fs::write(&hidden, b"x").unwrap();
        let status = std::process::Command::new("attrib")
            .arg("+h")
            .arg(&hidden)
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(StdLocalFiles.list(dir.path()).unwrap(), Vec::new());
        assert!(StdLocalFiles.roots().iter().any(|d| d.path == "C:\\"));
    }

    #[cfg(not(windows))]
    #[test]
    fn offers_the_file_system_root_on_linux() {
        assert!(StdLocalFiles.roots().iter().any(|root| root.path == "/"));
    }

    #[test]
    fn lists_home_file_system_and_mounted_volumes_as_unix_roots() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let media = dir.path().join("media");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(media.join("USB-STICK")).unwrap();
        fs::write(media.join("keine-platte.txt"), b"x").unwrap();
        let roots = unix_roots(Some(&home), &[media.clone(), dir.path().join("fehlt")]);
        let summary: Vec<_> = roots.iter().map(|r| (r.name.as_str(), r.path.clone())).collect();
        assert_eq!(
            summary,
            [
                ("Persönlicher Ordner", home.display().to_string()),
                ("Dateisystem", "/".to_owned()),
                ("USB-STICK", media.join("USB-STICK").display().to_string()),
            ]
        );
        assert_eq!(unix_roots(Some(&dir.path().join("fehlt")), &[]).len(), 1);
    }

    #[test]
    fn expands_files_and_folders_with_relative_paths() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("fotos");
        fs::create_dir_all(root.join("2026").join("oktober")).unwrap();
        fs::write(root.join("2026").join("oktober").join("bild.jpg"), b"jpeg").unwrap();
        fs::write(root.join("liesmich.txt"), b"hallo").unwrap();
        let single = dir.path().join("einzeln.zip");
        fs::write(&single, b"zip!").unwrap();

        let files = StdLocalFiles.expand(&[root, single]).unwrap();
        let summary: Vec<_> = files
            .iter()
            .map(|f| (f.relative.as_str(), f.size, f.content_type.as_str()))
            .collect();
        assert_eq!(
            summary,
            [
                ("fotos/2026/oktober/bild.jpg", 4, "image/jpeg"),
                ("fotos/liesmich.txt", 5, "text/plain"),
                ("einzeln.zip", 4, "application/zip"),
            ]
        );
    }

    #[test]
    fn uses_octet_stream_for_unknown_types_and_skips_empty_folders() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("leer")).unwrap();
        let file = dir.path().join("000000010000004A000000C3");
        fs::write(&file, b"wal").unwrap();
        let files = StdLocalFiles.expand(&[dir.path().join("leer"), file]).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].content_type, "application/octet-stream");
    }

    #[test]
    fn reports_missing_paths() {
        let result = StdLocalFiles.expand(&[PathBuf::from("X:\\gibt\\es\\nicht.txt")]);
        let Err(StoreError::LocalFile(message)) = result else {
            panic!("Fehler erwartet")
        };
        assert!(message.contains("nicht.txt"));
    }

    #[test]
    fn prepares_partial_files_with_folders_and_keeps_existing_content() {
        let dir = tempfile::tempdir().unwrap();
        let partial = dir.path().join("neu").join("unter").join("a.bin.s3part");
        assert!(!StdLocalFiles.prepare_download(&partial, 8).unwrap(), "neue Teildatei");
        assert_eq!(fs::metadata(&partial).unwrap().len(), 8);
        fs::write(&partial, b"12345678").unwrap();
        assert!(StdLocalFiles.prepare_download(&partial, 8).unwrap(), "weiterverwendbar");
        assert_eq!(fs::read(&partial).unwrap(), b"12345678");
        assert!(!StdLocalFiles.prepare_download(&partial, 4).unwrap(), "andere Größe");
        assert_eq!(fs::metadata(&partial).unwrap().len(), 4);
    }

    #[test]
    fn completes_downloads_without_overwriting_existing_files() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("bild.jpg");
        fs::write(&target, b"alt").unwrap();
        fs::write(dir.path().join("bild (2).jpg"), b"auch alt").unwrap();
        let partial = dir.path().join("bild.jpg.s3part");
        fs::write(&partial, b"neu").unwrap();
        let done = StdLocalFiles.complete_download(&partial, &target, false).unwrap();
        assert_eq!(done, dir.path().join("bild (3).jpg"));
        assert_eq!(fs::read(&done).unwrap(), b"neu");
        assert_eq!(fs::read(&target).unwrap(), b"alt");
        assert!(!partial.exists());
    }

    #[test]
    fn overwrites_on_request_and_reads_modification_times() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("bild.jpg");
        assert_eq!(StdLocalFiles.modified_ms(&target).unwrap(), None);
        fs::write(&target, b"alt").unwrap();
        let modified = StdLocalFiles.modified_ms(&target).unwrap().unwrap();
        assert!(modified > 1_700_000_000_000, "{modified}");
        let partial = dir.path().join("bild.jpg.s3part");
        fs::write(&partial, b"neu").unwrap();
        assert_eq!(
            StdLocalFiles.complete_download(&partial, &target, true).unwrap(),
            target
        );
        assert_eq!(fs::read(&target).unwrap(), b"neu");
    }

    #[test]
    fn discards_partial_files_and_ignores_missing_ones() {
        let dir = tempfile::tempdir().unwrap();
        let partial = dir.path().join("x.s3part");
        fs::write(&partial, b"x").unwrap();
        StdLocalFiles.discard_download(&partial).unwrap();
        assert!(!partial.exists());
        StdLocalFiles.discard_download(&partial).unwrap();
    }

    #[test]
    fn reports_file_system_errors_for_downloads() {
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("datei");
        fs::write(&blocker, b"x").unwrap();
        let below_file = blocker.join("a.s3part");
        assert!(StdLocalFiles.prepare_download(&below_file, 1).is_err());
        assert!(
            StdLocalFiles
                .complete_download(&below_file, &blocker.join("a"), false)
                .is_err()
        );
        assert!(
            StdLocalFiles.discard_download(dir.path()).is_err(),
            "Ordner sind keine Teildateien"
        );
    }

    #[test]
    fn names_paths_without_file_name() {
        assert_eq!(file_name(Path::new("C:\\")), "C:\\");
    }
}
