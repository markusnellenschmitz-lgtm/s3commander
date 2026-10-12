//! Link für den Teilen-Dialog von Windows: Titel und Adresse eines vorsignierten Links.

/// Titel, wenn die Oberfläche keinen mitgibt.
const FALLBACK_TITLE: &str = "Link";

/// Ein geprüfter Link, den der Teilen-Dialog weitergibt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedLink {
    title: String,
    url: String,
}

impl SharedLink {
    /// Prüft die Adresse und bereinigt den Titel.
    ///
    /// # Errors
    /// `InvalidLink`, wenn die Adresse keine absolute HTTP(S)-Adresse mit Host ist.
    pub fn new(title: &str, url: &str) -> Result<Self, ShareError> {
        let url = url.trim();
        if !has_web_host(url) {
            return Err(ShareError::InvalidLink(url.to_owned()));
        }
        let title = title.trim();
        Ok(Self {
            title: if title.is_empty() { FALLBACK_TITLE } else { title }.to_owned(),
            url: url.to_owned(),
        })
    }

    #[must_use]
    pub fn title(&self) -> &str {
        &self.title
    }

    #[must_use]
    pub fn url(&self) -> &str {
        &self.url
    }
}

fn has_web_host(url: &str) -> bool {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"));
    rest.is_some_and(|rest| {
        let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
        !host.is_empty() && !url.chars().any(char::is_whitespace)
    })
}

/// Fehler beim Teilen eines Links.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ShareError {
    #[error("Ungültiger Link zum Teilen: {0}")]
    InvalidLink(String),
    #[error("Der Teilen-Dialog von Windows ließ sich nicht öffnen: {0}")]
    Platform(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_web_links_and_cleans_the_title() {
        let link = SharedLink::new(
            "  bericht.pdf ",
            " https://b.s3.amazonaws.com/bericht.pdf?X-Amz-Expires=3600 ",
        )
        .unwrap();
        assert_eq!(link.title(), "bericht.pdf");
        assert_eq!(link.url(), "https://b.s3.amazonaws.com/bericht.pdf?X-Amz-Expires=3600");
        assert_eq!(SharedLink::new(" ", "http://minio:9000/b/k").unwrap().title(), "Link");
    }

    #[test]
    fn rejects_everything_but_absolute_web_links() {
        for url in [
            "",
            "ftp://host/x",
            "https://",
            "https:///pfad",
            "https://host/mit leerzeichen",
            "datei.txt",
        ] {
            assert_eq!(
                SharedLink::new("x", url),
                Err(ShareError::InvalidLink(url.to_owned())),
                "{url}"
            );
        }
    }

    #[test]
    fn explains_errors() {
        assert_eq!(
            ShareError::Platform("E_FAIL".into()).to_string(),
            "Der Teilen-Dialog von Windows ließ sich nicht öffnen: E_FAIL"
        );
    }
}
