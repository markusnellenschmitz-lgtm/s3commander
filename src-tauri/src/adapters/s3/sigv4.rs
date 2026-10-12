//! AWS Signature Version 4 für Header-Signaturen und Presigned URLs.
//! Referenz: AWS-Dokumentation "Signature Version 4 signing process" und S3-Beispiele.

use crate::domain::credentials::Credentials;
use crate::domain::uri::{canonical_query, encode_path, parse_query};
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use time::OffsetDateTime;
use time::macros::format_description;
use url::Url;

pub const ALGORITHM: &str = "AWS4-HMAC-SHA256";
/// SHA-256 eines leeren Körpers.
pub const EMPTY_PAYLOAD_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
pub const UNSIGNED_PAYLOAD: &str = "UNSIGNED-PAYLOAD";
const TERMINATOR: &str = "aws4_request";

/// Wer signiert, wo und wann.
#[derive(Debug, Clone, Copy)]
pub struct SigningScope<'a> {
    pub credentials: &'a Credentials,
    pub region: &'a str,
    pub service: &'a str,
    pub time: OffsetDateTime,
}

impl SigningScope<'_> {
    fn amz_date(&self) -> String {
        format_time(self.time, true)
    }

    fn credential_scope(&self) -> String {
        format!(
            "{}/{}/{}/{TERMINATOR}",
            format_time(self.time, false),
            self.region,
            self.service
        )
    }

    fn signing_key(&self) -> Vec<u8> {
        let secret = format!("AWS4{}", self.credentials.secret_access_key());
        let date = hmac(secret.as_bytes(), format_time(self.time, false).as_bytes());
        let region = hmac(&date, self.region.as_bytes());
        let service = hmac(&region, self.service.as_bytes());
        hmac(&service, TERMINATOR.as_bytes())
    }

    fn signature(&self, canonical_request: &str) -> String {
        let string_to_sign = format!(
            "{ALGORITHM}\n{}\n{}\n{}",
            self.amz_date(),
            self.credential_scope(),
            hex::encode(Sha256::digest(canonical_request.as_bytes()))
        );
        hex::encode(hmac(&self.signing_key(), string_to_sign.as_bytes()))
    }
}

/// Signiert eine Anfrage. `headers` enthält alle zu signierenden Header außer `host`,
/// `x-amz-date` und `x-amz-security-token`; diese ergänzt die Funktion.
/// Rückgabe: zusätzliche Header inklusive `authorization`.
#[must_use]
pub fn sign_headers(
    method: &str,
    url: &Url,
    headers: &[(String, String)],
    payload_hash: &str,
    scope: &SigningScope<'_>,
) -> Vec<(String, String)> {
    let mut added = vec![("x-amz-date".to_owned(), scope.amz_date())];
    if let Some(token) = scope.credentials.session_token() {
        added.push(("x-amz-security-token".to_owned(), token.to_owned()));
    }
    let mut all: Vec<(String, String)> = vec![("host".to_owned(), host_header(url))];
    all.extend(headers.iter().cloned());
    all.extend(added.iter().cloned());
    let (canonical_headers, signed_headers) = canonicalize_headers(&all);
    let canonical_request = format!(
        "{method}\n{}\n{}\n{canonical_headers}\n{signed_headers}\n{payload_hash}",
        canonical_uri(url),
        canonical_query(&parse_query(url.query().unwrap_or_default()))
    );
    let authorization = format!(
        "{ALGORITHM} Credential={}/{}, SignedHeaders={signed_headers}, Signature={}",
        scope.credentials.access_key_id(),
        scope.credential_scope(),
        scope.signature(&canonical_request)
    );
    added.push(("authorization".to_owned(), authorization));
    added
}

/// Erzeugt eine Presigned URL (nur `host` signiert, Payload unsigniert).
#[must_use]
pub fn presign_url(method: &str, url: &Url, expires_secs: u32, scope: &SigningScope<'_>) -> Url {
    let mut query = parse_query(url.query().unwrap_or_default());
    query.push(("X-Amz-Algorithm".into(), ALGORITHM.into()));
    query.push((
        "X-Amz-Credential".into(),
        format!("{}/{}", scope.credentials.access_key_id(), scope.credential_scope()),
    ));
    query.push(("X-Amz-Date".into(), scope.amz_date()));
    query.push(("X-Amz-Expires".into(), expires_secs.to_string()));
    if let Some(token) = scope.credentials.session_token() {
        query.push(("X-Amz-Security-Token".into(), token.to_owned()));
    }
    query.push(("X-Amz-SignedHeaders".into(), "host".into()));
    let canonical_query = canonical_query(&query);
    let canonical_request = format!(
        "{method}\n{}\n{canonical_query}\nhost:{}\n\nhost\n{UNSIGNED_PAYLOAD}",
        canonical_uri(url),
        host_header(url)
    );
    let mut signed = url.clone();
    signed.set_query(Some(&format!(
        "{canonical_query}&X-Amz-Signature={}",
        scope.signature(&canonical_request)
    )));
    signed
}

/// Hex-SHA-256 eines Körpers für `x-amz-content-sha256`.
#[must_use]
pub fn payload_sha256(body: &[u8]) -> String {
    hex::encode(Sha256::digest(body))
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    // HMAC akzeptiert Schlüssel jeder Länge; new_from_slice kann hier nicht fehlschlagen.
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(key).unwrap_or_else(|_| unreachable!());
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn format_time(time: OffsetDateTime, with_clock: bool) -> String {
    let utc = time.to_offset(time::UtcOffset::UTC);
    let formatted = if with_clock {
        utc.format(format_description!("[year][month][day]T[hour][minute][second]Z"))
    } else {
        utc.format(format_description!("[year][month][day]"))
    };
    formatted.unwrap_or_default()
}

fn host_header(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default();
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    }
}

/// Der Pfad liegt bereits kodiert in der URL; er wird dekodiert und S3-konform neu
/// kodiert, damit beliebig kodierte URLs dieselbe Signatur ergeben.
fn canonical_uri(url: &Url) -> String {
    encode_path(&crate::domain::uri::decode(url.path(), false))
}

fn canonicalize_headers(headers: &[(String, String)]) -> (String, String) {
    let mut normalized: Vec<(String, String)> = headers
        .iter()
        .map(|(k, v)| {
            (
                k.to_ascii_lowercase(),
                v.split_whitespace().collect::<Vec<_>>().join(" "),
            )
        })
        .collect();
    normalized.sort();
    let canonical = normalized.iter().fold(String::new(), |mut out, (k, v)| {
        // Schreiben in einen String kann nicht fehlschlagen.
        let _ = writeln!(out, "{k}:{v}");
        out
    });
    let signed = normalized.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(";");
    (canonical, signed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    fn header<'a>(headers: &'a [(String, String)], name: &str) -> &'a str {
        headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
            .unwrap()
    }

    fn signature_of(headers: &[(String, String)]) -> &str {
        header(headers, "authorization").rsplit("Signature=").next().unwrap()
    }

    /// AWS SigV4-Testsuite, Fall "get-vanilla".
    #[test]
    fn matches_aws_test_suite_get_vanilla() {
        let credentials = Credentials::new("AKIDEXAMPLE", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", None).unwrap();
        let scope = SigningScope {
            credentials: &credentials,
            region: "us-east-1",
            service: "service",
            time: datetime!(2015-08-30 12:36:00 UTC),
        };
        let url = Url::parse("https://example.amazonaws.com/").unwrap();
        let headers = sign_headers("GET", &url, &[], EMPTY_PAYLOAD_SHA256, &scope);
        assert_eq!(header(&headers, "x-amz-date"), "20150830T123600Z");
        assert_eq!(
            header(&headers, "authorization"),
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, \
             SignedHeaders=host;x-amz-date, \
             Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
        );
    }

    fn s3_example_credentials() -> Credentials {
        Credentials::new("AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", None).unwrap()
    }

    fn s3_example_scope(credentials: &Credentials) -> SigningScope<'_> {
        SigningScope {
            credentials,
            region: "us-east-1",
            service: "s3",
            time: datetime!(2013-05-24 00:00:00 UTC),
        }
    }

    /// S3-Doku, Beispiel "GET Object" mit Range-Header.
    #[test]
    fn matches_s3_example_get_object() {
        let credentials = s3_example_credentials();
        let url = Url::parse("https://examplebucket.s3.amazonaws.com/test.txt").unwrap();
        let signed = sign_headers(
            "GET",
            &url,
            &[
                ("range".into(), "bytes=0-9".into()),
                ("x-amz-content-sha256".into(), EMPTY_PAYLOAD_SHA256.into()),
            ],
            EMPTY_PAYLOAD_SHA256,
            &s3_example_scope(&credentials),
        );
        assert_eq!(
            signature_of(&signed),
            "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
        assert!(header(&signed, "authorization").contains("SignedHeaders=host;range;x-amz-content-sha256;x-amz-date"));
    }

    /// S3-Doku, Beispiel "GET Bucket (List Objects)" mit Query-Parametern.
    #[test]
    fn matches_s3_example_list_objects() {
        let credentials = s3_example_credentials();
        let url = Url::parse("https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J").unwrap();
        let signed = sign_headers(
            "GET",
            &url,
            &[("x-amz-content-sha256".into(), EMPTY_PAYLOAD_SHA256.into())],
            EMPTY_PAYLOAD_SHA256,
            &s3_example_scope(&credentials),
        );
        assert_eq!(
            signature_of(&signed),
            "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7"
        );
    }

    /// S3-Doku, Beispiel für eine Presigned URL mit 86.400 s Gültigkeit.
    #[test]
    fn matches_s3_example_presigned_url() {
        let credentials = s3_example_credentials();
        let url = Url::parse("https://examplebucket.s3.amazonaws.com/test.txt").unwrap();
        let signed = presign_url("GET", &url, 86_400, &s3_example_scope(&credentials));
        let query = signed.query().unwrap();
        assert!(query.contains("X-Amz-Expires=86400"));
        assert!(query.ends_with("X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"));
    }

    #[test]
    fn adds_session_tokens_to_headers_and_presigned_urls() {
        let credentials = Credentials::new("AKID", "secret", Some("TOKEN")).unwrap();
        let scope = SigningScope {
            credentials: &credentials,
            region: "eu-central-1",
            service: "s3",
            time: datetime!(2026-10-11 12:00:00 UTC),
        };
        let url = Url::parse("http://localhost:9000/bucket/key").unwrap();
        let headers = sign_headers("GET", &url, &[], UNSIGNED_PAYLOAD, &scope);
        assert_eq!(header(&headers, "x-amz-security-token"), "TOKEN");
        assert!(header(&headers, "authorization").contains("x-amz-security-token"));
        assert!(
            presign_url("GET", &url, 60, &scope)
                .query()
                .unwrap()
                .contains("X-Amz-Security-Token=TOKEN")
        );
    }

    #[test]
    fn signs_identically_regardless_of_url_encoding_and_header_case() {
        let credentials = s3_example_credentials();
        let scope = s3_example_scope(&credentials);
        let a = Url::parse("https://b.s3.amazonaws.com/a%20b/c?prefix=x%2Fy").unwrap();
        let b = Url::parse("https://b.s3.amazonaws.com/a b/c?prefix=x/y").unwrap();
        let h1 = sign_headers(
            "GET",
            &a,
            &[("X-Amz-Meta-A".into(), "  1   2 ".into())],
            EMPTY_PAYLOAD_SHA256,
            &scope,
        );
        let h2 = sign_headers(
            "GET",
            &b,
            &[("x-amz-meta-a".into(), "1 2".into())],
            EMPTY_PAYLOAD_SHA256,
            &scope,
        );
        assert_eq!(signature_of(&h1), signature_of(&h2));
    }

    #[test]
    fn includes_non_default_ports_in_the_host() {
        assert_eq!(
            host_header(&Url::parse("http://localhost:9000/").unwrap()),
            "localhost:9000"
        );
        assert_eq!(host_header(&Url::parse("https://host:443/").unwrap()), "host");
    }

    #[test]
    fn hashes_payloads() {
        assert_eq!(payload_sha256(b""), EMPTY_PAYLOAD_SHA256);
    }
}
