//! Runner wake-ups (`[wake]` in the config): a long-poll endpoint on the `--listen` address that
//! tells a runner which of its repositories just had a push, so it polls them now instead of at
//! its next interval (platform-parity-spec §2.4).
//!
//! A wake carries no trust. The runner reads the repository from Platform itself (the refs
//! from proofs); a wake only says "look now". So a relay that lies, or is down, costs latency
//! and nothing else: the runner keeps its own poll interval.
//!
//! ## Protocol (`forge-wake-v1`)
//!
//! `GET /v1/wake?after=<cursor>&wait=<secs>&nonce=<hex>`
//!
//! * `after`: the `cursor` of the previous answer (absent on the first call, which answers at
//!   once with the current cursor and no repos).
//! * `wait`: how long to hold the request open when nothing happened yet (0 to 60 s, default 30).
//! * `nonce`: 16 to 64 hex digits, fresh per request.
//! * `X-Forge-Wake-Time`: the request's time (unix seconds); refused beyond ±5 minutes.
//! * `X-Forge-Wake-Signature`: `sha256=<hex>`, HMAC-SHA256 under the shared secret of
//!   `forge-wake-v1\nGET\n<path and query>\n<time>`. The secret never crosses the wire, and a
//!   signature is accepted once (a replay inside the window is refused).
//!
//! The answer (`200`, JSON) is `{"cursor": "<epoch>.<seq>", "resync": bool, "repos": [{"id",
//! "name", "label"}]}`: the repos woken after `after` (`name` is `<owner id>/<name>`, `label`
//! the relay's own spelling from `[wake] repos`). `resync` is true when the relay cannot say
//! (it restarted, or more happened than it keeps): the runner then polls every repository.
//! The answer's `X-Forge-Wake-Signature` is the HMAC of `forge-wake-v1-response\n<request
//! signature>\n<body>`, which ties it to this request: a recorded answer cannot be replayed.

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use forge_core::envelope::SecretBytes;
use forge_core::webhooks::{sign_body, verify_signature};
use serde_json::json;
use tokio::sync::watch;

/// The request path.
pub const PATH: &str = "/v1/wake";

/// How far a request's time may be from the relay's clock.
pub const MAX_SKEW_SECS: u64 = 300;

/// The longest `wait`.
pub const MAX_WAIT_SECS: u64 = 60;

/// How many wakes are kept for runners that ask with an older cursor.
const RING: usize = 1024;

/// How many signatures seen inside the window are remembered (replay guard).
const MAX_SEEN: usize = 10_000;

/// A waiting request answers this long after the first wake, so the wakes of one push (one per
/// ref) go out together.
const COALESCE: Duration = Duration::from_millis(300);

/// The string a request's signature covers.
pub fn request_message(path_and_query: &str, time: u64) -> String {
    format!("forge-wake-v1\nGET\n{path_and_query}\n{time}")
}

/// The bytes an answer's signature covers.
pub fn response_message(request_signature: &str, body: &[u8]) -> Vec<u8> {
    let mut m = format!("forge-wake-v1-response\n{request_signature}\n").into_bytes();
    m.extend_from_slice(body);
    m
}

/// A repository runners may be woken for.
#[derive(Debug, Clone)]
pub struct WakeRepo {
    /// `<owner id>/<name>`.
    pub name: String,
    /// As `[wake] repos` spells it.
    pub label: String,
}

/// The wakes and the waiting runners.
pub struct WakeHub {
    secret: SecretBytes,
    /// Changes on every restart: a cursor from an earlier run means "resync".
    epoch: String,
    /// Repo id → how it is named.
    repos: BTreeMap<String, WakeRepo>,
    ring: Mutex<Ring>,
    seq: watch::Sender<u64>,
    seen: Mutex<Seen>,
}

/// Signatures accepted inside the window, oldest first (the replay guard). Only valid
/// signatures get here, so filling it takes genuine requests; past [`MAX_SEEN`] the oldest go.
#[derive(Default)]
struct Seen {
    set: HashSet<String>,
    order: VecDeque<(Instant, String)>,
}

#[derive(Default)]
struct Ring {
    /// `(seq, repo id)`, oldest first.
    wakes: VecDeque<(u64, String)>,
}

/// What a runner is told.
#[derive(Debug, PartialEq, Eq)]
pub struct Answer {
    pub cursor: String,
    pub resync: bool,
    /// Repo ids.
    pub repos: Vec<String>,
}

/// Why a request is refused.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    /// 400: a query the protocol does not allow.
    BadRequest(&'static str),
    /// 401: no, a wrong, a stale or a replayed signature.
    Unauthorized,
}

impl std::fmt::Debug for WakeHub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WakeHub")
            .field("epoch", &self.epoch)
            .field("repos", &self.repos.len())
            .finish_non_exhaustive()
    }
}

impl WakeHub {
    /// A hub for `repos` (repo id → names), answering to `secret`.
    pub fn new(secret: SecretBytes, repos: BTreeMap<String, WakeRepo>) -> Self {
        let epoch = {
            use sha2::Digest as _;
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            let h = sha2::Sha256::digest(format!("{nanos}:{}", std::process::id()));
            hex::encode(&h[..8])
        };
        Self {
            secret,
            epoch,
            repos,
            ring: Mutex::new(Ring::default()),
            seq: watch::channel(0).0,
            seen: Mutex::new(Seen::default()),
        }
    }

    /// Whether `repo_id` is one runners are woken for.
    pub fn serves(&self, repo_id: &str) -> bool {
        self.repos.contains_key(repo_id)
    }

    /// Record activity on `repo_id` and wake the waiting runners (a repo not served is ignored).
    pub fn notify(&self, repo_id: &str) {
        if !self.serves(repo_id) {
            return;
        }
        let mut ring = self
            .ring
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let seq = *self.seq.borrow() + 1;
        ring.wakes.push_back((seq, repo_id.to_string()));
        while ring.wakes.len() > RING {
            ring.wakes.pop_front();
        }
        self.seq.send_replace(seq);
    }

    /// What a runner whose cursor is `after` is told now.
    fn answer(&self, after: Option<&str>) -> Answer {
        let ring = self
            .ring
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let seq = *self.seq.borrow();
        let cursor = format!("{}.{seq}", self.epoch);
        let Some(after) = after else {
            return Answer {
                cursor,
                resync: false,
                repos: Vec::new(),
            };
        };
        let from = after
            .split_once('.')
            .filter(|(e, _)| *e == self.epoch)
            .and_then(|(_, s)| s.parse::<u64>().ok())
            .filter(|s| *s <= seq);
        // Kept: every wake after `oldest - 1`.
        let oldest = ring.wakes.front().map_or(seq + 1, |(s, _)| *s);
        match from {
            Some(from) if from + 1 >= oldest => {
                let mut repos: Vec<String> = ring
                    .wakes
                    .iter()
                    .filter(|(s, _)| *s > from)
                    .map(|(_, r)| r.clone())
                    .collect();
                repos.sort();
                repos.dedup();
                Answer {
                    cursor,
                    resync: false,
                    repos,
                }
            }
            _ => Answer {
                cursor,
                resync: true,
                repos: Vec::new(),
            },
        }
    }

    /// Check a request's signature (`time`, `signature` from its headers) over `path_and_query`
    /// at `now` (unix seconds), and remember it so it is accepted once.
    pub fn authenticate(
        &self,
        path_and_query: &str,
        time: Option<&str>,
        signature: Option<&str>,
        now: u64,
    ) -> Result<(), Refusal> {
        let (Some(time), Some(signature)) = (time, signature) else {
            return Err(Refusal::Unauthorized);
        };
        let time: u64 = time.trim().parse().map_err(|_| Refusal::Unauthorized)?;
        if time.abs_diff(now) > MAX_SKEW_SECS {
            return Err(Refusal::Unauthorized);
        }
        // One spelling only (`sha256=` and 64 lowercase hex digits): the replay guard keys on
        // it, so an uppercase respelling of a seen signature must not pass as a new one.
        let signature = signature.trim();
        let canonical = signature.strip_prefix("sha256=").is_some_and(|h| {
            h.len() == 64
                && h.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        });
        if !canonical
            || !verify_signature(
                self.secret.expose(),
                request_message(path_and_query, time).as_bytes(),
                signature,
            )
        {
            return Err(Refusal::Unauthorized);
        }
        let mut seen = self
            .seen
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let window = Duration::from_secs(2 * MAX_SKEW_SECS + 1);
        while seen
            .order
            .front()
            .is_some_and(|(at, _)| at.elapsed() >= window || seen.order.len() >= MAX_SEEN)
        {
            if let Some((_, old)) = seen.order.pop_front() {
                seen.set.remove(&old);
            }
        }
        if !seen.set.insert(signature.to_string()) {
            return Err(Refusal::Unauthorized);
        }
        seen.order
            .push_back((Instant::now(), signature.to_string()));
        Ok(())
    }

    /// Answer an authenticated request: at once when there is news (or no cursor), else when
    /// a wake arrives or `wait` ends. Returns the body and its signature header.
    pub async fn respond(&self, query: &Query, request_signature: &str) -> (String, String) {
        let mut rx = self.seq.subscribe();
        let deadline = tokio::time::Instant::now() + query.wait;
        let answer = loop {
            let a = self.answer(query.after.as_deref());
            if query.after.is_none() || a.resync || !a.repos.is_empty() {
                break a;
            }
            match tokio::time::timeout_at(deadline, rx.changed()).await {
                // A push of several refs is several wakes: answer them together.
                Ok(Ok(())) => tokio::time::sleep(COALESCE).await,
                _ => break a,
            }
        };
        let repos: Vec<serde_json::Value> = answer
            .repos
            .iter()
            .filter_map(|id| {
                self.repos
                    .get(id)
                    .map(|r| json!({ "id": id, "name": r.name, "label": r.label }))
            })
            .collect();
        let body =
            json!({ "cursor": answer.cursor, "resync": answer.resync, "repos": repos }).to_string();
        let sig = sign_body(
            self.secret.expose(),
            &response_message(request_signature, body.as_bytes()),
        );
        (body, sig)
    }
}

/// A wake request's query.
#[derive(Debug, PartialEq, Eq)]
pub struct Query {
    pub after: Option<String>,
    pub wait: Duration,
}

/// Parse `after`, `wait` and `nonce` (required) from a query string; anything else is refused.
pub fn parse_query(query: &str) -> Result<Query, Refusal> {
    let mut after = None;
    let mut wait = Duration::from_secs(30);
    let mut nonce = false;
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        match k {
            "after" => {
                let ok = !v.is_empty()
                    && v.len() <= 64
                    && v.bytes().all(|b| b.is_ascii_hexdigit() || b == b'.');
                if !ok {
                    return Err(Refusal::BadRequest("after is not a cursor"));
                }
                after = Some(v.to_string());
            }
            "wait" => {
                let s: u64 = v
                    .parse()
                    .map_err(|_| Refusal::BadRequest("wait is not a number of seconds"))?;
                wait = Duration::from_secs(s.min(MAX_WAIT_SECS));
            }
            "nonce" => {
                if !(16..=64).contains(&v.len()) || !v.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(Refusal::BadRequest("nonce must be 16 to 64 hex digits"));
                }
                nonce = true;
            }
            _ => return Err(Refusal::BadRequest("unknown query parameter")),
        }
    }
    if !nonce {
        return Err(Refusal::BadRequest("a nonce is required"));
    }
    Ok(Query { after, wait })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "0123456789abcdef0123456789abcdef-wake";

    fn hub() -> WakeHub {
        WakeHub::new(
            SecretBytes::new(SECRET.as_bytes().to_vec()),
            BTreeMap::from([
                (
                    "R1".to_string(),
                    WakeRepo {
                        name: "O/one".into(),
                        label: "alice/one".into(),
                    },
                ),
                (
                    "R2".to_string(),
                    WakeRepo {
                        name: "O/two".into(),
                        label: "alice/two".into(),
                    },
                ),
            ]),
        )
    }

    /// The same vector is checked in forge-runner's `relay` module: the two sides must agree.
    #[test]
    fn the_signature_vector_matches_the_runners() {
        let msg = request_message(
            "/v1/wake?wait=30&nonce=00112233445566778899aabbccddeeff",
            1_700_000_000,
        );
        assert_eq!(
            sign_body(SECRET.as_bytes(), msg.as_bytes()),
            "sha256=e65615ed747cb60aa8de326d9b5344b80b48760e82b2724d6af47222796bf669"
        );
        assert_eq!(
            sign_body(SECRET.as_bytes(), &response_message("sha256=ab", b"{}")),
            "sha256=6067605b6576ae4116af23bf0cb378e12de69452f6ea37c8bcc00712b2570919"
        );
    }

    fn signed(h: &WakeHub, pq: &str, t: u64) -> Result<(), Refusal> {
        let sig = sign_body(SECRET.as_bytes(), request_message(pq, t).as_bytes());
        h.authenticate(pq, Some(&t.to_string()), Some(&sig), t)
    }

    #[test]
    fn only_a_fresh_correctly_signed_request_is_accepted_once() {
        let h = hub();
        let pq = "/v1/wake?nonce=00112233445566778899aabbccddeeff";
        assert_eq!(signed(&h, pq, 1_700_000_000), Ok(()));
        assert_eq!(
            signed(&h, pq, 1_700_000_000),
            Err(Refusal::Unauthorized),
            "a replay is refused"
        );
        let sig = sign_body(
            SECRET.as_bytes(),
            request_message(pq, 1_700_000_000).as_bytes(),
        );
        let upper = format!("sha256={}", sig["sha256=".len()..].to_ascii_uppercase());
        assert_eq!(
            h.authenticate(pq, Some("1700000000"), Some(&upper), 1_700_000_000),
            Err(Refusal::Unauthorized),
            "a respelled replay is refused too"
        );
        let sig = sign_body(
            SECRET.as_bytes(),
            request_message(pq, 1_700_000_001).as_bytes(),
        );
        assert_eq!(
            h.authenticate(
                pq,
                Some("1700000001"),
                Some(&sig),
                1_700_000_001 + MAX_SKEW_SECS + 1
            ),
            Err(Refusal::Unauthorized),
            "a stale time is refused"
        );
        let wrong = sign_body(
            b"another secret of at least 32 bytes!!",
            request_message(pq, 5).as_bytes(),
        );
        assert_eq!(
            h.authenticate(pq, Some("5"), Some(&wrong), 5),
            Err(Refusal::Unauthorized)
        );
        assert_eq!(
            h.authenticate(pq, None, None, 5),
            Err(Refusal::Unauthorized)
        );
        // The signature covers the query: another cursor is another request.
        let sig = sign_body(SECRET.as_bytes(), request_message(pq, 9).as_bytes());
        assert_eq!(
            h.authenticate(&format!("{pq}&after=1.1"), Some("9"), Some(&sig), 9),
            Err(Refusal::Unauthorized)
        );
    }

    #[test]
    fn queries_are_strict() {
        let n = "nonce=00112233445566778899aabbccddeeff";
        assert_eq!(
            parse_query(&format!("after=ab.3&wait=500&{n}")),
            Ok(Query {
                after: Some("ab.3".into()),
                wait: Duration::from_secs(MAX_WAIT_SECS)
            })
        );
        assert!(parse_query("wait=5").is_err(), "no nonce");
        assert!(parse_query(&format!("{n}&x=1")).is_err());
        assert!(parse_query(&format!("{n}&after=../x")).is_err());
        assert!(parse_query("nonce=zz").is_err());
    }

    #[tokio::test]
    async fn wakes_are_told_after_the_cursor_and_a_foreign_cursor_resyncs() {
        let h = hub();
        let first = h.answer(None);
        assert!(!first.resync && first.repos.is_empty());
        h.notify("R2");
        h.notify("R9"); // not served: ignored
        h.notify("R1");
        h.notify("R2");
        let a = h.answer(Some(&first.cursor));
        assert_eq!(a.repos, ["R1", "R2"]);
        assert!(!a.resync);
        let b = h.answer(Some(&a.cursor));
        assert!(b.repos.is_empty() && !b.resync);
        assert!(
            h.answer(Some("feed.0")).resync,
            "another epoch: the relay restarted"
        );
        let (epoch, _) = a.cursor.split_once('.').unwrap();
        assert!(
            h.answer(Some(&format!("{epoch}.999"))).resync,
            "a cursor from the future"
        );
        for _ in 0..RING + 5 {
            h.notify("R1");
        }
        assert!(
            h.answer(Some(&a.cursor)).resync,
            "more happened than is kept"
        );
    }

    #[tokio::test]
    async fn a_waiting_request_returns_on_the_next_wake() {
        let h = std::sync::Arc::new(hub());
        let cursor = h.answer(None).cursor;
        let q = Query {
            after: Some(cursor),
            wait: Duration::from_secs(10),
        };
        let waiter = {
            let h = std::sync::Arc::clone(&h);
            tokio::spawn(async move { h.respond(&q, "sha256=00").await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.notify("R1");
        let (body, sig) = tokio::time::timeout(Duration::from_secs(5), waiter)
            .await
            .unwrap()
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["repos"][0]["label"], "alice/one");
        assert_eq!(v["repos"][0]["name"], "O/one");
        assert!(verify_signature(
            SECRET.as_bytes(),
            &response_message("sha256=00", body.as_bytes()),
            &sig
        ));
        let q = Query {
            after: Some(v["cursor"].as_str().unwrap().to_string()),
            wait: Duration::from_millis(100),
        };
        let (body, _) = h.respond(&q, "sha256=00").await;
        assert!(body.contains("\"repos\":[]"), "{body}");
    }
}
