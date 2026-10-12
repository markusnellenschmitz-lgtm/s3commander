//! Endpunkt eines S3-kompatiblen Dienstes und die Bildung von Request-URLs.
//!
//! Virtual-Hosted (`bucket.host/key`) ist der AWS-Standard, viele selbst gehostete Dienste
//! verlangen Path-Style (`host/bucket/key`). Bucket-Namen, die nicht DNS-tauglich sind oder
//! über HTTPS einen Punkt enthalten (Zertifikat passt nicht), fallen automatisch auf
//! Path-Style zurück.
//!
//! Einschränkung: Keys mit Pfadsegmenten `.` oder `..` werden von URL-Bibliotheken
//! normalisiert und sind über diese Funktionen nicht adressierbar.

use super::error::StoreError;
use super::uri::encode_path;
use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Addressing {
    VirtualHosted,
    PathStyle,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    base: Url,
    region: String,
    addressing: Addressing,
}

const MIN_BUCKET_LEN: usize = 3;
const MAX_BUCKET_LEN: usize = 63;

impl Endpoint {
    /// # Errors
    ///
    /// `InvalidConfig` bei ungültiger URL, anderem Schema als http/https, Pfad oder Query
    /// in der URL oder leerer Region.
    pub fn new(url: &str, region: &str, addressing: Addressing) -> Result<Self, StoreError> {
        let invalid = |reason: &str| StoreError::InvalidConfig(format!("Endpoint-URL {url}: {reason}"));
        let base = Url::parse(url.trim()).map_err(|e| invalid(&e.to_string()))?;
        if !matches!(base.scheme(), "http" | "https") {
            return Err(invalid("nur http und https sind erlaubt"));
        }
        if base.host_str().is_none() {
            return Err(invalid("Host fehlt"));
        }
        if base.path() != "/" || base.query().is_some() {
            return Err(invalid("darf keinen Pfad und keine Query enthalten"));
        }
        let region = region.trim();
        if region.is_empty() {
            return Err(StoreError::InvalidConfig("Region ist Pflicht".into()));
        }
        Ok(Self {
            base,
            region: region.to_owned(),
            addressing,
        })
    }

    #[must_use]
    pub fn region(&self) -> &str {
        &self.region
    }

    #[must_use]
    pub fn addressing(&self) -> Addressing {
        self.addressing
    }

    /// URL für Anfragen ohne Bucket (`ListBuckets`).
    #[must_use]
    pub fn service_url(&self) -> Url {
        self.base.clone()
    }

    /// URL für Anfragen an einen Bucket (`ListObjects`), mit abschließendem `/`.
    #[must_use]
    pub fn bucket_url(&self, bucket: &str) -> Url {
        self.object_url(bucket, "")
    }

    /// URL für ein Objekt.
    #[must_use]
    pub fn object_url(&self, bucket: &str, key: &str) -> Url {
        let mut url = self.base.clone();
        let encoded_key = encode_path(key);
        match self.effective_addressing(bucket) {
            Addressing::VirtualHosted => {
                let host = format!("{bucket}.{}", self.base.host_str().unwrap_or_default());
                // Der Host wurde in new() geprüft; ein DNS-tauglicher Bucket ergibt einen gültigen Host.
                let _ = url.set_host(Some(&host));
                url.set_path(&format!("/{encoded_key}"));
            }
            Addressing::PathStyle => url.set_path(&format!("/{bucket}/{encoded_key}")),
        }
        url
    }

    /// Tatsächlich verwendete Adressierung für einen Bucket.
    #[must_use]
    pub fn effective_addressing(&self, bucket: &str) -> Addressing {
        let dots_break_tls = self.base.scheme() == "https" && bucket.contains('.');
        if self.addressing == Addressing::VirtualHosted && is_dns_compatible(bucket) && !dots_break_tls {
            Addressing::VirtualHosted
        } else {
            Addressing::PathStyle
        }
    }
}

/// Bucket-Name als DNS-Label nutzbar: 3–63 Zeichen, Kleinbuchstaben, Ziffern, `-` und `.`,
/// Anfang und Ende alphanumerisch, keine `..`, keine IP-Adresse.
#[must_use]
pub fn is_dns_compatible(bucket: &str) -> bool {
    let allowed = bucket
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.');
    let edges = bucket.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
        && bucket.bytes().last().is_some_and(|b| b.is_ascii_alphanumeric());
    (MIN_BUCKET_LEN..=MAX_BUCKET_LEN).contains(&bucket.len())
        && allowed
        && edges
        && !bucket.contains("..")
        && bucket.parse::<std::net::Ipv4Addr>().is_err()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn aws() -> Endpoint {
        Endpoint::new(
            "https://s3.eu-central-1.amazonaws.com",
            "eu-central-1",
            Addressing::VirtualHosted,
        )
        .unwrap()
    }

    #[test]
    fn builds_virtual_hosted_urls() {
        let e = aws();
        assert_eq!(e.service_url().as_str(), "https://s3.eu-central-1.amazonaws.com/");
        assert_eq!(
            e.bucket_url("prod-backups-eu").as_str(),
            "https://prod-backups-eu.s3.eu-central-1.amazonaws.com/"
        );
        assert_eq!(
            e.object_url("prod-backups-eu", "backups/2026/10/db full.tar.zst")
                .as_str(),
            "https://prod-backups-eu.s3.eu-central-1.amazonaws.com/backups/2026/10/db%20full.tar.zst"
        );
    }

    #[test]
    fn builds_path_style_urls_with_port() {
        let e = Endpoint::new("http://localhost:9000/", "us-east-1", Addressing::PathStyle).unwrap();
        assert_eq!(e.bucket_url("media").as_str(), "http://localhost:9000/media/");
        assert_eq!(
            e.object_url("media", "a/ä.txt").as_str(),
            "http://localhost:9000/media/a/%C3%A4.txt"
        );
    }

    #[test]
    fn falls_back_to_path_style_when_needed() {
        let e = aws();
        assert_eq!(e.effective_addressing("my.dotted.bucket"), Addressing::PathStyle);
        assert_eq!(e.effective_addressing("Upper_Case"), Addressing::PathStyle);
        assert_eq!(
            e.object_url("my.bucket", "k").as_str(),
            "https://s3.eu-central-1.amazonaws.com/my.bucket/k"
        );
        let http = Endpoint::new("http://minio.lan", "us-east-1", Addressing::VirtualHosted).unwrap();
        assert_eq!(http.effective_addressing("my.bucket"), Addressing::VirtualHosted);
    }

    #[test]
    fn exposes_region_and_addressing() {
        let e = aws();
        assert_eq!(e.region(), "eu-central-1");
        assert_eq!(e.addressing(), Addressing::VirtualHosted);
    }

    #[test]
    fn rejects_invalid_configuration() {
        for (url, region) in [
            ("ftp://host", "r"),
            ("kein url", "r"),
            ("https://host/pfad", "r"),
            ("https://host/?x=1", "r"),
            ("https://host", " "),
            ("file:///c:/x", "r"),
        ] {
            assert!(
                matches!(
                    Endpoint::new(url, region, Addressing::PathStyle),
                    Err(StoreError::InvalidConfig(_))
                ),
                "{url} sollte abgelehnt werden"
            );
        }
    }

    #[test]
    fn checks_dns_compatibility() {
        for ok in ["abc", "prod-media-eu", "a.b.c", "x1y"] {
            assert!(is_dns_compatible(ok), "{ok}");
        }
        for bad in [
            "ab",
            "-abc",
            "abc-",
            "a..b",
            "ABC",
            "a_b",
            "192.168.1.1",
            &"a".repeat(64),
        ] {
            assert!(!is_dns_compatible(bad), "{bad}");
        }
    }
}
