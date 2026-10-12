//! Listing-Cache in einer SQLite-Datei (`rusqlite`, SQLite eingebaut).
//!
//! Ein Listing wird seitenweise unter einer neuen ID geschrieben und erst beim Abschluss gültig;
//! dabei verdrängt es das bisherige Listing desselben Ordners. Reste unvollständiger Listings
//! (Absturz, Abbruch) räumt das Öffnen auf.

use crate::domain::error::CacheError;
use crate::domain::listing_cache::{CACHED_PAGE_SIZE, CacheStats, FolderKey};
use crate::domain::object::{ListPage, ObjectEntry};
use crate::ports::{CacheWrite, ListingCache};
use rusqlite::{Connection, OptionalExtension, Row, params};
use std::path::Path;
use std::sync::{Mutex, MutexGuard, PoisonError};

/// Dateiname neben den übrigen Anwendungsdaten.
pub const CACHE_FILE_NAME: &str = "listing-cache.sqlite";

const SCHEMA: &str = "
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS listings (
        id INTEGER PRIMARY KEY,
        profile_id TEXT NOT NULL,
        bucket TEXT NOT NULL,
        prefix TEXT NOT NULL,
        fetched_ms INTEGER,
        complete INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS listings_by_folder ON listings (profile_id, bucket, prefix, complete);
    CREATE TABLE IF NOT EXISTS entries (
        listing_id INTEGER NOT NULL,
        key TEXT NOT NULL,
        is_prefix INTEGER NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        last_modified_ms INTEGER,
        etag TEXT,
        storage_class TEXT,
        PRIMARY KEY (listing_id, key)
    ) WITHOUT ROWID;
";

#[derive(Debug)]
pub struct SqliteListingCache {
    connection: Mutex<Connection>,
}

impl SqliteListingCache {
    /// Öffnet oder erzeugt die Cache-Datei.
    ///
    /// # Errors
    /// `Storage`, wenn die Datei nicht geöffnet oder angelegt werden kann.
    pub fn open(path: &Path) -> Result<Self, CacheError> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| CacheError::Storage(e.to_string()))?;
        }
        Self::prepare(Connection::open(path).map_err(storage)?)
    }

    /// Cache nur im Arbeitsspeicher, für Tests.
    ///
    /// # Errors
    /// `Storage`, wenn SQLite nicht startet.
    pub fn in_memory() -> Result<Self, CacheError> {
        Self::prepare(Connection::open_in_memory().map_err(storage)?)
    }

    fn prepare(connection: Connection) -> Result<Self, CacheError> {
        connection.execute_batch(SCHEMA).map_err(storage)?;
        let cache = Self {
            connection: Mutex::new(connection),
        };
        cache.remove_listings("complete = 0", params![])?;
        Ok(cache)
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.connection.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Löscht Listings samt Einträgen, die `condition` erfüllen.
    fn remove_listings(&self, condition: &str, values: impl rusqlite::Params + Clone) -> Result<(), CacheError> {
        let mut connection = self.lock();
        let tx = connection.transaction().map_err(storage)?;
        tx.execute(
            &format!("DELETE FROM entries WHERE listing_id IN (SELECT id FROM listings WHERE {condition})"),
            values.clone(),
        )
        .map_err(storage)?;
        tx.execute(&format!("DELETE FROM listings WHERE {condition}"), values)
            .map_err(storage)?;
        tx.commit().map_err(storage)
    }
}

impl ListingCache for SqliteListingCache {
    fn load(&self, folder: &FolderKey, on_page: &mut dyn FnMut(i64, ListPage)) -> Result<bool, CacheError> {
        let connection = self.lock();
        let found: Option<(i64, i64)> = connection
            .query_row(
                "SELECT id, fetched_ms FROM listings
                 WHERE profile_id = ?1 AND bucket = ?2 AND prefix = ?3 AND complete = 1",
                params![folder.profile_id, folder.bucket, folder.prefix],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(storage)?;
        let Some((id, fetched_ms)) = found else {
            return Ok(false);
        };
        let mut statement = connection
            .prepare(
                "SELECT key, is_prefix, size, last_modified_ms, etag, storage_class
                 FROM entries WHERE listing_id = ?1 ORDER BY key",
            )
            .map_err(storage)?;
        let mut rows = statement.query(params![id]).map_err(storage)?;
        let mut page = ListPage::default();
        while let Some(row) = rows.next().map_err(storage)? {
            add_entry(&mut page, row).map_err(storage)?;
            if page.entry_count() >= CACHED_PAGE_SIZE {
                on_page(fetched_ms, std::mem::take(&mut page));
            }
        }
        on_page(fetched_ms, page);
        Ok(true)
    }

    fn begin(&self, folder: &FolderKey) -> Result<CacheWrite, CacheError> {
        let connection = self.lock();
        connection
            .execute(
                "INSERT INTO listings (profile_id, bucket, prefix) VALUES (?1, ?2, ?3)",
                params![folder.profile_id, folder.bucket, folder.prefix],
            )
            .map_err(storage)?;
        Ok(connection.last_insert_rowid())
    }

    fn append(&self, write: CacheWrite, page: &ListPage) -> Result<(), CacheError> {
        let mut connection = self.lock();
        let tx = connection.transaction().map_err(storage)?;
        {
            let mut insert = tx
                .prepare_cached(
                    "INSERT OR REPLACE INTO entries
                     (listing_id, key, is_prefix, size, last_modified_ms, etag, storage_class)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                )
                .map_err(storage)?;
            for prefix in &page.prefixes {
                insert
                    .execute(params![
                        write,
                        prefix,
                        true,
                        0,
                        None::<i64>,
                        None::<String>,
                        None::<String>
                    ])
                    .map_err(storage)?;
            }
            for object in &page.objects {
                insert
                    .execute(params![
                        write,
                        object.key,
                        false,
                        i64::try_from(object.size).unwrap_or(i64::MAX),
                        object.last_modified_ms,
                        object.etag,
                        object.storage_class
                    ])
                    .map_err(storage)?;
            }
        }
        tx.commit().map_err(storage)
    }

    fn commit(&self, write: CacheWrite, fetched_ms: i64) -> Result<(), CacheError> {
        let mut connection = self.lock();
        let tx = connection.transaction().map_err(storage)?;
        let older = "SELECT old.id FROM listings old JOIN listings new ON new.id = ?1
                     WHERE old.id <> new.id AND old.profile_id = new.profile_id
                       AND old.bucket = new.bucket AND old.prefix = new.prefix";
        tx.execute(
            &format!("DELETE FROM entries WHERE listing_id IN ({older})"),
            params![write],
        )
        .map_err(storage)?;
        tx.execute(&format!("DELETE FROM listings WHERE id IN ({older})"), params![write])
            .map_err(storage)?;
        tx.execute(
            "UPDATE listings SET complete = 1, fetched_ms = ?2 WHERE id = ?1",
            params![write, fetched_ms],
        )
        .map_err(storage)?;
        tx.commit().map_err(storage)
    }

    fn discard(&self, write: CacheWrite) -> Result<(), CacheError> {
        self.remove_listings("id = ?1", params![write])
    }

    fn forget_profile(&self, profile_id: &str) -> Result<(), CacheError> {
        self.remove_listings("profile_id = ?1", params![profile_id])
    }

    fn clear(&self) -> Result<(), CacheError> {
        self.remove_listings("1 = 1", params![])?;
        self.lock().execute_batch("VACUUM").map_err(storage)
    }

    fn stats(&self) -> Result<CacheStats, CacheError> {
        let connection = self.lock();
        let count = |sql: &str| -> Result<u64, CacheError> {
            let value: i64 = connection.query_row(sql, [], |row| row.get(0)).map_err(storage)?;
            Ok(u64::try_from(value).unwrap_or(0))
        };
        Ok(CacheStats {
            folders: count("SELECT COUNT(*) FROM listings WHERE complete = 1")?,
            entries: count(
                "SELECT COUNT(*) FROM entries WHERE listing_id IN (SELECT id FROM listings WHERE complete = 1)",
            )?,
            bytes: count("SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()")?,
        })
    }
}

fn add_entry(page: &mut ListPage, row: &Row<'_>) -> rusqlite::Result<()> {
    let key: String = row.get(0)?;
    if row.get::<_, bool>(1)? {
        page.prefixes.push(key);
    } else {
        page.objects.push(ObjectEntry {
            key,
            size: u64::try_from(row.get::<_, i64>(2)?).unwrap_or(0),
            last_modified_ms: row.get(3)?,
            etag: row.get(4)?,
            storage_class: row.get(5)?,
        });
    }
    Ok(())
}

#[allow(clippy::needless_pass_by_value)] // als map_err-Funktion nimmt sie den Fehler als Wert
fn storage(error: rusqlite::Error) -> CacheError {
    CacheError::Storage(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(prefix: &str) -> FolderKey {
        FolderKey::new("p1", "media", prefix)
    }

    fn object(key: &str, size: u64) -> ObjectEntry {
        ObjectEntry {
            key: key.into(),
            size,
            last_modified_ms: Some(5),
            etag: Some("\"e\"".into()),
            storage_class: Some("STANDARD".into()),
        }
    }

    fn page(objects: &[&str], prefixes: &[&str]) -> ListPage {
        ListPage {
            objects: objects.iter().map(|k| object(k, 3)).collect(),
            prefixes: prefixes.iter().map(|p| (*p).to_owned()).collect(),
            next_token: None,
        }
    }

    fn load(cache: &SqliteListingCache, key: &FolderKey) -> Option<(i64, Vec<ListPage>)> {
        let mut fetched = 0;
        let mut pages = Vec::new();
        let found = cache
            .load(key, &mut |ms, p| {
                fetched = ms;
                pages.push(p);
            })
            .unwrap();
        found.then_some((fetched, pages))
    }

    fn store(cache: &SqliteListingCache, key: &FolderKey, pages: &[ListPage], fetched_ms: i64) {
        let write = cache.begin(key).unwrap();
        for p in pages {
            cache.append(write, p).unwrap();
        }
        cache.commit(write, fetched_ms).unwrap();
    }

    #[test]
    fn stores_and_loads_a_listing_in_key_order() {
        let cache = SqliteListingCache::in_memory().unwrap();
        assert_eq!(load(&cache, &folder("v/")), None);
        store(
            &cache,
            &folder("v/"),
            &[page(&["v/b.mp4"], &["v/d/"]), page(&["v/a.mp4"], &[])],
            42,
        );
        let (fetched, pages) = load(&cache, &folder("v/")).unwrap();
        assert_eq!(fetched, 42);
        assert_eq!(pages.len(), 1);
        let keys: Vec<_> = pages[0].objects.iter().map(|o| o.key.as_str()).collect();
        assert_eq!(keys, ["v/a.mp4", "v/b.mp4"]);
        assert_eq!(pages[0].prefixes, ["v/d/"]);
        assert_eq!(pages[0].objects[0], object("v/a.mp4", 3));
        assert_eq!(load(&cache, &folder("anders/")), None);
    }

    #[test]
    fn splits_large_listings_into_pages() {
        let cache = SqliteListingCache::in_memory().unwrap();
        let keys: Vec<String> = (0..2500).map(|i| format!("k{i:05}")).collect();
        let refs: Vec<&str> = keys.iter().map(String::as_str).collect();
        store(&cache, &folder(""), &[page(&refs, &[])], 1);
        let (_, pages) = load(&cache, &folder("")).unwrap();
        let sizes: Vec<usize> = pages.iter().map(ListPage::entry_count).collect();
        assert_eq!(sizes, [1000, 1000, 500]);
    }

    #[test]
    fn replaces_the_old_listing_only_on_commit() {
        let cache = SqliteListingCache::in_memory().unwrap();
        store(&cache, &folder(""), &[page(&["alt"], &[])], 1);
        let write = cache.begin(&folder("")).unwrap();
        cache.append(write, &page(&["neu"], &[])).unwrap();
        assert_eq!(load(&cache, &folder("")).unwrap().1[0].objects[0].key, "alt");
        cache.commit(write, 2).unwrap();
        let (fetched, pages) = load(&cache, &folder("")).unwrap();
        assert_eq!((fetched, pages[0].objects[0].key.as_str()), (2, "neu"));
        assert_eq!(cache.stats().unwrap().folders, 1);
    }

    #[test]
    fn discards_unfinished_listings() {
        let cache = SqliteListingCache::in_memory().unwrap();
        let write = cache.begin(&folder("")).unwrap();
        cache.append(write, &page(&["x"], &[])).unwrap();
        cache.discard(write).unwrap();
        assert_eq!(load(&cache, &folder("")), None);
        assert_eq!(cache.stats().unwrap().entries, 0);
    }

    #[test]
    fn forgets_profiles_and_clears_everything() {
        let cache = SqliteListingCache::in_memory().unwrap();
        store(&cache, &folder("a/"), &[page(&["a/1", "a/2"], &[])], 1);
        store(&cache, &FolderKey::new("p2", "b", ""), &[page(&["x"], &[])], 1);
        let stats = cache.stats().unwrap();
        assert_eq!((stats.folders, stats.entries), (2, 3));
        assert!(stats.bytes > 0);
        cache.forget_profile("p1").unwrap();
        assert_eq!(load(&cache, &folder("a/")), None);
        assert!(load(&cache, &FolderKey::new("p2", "b", "")).is_some());
        cache.clear().unwrap();
        assert_eq!(cache.stats().unwrap().folders, 0);
    }

    #[test]
    fn survives_reopening_and_drops_unfinished_listings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("neu").join(CACHE_FILE_NAME);
        {
            let cache = SqliteListingCache::open(&path).unwrap();
            store(&cache, &folder(""), &[page(&["bleibt"], &[])], 9);
            let write = cache.begin(&folder("halb/")).unwrap();
            cache.append(write, &page(&["halb/x"], &[])).unwrap();
        }
        let cache = SqliteListingCache::open(&path).unwrap();
        assert_eq!(load(&cache, &folder("")).unwrap().0, 9);
        assert_eq!(cache.stats().unwrap().entries, 1, "unvollständiges Listing ist weg");
    }
}
