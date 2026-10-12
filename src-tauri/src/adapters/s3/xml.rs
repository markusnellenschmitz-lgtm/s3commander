//! Parsen der XML-Antworten von S3 (`ListBuckets`, `ListObjectsV2`, Fehler).

use crate::domain::deletion::DeleteFailure;
use crate::domain::details::{AclGrant, ObjectAcl, ObjectTag, ObjectVersion};
use crate::domain::error::{ServiceError, StoreError};
use crate::domain::object::{BucketInfo, ListPage, ObjectEntry};
use crate::domain::timestamp::unix_ms;
use crate::domain::transfer::{CompletedPart, UploadedPart};
use crate::domain::uri::decode;
use serde::Deserialize;
use std::fmt::Write as _;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ListAllMyBucketsResult {
    #[serde(default)]
    buckets: BucketList,
}

#[derive(Deserialize, Default)]
struct BucketList {
    #[serde(rename = "Bucket", default)]
    items: Vec<BucketXml>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct BucketXml {
    name: String,
    creation_date: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ListBucketResult {
    #[serde(default)]
    contents: Vec<ContentsXml>,
    #[serde(default)]
    common_prefixes: Vec<PrefixXml>,
    #[serde(default)]
    is_truncated: bool,
    next_continuation_token: Option<String>,
    encoding_type: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ContentsXml {
    key: String,
    last_modified: Option<String>,
    #[serde(rename = "ETag")]
    etag: Option<String>,
    #[serde(default)]
    size: u64,
    storage_class: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct PrefixXml {
    prefix: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ErrorXml {
    code: String,
    #[serde(default)]
    message: String,
    request_id: Option<String>,
}

fn invalid(what: &str, error: &impl std::fmt::Display) -> StoreError {
    StoreError::InvalidResponse(format!("{what}: {error}"))
}

fn parse_time_ms(value: Option<&str>) -> Option<i64> {
    unix_ms(OffsetDateTime::parse(value?, &Rfc3339).ok()?)
}

/// # Errors
/// `InvalidResponse` bei unlesbarem XML.
pub fn parse_list_buckets(body: &str) -> Result<Vec<BucketInfo>, StoreError> {
    let result: ListAllMyBucketsResult = quick_xml::de::from_str(body).map_err(|e| invalid("ListBuckets", &e))?;
    Ok(result
        .buckets
        .items
        .into_iter()
        .map(|b| BucketInfo {
            created_ms: parse_time_ms(b.creation_date.as_deref()),
            name: b.name,
        })
        .collect())
}

/// # Errors
/// `InvalidResponse` bei unlesbarem XML oder fehlendem Fortsetzungs-Token einer
/// abgeschnittenen Seite.
pub fn parse_list_objects(body: &str) -> Result<ListPage, StoreError> {
    let result: ListBucketResult = quick_xml::de::from_str(body).map_err(|e| invalid("ListObjectsV2", &e))?;
    let url_encoded = result.encoding_type.as_deref() == Some("url");
    let text = |value: String| if url_encoded { decode(&value, true) } else { value };
    if result.is_truncated && result.next_continuation_token.is_none() {
        return Err(StoreError::InvalidResponse(
            "Seite abgeschnitten, aber ohne Fortsetzungs-Token".into(),
        ));
    }
    Ok(ListPage {
        objects: result
            .contents
            .into_iter()
            .map(|c| ObjectEntry {
                last_modified_ms: parse_time_ms(c.last_modified.as_deref()),
                key: text(c.key),
                size: c.size,
                etag: c.etag,
                storage_class: c.storage_class,
            })
            .collect(),
        prefixes: result.common_prefixes.into_iter().map(|p| text(p.prefix)).collect(),
        next_token: result.next_continuation_token.filter(|_| result.is_truncated),
    })
}

/// Liest eine S3-Fehlerantwort. Fehlt ein lesbarer Körper (z. B. bei HEAD), entsteht ein
/// Fehler aus HTTP-Status und Request-ID.
#[must_use]
pub fn parse_error(status: u16, body: &str, request_id_header: Option<String>) -> ServiceError {
    match quick_xml::de::from_str::<ErrorXml>(body) {
        Ok(e) => ServiceError {
            code: e.code,
            message: e.message,
            http_status: status,
            request_id: e.request_id.or(request_id_header),
        },
        Err(_) => ServiceError {
            code: format!("Http{status}"),
            message: status_text(status).to_owned(),
            http_status: status,
            request_id: request_id_header,
        },
    }
}

fn status_text(status: u16) -> &'static str {
    match status {
        301 | 307 => "Falscher Endpunkt oder falsche Region für diesen Bucket",
        400 => "Ungültige Anfrage",
        403 => "Zugriff verweigert",
        404 => "Nicht gefunden",
        500..=599 => "Fehler beim Anbieter",
        _ => "Unerwartete Antwort",
    }
}

// ---------- Multipart-Upload ----------

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct InitiateMultipartUploadResult {
    upload_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ListPartsResult {
    #[serde(default, rename = "Part")]
    parts: Vec<PartXml>,
    #[serde(default)]
    is_truncated: bool,
    next_part_number_marker: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct PartXml {
    part_number: u32,
    #[serde(rename = "ETag")]
    etag: String,
    size: u64,
    #[serde(rename = "ChecksumCRC32C")]
    checksum_crc32c: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct CompleteMultipartUploadResult {
    #[serde(rename = "ETag")]
    etag: String,
}

/// Eine Seite von `ListParts`.
#[derive(Debug, PartialEq, Eq)]
pub struct PartsPage {
    pub parts: Vec<UploadedPart>,
    /// Marker für die nächste Seite, `None` auf der letzten.
    pub next_marker: Option<String>,
}

/// # Errors
/// `InvalidResponse` bei unlesbarem XML.
pub fn parse_initiate_multipart(body: &str) -> Result<String, StoreError> {
    let result: InitiateMultipartUploadResult =
        quick_xml::de::from_str(body).map_err(|e| invalid("CreateMultipartUpload", &e))?;
    Ok(result.upload_id)
}

/// # Errors
/// `InvalidResponse` bei unlesbarem XML.
pub fn parse_list_parts(body: &str) -> Result<PartsPage, StoreError> {
    let result: ListPartsResult = quick_xml::de::from_str(body).map_err(|e| invalid("ListParts", &e))?;
    Ok(PartsPage {
        parts: result
            .parts
            .into_iter()
            .map(|p| UploadedPart {
                part_number: p.part_number,
                etag: p.etag,
                size: p.size,
                checksum_crc32c: p.checksum_crc32c,
            })
            .collect(),
        next_marker: result.next_part_number_marker.filter(|_| result.is_truncated),
    })
}

/// S3 kann `CompleteMultipartUpload` mit HTTP 200 beantworten und trotzdem einen Fehler im
/// Körper liefern (z. B. bei einer Zeitüberschreitung während des Zusammenfügens).
///
/// # Errors
/// `Service` bei einem Fehlerdokument, `InvalidResponse` bei unlesbarem XML.
pub fn parse_complete_multipart(body: &str) -> Result<String, StoreError> {
    if body.contains("<Error>") {
        return Err(StoreError::Service(parse_error(200, body, None)));
    }
    let result: CompleteMultipartUploadResult =
        quick_xml::de::from_str(body).map_err(|e| invalid("CompleteMultipartUpload", &e))?;
    Ok(result.etag)
}

/// Körper für `CompleteMultipartUpload`; Teile müssen aufsteigend sortiert sein.
#[must_use]
pub fn build_complete_multipart(parts: &[CompletedPart]) -> String {
    let mut body = String::from("<CompleteMultipartUpload>");
    for p in parts {
        // Schreiben in einen String kann nicht fehlschlagen.
        let _ = write!(
            body,
            "<Part><PartNumber>{}</PartNumber><ETag>{}</ETag>",
            p.part_number,
            quick_xml::escape::escape(&p.etag)
        );
        if let Some(checksum) = &p.checksum_crc32c {
            let _ = write!(
                body,
                "<ChecksumCRC32C>{}</ChecksumCRC32C>",
                quick_xml::escape::escape(checksum)
            );
        }
        body.push_str("</Part>");
    }
    body.push_str("</CompleteMultipartUpload>");
    body
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct DeleteResult {
    #[serde(default, rename = "Error")]
    errors: Vec<DeleteErrorXml>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct DeleteErrorXml {
    key: String,
    code: String,
    #[serde(default)]
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct VersioningConfiguration {
    status: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct CopyPartResult {
    #[serde(rename = "ETag")]
    etag: String,
}

/// Prüft die Antwort von `CopyObject`. Auch ein HTTP 200 kann einen Fehler tragen.
///
/// # Errors
/// `Service`, wenn statt `CopyObjectResult` ein Fehler kommt.
pub fn parse_copy_object(body: &str) -> Result<(), StoreError> {
    if body.contains("<CopyObjectResult") {
        Ok(())
    } else {
        Err(StoreError::Service(parse_error(200, body, None)))
    }
}

/// `ETag` aus der Antwort von `UploadPartCopy`.
///
/// # Errors
/// `Service` bei einem Fehler im HTTP 200, `InvalidResponse` bei unlesbarem XML.
pub fn parse_copy_part(body: &str) -> Result<String, StoreError> {
    if !body.contains("<CopyPartResult") {
        return Err(StoreError::Service(parse_error(200, body, None)));
    }
    let result: CopyPartResult = quick_xml::de::from_str(body).map_err(|e| invalid("CopyPartResult", &e))?;
    Ok(result.etag)
}

/// Körper für `DeleteObjects`. Im Modus `Quiet` meldet der Dienst nur Fehlschläge.
#[must_use]
pub fn build_delete_objects(keys: &[String]) -> String {
    let mut body = String::from("<Delete><Quiet>true</Quiet>");
    for key in keys {
        // Schreiben in einen String kann nicht fehlschlagen.
        let _ = write!(body, "<Object><Key>{}</Key></Object>", quick_xml::escape::escape(key));
    }
    body.push_str("</Delete>");
    body
}

/// Keys, die nicht gelöscht werden konnten. Auch ein HTTP 200 kann einen Gesamtfehler tragen;
/// den erkennt man am Wurzelelement `Error` statt `DeleteResult`.
///
/// # Errors
/// `Service` bei einem Gesamtfehler, `InvalidResponse` bei unlesbarem XML.
pub fn parse_delete_result(body: &str) -> Result<Vec<DeleteFailure>, StoreError> {
    if !body.contains("<DeleteResult") {
        return Err(StoreError::Service(parse_error(200, body, None)));
    }
    let result: DeleteResult = quick_xml::de::from_str(body).map_err(|e| invalid("DeleteResult", &e))?;
    Ok(result
        .errors
        .into_iter()
        .map(|e| DeleteFailure {
            key: e.key,
            code: e.code,
            message: e.message,
        })
        .collect())
}

/// `true`, wenn die Versionierung aktiv (`Enabled`) oder ausgesetzt (`Suspended`) ist; in beiden
/// Fällen kann es ältere Versionen geben.
///
/// # Errors
/// `InvalidResponse` bei unlesbarem XML.
pub fn parse_versioning(body: &str) -> Result<bool, StoreError> {
    let config: VersioningConfiguration =
        quick_xml::de::from_str(body).map_err(|e| invalid("VersioningConfiguration", &e))?;
    Ok(matches!(config.status.as_deref(), Some("Enabled" | "Suspended")))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase")]
struct Tagging {
    #[serde(default)]
    tag_set: TagSet,
}

#[derive(Deserialize, Default)]
struct TagSet {
    #[serde(default, rename = "Tag")]
    tags: Vec<TagXml>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct TagXml {
    key: String,
    #[serde(default)]
    value: String,
}

/// Tags aus der Antwort von `GetObjectTagging`.
///
/// # Errors
/// `InvalidResponse` bei unlesbarem XML.
pub fn parse_tagging(body: &str) -> Result<Vec<ObjectTag>, StoreError> {
    let tagging: Tagging = quick_xml::de::from_str(body).map_err(|e| invalid("Tagging", &e))?;
    Ok(tagging
        .tag_set
        .tags
        .into_iter()
        .map(|t| ObjectTag {
            key: t.key,
            value: t.value,
        })
        .collect())
}

/// Körper für `PutObjectTagging`.
#[must_use]
pub fn build_tagging(tags: &[ObjectTag]) -> String {
    let mut body = String::from("<Tagging><TagSet>");
    for tag in tags {
        // Schreiben in einen String kann nicht fehlschlagen.
        let _ = write!(
            body,
            "<Tag><Key>{}</Key><Value>{}</Value></Tag>",
            quick_xml::escape::escape(&tag.key),
            quick_xml::escape::escape(&tag.value)
        );
    }
    body.push_str("</TagSet></Tagging>");
    body
}

/// Eine Seite von `ListObjectVersions`: Einträge mit ihrem Key und Marker für die nächste Seite.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct VersionsPage {
    pub entries: Vec<(String, ObjectVersion)>,
    pub next_key_marker: Option<String>,
    pub next_version_marker: Option<String>,
}

/// Liest `ListVersionsResult`. Versionen und Delete Marker stehen dort gemischt; deshalb wird das
/// XML ereignisweise gelesen, damit ihre Reihenfolge erhalten bleibt.
///
/// # Errors
/// `InvalidResponse` bei unlesbarem XML.
pub fn parse_versions(body: &str) -> Result<VersionsPage, StoreError> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_str(body);
    let mut page = VersionsPage::default();
    let mut truncated = false;
    let mut current: Option<(bool, VersionFields)> = None;
    let mut text = String::new();
    loop {
        match reader.read_event().map_err(|e| invalid("ListVersionsResult", &e))? {
            Event::Start(start) => {
                let name = start.local_name();
                if let kind @ ("Version" | "DeleteMarker") = name.as_ref() {
                    current = Some((kind == "DeleteMarker", VersionFields::default()));
                }
                text.clear();
            }
            Event::Text(content) => text.push_str(&content.into_inner()),
            // Entitäten wie &amp; oder &#55; kommen als eigene Ereignisse.
            Event::GeneralRef(entity) => {
                let raw = format!("&{};", entity.into_inner());
                let resolved = quick_xml::escape::unescape(&raw).map_err(|e| invalid("ListVersionsResult", &e))?;
                text.push_str(&resolved);
            }
            Event::End(end) => {
                let name = end.local_name();
                let value = std::mem::take(&mut text);
                match (name.as_ref(), current.as_mut()) {
                    ("Version" | "DeleteMarker", _) => {
                        if let Some((is_delete_marker, fields)) = current.take() {
                            page.entries.push(fields.into_entry(is_delete_marker));
                        }
                    }
                    (field, Some((_, fields))) => fields.set(field, value),
                    ("IsTruncated", None) => truncated = value == "true",
                    ("NextKeyMarker", None) => page.next_key_marker = Some(value),
                    ("NextVersionIdMarker", None) => page.next_version_marker = Some(value),
                    _ => {}
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !truncated {
        page.next_key_marker = None;
        page.next_version_marker = None;
    }
    Ok(page)
}

#[derive(Default)]
struct VersionFields {
    key: String,
    version_id: String,
    is_latest: bool,
    last_modified: Option<String>,
    size: u64,
}

impl VersionFields {
    fn set(&mut self, field: &str, value: String) {
        match field {
            "Key" => self.key = value,
            "VersionId" => self.version_id = value,
            "IsLatest" => self.is_latest = value == "true",
            "LastModified" => self.last_modified = Some(value),
            "Size" => self.size = value.parse().unwrap_or(0),
            _ => {}
        }
    }

    fn into_entry(self, is_delete_marker: bool) -> (String, ObjectVersion) {
        let version = ObjectVersion {
            version_id: self.version_id,
            is_latest: self.is_latest,
            is_delete_marker,
            last_modified_ms: parse_time_ms(self.last_modified.as_deref()),
            size: self.size,
        };
        (self.key, version)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct AccessControlPolicy {
    owner: Option<GranteeXml>,
    #[serde(default)]
    access_control_list: AccessControlList,
}

#[derive(Deserialize, Default)]
struct AccessControlList {
    #[serde(default, rename = "Grant")]
    grants: Vec<GrantXml>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct GrantXml {
    grantee: GranteeXml,
    permission: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct GranteeXml {
    #[serde(rename = "ID")]
    id: Option<String>,
    display_name: Option<String>,
    #[serde(rename = "URI")]
    uri: Option<String>,
    email_address: Option<String>,
}

/// Gruppen, die ein Objekt öffentlich machen.
const PUBLIC_GROUPS: [&str; 2] = ["/global/AllUsers", "/global/AuthenticatedUsers"];

impl GranteeXml {
    fn label(self) -> (String, bool) {
        let is_public = self
            .uri
            .as_deref()
            .is_some_and(|uri| PUBLIC_GROUPS.iter().any(|group| uri.ends_with(group)));
        let label = self
            .display_name
            .or(self.email_address)
            .or_else(|| self.uri.map(|uri| uri.rsplit('/').next().unwrap_or(&uri).to_owned()))
            .or(self.id)
            .unwrap_or_default();
        (label, is_public)
    }
}

/// Eigentümer und Berechtigungen aus `GetObjectAcl`.
///
/// # Errors
/// `InvalidResponse` bei unlesbarem XML.
pub fn parse_acl(body: &str) -> Result<ObjectAcl, StoreError> {
    let policy: AccessControlPolicy = quick_xml::de::from_str(body).map_err(|e| invalid("AccessControlPolicy", &e))?;
    let grants = policy
        .access_control_list
        .grants
        .into_iter()
        .map(|grant| {
            let (grantee, is_public) = grant.grantee.label();
            AclGrant {
                grantee,
                is_public,
                permission: grant.permission,
            }
        })
        .collect();
    Ok(ObjectAcl {
        owner: policy.owner.map(|owner| owner.label().0),
        grants,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_builds_tagging() {
        let xml = "<Tagging><TagSet><Tag><Key>env</Key><Value>prod</Value></Tag><Tag><Key>leer</Key><Value></Value></Tag></TagSet></Tagging>";
        let tags = parse_tagging(xml).unwrap();
        assert_eq!(tags.len(), 2);
        assert_eq!(
            (tags[0].key.as_str(), tags[0].value.as_str(), tags[1].value.as_str()),
            ("env", "prod", "")
        );
        assert_eq!(parse_tagging("<Tagging><TagSet/></Tagging>").unwrap(), Vec::new());
        assert!(parse_tagging("<Tagging><TagSet><Tag>").is_err());
        let built = build_tagging(&[ObjectTag {
            key: "a&b".into(),
            value: "<x>".into(),
        }]);
        assert_eq!(
            built,
            "<Tagging><TagSet><Tag><Key>a&amp;b</Key><Value>&lt;x&gt;</Value></Tag></TagSet></Tagging>"
        );
    }

    #[test]
    fn parses_mixed_versions_and_delete_markers_in_order() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
            <ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
              <Name>b</Name><Prefix>a/x.bin</Prefix><IsTruncated>true</IsTruncated>
              <NextKeyMarker>a/x.bin</NextKeyMarker><NextVersionIdMarker>v0</NextVersionIdMarker>
              <Version><Key>a/x.bin</Key><VersionId>v3</VersionId><IsLatest>true</IsLatest>
                <LastModified>2026-10-11T03:14:52.000Z</LastModified><ETag>"e"</ETag><Size>5</Size></Version>
              <DeleteMarker><Key>a/x.bin</Key><VersionId>v2</VersionId><IsLatest>false</IsLatest>
                <LastModified>2026-10-10T18:22:00.000Z</LastModified></DeleteMarker>
              <Version><Key>a/x.bin.bak</Key><VersionId>v1</VersionId><IsLatest>true</IsLatest><Size>&#55;</Size></Version>
            </ListVersionsResult>"#;
        let page = parse_versions(xml).unwrap();
        let summary: Vec<_> = page
            .entries
            .iter()
            .map(|(key, v)| {
                (
                    key.as_str(),
                    v.version_id.as_str(),
                    v.is_latest,
                    v.is_delete_marker,
                    v.size,
                )
            })
            .collect();
        assert_eq!(
            summary,
            [
                ("a/x.bin", "v3", true, false, 5),
                ("a/x.bin", "v2", false, true, 0),
                ("a/x.bin.bak", "v1", true, false, 7),
            ]
        );
        assert_eq!(page.entries[0].1.last_modified_ms, Some(1_791_688_492_000));
        assert_eq!(page.next_key_marker.as_deref(), Some("a/x.bin"));
        assert_eq!(page.next_version_marker.as_deref(), Some("v0"));
        let last = parse_versions(
            "<ListVersionsResult><IsTruncated>false</IsTruncated><NextKeyMarker>x</NextKeyMarker></ListVersionsResult>",
        )
        .unwrap();
        assert_eq!(last, VersionsPage::default());
        assert!(parse_versions("<ListVersionsResult><Version>&unbekannt;</Version></ListVersionsResult>").is_err());
    }

    #[test]
    fn parses_acls_with_users_groups_and_public_access() {
        let xml = r#"<AccessControlPolicy><Owner><ID>abc</ID><DisplayName>ops</DisplayName></Owner>
            <AccessControlList>
              <Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>abc</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant>
              <Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Group"><URI>http://acs.amazonaws.com/groups/global/AllUsers</URI></Grantee><Permission>READ</Permission></Grant>
              <Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="AmazonCustomerByEmail"><EmailAddress>a@b.de</EmailAddress></Grantee><Permission>READ_ACP</Permission></Grant>
            </AccessControlList></AccessControlPolicy>"#;
        let acl = parse_acl(xml).unwrap();
        assert_eq!(acl.owner.as_deref(), Some("ops"));
        let grants: Vec<_> = acl
            .grants
            .iter()
            .map(|g| (g.grantee.as_str(), g.is_public, g.permission.as_str()))
            .collect();
        assert_eq!(
            grants,
            [
                ("abc", false, "FULL_CONTROL"),
                ("AllUsers", true, "READ"),
                ("a@b.de", false, "READ_ACP")
            ]
        );
        assert!(parse_acl("<AccessControlPolicy><AccessControlList><Grant>").is_err());
        assert_eq!(parse_acl("<AccessControlPolicy/>").unwrap(), ObjectAcl::default());
    }

    #[test]
    fn parses_copy_results_and_errors_in_successful_responses() {
        assert!(parse_copy_object("<CopyObjectResult><ETag>\"e\"</ETag></CopyObjectResult>").is_ok());
        let error = "<Error><Code>InternalError</Code><Message>später</Message></Error>";
        assert!(matches!(parse_copy_object(error), Err(StoreError::Service(_))));
        let part =
            "<CopyPartResult><LastModified>2026-10-11T00:00:00Z</LastModified><ETag>\"p1\"</ETag></CopyPartResult>";
        assert_eq!(parse_copy_part(part).unwrap(), "\"p1\"");
        assert!(matches!(parse_copy_part(error), Err(StoreError::Service(_))));
        assert!(matches!(
            parse_copy_part("<CopyPartResult>"),
            Err(StoreError::InvalidResponse(_))
        ));
    }

    #[test]
    fn builds_delete_bodies_with_escaped_keys() {
        let keys = ["a&b.txt".to_owned(), "ordner/<x>".to_owned()];
        assert_eq!(
            build_delete_objects(&keys),
            "<Delete><Quiet>true</Quiet><Object><Key>a&amp;b.txt</Key></Object>\
             <Object><Key>ordner/&lt;x&gt;</Key></Object></Delete>"
        );
    }

    #[test]
    fn parses_delete_results_and_whole_request_errors() {
        let ok =
            r#"<?xml version="1.0"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></DeleteResult>"#;
        assert_eq!(parse_delete_result(ok).unwrap(), Vec::new());
        let partial = "<DeleteResult><Deleted><Key>a</Key></Deleted>\
            <Error><Key>b</Key><Code>AccessDenied</Code><Message>Access Denied</Message></Error>\
            <Error><Key>c</Key><Code>InternalError</Code></Error></DeleteResult>";
        let failures = parse_delete_result(partial).unwrap();
        assert_eq!(failures.len(), 2);
        assert_eq!(
            failures[0],
            DeleteFailure {
                key: "b".into(),
                code: "AccessDenied".into(),
                message: "Access Denied".into()
            }
        );
        assert_eq!(failures[1].message, "");
        let whole = "<Error><Code>MalformedXML</Code><Message>kaputt</Message></Error>";
        let Err(StoreError::Service(error)) = parse_delete_result(whole) else {
            panic!("Gesamtfehler erwartet")
        };
        assert_eq!(error.code, "MalformedXML");
        assert!(matches!(
            parse_delete_result("<DeleteResult><Error>"),
            Err(StoreError::InvalidResponse(_))
        ));
    }

    #[test]
    fn parses_the_versioning_status() {
        let enabled = r#"<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>"#;
        assert!(parse_versioning(enabled).unwrap());
        assert!(
            parse_versioning("<VersioningConfiguration><Status>Suspended</Status></VersioningConfiguration>").unwrap()
        );
        assert!(!parse_versioning("<VersioningConfiguration/>").unwrap());
        assert!(parse_versioning("kein xml <").is_err());
    }

    #[test]
    fn parses_initiate_multipart_upload() {
        let xml = "<InitiateMultipartUploadResult><Bucket>b</Bucket><Key>k</Key><UploadId>VXBsb2FkIElE</UploadId></InitiateMultipartUploadResult>";
        assert_eq!(parse_initiate_multipart(xml).unwrap(), "VXBsb2FkIElE");
        assert!(parse_initiate_multipart("<x/>").is_err());
    }

    #[test]
    fn parses_list_parts_with_paging() {
        let xml = "<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>2</NextPartNumberMarker>\
                   <Part><PartNumber>1</PartNumber><ETag>\"a\"</ETag><Size>5242880</Size></Part>\
                                      <Part><PartNumber>2</PartNumber><ETag>\"b\"</ETag><Size>5242880</Size><ChecksumCRC32C>AAAAAA==</ChecksumCRC32C></Part></ListPartsResult>";
        let page = parse_list_parts(xml).unwrap();
        assert_eq!(page.parts.len(), 2);
        assert_eq!(
            page.parts[1],
            UploadedPart {
                part_number: 2,
                etag: "\"b\"".into(),
                size: 5_242_880,
                checksum_crc32c: Some("AAAAAA==".into()),
            }
        );
        assert_eq!(page.next_marker.as_deref(), Some("2"));
        let last = parse_list_parts("<ListPartsResult><IsTruncated>false</IsTruncated></ListPartsResult>").unwrap();
        assert_eq!(
            last,
            PartsPage {
                parts: vec![],
                next_marker: None
            }
        );
        assert!(parse_list_parts("kaputt").is_err());
    }

    #[test]
    fn parses_complete_results_and_errors_hidden_in_200() {
        let ok = "<CompleteMultipartUploadResult><Location>x</Location><ETag>\"abc-3\"</ETag></CompleteMultipartUploadResult>";
        assert_eq!(parse_complete_multipart(ok).unwrap(), "\"abc-3\"");
        let hidden = "<?xml version=\"1.0\"?><Error><Code>InternalError</Code><Message>retry</Message></Error>";
        let Err(StoreError::Service(e)) = parse_complete_multipart(hidden) else {
            panic!("Fehler erwartet")
        };
        assert_eq!((e.code.as_str(), e.http_status), ("InternalError", 200));
        assert!(parse_complete_multipart("<x/>").is_err());
    }

    #[test]
    fn builds_the_complete_body_with_escaped_etags() {
        let parts = [
            CompletedPart::new(1, "\"a\"".into()),
            CompletedPart {
                checksum_crc32c: Some("q+w=".into()),
                ..CompletedPart::new(2, "b&c".into())
            },
        ];
        assert_eq!(
            build_complete_multipart(&parts),
            "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;a&quot;</ETag></Part>\
             <Part><PartNumber>2</PartNumber><ETag>b&amp;c</ETag><ChecksumCRC32C>q+w=</ChecksumCRC32C></Part>\
             </CompleteMultipartUpload>"
        );
    }

    #[test]
    fn parses_bucket_lists() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Owner><ID>abc</ID><DisplayName>me</DisplayName></Owner>
  <Buckets>
    <Bucket><Name>prod-backups-eu</Name><CreationDate>2026-01-02T03:04:05.000Z</CreationDate></Bucket>
    <Bucket><Name>prod-media-eu</Name></Bucket>
  </Buckets>
</ListAllMyBucketsResult>"#;
        let buckets = parse_list_buckets(xml).unwrap();
        assert_eq!(buckets.len(), 2);
        assert_eq!(buckets[0].name, "prod-backups-eu");
        assert_eq!(buckets[0].created_ms, Some(1_767_323_045_000));
        assert_eq!(buckets[1].created_ms, None);
    }

    #[test]
    fn parses_empty_bucket_lists() {
        let none: Vec<BucketInfo> = Vec::new();
        assert_eq!(
            parse_list_buckets("<ListAllMyBucketsResult><Buckets/></ListAllMyBucketsResult>").unwrap(),
            none
        );
        assert_eq!(parse_list_buckets("<ListAllMyBucketsResult/>").unwrap(), none);
    }

    #[test]
    fn parses_object_pages_with_prefixes_and_token() {
        let xml = r#"<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>prod-backups-eu</Name><Prefix>backups/2026/10/</Prefix><KeyCount>3</KeyCount><MaxKeys>1000</MaxKeys>
  <Delimiter>/</Delimiter><IsTruncated>true</IsTruncated>
  <NextContinuationToken>1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=</NextContinuationToken>
  <Contents>
    <Key>backups/2026/10/db-full-20261011.tar.zst</Key>
    <LastModified>2026-10-11T03:14:52.000Z</LastModified>
    <ETag>"5e1b9a07c3d4f2e8a6b0c9d1e7f3a2b4-157"</ETag>
    <Size>5089471232</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
  <CommonPrefixes><Prefix>backups/2026/10/daily/</Prefix></CommonPrefixes>
  <CommonPrefixes><Prefix>backups/2026/10/wal/</Prefix></CommonPrefixes>
</ListBucketResult>"#;
        let page = parse_list_objects(xml).unwrap();
        assert_eq!(page.objects.len(), 1);
        let o = &page.objects[0];
        assert_eq!(o.key, "backups/2026/10/db-full-20261011.tar.zst");
        assert_eq!(o.size, 5_089_471_232);
        assert_eq!(o.etag.as_deref(), Some("\"5e1b9a07c3d4f2e8a6b0c9d1e7f3a2b4-157\""));
        assert_eq!(o.storage_class.as_deref(), Some("STANDARD"));
        assert!(o.last_modified_ms.is_some());
        assert_eq!(page.prefixes, ["backups/2026/10/daily/", "backups/2026/10/wal/"]);
        assert_eq!(
            page.next_token.as_deref(),
            Some("1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=")
        );
    }

    #[test]
    fn decodes_url_encoded_listings() {
        let xml = "<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated>\
                   <Contents><Key>a+b%2Bc%0A.txt</Key><Size>1</Size></Contents>\
                   <CommonPrefixes><Prefix>ordner+mit%2Fslash/</Prefix></CommonPrefixes></ListBucketResult>";
        let page = parse_list_objects(xml).unwrap();
        assert_eq!(page.objects[0].key, "a b+c\n.txt");
        assert_eq!(page.prefixes[0], "ordner mit/slash/");
    }

    #[test]
    fn ignores_tokens_on_the_last_page_and_handles_missing_fields() {
        let xml = "<ListBucketResult><IsTruncated>false</IsTruncated><NextContinuationToken>x</NextContinuationToken>\
                   <Contents><Key>k</Key></Contents></ListBucketResult>";
        let page = parse_list_objects(xml).unwrap();
        assert_eq!(page.next_token, None);
        assert_eq!(page.objects[0].size, 0);
        assert_eq!(page.objects[0].last_modified_ms, None);
    }

    #[test]
    fn rejects_truncated_pages_without_token_and_broken_xml() {
        let truncated = "<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>";
        assert!(matches!(
            parse_list_objects(truncated),
            Err(StoreError::InvalidResponse(_))
        ));
        assert!(matches!(
            parse_list_objects("<html>Proxy</html"),
            Err(StoreError::InvalidResponse(_))
        ));
        assert!(matches!(
            parse_list_buckets("kein xml"),
            Err(StoreError::InvalidResponse(_))
        ));
    }

    #[test]
    fn parses_error_documents() {
        let xml = "<Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match</Message>\
                   <RequestId>7XQ2M9K4PZ1R8T3B</RequestId></Error>";
        let e = parse_error(403, xml, Some("HEADER".into()));
        assert_eq!(e.code, "SignatureDoesNotMatch");
        assert_eq!(e.http_status, 403);
        assert_eq!(e.request_id.as_deref(), Some("7XQ2M9K4PZ1R8T3B"));
    }

    #[test]
    fn falls_back_to_status_and_header_without_body() {
        let e = parse_error(404, "", Some("REQ".into()));
        assert_eq!(e.code, "Http404");
        assert_eq!(e.message, "Nicht gefunden");
        assert_eq!(e.request_id.as_deref(), Some("REQ"));
        assert_eq!(
            parse_error(301, "", None).message,
            "Falscher Endpunkt oder falsche Region für diesen Bucket"
        );
        assert_eq!(parse_error(400, "", None).message, "Ungültige Anfrage");
        assert_eq!(parse_error(403, "", None).message, "Zugriff verweigert");
        assert_eq!(parse_error(503, "", None).message, "Fehler beim Anbieter");
        assert_eq!(parse_error(418, "", None).message, "Unerwartete Antwort");
    }

    #[test]
    fn error_documents_without_message_or_request_id_use_the_header() {
        let e = parse_error(500, "<Error><Code>InternalError</Code></Error>", Some("H".into()));
        assert_eq!(e.message, "");
        assert_eq!(e.request_id.as_deref(), Some("H"));
    }
}
