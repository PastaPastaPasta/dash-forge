//! Counters for `/metrics` (Prometheus text format). No labels carry a client address, and
//! repository labels are never used: the series stay bounded however many repos are served.

use std::fmt::Write as _;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::SystemTime;

/// Every counter the gateway keeps.
#[derive(Debug, Default)]
pub struct Metrics {
    /// HTTP requests answered, by route class.
    pub requests_git: AtomicU64,
    /// Badge requests.
    pub requests_badge: AtomicU64,
    /// Feed requests.
    pub requests_feed: AtomicU64,
    /// Link-preview requests.
    pub requests_og: AtomicU64,
    /// Other requests (index, health, manifest).
    pub requests_other: AtomicU64,
    /// `git-upload-pack` responses started.
    pub upload_packs: AtomicU64,
    /// Bytes streamed by `git-upload-pack` and `info/refs`.
    pub git_bytes: AtomicU64,
    /// Requests refused by a rate or concurrency limit.
    pub rate_limited: AtomicU64,
    /// Refreshes that succeeded.
    pub refresh_ok: AtomicU64,
    /// Refreshes that failed (the mirror keeps serving its last snapshot).
    pub refresh_failed: AtomicU64,
    /// Refreshes that changed the served refs.
    pub refresh_changed: AtomicU64,
    /// Mirrors created.
    pub mirrors_created: AtomicU64,
    /// Mirrors evicted by the disk cap.
    pub mirrors_evicted: AtomicU64,
    /// Requests for private repositories (refused).
    pub private_refused: AtomicU64,
    /// Wakes received from the relay.
    pub wakes: AtomicU64,
    /// Badge/feed/preview renders served from a stale cache because Platform failed.
    pub stale_renders: AtomicU64,
    /// When a Platform read last succeeded and last failed.
    upstream: Mutex<(Option<SystemTime>, Option<SystemTime>)>,
}

/// Gauges read at scrape time.
#[derive(Debug, Default, Clone, Copy)]
pub struct Gauges {
    /// Mirrors known.
    pub mirrors: u64,
    /// Mirrors with a served snapshot.
    pub mirrors_ready: u64,
    /// Bytes on disk.
    pub cache_bytes: u64,
    /// The cap.
    pub cache_max_bytes: u64,
    /// `git-upload-pack`s streaming now.
    pub upload_packs_active: u64,
}

impl Metrics {
    /// Bump `c` by one.
    pub fn inc(c: &AtomicU64) {
        c.fetch_add(1, Ordering::Relaxed);
    }

    /// Record a Platform read's outcome.
    pub fn upstream(&self, ok: bool) {
        let mut g = self
            .upstream
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if ok {
            g.0 = Some(SystemTime::now());
        } else {
            g.1 = Some(SystemTime::now());
        }
    }

    /// When a Platform read last succeeded and last failed.
    pub fn upstream_times(&self) -> (Option<SystemTime>, Option<SystemTime>) {
        *self
            .upstream
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Every counter: name, help and value.
    fn counters(&self) -> [(&'static str, &'static str, &AtomicU64); 16] {
        [
            (
                "forge_gateway_requests_git_total",
                "git smart-HTTP requests.",
                &self.requests_git,
            ),
            (
                "forge_gateway_requests_badge_total",
                "Badge requests.",
                &self.requests_badge,
            ),
            (
                "forge_gateway_requests_feed_total",
                "Atom feed requests.",
                &self.requests_feed,
            ),
            (
                "forge_gateway_requests_og_total",
                "Link-preview requests.",
                &self.requests_og,
            ),
            (
                "forge_gateway_requests_other_total",
                "Other requests.",
                &self.requests_other,
            ),
            (
                "forge_gateway_upload_packs_total",
                "git-upload-pack responses started.",
                &self.upload_packs,
            ),
            (
                "forge_gateway_git_bytes_total",
                "Bytes streamed to git clients.",
                &self.git_bytes,
            ),
            (
                "forge_gateway_rate_limited_total",
                "Requests refused by a limit.",
                &self.rate_limited,
            ),
            (
                "forge_gateway_refresh_ok_total",
                "Mirror refreshes that succeeded.",
                &self.refresh_ok,
            ),
            (
                "forge_gateway_refresh_failed_total",
                "Mirror refreshes that failed.",
                &self.refresh_failed,
            ),
            (
                "forge_gateway_refresh_changed_total",
                "Refreshes that moved a ref.",
                &self.refresh_changed,
            ),
            (
                "forge_gateway_mirrors_created_total",
                "Mirrors created.",
                &self.mirrors_created,
            ),
            (
                "forge_gateway_mirrors_evicted_total",
                "Mirrors evicted by the disk cap.",
                &self.mirrors_evicted,
            ),
            (
                "forge_gateway_private_refused_total",
                "Requests for private repositories.",
                &self.private_refused,
            ),
            (
                "forge_gateway_wakes_total",
                "Relay wakes received.",
                &self.wakes,
            ),
            (
                "forge_gateway_stale_renders_total",
                "Renders served stale because Platform failed.",
                &self.stale_renders,
            ),
        ]
    }

    /// The Prometheus exposition.
    pub fn render(&self, g: Gauges) -> String {
        let mut out = String::new();
        for (name, help, v) in self.counters() {
            let _ = writeln!(
                out,
                "# HELP {name} {help}\n# TYPE {name} counter\n{name} {}",
                v.load(Ordering::Relaxed)
            );
        }
        let mut gauge = |name: &str, help: &str, v: u64| {
            let _ = writeln!(out, "# HELP {name} {help}\n# TYPE {name} gauge\n{name} {v}");
        };
        gauge("forge_gateway_mirrors", "Mirrors known.", g.mirrors);
        gauge(
            "forge_gateway_mirrors_ready",
            "Mirrors serving a snapshot.",
            g.mirrors_ready,
        );
        gauge(
            "forge_gateway_cache_bytes",
            "Mirror bytes on disk.",
            g.cache_bytes,
        );
        gauge(
            "forge_gateway_cache_max_bytes",
            "The mirror disk cap.",
            g.cache_max_bytes,
        );
        gauge(
            "forge_gateway_upload_packs_active",
            "git-upload-packs streaming now.",
            g.upload_packs_active,
        );
        let (ok, failed) = self.upstream_times();
        let secs = |t: Option<SystemTime>| {
            t.and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs())
        };
        gauge(
            "forge_gateway_upstream_last_ok_seconds",
            "Unix time of the last successful Platform read (0: none yet).",
            secs(ok),
        );
        gauge(
            "forge_gateway_upstream_last_error_seconds",
            "Unix time of the last failed Platform read (0: none).",
            secs(failed),
        );
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_prometheus_text() {
        let m = Metrics::default();
        Metrics::inc(&m.upload_packs);
        m.upstream(true);
        let text = m.render(Gauges {
            mirrors: 2,
            ..Gauges::default()
        });
        assert!(
            text.contains("forge_gateway_upload_packs_total 1\n"),
            "{text}"
        );
        assert!(text.contains("# TYPE forge_gateway_mirrors gauge\nforge_gateway_mirrors 2\n"));
        assert!(!text.contains("forge_gateway_upstream_last_ok_seconds 0\n"));
    }
}
