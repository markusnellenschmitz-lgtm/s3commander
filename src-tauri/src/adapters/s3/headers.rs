//! Auswertung der Antwort-Header von `HeadObject`: Größe, Typ, `ETag`, Storage Class, Datum,
//! Version und Metadaten.

use crate::domain::details::{CUSTOMER_ENCRYPTION, MetadataEntry, ObjectHead, SYSTEM_METADATA, USER_METADATA_PREFIX};
use crate::domain::timestamp::unix_ms;
use reqwest::header::HeaderMap;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc2822;

/// Storage Class ohne Header: S3 lässt ihn bei STANDARD weg.
const DEFAULT_STORAGE_CLASS: &str = "STANDARD";

/// Kopfdaten aus den Headern einer `HeadObject`-Antwort.
#[must_use]
pub fn object_head(headers: &HeaderMap) -> ObjectHead {
    let text = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let mut metadata: Vec<MetadataEntry> = headers
        .iter()
        .filter(|(name, _)| is_metadata(name.as_str()))
        .filter_map(|(name, value)| {
            Some(MetadataEntry {
                name: name.as_str().to_owned(),
                value: value.to_str().ok()?.to_owned(),
            })
        })
        .collect();
    metadata.sort_by(|a, b| a.name.cmp(&b.name));
    ObjectHead {
        size: text("content-length").and_then(|v| v.parse().ok()).unwrap_or(0),
        content_type: text("content-type"),
        etag: text("etag"),
        storage_class: text("x-amz-storage-class").or_else(|| Some(DEFAULT_STORAGE_CLASS.to_owned())),
        last_modified_ms: text("last-modified").as_deref().and_then(parse_http_date),
        version_id: text("x-amz-version-id"),
        metadata,
        encryption: text("x-amz-server-side-encryption-customer-algorithm")
            .map(|_| CUSTOMER_ENCRYPTION.to_owned())
            .or_else(|| text("x-amz-server-side-encryption")),
    }
}

fn is_metadata(name: &str) -> bool {
    name.starts_with(USER_METADATA_PREFIX) || SYSTEM_METADATA.contains(&name)
}

/// HTTP-Datum (`Wed, 21 Oct 2015 07:28:00 GMT`) in Millisekunden seit Epoch.
#[must_use]
pub fn parse_http_date(value: &str) -> Option<i64> {
    unix_ms(OffsetDateTime::parse(value, &Rfc2822).ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderName, HeaderValue};

    fn headers(pairs: &[(&str, &[u8])]) -> HeaderMap {
        pairs
            .iter()
            .map(|(name, value)| {
                (
                    HeaderName::from_bytes(name.as_bytes()).unwrap(),
                    HeaderValue::from_bytes(value).unwrap(),
                )
            })
            .collect()
    }

    #[test]
    fn reads_head_fields_and_sorted_metadata() {
        let head = object_head(&headers(&[
            ("content-length", b"5089471232"),
            ("content-type", b"application/zstd"),
            ("etag", b"\"abc-157\""),
            ("x-amz-storage-class", b"STANDARD_IA"),
            ("last-modified", b"Sun, 11 Oct 2026 03:14:52 GMT"),
            ("x-amz-version-id", b"3HL4kqtJ"),
            ("x-amz-meta-source-host", b"db-prod-01"),
            ("cache-control", b"no-store"),
            ("x-amz-request-id", b"egal"),
            ("x-amz-meta-binaer", b"\xff"),
        ]));
        assert_eq!(head.size, 5_089_471_232);
        assert_eq!(head.content_type.as_deref(), Some("application/zstd"));
        assert_eq!(head.etag.as_deref(), Some("\"abc-157\""));
        assert_eq!(head.storage_class.as_deref(), Some("STANDARD_IA"));
        assert_eq!(head.last_modified_ms, Some(1_791_688_492_000));
        assert_eq!(head.version_id.as_deref(), Some("3HL4kqtJ"));
        let names: Vec<_> = head.metadata.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, ["cache-control", "x-amz-meta-source-host"]);
    }

    #[test]
    fn falls_back_to_standard_and_tolerates_missing_headers() {
        let head = object_head(&HeaderMap::new());
        assert_eq!((head.size, head.storage_class.as_deref()), (0, Some("STANDARD")));
        assert_eq!(head.last_modified_ms, None);
        assert_eq!(parse_http_date("kein Datum"), None);
        assert!(head.etag_is_md5());
    }

    #[test]
    fn reads_server_side_encryption() {
        let sse_s3 = object_head(&headers(&[("x-amz-server-side-encryption", b"AES256")]));
        assert_eq!(sse_s3.encryption.as_deref(), Some("AES256"));
        assert!(sse_s3.etag_is_md5());
        let kms = object_head(&headers(&[("x-amz-server-side-encryption", b"aws:kms")]));
        assert!(!kms.etag_is_md5());
        let customer = object_head(&headers(&[(
            "x-amz-server-side-encryption-customer-algorithm",
            b"AES256",
        )]));
        assert_eq!(customer.encryption.as_deref(), Some("SSE-C"));
        assert!(!customer.etag_is_md5());
    }
}
