//! Systemuhr als Adapter für den Port `Clock`.

use crate::ports::Clock;
use std::time::Instant;
use time::OffsetDateTime;

#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn utc_now(&self) -> OffsetDateTime {
        OffsetDateTime::now_utc()
    }

    fn monotonic(&self) -> Instant {
        Instant::now()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_current_time() {
        let clock = SystemClock;
        let before = OffsetDateTime::now_utc();
        assert!(clock.utc_now() >= before);
        let a = clock.monotonic();
        assert!(clock.monotonic() >= a);
    }
}
