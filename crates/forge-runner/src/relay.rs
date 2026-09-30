//! Wake-ups from the owner's own relay (`[relay]` in runner.toml): a thread long-polls the
//! relay's `/v1/wake` endpoint (forge-relay's `wake` module has the protocol) and tells the
//! watch loop which repositories to poll now.
//!
//! A wake carries no trust: it only makes the runner poll a repository earlier. What runs is
//! still decided by what the runner reads itself (`git ls-remote dash://…` from Platform
//! proofs). A relay that is down, lies or is spoofed costs
//! latency, never a run the runner would not have made; the poll interval stays the floor.
//!
//! Authentication is a secret shared with the relay (`[wake] secret` there). Every request is
//! signed with it (HMAC-SHA256 over the path, the query with a fresh nonce, and the time), so
//! the secret never crosses the wire and a recorded request cannot be replayed; every answer is
//! signed over the request's signature and its body, so a forged or replayed answer is refused.

use std::path::Path;
use std::sync::mpsc::Sender;
use std::time::Duration;

use anyhow::{bail, Context as _, Result};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;

/// How long the relay may hold a request (the relay caps it at 60 s).
const WAIT_SECS: u64 = 50;

/// First and largest pause after a failed request.
const BACKOFF: (Duration, Duration) = (Duration::from_secs(5), Duration::from_secs(120));

/// What the watch loop is told.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Wake {
    /// The relay cannot say what happened (it restarted, or more happened than it keeps):
    /// poll every repository.
    All,
    /// These repositories had a push: each by every name the relay
    /// gives it (`<owner id>/<name>` and the relay's own label).
    Repos(Vec<Vec<String>>),
}

/// The string a request's signature covers (forge-relay `wake::request_message`).
pub fn request_message(path_and_query: &str, time: u64) -> String {
    format!("forge-wake-v1\nGET\n{path_and_query}\n{time}")
}

/// The bytes an answer's signature covers (forge-relay `wake::response_message`).
pub fn response_message(request_signature: &str, body: &[u8]) -> Vec<u8> {
    let mut m = format!("forge-wake-v1-response\n{request_signature}\n").into_bytes();
    m.extend_from_slice(body);
    m
}

fn mac(secret: &[u8]) -> Hmac<Sha256> {
    Hmac::<Sha256>::new_from_slice(secret).expect("HMAC takes any key length")
}

/// `sha256=<hex>` of `msg` under `secret`.
pub fn sign(secret: &[u8], msg: &[u8]) -> String {
    let mut m = mac(secret);
    m.update(msg);
    format!("sha256={}", hex::encode(m.finalize().into_bytes()))
}

/// Constant-time check of a `sha256=<hex>` signature.
pub fn verify(secret: &[u8], msg: &[u8], signature: &str) -> bool {
    let Some(want) = signature
        .trim()
        .strip_prefix("sha256=")
        .and_then(|h| hex::decode(h).ok())
    else {
        return false;
    };
    let mut m = mac(secret);
    m.update(msg);
    m.verify_slice(&want).is_ok()
}

/// Read and check the shared secret: 32 to 96 printable ASCII characters, as the relay takes.
pub fn read_secret(path: &Path) -> Result<Vec<u8>> {
    let s = std::fs::read_to_string(path)
        .with_context(|| format!("reading the relay secret {}", path.display()))?;
    let s = s.trim_end().as_bytes().to_vec();
    if !(32..=96).contains(&s.len()) || !s.iter().all(|b| (0x21..=0x7e).contains(b)) {
        bail!(
            "the relay secret in {} must be 32 to 96 printable ASCII characters (no spaces)",
            path.display()
        );
    }
    Ok(s)
}

/// A relay's answer.
#[derive(Debug, Deserialize)]
struct Answer {
    cursor: String,
    #[serde(default)]
    resync: bool,
    #[serde(default)]
    repos: Vec<AnswerRepo>,
}

#[derive(Debug, Deserialize)]
struct AnswerRepo {
    #[serde(default)]
    name: String,
    #[serde(default)]
    label: String,
}

/// A fresh nonce: unique per request (the relay refuses a signature it saw), not secret.
fn nonce() -> String {
    use sha2::Digest as _;
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let h = Sha256::digest(format!("{nanos}:{}:{n}", std::process::id()));
    hex::encode(&h[..16])
}

/// The path and query of a wake request after `cursor`.
fn target(cursor: Option<&str>, wait: u64) -> String {
    let after = cursor.map_or_else(String::new, |c| format!("after={c}&"));
    format!("/v1/wake?{after}wait={wait}&nonce={}", nonce())
}

/// Check an answer's signature and read it.
fn read_answer(secret: &[u8], request_sig: &str, body: &str, sig: Option<&str>) -> Result<Answer> {
    let ok =
        sig.is_some_and(|s| verify(secret, &response_message(request_sig, body.as_bytes()), s));
    if !ok {
        bail!("the relay's answer is not signed with the shared secret");
    }
    serde_json::from_str(body).context("the relay's answer is not a wake answer")
}

impl Answer {
    fn wake(self) -> Option<Wake> {
        if self.resync {
            return Some(Wake::All);
        }
        let repos: Vec<Vec<String>> = self
            .repos
            .into_iter()
            .map(|r| {
                [r.name, r.label]
                    .into_iter()
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .collect();
        (!repos.is_empty()).then_some(Wake::Repos(repos))
    }
}

/// One long-poll: the answer after `cursor`.
fn ask(agent: &ureq::Agent, base: &str, secret: &[u8], cursor: Option<&str>) -> Result<Answer> {
    let target = target(cursor, if cursor.is_some() { WAIT_SECS } else { 0 });
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let sig = sign(secret, request_message(&target, time).as_bytes());
    let mut resp = agent
        .get(&format!("{base}{target}"))
        .header("X-Forge-Wake-Time", &time.to_string())
        .header("X-Forge-Wake-Signature", &sig)
        .call()
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let answer_sig = resp
        .headers()
        .get("x-forge-wake-signature")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let body = resp
        .body_mut()
        .with_config()
        .limit(1024 * 1024)
        .read_to_string()
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    read_answer(secret, &sig, &body, answer_sig.as_deref())
}

/// Long-poll `url` (`http(s)://host[:port]`) with `secret` in a thread of its own, sending each
/// wake to `tx`, until the receiver is gone. Errors are logged and retried with a backoff; the
/// runner's own polling goes on meanwhile.
pub fn spawn(url: String, secret: Vec<u8>, tx: Sender<Wake>) {
    std::thread::spawn(move || {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(WAIT_SECS + 30)))
            .build()
            .into();
        let base = url.trim_end_matches('/').to_string();
        let mut cursor: Option<String> = None;
        let mut backoff = BACKOFF.0;
        let mut connected = false;
        loop {
            match ask(&agent, &base, &secret, cursor.as_deref()) {
                Ok(answer) => {
                    if !connected {
                        eprintln!("forge-runner: woken by the relay at {base}");
                        connected = true;
                    }
                    backoff = BACKOFF.0;
                    // The first answer only sets the cursor: before it, nothing was missed.
                    let first = cursor.is_none();
                    cursor = Some(answer.cursor.clone());
                    if let Some(w) = answer.wake().filter(|_| !first) {
                        if tx.send(w).is_err() {
                            return;
                        }
                    }
                }
                Err(e) => {
                    eprintln!(
                        "forge-runner: relay wake-ups from {base}: {e:#} (polling goes on; retrying in {}s)",
                        backoff.as_secs()
                    );
                    connected = false;
                    std::thread::sleep(backoff);
                    backoff = (backoff * 2).min(BACKOFF.1);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "0123456789abcdef0123456789abcdef-wake";

    /// The same vector is checked in forge-relay's `wake` module: the two sides must agree.
    #[test]
    fn the_signature_vector_matches_the_relays() {
        let msg = request_message(
            "/v1/wake?wait=30&nonce=00112233445566778899aabbccddeeff",
            1_700_000_000,
        );
        assert_eq!(
            sign(SECRET.as_bytes(), msg.as_bytes()),
            "sha256=e65615ed747cb60aa8de326d9b5344b80b48760e82b2724d6af47222796bf669"
        );
        assert_eq!(
            sign(SECRET.as_bytes(), &response_message("sha256=ab", b"{}")),
            "sha256=6067605b6576ae4116af23bf0cb378e12de69452f6ea37c8bcc00712b2570919"
        );
    }

    #[test]
    fn an_answer_must_be_signed_for_this_request() {
        let s = SECRET.as_bytes();
        let body = r#"{"cursor":"ab.2","resync":false,"repos":[{"id":"R","name":"O/p","label":"alice/p"}]}"#;
        let good = sign(s, &response_message("sha256=01", body.as_bytes()));
        let a = read_answer(s, "sha256=01", body, Some(&good)).unwrap();
        assert_eq!(a.cursor, "ab.2");
        assert_eq!(
            a.wake(),
            Some(Wake::Repos(vec![vec!["O/p".into(), "alice/p".into()]]))
        );
        assert!(
            read_answer(s, "sha256=02", body, Some(&good)).is_err(),
            "an answer to another request (a replay)"
        );
        assert!(read_answer(s, "sha256=01", body, None).is_err(), "unsigned");
        let forged = body.replace("alice/p", "alice/q");
        assert!(read_answer(s, "sha256=01", &forged, Some(&good)).is_err());
        let resync = r#"{"cursor":"cd.0","resync":true,"repos":[]}"#;
        let sig = sign(s, &response_message("sha256=01", resync.as_bytes()));
        assert_eq!(
            read_answer(s, "sha256=01", resync, Some(&sig))
                .unwrap()
                .wake(),
            Some(Wake::All)
        );
        let quiet = r#"{"cursor":"cd.0","resync":false,"repos":[]}"#;
        let sig = sign(s, &response_message("sha256=01", quiet.as_bytes()));
        assert_eq!(
            read_answer(s, "sha256=01", quiet, Some(&sig))
                .unwrap()
                .wake(),
            None
        );
    }

    #[test]
    fn requests_carry_a_fresh_nonce_and_the_cursor() {
        let a = target(Some("ab.3"), 50);
        let b = target(Some("ab.3"), 50);
        assert!(a.starts_with("/v1/wake?after=ab.3&wait=50&nonce="), "{a}");
        assert_ne!(a, b, "two requests never sign the same string");
        assert!(target(None, 0).starts_with("/v1/wake?wait=0&nonce="));
    }

    #[test]
    fn the_secret_is_checked() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("s");
        std::fs::write(&p, format!("{SECRET}\n")).unwrap();
        assert_eq!(read_secret(&p).unwrap(), SECRET.as_bytes());
        std::fs::write(&p, "short").unwrap();
        assert!(read_secret(&p).is_err());
        std::fs::write(&p, "has a space in it but is long enough to pass").unwrap();
        assert!(read_secret(&p).is_err());
    }
}
