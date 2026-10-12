//! Anwendungsfall: lokale Ordner für die Zwei-Panel-Ansicht durchsuchen. Ohne Pfad gibt es die
//! Laufwerke („Dieser PC“), sonst den Inhalt des Ordners.

use super::error::AppError;
use crate::domain::local_dir::LocalEntry;
use crate::ports::LocalDirectories;
use std::path::Path;

/// # Errors
/// `LocalFile`, wenn der Ordner nicht gelesen werden kann.
pub fn list_local<D: LocalDirectories>(dirs: &D, path: Option<&str>) -> Result<Vec<LocalEntry>, AppError> {
    match path {
        None | Some("") => Ok(dirs.roots()),
        Some(dir) => Ok(dirs.list(Path::new(dir))?),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::error::StoreError;
    use std::path::PathBuf;
    use std::sync::Mutex;

    #[derive(Debug, Default)]
    struct FakeDirectories {
        listed: Mutex<Vec<PathBuf>>,
    }

    impl LocalDirectories for FakeDirectories {
        fn roots(&self) -> Vec<LocalEntry> {
            vec![LocalEntry::drive('C'), LocalEntry::drive('D')]
        }

        fn list(&self, dir: &Path) -> Result<Vec<LocalEntry>, StoreError> {
            self.listed.lock().unwrap().push(dir.to_path_buf());
            if dir == Path::new("X:\\") {
                return Err(StoreError::LocalFile("X:\\ nicht bereit".into()));
            }
            Ok(Vec::new())
        }
    }

    #[test]
    fn lists_drives_without_a_path_and_folders_otherwise() {
        let dirs = FakeDirectories::default();
        assert_eq!(list_local(&dirs, None).unwrap().len(), 2);
        assert_eq!(list_local(&dirs, Some("")).unwrap().len(), 2);
        assert_eq!(list_local(&dirs, Some("D:\\Backups")).unwrap(), Vec::new());
        assert_eq!(*dirs.listed.lock().unwrap(), [PathBuf::from("D:\\Backups")]);
        assert!(matches!(
            list_local(&dirs, Some("X:\\")),
            Err(AppError::Store(StoreError::LocalFile(_)))
        ));
    }
}
