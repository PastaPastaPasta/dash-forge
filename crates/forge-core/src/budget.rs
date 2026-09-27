//! The DAPI request budget of one CLI process, and what a rate-limit refusal does.
//!
//! Each DAPI gateway counts requests per client IP in 60 s windows (150 on moutai, dashmate's
//! default `rateLimiter.requestsPerUnit`), per node. The SDK spreads requests over a sticky
//! active set of about five nodes, so a process pacing itself at [`INTERVAL`] after a
//! [`BURST`] stays well inside every node's window while leaving room for a browser tab or a
//! second command on the same IP.
//!
//! A refusal (gRPC `ResourceExhausted`, `ratelimit-reset: N`) is waited out rather than
//! treated as a failure: the read retries after `N` seconds plus jitter, and the wait is said
//! on stderr (`dash: DAPI rate limit reached; waiting 23 s`). Before this the SDK banned each
//! refusing node and the command died with "no available addresses" once every node was banned
//! (D-902). The SDK still stops sending to a refusing node for exactly the reset it names
//! (`rs-dapi-client` `update_address_ban_status`), which is the right thing per node; what it
//! could not do was wait when every node refused.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Requests one process may send at once before pacing starts.
pub const BURST: u32 = 100;
/// Sustained pace after the burst: 8 requests per second across all nodes. The SDK spreads
/// requests over about five active nodes, each allowing 150 a minute, so this is about 100 a
/// minute per node: inside the limit with room for a browser on the same IP, and fast enough
/// that a pack stored as Platform chunks does not crawl.
pub const INTERVAL: Duration = Duration::from_millis(125);
/// How many rate-limit waits one read or write sits through before its error is returned.
pub const MAX_RATE_LIMIT_WAITS: u32 = 5;
/// The longest reset honoured: the SDK's own clamp (`MAX_RATE_LIMIT_BAN_SECS`), so a wait
/// never ends while the SDK still has the node banned for the same refusal.
const MAX_RESET: Duration = Duration::from_mins(10);

/// A GCRA token bucket: `tat` is the theoretical arrival time of the next request.
#[derive(Debug)]
pub struct Bucket {
    tat: Option<Instant>,
    burst: u32,
    interval: Duration,
}

impl Bucket {
    /// A bucket allowing `burst` requests at once, then one per `interval`.
    pub const fn new(burst: u32, interval: Duration) -> Self {
        Self {
            tat: None,
            burst,
            interval,
        }
    }

    /// Take a token at `now`; returns how long the caller must wait first (zero when the
    /// burst allows it now).
    pub fn take(&mut self, now: Instant) -> Duration {
        let tolerance = self.interval * self.burst.saturating_sub(1);
        let tat = self.tat.map_or(now, |t| t.max(now));
        let allowed_at = tat.checked_sub(tolerance).unwrap_or(now);
        let wait = allowed_at.saturating_duration_since(now);
        self.tat = Some(tat + self.interval);
        wait
    }
}

static BUCKET: Mutex<Bucket> = Mutex::new(Bucket::new(BURST, INTERVAL));

/// Wait until this process may send one more DAPI request.
pub async fn acquire() {
    let wait = crate::history::lock(&BUCKET).take(Instant::now());
    if !wait.is_zero() {
        tracing::debug!(wait_ms = wait.as_millis(), "pacing DAPI requests");
        tokio::time::sleep(wait).await;
    }
}

/// The pause for a refusal whose gateway asked for `reset`: the reset (capped), plus up to a
/// second of jitter so concurrent requests do not all come back in the same instant.
pub fn rate_limit_pause(reset: Duration) -> Duration {
    let jitter = Duration::from_millis(crate::cache::now_ms() % 1000);
    reset.min(MAX_RESET) + jitter
}

/// Wait out a rate-limit refusal of `label`, saying so on stderr.
pub async fn wait_out_rate_limit(label: &str, reset: Duration) {
    let pause = rate_limit_pause(reset);
    eprintln!(
        "dash: DAPI rate limit reached; waiting {} s before retrying ({label})",
        pause.as_secs().max(1)
    );
    tracing::info!(
        op = label,
        wait_ms = pause.as_millis(),
        "rate-limited; waiting for ratelimit-reset"
    );
    tokio::time::sleep(pause).await;
}

#[cfg(test)]
mod tests {
    use super::{rate_limit_pause, Bucket};
    use std::time::{Duration, Instant};

    #[test]
    fn the_bucket_allows_its_burst_then_paces() {
        let mut b = Bucket::new(3, Duration::from_secs(1));
        let t0 = Instant::now();
        assert!(b.take(t0).is_zero());
        assert!(b.take(t0).is_zero());
        assert!(b.take(t0).is_zero());
        assert_eq!(b.take(t0), Duration::from_secs(1));
        assert_eq!(b.take(t0), Duration::from_secs(2));
        // Time passing refills it.
        let later = t0 + Duration::from_secs(10);
        assert!(b.take(later).is_zero());
    }

    #[test]
    fn a_reset_is_honoured_with_jitter_and_capped() {
        let p = rate_limit_pause(Duration::from_secs(23));
        assert!(p >= Duration::from_secs(23) && p < Duration::from_secs(24));
        assert!(rate_limit_pause(Duration::from_mins(15)) < Duration::from_secs(601));
    }
}
