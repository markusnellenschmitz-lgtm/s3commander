//! Planung von Transfers in Teilen.
//!
//! Uploads: einzelner PUT oder Multipart mit passender Teilgröße. Downloads: ein GET oder
//! parallele Range-Requests; dafür gelten die Multipart-Grenzen nicht.
//!
//! Grenzen laut S3-Spezifikation: Teile 5 MiB bis 5 GiB (der letzte darf kleiner sein),
//! höchstens 10.000 Teile, Objekte bis 5 TiB, einzelner PUT bis 5 GiB.
//! Ist die gewünschte Teilgröße für die Datei zu klein, wird sie automatisch erhöht.

use super::error::StoreError;
use serde::Serialize;

pub const MIB: u64 = 1024 * 1024;
pub const MIN_PART_SIZE: u64 = 5 * MIB;
pub const MAX_PART_SIZE: u64 = 5 * 1024 * MIB;
pub const MAX_PARTS: u64 = 10_000;
pub const MAX_OBJECT_SIZE: u64 = 5 * 1024 * 1024 * MIB;
pub const MAX_SINGLE_PUT_SIZE: u64 = MAX_PART_SIZE;
/// Standard laut Einstellungen › Transfers.
pub const DEFAULT_PART_SIZE: u64 = 16 * MIB;
pub const DEFAULT_MULTIPART_THRESHOLD: u64 = 64 * MIB;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PartPlan {
    Single,
    #[serde(rename_all = "camelCase")]
    Multipart {
        part_size: u64,
        part_count: u64,
    },
}

impl PartPlan {
    /// Plant den Upload einer Datei der Größe `size`.
    ///
    /// # Errors
    ///
    /// `InvalidConfig`, wenn die Datei größer als 5 TiB ist.
    pub fn for_upload(size: u64, preferred_part_size: u64, multipart_threshold: u64) -> Result<Self, StoreError> {
        if size > MAX_OBJECT_SIZE {
            return Err(StoreError::InvalidConfig(
                "Objekte dürfen höchstens 5 TiB groß sein".into(),
            ));
        }
        if size < multipart_threshold && size <= MAX_SINGLE_PUT_SIZE {
            return Ok(Self::Single);
        }
        let part_size = part_size_for(size, preferred_part_size);
        Ok(Self::Multipart {
            part_size,
            part_count: size.div_ceil(part_size).max(1),
        })
    }

    /// Plant den Download eines Objekts der Größe `size`: unter der Schwelle ein GET,
    /// sonst Range-Requests mit der gewünschten Teilgröße.
    #[must_use]
    pub fn for_download(size: u64, part_size: u64, multipart_threshold: u64) -> Self {
        if size < multipart_threshold {
            return Self::Single;
        }
        let part_size = part_size.max(1);
        Self::Multipart {
            part_size,
            part_count: size.div_ceil(part_size).max(1),
        }
    }

    /// Anzahl der Teile.
    #[must_use]
    pub fn part_count(&self) -> u64 {
        match *self {
            Self::Single => 1,
            Self::Multipart { part_count, .. } => part_count,
        }
    }

    /// Byte-Bereich `(offset, length)` des Teils `index` (0-basiert).
    #[must_use]
    pub fn part_range(&self, size: u64, index: u64) -> Option<(u64, u64)> {
        match *self {
            Self::Single => (index == 0).then_some((0, size)),
            Self::Multipart { part_size, part_count } => (index < part_count).then(|| {
                let offset = index * part_size;
                (offset, part_size.min(size - offset))
            }),
        }
    }
}

/// Kleinste erlaubte Teilgröße, die die Datei in höchstens 10.000 Teile zerlegt,
/// auf volle MiB aufgerundet und nie kleiner als die Wunschgröße.
fn part_size_for(size: u64, preferred: u64) -> u64 {
    let needed = size.div_ceil(MAX_PARTS).div_ceil(MIB) * MIB;
    preferred.max(needed).clamp(MIN_PART_SIZE, MAX_PART_SIZE)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1024 * MIB;

    fn plan(size: u64) -> PartPlan {
        PartPlan::for_upload(size, DEFAULT_PART_SIZE, DEFAULT_MULTIPART_THRESHOLD).unwrap()
    }

    #[test]
    fn small_files_use_a_single_put() {
        assert_eq!(plan(0), PartPlan::Single);
        assert_eq!(plan(16 * MIB), PartPlan::Single);
        assert_eq!(plan(DEFAULT_MULTIPART_THRESHOLD - 1), PartPlan::Single);
    }

    #[test]
    fn large_files_use_the_preferred_part_size() {
        // 4,74 GiB aus dem Design: mit 16 MiB-Teilen 304 Teile.
        let size = 5_089_471_232;
        assert_eq!(
            plan(size),
            PartPlan::Multipart {
                part_size: 16 * MIB,
                part_count: 304
            }
        );
    }

    #[test]
    fn part_size_grows_beyond_10000_parts() {
        // 156,25 GiB ist die Grenze für 16 MiB-Teile; darüber wächst die Teilgröße.
        assert_eq!(
            plan(160_000 * MIB),
            PartPlan::Multipart {
                part_size: 16 * MIB,
                part_count: 10_000
            }
        );
        let PartPlan::Multipart { part_size, part_count } = plan(1024 * GIB) else {
            panic!("Multipart erwartet")
        };
        assert_eq!(part_size, 105 * MIB);
        assert!(part_count <= MAX_PARTS);
    }

    #[test]
    fn respects_part_size_limits() {
        let tiny = PartPlan::for_upload(100 * MIB, MIB, 0).unwrap();
        assert_eq!(
            tiny,
            PartPlan::Multipart {
                part_size: MIN_PART_SIZE,
                part_count: 20
            }
        );
        let huge = PartPlan::for_upload(MAX_OBJECT_SIZE, DEFAULT_PART_SIZE, 0).unwrap();
        let PartPlan::Multipart { part_size, part_count } = huge else {
            panic!("Multipart erwartet")
        };
        assert!(part_size <= MAX_PART_SIZE && part_count <= MAX_PARTS);
    }

    #[test]
    fn files_over_5_gib_never_use_a_single_put() {
        let plan = PartPlan::for_upload(MAX_SINGLE_PUT_SIZE + 1, DEFAULT_PART_SIZE, u64::MAX).unwrap();
        assert!(matches!(plan, PartPlan::Multipart { .. }));
    }

    #[test]
    fn rejects_objects_over_5_tib() {
        assert!(PartPlan::for_upload(MAX_OBJECT_SIZE + 1, DEFAULT_PART_SIZE, 0).is_err());
    }

    #[test]
    fn computes_part_ranges_including_the_short_last_part() {
        let size = 40 * MIB + 3;
        let plan = PartPlan::for_upload(size, DEFAULT_PART_SIZE, 0).unwrap();
        assert_eq!(plan.part_range(size, 0), Some((0, 16 * MIB)));
        assert_eq!(plan.part_range(size, 2), Some((32 * MIB, 8 * MIB + 3)));
        assert_eq!(plan.part_range(size, 3), None);
        assert_eq!(PartPlan::Single.part_range(10, 0), Some((0, 10)));
        assert_eq!(PartPlan::Single.part_range(10, 1), None);
    }

    #[test]
    fn downloads_use_range_requests_above_the_threshold_without_part_limits() {
        assert_eq!(
            PartPlan::for_download(10, DEFAULT_PART_SIZE, DEFAULT_MULTIPART_THRESHOLD),
            PartPlan::Single
        );
        assert_eq!(PartPlan::for_download(0, DEFAULT_PART_SIZE, 0).part_count(), 1);
        let plan = PartPlan::for_download(200_000 * MIB, DEFAULT_PART_SIZE, DEFAULT_MULTIPART_THRESHOLD);
        assert_eq!(
            plan.part_count(),
            12_500,
            "mehr als 10.000 Teile sind beim Download erlaubt"
        );
        assert_eq!(plan.part_range(200_000 * MIB, 1), Some((16 * MIB, 16 * MIB)));
        assert_eq!(
            PartPlan::for_download(3, 0, 0).part_count(),
            3,
            "Teilgröße mindestens 1 Byte"
        );
        assert_eq!(PartPlan::Single.part_count(), 1);
    }

    #[test]
    fn serializes_for_the_frontend() {
        let json = serde_json::to_string(&PartPlan::Multipart {
            part_size: 1,
            part_count: 2,
        })
        .unwrap();
        assert_eq!(json, r#"{"kind":"multipart","partSize":1,"partCount":2}"#);
    }
}
