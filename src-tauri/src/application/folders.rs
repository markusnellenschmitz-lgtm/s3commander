//! Anwendungsfall: Ordner listen, mit Listing-Cache.
//!
//! Bei `CachedFirst` gehen zuerst die gespeicherten Seiten an die Oberfläche, danach die frischen
//! vom Server. Jedes vollständige Listing ersetzt den gespeicherten Stand. Fehler des Caches
//! halten kein Listing auf; sie werden protokolliert, und das Listing läuft ohne Cache weiter.

use super::cancel::CancelFlag;
use super::error::AppError;
use super::listing::{ListingSummary, list_all};
use crate::domain::error::CacheError;
use crate::domain::listing_cache::{CacheStats, FolderKey, FolderPage, ListingMode};
use crate::domain::object::ListRequest;
use crate::ports::{CacheWrite, Clock, ListingCache, StoreProvider};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

pub struct FolderService<P, C, K> {
    provider: P,
    cache: C,
    clock: K,
    cache_enabled: AtomicBool,
    listings: Mutex<HashMap<String, CancelFlag>>,
}

impl<P, C, K> std::fmt::Debug for FolderService<P, C, K> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FolderService").finish_non_exhaustive()
    }
}

impl<P, C, K> FolderService<P, C, K>
where
    P: StoreProvider,
    C: ListingCache,
    K: Clock,
{
    pub fn new(provider: P, cache: C, clock: K, cache_enabled: bool) -> Self {
        Self {
            provider,
            cache,
            clock,
            cache_enabled: AtomicBool::new(cache_enabled),
            listings: Mutex::default(),
        }
    }

    /// Einstellungen › Cache; ausgeschaltet wird weder gelesen noch geschrieben.
    pub fn set_cache_enabled(&self, enabled: bool) {
        self.cache_enabled.store(enabled, Ordering::Relaxed);
    }

    /// Listet einen Ordner und gibt jede Seite an `on_page`; `listing_id` erlaubt den Abbruch
    /// über [`Self::cancel_listing`].
    ///
    /// # Errors
    /// Unbekanntes Profil, fehlende Zugangsdaten, Fehler des Object Stores oder Abbruch.
    pub async fn list_folder<F>(
        &self,
        folder: &FolderKey,
        mode: ListingMode,
        listing_id: &str,
        mut on_page: F,
    ) -> Result<ListingSummary, AppError>
    where
        F: FnMut(FolderPage) + Send,
    {
        let store = self.provider.store_for(&folder.profile_id)?;
        let use_cache = self.cache_enabled.load(Ordering::Relaxed);
        if use_cache && mode == ListingMode::CachedFirst {
            self.send_cached(folder, &mut on_page);
        }
        let mut write = if use_cache { self.begin_write(folder) } else { None };
        let cancel = CancelFlag::default();
        lock(&self.listings).insert(listing_id.to_owned(), cancel.clone());
        let request = ListRequest::folder(&folder.bucket, &folder.prefix);
        let result = list_all(store.as_ref(), request, &cancel, |page| {
            if let Some(id) = write
                && let Err(error) = self.cache.append(id, &page)
            {
                self.give_up_write(id, &error);
                write = None;
            }
            on_page(FolderPage::live(page));
        })
        .await;
        lock(&self.listings).remove(listing_id);
        if let Some(id) = write {
            self.finish_write(id, result.is_ok());
        }
        Ok(result?)
    }

    /// Bricht ein laufendes Listing ab; `false`, wenn es nicht (mehr) läuft.
    pub fn cancel_listing(&self, listing_id: &str) -> bool {
        lock(&self.listings)
            .get(listing_id)
            .inspect(|flag| flag.cancel())
            .is_some()
    }

    /// Nach dem Löschen einer Verbindung: ihre Listings aus dem Cache entfernen.
    pub fn forget_profile(&self, profile_id: &str) {
        if let Err(error) = self.cache.forget_profile(profile_id) {
            log::warn!("Listings der Verbindung {profile_id} nicht aus dem Cache entfernt: {error}");
        }
    }

    /// # Errors
    /// `Cache`, wenn die Cache-Datei nicht geschrieben werden kann.
    pub fn clear_cache(&self) -> Result<(), AppError> {
        Ok(self.cache.clear()?)
    }

    /// # Errors
    /// `Cache`, wenn die Cache-Datei nicht gelesen werden kann.
    pub fn cache_stats(&self) -> Result<CacheStats, AppError> {
        Ok(self.cache.stats()?)
    }

    fn send_cached<F: FnMut(FolderPage)>(&self, folder: &FolderKey, on_page: &mut F) {
        let mut send = |fetched_ms, page| on_page(FolderPage::cached(page, fetched_ms));
        if let Err(error) = self.cache.load(folder, &mut send) {
            log::warn!("Listing-Cache nicht gelesen: {error}");
        }
    }

    fn begin_write(&self, folder: &FolderKey) -> Option<CacheWrite> {
        self.cache
            .begin(folder)
            .inspect_err(|error| log::warn!("Listing wird nicht zwischengespeichert: {error}"))
            .ok()
    }

    fn give_up_write(&self, write: CacheWrite, error: &CacheError) {
        log::warn!("Listing wird nicht weiter zwischengespeichert: {error}");
        self.finish_write(write, false);
    }

    /// Vollständige Listings werden gültig, abgebrochene und gescheiterte verworfen.
    fn finish_write(&self, write: CacheWrite, complete: bool) {
        let result = if complete {
            self.cache.commit(write, self.clock.unix_ms())
        } else {
            self.cache.discard(write)
        };
        if let Err(error) = result {
            log::warn!("Listing-Cache nicht aktualisiert: {error}");
        }
    }
}

/// Ein vergiftetes Mutex betrifft nur die Abbruch-Signale; sie bleiben brauchbar.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::test_support::{FakeClock, FakeListingCache, FakeProvider, FakeStore};
    use crate::domain::error::StoreError;
    use crate::domain::object::ListPage;
    use std::sync::Arc;
    use std::time::Duration;

    type Service = FolderService<FakeProvider, Arc<FakeListingCache>, FakeClock>;

    fn two_pages() -> Vec<ListPage> {
        vec![
            ListPage {
                objects: vec![FakeStore::object("a")],
                prefixes: vec![],
                next_token: Some("t".into()),
            },
            ListPage {
                objects: vec![FakeStore::object("b")],
                prefixes: vec!["d/".into()],
                next_token: None,
            },
        ]
    }

    fn service(store: FakeStore, cache: &Arc<FakeListingCache>, enabled: bool) -> Service {
        FolderService::new(
            FakeProvider::new(Arc::new(store)),
            Arc::clone(cache),
            FakeClock::stepping(Duration::ZERO),
            enabled,
        )
    }

    fn folder() -> FolderKey {
        FolderKey::new("p1", "gtg-mods", "")
    }

    async fn list(s: &Service, mode: ListingMode) -> (Result<ListingSummary, AppError>, Vec<FolderPage>) {
        let mut pages = Vec::new();
        let result = s.list_folder(&folder(), mode, "l1", |p| pages.push(p)).await;
        (result, pages)
    }

    #[tokio::test]
    async fn lists_all_pages_and_stores_the_listing() {
        let cache = Arc::new(FakeListingCache::default());
        let s = service(FakeStore::with_pages(two_pages()), &cache, true);
        let (result, pages) = list(&s, ListingMode::CachedFirst).await;
        let summary = result.unwrap();
        assert_eq!((summary.objects, summary.prefixes), (2, 1));
        assert!(pages.iter().all(|p| p.cached_ms.is_none()), "noch nichts im Cache");
        assert_eq!(cache.stored(&folder()), Some((0, 3)));
        assert!(!s.cancel_listing("l1"), "beendete Listings sind abgemeldet");
    }

    #[tokio::test]
    async fn sends_the_cached_listing_first() {
        let cache = Arc::new(FakeListingCache::default());
        cache.put(&folder(), two_pages(), 77);
        let s = service(FakeStore::with_pages(vec![ListPage::default()]), &cache, true);
        let (_, pages) = list(&s, ListingMode::CachedFirst).await;
        let cached: Vec<_> = pages.iter().map(|p| p.cached_ms).collect();
        assert_eq!(cached, [Some(77), Some(77), None]);
        assert_eq!(
            cache.stored(&folder()),
            Some((0, 0)),
            "frisches, leeres Listing ersetzt den Stand"
        );
    }

    #[tokio::test]
    async fn skips_the_cache_for_fresh_listings_and_when_disabled() {
        let cache = Arc::new(FakeListingCache::default());
        cache.put(&folder(), two_pages(), 77);
        let s = service(FakeStore::with_pages(vec![ListPage::default()]), &cache, true);
        let (_, pages) = list(&s, ListingMode::Fresh).await;
        assert_eq!(pages.len(), 1);
        s.set_cache_enabled(false);
        cache.put(&folder(), two_pages(), 77);
        let (_, pages) = list(&s, ListingMode::CachedFirst).await;
        assert_eq!(pages.len(), 1);
        assert_eq!(
            cache.stored(&folder()),
            Some((77, 3)),
            "ausgeschaltet bleibt der Cache unberührt"
        );
    }

    #[tokio::test]
    async fn discards_cancelled_listings() {
        let cache = Arc::new(FakeListingCache::default());
        let s = service(FakeStore::with_pages(two_pages()), &cache, true);
        let result = s
            .list_folder(&folder(), ListingMode::Fresh, "l2", |_| {
                assert!(s.cancel_listing("l2"));
            })
            .await;
        assert_eq!(result, Err(AppError::Store(StoreError::Cancelled)));
        assert_eq!(cache.stored(&folder()), None);
        assert_eq!(cache.open_writes(), 0);
    }

    #[tokio::test]
    async fn keeps_listing_when_the_cache_fails() {
        let cache = Arc::new(FakeListingCache::default());
        cache.put(&folder(), two_pages(), 1);
        cache.fail_from_now();
        let s = service(FakeStore::with_pages(two_pages()), &cache, true);
        let (result, pages) = list(&s, ListingMode::CachedFirst).await;
        assert!(result.is_ok());
        assert_eq!(pages.len(), 2, "nur die frischen Seiten");
        s.forget_profile("p1");
        assert!(s.clear_cache().is_err());
        assert!(s.cache_stats().is_err());
    }

    #[tokio::test]
    async fn stops_caching_when_a_page_cannot_be_written() {
        let cache = Arc::new(FakeListingCache::default());
        cache.fail_appends();
        let s = service(FakeStore::with_pages(two_pages()), &cache, true);
        let (result, pages) = list(&s, ListingMode::Fresh).await;
        assert!(result.is_ok());
        assert_eq!(pages.len(), 2);
        assert_eq!(cache.stored(&folder()), None);
        assert_eq!(cache.open_writes(), 0);
    }

    #[tokio::test]
    async fn manages_the_cache() {
        let cache = Arc::new(FakeListingCache::default());
        cache.put(&folder(), two_pages(), 1);
        cache.put(&FolderKey::new("p2", "b", ""), two_pages(), 1);
        let s = service(FakeStore::default(), &cache, true);
        assert_eq!(s.cache_stats().unwrap().folders, 2);
        s.forget_profile("p1");
        assert_eq!(cache.stored(&folder()), None);
        s.clear_cache().unwrap();
        assert_eq!(s.cache_stats().unwrap().folders, 0);
    }

    #[tokio::test]
    async fn reports_unknown_profiles() {
        let cache = Arc::new(FakeListingCache::default());
        let s = service(FakeStore::default(), &cache, true);
        s.provider.make_unavailable();
        let (result, _) = list(&s, ListingMode::Fresh).await;
        assert!(matches!(result, Err(AppError::ProfileNotFound(_))));
    }
}
