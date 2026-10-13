//! Anwendungsfall: Ordner listen, mit Listing-Cache.
//!
//! Bei `CachedFirst` gehen zuerst die gespeicherten Seiten an die Oberfläche, danach die frischen
//! vom Server. Jedes vollständige Listing ersetzt den gespeicherten Stand. Fehler des Caches
//! halten kein Listing auf; sie werden protokolliert, und das Listing läuft ohne Cache weiter.
//!
//! Sehr große Ordner (mehr als [`WINDOW_THRESHOLD`] Einträge) bekommt die Oberfläche nicht mehr
//! Eintrag für Eintrag: Seiten tragen dann nur noch den Verweis auf das Listing im Cache, aus dem
//! sie Fenster lädt. Bei ausgeschaltetem Cache wird das Listing dafür trotzdem geschrieben, aber
//! nie gültig; die Oberfläche gibt es frei, sobald sie es nicht mehr zeigt.

use super::cancel::CancelFlag;
use super::error::AppError;
use super::listing::{ListingSummary, list_all};
use crate::domain::error::CacheError;
use crate::domain::listing_cache::{CacheStats, FolderKey, FolderPage, ListingMode};
use crate::domain::listing_window::{ListingId, WINDOW_THRESHOLD, WindowRef};
use crate::domain::object::{ListPage, ListRequest};
use crate::ports::{CacheWrite, Clock, ListingCache, StoreProvider};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

pub struct FolderService<P, C, K> {
    provider: P,
    cache: C,
    clock: K,
    cache_enabled: AtomicBool,
    listings: Mutex<HashMap<String, CancelFlag>>,
    window_threshold: u64,
    /// Listings, die gerade für Fenster geschrieben werden.
    writing: Mutex<HashSet<ListingId>>,
    /// Davon schon freigegebene; sie werden nach dem Listing verworfen.
    released_early: Mutex<HashSet<ListingId>>,
}

/// Zustand eines laufenden Listings.
struct LiveListing {
    cache_enabled: bool,
    write: Option<CacheWrite>,
    /// Bei ausgeschaltetem Cache bis zum Schwellwert zurückgehaltene Seiten.
    held: Vec<ListPage>,
    delivered: u64,
    window: Option<ListingId>,
    window_tried: bool,
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
            window_threshold: WINDOW_THRESHOLD,
            writing: Mutex::default(),
            released_early: Mutex::default(),
        }
    }

    /// Ab wie vielen Einträgen die Oberfläche Fenster lädt.
    #[must_use]
    pub fn with_window_threshold(mut self, threshold: u64) -> Self {
        self.window_threshold = threshold;
        self
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
        let cache_enabled = self.cache_enabled.load(Ordering::Relaxed);
        if cache_enabled && mode == ListingMode::CachedFirst {
            self.send_cached(folder, &mut on_page);
        }
        let mut live = LiveListing {
            cache_enabled,
            write: if cache_enabled { self.begin_write(folder) } else { None },
            held: Vec::new(),
            delivered: 0,
            window: None,
            window_tried: false,
        };
        let cancel = CancelFlag::default();
        lock(&self.listings).insert(listing_id.to_owned(), cancel.clone());
        let request = ListRequest::folder(&folder.bucket, &folder.prefix);
        let result = list_all(store.as_ref(), request, &cancel, |page| {
            self.receive(&mut live, folder, page, &mut on_page);
        })
        .await;
        lock(&self.listings).remove(listing_id);
        self.finish_listing(&live, result.is_ok());
        Ok(result?)
    }

    /// Die Oberfläche zeigt das Listing nicht mehr: Wurde es nur für Fenster aufbewahrt, wird es
    /// verworfen, läuft es noch, nach dem Ende. Vollständige Listings bleiben als Cache.
    pub fn release_listing(&self, listing: ListingId) {
        if lock(&self.writing).contains(&listing) {
            lock(&self.released_early).insert(listing);
            return;
        }
        if let Err(error) = self.cache.release(listing) {
            log::warn!("Listing {listing} nicht freigegeben: {error}");
        }
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

    /// Gespeicherter Stand zuerst; ist er sehr groß, nur der Verweis für die Fenster.
    fn send_cached<F: FnMut(FolderPage)>(&self, folder: &FolderKey, on_page: &mut F) {
        let result = self.cache.find(folder).and_then(|stored| match stored {
            Some(stored) if stored.entries > self.window_threshold => {
                let window = WindowRef {
                    listing_id: stored.id,
                    loaded: stored.entries,
                };
                on_page(FolderPage::windowed(window, Some(stored.fetched_ms)));
                Ok(true)
            }
            Some(_) => self.cache.load(folder, &mut |fetched_ms, page| {
                on_page(FolderPage::cached(page, fetched_ms));
            }),
            None => Ok(false),
        });
        if let Err(error) = result {
            log::warn!("Listing-Cache nicht gelesen: {error}");
        }
    }

    /// Speichert eine frische Seite und gibt sie weiter, ab dem Schwellwert nur als Verweis.
    fn receive<F: FnMut(FolderPage)>(
        &self,
        live: &mut LiveListing,
        folder: &FolderKey,
        page: ListPage,
        on_page: &mut F,
    ) {
        live.delivered += page.entry_count() as u64;
        self.store_page(live, &page);
        if !live.window_tried && live.delivered > self.window_threshold {
            live.window_tried = true;
            live.window = self.start_window(live, folder);
        }
        match live.window {
            Some(listing_id) => on_page(FolderPage::windowed(
                WindowRef {
                    listing_id,
                    loaded: live.delivered,
                },
                None,
            )),
            None => on_page(FolderPage::live(page)),
        }
    }

    fn store_page(&self, live: &mut LiveListing, page: &ListPage) {
        if let Some(id) = live.write {
            if let Err(error) = self.cache.append(id, page) {
                log::warn!("Listing wird nicht weiter zwischengespeichert: {error}");
                live.write = None;
                if live.window != Some(id) {
                    self.finish_write(id, false);
                }
            }
        } else if !live.cache_enabled && !live.window_tried {
            live.held.push(page.clone());
        }
    }

    /// Ab dem Schwellwert lädt die Oberfläche Fenster aus dem Listing im Cache. Bei
    /// ausgeschaltetem Cache wird es erst jetzt angelegt, mit den zurückgehaltenen Seiten.
    fn start_window(&self, live: &mut LiveListing, folder: &FolderKey) -> Option<ListingId> {
        let held = std::mem::take(&mut live.held);
        if live.write.is_none() && !live.cache_enabled {
            let id = self.begin_write(folder)?;
            if let Some(error) = held.iter().find_map(|page| self.cache.append(id, page).err()) {
                self.give_up_write(id, &error);
                return None;
            }
            live.write = Some(id);
        }
        let id = live.write?;
        lock(&self.writing).insert(id);
        Some(id)
    }

    /// Vollständige Listings werden bei eingeschaltetem Cache gültig. Listings für Fenster bleiben
    /// unvollständig erhalten, bis die Oberfläche sie freigibt; alles andere wird verworfen.
    fn finish_listing(&self, live: &LiveListing, complete: bool) {
        if let Some(window) = live.window {
            lock(&self.writing).remove(&window);
            if lock(&self.released_early).remove(&window) {
                self.finish_write(window, false);
                return;
            }
        }
        match live.write {
            Some(id) if complete && live.cache_enabled => self.finish_write(id, true),
            Some(id) if live.window != Some(id) => self.finish_write(id, false),
            _ => {}
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

    fn windows(pages: &[FolderPage]) -> Vec<Option<(ListingId, u64)>> {
        pages
            .iter()
            .map(|p| p.window.map(|w| (w.listing_id, w.loaded)))
            .collect()
    }

    #[tokio::test]
    async fn sends_only_the_listing_reference_above_the_threshold() {
        let cache = Arc::new(FakeListingCache::default());
        let s = service(FakeStore::with_pages(two_pages()), &cache, true).with_window_threshold(2);
        let (result, pages) = list(&s, ListingMode::Fresh).await;
        assert!(result.is_ok());
        let listing = cache.listing_id(&folder()).unwrap();
        assert_eq!(windows(&pages), [None, Some((listing, 3))]);
        assert_eq!(pages[0].page.objects.len(), 1, "unter dem Schwellwert mit Einträgen");
        assert_eq!(pages[1].page.entry_count(), 0, "darüber nur der Verweis");
        assert_eq!(cache.stored(&folder()), Some((0, 3)), "vollständig im Cache");
    }

    #[tokio::test]
    async fn writes_large_listings_for_windows_even_without_cache() {
        let cache = Arc::new(FakeListingCache::default());
        let s = service(FakeStore::with_pages(two_pages()), &cache, false).with_window_threshold(2);
        let (_, pages) = list(&s, ListingMode::CachedFirst).await;
        let (listing, loaded) = pages[1].window.map(|w| (w.listing_id, w.loaded)).unwrap();
        assert_eq!(loaded, 3);
        assert_eq!(
            cache.open_entries(listing),
            Some(3),
            "mit der zurückgehaltenen ersten Seite"
        );
        assert_eq!(cache.stored(&folder()), None, "nie gültig, also kein Cache");
        s.release_listing(listing);
        assert_eq!(cache.released(), [listing]);
        assert_eq!(cache.open_entries(listing), None);
    }

    #[tokio::test]
    async fn writes_nothing_for_small_listings_without_cache() {
        let cache = Arc::new(FakeListingCache::default());
        let s = service(FakeStore::with_pages(two_pages()), &cache, false).with_window_threshold(5);
        let (_, pages) = list(&s, ListingMode::Fresh).await;
        assert_eq!(windows(&pages), [None, None]);
        assert_eq!(cache.open_writes(), 0);
    }

    #[tokio::test]
    async fn refers_to_large_cached_listings_instead_of_sending_them() {
        let cache = Arc::new(FakeListingCache::default());
        cache.put(&folder(), two_pages(), 77);
        let cached = cache.listing_id(&folder()).unwrap();
        let s = service(FakeStore::with_pages(vec![ListPage::default()]), &cache, true).with_window_threshold(2);
        let (_, pages) = list(&s, ListingMode::CachedFirst).await;
        assert_eq!(windows(&pages), [Some((cached, 3)), None]);
        assert_eq!(pages[0].cached_ms, Some(77));
    }

    #[tokio::test]
    async fn keeps_windowed_listings_after_a_cancel_until_released() {
        let cache = Arc::new(FakeListingCache::default());
        let mut first = two_pages()[1].clone();
        first.next_token = Some("weiter".into());
        let pages = vec![first, two_pages()[0].clone()];
        let s = service(FakeStore::with_pages(pages), &cache, true).with_window_threshold(1);
        let mut window = None;
        let result = s
            .list_folder(&folder(), ListingMode::Fresh, "l3", |page| {
                window = page.window.map(|w| w.listing_id);
                assert!(s.cancel_listing("l3"));
            })
            .await;
        assert_eq!(result, Err(AppError::Store(StoreError::Cancelled)));
        let listing = window.unwrap();
        assert_eq!(
            cache.open_entries(listing),
            Some(2),
            "Teil-Listing bleibt für die Fenster"
        );
        assert_eq!(cache.stored(&folder()), None);
    }

    #[tokio::test]
    async fn discards_windowed_listings_released_while_running() {
        let cache = Arc::new(FakeListingCache::default());
        let s = service(FakeStore::with_pages(two_pages()), &cache, true).with_window_threshold(1);
        let result = s
            .list_folder(&folder(), ListingMode::Fresh, "l4", |page| {
                if let Some(window) = page.window {
                    s.release_listing(window.listing_id);
                }
            })
            .await;
        assert!(result.is_ok());
        assert_eq!(cache.stored(&folder()), None, "freigegeben, also nicht übernommen");
        assert_eq!(cache.open_writes(), 0);
        assert_eq!(cache.released().len(), 0, "verworfen statt freigegeben");
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
