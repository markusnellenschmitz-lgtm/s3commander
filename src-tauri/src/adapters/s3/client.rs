//! Object Store über die S3-REST-API (HTTP + `SigV4`), ohne AWS-SDK.

use super::headers::object_head;
use super::sigv4::presign_url;
use super::sigv4::{EMPTY_PAYLOAD_SHA256, SigningScope, UNSIGNED_PAYLOAD, payload_sha256, sign_headers};
use super::xml::{VersionsPage, build_tagging, parse_acl, parse_tagging, parse_versions};
use super::xml::{
    build_complete_multipart, build_delete_objects, parse_complete_multipart, parse_copy_object, parse_copy_part,
    parse_delete_result, parse_error, parse_initiate_multipart, parse_list_buckets, parse_list_objects,
    parse_list_parts, parse_versioning,
};
use crate::adapters::checksum::{CHECKSUM_ALGORITHM_HEADER, Digest, DigestKind, digest_bytes, digest_file};
use crate::domain::credentials::Credentials;
use crate::domain::deletion::DeleteFailure;
use crate::domain::details::{MetadataEntry, ObjectAcl, ObjectHead, ObjectTag, ObjectVersion};
use crate::domain::endpoint::Endpoint;
use crate::domain::error::StoreError;
use crate::domain::object::{BucketInfo, ListPage, ListRequest};
use crate::domain::provider::Quirks;
use crate::domain::transfer::{ByteCounter, Checksums, CompletedPart, FileRange, ObjectRef, UploadedPart};
use crate::domain::uri::{canonical_query, encode_path, encode_strict};
use crate::ports::{Clock, ObjectStore};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use futures_util::StreamExt;
use md5::{Digest as _, Md5};
use reqwest::header::HeaderMap;
use reqwest::{Method, StatusCode};
use std::io::SeekFrom;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::io::ReaderStream;
use url::Url;

const SERVICE: &str = "s3";
const USER_AGENT: &str = concat!("s3-commander/", env!("CARGO_PKG_VERSION"));
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);

/// Alles, was eine Verbindung braucht.
#[derive(Debug, Clone)]
pub struct S3Config {
    pub endpoint: Endpoint,
    pub credentials: Credentials,
    pub quirks: Quirks,
    pub http: HttpOptions,
}

/// Transport-Einstellungen aus "Erweitert" im Verbindungsdialog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpOptions {
    /// Höchstens so lange auf Verbindung oder neue Daten warten. Bewusst keine Grenze für die
    /// ganze Anfrage, damit große Teile auch über langsame Leitungen durchlaufen.
    pub timeout: Duration,
    /// `false` nur für Testumgebungen mit selbst signierten Zertifikaten.
    pub verify_tls: bool,
    pub proxy: Option<String>,
    /// Zusätzliche Stammzertifizierungsstelle (PEM) neben dem Windows-Zertifikatspeicher.
    pub ca_certificate_pem: Option<Vec<u8>>,
}

impl Default for HttpOptions {
    fn default() -> Self {
        Self {
            timeout: DEFAULT_TIMEOUT,
            verify_tls: true,
            proxy: None,
            ca_certificate_pem: None,
        }
    }
}

impl HttpOptions {
    fn build_client(&self) -> Result<reqwest::Client, StoreError> {
        let invalid = |what: &str, e: &reqwest::Error| StoreError::InvalidConfig(format!("{what}: {e}"));
        let mut builder = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(self.timeout)
            .read_timeout(self.timeout)
            .danger_accept_invalid_certs(!self.verify_tls);
        if let Some(proxy) = &self.proxy {
            builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|e| invalid("Proxy", &e))?);
        }
        if let Some(pem) = &self.ca_certificate_pem {
            builder =
                builder.add_root_certificate(reqwest::Certificate::from_pem(pem).map_err(|e| invalid("CA-Datei", &e))?);
        }
        builder.build().map_err(|e| invalid("HTTP-Client", &e))
    }
}

#[derive(Debug)]
pub struct HttpObjectStore<C: Clock> {
    http: reqwest::Client,
    config: S3Config,
    clock: C,
}

impl<C: Clock> HttpObjectStore<C> {
    /// # Errors
    ///
    /// `InvalidConfig` bei ungültigem Proxy, ungültiger CA oder wenn der HTTP-Client nicht
    /// erstellt werden kann.
    pub fn new(config: S3Config, clock: C) -> Result<Self, StoreError> {
        let http = config.http.build_client()?;
        Ok(Self { http, config, clock })
    }

    /// Signierter GET ohne Körper; liefert den Antworttext bei Erfolg.
    async fn get(&self, url: Url) -> Result<String, StoreError> {
        Ok(self.send(Method::GET, url, Payload::Empty, Vec::new()).await?.body)
    }

    /// Sendet eine signierte Anfrage und liest den Antworttext. `headers` werden mitsigniert.
    async fn send(
        &self,
        method: Method,
        url: Url,
        payload: Payload,
        headers: Vec<(String, String)>,
    ) -> Result<Reply, StoreError> {
        let response = self.execute(method, url, payload, headers).await?;
        let headers = response.headers().clone();
        let body = response.text().await.map_err(|e| map_transport_error(&e))?;
        Ok(Reply { headers, body })
    }

    /// Sendet eine signierte Anfrage und liefert die erfolgreiche Antwort mit ungelesenem Körper.
    /// Fehlerantworten werden zu `StoreError::Service`.
    async fn execute(
        &self,
        method: Method,
        url: Url,
        payload: Payload,
        mut headers: Vec<(String, String)>,
    ) -> Result<reqwest::Response, StoreError> {
        let payload_hash = payload.sha256();
        headers.push(("x-amz-content-sha256".to_owned(), payload_hash.clone()));
        let scope = SigningScope {
            credentials: &self.config.credentials,
            region: self.config.endpoint.region(),
            service: SERVICE,
            time: self.clock.utc_now(),
        };
        let signed = sign_headers(method.as_str(), &url, &headers, &payload_hash, &scope);
        let mut request = self.http.request(method, url);
        for (name, value) in headers.iter().chain(signed.iter()) {
            request = request.header(name, value);
        }
        request = payload.attach(request).await?;
        let response = request.send().await.map_err(|e| map_transport_error(&e))?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let request_id = header_value(response.headers(), "x-amz-request-id");
        let body = response.text().await.map_err(|e| map_transport_error(&e))?;
        Err(StoreError::Service(parse_error(status.as_u16(), &body, request_id)))
    }

    /// Welche Prüfsumme der Dienst prüfen soll: CRC32C, wo der Anbieter es kann, sonst MD5.
    fn digest_kind(&self, checksums: Checksums) -> Option<DigestKind> {
        match checksums {
            Checksums::Off => None,
            Checksums::Verify if self.config.quirks.crc32c_checksums => Some(DigestKind::Crc32c),
            Checksums::Verify => Some(DigestKind::Md5),
        }
    }

    async fn digest(&self, payload: &Payload, checksums: Checksums) -> Result<Option<Digest>, StoreError> {
        let Some(kind) = self.digest_kind(checksums) else {
            return Ok(None);
        };
        match payload {
            Payload::File { source, .. } => Ok(Some(digest_file(kind, source).await?)),
            Payload::Memory { body, .. } => Ok(Some(digest_bytes(kind, body))),
            Payload::Empty | Payload::Bytes(_) => Ok(None),
        }
    }

    /// PUT eines Objekts oder Teils, auf Wunsch mit Prüfsumme; liefert `ETag` und CRC32C.
    async fn put_body(
        &self,
        url: Url,
        payload: Payload,
        mut headers: Vec<(String, String)>,
        checksums: Checksums,
    ) -> Result<(String, Option<String>), StoreError> {
        let digest = self.digest(&payload, checksums).await?;
        if let Some(digest) = &digest {
            headers.push(digest.header());
        }
        let etag = self.send(Method::PUT, url, payload, headers).await?.etag()?;
        Ok((etag, digest.and_then(|d| d.crc32c())))
    }

    async fn put_part(
        &self,
        target: &ObjectRef,
        upload_id: &str,
        part_number: u32,
        payload: Payload,
        checksums: Checksums,
    ) -> Result<CompletedPart, StoreError> {
        let url = self.part_url(target, upload_id, part_number);
        let (etag, checksum_crc32c) = self.put_body(url, payload, Vec::new(), checksums).await?;
        Ok(CompletedPart {
            part_number,
            etag,
            checksum_crc32c,
        })
    }

    /// GET eines Byte-Bereichs; ohne 206 kommt das ganze Objekt, das passt nur ab Byte 0.
    async fn get_range_response(
        &self,
        object: &ObjectRef,
        if_match: Option<&str>,
        (offset, length): (u64, u64),
    ) -> Result<reqwest::Response, StoreError> {
        let url = self.object_url_with(object, &[]);
        let mut headers = Vec::new();
        if length > 0 {
            let last = offset + length - 1;
            headers.push(("range".to_owned(), format!("bytes={offset}-{last}")));
        }
        if let Some(etag) = if_match {
            headers.push(("if-match".to_owned(), etag.to_owned()));
        }
        let response = self.execute(Method::GET, url, Payload::Empty, headers).await?;
        if response.status() != StatusCode::PARTIAL_CONTENT && offset > 0 {
            return Err(StoreError::InvalidResponse(
                "Der Endpunkt unterstützt keine Range-Anfragen".into(),
            ));
        }
        Ok(response)
    }

    fn part_url(&self, target: &ObjectRef, upload_id: &str, part_number: u32) -> Url {
        let query = [
            ("partNumber", part_number.to_string()),
            ("uploadId", upload_id.to_owned()),
        ];
        self.object_url_with(target, &query)
    }

    fn object_url_with(&self, target: &ObjectRef, query: &[(&str, String)]) -> Url {
        let mut url = self.config.endpoint.object_url(&target.bucket, &target.key);
        if !query.is_empty() {
            url.set_query(Some(&canonical_query(query)));
        }
        url
    }

    fn bucket_url_with(&self, bucket: &str, query: &[(&str, String)]) -> Url {
        let mut url = self.config.endpoint.bucket_url(bucket);
        url.set_query(Some(&canonical_query(query)));
        url
    }

    fn list_objects_url(&self, request: &ListRequest) -> Url {
        let mut pairs: Vec<(&str, String)> = vec![("list-type", "2".into())];
        if !request.prefix.is_empty() {
            pairs.push(("prefix", request.prefix.clone()));
        }
        if let Some(delimiter) = &request.delimiter {
            pairs.push(("delimiter", delimiter.clone()));
        }
        if let Some(token) = &request.continuation_token {
            pairs.push(("continuation-token", token.clone()));
        }
        if let Some(max) = request.max_keys {
            pairs.push(("max-keys", max.to_string()));
        }
        if self.config.quirks.url_encoded_listing {
            pairs.push(("encoding-type", "url".into()));
        }
        self.bucket_url_with(&request.bucket, &pairs)
    }
}

impl<C: Clock> ObjectStore for HttpObjectStore<C> {
    async fn list_buckets(&self) -> Result<Vec<BucketInfo>, StoreError> {
        parse_list_buckets(&self.get(self.config.endpoint.service_url()).await?)
    }

    async fn list_objects(&self, request: &ListRequest) -> Result<ListPage, StoreError> {
        parse_list_objects(&self.get(self.list_objects_url(request)).await?)
    }

    async fn put_object(
        &self,
        target: &ObjectRef,
        source: &FileRange,
        progress: &ByteCounter,
        checksums: Checksums,
    ) -> Result<String, StoreError> {
        let payload = Payload::File {
            source: source.clone(),
            progress: progress.clone(),
        };
        let url = self.object_url_with(target, &[]);
        let (etag, _) = self
            .put_body(url, payload, content_type_header(target), checksums)
            .await?;
        Ok(etag)
    }

    async fn create_multipart_upload(&self, target: &ObjectRef, checksums: Checksums) -> Result<String, StoreError> {
        let url = self.object_url_with(target, &[("uploads", String::new())]);
        let mut headers = content_type_header(target);
        if self.digest_kind(checksums) == Some(DigestKind::Crc32c) {
            let (name, value) = CHECKSUM_ALGORITHM_HEADER;
            headers.push((name.to_owned(), value.to_owned()));
        }
        let reply = self.send(Method::POST, url, Payload::Empty, headers).await?;
        parse_initiate_multipart(&reply.body)
    }

    async fn upload_part(
        &self,
        target: &ObjectRef,
        upload_id: &str,
        part_number: u32,
        source: &FileRange,
        progress: &ByteCounter,
        checksums: Checksums,
    ) -> Result<CompletedPart, StoreError> {
        let payload = Payload::File {
            source: source.clone(),
            progress: progress.clone(),
        };
        self.put_part(target, upload_id, part_number, payload, checksums).await
    }

    async fn complete_multipart_upload(
        &self,
        target: &ObjectRef,
        upload_id: &str,
        parts: &[CompletedPart],
    ) -> Result<String, StoreError> {
        let url = self.object_url_with(target, &[("uploadId", upload_id.to_owned())]);
        let body = build_complete_multipart(parts).into_bytes();
        let headers = vec![("content-type".to_owned(), "application/xml".to_owned())];
        let reply = self.send(Method::POST, url, Payload::Bytes(body), headers).await?;
        parse_complete_multipart(&reply.body)
    }

    async fn abort_multipart_upload(&self, target: &ObjectRef, upload_id: &str) -> Result<(), StoreError> {
        let url = self.object_url_with(target, &[("uploadId", upload_id.to_owned())]);
        self.send(Method::DELETE, url, Payload::Empty, Vec::new()).await?;
        Ok(())
    }

    async fn list_parts(&self, target: &ObjectRef, upload_id: &str) -> Result<Vec<UploadedPart>, StoreError> {
        let mut parts = Vec::new();
        let mut marker: Option<String> = None;
        loop {
            let mut query = vec![("uploadId", upload_id.to_owned())];
            if let Some(m) = &marker {
                query.push(("part-number-marker", m.clone()));
            }
            let page = parse_list_parts(&self.get(self.object_url_with(target, &query)).await?)?;
            parts.extend(page.parts);
            match page.next_marker {
                Some(next) if marker.as_deref() != Some(next.as_str()) => marker = Some(next),
                _ => return Ok(parts),
            }
        }
    }

    async fn head_object(&self, bucket: &str, key: &str) -> Result<ObjectHead, StoreError> {
        let url = self.config.endpoint.object_url(bucket, key);
        let reply = self.send(Method::HEAD, url, Payload::Empty, Vec::new()).await?;
        Ok(object_head(&reply.headers))
    }

    async fn get_object_tagging(&self, bucket: &str, key: &str) -> Result<Vec<ObjectTag>, StoreError> {
        parse_tagging(
            &self
                .get(self.object_url_with(&object(bucket, key), &[("tagging", String::new())]))
                .await?,
        )
    }

    async fn put_object_tagging(&self, bucket: &str, key: &str, tags: &[ObjectTag]) -> Result<(), StoreError> {
        let url = self.object_url_with(&object(bucket, key), &[("tagging", String::new())]);
        let body = build_tagging(tags).into_bytes();
        let headers = xml_body_headers(&body);
        self.send(Method::PUT, url, Payload::Bytes(body), headers).await?;
        Ok(())
    }

    async fn list_object_versions(&self, bucket: &str, key: &str) -> Result<Vec<ObjectVersion>, StoreError> {
        let mut versions = Vec::new();
        let mut markers: Option<(String, String)> = None;
        loop {
            let mut query = vec![("versions", String::new()), ("prefix", key.to_owned())];
            if let Some((key_marker, version_marker)) = &markers {
                query.push(("key-marker", key_marker.clone()));
                query.push(("version-id-marker", version_marker.clone()));
            }
            let page = parse_versions(&self.get(self.bucket_url_with(bucket, &query)).await?)?;
            // Keys kommen sortiert; ein längerer Key mit demselben Anfang beendet die Suche.
            let past_key = page.entries.iter().any(|(entry_key, _)| entry_key.as_str() > key);
            let VersionsPage {
                entries,
                next_key_marker,
                next_version_marker,
            } = page;
            versions.extend(entries.into_iter().filter(|(k, _)| k == key).map(|(_, v)| v));
            match (next_key_marker, next_version_marker) {
                (Some(k), Some(v)) if !past_key && markers.as_ref() != Some(&(k.clone(), v.clone())) => {
                    markers = Some((k, v));
                }
                _ => return Ok(versions),
            }
        }
    }

    async fn copy_version(&self, source: &ObjectRef, version_id: &str, target: &ObjectRef) -> Result<(), StoreError> {
        let (name, value) = copy_source(source);
        let header = (name, format!("{value}?versionId={}", encode_strict(version_id)));
        let url = self.object_url_with(target, &[]);
        let reply = self.send(Method::PUT, url, Payload::Empty, vec![header]).await?;
        parse_copy_object(&reply.body)
    }

    async fn delete_version(&self, bucket: &str, key: &str, version_id: &str) -> Result<(), StoreError> {
        let url = self.object_url_with(&object(bucket, key), &[("versionId", version_id.to_owned())]);
        self.send(Method::DELETE, url, Payload::Empty, Vec::new()).await?;
        Ok(())
    }

    async fn replace_metadata(
        &self,
        object: &ObjectRef,
        metadata: &[MetadataEntry],
        storage_class: Option<&str>,
    ) -> Result<(), StoreError> {
        let mut headers = vec![
            copy_source(object),
            ("x-amz-metadata-directive".to_owned(), "REPLACE".to_owned()),
        ];
        headers.extend(write_headers(object, metadata, storage_class));
        let url = self.object_url_with(object, &[]);
        let reply = self.send(Method::PUT, url, Payload::Empty, headers).await?;
        parse_copy_object(&reply.body)
    }

    async fn create_multipart_upload_with_metadata(
        &self,
        target: &ObjectRef,
        metadata: &[MetadataEntry],
        storage_class: Option<&str>,
    ) -> Result<String, StoreError> {
        let url = self.object_url_with(target, &[("uploads", String::new())]);
        let headers = write_headers(target, metadata, storage_class);
        let reply = self.send(Method::POST, url, Payload::Empty, headers).await?;
        parse_initiate_multipart(&reply.body)
    }

    async fn get_object_acl(&self, bucket: &str, key: &str) -> Result<ObjectAcl, StoreError> {
        parse_acl(
            &self
                .get(self.object_url_with(&object(bucket, key), &[("acl", String::new())]))
                .await?,
        )
    }

    fn presign_get(&self, bucket: &str, key: &str, expires_secs: u32) -> Result<String, StoreError> {
        let scope = SigningScope {
            credentials: &self.config.credentials,
            region: self.config.endpoint.region(),
            service: SERVICE,
            time: self.clock.utc_now(),
        };
        let url = self.config.endpoint.object_url(bucket, key);
        Ok(presign_url("GET", &url, expires_secs, &scope).to_string())
    }

    async fn put_empty(&self, bucket: &str, key: &str) -> Result<(), StoreError> {
        let url = self.config.endpoint.object_url(bucket, key);
        self.send(Method::PUT, url, Payload::Bytes(Vec::new()), Vec::new())
            .await?;
        Ok(())
    }

    async fn copy_object(&self, source: &ObjectRef, target: &ObjectRef) -> Result<(), StoreError> {
        let url = self.object_url_with(target, &[]);
        let reply = self
            .send(Method::PUT, url, Payload::Empty, vec![copy_source(source)])
            .await?;
        parse_copy_object(&reply.body)
    }

    async fn upload_part_copy(
        &self,
        target: &ObjectRef,
        upload_id: &str,
        part_number: u32,
        source: &ObjectRef,
        (offset, length): (u64, u64),
    ) -> Result<String, StoreError> {
        let query = [
            ("partNumber", part_number.to_string()),
            ("uploadId", upload_id.to_owned()),
        ];
        let url = self.object_url_with(target, &query);
        let last = offset + length.saturating_sub(1);
        let headers = vec![
            copy_source(source),
            ("x-amz-copy-source-range".to_owned(), format!("bytes={offset}-{last}")),
        ];
        let reply = self.send(Method::PUT, url, Payload::Empty, headers).await?;
        parse_copy_part(&reply.body)
    }

    async fn delete_objects(&self, bucket: &str, keys: &[String]) -> Result<Vec<DeleteFailure>, StoreError> {
        let url = self.bucket_url_with(bucket, &[("delete", String::new())]);
        let body = build_delete_objects(keys).into_bytes();
        let headers = xml_body_headers(&body);
        let reply = self.send(Method::POST, url, Payload::Bytes(body), headers).await?;
        parse_delete_result(&reply.body)
    }

    async fn is_versioned(&self, bucket: &str) -> Result<bool, StoreError> {
        let url = self.bucket_url_with(bucket, &[("versioning", String::new())]);
        parse_versioning(&self.get(url).await?)
    }

    async fn get_range(
        &self,
        object: &ObjectRef,
        if_match: Option<&str>,
        range: (u64, u64),
    ) -> Result<Vec<u8>, StoreError> {
        let response = self.get_range_response(object, if_match, range).await?;
        let body = response.bytes().await.map_err(|e| map_transport_error(&e))?;
        if u64::try_from(body.len()).unwrap_or(u64::MAX) != range.1 {
            return Err(StoreError::Network(format!(
                "{} von {} Bytes empfangen",
                body.len(),
                range.1
            )));
        }
        Ok(body.to_vec())
    }

    async fn put_object_bytes(
        &self,
        target: &ObjectRef,
        body: Vec<u8>,
        progress: &ByteCounter,
        checksums: Checksums,
    ) -> Result<String, StoreError> {
        let payload = Payload::Memory {
            body,
            progress: progress.clone(),
        };
        let url = self.object_url_with(target, &[]);
        let (etag, _) = self
            .put_body(url, payload, content_type_header(target), checksums)
            .await?;
        Ok(etag)
    }

    async fn upload_part_bytes(
        &self,
        target: &ObjectRef,
        upload_id: &str,
        part_number: u32,
        body: Vec<u8>,
        progress: &ByteCounter,
        checksums: Checksums,
    ) -> Result<CompletedPart, StoreError> {
        let payload = Payload::Memory {
            body,
            progress: progress.clone(),
        };
        self.put_part(target, upload_id, part_number, payload, checksums).await
    }

    async fn download_range(
        &self,
        object: &ObjectRef,
        if_match: Option<&str>,
        part: &FileRange,
        progress: &ByteCounter,
    ) -> Result<(), StoreError> {
        let response = self
            .get_range_response(object, if_match, (part.offset, part.length))
            .await?;
        write_body(response, part, progress).await
    }
}

/// Körper einer Anfrage. Dateien werden gestreamt und nicht signiert (`UNSIGNED-PAYLOAD`),
/// damit große Teile nicht zweimal gelesen und nie ganz in den Speicher geladen werden.
/// Teile aus dem Speicher (Kopie zwischen Verbindungen) laufen genauso, mit Fortschritt.
enum Payload {
    Empty,
    Bytes(Vec<u8>),
    File { source: FileRange, progress: ByteCounter },
    Memory { body: Vec<u8>, progress: ByteCounter },
}

/// Lesepuffer beim Streamen aus Dateien.
const STREAM_CHUNK: usize = 256 * 1024;

impl Payload {
    fn sha256(&self) -> String {
        match self {
            Self::Empty => EMPTY_PAYLOAD_SHA256.to_owned(),
            Self::Bytes(bytes) => payload_sha256(bytes),
            Self::File { .. } | Self::Memory { .. } => UNSIGNED_PAYLOAD.to_owned(),
        }
    }

    async fn attach(self, request: reqwest::RequestBuilder) -> Result<reqwest::RequestBuilder, StoreError> {
        Ok(match self {
            Self::Empty => request,
            // Auch leere Körper brauchen die Länge, sonst lehnt S3 PUT mit 411 ab.
            Self::Bytes(bytes) => request.header(reqwest::header::CONTENT_LENGTH, bytes.len()).body(bytes),
            Self::File { source, progress } => {
                // S3 verlangt eine Länge; ohne sie würde reqwest chunked senden.
                let length = source.length;
                request
                    .header(reqwest::header::CONTENT_LENGTH, length)
                    .body(file_body(&source, progress).await?)
            }
            Self::Memory { body, progress } => request
                .header(reqwest::header::CONTENT_LENGTH, body.len())
                .body(memory_body(&body, progress)),
        })
    }
}

/// Speicherpuffer in Stücken senden, damit Fortschritt und Bandbreitenlimit wie bei Dateien wirken.
fn memory_body(body: &[u8], progress: ByteCounter) -> reqwest::Body {
    let chunks: Vec<Result<Vec<u8>, std::io::Error>> = body.chunks(STREAM_CHUNK).map(|c| Ok(c.to_vec())).collect();
    let stream = futures_util::stream::iter(chunks).then(move |chunk| {
        let progress = progress.clone();
        async move {
            if let Ok(bytes) = &chunk {
                let length = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
                wait_for_bandwidth(&progress, length).await;
                progress.add(length);
            }
            chunk
        }
    });
    reqwest::Body::wrap_stream(stream)
}

async fn file_body(source: &FileRange, progress: ByteCounter) -> Result<reqwest::Body, StoreError> {
    let local_error = |e: std::io::Error| StoreError::LocalFile(format!("{}: {e}", source.path.display()));
    let mut file = tokio::fs::File::open(&source.path).await.map_err(local_error)?;
    file.seek(SeekFrom::Start(source.offset)).await.map_err(local_error)?;
    let stream = ReaderStream::with_capacity(file.take(source.length), STREAM_CHUNK).then(move |chunk| {
        let progress = progress.clone();
        async move {
            if let Ok(bytes) = &chunk {
                let length = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
                wait_for_bandwidth(&progress, length).await;
                progress.add(length);
            }
            chunk
        }
    });
    Ok(reqwest::Body::wrap_stream(stream))
}

/// Hält das Bandbreitenlimit ein, bevor `length` Bytes übertragen werden.
async fn wait_for_bandwidth(progress: &ByteCounter, length: u64) {
    let wait = progress.throttle(length, std::time::Instant::now());
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
}

/// Schreibt den Antwortkörper an die Stelle `part.offset` der lokalen Datei.
async fn write_body(response: reqwest::Response, part: &FileRange, progress: &ByteCounter) -> Result<(), StoreError> {
    let local_error = |e: std::io::Error| StoreError::LocalFile(format!("{}: {e}", part.path.display()));
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .open(&part.path)
        .await
        .map_err(local_error)?;
    file.seek(SeekFrom::Start(part.offset)).await.map_err(local_error)?;
    let mut written: u64 = 0;
    let mut body = response.bytes_stream();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|e| map_transport_error(&e))?;
        let length = u64::try_from(chunk.len()).unwrap_or(u64::MAX);
        if written.saturating_add(length) > part.length {
            return Err(StoreError::InvalidResponse(
                "Die Antwort ist länger als der angeforderte Bereich".into(),
            ));
        }
        wait_for_bandwidth(progress, length).await;
        file.write_all(&chunk).await.map_err(local_error)?;
        written += length;
        progress.add(length);
    }
    file.flush().await.map_err(local_error)?;
    if written < part.length {
        return Err(StoreError::Network(format!(
            "Verbindung nach {written} von {} Bytes getrennt",
            part.length
        )));
    }
    Ok(())
}

struct Reply {
    headers: HeaderMap,
    body: String,
}

impl Reply {
    fn etag(&self) -> Result<String, StoreError> {
        header_value(&self.headers, "etag")
            .ok_or_else(|| StoreError::InvalidResponse("ETag fehlt in der Antwort".into()))
    }
}

fn header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_owned)
}

/// Header für XML-Körper. AWS und `MinIO` verlangen bei `DeleteObjects` und Tagging eine Prüfsumme.
fn xml_body_headers(body: &[u8]) -> Vec<(String, String)> {
    vec![
        ("content-type".to_owned(), "application/xml".to_owned()),
        ("content-md5".to_owned(), BASE64.encode(Md5::digest(body))),
    ]
}

/// Header beim Schreiben eines Objekts mit Metadaten: Content-Type, Metadaten, Storage Class.
fn write_headers(object: &ObjectRef, metadata: &[MetadataEntry], storage_class: Option<&str>) -> Vec<(String, String)> {
    let mut headers = content_type_header(object);
    headers.extend(metadata.iter().map(|m| (m.name.clone(), m.value.clone())));
    headers.extend(storage_class.map(|class| ("x-amz-storage-class".to_owned(), class.to_owned())));
    headers
}

fn object(bucket: &str, key: &str) -> ObjectRef {
    ObjectRef {
        bucket: bucket.to_owned(),
        key: key.to_owned(),
        content_type: None,
    }
}

/// Quelle einer serverseitigen Kopie: `bucket/key`, URL-kodiert.
fn copy_source(source: &ObjectRef) -> (String, String) {
    let value = format!("{}/{}", encode_path(&source.bucket), encode_path(&source.key));
    ("x-amz-copy-source".to_owned(), value)
}

fn content_type_header(target: &ObjectRef) -> Vec<(String, String)> {
    target
        .content_type
        .iter()
        .map(|ct| ("content-type".to_owned(), ct.clone()))
        .collect()
}

fn map_transport_error(error: &reqwest::Error) -> StoreError {
    if error.is_timeout() {
        StoreError::Timeout
    } else {
        // Die vollständige Ursachenkette enthält z. B. TLS- oder DNS-Details.
        let mut message = error.to_string();
        let mut source = std::error::Error::source(error);
        while let Some(cause) = source {
            message.push_str(": ");
            message.push_str(&cause.to_string());
            source = cause.source();
        }
        StoreError::Network(message)
    }
}
