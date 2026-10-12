//! Adapter zur Tauri-Laufzeit: Events an die Oberfläche und Hintergrundaufgaben.

use crate::domain::transfer::TransferUpdate;
use crate::ports::{BoxFuture, Spawner, TransferEvents};
use tauri::{AppHandle, Emitter, Runtime};

/// Name des Events, über das die Oberfläche geänderte und entfernte Transfers erhält.
pub const TRANSFERS_EVENT: &str = "transfers";

#[derive(Debug, Clone)]
pub struct TauriTransferEvents<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> TauriTransferEvents<R> {
    #[must_use]
    pub fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> TransferEvents for TauriTransferEvents<R> {
    fn publish(&self, update: TransferUpdate) {
        if let Err(error) = self.app.emit(TRANSFERS_EVENT, update) {
            log::warn!("Transfer-Stand nicht gemeldet: {error}");
        }
    }
}

/// Startet Aufgaben auf der asynchronen Laufzeit von Tauri (Tokio).
#[derive(Debug, Clone, Copy, Default)]
pub struct TauriSpawner;

impl Spawner for TauriSpawner {
    fn spawn(&self, task: BoxFuture) {
        tauri::async_runtime::spawn(task);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::Listener;

    #[test]
    fn emits_transfer_updates_as_event() {
        let app = tauri::test::mock_app();
        let (tx, rx) = mpsc::channel();
        app.listen(TRANSFERS_EVENT, move |event| {
            tx.send(event.payload().to_owned()).unwrap();
        });
        TauriTransferEvents::new(app.handle().clone()).publish(TransferUpdate::default());
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            r#"{"changed":[],"removed":[]}"#
        );
    }

    #[test]
    fn spawns_tasks_on_the_tauri_runtime() {
        let (tx, rx) = mpsc::channel();
        TauriSpawner.spawn(Box::pin(async move { tx.send(42).unwrap() }));
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), 42);
    }
}
