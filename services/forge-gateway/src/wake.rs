//! Fresher mirrors through a forge-relay's wake stream (`forge-wake-v1`, the protocol in
//! forge-relay's `wake` module): a long poll that names the repositories that just had a push,
//! so their mirrors refresh at once instead of at the next poll.
//!
//! A wake carries no trust: it only says "refresh now", and the refresh reads Platform with
//! proofs as every other does. A relay that is down, lies or is spoofed costs latency; polling
//! stays the floor. Requests and answers are signed with the shared secret (HMAC-SHA256), as
//! forge-runner signs them.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context as _, Result};
use forge_core::webhooks::{sign_body, verify_signature};
use serde::Deserialize;
use sha2::{Digest as _, Sha256};

use crate::metrics::Metrics;
use crate::mirror::Mirrors;

/// How long the relay may hold a request (it caps `wait` at 60 s).
const WAIT_SECS: u64 = 50;

/// First and largest pause after a failed request.
const BACKOFF: (Duration, Duration) = (Duration::from_secs(5), Duration::from_secs(120));

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

/// Read and check the shared secret: 32 to 96 printable ASCII characters, as the relay takes.
pub fn read_secret(path: &Path) -> Result<Vec<u8>> {
    let s = std::fs::read_to_string(path)
        .with_context(|| format!("reading the wake secret {}", path.display()))?;
    let s = s.trim_end().as_bytes().to_vec();
    if !(32..=96).contains(&s.len()) || !s.iter().all(|b| (0x21..=0x7e).contains(b)) {
        bail!(
            "the wake secret in {} must be 32 to 96 printable ASCII characters (no spaces)",
            path.display()
        );
    }
    Ok(s)
}

/// A relay's answer.
#[derive(Debug, Deserialize)]
pub struct Answer {
    /// Where the next request continues.
    pub cursor: String,
    /// The relay cannot say what happened: refresh everything warm.
    #[serde(default)]
    pub resync: bool,
    /// The repositories woken.
    #[serde(default)]
    pub repos: Vec<AnswerRepo>,
}

/// A woken repository.
#[derive(Debug, Deserialize)]
pub struct AnswerRepo {
    /// `<owner id>/<name>`.
    #[serde(default)]
    pub name: String,
}

fn nonce() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let h = Sha256::digest(format!("{nanos}:{}:{n}", std::process::id()));
    hex::encode(&h[..16])
}

/// Check an answer's signature and read it.
pub fn read_answer(
    secret: &[u8],
    request_sig: &str,
    body: &[u8],
    sig: Option<&str>,
) -> Result<Answer> {
    let ok = sig.is_some_and(|s| verify_signature(secret, &response_message(request_sig, body), s));
    if !ok {
        bail!("the relay's answer is not signed with the shared secret");
    }
    serde_json::from_slice(body).context("the relay's answer is not a wake answer")
}

/// The largest wake answer the gateway reads.
const MAX_ANSWER: usize = 1024 * 1024;

async fn ask(
    http: &reqwest::Client,
    base: &str,
    secret: &[u8],
    cursor: Option<&str>,
) -> Result<Answer> {
    let after = cursor.map_or_else(String::new, |c| format!("after={c}&"));
    let wait = if cursor.is_some() { WAIT_SECS } else { 0 };
    let target = format!("/v1/wake?{after}wait={wait}&nonce={}", nonce());
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let sig = sign_body(secret, request_message(&target, time).as_bytes());
    let mut resp = http
        .get(format!("{base}{target}"))
        .header("X-Forge-Wake-Time", time.to_string())
        .header("X-Forge-Wake-Signature", &sig)
        .send()
        .await?
        .error_for_status()?;
    let answer_sig = resp
        .headers()
        .get("x-forge-wake-signature")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    // Capped while it is read: a spoofed relay must not make the gateway buffer a huge body.
    if resp.content_length().is_some_and(|n| n > MAX_ANSWER as u64) {
        bail!("the relay's answer is too large");
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await? {
        if body.len() + chunk.len() > MAX_ANSWER {
            bail!("the relay's answer is too large");
        }
        body.extend_from_slice(&chunk);
    }
    read_answer(secret, &sig, &body, answer_sig.as_deref())
}

/// Long-poll `url` until the process ends, refreshing each woken mirror (by `<owner id>/<name>`;
/// the relay's `[wake] repos` must list the repositories). Errors are logged and retried with a
/// backoff; polling goes on meanwhile.
pub async fn run(url: String, secret: Vec<u8>, mirrors: Arc<Mirrors>, metrics: Arc<Metrics>) {
    let http = match reqwest::Client::builder()
        .timeout(Duration::from_secs(WAIT_SECS + 30))
        .build()
    {
        Ok(h) => h,
        Err(e) => {
            tracing::error!(error = %e, "wake client");
            return;
        }
    };
    let base = url.trim_end_matches('/').to_string();
    let mut cursor: Option<String> = None;
    let mut backoff = BACKOFF.0;
    loop {
        match ask(&http, &base, &secret, cursor.as_deref()).await {
            Ok(answer) => {
                backoff = BACKOFF.0;
                let first = cursor.is_none();
                cursor = Some(answer.cursor.clone());
                if first {
                    tracing::info!("subscribed to relay wakes");
                    continue;
                }
                Metrics::inc(&metrics.wakes);
                if answer.resync {
                    for slot in mirrors.warm() {
                        mirrors.trigger(&slot);
                    }
                    continue;
                }
                for r in &answer.repos {
                    if let Some((owner, name)) = r.name.split_once('/') {
                        for slot in mirrors.find(owner, name) {
                            mirrors.trigger(&slot);
                        }
                    }
                }
            }
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), retry_secs = backoff.as_secs(), "relay wakes unavailable; polling goes on");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(BACKOFF.1);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "0123456789abcdef0123456789abcdef-wake";

    /// forge-relay's `wake` module and forge-runner check the same vector.
    #[test]
    fn the_signature_vector_matches_the_relays() {
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

    #[test]
    fn an_answer_must_be_signed_for_this_request() {
        let s = SECRET.as_bytes();
        let body = br#"{"cursor":"ab.2","resync":false,"repos":[{"id":"R","name":"O/p","label":"alice/p"}]}"#;
        let good = sign_body(s, &response_message("sha256=01", body));
        let a = read_answer(s, "sha256=01", body, Some(&good)).unwrap();
        assert_eq!(a.repos[0].name, "O/p");
        assert!(
            read_answer(s, "sha256=02", body, Some(&good)).is_err(),
            "another request's"
        );
        assert!(read_answer(s, "sha256=01", body, None).is_err());
    }
}
