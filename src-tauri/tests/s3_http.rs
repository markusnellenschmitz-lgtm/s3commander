//! Integrationstests des HTTP-Adapters gegen einen S3-Mock (wiremock).
//! Prüfen das Draht-Format: Pfad, Query, Signatur-Header, Antworten und Fehler.
// Hilfsfunktionen der Tests nutzen unwrap auf feste Testdaten.
#![allow(clippy::unwrap_used)]

use s3_commander_lib::adapters::s3::client::{HttpObjectStore, HttpOptions, S3Config};
use s3_commander_lib::application::cancel::CancelFlag;
use s3_commander_lib::application::connection::test_connection;
use s3_commander_lib::application::listing::list_all;
use s3_commander_lib::domain::credentials::Credentials;
use s3_commander_lib::domain::details::{MetadataEntry, ObjectTag};
use s3_commander_lib::domain::endpoint::{Addressing, Endpoint};
use s3_commander_lib::domain::error::StoreError;
use s3_commander_lib::domain::object::ListRequest;
use s3_commander_lib::domain::provider::Quirks;
use s3_commander_lib::domain::transfer::ObjectRef;
use s3_commander_lib::ports::{Clock, ObjectStore};
use std::time::{Duration, Instant};
use time::OffsetDateTime;
use time::macros::datetime;
use wiremock::matchers::{header, header_exists, method, path, query_param, query_param_is_missing};
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

fn config(endpoint: &str, quirks: Quirks, timeout: Duration) -> S3Config {
    S3Config {
        endpoint: Endpoint::new(endpoint, "eu-central-1", Addressing::PathStyle).unwrap(),
        credentials: Credentials::new("HZK7Q2M4XW9PL3RT8VN1", "w8Kq2LmZr4Tn9Xb1Vc6Hy3Pd7Fs0Jg5Ae2Ru8Ni", None).unwrap(),
        quirks,
        http: HttpOptions {
            timeout,
            ..HttpOptions::default()
        },
    }
}

fn store(server: &MockServer, quirks: Quirks) -> HttpObjectStore<FixedClock> {
    HttpObjectStore::new(config(&server.uri(), quirks, Duration::from_secs(5)), FixedClock).unwrap()
}

const BUCKETS_XML: &str = "<ListAllMyBucketsResult><Buckets>\
    <Bucket><Name>gtg-mods</Name></Bucket><Bucket><Name>nextcloud-data</Name></Bucket><Bucket><Name>restic-repo</Name></Bucket>\
    </Buckets></ListAllMyBucketsResult>";

fn page_xml(keys: &[&str], token: Option<&str>) -> String {
    let contents: String = keys
        .iter()
        .flat_map(|k| {
            [
                "<Contents><Key>",
                k,
                "</Key><Size>10</Size><LastModified>2026-10-11T03:14:52.000Z</LastModified></Contents>",
            ]
        })
        .collect();
    let next = token
        .map(|t| format!("<NextContinuationToken>{t}</NextContinuationToken>"))
        .unwrap_or_default();
    format!(
        "<ListBucketResult><IsTruncated>{}</IsTruncated>{next}{contents}</ListBucketResult>",
        token.is_some()
    )
}

#[tokio::test]
async fn lists_buckets_with_signed_request() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/"))
        .and(header("x-amz-date", "20261011T152308Z"))
        .and(header(
            "x-amz-content-sha256",
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        ))
        .and(header_exists("authorization"))
        .respond_with(ResponseTemplate::new(200).set_body_string(BUCKETS_XML))
        .expect(1)
        .mount(&server)
        .await;

    let buckets = store(&server, Quirks::CONSERVATIVE).list_buckets().await.unwrap();
    assert_eq!(
        buckets.iter().map(|b| b.name.as_str()).collect::<Vec<_>>(),
        ["gtg-mods", "nextcloud-data", "restic-repo"]
    );

    let requests = server.received_requests().await.unwrap();
    let auth = requests[0].headers.get("authorization").unwrap().to_str().unwrap();
    assert!(auth.starts_with("AWS4-HMAC-SHA256 Credential=HZK7Q2M4XW9PL3RT8VN1/20261011/eu-central-1/s3/aws4_request"));
    assert!(auth.contains("SignedHeaders=host;x-amz-content-sha256;x-amz-date"));
}

#[tokio::test]
async fn lists_a_folder_with_path_style_and_query_parameters() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/prod-backups-eu/"))
        .and(query_param("list-type", "2"))
        .and(query_param("prefix", "backups/2026/10/"))
        .and(query_param("delimiter", "/"))
        .and(query_param_is_missing("encoding-type"))
        .respond_with(ResponseTemplate::new(200).set_body_string(page_xml(&["backups/2026/10/README.txt"], None)))
        .mount(&server)
        .await;

    let page = store(&server, Quirks::CONSERVATIVE)
        .list_objects(&ListRequest::folder("prod-backups-eu", "backups/2026/10/"))
        .await
        .unwrap();
    assert_eq!(page.objects[0].key, "backups/2026/10/README.txt");
    assert_eq!(page.next_token, None);
}

#[tokio::test]
async fn requests_url_encoding_and_max_keys_when_configured() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/b/"))
        .and(query_param("encoding-type", "url"))
        .and(query_param("max-keys", "1"))
        .and(query_param_is_missing("prefix"))
        .respond_with(ResponseTemplate::new(200).set_body_string(page_xml(&[], None)))
        .expect(1)
        .mount(&server)
        .await;

    let request = ListRequest {
        max_keys: Some(1),
        ..ListRequest::recursive("b", "")
    };
    store(&server, Quirks::FULL).list_objects(&request).await.unwrap();
}

#[tokio::test]
async fn follows_continuation_tokens_with_special_characters() {
    let server = MockServer::start().await;
    let token = "1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J+wm36Hy4vbOwM=";
    Mock::given(method("GET"))
        .and(path("/logs/"))
        .and(query_param("continuation-token", token))
        .respond_with(ResponseTemplate::new(200).set_body_string(page_xml(&["b"], None)))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/logs/"))
        .and(query_param_is_missing("continuation-token"))
        .respond_with(ResponseTemplate::new(200).set_body_string(page_xml(&["a"], Some(token))))
        .mount(&server)
        .await;

    let mut keys = Vec::new();
    let summary = list_all(
        &store(&server, Quirks::CONSERVATIVE),
        ListRequest::recursive("logs", ""),
        &CancelFlag::default(),
        |page| keys.extend(page.objects.into_iter().map(|o| o.key)),
    )
    .await
    .unwrap();
    assert_eq!(keys, ["a", "b"]);
    assert_eq!(summary.pages, 2);
}

#[tokio::test]
async fn maps_service_errors_with_request_id() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(403)
                .insert_header("x-amz-request-id", "7XQ2M9K4PZ1R8T3B")
                .set_body_string(
                    "<Error><Code>SignatureDoesNotMatch</Code><Message>Prüfe Secret Key und Region</Message></Error>",
                ),
        )
        .mount(&server)
        .await;

    let Err(StoreError::Service(error)) = store(&server, Quirks::CONSERVATIVE).list_buckets().await else {
        panic!("Service-Fehler erwartet");
    };
    assert_eq!(error.code, "SignatureDoesNotMatch");
    assert_eq!(error.http_status, 403);
    assert_eq!(error.request_id.as_deref(), Some("7XQ2M9K4PZ1R8T3B"));
}

#[tokio::test]
async fn reports_timeouts_and_unreachable_endpoints() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(3)))
        .mount(&server)
        .await;
    let slow = HttpObjectStore::new(
        config(&server.uri(), Quirks::CONSERVATIVE, Duration::from_millis(200)),
        FixedClock,
    );
    assert_eq!(slow.unwrap().list_buckets().await, Err(StoreError::Timeout));

    // Port 9 (discard) ist lokal praktisch nie geöffnet.
    let closed = config("http://127.0.0.1:9", Quirks::CONSERVATIVE, Duration::from_secs(5));
    let result = HttpObjectStore::new(closed, FixedClock).unwrap().list_buckets().await;
    assert!(matches!(result, Err(StoreError::Network(_))), "{result:?}");
}

#[tokio::test]
async fn tests_a_connection_end_to_end() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(200).set_body_string(BUCKETS_XML))
        .mount(&server)
        .await;
    let result = test_connection(&store(&server, Quirks::CONSERVATIVE), &FixedClock, None)
        .await
        .unwrap();
    assert_eq!(result.bucket_count, Some(3));
}

#[tokio::test]
async fn deletes_objects_with_content_md5_and_reports_refused_keys() {
    let server = MockServer::start().await;
    let body = "<Delete><Quiet>true</Quiet><Object><Key>a.txt</Key></Object>\
                <Object><Key>ordner/b &amp; c.bin</Key></Object></Delete>";
    Mock::given(method("POST"))
        .and(path("/gtg-mods/"))
        .and(query_param("delete", ""))
        .and(header("content-md5", "OiRkTzIRo/UJHch9S+PAIg=="))
        .and(header("content-type", "application/xml"))
        .and(wiremock::matchers::body_string(body))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            "<DeleteResult><Error><Key>a.txt</Key><Code>AccessDenied</Code><Message>Access Denied</Message></Error></DeleteResult>",
        ))
        .expect(1)
        .mount(&server)
        .await;
    let keys = ["a.txt".to_owned(), "ordner/b & c.bin".to_owned()];
    let failures = store(&server, Quirks::CONSERVATIVE)
        .delete_objects("gtg-mods", &keys)
        .await
        .unwrap();
    assert_eq!(failures.len(), 1);
    assert_eq!(
        (failures[0].key.as_str(), failures[0].code.as_str()),
        ("a.txt", "AccessDenied")
    );
}

#[tokio::test]
async fn reads_the_versioning_status_and_maps_errors() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/gtg-mods/"))
        .and(query_param("versioning", ""))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string("<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>"),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/gesperrt/"))
        .respond_with(
            ResponseTemplate::new(403)
                .set_body_string("<Error><Code>AccessDenied</Code><Message>nein</Message></Error>"),
        )
        .mount(&server)
        .await;
    let store = store(&server, Quirks::CONSERVATIVE);
    assert_eq!(store.is_versioned("gtg-mods").await, Ok(true));
    assert!(matches!(
        store.is_versioned("gesperrt").await,
        Err(StoreError::Service(_))
    ));
}

#[tokio::test]
async fn creates_placeholders_and_copies_on_the_server() {
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path("/gtg-mods/mods/neu/"))
        .and(header("content-length", "0"))
        .respond_with(ResponseTemplate::new(200))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path("/gtg-mods/mods/neu%20name.zip"))
        .and(query_param_is_missing("uploadId"))
        .and(header("x-amz-copy-source", "gtg-mods/mods/alt%20%C3%BC.zip"))
        .respond_with(
            ResponseTemplate::new(200).set_body_string("<CopyObjectResult><ETag>\"e\"</ETag></CopyObjectResult>"),
        )
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path("/gtg-mods/mods/neu%20name.zip"))
        .and(query_param("uploadId", "UP"))
        .and(query_param("partNumber", "2"))
        .and(header("x-amz-copy-source-range", "bytes=100-199"))
        .respond_with(
            ResponseTemplate::new(200).set_body_string("<CopyPartResult><ETag>\"p2\"</ETag></CopyPartResult>"),
        )
        .expect(1)
        .mount(&server)
        .await;
    let store = store(&server, Quirks::CONSERVATIVE);
    let object = |key: &str| ObjectRef {
        bucket: "gtg-mods".into(),
        key: key.into(),
        content_type: None,
    };
    store.put_empty("gtg-mods", "mods/neu/").await.unwrap();
    let (source, target) = (object("mods/alt ü.zip"), object("mods/neu name.zip"));
    store.copy_object(&source, &target).await.unwrap();
    let etag = store
        .upload_part_copy(&target, "UP", 2, &source, (100, 100))
        .await
        .unwrap();
    assert_eq!(etag, "\"p2\"");
}

// ---------- Objekt-Details ----------

fn obj(key: &str) -> ObjectRef {
    ObjectRef {
        bucket: "gtg-mods".into(),
        key: key.into(),
        content_type: Some("application/zip".into()),
    }
}

#[tokio::test]
async fn reads_heads_tags_and_acls() {
    let server = MockServer::start().await;
    Mock::given(method("HEAD"))
        .and(path("/gtg-mods/a.zip"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-length", "42")
                .insert_header("x-amz-meta-owner", "ops")
                .insert_header("etag", "\"e\""),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/gtg-mods/a.zip"))
        .and(query_param("tagging", ""))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string("<Tagging><TagSet><Tag><Key>env</Key><Value>prod</Value></Tag></TagSet></Tagging>"),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/gtg-mods/a.zip"))
        .and(query_param("acl", ""))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            "<AccessControlPolicy><Owner><DisplayName>ops</DisplayName></Owner><AccessControlList/></AccessControlPolicy>",
        ))
        .mount(&server)
        .await;
    let store = store(&server, Quirks::CONSERVATIVE);
    let head = store.head_object("gtg-mods", "a.zip").await.unwrap();
    assert_eq!((head.size, head.etag.as_deref()), (42, Some("\"e\"")));
    assert_eq!(head.metadata[0].name, "x-amz-meta-owner");
    let tags = store.get_object_tagging("gtg-mods", "a.zip").await.unwrap();
    assert_eq!(tags[0].key, "env");
    let acl = store.get_object_acl("gtg-mods", "a.zip").await.unwrap();
    assert_eq!(acl.owner.as_deref(), Some("ops"));
}

#[tokio::test]
async fn writes_tags_and_replaces_metadata_with_the_right_headers() {
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path("/gtg-mods/a.zip"))
        .and(query_param("tagging", ""))
        .and(header_exists("content-md5"))
        .and(wiremock::matchers::body_string_contains(
            "<Key>env</Key><Value>prod</Value>",
        ))
        .respond_with(ResponseTemplate::new(200))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path("/gtg-mods/a.zip"))
        .and(query_param_is_missing("tagging"))
        .and(header("x-amz-copy-source", "gtg-mods/a.zip"))
        .and(header("x-amz-metadata-directive", "REPLACE"))
        .and(header("content-type", "application/zip"))
        .and(header("x-amz-meta-retention", "90d"))
        .and(header("x-amz-storage-class", "STANDARD_IA"))
        .respond_with(ResponseTemplate::new(200).set_body_string("<CopyObjectResult/>"))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/gtg-mods/a.zip"))
        .and(query_param("uploads", ""))
        .and(header("cache-control", "no-store"))
        .respond_with(
            ResponseTemplate::new(200).set_body_string(
                "<InitiateMultipartUploadResult><UploadId>U1</UploadId></InitiateMultipartUploadResult>",
            ),
        )
        .expect(1)
        .mount(&server)
        .await;
    let store = store(&server, Quirks::CONSERVATIVE);
    let tag = ObjectTag {
        key: "env".into(),
        value: "prod".into(),
    };
    store.put_object_tagging("gtg-mods", "a.zip", &[tag]).await.unwrap();
    let retention = MetadataEntry {
        name: "x-amz-meta-retention".into(),
        value: "90d".into(),
    };
    store
        .replace_metadata(&obj("a.zip"), &[retention], Some("STANDARD_IA"))
        .await
        .unwrap();
    let cache = MetadataEntry {
        name: "cache-control".into(),
        value: "no-store".into(),
    };
    let upload = store
        .create_multipart_upload_with_metadata(&obj("a.zip"), &[cache], None)
        .await
        .unwrap();
    assert_eq!(upload, "U1");
}

fn versions_xml(entries: &str, next: Option<(&str, &str)>) -> String {
    let markers = next.map_or_else(
        || "<IsTruncated>false</IsTruncated>".to_owned(),
        |(k, v)| format!("<IsTruncated>true</IsTruncated><NextKeyMarker>{k}</NextKeyMarker><NextVersionIdMarker>{v}</NextVersionIdMarker>"),
    );
    format!("<ListVersionsResult>{markers}{entries}</ListVersionsResult>")
}

#[tokio::test]
async fn lists_versions_of_exactly_one_key_across_pages() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/gtg-mods/"))
        .and(query_param("versions", ""))
        .and(query_param("prefix", "a.zip"))
        .and(query_param_is_missing("key-marker"))
        .respond_with(ResponseTemplate::new(200).set_body_string(versions_xml(
            "<Version><Key>a.zip</Key><VersionId>v3</VersionId><IsLatest>true</IsLatest><Size>3</Size></Version>",
            Some(("a.zip", "v3")),
        )))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/gtg-mods/"))
        .and(query_param("key-marker", "a.zip"))
        .and(query_param("version-id-marker", "v3"))
        .respond_with(ResponseTemplate::new(200).set_body_string(versions_xml(
            "<DeleteMarker><Key>a.zip</Key><VersionId>v2</VersionId><IsLatest>false</IsLatest></DeleteMarker>\
             <Version><Key>a.zip.bak</Key><VersionId>x</VersionId><IsLatest>true</IsLatest><Size>1</Size></Version>",
            Some(("a.zip.bak", "x")),
        )))
        .expect(1)
        .mount(&server)
        .await;
    let versions = store(&server, Quirks::CONSERVATIVE)
        .list_object_versions("gtg-mods", "a.zip")
        .await
        .unwrap();
    let ids: Vec<_> = versions
        .iter()
        .map(|v| (v.version_id.as_str(), v.is_delete_marker))
        .collect();
    assert_eq!(ids, [("v3", false), ("v2", true)]);
}

#[tokio::test]
async fn restores_and_deletes_versions_and_presigns_links() {
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path("/gtg-mods/a.zip"))
        .and(header("x-amz-copy-source", "gtg-mods/a.zip?versionId=p7%2BK"))
        .respond_with(ResponseTemplate::new(200).set_body_string("<CopyObjectResult/>"))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/gtg-mods/a.zip"))
        .and(query_param("versionId", "v2"))
        .respond_with(ResponseTemplate::new(204))
        .expect(1)
        .mount(&server)
        .await;
    let store = store(&server, Quirks::CONSERVATIVE);
    store.copy_version(&obj("a.zip"), "p7+K", &obj("a.zip")).await.unwrap();
    store.delete_version("gtg-mods", "a.zip", "v2").await.unwrap();
    let link = store.presign_get("gtg-mods", "ordner/a b.zip", 3600).unwrap();
    assert!(
        link.starts_with(&format!("{}/gtg-mods/ordner/a%20b.zip?", server.uri())),
        "{link}"
    );
    for part in [
        "X-Amz-Algorithm=AWS4-HMAC-SHA256",
        "X-Amz-Expires=3600",
        "X-Amz-SignedHeaders=host",
        "X-Amz-Signature=",
    ] {
        assert!(link.contains(part), "{part} fehlt in {link}");
    }
}
