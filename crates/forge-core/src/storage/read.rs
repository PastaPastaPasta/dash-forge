//! [`PackReader`]: fetch an artifact from the URIs its manifest recorded, racing them with
//! a configurable IPFS gateway list, hash-verifying every candidate.
//!
//! The candidate list for a manifest is:
//! 1. every recorded `http(s)://` URL (S3 public origins, public IPFS gateway URLs),
//! 2. every recorded `s3://bucket/key` a local profile can resolve (credentialed CLI read),
//! 3. for every `ipfs://<cid>` (and every recorded `…/ipfs/<cid>` URL), the CID on each
//!    gateway of the configured list (`storage.toml` `[read] ipfs_gateways`, else the
//!    shared defaults in `forge-contracts/config/storage-defaults.json`).
//!
//! Candidates are raced two at a time (PRD 04 reader policy); a candidate only wins if its
//! bytes hash to the manifest's SHA-256, so a lying or stale host costs a retry, never a
//! corrupt clone. Platform `chunk` documents are the caller's last resort — the reader
//! never needs a Platform connection.

use std::time::{Duration, Instant};

use crate::backends::https::http_get_capped;
use crate::backends::s3::key_has_bad_segment;
use crate::backends::{sha256, ByteRange, S3Backend, Uri};
use crate::error::{Error, Result};

use super::profiles::{Profile, S3Profile, StorageProfiles};

/// Candidates raced concurrently (PRD 04: "≤2 parallel attempts").
const RACE_WIDTH: usize = 2;

/// Default upper bound on one candidate's whole transfer (connect + body). A host that
/// trickles bytes forever costs this much, then the next candidate is tried.
pub const DEFAULT_CANDIDATE_TIMEOUT: Duration = Duration::from_secs(120);

/// Default total time the external copies get before a caller with Platform chunks falls
/// back to them (a mixed repo must not spend minutes per pack on dead gateways).
pub const DEFAULT_EXTERNAL_BUDGET: Duration = Duration::from_secs(90);

/// One way to fetch the bytes.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Candidate {
    /// A plain GET.
    Http(String),
    /// A (possibly signed) GET through the local S3 profile `profile` for `bucket`.
    S3 { profile: String, key: String },
}

impl Candidate {
    fn label(&self) -> String {
        match self {
            Candidate::Http(u) => u.clone(),
            Candidate::S3 { profile, key } => format!("s3 profile {profile}: {key}"),
        }
    }
}

/// A read-side racer over external copies.
pub struct PackReader {
    client: reqwest::Client,
    gateways: Vec<String>,
    /// Local S3 profiles `(bucket, profile name, profile)`. Secrets are NOT resolved here:
    /// only when an `s3://` candidate for that bucket is actually tried (so a plain fetch
    /// of a public repo never runs `security` / pops a keychain prompt). Several profiles
    /// may name the same bucket (different endpoints); each is tried in turn.
    s3_profiles: Vec<(String, String, S3Profile)>,
    candidate_timeout: Duration,
    budget: Option<Duration>,
}

impl PackReader {
    /// A reader over the shared default gateway list and no local profiles.
    pub fn with_defaults() -> Self {
        Self::new(super::default_ipfs_gateways(), &StorageProfiles::default())
    }

    /// A reader over `gateways`, able to resolve `s3://` URIs through `profiles`.
    pub fn new(gateways: Vec<String>, profiles: &StorageProfiles) -> Self {
        let s3_profiles = profiles
            .profiles
            .iter()
            .filter_map(|(name, p)| match p {
                Profile::S3(s3) => Some((s3.bucket.clone(), name.clone(), s3.clone())),
                _ => None,
            })
            .collect();
        Self {
            client: super::http_client(),
            gateways: gateways
                .into_iter()
                .map(|g| g.trim_end_matches('/').to_string())
                .collect(),
            s3_profiles,
            candidate_timeout: DEFAULT_CANDIDATE_TIMEOUT,
            budget: None,
        }
    }

    /// A reader configured from the user's `storage.toml` (defaults when it is absent or
    /// unreadable — a broken profiles file must not stop a clone from public copies).
    pub fn from_user_config() -> Self {
        match StorageProfiles::load() {
            Ok(p) => Self::new(p.ipfs_gateways(), &p),
            Err(e) => {
                tracing::warn!(error = %e, "ignoring unreadable storage profiles for reads");
                Self::with_defaults()
            }
        }
    }

    /// Bound each candidate's whole transfer.
    #[must_use]
    pub fn with_candidate_timeout(mut self, t: Duration) -> Self {
        self.candidate_timeout = t;
        self
    }

    /// Bound the total time [`Self::fetch_verified`] spends before giving up.
    #[must_use]
    pub fn with_budget(mut self, budget: Duration) -> Self {
        self.budget = Some(budget);
        self
    }

    /// The gateway list in use.
    pub fn gateways(&self) -> &[String] {
        &self.gateways
    }

    /// The ordered, de-duplicated candidate list for `uris`.
    fn candidates(&self, uris: &[String]) -> Vec<Candidate> {
        let mut http = Vec::new();
        let mut s3 = Vec::new();
        let mut cids = Vec::new();
        for raw in uris {
            let uri = Uri(raw.clone());
            match uri.scheme() {
                Some("https" | "http") => {
                    if let Some(cid) = gateway_cid(raw) {
                        cids.push(cid);
                    }
                    http.push(Candidate::Http(raw.clone()));
                }
                Some("s3") => {
                    let Some((bucket, key)) = uri.rest().and_then(|r| r.split_once('/')) else {
                        continue;
                    };
                    // A hostile manifest must not steer a signed request elsewhere.
                    if key_has_bad_segment(key) {
                        continue;
                    }
                    for (b, profile, _) in &self.s3_profiles {
                        if b == bucket {
                            s3.push(Candidate::S3 {
                                profile: profile.clone(),
                                key: key.to_string(),
                            });
                        }
                    }
                }
                Some("ipfs") => {
                    if let Ok(cid) = crate::backends::IpfsBackend::cid_of(&uri) {
                        cids.push(cid);
                    }
                }
                _ => {}
            }
        }
        let mut out = http;
        out.extend(s3);
        for cid in cids {
            for gw in &self.gateways {
                out.push(Candidate::Http(format!("{gw}/ipfs/{cid}")));
            }
        }
        let mut seen = std::collections::BTreeSet::new();
        out.retain(|c| seen.insert(c.clone()));
        out
    }

    async fn fetch(
        &self,
        c: &Candidate,
        range: Option<ByteRange>,
        max_bytes: Option<u64>,
    ) -> Result<Vec<u8>> {
        let attempt = async {
            match c {
                Candidate::Http(url) => http_get_capped(&self.client, url, range, max_bytes).await,
                Candidate::S3 { profile, key } => {
                    let (_, _, p) = self
                        .s3_profiles
                        .iter()
                        .find(|(_, name, _)| name == profile)
                        .ok_or(Error::NotFound)?;
                    // Resolve secrets now, only because this candidate is being tried.
                    let backend = S3Backend::with_client(p.to_config()?, S3Backend::client());
                    backend.get_object_capped(key, range, max_bytes).await
                }
            }
        };
        tokio::time::timeout(self.candidate_timeout, attempt)
            .await
            .unwrap_or_else(|_| {
                Err(Error::Io(format!(
                    "timed out after {}s",
                    self.candidate_timeout.as_secs()
                )))
            })
    }

    /// Whether any candidate exists for `uris` (so the caller knows whether to bother).
    pub fn has_candidates(&self, uris: &[String]) -> bool {
        !self.candidates(uris).is_empty()
    }

    /// Fetch the whole artifact from the first candidate whose bytes hash to
    /// `expected_sha256` (lowercase hex). `size` (the manifest's `sizeBytes`, when known)
    /// caps every candidate's body. Errors with every candidate's failure when none
    /// verifies, or when the budget ([`Self::with_budget`]) runs out.
    pub async fn fetch_verified(
        &self,
        uris: &[String],
        expected_sha256: &str,
        size: Option<u64>,
    ) -> Result<Vec<u8>> {
        let candidates = self.candidates(uris);
        if candidates.is_empty() {
            return Err(Error::NotFound);
        }
        let started = Instant::now();
        let mut reasons = Vec::new();
        for window in candidates.chunks(RACE_WIDTH) {
            use futures::stream::{FuturesUnordered, StreamExt as _};
            if let Some(budget) = self.budget {
                if started.elapsed() >= budget {
                    reasons.push(format!("gave up after the {}s budget", budget.as_secs()));
                    break;
                }
            }
            let mut race: FuturesUnordered<_> = window
                .iter()
                .map(|c| async move {
                    let bytes = self
                        .fetch(c, None, size)
                        .await
                        .map_err(|e| (c.label(), e.to_string()))?;
                    if hex::encode(sha256(&bytes)).eq_ignore_ascii_case(expected_sha256) {
                        Ok(bytes)
                    } else {
                        Err((
                            c.label(),
                            "served bytes that do not match the manifest hash".to_string(),
                        ))
                    }
                })
                .collect();
            // First verified copy wins (the loser is dropped = cancelled); collect every
            // failure so a tampering host is named, not masked by a later 404.
            while let Some(res) = race.next().await {
                match res {
                    Ok(bytes) => return Ok(bytes),
                    Err((label, why)) => {
                        tracing::debug!(candidate = %label, reason = %why, "external copy unusable");
                        reasons.push(format!("{label}: {why}"));
                    }
                }
            }
        }
        Err(Error::Io(format!(
            "no external copy verified ({} candidate(s)): {}",
            candidates.len(),
            reasons.join("; ")
        )))
    }

    /// Fetch `range` of the artifact (browse / partial reads). NOT hash-verified here — a
    /// slice cannot be checked against a whole-artifact hash; callers verify the objects
    /// they decode against their git OIDs.
    pub async fn fetch_range(&self, uris: &[String], range: ByteRange) -> Result<Vec<u8>> {
        let mut last = Error::NotFound;
        for c in self.candidates(uris) {
            match self.fetch(&c, Some(range), Some(range.len())).await {
                Ok(b) if b.len() as u64 == range.len() => return Ok(b),
                Ok(b) => {
                    last = Error::Io(format!(
                        "{} returned {} bytes for a {}-byte range",
                        c.label(),
                        b.len(),
                        range.len()
                    ));
                }
                Err(e) => last = e,
            }
        }
        Err(last)
    }
}

/// The CID in a path-style gateway URL (`https://gw/ipfs/<cid>[/…]`), if any.
fn gateway_cid(url: &str) -> Option<String> {
    let (_, after) = url.split_once("/ipfs/")?;
    let cid = after.split(['/', '?', '#']).next()?;
    (!cid.is_empty() && cid.bytes().all(|b| b.is_ascii_alphanumeric())).then(|| cid.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reader() -> PackReader {
        let profiles = StorageProfiles::parse(
            "[profiles.mine]\nkind = \"s3\"\nendpoint = \"http://127.0.0.1:9\"\nbucket = \"priv\"\n",
        )
        .unwrap();
        PackReader::new(vec!["https://gw1/".into(), "https://gw2".into()], &profiles)
    }

    #[test]
    fn candidates_order_public_then_s3_then_gateway_race() {
        let r = reader();
        let c = r.candidates(&[
            "ipfs://bafyabc".into(),
            "s3://priv/packs/x.pack".into(),
            "s3://someone-elses/packs/x.pack".into(),
            "https://pub.r2.dev/packs/x.pack".into(),
        ]);
        assert_eq!(
            c,
            vec![
                Candidate::Http("https://pub.r2.dev/packs/x.pack".into()),
                Candidate::S3 {
                    profile: "mine".into(),
                    key: "packs/x.pack".into()
                },
                Candidate::Http("https://gw1/ipfs/bafyabc".into()),
                Candidate::Http("https://gw2/ipfs/bafyabc".into()),
            ]
        );
    }

    #[test]
    fn recorded_gateway_urls_also_fan_out_to_the_list_once() {
        let r = reader();
        let c = r.candidates(&["https://gw1/ipfs/bafyq".into(), "ipfs://bafyq".into()]);
        assert_eq!(
            c,
            vec![
                Candidate::Http("https://gw1/ipfs/bafyq".into()),
                Candidate::Http("https://gw2/ipfs/bafyq".into()),
            ]
        );
    }

    #[test]
    fn hostile_uris_are_ignored() {
        let r = reader();
        assert!(r
            .candidates(&[
                "ipfs://bafy/../x".into(),
                "file:///etc/passwd".into(),
                "s3://priv/../other-bucket/k".into(),
                "s3://priv/a/./k".into(),
                "s3://priv/a//k".into(),
            ])
            .is_empty());
        assert_eq!(gateway_cid("https://g/ipfs/bafy?x"), Some("bafy".into()));
        assert_eq!(gateway_cid("https://g/ipfs/"), None);
    }

    /// Serve fixed bodies per path.
    fn serve(routes: Vec<(&'static str, Vec<u8>)>) -> String {
        use std::io::{BufRead as _, BufReader, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                loop {
                    let mut h = String::new();
                    reader.read_line(&mut h).unwrap();
                    if h == "\r\n" || h.is_empty() {
                        break;
                    }
                }
                let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
                let body = routes
                    .iter()
                    .find(|(p, _)| *p == path)
                    .map(|(_, b)| b.clone());
                let (status, body) = match body {
                    Some(b) => ("200 OK", b),
                    None => ("404 Not Found", Vec::new()),
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(&body);
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn oversized_bodies_and_slow_hosts_cost_one_candidate() {
        let good = b"the real pack".to_vec();
        let hash = hex::encode(sha256(&good));
        let base = serve(vec![("/huge", vec![7u8; 1 << 20]), ("/good", good.clone())]);
        let r = PackReader::new(vec![], &StorageProfiles::default());
        // The 1 MiB body is refused against the 13-byte manifest size, then /good wins.
        let got = r
            .fetch_verified(
                &[format!("{base}/huge"), format!("{base}/good")],
                &hash,
                Some(good.len() as u64),
            )
            .await
            .unwrap();
        assert_eq!(got, good);
        let err = r
            .fetch_verified(&[format!("{base}/huge")], &hash, Some(13))
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("larger than the expected"), "{err}");

        // A host that accepts but never answers is cut off by the candidate timeout.
        let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = silent.local_addr().unwrap();
        std::thread::spawn(move || {
            let _held: Vec<_> = silent.incoming().take(4).collect();
            std::thread::sleep(std::time::Duration::from_secs(30));
        });
        let r = PackReader::new(vec![], &StorageProfiles::default())
            .with_candidate_timeout(std::time::Duration::from_millis(300));
        let started = std::time::Instant::now();
        let err = r
            .fetch_verified(&[format!("http://{addr}/x")], &hash, None)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("timed out"), "{err}");
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[test]
    fn s3_candidates_do_not_resolve_secrets_up_front() {
        // A profile whose secret reference cannot resolve still yields a candidate; the
        // failure (if any) happens only when that candidate is tried.
        let profiles = StorageProfiles::parse(
            "[profiles.p]\nkind = \"s3\"\nendpoint = \"http://127.0.0.1:9\"\nbucket = \"priv\"\n\
             access_key_id = \"AK\"\nsecret_access_key = \"env:FORGE_TEST_NEVER_SET_XYZ\"\n",
        )
        .unwrap();
        let r = PackReader::new(vec![], &profiles);
        assert_eq!(r.candidates(&["s3://priv/k".into()]).len(), 1);
    }

    #[tokio::test]
    async fn races_past_missing_and_tampered_copies() {
        let good = b"real pack bytes".to_vec();
        let hash = hex::encode(sha256(&good));
        let base = serve(vec![
            ("/tampered", b"evil pack bytes".to_vec()),
            ("/ipfs/bafygood", good.clone()),
        ]);
        let r = PackReader::new(vec![base.clone()], &StorageProfiles::default());
        let got = r
            .fetch_verified(
                &[
                    format!("{base}/missing"),
                    format!("{base}/tampered"),
                    "ipfs://bafygood".into(),
                ],
                &hash,
                Some(good.len() as u64),
            )
            .await
            .unwrap();
        assert_eq!(got, good);
    }

    #[tokio::test]
    async fn reports_every_failure_when_nothing_verifies() {
        let base = serve(vec![("/tampered", b"evil".to_vec())]);
        let r = PackReader::new(vec![], &StorageProfiles::default());
        let err = r
            .fetch_verified(
                &[format!("{base}/tampered"), format!("{base}/gone")],
                &"0".repeat(64),
                None,
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("do not match the manifest hash"), "{err}");
        assert!(matches!(
            r.fetch_verified(&["platform://c/h".into()], "00", None)
                .await,
            Err(Error::NotFound)
        ));
    }
}
