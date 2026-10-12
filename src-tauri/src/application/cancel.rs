//! Kooperativer Abbruch langer Vorgänge ("Listing abbrechen", Transfers pausieren und abbrechen).

use tokio_util::sync::CancellationToken;

/// Günstig klonbar; alle Klone teilen denselben Zustand.
#[derive(Debug, Clone, Default)]
pub struct CancelFlag(CancellationToken);

impl CancelFlag {
    pub fn cancel(&self) {
        self.0.cancel();
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.is_cancelled()
    }

    /// Wartet, bis abgebrochen wird. Für `tokio::select!` gegen laufende Requests.
    pub async fn cancelled(&self) {
        self.0.cancelled().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clones_share_the_state() {
        let flag = CancelFlag::default();
        let clone = flag.clone();
        assert!(!clone.is_cancelled());
        flag.cancel();
        assert!(clone.is_cancelled());
    }

    #[tokio::test]
    async fn wakes_waiters_on_cancel() {
        let flag = CancelFlag::default();
        let waiter = flag.clone();
        let task = tokio::spawn(async move { waiter.cancelled().await });
        flag.cancel();
        task.await.unwrap();
    }
}
