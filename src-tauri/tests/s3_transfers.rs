//! Integrationstests der Transfer-Operationen des HTTP-Adapters gegen einen S3-Mock (wiremock):
//! Uploads (Streaming aus Dateien, Multipart-Ablauf, `ListParts`, Abbruch, Fehlerfälle) und
//! Downloads (Range-Requests direkt in Teildateien, Ende-zu-Ende mit dem lokalen Dateisystem).
// Tests nutzen unwrap auf feste Testdaten.
#![allow(clippy::unwrap_used)]

use s3_commander_lib::adapters::local_files::StdLocalFiles;
use s3_commander_lib::adapters::s3::client::{HttpObjectStore, HttpOptions, S3Config};
use s3_commander_lib::application::cancel::CancelFlag;
use s3_commander_lib::application::download::{
    DownloadJob, DownloadOptions, DownloadOutcome, DownloadResume, download,
};
use s3_commander_lib::application::parts::{PartProgress, PartSettings};
use s3_commander_lib::application::upload::{ResumeState, UploadJob, upload};
use s3_commander_lib::domain::credentials::Credentials;
use s3_commander_lib::domain::endpoint::{Addressing, Endpoint};
use s3_commander_lib::domain::error::StoreError;
use s3_commander_lib::domain::multipart::MIB;
use s3_commander_lib::domain::provider::Quirks;
use s3_commander_lib::domain::settings::ConflictPolicy;
use s3_commander_lib::domain::transfer::{ByteCounter, Checksums, CompletedPart, FileRange, ObjectRef};
use s3_commander_lib::ports::{Clock, ObjectStore};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use time::OffsetDateTime;
use time::macros::datetime;
use wiremock::matchers::{body_bytes, body_string_contains, header, method, path, query_param, query_param_is_missing};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[derive(Debug, Clone, Copy)]
struct FixedClock;

impl Clock for FixedClock {
    fn utc_now(&self) -> OffsetDateTime {
        datetime!(2026-10-11 15:23:08 UTC)
    }

    fn monotonic(&self) -> Instant {
        Instant::now()
    }
}

fn store(server: &MockServer) -> HttpObjectStore<FixedClock> {
    store_with(server, Quirks::CONSERVATIVE)
}

fn store_with(server: &MockServer, quirks: Quirks) -> HttpObjectStore<FixedClock> {
    let config = S3Config {
        endpoint: Endpoint::new(&server.uri(), "fsn1", Addressing::PathStyle).unwrap(),
        credentials: Credentials::new("AKID", "geheim", None).unwrap(),
        quirks,
        http: HttpOptions {
            timeout: Duration::from_secs(10),
            ..HttpOptions::default()
        },
    };
    HttpObjectStore::new(config, FixedClock).unwrap()
}

fn target(content_type: Option<&str>) -> ObjectRef {
    ObjectRef {
        bucket: "gtg-mods".into(),
        key: "uploads/mod paket.zip".into(),
        content_type: content_type.map(str::to_owned),
    }
}

/// Datei mit wiederholbarem Inhalt, damit Teile im Mock geprüft werden können.
/// Inhalt an Position i; 251 ist prim, damit sich Teile nicht gleichen.
fn byte(i: usize) -> u8 {
    u8::try_from(i % 251).unwrap()
}

fn write_file(dir: &tempfile::TempDir, size: usize) -> PathBuf {
    let path = dir.path().join("datei.bin");
    let content: Vec<u8> = (0..size).map(byte).collect();
    std::fs::write(&path, content).unwrap();
    path
}

const OBJECT_PATH: &str = "/gtg-mods/uploads/mod%20paket.zip";

#[tokio::test]
async fn streams_a_file_range_with_put_and_returns_the_etag() {
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let file = write_file(&dir, 1000);
    let expected: Vec<u8> = (100..400).map(byte).collect();
    Mock::given(method("PUT"))
        .and(path(OBJECT_PATH))
        .and(header("x-amz-content-sha256", "UNSIGNED-PAYLOAD"))
        .and(header("content-length", "300"))
        .and(header("content-type", "application/zip"))
        .and(body_bytes(expected))
        .respond_with(ResponseTemplate::new(200).insert_header("ETag", "\"abc\""))
        .expect(1)
        .mount(&server)
        .await;

    let progress = ByteCounter::default();
    let source = FileRange {
        path: file,
        offset: 100,
        length: 300,
    };
    let etag = store(&server)
        .put_object(&target(Some("application/zip")), &source, &progress, Checksums::Off)
        .await
        .unwrap();
    assert_eq!(etag, "\"abc\"");
    assert_eq!(progress.get(), 300);
}

#[tokio::test]
async fn uploads_a_large_file_as_multipart() {
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let size: u64 = 11 * MIB;
    let file = write_file(&dir, usize::try_from(size).unwrap());
    Mock::given(method("POST"))
        .and(path(OBJECT_PATH))
        .and(query_param("uploads", ""))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            "<InitiateMultipartUploadResult><UploadId>UP-1</UploadId></InitiateMultipartUploadResult>",
        ))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path(OBJECT_PATH))
        .and(query_param("uploadId", "UP-1"))
        .respond_with(ResponseTemplate::new(200).insert_header("ETag", "\"teil\""))
        .expect(3)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path(OBJECT_PATH))
        .and(query_param("uploadId", "UP-1"))
        .and(body_string_contains(
            "<Part><PartNumber>3</PartNumber><ETag>&quot;teil&quot;</ETag></Part>",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            "<CompleteMultipartUploadResult><ETag>\"fertig-3\"</ETag></CompleteMultipartUploadResult>",
        ))
        .expect(1)
        .mount(&server)
        .await;

    let job = UploadJob {
        target: target(None),
        file,
        size,
    };
    let settings = PartSettings {
        part_size: 5 * MIB,
        multipart_threshold: 8 * MIB,
        ..PartSettings::default()
    };
    let progress = PartProgress::default();
    let etag = upload(
        &store(&server),
        &job,
        &settings,
        &ResumeState::default(),
        &progress,
        &CancelFlag::default(),
    )
    .await
    .unwrap();
    assert_eq!(etag, "\"fertig-3\"");
    assert_eq!(progress.done_bytes(), size);
    assert_eq!(progress.parts_done(), 3);

    let parts: Vec<_> = server
        .received_requests()
        .await
        .unwrap()
        .into_iter()
        .filter(|r| r.method.as_str() == "PUT")
        .map(|r| r.body.len())
        .collect();
    assert_eq!(parts.iter().sum::<usize>(), usize::try_from(size).unwrap());
}

#[tokio::test]
async fn lists_parts_across_pages() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(OBJECT_PATH))
        .and(query_param("uploadId", "UP-1"))
        .and(query_param_is_missing("part-number-marker"))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            "<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>1</NextPartNumberMarker>\
             <Part><PartNumber>1</PartNumber><ETag>\"a\"</ETag><Size>5</Size></Part></ListPartsResult>",
        ))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path(OBJECT_PATH))
        .and(query_param("part-number-marker", "1"))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            "<ListPartsResult><IsTruncated>false</IsTruncated>\
             <Part><PartNumber>2</PartNumber><ETag>\"b\"</ETag><Size>3</Size></Part></ListPartsResult>",
        ))
        .mount(&server)
        .await;
    let parts = store(&server).list_parts(&target(None), "UP-1").await.unwrap();
    assert_eq!(parts.iter().map(|p| p.part_number).collect::<Vec<_>>(), [1, 2]);
}

#[tokio::test]
async fn aborts_multipart_uploads() {
    let server = MockServer::start().await;
    Mock::given(method("DELETE"))
        .and(path(OBJECT_PATH))
        .and(query_param("uploadId", "UP-1"))
        .respond_with(ResponseTemplate::new(204))
        .expect(1)
        .mount(&server)
        .await;
    store(&server)
        .abort_multipart_upload(&target(None), "UP-1")
        .await
        .unwrap();
}

#[tokio::test]
async fn reports_errors_hidden_in_a_successful_complete() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string("<Error><Code>InternalError</Code><Message>bitte wiederholen</Message></Error>"),
        )
        .mount(&server)
        .await;
    let parts = [CompletedPart::new(1, "\"a\"".into())];
    let result = store(&server)
        .complete_multipart_upload(&target(None), "UP-1", &parts)
        .await;
    let Err(StoreError::Service(error)) = result else {
        panic!("Fehler erwartet")
    };
    assert_eq!(error.code, "InternalError");
}

#[tokio::test]
async fn reports_missing_local_files_and_missing_etags() {
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let s = store(&server);
    let missing = FileRange {
        path: PathBuf::from("X:\\gibt\\es\\nicht.bin"),
        offset: 0,
        length: 1,
    };
    let result = s
        .put_object(&target(None), &missing, &ByteCounter::default(), Checksums::Off)
        .await;
    assert!(matches!(result, Err(StoreError::LocalFile(_))), "{result:?}");

    let dir = tempfile::tempdir().unwrap();
    let file = FileRange {
        path: write_file(&dir, 10),
        offset: 0,
        length: 10,
    };
    let result = s
        .put_object(&target(None), &file, &ByteCounter::default(), Checksums::Off)
        .await;
    assert!(matches!(result, Err(StoreError::InvalidResponse(_))), "{result:?}");
}

#[tokio::test]
async fn maps_rejected_uploads_to_service_errors() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(query_param("uploads", ""))
        .respond_with(
            ResponseTemplate::new(403)
                .insert_header("x-amz-request-id", "R1")
                .set_body_string("<Error><Code>AccessDenied</Code><Message>nein</Message></Error>"),
        )
        .mount(&server)
        .await;
    let Err(StoreError::Service(error)) = store(&server)
        .create_multipart_upload(&target(None), Checksums::Off)
        .await
    else {
        panic!("Fehler erwartet")
    };
    assert_eq!((error.code.as_str(), error.http_status), ("AccessDenied", 403));
}

// ---------- Downloads ----------

/// Leere Teildatei der Größe `size`, wie `prepare_download` sie anlegt.
fn partial_file(dir: &tempfile::TempDir, size: usize) -> PathBuf {
    let path = dir.path().join("ziel.bin.s3part");
    std::fs::write(&path, vec![0u8; size]).unwrap();
    path
}

fn content(range: std::ops::Range<usize>) -> Vec<u8> {
    range.map(byte).collect()
}

async fn download_into(server: &MockServer, part: &FileRange) -> (Result<(), StoreError>, u64) {
    let progress = ByteCounter::default();
    let result = store(server)
        .download_range(&target(None), Some("\"abc\""), part, &progress)
        .await;
    (result, progress.get())
}

#[tokio::test]
async fn writes_a_range_at_its_offset_with_range_and_if_match_headers() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(OBJECT_PATH))
        .and(header("range", "bytes=100-399"))
        .and(header("if-match", "\"abc\""))
        .respond_with(ResponseTemplate::new(206).set_body_bytes(content(100..400)))
        .expect(1)
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let part = FileRange {
        path: partial_file(&dir, 1000),
        offset: 100,
        length: 300,
    };
    let (result, transferred) = download_into(&server, &part).await;
    result.unwrap();
    assert_eq!(transferred, 300);
    let written = std::fs::read(&part.path).unwrap();
    assert_eq!(&written[100..400], content(100..400).as_slice());
    assert!(written[..100].iter().chain(&written[400..]).all(|b| *b == 0));
}

#[tokio::test]
async fn downloads_a_large_object_in_parallel_ranges_into_the_target_file() {
    let server = MockServer::start().await;
    let size: u64 = 11 * MIB;
    let size_usize = usize::try_from(size).unwrap();
    for (first, last) in [(0, 5 * MIB - 1), (5 * MIB, 10 * MIB - 1), (10 * MIB, size - 1)] {
        let body = content(usize::try_from(first).unwrap()..usize::try_from(last + 1).unwrap());
        Mock::given(method("GET"))
            .and(path(OBJECT_PATH))
            .and(header("range", format!("bytes={first}-{last}").as_str()))
            .respond_with(ResponseTemplate::new(206).set_body_bytes(body))
            .expect(1)
            .mount(&server)
            .await;
    }
    let dir = tempfile::tempdir().unwrap();
    let job = DownloadJob {
        source: target(None),
        etag: None,
        size,
        target: dir.path().join("unter").join("mod paket.zip"),
        modified_ms: None,
        replace_existing: false,
        keep_remote_time: false,
    };
    let options = DownloadOptions {
        parts: PartSettings {
            part_size: 5 * MIB,
            multipart_threshold: 8 * MIB,
            ..PartSettings::default()
        },
        conflict: ConflictPolicy::Rename,
    };
    let progress = PartProgress::default();
    let outcome = download(
        &store(&server),
        &StdLocalFiles,
        &job,
        &options,
        &DownloadResume::default(),
        &progress,
        &CancelFlag::default(),
    )
    .await
    .unwrap();
    let DownloadOutcome::Saved(path) = outcome else {
        panic!("gespeichert erwartet")
    };
    assert_eq!(path, job.target);
    assert_eq!(std::fs::read(&path).unwrap(), content(0..size_usize));
    assert_eq!((progress.done_bytes(), progress.parts_done()), (size, 3));
    assert!(!dir.path().join("unter").join("mod paket.zip.s3part").exists());
}

#[tokio::test]
async fn rejects_full_responses_to_ranges_after_the_start() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(content(0..1000)))
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let part = FileRange {
        path: partial_file(&dir, 1000),
        offset: 500,
        length: 500,
    };
    let (result, _) = download_into(&server, &part).await;
    assert!(matches!(result, Err(StoreError::InvalidResponse(_))), "{result:?}");
}

#[tokio::test]
async fn reports_truncated_and_oversized_bodies() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(header("range", "bytes=0-99"))
        .respond_with(ResponseTemplate::new(206).set_body_bytes(content(0..60)))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(header("range", "bytes=0-9"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(content(0..20)))
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let path = partial_file(&dir, 100);
    let short = FileRange {
        path: path.clone(),
        offset: 0,
        length: 100,
    };
    let (result, transferred) = download_into(&server, &short).await;
    assert!(
        matches!(result, Err(StoreError::Network(ref m)) if m.contains("60 von 100")),
        "{result:?}"
    );
    assert_eq!(transferred, 60);
    let long = FileRange {
        path,
        offset: 0,
        length: 10,
    };
    let (result, _) = download_into(&server, &long).await;
    assert!(matches!(result, Err(StoreError::InvalidResponse(_))), "{result:?}");
}

#[tokio::test]
async fn reports_changed_objects_and_missing_partial_files() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(412).set_body_string(
            "<Error><Code>PreconditionFailed</Code><Message>At least one of the pre-conditions you specified did not hold</Message></Error>",
        ))
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let part = FileRange {
        path: partial_file(&dir, 10),
        offset: 0,
        length: 10,
    };
    let (result, _) = download_into(&server, &part).await;
    let Err(StoreError::Service(error)) = result else {
        panic!("Service-Fehler erwartet: {result:?}")
    };
    assert_eq!((error.code.as_str(), error.http_status), ("PreconditionFailed", 412));

    let ok = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(Vec::new()))
        .mount(&ok)
        .await;
    let missing = FileRange {
        path: dir.path().join("fehlt.s3part"),
        offset: 0,
        length: 0,
    };
    let (result, _) = download_into(&ok, &missing).await;
    assert!(matches!(result, Err(StoreError::LocalFile(_))), "{result:?}");
}

#[tokio::test]
async fn sends_no_range_for_empty_objects() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(OBJECT_PATH))
        .respond_with(ResponseTemplate::new(200))
        .expect(1)
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let part = FileRange {
        path: partial_file(&dir, 0),
        offset: 0,
        length: 0,
    };
    let (result, _) = download_into(&server, &part).await;
    result.unwrap();
    let requests = server.received_requests().await.unwrap();
    assert!(!requests[0].headers.contains_key("range"));
}

// ---------- Prüfsummen ----------

#[tokio::test]
async fn lets_crc32c_providers_verify_multipart_uploads() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(query_param("uploads", ""))
        .and(header("x-amz-checksum-algorithm", "CRC32C"))
        .respond_with(
            ResponseTemplate::new(200).set_body_string(
                "<InitiateMultipartUploadResult><UploadId>u-9</UploadId></InitiateMultipartUploadResult>",
            ),
        )
        .expect(1)
        .mount(&server)
        .await;
    // CRC32C("123456789") = 0xE3069283
    Mock::given(method("PUT"))
        .and(query_param("partNumber", "1"))
        .and(header("x-amz-checksum-crc32c", "4waSgw=="))
        .respond_with(ResponseTemplate::new(200).insert_header("ETag", "\"p1\""))
        .expect(1)
        .mount(&server)
        .await;
    let s = store_with(&server, Quirks::FULL);
    let upload_id = s
        .create_multipart_upload(&target(None), Checksums::Verify)
        .await
        .unwrap();
    let part = s
        .upload_part_bytes(
            &target(None),
            &upload_id,
            1,
            b"123456789".to_vec(),
            &ByteCounter::default(),
            Checksums::Verify,
        )
        .await
        .unwrap();
    assert_eq!(part.checksum_crc32c.as_deref(), Some("4waSgw=="));
}

#[tokio::test]
async fn sends_content_md5_where_crc32c_is_unknown() {
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let file = write_file(&dir, 0);
    // MD5 der leeren Datei
    Mock::given(method("PUT"))
        .and(path(OBJECT_PATH))
        .and(header("content-md5", "1B2M2Y8AsgTpgAmY7PhCfg=="))
        .respond_with(ResponseTemplate::new(200).insert_header("ETag", "\"leer\""))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(query_param("uploads", ""))
        .respond_with(
            ResponseTemplate::new(200).set_body_string(
                "<InitiateMultipartUploadResult><UploadId>u-1</UploadId></InitiateMultipartUploadResult>",
            ),
        )
        .expect(1)
        .mount(&server)
        .await;
    let s = store(&server);
    let source = FileRange {
        path: file,
        offset: 0,
        length: 0,
    };
    let etag = s
        .put_object(&target(None), &source, &ByteCounter::default(), Checksums::Verify)
        .await
        .unwrap();
    assert_eq!(etag, "\"leer\"");
    s.create_multipart_upload(&target(None), Checksums::Verify)
        .await
        .unwrap();
    let requests = server.received_requests().await.unwrap();
    let create = requests.iter().find(|r| r.method.as_str() == "POST").unwrap();
    assert!(!create.headers.contains_key("x-amz-checksum-algorithm"));
}

// ---------- Kopie zwischen Verbindungen: Teile über den Speicher ----------

#[tokio::test]
async fn reads_a_range_into_memory() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(OBJECT_PATH))
        .and(header("range", "bytes=100-399"))
        .and(header("if-match", "\"abc\""))
        .respond_with(ResponseTemplate::new(206).set_body_bytes(content(100..400)))
        .expect(1)
        .mount(&server)
        .await;
    let body = store(&server)
        .get_range(&target(None), Some("\"abc\""), (100, 300))
        .await
        .unwrap();
    assert_eq!(body, content(100..400));
}

#[tokio::test]
async fn rejects_short_ranges_and_full_answers_after_the_start() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(header("range", "bytes=0-9"))
        .respond_with(ResponseTemplate::new(206).set_body_bytes(content(0..4)))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(header("range", "bytes=10-19"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(content(0..30)))
        .mount(&server)
        .await;
    let s = store(&server);
    assert!(matches!(
        s.get_range(&target(None), None, (0, 10)).await,
        Err(StoreError::Network(_))
    ));
    assert!(matches!(
        s.get_range(&target(None), None, (10, 10)).await,
        Err(StoreError::InvalidResponse(_))
    ));
}

#[tokio::test]
async fn uploads_objects_and_parts_from_memory_unsigned_with_progress() {
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path(OBJECT_PATH))
        .and(query_param_is_missing("partNumber"))
        .and(header("x-amz-content-sha256", "UNSIGNED-PAYLOAD"))
        .and(header("content-type", "video/mp4"))
        .and(body_bytes(content(0..300)))
        .respond_with(ResponseTemplate::new(200).insert_header("ETag", "\"ganz\""))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path(OBJECT_PATH))
        .and(query_param("partNumber", "2"))
        .and(query_param("uploadId", "u-1"))
        .and(header("content-length", "500000"))
        .and(body_bytes(content(0..500_000)))
        .respond_with(ResponseTemplate::new(200).insert_header("ETag", "\"teil-2\""))
        .expect(1)
        .mount(&server)
        .await;
    let s = store(&server);
    let progress = ByteCounter::default();
    let etag = s
        .put_object_bytes(&target(Some("video/mp4")), content(0..300), &progress, Checksums::Off)
        .await
        .unwrap();
    assert_eq!(etag, "\"ganz\"");
    let part = s
        .upload_part_bytes(&target(None), "u-1", 2, content(0..500_000), &progress, Checksums::Off)
        .await
        .unwrap();
    assert_eq!(part, CompletedPart::new(2, "\"teil-2\"".into()));
    assert_eq!(progress.get(), 500_300);
}
