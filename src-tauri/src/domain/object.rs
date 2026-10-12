//! Buckets, Objekte und Listing-Seiten.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketInfo {
    pub name: String,
    /// Millisekunden seit Epoch
    pub created_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectEntry {
    pub key: String,
    pub size: u64,
    /// Millisekunden seit Epoch
    pub last_modified_ms: Option<i64>,
    pub etag: Option<String>,
    pub storage_class: Option<String>,
}

/// Eine Seite eines Listings (höchstens 1.000 Einträge bei S3).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPage {
    pub objects: Vec<ObjectEntry>,
    /// Gemeinsame Präfixe ("Ordner") bei gesetztem Delimiter
    pub prefixes: Vec<String>,
    /// Token für die nächste Seite, `None` auf der letzten Seite
    pub next_token: Option<String>,
}

impl ListPage {
    #[must_use]
    pub fn entry_count(&self) -> usize {
        self.objects.len() + self.prefixes.len()
    }
}

/// Parameter für `ListObjectsV2`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListRequest {
    pub bucket: String,
    pub prefix: String,
    pub delimiter: Option<String>,
    pub continuation_token: Option<String>,
    pub max_keys: Option<u32>,
}

impl ListRequest {
    /// Listing eines "Ordners": Präfix mit `/` als Delimiter.
    #[must_use]
    pub fn folder(bucket: &str, prefix: &str) -> Self {
        Self {
            bucket: bucket.to_owned(),
            prefix: prefix.to_owned(),
            delimiter: Some("/".to_owned()),
            continuation_token: None,
            max_keys: None,
        }
    }

    /// Rekursives Listing aller Keys unter einem Präfix.
    #[must_use]
    pub fn recursive(bucket: &str, prefix: &str) -> Self {
        Self {
            delimiter: None,
            ..Self::folder(bucket, prefix)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_and_recursive_requests_differ_only_in_delimiter() {
        let folder = ListRequest::folder("b", "p/");
        assert_eq!(folder.delimiter.as_deref(), Some("/"));
        let recursive = ListRequest::recursive("b", "p/");
        assert_eq!(recursive.delimiter, None);
        assert_eq!(recursive.prefix, "p/");
    }

    #[test]
    fn counts_objects_and_prefixes() {
        let page = ListPage {
            objects: vec![ObjectEntry {
                key: "a".into(),
                size: 1,
                last_modified_ms: None,
                etag: None,
                storage_class: None,
            }],
            prefixes: vec!["d/".into(), "e/".into()],
            next_token: None,
        };
        assert_eq!(page.entry_count(), 3);
    }

    #[test]
    fn serializes_camel_case_for_the_frontend() {
        let json = serde_json::to_string(&BucketInfo {
            name: "b".into(),
            created_ms: Some(1),
        })
        .unwrap();
        assert_eq!(json, r#"{"name":"b","createdMs":1}"#);
    }
}
