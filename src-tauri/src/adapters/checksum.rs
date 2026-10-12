//! Prüfsummen für Uploads und Downloads.
//!
//! Uploads: `x-amz-checksum-crc32c` bei Anbietern, die CRC32C können, sonst `Content-MD5`. Ein
//! verfälschter Teil wird vom Dienst abgelehnt (`BadDigest`, `InvalidRequest`) und wiederholt.
//! Downloads: MD5 der fertigen Datei als Hex, zum Vergleich mit einem einfachen `ETag`.

use crate::domain::error::StoreError;
use crate::domain::transfer::FileRange;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use md5::{Digest as _, Md5};
use std::fmt::Write as _;
use std::io::SeekFrom;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

/// Kopfzeile, mit der beim Start eines Multipart-Uploads CRC32C angemeldet wird.
pub const CHECKSUM_ALGORITHM_HEADER: (&str, &str) = ("x-amz-checksum-algorithm", "CRC32C");

/// Lesepuffer beim Prüfen von Dateien.
const READ_CHUNK: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DigestKind {
    Crc32c,
    Md5,
}

/// Fertige Prüfsumme.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Digest {
    Crc32c(u32),
    Md5([u8; 16]),
}

impl Digest {
    /// Base64 wie von S3 erwartet (CRC32C als 4 Bytes Big Endian).
    #[must_use]
    pub fn base64(&self) -> String {
        match self {
            Self::Crc32c(crc) => BASE64.encode(crc.to_be_bytes()),
            Self::Md5(md5) => BASE64.encode(md5),
        }
    }

    /// Kleinbuchstaben-Hex, wie in einem einfachen `ETag`.
    #[must_use]
    pub fn hex(&self) -> String {
        let bytes: Vec<u8> = match self {
            Self::Crc32c(crc) => crc.to_be_bytes().to_vec(),
            Self::Md5(md5) => md5.to_vec(),
        };
        bytes.iter().fold(String::new(), |mut out, b| {
            // Schreiben in einen String kann nicht fehlschlagen.
            let _ = write!(out, "{b:02x}");
            out
        })
    }

    /// Kopfzeile der Anfrage.
    #[must_use]
    pub fn header(&self) -> (String, String) {
        let name = match self {
            Self::Crc32c(_) => "x-amz-checksum-crc32c",
            Self::Md5(_) => "content-md5",
        };
        (name.to_owned(), self.base64())
    }

    /// Prüfsumme des Teils für `CompleteMultipartUpload`; nur bei CRC32C.
    #[must_use]
    pub fn crc32c(&self) -> Option<String> {
        matches!(self, Self::Crc32c(_)).then(|| self.base64())
    }
}

/// Rechnet eine Prüfsumme stückweise, damit große Teile nie ganz im Speicher liegen.
struct Hasher {
    kind: DigestKind,
    crc: u32,
    md5: Md5,
}

impl Hasher {
    fn new(kind: DigestKind) -> Self {
        Self {
            kind,
            crc: 0,
            md5: Md5::new(),
        }
    }

    fn update(&mut self, bytes: &[u8]) {
        match self.kind {
            DigestKind::Crc32c => self.crc = crc32c::crc32c_append(self.crc, bytes),
            DigestKind::Md5 => self.md5.update(bytes),
        }
    }

    fn finish(self) -> Digest {
        match self.kind {
            DigestKind::Crc32c => Digest::Crc32c(self.crc),
            DigestKind::Md5 => Digest::Md5(self.md5.finalize().into()),
        }
    }
}

#[must_use]
pub fn digest_bytes(kind: DigestKind, bytes: &[u8]) -> Digest {
    let mut hasher = Hasher::new(kind);
    hasher.update(bytes);
    hasher.finish()
}

/// Prüfsumme eines Bereichs einer lokalen Datei.
///
/// # Errors
/// `LocalFile`, wenn die Datei nicht gelesen werden kann oder kürzer ist als der Bereich.
pub async fn digest_file(kind: DigestKind, range: &FileRange) -> Result<Digest, StoreError> {
    let local_error = |e: std::io::Error| StoreError::LocalFile(format!("{}: {e}", range.path.display()));
    let mut file = tokio::fs::File::open(&range.path).await.map_err(local_error)?;
    file.seek(SeekFrom::Start(range.offset)).await.map_err(local_error)?;
    let mut hasher = Hasher::new(kind);
    let mut buffer = vec![0; READ_CHUNK];
    let mut left = range.length;
    while left > 0 {
        let wanted = usize::try_from(left).map_or(READ_CHUNK, |left| left.min(READ_CHUNK));
        let read = file.read(&mut buffer[..wanted]).await.map_err(local_error)?;
        if read == 0 {
            return Err(StoreError::LocalFile(format!(
                "{}: Datei ist kürzer als erwartet",
                range.path.display()
            )));
        }
        hasher.update(&buffer[..read]);
        left -= u64::try_from(read).unwrap_or(left);
    }
    Ok(hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_aws_style_checksums() {
        // Referenzwerte: CRC32C("123456789") = 0xE3069283, MD5("") = d41d8cd98f00b204e9800998ecf8427e.
        let crc = digest_bytes(DigestKind::Crc32c, b"123456789");
        assert_eq!((crc.base64().as_str(), crc.hex().as_str()), ("4waSgw==", "e3069283"));
        let md5 = digest_bytes(DigestKind::Md5, b"");
        assert_eq!(md5.base64(), "1B2M2Y8AsgTpgAmY7PhCfg==");
        assert_eq!(md5.hex(), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(crc.header(), ("x-amz-checksum-crc32c".into(), "4waSgw==".into()));
        assert_eq!(crc.crc32c().as_deref(), Some("4waSgw=="));
        assert_eq!((md5.header().0.as_str(), md5.crc32c()), ("content-md5", None));
    }

    #[tokio::test]
    async fn digests_file_ranges_in_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("teil.bin");
        let data: Vec<u8> = (0..700_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &data).unwrap();
        let range = FileRange {
            path: path.clone(),
            offset: 1000,
            length: 600_000,
        };
        for kind in [DigestKind::Crc32c, DigestKind::Md5] {
            assert_eq!(
                digest_file(kind, &range).await.unwrap(),
                digest_bytes(kind, &data[1000..601_000])
            );
        }
        let too_long = FileRange {
            length: 800_000,
            ..range
        };
        assert!(matches!(
            digest_file(DigestKind::Md5, &too_long).await,
            Err(StoreError::LocalFile(_))
        ));
    }
}
