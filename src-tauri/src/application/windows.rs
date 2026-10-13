//! Anwendungsfall: Fenster aus sehr großen Ordnern laden.
//!
//! Die Oberfläche öffnet je Sortierung und Filter eine Sicht auf das Listing im Cache und holt
//! daraus nur die sichtbaren Zeilen. Sichten belegen Platz in SQLite; deshalb bleiben nur die
//! zuletzt geöffneten offen, ältere werden verworfen.

use super::error::AppError;
use crate::domain::listing_window::{
    ListingId, MAX_WINDOW_ENTRIES, ViewId, ViewInfo, WindowEntry, WindowFilter, WindowSort,
};
use crate::ports::ListingWindows;
use std::collections::VecDeque;
use std::sync::{Mutex, MutexGuard, PoisonError};

/// So viele Sichten bleiben gleichzeitig offen (Tabs mit großen Ordnern, Wechsel der Sortierung).
pub const MAX_OPEN_VIEWS: usize = 4;

pub struct ListingWindowService<W> {
    windows: W,
    /// Offene Sichten, die älteste vorn.
    open: Mutex<VecDeque<ViewId>>,
}

impl<W> std::fmt::Debug for ListingWindowService<W> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ListingWindowService").finish_non_exhaustive()
    }
}

impl<W: ListingWindows> ListingWindowService<W> {
    pub fn new(windows: W) -> Self {
        Self {
            windows,
            open: Mutex::default(),
        }
    }

    /// Öffnet eine Sicht und verwirft die älteste, wenn schon [`MAX_OPEN_VIEWS`] offen sind.
    ///
    /// # Errors
    /// `Cache`, wenn das Listing nicht gelesen werden kann.
    pub fn open(&self, listing: ListingId, filter: &WindowFilter, sort: WindowSort) -> Result<ViewInfo, AppError> {
        let info = self.windows.open_view(listing, filter, sort)?;
        let surplus: Vec<ViewId> = {
            let mut open = self.open_views();
            open.push_back(info.view_id);
            let excess = open.len().saturating_sub(MAX_OPEN_VIEWS);
            open.drain(..excess).collect()
        };
        for view in surplus {
            self.windows.close_view(view);
        }
        Ok(info)
    }

    /// Zeilen ab `offset`; höchstens [`MAX_WINDOW_ENTRIES`] je Abfrage.
    ///
    /// # Errors
    /// `Cache` bei Lesefehlern oder einer nicht (mehr) offenen Sicht.
    pub fn entries(&self, view: ViewId, offset: u64, limit: u64) -> Result<Vec<WindowEntry>, AppError> {
        Ok(self.windows.view_entries(view, offset, limit.min(MAX_WINDOW_ENTRIES))?)
    }

    /// Alle Treffer außer `excluded`: die Auswahl „alle außer …“ für Aktionen.
    ///
    /// # Errors
    /// `Cache` bei Lesefehlern oder einer nicht (mehr) offenen Sicht.
    pub fn selection(&self, view: ViewId, excluded: &[String]) -> Result<Vec<WindowEntry>, AppError> {
        Ok(self.windows.view_entries_except(view, excluded)?)
    }

    pub fn close(&self, view: ViewId) {
        self.open_views().retain(|open| *open != view);
        self.windows.close_view(view);
    }

    fn open_views(&self) -> MutexGuard<'_, VecDeque<ViewId>> {
        self.open.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::test_support::FakeWindows;
    use crate::domain::listing_window::SortColumn;
    use std::sync::Arc;

    const SORT: WindowSort = WindowSort {
        column: SortColumn::Name,
        dir: 1,
    };

    fn service() -> (ListingWindowService<Arc<FakeWindows>>, Arc<FakeWindows>) {
        let windows = Arc::new(FakeWindows::with_entries(25_000));
        (ListingWindowService::new(Arc::clone(&windows)), windows)
    }

    #[test]
    fn keeps_only_the_most_recent_views_open() {
        let (s, windows) = service();
        let views: Vec<ViewId> = (0..=MAX_OPEN_VIEWS)
            .map(|_| s.open(1, &WindowFilter::default(), SORT).unwrap().view_id)
            .collect();
        assert_eq!(windows.closed(), [views[0]], "die älteste Sicht wird verworfen");
        s.close(views[2]);
        assert_eq!(windows.closed(), [views[0], views[2]]);
        s.open(1, &WindowFilter::default(), SORT).unwrap();
        assert_eq!(windows.closed().len(), 2, "nach dem Schließen ist wieder Platz");
    }

    #[test]
    fn limits_the_size_of_a_window() {
        let (s, _) = service();
        let view = s.open(1, &WindowFilter::default(), SORT).unwrap().view_id;
        assert_eq!(s.entries(view, 0, 50).unwrap().len(), 50);
        let limit = usize::try_from(MAX_WINDOW_ENTRIES).unwrap();
        assert_eq!(s.entries(view, 0, u64::MAX).unwrap().len(), limit);
    }

    #[test]
    fn resolves_everything_but_excluded_keys() {
        let (s, _) = service();
        let view = s.open(1, &WindowFilter::default(), SORT).unwrap().view_id;
        let rest = s.selection(view, &["k00000".into()]).unwrap();
        assert_eq!(rest.len(), 24_999);
        assert_eq!(rest[0].key, "k00001");
    }

    #[test]
    fn reports_errors_of_the_cache() {
        let (s, windows) = service();
        windows.fail();
        assert!(matches!(
            s.open(1, &WindowFilter::default(), SORT),
            Err(AppError::Cache(_))
        ));
        assert!(s.entries(9, 0, 1).is_err());
        assert!(s.selection(9, &[]).is_err());
    }
}
