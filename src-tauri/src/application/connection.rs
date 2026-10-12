//! Anwendungsfall: Verbindung testen ("Verbindung testen" im Verbindungsdialog).
//!
//! Ohne Bucket werden die Buckets gelistet. Mit Bucket wird nur dieser geprüft, weil
//! Schlüssel oft auf einen Bucket beschränkt sind und `ListBuckets` dann verweigert wird.

use crate::domain::error::StoreError;
use crate::domain::object::ListRequest;
use crate::ports::{Clock, ObjectStore};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTest {
    /// Anzahl Buckets; `None`, wenn nur ein einzelner Bucket geprüft wurde.
    pub bucket_count: Option<usize>,
    pub latency_ms: u64,
}

/// # Errors
///
/// Fehler des Stores, z. B. `SignatureDoesNotMatch` oder Netzwerkfehler.
pub async fn test_connection<S: ObjectStore, C: Clock>(
    store: &S,
    clock: &C,
    bucket: Option<&str>,
) -> Result<ConnectionTest, StoreError> {
    let started = clock.monotonic();
    let bucket_count = match bucket.map(str::trim).filter(|b| !b.is_empty()) {
        Some(bucket) => {
            let probe = ListRequest {
                max_keys: Some(1),
                ..ListRequest::folder(bucket, "")
            };
            store.list_objects(&probe).await?;
            None
        }
        None => Some(store.list_buckets().await?.len()),
    };
    let elapsed = clock.monotonic().saturating_duration_since(started);
    Ok(ConnectionTest {
        bucket_count,
        latency_ms: u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::test_support::{FakeClock, FakeStore};
    use crate::domain::object::ListPage;
    use std::time::Duration;

    #[tokio::test]
    async fn counts_buckets_and_measures_latency() {
        let clock = FakeClock::stepping(Duration::from_millis(142));
        let store = FakeStore::with_buckets(&["a", "b", "c"]);
        let result = test_connection(&store, &clock, None).await.unwrap();
        assert_eq!(
            result,
            ConnectionTest {
                bucket_count: Some(3),
                latency_ms: 142
            }
        );
    }

    #[tokio::test]
    async fn probes_a_single_bucket_with_one_key() {
        let clock = FakeClock::stepping(Duration::ZERO);
        let store = FakeStore::with_pages(vec![ListPage::default()]);
        let result = test_connection(&store, &clock, Some(" gtg-mods ")).await.unwrap();
        assert_eq!(result.bucket_count, None);
        let request = &store.requests()[0];
        assert_eq!(request.bucket, "gtg-mods");
        assert_eq!(request.max_keys, Some(1));
    }

    #[tokio::test]
    async fn treats_blank_bucket_as_none_and_reports_errors() {
        let clock = FakeClock::stepping(Duration::ZERO);
        let store = FakeStore::failing(StoreError::Network("weg".into()));
        let result = test_connection(&store, &clock, Some("  ")).await;
        assert_eq!(result, Err(StoreError::Network("weg".into())));
    }
}
