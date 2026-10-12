//! Typen des Listing-Caches: welcher Ordner gemeint ist, wie ein Listing den Cache nutzt und
//! welche Seiten an die Oberfläche gehen.

use super::object::ListPage;
use serde::Serialize;

/// Ein Ordner (Präfix) in einem Bucket einer Verbindung.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct FolderKey {
    pub profile_id: String,
    pub bucket: String,
    pub prefix: String,
}

impl FolderKey {
    #[must_use]
    pub fn new(profile_id: &str, bucket: &str, prefix: &str) -> Self {
        Self {
            profile_id: profile_id.to_owned(),
            bucket: bucket.to_owned(),
            prefix: prefix.to_owned(),
        }
    }
}

/// Wie ein Listing den Cache nutzt; gespeichert wird bei eingeschaltetem Cache immer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListingMode {
    /// Gespeicherten Stand sofort zeigen, danach frisch vom Server listen.
    CachedFirst,
    /// Nur frisch vom Server, z. B. nach F5 oder eigenen Änderungen.
    Fresh,
}

/// Eine Seite für die Oberfläche; `cached_ms` ist gesetzt, wenn sie aus dem Cache stammt,
/// und nennt den Zeitpunkt des gespeicherten Listings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderPage {
    #[serde(flatten)]
    pub page: ListPage,
    pub cached_ms: Option<i64>,
}

impl FolderPage {
    #[must_use]
    pub fn live(page: ListPage) -> Self {
        Self { page, cached_ms: None }
    }

    #[must_use]
    pub fn cached(page: ListPage, fetched_ms: i64) -> Self {
        Self {
            page,
            cached_ms: Some(fetched_ms),
        }
    }
}

/// Umfang des Caches für Einstellungen › Cache.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub folders: u64,
    pub entries: u64,
    /// Größe der Cache-Datei
    pub bytes: u64,
}

/// Einträge je Seite, wenn ein gespeichertes Listing wieder ausgeliefert wird (wie bei S3).
pub const CACHED_PAGE_SIZE: usize = 1000;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::object::ObjectEntry;

    #[test]
    fn serializes_pages_flat_with_their_cache_time() {
        let page = ListPage {
            objects: vec![ObjectEntry {
                key: "a".into(),
                size: 1,
                last_modified_ms: None,
                etag: None,
                storage_class: None,
            }],
            prefixes: vec!["d/".into()],
            next_token: None,
        };
        let json = serde_json::to_value(FolderPage::cached(page.clone(), 7)).unwrap();
        assert_eq!(json["cachedMs"], 7);
        assert_eq!(json["prefixes"][0], "d/");
        assert_eq!(
            serde_json::to_value(FolderPage::live(page)).unwrap()["cachedMs"],
            serde_json::Value::Null
        );
        assert_eq!(FolderKey::new("p", "b", "x/").prefix, "x/");
    }
}
