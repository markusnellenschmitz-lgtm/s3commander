//! Vorlagen für S3-kompatible Anbieter (Screen 1, Verbindungsdialog) und ihre Eigenheiten.
//!
//! Eigenheiten sind bewusst vorsichtig gesetzt: Nur wo eine Funktion sicher unterstützt wird,
//! ist sie aktiv. Benutzer können sie pro Profil überschreiben.

use super::endpoint::Addressing;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Provider {
    Aws,
    Minio,
    BackblazeB2,
    CloudflareR2,
    Wasabi,
    Hetzner,
    Ceph,
    Garage,
    Custom,
}

/// Abweichungen einzelner Anbieter vom AWS-Verhalten.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quirks {
    /// Listing mit `encoding-type=url` anfordern (schützt Keys mit Steuerzeichen).
    pub url_encoded_listing: bool,
    /// Prüfsummen mit CRC32C (`x-amz-checksum-crc32c`) werden unterstützt.
    pub crc32c_checksums: bool,
}

impl Quirks {
    pub const CONSERVATIVE: Self = Self {
        url_encoded_listing: false,
        crc32c_checksums: false,
    };
    pub const FULL: Self = Self {
        url_encoded_listing: true,
        crc32c_checksums: true,
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPreset {
    pub provider: Provider,
    pub label: &'static str,
    /// Platzhalter `{region}` und `{account}` werden ersetzt; leer bei selbst gehosteten Diensten.
    pub endpoint_template: &'static str,
    pub default_region: &'static str,
    pub regions: &'static [&'static str],
    pub addressing: Addressing,
    pub quirks: Quirks,
    pub self_hosted: bool,
}

pub const PRESETS: &[ProviderPreset] = &[
    ProviderPreset {
        provider: Provider::Aws,
        label: "AWS S3",
        endpoint_template: "https://s3.{region}.amazonaws.com",
        default_region: "eu-central-1",
        regions: &[
            "eu-central-1",
            "eu-central-2",
            "eu-west-1",
            "eu-west-2",
            "eu-west-3",
            "eu-north-1",
            "eu-south-1",
            "us-east-1",
            "us-east-2",
            "us-west-1",
            "us-west-2",
            "ap-northeast-1",
            "ap-southeast-1",
            "ap-southeast-2",
        ],
        addressing: Addressing::VirtualHosted,
        quirks: Quirks::FULL,
        self_hosted: false,
    },
    ProviderPreset {
        provider: Provider::Minio,
        label: "MinIO",
        endpoint_template: "",
        default_region: "us-east-1",
        regions: &[],
        addressing: Addressing::PathStyle,
        quirks: Quirks::FULL,
        self_hosted: true,
    },
    ProviderPreset {
        provider: Provider::BackblazeB2,
        label: "Backblaze B2",
        endpoint_template: "https://s3.{region}.backblazeb2.com",
        default_region: "eu-central-003",
        regions: &[
            "eu-central-003",
            "us-west-001",
            "us-west-002",
            "us-west-004",
            "us-east-005",
        ],
        addressing: Addressing::VirtualHosted,
        quirks: Quirks::CONSERVATIVE,
        self_hosted: false,
    },
    ProviderPreset {
        provider: Provider::CloudflareR2,
        label: "Cloudflare R2",
        endpoint_template: "https://{account}.r2.cloudflarestorage.com",
        default_region: "auto",
        regions: &["auto"],
        addressing: Addressing::PathStyle,
        quirks: Quirks::CONSERVATIVE,
        self_hosted: false,
    },
    ProviderPreset {
        provider: Provider::Wasabi,
        label: "Wasabi",
        endpoint_template: "https://s3.{region}.wasabisys.com",
        default_region: "eu-central-1",
        regions: &[
            "eu-central-1",
            "eu-central-2",
            "eu-west-1",
            "eu-west-2",
            "us-east-1",
            "us-east-2",
            "us-west-1",
            "ap-northeast-1",
        ],
        addressing: Addressing::VirtualHosted,
        quirks: Quirks::CONSERVATIVE,
        self_hosted: false,
    },
    ProviderPreset {
        provider: Provider::Hetzner,
        label: "Hetzner",
        endpoint_template: "https://{region}.your-objectstorage.com",
        default_region: "fsn1",
        regions: &["fsn1", "nbg1", "hel1"],
        addressing: Addressing::VirtualHosted,
        quirks: Quirks::CONSERVATIVE,
        self_hosted: false,
    },
    ProviderPreset {
        provider: Provider::Ceph,
        label: "Ceph",
        endpoint_template: "",
        default_region: "default",
        regions: &[],
        addressing: Addressing::PathStyle,
        quirks: Quirks::CONSERVATIVE,
        self_hosted: true,
    },
    ProviderPreset {
        provider: Provider::Garage,
        label: "Garage",
        endpoint_template: "",
        default_region: "garage",
        regions: &[],
        addressing: Addressing::PathStyle,
        quirks: Quirks::CONSERVATIVE,
        self_hosted: true,
    },
    ProviderPreset {
        provider: Provider::Custom,
        label: "Benutzerdefiniert",
        endpoint_template: "",
        default_region: "us-east-1",
        regions: &[],
        addressing: Addressing::PathStyle,
        quirks: Quirks::CONSERVATIVE,
        self_hosted: true,
    },
];

/// Vorlage zu einem Anbieter. Jeder Anbieter hat genau eine Vorlage.
#[must_use]
pub fn preset(provider: Provider) -> &'static ProviderPreset {
    PRESETS
        .iter()
        .find(|p| p.provider == provider)
        .unwrap_or(&PRESETS[PRESETS.len() - 1])
}

impl ProviderPreset {
    /// Endpoint-URL aus der Vorlage; `None` bei selbst gehosteten Diensten ohne Vorlage.
    #[must_use]
    pub fn endpoint(&self, region: &str, account: &str) -> Option<String> {
        (!self.endpoint_template.is_empty()).then(|| {
            self.endpoint_template
                .replace("{region}", region)
                .replace("{account}", account)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [Provider; 9] = [
        Provider::Aws,
        Provider::Minio,
        Provider::BackblazeB2,
        Provider::CloudflareR2,
        Provider::Wasabi,
        Provider::Hetzner,
        Provider::Ceph,
        Provider::Garage,
        Provider::Custom,
    ];

    #[test]
    fn every_provider_has_exactly_one_preset() {
        assert_eq!(PRESETS.len(), ALL.len());
        for provider in ALL {
            assert_eq!(preset(provider).provider, provider);
            assert_eq!(PRESETS.iter().filter(|p| p.provider == provider).count(), 1);
        }
    }

    #[test]
    fn hosted_presets_build_endpoints_from_region() {
        assert_eq!(
            preset(Provider::Hetzner).endpoint("nbg1", "").as_deref(),
            Some("https://nbg1.your-objectstorage.com")
        );
        assert_eq!(
            preset(Provider::Aws).endpoint("eu-central-1", "").as_deref(),
            Some("https://s3.eu-central-1.amazonaws.com")
        );
        assert_eq!(
            preset(Provider::CloudflareR2).endpoint("auto", "abc123").as_deref(),
            Some("https://abc123.r2.cloudflarestorage.com")
        );
        assert_eq!(preset(Provider::Minio).endpoint("us-east-1", ""), None);
    }

    #[test]
    fn default_region_is_offered_where_regions_are_listed() {
        for p in PRESETS.iter().filter(|p| !p.regions.is_empty()) {
            assert!(p.regions.contains(&p.default_region), "{}", p.label);
        }
    }

    #[test]
    fn self_hosted_presets_have_no_template_and_use_path_style() {
        for p in PRESETS.iter().filter(|p| p.self_hosted) {
            assert!(p.endpoint_template.is_empty(), "{}", p.label);
            assert_eq!(p.addressing, Addressing::PathStyle, "{}", p.label);
        }
    }

    #[test]
    fn serializes_provider_ids_in_kebab_case() {
        assert_eq!(
            serde_json::to_string(&Provider::BackblazeB2).unwrap(),
            r#""backblaze-b2""#
        );
    }
}
