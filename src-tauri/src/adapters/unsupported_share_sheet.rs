//! Teilen-Dialog für Systeme ohne einen solchen (Linux): lehnt jedes Teilen ab. Die Oberfläche
//! blendet „Teilen …“ dort aus; der Adapter sichert nur ab, falls der Befehl trotzdem kommt.

use crate::domain::share::{ShareError, SharedLink};
use crate::ports::ShareSheet;

#[derive(Debug, Default)]
pub struct UnsupportedShareSheet;

impl ShareSheet for UnsupportedShareSheet {
    fn show(&self, _link: &SharedLink) -> Result<(), ShareError> {
        Err(ShareError::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_to_share() {
        let link = SharedLink::new("a.txt", "https://host/a.txt").unwrap();
        assert_eq!(UnsupportedShareSheet.show(&link), Err(ShareError::Unsupported));
    }
}
