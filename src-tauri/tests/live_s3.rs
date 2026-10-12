//! Live-Tests gegen einen echten S3-Anbieter (z. B. Hetzner Object Storage).
//!
//! Laufen nur, wenn `src-tauri/.live-s3.env` existiert (Vorlage: `.live-s3.env.example`).
//! Die Datei enthält Zugangsdaten, ist per .gitignore ausgeschlossen und wird nie ausgegeben.
//! Die Tests lesen nur, sie verändern nichts im Bucket.
// Tests nutzen unwrap auf Konfiguration und Ergebnisse.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use s3_commander_lib::adapters::clock::SystemClock;
use s3_commander_lib::adapters::s3::factory::HttpStoreFactory;
use s3_commander_lib::application::cancel::CancelFlag;
use s3_commander_lib::application::connection::test_connection;
use s3_commander_lib::application::listing::list_all;
use s3_commander_lib::domain::credentials::Credentials;
use s3_commander_lib::domain::endpoint::Addressing;
use s3_commander_lib::domain::object::ListRequest;
use s3_commander_lib::domain::profile::{ConnectionProfile, DEFAULT_CONCURRENCY, DEFAULT_TIMEOUT_SECS};
use s3_commander_lib::domain::provider::{Provider, Quirks};
use s3_commander_lib::ports::{ObjectStore, StoreFactory};
use std::collections::HashMap;
use std::path::Path;

const CONFIG_FILE: &str = ".live-s3.env";

struct Live {
    profile: ConnectionProfile,
    credentials: Credentials,
    bucket: String,
}

/// Liest `KEY=VALUE`-Zeilen; `#` leitet Kommentare ein.
fn parse_env(content: &str) -> HashMap<String, String> {
    content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| line.split_once('='))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
        .collect()
}

fn live() -> Option<Live> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(CONFIG_FILE);
    let Ok(content) = std::fs::read_to_string(&path) else {
        eprintln!("Live-Test übersprungen: {CONFIG_FILE} fehlt");
        return None;
    };
    let env = parse_env(&content);
    let get = |key: &str| {
        env.get(key)
            .cloned()
            .unwrap_or_else(|| panic!("{key} fehlt in {CONFIG_FILE}"))
    };
    let addressing = match env.get("S3_ADDRESSING").map(String::as_str) {
        Some("path-style") => Addressing::PathStyle,
        _ => Addressing::VirtualHosted,
    };
    let profile = ConnectionProfile {
        id: "live-test".into(),
        name: "Live-Test".into(),
        provider: Provider::Custom,
        endpoint: get("S3_ENDPOINT"),
        region: get("S3_REGION"),
        default_bucket: None,
        addressing,
        quirks: Quirks::CONSERVATIVE,
        timeout_secs: DEFAULT_TIMEOUT_SECS,
        concurrency: DEFAULT_CONCURRENCY,
        verify_tls: true,
        ca_file: None,
        proxy: None,
    };
    let credentials = Credentials::new(&get("S3_ACCESS_KEY"), &get("S3_SECRET_KEY"), None).unwrap();
    Some(Live {
        profile,
        credentials,
        bucket: get("S3_BUCKET"),
    })
}

fn store(live: &Live) -> <HttpStoreFactory<SystemClock> as StoreFactory>::Store {
    HttpStoreFactory::new(SystemClock)
        .create(&live.profile, live.credentials.clone())
        .expect("Profil ungültig")
}

#[test]
fn parses_the_config_format() {
    let env = parse_env("# Kommentar\n\nS3_REGION = fsn1\nS3_BUCKET=test=bucket\nkaputt\n");
    assert_eq!(env.get("S3_REGION").map(String::as_str), Some("fsn1"));
    assert_eq!(env.get("S3_BUCKET").map(String::as_str), Some("test=bucket"));
    assert_eq!(env.len(), 2);
}

#[tokio::test]
async fn connects_and_lists_buckets() {
    let Some(live) = live() else { return };
    let store = store(&live);
    let result = test_connection(&store, &SystemClock, None)
        .await
        .expect("Verbindungstest");
    let buckets = store.list_buckets().await.expect("ListBuckets");
    eprintln!("Verbunden: {} Buckets, {} ms", buckets.len(), result.latency_ms);
    assert!(
        buckets.iter().any(|b| b.name == live.bucket),
        "Bucket {} nicht in der Liste",
        live.bucket
    );
}

#[tokio::test]
async fn tests_the_configured_bucket_directly() {
    let Some(live) = live() else { return };
    let result = test_connection(&store(&live), &SystemClock, Some(&live.bucket))
        .await
        .expect("Bucket-Test");
    assert_eq!(result.bucket_count, None);
}

#[tokio::test]
async fn lists_the_bucket_root_completely() {
    let Some(live) = live() else { return };
    let summary = list_all(
        &store(&live),
        ListRequest::folder(&live.bucket, ""),
        &CancelFlag::default(),
        |page| {
            for prefix in &page.prefixes {
                assert!(prefix.ends_with('/'), "Ordner ohne /: {prefix}");
            }
        },
    )
    .await
    .expect("Listing");
    eprintln!(
        "Wurzel: {} Objekte, {} Ordner, {} Seiten",
        summary.objects, summary.prefixes, summary.pages
    );
    assert!(summary.pages >= 1);
}

#[tokio::test]
async fn pages_with_small_page_size() {
    let Some(live) = live() else { return };
    let request = ListRequest {
        max_keys: Some(2),
        ..ListRequest::recursive(&live.bucket, "")
    };
    let mut keys = Vec::new();
    let summary = list_all(&store(&live), request, &CancelFlag::default(), |page| {
        assert!(page.objects.len() <= 2);
        keys.extend(page.objects.into_iter().map(|o| o.key));
    })
    .await
    .expect("Listing mit kleinen Seiten");
    let mut sorted = keys.clone();
    sorted.sort();
    assert_eq!(keys, sorted, "S3 liefert Keys sortiert");
    eprintln!("Rekursiv: {} Objekte in {} Seiten", summary.objects, summary.pages);
}
