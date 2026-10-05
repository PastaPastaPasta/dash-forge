//! Abuse controls: per-client token buckets and per-client concurrency, keyed by the client's
//! address (an IPv6 address by its /64, so one host cannot rotate through its prefix). The
//! addresses live in memory only, and are never logged. A bucket that is full again is dropped
//! at the next sweep (at most one limiter period later), so an address is kept for at most two
//! periods after its last request.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

/// The key a client is limited by.
pub fn client_key(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(_) => ip,
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return IpAddr::V4(v4);
            }
            let s = v6.segments();
            IpAddr::V6(std::net::Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
        }
    }
}

/// A token bucket per client: `capacity` requests, refilled evenly over `period`.
pub struct RateLimiter {
    capacity: f64,
    per_sec: f64,
    period: Duration,
    buckets: Mutex<HashMap<IpAddr, (f64, Instant)>>,
    /// When full buckets were last dropped.
    swept: Mutex<Instant>,
}

/// The most clients a limiter tracks: when full, it drops the full (idle) buckets, and if
/// that is not enough (many clients at once, or a host rotating addresses), the least recently
/// seen tenth.
const MAX_TRACKED: usize = 100_000;

impl RateLimiter {
    /// `capacity` per `period`, per client.
    pub fn new(capacity: u32, period: Duration) -> Self {
        let capacity = f64::from(capacity.max(1));
        Self {
            capacity,
            per_sec: capacity / period.as_secs_f64().max(0.001),
            period,
            buckets: Mutex::default(),
            swept: Mutex::new(Instant::now()),
        }
    }

    /// Take one token for `ip`. `Err(wait)` when it has none: retry after `wait`.
    pub fn check(&self, ip: IpAddr) -> Result<(), Duration> {
        self.check_at(ip, Instant::now())
    }

    fn check_at(&self, ip: IpAddr, now: Instant) -> Result<(), Duration> {
        let key = client_key(ip);
        let mut b = self.buckets.lock().unwrap_or_else(PoisonError::into_inner);
        let sweep = {
            let mut swept = self.swept.lock().unwrap_or_else(PoisonError::into_inner);
            let due = now.saturating_duration_since(*swept) >= self.period;
            if due {
                *swept = now;
            }
            due
        };
        if sweep || b.len() >= MAX_TRACKED {
            // Drop the clients whose bucket is full again: they are idle.
            let (cap, rate) = (self.capacity, self.per_sec);
            b.retain(|_, (tokens, at)| {
                *tokens + now.saturating_duration_since(*at).as_secs_f64() * rate < cap
            });
            if b.len() >= MAX_TRACKED {
                let mut seen: Vec<Instant> = b.values().map(|(_, at)| *at).collect();
                let evict = b.len() - MAX_TRACKED * 9 / 10;
                let cutoff = *seen.select_nth_unstable(evict - 1).1;
                b.retain(|_, (_, at)| *at > cutoff);
            }
        }
        let (tokens, at) = b.entry(key).or_insert((self.capacity, now));
        *tokens = (*tokens + now.saturating_duration_since(*at).as_secs_f64() * self.per_sec)
            .min(self.capacity);
        *at = now;
        if *tokens >= 1.0 {
            *tokens -= 1.0;
            Ok(())
        } else {
            Err(Duration::from_secs_f64((1.0 - *tokens) / self.per_sec).max(Duration::from_secs(1)))
        }
    }
}

/// At most `per_client` concurrent holders per client.
pub struct ClientConcurrency {
    per_client: usize,
    active: Arc<Mutex<HashMap<IpAddr, usize>>>,
}

/// One client's slot; released on drop.
pub struct ClientPermit {
    key: IpAddr,
    active: Arc<Mutex<HashMap<IpAddr, usize>>>,
}

impl Drop for ClientPermit {
    fn drop(&mut self) {
        let mut a = self.active.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(n) = a.get_mut(&self.key) {
            *n -= 1;
            if *n == 0 {
                a.remove(&self.key);
            }
        }
    }
}

impl ClientConcurrency {
    /// `per_client` at once per client.
    pub fn new(per_client: usize) -> Self {
        Self {
            per_client: per_client.max(1),
            active: Arc::default(),
        }
    }

    /// A slot for `ip`, or `None` when it already holds `per_client`.
    pub fn acquire(&self, ip: IpAddr) -> Option<ClientPermit> {
        let key = client_key(ip);
        let mut a = self.active.lock().unwrap_or_else(PoisonError::into_inner);
        let n = a.entry(key).or_insert(0);
        if *n >= self.per_client {
            return None;
        }
        *n += 1;
        Some(ClientPermit {
            key,
            active: Arc::clone(&self.active),
        })
    }

    /// Slots held now, every client.
    pub fn active(&self) -> usize {
        self.active
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bucket_empties_and_refills() {
        let l = RateLimiter::new(2, Duration::from_secs(60));
        let ip: IpAddr = "192.0.2.1".parse().unwrap();
        let t = Instant::now();
        assert!(l.check_at(ip, t).is_ok());
        assert!(l.check_at(ip, t).is_ok());
        let wait = l.check_at(ip, t).unwrap_err();
        assert!(
            wait >= Duration::from_secs(29) && wait <= Duration::from_secs(31),
            "{wait:?}"
        );
        // Another client is unaffected.
        assert!(l.check_at("192.0.2.2".parse().unwrap(), t).is_ok());
        // Half a period later, one token is back.
        assert!(l.check_at(ip, t + Duration::from_secs(30)).is_ok());
    }

    #[test]
    fn an_idle_client_is_forgotten_within_two_periods() {
        let l = RateLimiter::new(2, Duration::from_secs(60));
        let t = Instant::now();
        assert!(l.check_at("192.0.2.1".parse().unwrap(), t).is_ok());
        // Two periods on, any request sweeps the full bucket away.
        assert!(l
            .check_at("192.0.2.2".parse().unwrap(), t + Duration::from_secs(121))
            .is_ok());
        let b = l.buckets.lock().unwrap();
        assert!(!b.contains_key(&"192.0.2.1".parse::<IpAddr>().unwrap()));
        assert_eq!(b.len(), 1);
    }

    #[test]
    fn the_tracked_clients_are_capped_even_when_none_is_idle() {
        // One request an hour: no bucket refills while this runs, so none is idle.
        let l = RateLimiter::new(1, Duration::from_secs(3600));
        let t = Instant::now();
        let client = |n: usize| IpAddr::from(u32::try_from(n).unwrap().to_be_bytes());
        for n in 0..MAX_TRACKED + 5 {
            let _ = l.check_at(client(n), t + Duration::from_millis(n as u64));
        }
        let b = l.buckets.lock().unwrap();
        assert!(b.len() <= MAX_TRACKED, "{}", b.len());
        // The least recently seen went; the newest stayed.
        assert!(!b.contains_key(&client(0)));
        assert!(b.contains_key(&client(MAX_TRACKED + 4)));
    }

    #[test]
    fn ipv6_is_limited_by_its_64() {
        let a: IpAddr = "2001:db8:1:2:aaaa::1".parse().unwrap();
        let b: IpAddr = "2001:db8:1:2:bbbb::2".parse().unwrap();
        assert_eq!(client_key(a), client_key(b));
        let mapped: IpAddr = "::ffff:192.0.2.9".parse().unwrap();
        assert_eq!(client_key(mapped), "192.0.2.9".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn concurrency_is_per_client() {
        let c = ClientConcurrency::new(1);
        let ip: IpAddr = "192.0.2.1".parse().unwrap();
        let p = c.acquire(ip).unwrap();
        assert!(c.acquire(ip).is_none());
        assert!(c.acquire("192.0.2.3".parse().unwrap()).is_some());
        drop(p);
        assert!(c.acquire(ip).is_some());
        assert_eq!(c.active(), 0);
    }
}
