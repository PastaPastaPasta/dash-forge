//! Abuse controls: per-client token buckets and per-client concurrency, keyed by the client's
//! address (an IPv6 address by its /64, so one host cannot rotate through its prefix). The
//! addresses live in memory only, for as long as a bucket is not full again, and are never
//! logged.

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
    buckets: Mutex<HashMap<IpAddr, (f64, Instant)>>,
}

/// The most clients a limiter tracks before it drops the full (idle) buckets.
const MAX_TRACKED: usize = 100_000;

impl RateLimiter {
    /// `capacity` per `period`, per client.
    pub fn new(capacity: u32, period: Duration) -> Self {
        let capacity = f64::from(capacity.max(1));
        Self {
            capacity,
            per_sec: capacity / period.as_secs_f64().max(0.001),
            buckets: Mutex::default(),
        }
    }

    /// Take one token for `ip`. `Err(wait)` when it has none: retry after `wait`.
    pub fn check(&self, ip: IpAddr) -> Result<(), Duration> {
        self.check_at(ip, Instant::now())
    }

    fn check_at(&self, ip: IpAddr, now: Instant) -> Result<(), Duration> {
        let key = client_key(ip);
        let mut b = self.buckets.lock().unwrap_or_else(PoisonError::into_inner);
        if b.len() >= MAX_TRACKED {
            let (cap, rate) = (self.capacity, self.per_sec);
            b.retain(|_, (tokens, at)| {
                *tokens + now.saturating_duration_since(*at).as_secs_f64() * rate < cap
            });
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
