//! Anwendungsfall „Teilen“: einen Link geprüft an den Teilen-Dialog des Systems geben.

use crate::application::error::AppError;
use crate::domain::share::SharedLink;
use crate::ports::ShareSheet;

/// # Errors
/// `Share`, wenn der Link ungültig ist oder der Dialog nicht geöffnet werden kann.
pub fn share_link<S: ShareSheet>(sheet: &S, title: &str, url: &str) -> Result<(), AppError> {
    Ok(sheet.show(&SharedLink::new(title, url)?)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::share::ShareError;
    use std::sync::Mutex;

    #[derive(Debug, Default)]
    struct FakeSheet {
        shown: Mutex<Vec<SharedLink>>,
        fail: bool,
    }

    impl ShareSheet for FakeSheet {
        fn show(&self, link: &SharedLink) -> Result<(), ShareError> {
            if self.fail {
                return Err(ShareError::Platform("E_FAIL".into()));
            }
            self.shown.lock().unwrap().push(link.clone());
            Ok(())
        }
    }

    #[test]
    fn shows_valid_links_in_the_share_sheet() {
        let sheet = FakeSheet::default();
        share_link(&sheet, "a.txt", "https://host/a.txt").unwrap();
        assert_eq!(
            *sheet.shown.lock().unwrap(),
            [SharedLink::new("a.txt", "https://host/a.txt").unwrap()]
        );
    }

    #[test]
    fn rejects_invalid_links_before_the_sheet_and_passes_platform_errors_through() {
        let sheet = FakeSheet::default();
        assert!(matches!(
            share_link(&sheet, "a", "localhost"),
            Err(AppError::Share(ShareError::InvalidLink(_)))
        ));
        assert!(sheet.shown.lock().unwrap().is_empty());
        let failing = FakeSheet {
            fail: true,
            ..FakeSheet::default()
        };
        assert!(matches!(
            share_link(&failing, "a", "https://host/a"),
            Err(AppError::Share(ShareError::Platform(_)))
        ));
    }
}
