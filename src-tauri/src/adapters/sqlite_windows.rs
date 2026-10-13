//! Fenster auf gespeicherte Listings im SQLite-Cache: Eine Sicht ist eine temporäre Tabelle mit
//! den Keys der Treffer in Anzeigereihenfolge. Sortiert und gefiltert wird einmal beim Anlegen,
//! danach liefert jedes Fenster seine Zeilen über die Position, ohne erneut zu sortieren.

use super::sqlite_cache::{SqliteListingCache, storage};
use crate::domain::error::CacheError;
use crate::domain::listing_window::{
    EntryKind, ListingId, SortColumn, ViewId, ViewInfo, WindowEntry, WindowFilter, WindowSort, WindowStats, kind_of,
    name_matches,
};
use crate::ports::ListingWindows;
use rusqlite::functions::FunctionFlags;
use rusqlite::types::Value;
use rusqlite::{Connection, Row, params, params_from_iter};
use std::collections::HashSet;

/// Letztes Segment des Keys relativ zum Präfix des Listings (Ordner mit `/`).
const NAME: &str = "substr(e.key, length(l.prefix) + 1)";

/// Meldet die Funktionen an, die Sichten zum Filtern brauchen. Sortiert wird ohne Rückruf über
/// den beim Speichern berechneten Schlüssel `sort_name`.
///
/// # Errors
/// Wenn SQLite die Anmeldung ablehnt.
pub fn register_functions(connection: &Connection) -> rusqlite::Result<()> {
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;
    connection.create_scalar_function("name_matches", 2, flags, |ctx| {
        Ok(name_matches(&ctx.get::<String>(0)?, &ctx.get::<String>(1)?))
    })?;
    connection.create_scalar_function("entry_kind", 3, flags, |ctx| {
        let kind = kind_of(
            &ctx.get::<String>(0)?,
            ctx.get(1)?,
            ctx.get::<Option<String>>(2)?.as_deref(),
        );
        Ok(kind_name(kind))
    })
}

fn kind_name(kind: EntryKind) -> &'static str {
    match kind {
        EntryKind::Folder => "folder",
        EntryKind::Archive => "archive",
        EntryKind::Text => "text",
        EntryKind::Lock => "lock",
        EntryKind::File => "file",
    }
}

fn table(view: ViewId) -> String {
    format!("temp.window_view_{view}")
}

/// Bedingungen und Werte für den Filter einer Sicht.
fn filter_clause(filter: &WindowFilter) -> (String, Vec<Value>) {
    let mut conditions = Vec::new();
    let mut values = Vec::new();
    if !filter.text.trim().is_empty() {
        conditions.push(format!("name_matches({NAME}, ?)"));
        values.push(Value::Text(filter.text.clone()));
    }
    if let Some(kind) = filter.kind {
        conditions.push(format!("entry_kind({NAME}, e.is_prefix, e.storage_class) = ?"));
        values.push(Value::Text(kind_name(kind).to_owned()));
    }
    if filter.filters_size() {
        conditions.push("e.is_prefix = 0".to_owned());
    }
    let bounds = [
        ("e.size >= ?", filter.min_size.map(saturating_i64)),
        ("e.size < ?", filter.max_size.map(saturating_i64)),
        ("e.last_modified_ms >= ?", filter.modified_from),
        ("e.last_modified_ms <= ?", filter.modified_to),
    ];
    for (condition, bound) in bounds {
        if let Some(bound) = bound {
            conditions.push(condition.to_owned());
            values.push(Value::Integer(bound));
        }
    }
    let clause = conditions.iter().fold(String::new(), |mut clause, condition| {
        clause.push_str(" AND ");
        clause.push_str(condition);
        clause
    });
    (clause, values)
}

/// Reihenfolge wie in der Oberfläche: Ordner zuerst, dann die Spalte, bei Gleichstand der Name.
fn order_clause(sort: WindowSort) -> String {
    let dir = if sort.descending() { "DESC" } else { "ASC" };
    let column = match sort.column {
        SortColumn::Name => None,
        SortColumn::Size => Some("e.size".to_owned()),
        SortColumn::Modified => Some("COALESCE(e.last_modified_ms, 0)".to_owned()),
        SortColumn::StorageClass => Some("COALESCE(e.storage_class, '')".to_owned()),
    };
    let primary = column.map(|c| format!("{c} {dir}, ")).unwrap_or_default();
    format!("e.is_prefix DESC, {primary}e.sort_name {dir}, e.key {dir}")
}

fn saturating_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn count(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

fn window_entry(row: &Row<'_>) -> rusqlite::Result<WindowEntry> {
    Ok(WindowEntry {
        key: row.get(0)?,
        is_prefix: row.get(1)?,
        size: count(row.get(2)?),
        last_modified_ms: row.get(3)?,
        etag: row.get(4)?,
        storage_class: row.get(5)?,
    })
}

const ENTRY_COLUMNS: &str = "e.key, e.is_prefix, e.size, e.last_modified_ms, e.etag, e.storage_class";

fn stats(connection: &Connection, listing: ListingId, view: ViewId) -> rusqlite::Result<WindowStats> {
    let (matches, folders, bytes): (i64, i64, i64) = connection.query_row(
        &format!(
            "SELECT COUNT(*), COALESCE(SUM(e.is_prefix), 0), COALESCE(SUM(e.size), 0)
             FROM {} v JOIN entries e ON e.listing_id = ?1 AND e.key = v.key",
            table(view)
        ),
        params![listing],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let total: i64 = connection.query_row(
        "SELECT COUNT(*) FROM entries e JOIN listings l ON l.id = e.listing_id
         WHERE e.listing_id = ?1 AND e.key <> l.prefix",
        params![listing],
        |row| row.get(0),
    )?;
    Ok(WindowStats {
        count: count(matches),
        folders: count(folders),
        bytes: count(bytes),
        total: count(total),
    })
}

impl SqliteListingCache {
    fn view_listing(&self, view: ViewId) -> Result<ListingId, CacheError> {
        self.views()
            .get(&view)
            .copied()
            .ok_or_else(|| CacheError::Storage(format!("Sicht {view} ist nicht geöffnet")))
    }
}

impl ListingWindows for SqliteListingCache {
    fn open_view(&self, listing: ListingId, filter: &WindowFilter, sort: WindowSort) -> Result<ViewInfo, CacheError> {
        let view = self.next_view_id();
        let (conditions, values) = filter_clause(filter);
        let mut all_values = vec![Value::Integer(listing)];
        all_values.extend(values);
        let connection = self.lock();
        connection
            .execute(
                &format!(
                    "CREATE TABLE {} AS SELECT e.key AS key
                     FROM entries e JOIN listings l ON l.id = e.listing_id
                     WHERE e.listing_id = ? AND e.key <> l.prefix{conditions}
                     ORDER BY {}",
                    table(view),
                    order_clause(sort)
                ),
                params_from_iter(all_values),
            )
            .map_err(storage)?;
        let stats = stats(&connection, listing, view).map_err(storage)?;
        drop(connection);
        self.views().insert(view, listing);
        Ok(ViewInfo { view_id: view, stats })
    }

    fn view_entries(&self, view: ViewId, offset: u64, limit: u64) -> Result<Vec<WindowEntry>, CacheError> {
        let listing = self.view_listing(view)?;
        let connection = self.lock();
        let mut statement = connection
            .prepare(&format!(
                "SELECT {ENTRY_COLUMNS} FROM {} v JOIN entries e ON e.listing_id = ?1 AND e.key = v.key
                 WHERE v.rowid > ?2 ORDER BY v.rowid LIMIT ?3",
                table(view)
            ))
            .map_err(storage)?;
        let rows = statement
            .query_map(
                params![listing, saturating_i64(offset), saturating_i64(limit)],
                window_entry,
            )
            .map_err(storage)?;
        rows.collect::<rusqlite::Result<_>>().map_err(storage)
    }

    fn view_entries_except(&self, view: ViewId, excluded: &[String]) -> Result<Vec<WindowEntry>, CacheError> {
        let listing = self.view_listing(view)?;
        let excluded: HashSet<&str> = excluded.iter().map(String::as_str).collect();
        let connection = self.lock();
        let mut statement = connection
            .prepare(&format!(
                "SELECT {ENTRY_COLUMNS} FROM {} v JOIN entries e ON e.listing_id = ?1 AND e.key = v.key
                 ORDER BY v.rowid",
                table(view)
            ))
            .map_err(storage)?;
        let rows = statement.query_map(params![listing], window_entry).map_err(storage)?;
        let mut entries = Vec::new();
        for entry in rows {
            let entry = entry.map_err(storage)?;
            if !excluded.contains(entry.key.as_str()) {
                entries.push(entry);
            }
        }
        Ok(entries)
    }

    fn close_view(&self, view: ViewId) {
        if self.views().remove(&view).is_none() {
            return;
        }
        if let Err(error) = self
            .lock()
            .execute(&format!("DROP TABLE IF EXISTS {}", table(view)), [])
        {
            log::warn!("Sicht {view} nicht verworfen: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::listing_cache::FolderKey;
    use crate::domain::object::{ListPage, ObjectEntry};
    use crate::ports::ListingCache;

    const PREFIX: &str = "p/";

    fn object(name: &str, size: u64, modified: i64, class: &str) -> ObjectEntry {
        ObjectEntry {
            key: format!("{PREFIX}{name}"),
            size,
            last_modified_ms: Some(modified),
            etag: Some(format!("\"{name}\"")),
            storage_class: Some(class.into()),
        }
    }

    /// Listing mit zwei Ordnern, fünf Dateien und dem Platzhalter des Ordners selbst.
    fn cache_with_listing() -> (SqliteListingCache, ListingId) {
        let cache = SqliteListingCache::in_memory().unwrap();
        let write = cache.begin(&FolderKey::new("p1", "b", PREFIX)).unwrap();
        let page = ListPage {
            objects: vec![
                // Ordner-Platzhalter, wie ihn die AWS-Konsole anlegt; erscheint nicht in Sichten.
                object("", 0, 1, "STANDARD"),
                object("Bericht10.pdf", 300, 30, "STANDARD"),
                object("bericht2.pdf", 200, 20, "GLACIER"),
                object("daten.tar.zst", 5_000, 50, "STANDARD"),
                object("notiz.txt", 10, 40, "STANDARD_IA"),
                object("Übersicht.csv", 40, 10, "STANDARD"),
            ],
            prefixes: vec![format!("{PREFIX}Zeta/"), format!("{PREFIX}alpha/")],
            next_token: None,
        };
        cache.append(write, &page).unwrap();
        cache.commit(write, 1).unwrap();
        (cache, write)
    }

    fn sort(column: SortColumn, dir: i8) -> WindowSort {
        WindowSort { column, dir }
    }

    fn names(cache: &SqliteListingCache, view: ViewId) -> Vec<String> {
        cache
            .view_entries(view, 0, 100)
            .unwrap()
            .into_iter()
            .map(|e| e.key.trim_start_matches(PREFIX).to_owned())
            .collect()
    }

    fn open(cache: &SqliteListingCache, listing: ListingId, filter: &WindowFilter, s: WindowSort) -> ViewInfo {
        cache.open_view(listing, filter, s).unwrap()
    }

    #[test]
    fn sorts_folders_first_and_names_naturally() {
        let (cache, listing) = cache_with_listing();
        let info = open(&cache, listing, &WindowFilter::default(), sort(SortColumn::Name, 1));
        assert_eq!(
            names(&cache, info.view_id),
            [
                "alpha/",
                "Zeta/",
                "bericht2.pdf",
                "Bericht10.pdf",
                "daten.tar.zst",
                "notiz.txt",
                "Übersicht.csv"
            ]
        );
        assert_eq!(
            info.stats,
            WindowStats {
                count: 7,
                folders: 2,
                bytes: 5_550,
                total: 7
            }
        );
        let down = open(&cache, listing, &WindowFilter::default(), sort(SortColumn::Name, -1));
        assert_eq!(names(&cache, down.view_id)[..3], ["Zeta/", "alpha/", "Übersicht.csv"]);
    }

    #[test]
    fn sorts_by_size_date_and_storage_class() {
        let (cache, listing) = cache_with_listing();
        let none = WindowFilter::default();
        let by_size = open(&cache, listing, &none, sort(SortColumn::Size, -1));
        assert_eq!(names(&cache, by_size.view_id)[2..4], ["daten.tar.zst", "Bericht10.pdf"]);
        let by_date = open(&cache, listing, &none, sort(SortColumn::Modified, 1));
        assert_eq!(names(&cache, by_date.view_id)[2], "Übersicht.csv");
        let by_class = open(&cache, listing, &none, sort(SortColumn::StorageClass, 1));
        assert_eq!(names(&cache, by_class.view_id)[2], "bericht2.pdf", "GLACIER zuerst");
    }

    #[test]
    fn filters_by_text_kind_size_and_date() {
        let (cache, listing) = cache_with_listing();
        let by_name = sort(SortColumn::Name, 1);
        let text = WindowFilter {
            text: "bericht*pdf".into(),
            ..WindowFilter::default()
        };
        assert_eq!(
            names(&cache, open(&cache, listing, &text, by_name).view_id),
            ["bericht2.pdf", "Bericht10.pdf"]
        );
        let kind = WindowFilter {
            kind: Some(EntryKind::Lock),
            ..WindowFilter::default()
        };
        assert_eq!(
            names(&cache, open(&cache, listing, &kind, by_name).view_id),
            ["bericht2.pdf"]
        );
        let size = WindowFilter {
            min_size: Some(0),
            max_size: Some(100),
            ..WindowFilter::default()
        };
        let info = open(&cache, listing, &size, by_name);
        assert_eq!(
            names(&cache, info.view_id),
            ["notiz.txt", "Übersicht.csv"],
            "ohne Ordner"
        );
        assert_eq!((info.stats.count, info.stats.bytes, info.stats.total), (2, 50, 7));
        let date = WindowFilter {
            modified_from: Some(20),
            modified_to: Some(40),
            ..WindowFilter::default()
        };
        assert_eq!(
            names(&cache, open(&cache, listing, &date, by_name).view_id),
            ["bericht2.pdf", "Bericht10.pdf", "notiz.txt"]
        );
    }

    #[test]
    fn delivers_windows_by_position_and_everything_but_excluded_keys() {
        let (cache, listing) = cache_with_listing();
        let view = open(&cache, listing, &WindowFilter::default(), sort(SortColumn::Name, 1)).view_id;
        let window: Vec<_> = cache.view_entries(view, 2, 2).unwrap();
        assert_eq!(window[0].key, "p/bericht2.pdf");
        assert_eq!(window[1].size, 300);
        assert_eq!(window[1].etag.as_deref(), Some("\"Bericht10.pdf\""));
        assert_eq!(cache.view_entries(view, 7, 5).unwrap().len(), 0);
        let rest = cache
            .view_entries_except(view, &["p/alpha/".into(), "p/notiz.txt".into()])
            .unwrap();
        assert_eq!(rest.len(), 5);
        assert!(rest[0].is_prefix && rest[0].key == "p/Zeta/");
    }

    #[test]
    fn closes_views_and_rejects_unknown_ones() {
        let (cache, listing) = cache_with_listing();
        let view = open(&cache, listing, &WindowFilter::default(), sort(SortColumn::Name, 1)).view_id;
        cache.close_view(view);
        cache.close_view(view);
        assert!(cache.view_entries(view, 0, 1).is_err());
        assert!(cache.view_entries_except(view, &[]).is_err());
    }

    #[test]
    fn views_of_replaced_listings_become_empty() {
        let (cache, listing) = cache_with_listing();
        let view = open(&cache, listing, &WindowFilter::default(), sort(SortColumn::Name, 1)).view_id;
        let write = cache.begin(&FolderKey::new("p1", "b", PREFIX)).unwrap();
        cache.commit(write, 2).unwrap();
        assert_eq!(cache.view_entries(view, 0, 10).unwrap().len(), 0);
    }
}
