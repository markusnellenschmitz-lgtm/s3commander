//! Anwendungsfall: einen lokalen Ordner mit einem Ordner im Bucket abgleichen.
//!
//! Erst entsteht ein Plan zur Vorschau (was ist neu, geändert, unverändert, nur im Ziel), dann
//! reiht die Transfer-Verwaltung ihn ein. Bucket → Lokal überschreibt geänderte Dateien und gibt
//! ihnen die Änderungszeit des Objekts, damit der nächste Abgleich sie als unverändert erkennt.
//! Gelöscht wird hier nichts: Objekte, die lokal fehlen, nennt die Vorschau; löschen kann die
//! Oberfläche sie über den gewohnten Löschdialog. Lokale Dateien werden nie gelöscht.

use super::cancel::CancelFlag;
use super::download::DownloadJob;
use super::error::AppError;
use super::listing::list_all;
use crate::domain::object::ListRequest;
use crate::domain::sync::{PREVIEW_LIMIT, SyncDirection, SyncEntry, SyncReason, decide};
use crate::domain::transfer::{LocalFile, ObjectRef};
use crate::ports::{LocalFiles, StoreProvider};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

/// Was abgeglichen werden soll.
#[derive(Debug, Clone, Copy)]
pub struct SyncRequest<'a> {
    pub profile_id: &'a str,
    pub bucket: &'a str,
    /// Ordner im Bucket, leer oder mit `/` am Ende.
    pub prefix: &'a str,
    pub local_root: &'a Path,
    pub direction: SyncDirection,
}

/// Eine Zeile der Vorschau.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncItem {
    pub relative: String,
    pub size: u64,
    pub reason: SyncReason,
}

/// Objekt im Bucket, das lokal fehlt (nur Lokal → Bucket).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteExtra {
    pub key: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPreview {
    pub plan_id: String,
    pub direction: SyncDirection,
    /// Zu übertragende Dateien und ihre Summe.
    pub transfers: usize,
    pub bytes: u64,
    pub unchanged: usize,
    /// Die ersten [`PREVIEW_LIMIT`] Übertragungen.
    pub items: Vec<SyncItem>,
    /// Lokal → Bucket: Objekte, die lokal fehlen.
    pub remote_extras: Vec<RemoteExtra>,
    /// Bucket → Lokal: Dateien, die nur lokal liegen; sie bleiben, wie sie sind.
    pub local_extras: usize,
}

/// Bereit zum Einreihen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncWork {
    /// Lokale Datei und Ziel-Key.
    Uploads(Vec<(LocalFile, String)>),
    Downloads(Vec<DownloadJob>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncPlan {
    pub profile_id: String,
    pub bucket: String,
    pub work: SyncWork,
}

pub struct SyncService<P, L> {
    provider: P,
    files: L,
    plans: Mutex<HashMap<String, SyncPlan>>,
    next_plan: AtomicU64,
}

impl<P, L> std::fmt::Debug for SyncService<P, L> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SyncService").finish_non_exhaustive()
    }
}

/// Eine Seite des Abgleichs: Einträge für den Vergleich und woher sie stammen.
struct Side<T> {
    entries: Vec<SyncEntry>,
    origins: Vec<T>,
}

/// Objekt aus dem Listing.
struct RemoteObject {
    key: String,
    etag: Option<String>,
}

impl<P: StoreProvider, L: LocalFiles> SyncService<P, L> {
    pub fn new(provider: P, files: L) -> Self {
        Self {
            provider,
            files,
            plans: Mutex::default(),
            next_plan: AtomicU64::new(1),
        }
    }

    /// Vergleicht beide Seiten und merkt sich den Plan bis zum Start.
    ///
    /// # Errors
    /// Unbekanntes Profil, Fehler beim Listen oder ein lokaler Ordner, der sich nicht lesen lässt.
    pub async fn plan(&self, request: SyncRequest<'_>) -> Result<SyncPreview, AppError> {
        let local = self.local_side(request.local_root)?;
        let remote = self.remote_side(&request).await?;
        let (source, target) = match request.direction {
            SyncDirection::Upload => (&local.entries, &remote.entries),
            SyncDirection::Download => (&remote.entries, &local.entries),
        };
        let decision = decide(source, target);
        let items: Vec<SyncItem> = decision
            .transfers
            .iter()
            .map(|&(index, reason)| SyncItem {
                relative: source[index].relative.clone(),
                size: source[index].size,
                reason,
            })
            .collect();
        let chosen: Vec<usize> = decision.transfers.iter().map(|(index, _)| *index).collect();
        let (work, remote_extras, local_extras) = match request.direction {
            SyncDirection::Upload => {
                let extras = decision
                    .extras
                    .iter()
                    .map(|&i| RemoteExtra {
                        key: remote.origins[i].key.clone(),
                        size: remote.entries[i].size,
                    })
                    .collect();
                (upload_work(&request, &local, &chosen), extras, 0)
            }
            SyncDirection::Download => (
                download_work(&request, &remote, &chosen),
                Vec::new(),
                decision.extras.len(),
            ),
        };
        let plan_id = format!("sync-{}", self.next_plan.fetch_add(1, Ordering::Relaxed));
        self.lock().insert(
            plan_id.clone(),
            SyncPlan {
                profile_id: request.profile_id.to_owned(),
                bucket: request.bucket.to_owned(),
                work,
            },
        );
        Ok(SyncPreview {
            plan_id,
            direction: request.direction,
            transfers: items.len(),
            bytes: items.iter().map(|i| i.size).sum(),
            unchanged: decision.unchanged,
            items: items.into_iter().take(PREVIEW_LIMIT).collect(),
            remote_extras,
            local_extras,
        })
    }

    /// Gibt den Plan zum Einreihen heraus; jeder Plan gilt nur einmal.
    ///
    /// # Errors
    /// `SyncPlanNotFound`, wenn der Plan unbekannt oder schon gestartet ist.
    pub fn take(&self, plan_id: &str) -> Result<SyncPlan, AppError> {
        self.lock()
            .remove(plan_id)
            .ok_or_else(|| AppError::SyncPlanNotFound(plan_id.to_owned()))
    }

    /// Lokaler Ordner; Pfade relativ zum Ordner selbst.
    fn local_side(&self, root: &Path) -> Result<Side<LocalFile>, AppError> {
        let files = self.files.expand(&[root.to_path_buf()])?;
        let entries = files
            .iter()
            .map(|file| SyncEntry {
                relative: file.relative.split_once('/').map_or("", |(_, rest)| rest).to_owned(),
                size: file.size,
                modified_ms: file.modified_ms,
            })
            .collect();
        Ok(Side {
            entries,
            origins: files,
        })
    }

    /// Alle Objekte unter dem Präfix; Ordner-Platzhalter zählen nicht.
    async fn remote_side(&self, request: &SyncRequest<'_>) -> Result<Side<RemoteObject>, AppError> {
        let store = self.provider.store_for(request.profile_id)?;
        let mut side = Side {
            entries: Vec::new(),
            origins: Vec::new(),
        };
        let listing = ListRequest::recursive(request.bucket, request.prefix);
        list_all(store.as_ref(), listing, &CancelFlag::default(), |page| {
            for object in page.objects.into_iter().filter(|o| !o.key.ends_with('/')) {
                side.entries.push(SyncEntry {
                    relative: object.key[request.prefix.len()..].to_owned(),
                    size: object.size,
                    modified_ms: object.last_modified_ms,
                });
                side.origins.push(RemoteObject {
                    key: object.key,
                    etag: object.etag,
                });
            }
        })
        .await?;
        Ok(side)
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, SyncPlan>> {
        self.plans.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn upload_work(request: &SyncRequest<'_>, local: &Side<LocalFile>, chosen: &[usize]) -> SyncWork {
    SyncWork::Uploads(
        chosen
            .iter()
            .map(|&i| {
                let key = format!("{}{}", request.prefix, local.entries[i].relative);
                (local.origins[i].clone(), key)
            })
            .collect(),
    )
}

fn download_work(request: &SyncRequest<'_>, remote: &Side<RemoteObject>, chosen: &[usize]) -> SyncWork {
    SyncWork::Downloads(
        chosen
            .iter()
            .map(|&i| {
                let entry = &remote.entries[i];
                DownloadJob {
                    source: ObjectRef {
                        bucket: request.bucket.to_owned(),
                        key: remote.origins[i].key.clone(),
                        content_type: None,
                    },
                    etag: remote.origins[i].etag.clone(),
                    size: entry.size,
                    target: local_path(request.local_root, &entry.relative),
                    modified_ms: entry.modified_ms,
                    replace_existing: true,
                    keep_remote_time: true,
                }
            })
            .collect(),
    )
}

/// Lokaler Pfad zu einem relativen Pfad mit `/`.
fn local_path(root: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .fold(root.to_path_buf(), |path, part| path.join(part))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::test_support::{FakeFiles, FakeProvider, FakeStore};
    use crate::domain::object::{ListPage, ObjectEntry};
    use std::sync::Arc;

    const ROOT: &str = r"C:\upload";

    fn remote(key: &str, size: u64, modified_ms: i64) -> ObjectEntry {
        ObjectEntry {
            key: key.into(),
            size,
            last_modified_ms: Some(modified_ms),
            etag: Some(format!("\"{key}\"")),
            storage_class: None,
        }
    }

    /// Lokal: datei-0.bin (10 B), datei-1.bin (20 B), beide mit Zeit 50.000.
    fn service(objects: Vec<ObjectEntry>) -> (SyncService<FakeProvider, FakeFiles>, Arc<FakeStore>) {
        let store = Arc::new(FakeStore::with_pages(vec![ListPage {
            objects,
            ..ListPage::default()
        }]));
        let files = FakeFiles::with_sizes(&[10, 20]);
        files.set_file_time(Some(50_000));
        (SyncService::new(FakeProvider::new(Arc::clone(&store)), files), store)
    }

    fn request(direction: SyncDirection) -> SyncRequest<'static> {
        SyncRequest {
            profile_id: "p1",
            bucket: "b",
            prefix: "sicherung/",
            local_root: Path::new(ROOT),
            direction,
        }
    }

    #[tokio::test]
    async fn plans_uploads_of_new_and_changed_files_and_names_remote_extras() {
        let (s, store) = service(vec![
            remote("sicherung/datei-1.bin", 99, 0),
            remote("sicherung/alt.bin", 5, 0),
            remote("sicherung/ordner/", 0, 0),
        ]);
        let preview = s.plan(request(SyncDirection::Upload)).await.unwrap();
        assert_eq!((preview.transfers, preview.bytes, preview.unchanged), (2, 30, 0));
        assert_eq!(preview.items[1].reason, SyncReason::SizeDiffers);
        assert_eq!(
            preview.remote_extras,
            [RemoteExtra {
                key: "sicherung/alt.bin".into(),
                size: 5
            }]
        );
        assert_eq!(store.requests()[0].prefix, "sicherung/");
        let plan = s.take(&preview.plan_id).unwrap();
        let SyncWork::Uploads(uploads) = plan.work else {
            panic!("Uploads erwartet")
        };
        assert_eq!(uploads[0].1, "sicherung/datei-0.bin");
        assert!(matches!(s.take(&preview.plan_id), Err(AppError::SyncPlanNotFound(_))));
    }

    #[tokio::test]
    async fn plans_downloads_that_replace_files_and_keep_the_server_time() {
        let (s, _) = service(vec![
            remote("sicherung/datei-0.bin", 10, 40_000),
            remote("sicherung/datei-1.bin", 20, 90_000),
            remote("sicherung/neu/bericht.pdf", 7, 90_000),
        ]);
        let preview = s.plan(request(SyncDirection::Download)).await.unwrap();
        assert_eq!((preview.transfers, preview.unchanged, preview.local_extras), (2, 1, 0));
        assert_eq!(preview.items[0].reason, SyncReason::Newer);
        let SyncWork::Downloads(jobs) = s.take(&preview.plan_id).unwrap().work else {
            panic!("Downloads erwartet")
        };
        assert_eq!(jobs[1].target, Path::new(ROOT).join("neu").join("bericht.pdf"));
        assert!(jobs.iter().all(|j| j.replace_existing && j.keep_remote_time));
        assert_eq!(jobs[0].etag.as_deref(), Some("\"sicherung/datei-1.bin\""));
    }

    #[tokio::test]
    async fn counts_local_only_files_and_reports_unreadable_folders() {
        let (s, _) = service(Vec::new());
        let preview = s.plan(request(SyncDirection::Download)).await.unwrap();
        assert_eq!((preview.transfers, preview.local_extras), (0, 2));
        s.files.fail();
        assert!(matches!(
            s.plan(request(SyncDirection::Upload)).await,
            Err(AppError::Store(_))
        ));
    }
}
