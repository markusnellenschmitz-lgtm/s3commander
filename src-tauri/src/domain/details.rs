//! Objekt-Details (Screen 5): Kopfdaten, Metadaten, Tags, Versionen und Berechtigungen,
//! dazu die Regeln, die S3 für Metadaten und Tags vorgibt.

use serde::{Deserialize, Serialize};

/// Höchstens so viele Tags je Objekt.
pub const MAX_TAGS: usize = 10;
pub const MAX_TAG_KEY_CHARS: usize = 128;
pub const MAX_TAG_VALUE_CHARS: usize = 256;
/// Vorsignierte Links gelten mit `SigV4` höchstens sieben Tage.
pub const MAX_PRESIGN_SECS: u32 = 7 * 24 * 60 * 60;
/// Präfix benutzerdefinierter Metadaten.
pub const USER_METADATA_PREFIX: &str = "x-amz-meta-";
/// System-Metadaten, die beim Ersetzen mitgesendet werden dürfen (Content-Type gehört zu „Allgemein“).
pub const SYSTEM_METADATA: [&str; 5] = [
    "cache-control",
    "content-disposition",
    "content-encoding",
    "content-language",
    "expires",
];

/// Ein Metadaten-Eintrag; Namen klein geschrieben, wie S3 sie liefert.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MetadataEntry {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObjectTag {
    pub key: String,
    pub value: String,
}

/// Kopfdaten eines Objekts (`HeadObject`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectHead {
    pub size: u64,
    pub content_type: Option<String>,
    pub etag: Option<String>,
    pub storage_class: Option<String>,
    /// Millisekunden seit Epoch
    pub last_modified_ms: Option<i64>,
    pub version_id: Option<String>,
    /// System- und Benutzer-Metadaten, sortiert nach Namen.
    pub metadata: Vec<MetadataEntry>,
    /// Serverseitige Verschlüsselung: `AES256`, `aws:kms`, `aws:kms:dsse` oder `SSE-C`.
    pub encryption: Option<String>,
}

/// Verschlüsselung mit vom Kunden gelieferten Schlüsseln.
pub const CUSTOMER_ENCRYPTION: &str = "SSE-C";

impl ObjectHead {
    /// Nur unverschlüsselte und mit SSE-S3 (`AES256`) verschlüsselte Objekte haben die MD5-Summe
    /// als einfachen `ETag`; bei KMS- und Kundenschlüsseln ist er etwas anderes.
    #[must_use]
    pub fn etag_is_md5(&self) -> bool {
        self.encryption.as_deref().is_none_or(|e| e == "AES256")
    }
}

/// Eine Version oder ein Delete Marker (`ListObjectVersions`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectVersion {
    pub version_id: String,
    pub is_latest: bool,
    pub is_delete_marker: bool,
    /// Millisekunden seit Epoch
    pub last_modified_ms: Option<i64>,
    pub size: u64,
}

/// Berechtigung aus der ACL eines Objekts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AclGrant {
    /// Anzeigename, Konto-ID, E-Mail oder Gruppen-URI.
    pub grantee: String,
    /// Öffentlich für alle (`AllUsers`) oder alle angemeldeten AWS-Konten.
    pub is_public: bool,
    pub permission: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectAcl {
    pub owner: Option<String>,
    pub grants: Vec<AclGrant>,
}

/// Warum Metadaten oder Tags nicht gespeichert werden können. Texte erscheinen in der Oberfläche.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DetailsError {
    #[error(
        "„{0}“ ist kein gültiger Metadaten-Name (x-amz-meta-… oder Cache-Control, Content-Disposition, Content-Encoding, Content-Language, Expires)"
    )]
    MetadataName(String),
    #[error("Der Wert von „{0}“ darf nur sichtbare ASCII-Zeichen und Leerzeichen enthalten")]
    MetadataValue(String),
    #[error("„{0}“ kommt mehrfach vor")]
    Duplicate(String),
    #[error("Ein Objekt kann höchstens 10 Tags haben")]
    TooManyTags,
    #[error("Tag-Schlüssel müssen 1 bis 128 Zeichen lang sein")]
    TagKey,
    #[error("Tag-Werte dürfen höchstens 256 Zeichen lang sein")]
    TagValue,
}

/// Prüft Metadaten vor dem Ersetzen und liefert sie mit klein geschriebenen Namen.
///
/// # Errors
/// Unbekannte System-Header, ungültige Namen oder Werte, doppelte Namen.
pub fn validate_metadata(entries: &[MetadataEntry]) -> Result<Vec<MetadataEntry>, DetailsError> {
    let mut seen = Vec::new();
    entries
        .iter()
        .map(|entry| {
            let name = entry.name.trim().to_ascii_lowercase();
            if !is_valid_metadata_name(&name) {
                return Err(DetailsError::MetadataName(entry.name.clone()));
            }
            if !entry.value.chars().all(|c| c == ' ' || c.is_ascii_graphic()) {
                return Err(DetailsError::MetadataValue(entry.name.clone()));
            }
            if seen.contains(&name) {
                return Err(DetailsError::Duplicate(entry.name.clone()));
            }
            seen.push(name.clone());
            Ok(MetadataEntry {
                name,
                value: entry.value.trim().to_owned(),
            })
        })
        .collect()
}

fn is_valid_metadata_name(name: &str) -> bool {
    match name.strip_prefix(USER_METADATA_PREFIX) {
        Some(rest) => !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
        None => SYSTEM_METADATA.contains(&name),
    }
}

/// Prüft Tags vor dem Speichern.
///
/// # Errors
/// Mehr als zehn Tags, leere oder zu lange Schlüssel, zu lange Werte, doppelte Schlüssel.
pub fn validate_tags(tags: &[ObjectTag]) -> Result<(), DetailsError> {
    if tags.len() > MAX_TAGS {
        return Err(DetailsError::TooManyTags);
    }
    for (index, tag) in tags.iter().enumerate() {
        let key_chars = tag.key.chars().count();
        if key_chars == 0 || key_chars > MAX_TAG_KEY_CHARS {
            return Err(DetailsError::TagKey);
        }
        if tag.value.chars().count() > MAX_TAG_VALUE_CHARS {
            return Err(DetailsError::TagValue);
        }
        if tags[..index].iter().any(|t| t.key == tag.key) {
            return Err(DetailsError::Duplicate(tag.key.clone()));
        }
    }
    Ok(())
}

/// Gültigkeit eines vorsignierten Links: mindestens eine Sekunde, höchstens sieben Tage.
#[must_use]
pub fn clamp_presign_secs(secs: u32) -> u32 {
    secs.clamp(1, MAX_PRESIGN_SECS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(name: &str, value: &str) -> MetadataEntry {
        MetadataEntry {
            name: name.into(),
            value: value.into(),
        }
    }

    fn tag(key: &str, value: &str) -> ObjectTag {
        ObjectTag {
            key: key.into(),
            value: value.into(),
        }
    }

    #[test]
    fn accepts_user_and_system_metadata_with_lowercase_names() {
        let valid = validate_metadata(&[
            meta(" X-Amz-Meta-Pg-Version ", "16.4 "),
            meta("Cache-Control", "no-store"),
        ]);
        assert_eq!(
            valid.unwrap(),
            [meta("x-amz-meta-pg-version", "16.4"), meta("cache-control", "no-store")]
        );
    }

    #[test]
    fn rejects_unknown_headers_bad_values_and_duplicates() {
        assert_eq!(
            validate_metadata(&[meta("x-amz-meta-", "x")]),
            Err(DetailsError::MetadataName("x-amz-meta-".into()))
        );
        assert!(matches!(
            validate_metadata(&[meta("authorization", "x")]),
            Err(DetailsError::MetadataName(_))
        ));
        assert!(matches!(
            validate_metadata(&[meta("x-amz-meta-a b", "x")]),
            Err(DetailsError::MetadataName(_))
        ));
        assert!(matches!(
            validate_metadata(&[meta("x-amz-meta-a", "ümlaut")]),
            Err(DetailsError::MetadataValue(_))
        ));
        assert!(matches!(
            validate_metadata(&[meta("x-amz-meta-a", "a\nb")]),
            Err(DetailsError::MetadataValue(_))
        ));
        assert_eq!(
            validate_metadata(&[meta("x-amz-meta-a", "1"), meta("X-Amz-Meta-A", "2")]),
            Err(DetailsError::Duplicate("X-Amz-Meta-A".into()))
        );
    }

    #[test]
    fn checks_tag_limits() {
        assert!(validate_tags(&[tag("env", "prod"), tag("leer", "")]).is_ok());
        let eleven: Vec<_> = (0..11).map(|i| tag(&format!("k{i}"), "v")).collect();
        assert_eq!(validate_tags(&eleven), Err(DetailsError::TooManyTags));
        assert_eq!(validate_tags(&[tag("", "v")]), Err(DetailsError::TagKey));
        assert_eq!(validate_tags(&[tag(&"k".repeat(129), "v")]), Err(DetailsError::TagKey));
        assert_eq!(
            validate_tags(&[tag("k", &"v".repeat(257))]),
            Err(DetailsError::TagValue)
        );
        assert_eq!(
            validate_tags(&[tag("a", "1"), tag("a", "2")]),
            Err(DetailsError::Duplicate("a".into()))
        );
    }

    #[test]
    fn clamps_presign_durations() {
        assert_eq!(clamp_presign_secs(0), 1);
        assert_eq!(clamp_presign_secs(3600), 3600);
        assert_eq!(clamp_presign_secs(u32::MAX), MAX_PRESIGN_SECS);
    }

    #[test]
    fn serializes_for_the_frontend() {
        let version = ObjectVersion {
            version_id: "v1".into(),
            is_latest: true,
            is_delete_marker: false,
            last_modified_ms: Some(1),
            size: 2,
        };
        assert_eq!(
            serde_json::to_string(&version).unwrap(),
            r#"{"versionId":"v1","isLatest":true,"isDeleteMarker":false,"lastModifiedMs":1,"size":2}"#
        );
        let head = serde_json::to_string(&ObjectHead::default()).unwrap();
        assert!(head.contains(r#""contentType":null"#));
    }
}
