//! Anwendungsfall: Präfix vollständig listen, Seite für Seite.
//!
//! Seiten werden sofort an den Aufrufer weitergereicht (UI, später SQLite-Cache), damit
//! auch Millionen Objekte ohne großen Speicherbedarf und mit sichtbarem Fortschritt laufen.

use super::cancel::CancelFlag;
use crate::domain::error::StoreError;
use crate::domain::object::{ListPage, ListRequest};
use crate::ports::ObjectStore;
use serde::Serialize;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListingSummary {
    pub pages: u64,
    pub objects: u64,
    pub prefixes: u64,
}

/// Listet alle Seiten ab `request` und ruft `on_page` für jede Seite auf.
///
/// # Errors
///
/// Fehler des Stores, `Cancelled` nach Abbruch, `InvalidResponse`, wenn der Dienst
/// dasselbe Fortsetzungs-Token erneut liefert (würde sonst endlos laufen).
pub async fn list_all<S, F>(
    store: &S,
    request: ListRequest,
    cancel: &CancelFlag,
    mut on_page: F,
) -> Result<ListingSummary, StoreError>
where
    S: ObjectStore,
    F: FnMut(ListPage) + Send,
{
    let mut request = request;
    let mut summary = ListingSummary::default();
    loop {
        if cancel.is_cancelled() {
            return Err(StoreError::Cancelled);
        }
        let page = store.list_objects(&request).await?;
        summary.pages += 1;
        summary.objects += page.objects.len() as u64;
        summary.prefixes += page.prefixes.len() as u64;
        let next = page.next_token.clone();
        on_page(page);
        match next {
            None => return Ok(summary),
            Some(token) if request.continuation_token.as_deref() == Some(token.as_str()) => {
                return Err(StoreError::InvalidResponse("Fortsetzungs-Token wiederholt sich".into()));
            }
            Some(token) => request.continuation_token = Some(token),
        }
    }
}

/// Ob unter `key` schon etwas liegt; bei Ordnern (Key endet auf `/`) zählt jedes Objekt darunter.
///
/// # Errors
/// Fehler des Stores.
pub async fn key_taken<S: ObjectStore>(store: &S, bucket: &str, key: &str) -> Result<bool, StoreError> {
    let request = ListRequest {
        max_keys: Some(1),
        ..ListRequest::recursive(bucket, key)
    };
    let page = store.list_objects(&request).await?;
    // Ein exakter Treffer sortiert immer vor längeren Keys mit demselben Anfang.
    Ok(page
        .objects
        .first()
        .is_some_and(|object| key.ends_with('/') || object.key == key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::test_support::FakeStore;

    #[tokio::test]
    async fn detects_taken_keys_with_a_single_small_request() {
        let page = |key: &str| ListPage {
            objects: vec![FakeStore::object(key)],
            ..ListPage::default()
        };
        let store = FakeStore::with_pages(vec![
            page("a/x.txt"),
            page("a/x.txt.bak"),
            page("a/d/inner"),
            ListPage::default(),
        ]);
        assert!(key_taken(&store, "b", "a/x.txt").await.unwrap());
        assert!(
            !key_taken(&store, "b", "a/x.txt").await.unwrap(),
            "nur ein längerer Key"
        );
        assert!(key_taken(&store, "b", "a/d/").await.unwrap());
        assert!(!key_taken(&store, "b", "a/leer/").await.unwrap());
        let request = &store.requests()[0];
        assert_eq!((request.max_keys, request.delimiter.as_deref()), (Some(1), None));
    }

    fn pages(tokens: &[Option<&str>]) -> Vec<ListPage> {
        tokens
            .iter()
            .enumerate()
            .map(|(i, t)| ListPage {
                objects: vec![FakeStore::object(&format!("k{i}"))],
                prefixes: if i == 0 { vec!["d/".into()] } else { vec![] },
                next_token: t.map(str::to_owned),
            })
            .collect()
    }

    #[tokio::test]
    async fn follows_continuation_tokens_until_the_last_page() {
        let store = FakeStore::with_pages(pages(&[Some("t1"), Some("t2"), None]));
        let mut seen = Vec::new();
        let summary = list_all(&store, ListRequest::folder("b", "p/"), &CancelFlag::default(), |p| {
            seen.push(p.objects[0].key.clone());
        })
        .await
        .unwrap();
        assert_eq!(
            summary,
            ListingSummary {
                pages: 3,
                objects: 3,
                prefixes: 1
            }
        );
        assert_eq!(seen, ["k0", "k1", "k2"]);
        let tokens: Vec<_> = store.requests().into_iter().map(|r| r.continuation_token).collect();
        assert_eq!(tokens, [None, Some("t1".into()), Some("t2".into())]);
    }

    #[tokio::test]
    async fn stops_when_cancelled() {
        let store = FakeStore::with_pages(pages(&[Some("t1"), None]));
        let cancel = CancelFlag::default();
        let result = list_all(&store, ListRequest::folder("b", ""), &cancel, |_| cancel.cancel()).await;
        assert_eq!(result, Err(StoreError::Cancelled));
        assert_eq!(store.requests().len(), 1);
    }

    #[tokio::test]
    async fn detects_repeating_tokens() {
        let store = FakeStore::with_pages(pages(&[Some("t1"), Some("t1"), None]));
        let result = list_all(&store, ListRequest::folder("b", ""), &CancelFlag::default(), |_| {}).await;
        assert!(matches!(result, Err(StoreError::InvalidResponse(_))));
    }

    #[tokio::test]
    async fn passes_store_errors_through() {
        let store = FakeStore::failing(StoreError::Timeout);
        let result = list_all(&store, ListRequest::folder("b", ""), &CancelFlag::default(), |_| {}).await;
        assert_eq!(result, Err(StoreError::Timeout));
    }
}
