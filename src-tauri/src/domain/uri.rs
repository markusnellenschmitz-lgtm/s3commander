//! URI-Kodierung nach den Regeln von AWS `SigV4` (RFC 3986, nur "unreserved" bleibt stehen).
//! Dieselben Funktionen bauen die Request-URL und den kanonischen Request, damit beide
//! garantiert übereinstimmen.

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};

/// Alles außer `A-Z a-z 0-9 - _ . ~` wird kodiert.
const STRICT: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'~');
/// Wie `STRICT`, aber `/` bleibt als Pfadtrenner stehen.
const PATH: &AsciiSet = &STRICT.remove(b'/');

/// Kodiert einen Wert für Query-Parameter oder einzelne Segmente.
#[must_use]
pub fn encode_strict(value: &str) -> String {
    utf8_percent_encode(value, STRICT).to_string()
}

/// Kodiert einen Objekt-Key als Pfad; `/` bleibt erhalten.
#[must_use]
pub fn encode_path(value: &str) -> String {
    utf8_percent_encode(value, PATH).to_string()
}

/// Dekodiert Prozent-Kodierung. `plus_is_space` für S3-Listings mit `encoding-type=url`,
/// die Leerzeichen als `+` liefern.
#[must_use]
pub fn decode(value: &str, plus_is_space: bool) -> String {
    let value = if plus_is_space {
        value.replace('+', " ")
    } else {
        value.to_owned()
    };
    percent_decode_str(&value).decode_utf8_lossy().into_owned()
}

/// Kanonischer Query-String: Paare kodiert und nach Schlüssel, dann Wert sortiert.
#[must_use]
pub fn canonical_query<K: AsRef<str>, V: AsRef<str>>(pairs: &[(K, V)]) -> String {
    let mut encoded: Vec<(String, String)> = pairs
        .iter()
        .map(|(k, v)| (encode_strict(k.as_ref()), encode_strict(v.as_ref())))
        .collect();
    encoded.sort();
    encoded
        .into_iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&")
}

/// Zerlegt einen rohen Query-String in dekodierte Paare (`+` bleibt ein Plus).
#[must_use]
pub fn parse_query(raw: &str) -> Vec<(String, String)> {
    raw.split('&')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let (k, v) = part.split_once('=').unwrap_or((part, ""));
            (decode(k, false), decode(v, false))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_encoding_keeps_only_unreserved() {
        assert_eq!(encode_strict("a-b_c.d~e"), "a-b_c.d~e");
        assert_eq!(encode_strict("a b/c+d=e&ä"), "a%20b%2Fc%2Bd%3De%26%C3%A4");
    }

    #[test]
    fn path_encoding_keeps_slashes() {
        assert_eq!(encode_path("backups/2026/db full.tar"), "backups/2026/db%20full.tar");
    }

    #[test]
    fn decodes_with_and_without_plus_as_space() {
        assert_eq!(decode("a+b%2Bc%20d", true), "a b+c d");
        assert_eq!(decode("a+b", false), "a+b");
    }

    #[test]
    fn builds_sorted_canonical_query() {
        let q = canonical_query(&[("prefix", "a b/"), ("list-type", "2"), ("delimiter", "/")]);
        assert_eq!(q, "delimiter=%2F&list-type=2&prefix=a%20b%2F");
    }

    #[test]
    fn parses_raw_queries() {
        assert_eq!(
            parse_query("max-keys=2&prefix=J&flag&&x=a%2Bb+c"),
            vec![
                ("max-keys".into(), "2".into()),
                ("prefix".into(), "J".into()),
                ("flag".into(), String::new()),
                ("x".into(), "a+b+c".into()),
            ]
        );
    }
}
