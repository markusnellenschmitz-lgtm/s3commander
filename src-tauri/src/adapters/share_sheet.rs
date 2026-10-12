//! Teilen-Dialog von Windows (`DataTransferManager`) für das Hauptfenster.
//! Windows fragt die Daten erst an, wenn der Dialog sie braucht; der Adapter hält deshalb
//! genau einen Handler für den zuletzt geteilten Link.

// Die COM-Schnittstelle IDataTransferManagerInterop lässt sich nur über unsafe aufrufen; einzige
// Ausnahme von `unsafe_code = "deny"` im Projekt.
#![allow(unsafe_code)]

use crate::domain::share::{ShareError, SharedLink};
use crate::ports::ShareSheet;
use std::ffi::c_void;
use std::sync::{Mutex, PoisonError};
use windows::ApplicationModel::DataTransfer::{DataPackage, DataRequestedEventArgs, DataTransferManager};
use windows::Foundation::{TypedEventHandler, Uri};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Shell::IDataTransferManagerInterop;
use windows::core::{HSTRING, Ref, factory};

#[derive(Debug)]
pub struct WindowsShareSheet {
    /// Fensterhandle als Zahl, weil `HWND` nicht zwischen Threads geteilt werden darf.
    window: isize,
    /// Anmeldung des Handlers für den aktuellen Link.
    registration: Mutex<Option<i64>>,
}

impl WindowsShareSheet {
    /// Teilen-Dialog für das Fenster mit diesem Handle.
    #[must_use]
    pub fn new(window: isize) -> Self {
        Self {
            window,
            registration: Mutex::new(None),
        }
    }

    fn hwnd(&self) -> HWND {
        HWND(self.window as *mut c_void)
    }

    /// Muss auf dem Thread des Fensters laufen (synchrone Tauri-Befehle tun das).
    fn try_show(&self, link: &SharedLink) -> windows::core::Result<()> {
        let interop = factory::<DataTransferManager, IDataTransferManagerInterop>()?;
        // SAFETY: Das Handle stammt vom Hauptfenster, das so lange lebt wie die Anwendung.
        let manager: DataTransferManager = unsafe { interop.GetForWindow(self.hwnd())? };
        let mut registration = self.registration.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(previous) = registration.take() {
            manager.RemoveDataRequested(previous)?;
        }
        let shared = link.clone();
        let handler = TypedEventHandler::new(move |_, args: Ref<DataRequestedEventArgs>| {
            fill_package(&args.ok()?.Request()?.Data()?, &shared)
        });
        *registration = Some(manager.DataRequested(&handler)?);
        // SAFETY: wie oben.
        unsafe { interop.ShowShareUIForWindow(self.hwnd()) }
    }
}

impl ShareSheet for WindowsShareSheet {
    fn show(&self, link: &SharedLink) -> Result<(), ShareError> {
        self.try_show(link)
            .map_err(|error| ShareError::Platform(error.to_string()))
    }
}

/// Titel und Link so, dass Mail, Messenger und QR-Code ihn als Weblink erkennen.
fn fill_package(package: &DataPackage, link: &SharedLink) -> windows::core::Result<()> {
    package.Properties()?.SetTitle(&HSTRING::from(link.title()))?;
    package.SetWebLink(&Uri::CreateUri(&HSTRING::from(link.url()))?)?;
    package.SetText(&HSTRING::from(link.url()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::ApplicationModel::DataTransfer::StandardDataFormats;

    #[test]
    fn fills_title_web_link_and_text() {
        let package = DataPackage::new().unwrap();
        let link = SharedLink::new("bericht.pdf", "https://b.example.com/bericht.pdf?X-Amz-Expires=60").unwrap();
        fill_package(&package, &link).unwrap();
        let view = package.GetView().unwrap();
        assert_eq!(view.Properties().unwrap().Title().unwrap(), "bericht.pdf");
        for format in [StandardDataFormats::WebLink(), StandardDataFormats::Text()] {
            assert!(view.Contains(&format.unwrap()).unwrap());
        }
    }

    #[test]
    fn reports_a_missing_window_as_platform_error() {
        let sheet = WindowsShareSheet::new(0);
        let link = SharedLink::new("a", "https://host/a").unwrap();
        assert!(matches!(sheet.show(&link), Err(ShareError::Platform(_))));
    }
}
