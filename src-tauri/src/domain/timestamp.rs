//! Zeitpunkte als Millisekunden seit Epoch, wie sie Oberfläche und Cache verwenden.

use time::OffsetDateTime;

/// Millisekunden seit Epoch; `None` außerhalb des `i64`-Bereichs.
#[must_use]
pub fn unix_ms(at: OffsetDateTime) -> Option<i64> {
    i64::try_from(at.unix_timestamp_nanos() / 1_000_000).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    #[test]
    fn converts_to_milliseconds_since_epoch() {
        assert_eq!(unix_ms(OffsetDateTime::UNIX_EPOCH), Some(0));
        assert_eq!(unix_ms(datetime!(2026-10-12 00:00:00.123 UTC)), Some(1_791_763_200_123));
    }
}
