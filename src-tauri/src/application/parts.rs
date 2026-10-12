//! Gemeinsame Bausteine für Vorgänge in Teilen (Upload, Download, Löschen):
//! Einstellungen, Fortschritt je Teil und Wiederholungen mit wachsender Pause.

use super::cancel::CancelFlag;
use crate::domain::bandwidth::BandwidthLimit;
use crate::domain::error::StoreError;
use crate::domain::multipart::{DEFAULT_MULTIPART_THRESHOLD, DEFAULT_PART_SIZE, PartPlan};
use crate::domain::transfer::{ByteCounter, Checksums, is_retryable};
use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

/// Wiederholungen bei vorübergehenden Fehlern (Einstellungen › Transfers › Prüfung).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    /// Wiederholungen nach dem ersten Versuch
    pub retries: u32,
    /// Pause vor der ersten Wiederholung; verdoppelt sich je Versuch.
    pub delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            retries: 3,
            delay: Duration::from_secs(1),
        }
    }
}

/// Einstellungen › Transfers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PartSettings {
    pub part_size: u64,
    pub multipart_threshold: u64,
    /// Parallele Teile je Datei
    pub parts_parallel: usize,
    pub retry: RetryPolicy,
    /// Uploads vom Dienst prüfen lassen, Downloads mit dem `ETag` vergleichen.
    pub checksums: Checksums,
}

impl Default for PartSettings {
    fn default() -> Self {
        Self {
            part_size: DEFAULT_PART_SIZE,
            multipart_threshold: DEFAULT_MULTIPART_THRESHOLD,
            parts_parallel: 4,
            retry: RetryPolicy::default(),
            checksums: Checksums::Verify,
        }
    }
}

/// Fortschritt eines Transfers, auch während Teile noch laufen.
#[derive(Debug, Default)]
pub struct PartProgress {
    completed: AtomicU64,
    parts_done: AtomicU64,
    part_count: AtomicU64,
    in_flight: Mutex<HashMap<u32, ByteCounter>>,
    /// Gemeinsames Bandbreitenlimit der Richtung; None = unbegrenzt.
    limit: Option<Arc<BandwidthLimit>>,
}

impl PartProgress {
    /// Fortschritt, dessen Teile sich an das Bandbreitenlimit halten.
    #[must_use]
    pub fn limited(limit: Option<Arc<BandwidthLimit>>) -> Self {
        Self {
            limit,
            ..Self::default()
        }
    }

    #[must_use]
    pub fn done_bytes(&self) -> u64 {
        let in_flight: u64 = self.lock().values().map(ByteCounter::get).sum();
        self.completed.load(Ordering::Relaxed) + in_flight
    }

    #[must_use]
    pub fn parts_done(&self) -> u64 {
        self.parts_done.load(Ordering::Relaxed)
    }

    #[must_use]
    pub fn part_count(&self) -> u64 {
        self.part_count.load(Ordering::Relaxed)
    }

    pub(crate) fn reset(&self, part_count: u64) {
        self.completed.store(0, Ordering::Relaxed);
        self.parts_done.store(0, Ordering::Relaxed);
        self.part_count.store(part_count, Ordering::Relaxed);
        self.lock().clear();
    }

    /// Ein bereits früher übertragener Teil zählt sofort als fertig.
    pub(crate) fn credit(&self, length: u64) {
        self.completed.fetch_add(length, Ordering::Relaxed);
        self.parts_done.fetch_add(1, Ordering::Relaxed);
    }

    /// Führt einen Versuch für Teil `number` aus und zählt seine Bytes live mit.
    /// Ein gescheiterter Versuch zählt nicht: seine Bytes werden verworfen.
    pub(crate) async fn track<T, F, Fut>(&self, number: u32, length: u64, attempt: F) -> Result<T, StoreError>
    where
        F: FnOnce(ByteCounter) -> Fut,
        Fut: Future<Output = Result<T, StoreError>>,
    {
        let counter = ByteCounter::limited(self.limit.clone());
        self.lock().insert(number, counter.clone());
        let result = attempt(counter).await;
        self.lock().remove(&number);
        if result.is_ok() {
            self.credit(length);
        }
        result
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<u32, ByteCounter>> {
        self.in_flight.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Byte-Bereich `(offset, length)` von Teil `part_number`; S3 zählt Teile ab 1, der Plan ab 0.
#[must_use]
pub fn part_range(plan: &PartPlan, size: u64, part_number: u32) -> (u64, u64) {
    plan.part_range(size, u64::from(part_number).saturating_sub(1))
        .unwrap_or((0, 0))
}

/// Teilnummern `1..=count` des Plans.
pub fn part_numbers(plan: &PartPlan) -> impl Iterator<Item = u32> {
    1..=u32::try_from(plan.part_count()).unwrap_or(u32::MAX)
}

/// Führt `attempt` aus und wiederholt vorübergehende Fehler mit verdoppelter Pause.
///
/// # Errors
/// Der letzte Fehler, wenn er nicht vorübergehend ist, die Wiederholungen ausgeschöpft sind
/// oder abgebrochen wurde.
pub async fn with_retries<T, F, Fut>(policy: &RetryPolicy, cancel: &CancelFlag, mut attempt: F) -> Result<T, StoreError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, StoreError>>,
{
    let mut delay = policy.delay;
    let mut tries_left = policy.retries;
    loop {
        match attempt().await {
            Err(error) if tries_left > 0 && is_retryable(&error) && !cancel.is_cancelled() => {
                tries_left -= 1;
                tokio::time::sleep(delay).await;
                delay = delay.saturating_mul(2);
            }
            result => return result,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::multipart::MIB;

    #[test]
    fn has_sensible_defaults() {
        let s = PartSettings::default();
        assert_eq!(s.part_size, DEFAULT_PART_SIZE);
        assert_eq!(s.parts_parallel, 4);
        assert_eq!(s.retry.retries, 3);
    }

    #[test]
    fn numbers_parts_from_one() {
        let plan = PartPlan::for_download(40 * MIB, 16 * MIB, 0);
        assert_eq!(part_numbers(&plan).collect::<Vec<_>>(), [1, 2, 3]);
        assert_eq!(part_range(&plan, 40 * MIB, 3), (32 * MIB, 8 * MIB));
        assert_eq!(part_range(&PartPlan::Single, 10, 5), (0, 0));
        let huge = PartPlan::Multipart {
            part_size: 1,
            part_count: u64::MAX,
        };
        assert_eq!(part_numbers(&huge).last(), Some(u32::MAX));
    }

    #[tokio::test]
    async fn hands_the_bandwidth_limit_to_every_part() {
        let limit = Arc::new(BandwidthLimit::default());
        limit.set_rate(10);
        let progress = PartProgress::limited(Some(limit));
        let wait = progress
            .track(1, 0, |counter| async move {
                Ok::<_, StoreError>(counter.throttle(20, std::time::Instant::now()))
            })
            .await
            .unwrap();
        assert_eq!(wait, Duration::from_secs(1));
    }

    #[tokio::test]
    async fn tracks_bytes_live_and_discards_failed_attempts() {
        let progress = PartProgress::default();
        progress.reset(2);
        let failed: Result<(), _> = progress
            .track(1, 10, |counter| async move {
                counter.add(4);
                Err(StoreError::Timeout)
            })
            .await;
        assert!(failed.is_err());
        assert_eq!((progress.done_bytes(), progress.parts_done()), (0, 0));
        progress
            .track(1, 10, |counter| async move {
                counter.add(10);
                Ok(())
            })
            .await
            .unwrap();
        progress.credit(5);
        assert_eq!(
            (progress.done_bytes(), progress.parts_done(), progress.part_count()),
            (15, 2, 2)
        );
    }

    #[tokio::test]
    async fn retries_transient_errors_only_until_cancelled() {
        let policy = RetryPolicy {
            retries: 3,
            delay: Duration::from_millis(1),
        };
        let cancel = CancelFlag::default();
        let mut calls = 0;
        let result: Result<(), _> = with_retries(&policy, &cancel, || {
            calls += 1;
            cancel.cancel();
            async { Err(StoreError::Timeout) }
        })
        .await;
        assert_eq!(result, Err(StoreError::Timeout));
        assert_eq!(calls, 1, "nach Abbruch keine Wiederholung");
    }
}
