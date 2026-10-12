//! Bandbreitenlimit als Token-Bucket. Alle Transfers einer Richtung teilen sich ein Limit.
//! Die Rechnung ist rein: Der Aufrufer übergibt die aktuelle Zeit und wartet die gelieferte Dauer.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

#[derive(Debug, Default)]
pub struct BandwidthLimit {
    /// Bytes pro Sekunde; 0 = unbegrenzt.
    bytes_per_sec: AtomicU64,
    bucket: Mutex<Bucket>,
}

#[derive(Debug, Default)]
struct Bucket {
    /// Verfügbare Bytes; negativ, wenn mehr reserviert als nachgefüllt wurde.
    available: f64,
    last: Option<Instant>,
}

impl BandwidthLimit {
    /// Ändert das Limit sofort; 0 hebt es auf.
    pub fn set_rate(&self, bytes_per_sec: u64) {
        self.bytes_per_sec.store(bytes_per_sec, Ordering::Relaxed);
    }

    #[must_use]
    pub fn rate(&self) -> u64 {
        self.bytes_per_sec.load(Ordering::Relaxed)
    }

    /// Reserviert `bytes` und liefert, wie lange der Aufrufer warten muss, um das Limit einzuhalten.
    /// Der Eimer fasst höchstens eine Sekunde, damit nach Pausen kein großer Schub entsteht.
    #[allow(clippy::cast_precision_loss)] // Bytes und Raten bleiben weit unter 2^52.
    pub fn reserve(&self, bytes: u64, now: Instant) -> Duration {
        let rate = self.rate();
        if rate == 0 {
            return Duration::ZERO;
        }
        let rate = rate as f64;
        let mut bucket = self.bucket.lock().unwrap_or_else(PoisonError::into_inner);
        let refill = bucket
            .last
            .map_or(rate, |last| now.saturating_duration_since(last).as_secs_f64() * rate);
        bucket.available = (bucket.available + refill).min(rate) - bytes as f64;
        bucket.last = Some(now);
        if bucket.available >= 0.0 {
            Duration::ZERO
        } else {
            Duration::from_secs_f64(-bucket.available / rate)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn does_not_wait_without_a_limit() {
        let limit = BandwidthLimit::default();
        assert_eq!(limit.reserve(u64::MAX, Instant::now()), Duration::ZERO);
    }

    #[test]
    fn spreads_transfers_to_the_configured_rate() {
        let limit = BandwidthLimit::default();
        limit.set_rate(1000);
        let start = Instant::now();
        assert_eq!(
            limit.reserve(1000, start),
            Duration::ZERO,
            "eine Sekunde Vorrat zu Beginn"
        );
        assert_eq!(limit.reserve(500, start), Duration::from_millis(500));
        let later = start + Duration::from_millis(500);
        assert_eq!(limit.reserve(500, later), Duration::from_millis(500));
        let after_pause = start + Duration::from_secs(60);
        assert_eq!(limit.reserve(1000, after_pause), Duration::ZERO);
        assert_eq!(
            limit.reserve(1000, after_pause),
            Duration::from_secs(1),
            "Vorrat höchstens eine Sekunde"
        );
        limit.set_rate(0);
        assert_eq!(limit.rate(), 0);
        assert_eq!(limit.reserve(1, after_pause), Duration::ZERO);
    }
}
