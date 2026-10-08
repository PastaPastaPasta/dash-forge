//! A small TTL cache for rendered badges, feeds and previews. A fresh entry is served as is;
//! an expired one is kept as a fallback for when Platform cannot be read ("stale on error").

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use bytes::Bytes;

/// A rendered response.
#[derive(Debug, Clone)]
pub struct Rendered {
    /// `Content-Type`.
    pub content_type: &'static str,
    /// The body.
    pub body: Bytes,
}

/// What a lookup found.
pub enum Lookup {
    /// Within its lifetime.
    Fresh(Rendered),
    /// Expired, usable if a new render fails; with its age.
    Stale(Rendered, Duration),
    /// Nothing.
    Miss,
}

/// Rendered responses by key (`badge:<repo id>:stars.svg`).
pub struct RenderCache {
    ttl: Duration,
    max_entries: usize,
    entries: Mutex<HashMap<String, (Instant, Rendered)>>,
}

impl RenderCache {
    /// Entries live `ttl`; at most `max_entries` are kept (the oldest go first).
    pub fn new(ttl: Duration, max_entries: usize) -> Self {
        Self {
            ttl,
            max_entries: max_entries.max(1),
            entries: Mutex::default(),
        }
    }

    /// The entry for `key`.
    pub fn get(&self, key: &str) -> Lookup {
        let e = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        match e.get(key) {
            Some((at, r)) if at.elapsed() < self.ttl => Lookup::Fresh(r.clone()),
            Some((at, r)) => Lookup::Stale(r.clone(), at.elapsed()),
            None => Lookup::Miss,
        }
    }

    /// Store `r` under `key`.
    pub fn put(&self, key: String, r: Rendered) {
        let mut e = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        if e.len() >= self.max_entries && !e.contains_key(&key) {
            if let Some(oldest) = e
                .iter()
                .min_by_key(|(_, (at, _))| *at)
                .map(|(k, _)| k.clone())
            {
                e.remove(&oldest);
            }
        }
        e.insert(key, (Instant::now(), r));
    }

    /// Drop every render of repository `repo_id` (keys are `<kind>:<repo id>:…`).
    pub fn forget_repo(&self, repo_id: &str) {
        self.entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|k, _| k.split(':').nth(1) != Some(repo_id));
    }

    /// The lifetime (for `Cache-Control`).
    pub fn ttl(&self) -> Duration {
        self.ttl
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(s: &'static str) -> Rendered {
        Rendered {
            content_type: "text/plain",
            body: Bytes::from_static(s.as_bytes()),
        }
    }

    #[test]
    fn fresh_then_stale_and_bounded() {
        let c = RenderCache::new(Duration::from_millis(30), 2);
        assert!(matches!(c.get("a"), Lookup::Miss));
        c.put("a".into(), r("1"));
        assert!(matches!(c.get("a"), Lookup::Fresh(_)));
        std::thread::sleep(Duration::from_millis(40));
        assert!(matches!(c.get("a"), Lookup::Stale(_, age) if age >= Duration::from_millis(40)));
        c.put("b".into(), r("2"));
        c.put("c".into(), r("3"));
        assert!(matches!(c.get("a"), Lookup::Miss), "the oldest went first");
    }

    #[test]
    fn a_repos_renders_are_forgotten_together() {
        let c = RenderCache::new(Duration::from_secs(60), 10);
        for k in [
            "badge:R1:stars.svg:",
            "feed:R1:issues:alice",
            "og:R1:alice:true",
        ] {
            c.put(k.into(), r("x"));
        }
        c.put("badge:R12:stars.svg:".into(), r("y"));
        c.forget_repo("R1");
        assert!(matches!(c.get("badge:R1:stars.svg:"), Lookup::Miss));
        assert!(matches!(c.get("feed:R1:issues:alice"), Lookup::Miss));
        assert!(matches!(c.get("og:R1:alice:true"), Lookup::Miss));
        assert!(matches!(c.get("badge:R12:stars.svg:"), Lookup::Fresh(_)));
    }
}
