//! [`PackReader`]: fetch an artifact from the URIs its manifest recorded, racing them with
//! a configurable IPFS gateway list, hash-verifying every candidate.
//!
//! The candidate list for a manifest is:
//! 1. every recorded `http(s)://` URL (S3 public origins, public IPFS gateway URLs),
//! 2. every recorded `s3://bucket/key` a local profile can resolve (credentialed CLI read),
//! 3. for every `ipfs://<cid>` (and every recorded `…/ipfs/<cid>` URL), the CID on each
//!    gateway: first the repo's OWN public gateways (recorded on chain, see
//!    [`PackReader::prefer_gateways`] and [`repo_gateways`]), then the configured list
//!    (`storage.toml` `[read] ipfs_gateways`, else the shared defaults in
//!    `forge-contracts/config/storage-defaults.json`).
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
use super::publish::is_public_https_url;

/// Candidates raced concurrently (PRD 04: "≤2 parallel attempts").
const RACE_WIDTH: usize = 2;

/// The floor of a candidate's whole-transfer deadline (connect + body).
pub const MIN_TRANSFER_DEADLINE: Duration = Duration::from_secs(120);

/// The slowest sustained rate a candidate may deliver at before its deadline cuts it off
/// (1 MiB/s): a 2 GiB pack gets ~34 minutes. A host that stalls outright is cut off much
/// sooner by the HTTP client's idle `read_timeout` (see [`super::http_client`]).
pub const MIN_TRANSFER_RATE: u64 = 1024 * 1024;

/// The deadline for fetching `size` bytes (unknown size → the floor):
/// `max(MIN_TRANSFER_DEADLINE, size / MIN_TRANSFER_RATE)`.
pub fn transfer_deadline(size: Option<u64>) -> Duration {
    let scaled = Duration::from_secs(size.unwrap_or(0).div_ceil(MIN_TRANSFER_RATE));
    scaled.max(MIN_TRANSFER_DEADLINE)
}

/// The time a caller with Platform chunks gives the external copies of a `size`-byte
/// artifact before falling back to the chunks: no new candidate is STARTED after it (an
/// in-flight transfer still gets its own deadline), so dead gateways cost a bounded
/// ~90 s per pack in a mixed repo, while a large pack streaming from a healthy mirror is
/// not abandoned mid-transfer.
pub fn external_budget(size: Option<u64>) -> Duration {
    Duration::from_secs(90).max(transfer_deadline(size) / 2)
}

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
    /// Fixed per-candidate deadline override (tests); `None` = [`transfer_deadline`].
    candidate_timeout: Option<Duration>,
    /// Origins the user configured (read gateways, profiles' public URLs and gateways): a
    /// recorded URL on one of these is followed even when it is http or private.
    trusted_origins: Vec<String>,
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
        let gateways: Vec<String> = gateways
            .into_iter()
            .map(|g| g.trim_end_matches('/').to_string())
            .collect();
        let mut configured: Vec<&str> = gateways.iter().map(String::as_str).collect();
        for p in profiles.profiles.values() {
            match p {
                Profile::S3(s3) => configured.extend(s3.public_url.as_deref()),
                Profile::IpfsKubo(k) => {
                    configured.extend(k.gateway.as_deref());
                    configured.extend(k.public_gateway.as_deref());
                }
                Profile::IpfsPinningService(k) => {
                    configured.extend(k.gateway.as_deref());
                    configured.extend(k.public_gateway.as_deref());
                }
                Profile::Platform(_) => {}
            }
        }
        let trusted_origins = configured.into_iter().filter_map(origin_of).collect();
        Self {
            client: super::http_client(),
            gateways,
            s3_profiles,
            candidate_timeout: None,
            trusted_origins,
        }
    }

    /// Whether `url` is on an origin this user configured.
    fn is_trusted_origin(&self, url: &str) -> bool {
        origin_of(url).is_some_and(|o| self.trusted_origins.contains(&o))
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

    /// Override each candidate's whole-transfer deadline (default: size-scaled,
    /// [`transfer_deadline`]).
    #[must_use]
    pub fn with_candidate_timeout(mut self, t: Duration) -> Self {
        self.candidate_timeout = Some(t);
        self
    }

    /// Put `preferred` in front of the gateway list (deduplicated): the repo's own public
    /// gateways, which its owner recorded on chain and which reach the node holding the
    /// content, so they are tried before any shared default.
    #[must_use]
    pub fn prefer_gateways(mut self, preferred: impl IntoIterator<Item = String>) -> Self {
        let mut out: Vec<String> = preferred
            .into_iter()
            .map(|g| g.trim_end_matches('/').to_string())
            .filter(|g| !g.is_empty())
            .collect();
        out.append(&mut self.gateways);
        let mut seen = std::collections::BTreeSet::new();
        out.retain(|g| seen.insert(g.clone()));
        self.gateways = out;
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
                    // A manifest is written by whoever pushed: never follow it to plain
                    // http, this machine or a private network (parity with forge-web
                    // `externalFetchUrls`), unless it is on an origin this user configured
                    // (a profile's public URL or gateway, a read gateway: their own NAS).
                    if is_public_https_url(raw) || self.is_trusted_origin(raw) {
                        http.push(Candidate::Http(raw.clone()));
                    }
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
        let deadline = self
            .candidate_timeout
            .unwrap_or_else(|| transfer_deadline(range.map(|r| r.len()).or(max_bytes)));
        tokio::time::timeout(deadline, attempt)
            .await
            .unwrap_or_else(|_| {
                Err(Error::Io(format!(
                    "timed out after {}s",
                    deadline.as_secs()
                )))
            })
    }

    /// Candidate `c`'s whole body if it hashes to `expected_sha256`; else `(its label, why)`.
    async fn fetch_one_verified(
        &self,
        c: &Candidate,
        expected_sha256: &str,
        size: Option<u64>,
    ) -> std::result::Result<Vec<u8>, (String, String)> {
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
    }

    /// Whether any candidate exists for `uris` (so the caller knows whether to bother).
    pub fn has_candidates(&self, uris: &[String]) -> bool {
        !self.candidates(uris).is_empty()
    }

    /// Fetch the whole artifact from the first candidate whose bytes hash to
    /// `expected_sha256` (lowercase hex). `size` (the manifest's `sizeBytes`, when known)
    /// caps every candidate's body and scales its deadline ([`transfer_deadline`]).
    /// `budget`: no new candidate is started after it (in-flight ones keep their own
    /// deadline). Errors with every candidate's failure when none verifies.
    pub async fn fetch_verified(
        &self,
        uris: &[String],
        expected_sha256: &str,
        size: Option<u64>,
        budget: Option<Duration>,
    ) -> Result<Vec<u8>> {
        use futures::stream::{FuturesUnordered, StreamExt as _};
        let candidates = self.candidates(uris);
        if candidates.is_empty() {
            return Err(Error::NotFound);
        }
        let started = Instant::now();
        let mut reasons = Vec::new();
        // At most RACE_WIDTH in flight, and a slot is refilled as soon as its candidate
        // fails: a dead host (connection refused, no DNS) costs milliseconds instead of
        // holding its slot until the slow gateway racing next to it gives up, while a slow
        // but healthy gateway keeps its own full deadline. The first verified copy wins (the
        // others are dropped = cancelled); every failure is kept so a tampering host is
        // named, not masked by a later 404.
        let mut pending = candidates.iter();
        let mut race = FuturesUnordered::new();
        loop {
            while race.len() < RACE_WIDTH {
                let Some(c) = pending.next() else { break };
                // Said once, and only when a candidate is actually left untried.
                if let Some(b) = budget.filter(|b| started.elapsed() >= *b) {
                    reasons.push(format!("gave up after the {}s budget", b.as_secs()));
                    pending = [].iter();
                    break;
                }
                race.push(self.fetch_one_verified(c, expected_sha256, size));
            }
            let Some(res) = race.next().await else { break };
            match res {
                Ok(bytes) => return Ok(bytes),
                Err((label, why)) => {
                    tracing::debug!(candidate = %label, reason = %why, "external copy unusable");
                    reasons.push(format!("{label}: {why}"));
                }
            }
        }
        let hint = if candidates
            .iter()
            .all(|c| matches!(c, Candidate::Http(u) if gateway_cid(u).is_some()))
        {
            " — every candidate was an IPFS gateway: if the node holding this content is \
             reachable through a gateway you know, add it to `[read] ipfs_gateways` in \
             storage.toml (`dg storage status <repo>` shows which gateways answer)"
        } else {
            ""
        };
        Err(Error::Io(format!(
            "no external copy verified ({} candidate(s)): {}{hint}",
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

/// The empty identity CID: every working gateway serves it (0 bytes) without fetching
/// anything from the network, so it measures the gateway itself, not content routing.
pub const IDENTITY_CID: &str = "bafkqaaa";

/// How long a gateway gets to answer the [`IDENTITY_CID`] liveness probe.
pub const GATEWAY_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// What a gateway liveness probe found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GatewayHealth {
    /// It answered `2xx` for [`IDENTITY_CID`].
    Up,
    /// It is being retired: `429`/`410` with a `Sunset` header (ipfs.io and dweb.link since
    /// 2026-09-21), or `410 Gone`.
    Retired(String),
    /// It answered, but not with the content (`429` without `Sunset`, `5xx`, a redirect to a
    /// retired gateway, …).
    Down(String),
}

impl GatewayHealth {
    /// Whether the gateway can serve reads.
    pub fn is_up(&self) -> bool {
        matches!(self, GatewayHealth::Up)
    }

    /// One line for a report: `up`, or why not.
    pub fn describe(&self) -> String {
        match self {
            GatewayHealth::Up => "up".into(),
            GatewayHealth::Retired(why) | GatewayHealth::Down(why) => why.clone(),
        }
    }
}

/// Classify a gateway's answer to `GET <gw>/ipfs/<IDENTITY_CID>`. Down means rate-limited
/// or retired (429, 410) or broken (5xx); any other answer means the gateway is there (a
/// 403/404 is a restricted gateway that serves only its own pins, e.g. a dedicated one).
fn classify_gateway(status: reqwest::StatusCode, sunset: Option<&str>) -> GatewayHealth {
    use reqwest::StatusCode;
    let failing = status == StatusCode::TOO_MANY_REQUESTS
        || status == StatusCode::GONE
        || status.is_server_error();
    if !failing {
        GatewayHealth::Up
    } else if let Some(when) = sunset {
        GatewayHealth::Retired(format!(
            "{status} with Sunset: {when} (the gateway is retired)"
        ))
    } else if status == StatusCode::GONE {
        GatewayHealth::Retired(format!("{status} (the gateway is retired)"))
    } else {
        GatewayHealth::Down(status.to_string())
    }
}

/// Probe `gateway` (a base URL) with [`IDENTITY_CID`]; redirects are followed, so a gateway
/// that forwards to a retired one reads as retired. Bounded by `timeout`.
pub async fn probe_gateway(
    client: &reqwest::Client,
    gateway: &str,
    timeout: Duration,
) -> GatewayHealth {
    let url = format!("{}/ipfs/{IDENTITY_CID}", gateway.trim_end_matches('/'));
    match tokio::time::timeout(timeout, client.get(&url).send()).await {
        Err(_) => GatewayHealth::Down(format!("no answer in {}s", timeout.as_secs())),
        Ok(Err(e)) => GatewayHealth::Down(format!("unreachable: {e}")),
        Ok(Ok(resp)) => {
            let sunset = resp
                .headers()
                .get("sunset")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            classify_gateway(resp.status(), sunset.as_deref())
        }
    }
}

/// [`probe_gateway`] every gateway in `gateways` at once, in order.
pub async fn probe_gateways(
    client: &reqwest::Client,
    gateways: &[String],
    timeout: Duration,
) -> Vec<(String, GatewayHealth)> {
    futures::future::join_all(
        gateways
            .iter()
            .map(|g| async move { (g.clone(), probe_gateway(client, g, timeout).await) }),
    )
    .await
}

/// Ask every gateway in `gateways` for `cid` at once and report, per gateway, whether it
/// served exactly `expected` within `timeout` (a gateway that fails [`probe_gateway`] is
/// not asked). What `dg storage test` uses to learn whether the shared gateways can reach
/// a node that has no public gateway of its own.
pub async fn fetch_from_gateways(
    client: &reqwest::Client,
    gateways: &[String],
    cid: &str,
    expected: &[u8],
    timeout: Duration,
) -> Vec<(String, std::result::Result<(), String>)> {
    futures::future::join_all(gateways.iter().map(|gw| async move {
        let health = probe_gateway(client, gw, GATEWAY_PROBE_TIMEOUT).await;
        if !health.is_up() {
            return (gw.clone(), Err(health.describe()));
        }
        let url = format!("{}/ipfs/{cid}", gw.trim_end_matches('/'));
        let got = tokio::time::timeout(
            timeout,
            http_get_capped(client, &url, None, Some(expected.len() as u64)),
        )
        .await;
        let res = match got {
            Ok(Ok(b)) if b == expected => Ok(()),
            Ok(Ok(_)) => Err("served different bytes".to_string()),
            Ok(Err(e)) => Err(e.to_string()),
            Err(_) => Err(format!("did not find it within {}s", timeout.as_secs())),
        };
        (gw.clone(), res)
    }))
    .await
}

/// The public IPFS gateways `uris` name (what a repo recorded on chain: its
/// `config.backend.uris` `…/ipfs/` bases, then the gateway of every `…/ipfs/<cid>` URL its
/// pack manifests record), in first-seen order. Only public `https` gateways: a manifest
/// is written by whoever pushed, and must not steer readers at loopback or LAN hosts.
pub fn repo_gateways<'a>(uris: impl IntoIterator<Item = &'a String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for u in uris {
        let Some((base, _)) = u.split_once("/ipfs/") else {
            continue;
        };
        let base = base.trim_end_matches('/');
        if is_public_https_url(base) && !out.iter().any(|g| g == base) {
            out.push(base.to_string());
            if out.len() == MAX_REPO_GATEWAYS {
                break;
            }
        }
    }
    out
}

/// At most this many of a repo's own gateways go ahead of the shared list: each is raced
/// before any default, so a long list (even of honest gateways) would delay every read.
pub const MAX_REPO_GATEWAYS: usize = 3;

/// `scheme://host[:port]` of `url`, or `None`.
fn origin_of(url: &str) -> Option<String> {
    let u = reqwest::Url::parse(url).ok()?;
    Some(u.origin().ascii_serialization()).filter(|o| o != "null")
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
    fn the_repos_own_gateway_is_tried_before_the_defaults() {
        let r = reader().prefer_gateways(["https://repo-gw.example/".to_string()]);
        let c = r.candidates(&["ipfs://bafyq".into()]);
        assert_eq!(
            c,
            vec![
                Candidate::Http("https://repo-gw.example/ipfs/bafyq".into()),
                Candidate::Http("https://gw1/ipfs/bafyq".into()),
                Candidate::Http("https://gw2/ipfs/bafyq".into()),
            ]
        );
        // A preferred gateway already in the list moves to the front, once.
        let r = reader().prefer_gateways(["https://gw2".to_string()]);
        assert_eq!(r.gateways(), ["https://gw2", "https://gw1"]);
    }

    #[test]
    fn repo_gateways_come_from_the_chain_and_are_public() {
        let backend = [
            "https://pub.r2.dev".to_string(),
            "https://my-gw.example/ipfs/".to_string(),
            "ipfs://".to_string(),
        ];
        let manifests = vec![
            "https://other-gw.example/ipfs/bafyx".to_string(),
            "https://my-gw.example/ipfs/bafyy".to_string(),
            "http://127.0.0.1:8080/ipfs/bafyz".to_string(),
            "https://192.168.1.5/ipfs/bafyz".to_string(),
            "https://nas.local/ipfs/bafyz".to_string(),
            "https://user:pw@gw.example/ipfs/bafyz".to_string(),
            "ipfs://bafyx".to_string(),
        ];
        assert_eq!(
            repo_gateways(backend.iter().chain(&manifests)),
            vec!["https://my-gw.example", "https://other-gw.example"]
        );
    }

    #[test]
    fn recorded_urls_on_private_hosts_are_not_followed_unless_configured() {
        let r = reader();
        let c = r.candidates(&[
            "http://127.0.0.1:9000/b/p".into(),
            "https://192.168.1.5/b/p".into(),
            "https://nas.local./b/p".into(),
            "http://pub.example/b/p".into(),
            "https://pub.example/b/p".into(),
        ]);
        assert_eq!(c, vec![Candidate::Http("https://pub.example/b/p".into())]);
        // The user's own profile's public URL (their NAS) is followed.
        let profiles = StorageProfiles::parse(
            "[profiles.nas]\nkind = \"s3\"\nendpoint = \"http://127.0.0.1:9000\"\nbucket = \"b\"\n\
             public_url = \"http://127.0.0.1:9000/b\"\n",
        )
        .unwrap();
        let r = PackReader::new(vec![], &profiles);
        assert_eq!(
            r.candidates(&["http://127.0.0.1:9000/b/p".into()]),
            vec![Candidate::Http("http://127.0.0.1:9000/b/p".into())]
        );
    }

    #[test]
    fn repo_gateways_are_capped() {
        let many: Vec<String> = (0..10)
            .map(|i| format!("https://gw{i}.example/ipfs/bafy"))
            .collect();
        assert_eq!(repo_gateways(&many).len(), MAX_REPO_GATEWAYS);
    }

    #[test]
    fn private_hosts_match_the_web_rules() {
        use crate::storage::publish::is_private_host;
        for h in [
            "localhost",
            "a.localhost",
            "nas.local",
            "x.internal",
            "10.1.2.3",
            "127.0.0.1",
            "100.64.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.168.0.1",
            "0.0.0.0",
            "[::1]",
            "fd00::1",
            "fe80::1",
            "::ffff:1.2.3.4",
            "nas.local.",
            "localhost.",
        ] {
            assert!(is_private_host(h), "{h}");
        }
        for h in [
            "ipfs.filebase.io",
            "8.8.8.8",
            "172.32.0.1",
            "100.128.0.1",
            "2606:4700::1",
        ] {
            assert!(!is_private_host(h), "{h}");
        }
    }

    #[test]
    fn a_sunset_429_is_a_retired_gateway() {
        use reqwest::StatusCode;
        assert_eq!(classify_gateway(StatusCode::OK, None), GatewayHealth::Up);
        assert!(matches!(
            classify_gateway(
                StatusCode::TOO_MANY_REQUESTS,
                Some("Mon, 21 Sep 2026 00:00:00 GMT")
            ),
            GatewayHealth::Retired(_)
        ));
        assert!(matches!(
            classify_gateway(StatusCode::GONE, None),
            GatewayHealth::Retired(_)
        ));
        assert!(matches!(
            classify_gateway(StatusCode::GATEWAY_TIMEOUT, None),
            GatewayHealth::Down(_)
        ));
        assert!(matches!(
            classify_gateway(StatusCode::TOO_MANY_REQUESTS, None),
            GatewayHealth::Down(_)
        ));
        // A restricted (dedicated) gateway refuses CIDs it does not pin, the probe included.
        assert_eq!(
            classify_gateway(StatusCode::FORBIDDEN, None),
            GatewayHealth::Up
        );
    }

    #[tokio::test]
    async fn probe_gateway_reads_the_identity_cid() {
        let up = serve(vec![("/ipfs/bafkqaaa", Vec::new())]);
        let client = reqwest::Client::new();
        assert!(probe_gateway(&client, &up, Duration::from_secs(5))
            .await
            .is_up());
        // A retired gateway: 429 with a Sunset header, as ipfs.io answers since 2026-09-21.
        let retired = serve_status(
            "429 Too Many Requests",
            "sunset: Mon, 21 Sep 2026 00:00:00 GMT\r\n",
        );
        assert!(matches!(
            probe_gateway(&client, &retired, Duration::from_secs(5)).await,
            GatewayHealth::Retired(_)
        ));
        // Nothing listening: down, not a hang.
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = closed.local_addr().unwrap();
        drop(closed);
        assert!(
            !probe_gateway(&client, &format!("http://{addr}"), Duration::from_secs(5))
                .await
                .is_up()
        );
    }

    /// Answer every request with `status` and the extra header lines `headers`.
    fn serve_status(status: &'static str, headers: &'static str) -> String {
        use std::io::{BufRead as _, BufReader, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                loop {
                    let mut h = String::new();
                    reader.read_line(&mut h).unwrap();
                    if h == "\r\n" || h.is_empty() {
                        break;
                    }
                }
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\n{headers}content-length: 0\r\nconnection: close\r\n\r\n"
                );
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn a_gateway_only_failure_says_how_to_add_a_gateway() {
        let base = serve(vec![]);
        let r = PackReader::new(vec![base], &StorageProfiles::default());
        let err = r
            .fetch_verified(&["ipfs://bafynothere".into()], &"0".repeat(64), None, None)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("[read] ipfs_gateways"), "{err}");
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
        // The stub is on loopback: listing it as a gateway makes it a configured origin.
        let r = PackReader::new(vec![base.clone()], &StorageProfiles::default());
        // The 1 MiB body is refused against the 13-byte manifest size, then /good wins.
        let got = r
            .fetch_verified(
                &[format!("{base}/huge"), format!("{base}/good")],
                &hash,
                Some(good.len() as u64),
                None,
            )
            .await
            .unwrap();
        assert_eq!(got, good);
        let err = r
            .fetch_verified(&[format!("{base}/huge")], &hash, Some(13), None)
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
        let r = PackReader::new(vec![format!("http://{addr}")], &StorageProfiles::default())
            .with_candidate_timeout(std::time::Duration::from_millis(300));
        let started = std::time::Instant::now();
        let err = r
            .fetch_verified(&[format!("http://{addr}/x")], &hash, None, None)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("timed out"), "{err}");
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[tokio::test]
    async fn a_dead_host_frees_its_race_slot_at_once() {
        // D-403: candidates raced in fixed pairs, so a refused connection waited for the slow
        // gateway paired with it (55-60 s on a real gateway) before the next pair started.
        let good = b"pack bytes".to_vec();
        let hash = hex::encode(sha256(&good));
        let base = serve(vec![("/good", good.clone())]);
        // Accepts and never answers: a healthy but slow gateway.
        let slow = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let slow_addr = slow.local_addr().unwrap();
        std::thread::spawn(move || {
            let _held: Vec<_> = slow.incoming().take(4).collect();
            std::thread::sleep(std::time::Duration::from_secs(30));
        });
        // Nothing listening: connection refused.
        let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let dead_addr = dead.local_addr().unwrap();
        drop(dead);
        let r = PackReader::new(
            vec![
                format!("http://{slow_addr}"),
                format!("http://{dead_addr}"),
                base.clone(),
            ],
            &StorageProfiles::default(),
        )
        .with_candidate_timeout(std::time::Duration::from_secs(20));
        let started = std::time::Instant::now();
        let got = r
            .fetch_verified(
                &[
                    format!("http://{slow_addr}/x"),
                    format!("http://{dead_addr}/x"),
                    format!("{base}/good"),
                ],
                &hash,
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(got, good);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "the third candidate waited for the slow one: {:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn the_budget_is_reported_once_and_only_when_it_skipped_a_candidate() {
        // Hosts that accept and never answer: each candidate runs to its own deadline.
        let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = silent.local_addr().unwrap();
        std::thread::spawn(move || {
            let _held: Vec<_> = silent.incoming().take(8).collect();
            std::thread::sleep(std::time::Duration::from_secs(30));
        });
        let r = PackReader::new(vec![format!("http://{addr}")], &StorageProfiles::default())
            .with_candidate_timeout(std::time::Duration::from_millis(2000));
        let fetch = |n: usize| {
            let uris: Vec<String> = (0..n).map(|i| format!("http://{addr}/{i}")).collect();
            let r = &r;
            async move {
                r.fetch_verified(
                    &uris,
                    &"0".repeat(64),
                    None,
                    Some(std::time::Duration::from_millis(1000)),
                )
                .await
                .unwrap_err()
                .to_string()
            }
        };
        // Three candidates: two start, the budget runs out, the third is skipped once.
        let err = fetch(3).await;
        assert_eq!(err.matches("gave up after").count(), 1, "{err}");
        // Two candidates: both started before the budget ran out, so nothing was skipped.
        let err = fetch(2).await;
        assert_eq!(err.matches("gave up after").count(), 0, "{err}");
    }

    #[tokio::test]
    async fn a_refused_connection_is_named_as_such() {
        let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = dead.local_addr().unwrap();
        drop(dead);
        let r = PackReader::new(vec![format!("http://{addr}")], &StorageProfiles::default());
        let err = r
            .fetch_verified(&[format!("http://{addr}/x")], &"0".repeat(64), None, None)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("could not connect"), "{err}");
        assert!(err.to_ascii_lowercase().contains("refused"), "{err}");
    }

    #[test]
    fn deadlines_scale_with_size() {
        assert_eq!(transfer_deadline(None), MIN_TRANSFER_DEADLINE);
        assert_eq!(transfer_deadline(Some(4096)), MIN_TRANSFER_DEADLINE);
        // 2 GiB at >= 1 MiB/s: 2048 s.
        assert_eq!(transfer_deadline(Some(2 << 30)), Duration::from_secs(2048));
        assert_eq!(external_budget(None), Duration::from_secs(90));
        assert_eq!(external_budget(Some(2 << 30)), Duration::from_secs(1024));
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
                None,
            )
            .await
            .unwrap();
        assert_eq!(got, good);
    }

    #[tokio::test]
    async fn reports_every_failure_when_nothing_verifies() {
        let base = serve(vec![("/tampered", b"evil".to_vec())]);
        let r = PackReader::new(vec![base.clone()], &StorageProfiles::default());
        let err = r
            .fetch_verified(
                &[format!("{base}/tampered"), format!("{base}/gone")],
                &"0".repeat(64),
                None,
                None,
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("do not match the manifest hash"), "{err}");
        assert!(matches!(
            r.fetch_verified(&["platform://c/h".into()], "00", None, None)
                .await,
            Err(Error::NotFound)
        ));
    }
}
