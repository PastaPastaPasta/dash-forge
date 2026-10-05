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

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crate::backends::https::{http_get_capped, http_get_watched};
use crate::backends::s3::key_has_bad_segment;
use crate::backends::{sha256, ByteRange, S3Backend, Uri};
use crate::error::{Error, Result};

use super::egress::{may_fetch, Trusted};
use super::profiles::{Profile, S3Profile, StorageProfiles};

/// Candidates raced concurrently (PRD 04: "≤2 parallel attempts").
const RACE_WIDTH: usize = 2;

/// The floor of a candidate's whole-transfer deadline (connect + body).
pub const MIN_TRANSFER_DEADLINE: Duration = Duration::from_secs(120);

/// How a read that had no copy to try begins ([`PackReader::unfollowed`]): the recorded copies
/// are all ones this computer does not follow. A caller tells that case from a copy that
/// failed by this text, and gives the fix that applies (QW2-078).
pub const NO_FOLLOWED_COPY: &str = "no recorded copy is one this computer reads from";

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

/// How long the copies racing for a pack get while none of them has sent a single byte. A
/// gateway that cannot find a CID holds the request open and answers 504 after about a
/// minute (measured 2026-09-27). When the budget runs out the silent copies are dropped and
/// the next ones get a fresh budget, so every copy is still tried. Once any candidate's body
/// is flowing this no longer applies: slow but healthy gateways stream, and keep their
/// size-scaled [`transfer_deadline`].
pub const FIRST_BYTE_BUDGET: Duration = Duration::from_secs(20);

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

    /// Where this copy lives, as a person names it: `IPFS gateway 127.0.0.1:8081`, a
    /// mirror's `host:port`, or `S3 profile <name>`.
    fn place(&self) -> String {
        match self {
            Candidate::Http(u) => {
                let host = reqwest::Url::parse(u)
                    .ok()
                    .and_then(|p| {
                        let host = p.host_str()?;
                        Some(match p.port() {
                            Some(port) => format!("{host}:{port}"),
                            None => host.to_string(),
                        })
                    })
                    .unwrap_or_else(|| u.clone());
                if gateway_cid(u).is_some() {
                    format!("IPFS gateway {host}")
                } else {
                    host
                }
            }
            Candidate::S3 { profile, .. } => format!("S3 profile {profile}"),
        }
    }
}

/// A read that a copy other than the reader's first choice served: where the bytes came from
/// and every copy tried before it, with why it did not serve them. A clone that succeeds this
/// way says so ([`fallback_lines`]), so a lost bucket or a dead gateway is noticed while the
/// other copies still hold the history, not when the last one goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fallback {
    /// The artifact's SHA-256 (lowercase hex).
    pub pack: String,
    /// The copy that served it (`IPFS gateway 127.0.0.1:8081`, `Platform chunks`).
    pub served_by: String,
    /// The copies that did not, each `place (why)`.
    pub failed: Vec<String>,
}

impl std::fmt::Display for Fallback {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let short = self.pack.get(..12).unwrap_or(&self.pack);
        write!(
            f,
            "pack {short}… read from {}; unavailable: {}",
            self.served_by,
            self.failed.join(", ")
        )
    }
}

/// At most this many [`Fallback`]s are listed one per line; the rest are counted.
const FALLBACKS_SHOWN: usize = 3;

/// What a clone or fetch of `repo` prints when some of its packs came from a fallback copy:
/// one `warning:` line per pack (the first [`FALLBACKS_SHOWN`]), a count of the rest, and where
/// to look. Empty when every pack came from its first choice.
pub fn fallback_lines(fallbacks: &[Fallback], repo: &str) -> Vec<String> {
    if fallbacks.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<String> = fallbacks
        .iter()
        .take(FALLBACKS_SHOWN)
        .map(|f| format!("warning: {f}"))
        .collect();
    if fallbacks.len() > FALLBACKS_SHOWN {
        let more = fallbacks.len() - FALLBACKS_SHOWN;
        out.push(format!(
            "warning: and {more} more {} read from a fallback copy",
            if more == 1 { "pack" } else { "packs" }
        ));
    }
    out.push(format!(
        "hint: a recorded copy of this repository is unavailable; `dg storage status {repo}` checks every copy"
    ));
    out
}

/// A failure in a few words for a [`Fallback`] line: the reader's error without the generic
/// `io error:` / `GET request failed:` layers, and an HTTP status without the URL the line
/// already names (`HTTP 403 Forbidden`).
fn brief_why(why: &str) -> String {
    const STATUS: &str = " failed with status ";
    let why = why
        .replace("io error: ", "")
        .replace("GET request failed: ", "");
    match why.find(STATUS) {
        Some(at) if why.starts_with("GET ") || why.starts_with("S3 GET ") => {
            // The status alone: an S3 error's credential hint and XML body are for `dg
            // storage status`, not a one-line warning.
            let rest = &why[at + STATUS.len()..];
            let end = rest.find([':', '(']).unwrap_or(rest.len());
            format!("HTTP {}", rest[..end].trim_end())
        }
        _ => why,
    }
}

/// An artifact a copy served: the bytes, that copy's place, and the copies preferred to it that
/// failed first (`place (why)` each; empty when the first choice served).
pub(crate) struct Served {
    pub(crate) bytes: Vec<u8>,
    pub(crate) by: String,
    pub(crate) failed: Vec<String>,
}

impl Served {
    /// The bytes, recording on `reader` a [`Fallback`] for artifact `pack` when a preferred copy
    /// failed first.
    pub(crate) fn note_on(self, reader: &PackReader, pack: &str) -> Vec<u8> {
        if !self.failed.is_empty() {
            reader.note_fallback(Fallback {
                pack: pack.to_ascii_lowercase(),
                served_by: self.by,
                failed: self.failed,
            });
        }
        self.bytes
    }
}

/// The failures (`(candidate index, place (why))`) worth naming when candidate `won` served:
/// only candidates ranked before it (one ranked after that happened to fail first while the
/// two raced is no fallback), and not another gateway's miss for the CID a gateway served —
/// the IPFS copy is fine, a default gateway lacking it is not a lost copy. A gateway URL the
/// manifest itself records is the repo's own and is kept.
fn preferred_failures(
    candidates: &[Candidate],
    uris: &[String],
    won: usize,
    places: Vec<(usize, String)>,
) -> Vec<String> {
    let cid_of = |c: &Candidate| match c {
        Candidate::Http(u) => gateway_cid(u),
        Candidate::S3 { .. } => None,
    };
    let won_cid = cid_of(&candidates[won]);
    places
        .into_iter()
        .filter(|(i, _)| {
            let c = &candidates[*i];
            let other_gateway = won_cid.is_some()
                && cid_of(c) == won_cid
                && matches!(c, Candidate::Http(u) if !uris.contains(u));
            *i < won && !other_gateway
        })
        .map(|(_, p)| p)
        .collect()
}

/// Why [`PackReader::race`] returned no bytes.
pub(crate) enum Missed {
    /// No candidate for these URIs at all (nothing this reader can fetch).
    NoCandidate,
    /// Every candidate failed: the error [`PackReader::fetch_verified`] returns, and each
    /// copy's `place (why)` for a [`Fallback`] line.
    Unverified { error: Error, places: Vec<String> },
}

impl Missed {
    /// Every one of `candidates` failed: `reasons` (`label: why`) for the error, `places` for
    /// a [`Fallback`].
    fn unverified(candidates: &[Candidate], reasons: &[String], places: Vec<String>) -> Self {
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
        Missed::Unverified {
            error: Error::Io(format!(
                "no external copy verified ({} candidate(s)): {}{hint}",
                candidates.len(),
                reasons.join("; ")
            )),
            places,
        }
    }

    /// The error, and each failed copy's `place (why)`.
    pub(crate) fn into_parts(self) -> (Error, Vec<String>) {
        match self {
            Missed::NoCandidate => (Error::NotFound, Vec::new()),
            Missed::Unverified { error, places } => (error, places),
        }
    }
}

impl From<Missed> for Error {
    fn from(m: Missed) -> Self {
        m.into_parts().0
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
    /// How long the copies of one artifact get while none has sent a byte
    /// ([`FIRST_BYTE_BUDGET`]; shorter in tests).
    first_byte_budget: Duration,
    /// What the user configured (read gateways, profiles' public URLs and gateways): a
    /// recorded URL on one of these origins is followed even when it is http or private, and
    /// these hosts may resolve to private addresses ([`super::egress`]).
    trusted: Trusted,
    /// Candidates raced at once ([`RACE_WIDTH`]; 1 in tests that need a fixed order).
    race_width: usize,
    /// Reads a fallback copy served, since the last [`Self::take_fallbacks`].
    fallbacks: std::sync::Mutex<Vec<Fallback>>,
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
        let trusted = Trusted::of(configured);
        Self {
            client: super::egress::public_read_client(&trusted),
            gateways,
            s3_profiles,
            candidate_timeout: None,
            first_byte_budget: FIRST_BYTE_BUDGET,
            trusted,
            race_width: RACE_WIDTH,
            fallbacks: std::sync::Mutex::default(),
        }
    }

    /// Try candidates one at a time instead of racing them, so which copy is tried first (and
    /// so which failures a [`Fallback`] names) is fixed. For tests: the survivability drill
    /// asserts the exact warning a dead preferred copy produces.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn sequential(mut self) -> Self {
        self.race_width = 1;
        self
    }

    /// The reads a fallback copy served since the last call (oldest first), emptying the list.
    pub fn take_fallbacks(&self) -> Vec<Fallback> {
        std::mem::take(
            &mut *self
                .fallbacks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }

    /// Record a read a fallback copy served.
    pub(crate) fn note_fallback(&self, f: Fallback) {
        self.fallbacks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(f);
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

    /// Override how long an artifact's copies get while none has sent a byte (default
    /// [`FIRST_BYTE_BUDGET`]).
    #[must_use]
    pub fn with_first_byte_budget(mut self, t: Duration) -> Self {
        self.first_byte_budget = t;
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
                    // Redirects and DNS answers are held to the same rule (`egress`).
                    if may_fetch(raw, &self.trusted) {
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

    /// Fetch candidate `c` (a `range` of it, or the whole body capped at `max_bytes`),
    /// setting `flowing` once its body starts arriving.
    async fn fetch(
        &self,
        c: &Candidate,
        range: Option<ByteRange>,
        max_bytes: Option<u64>,
        flowing: Option<&AtomicBool>,
    ) -> Result<Vec<u8>> {
        let attempt = async {
            match c {
                Candidate::Http(url) => {
                    http_get_watched(&self.client, url, range, max_bytes, flowing).await
                }
                Candidate::S3 { profile, key } => {
                    let (_, _, p) = self
                        .s3_profiles
                        .iter()
                        .find(|(_, name, _)| name == profile)
                        .ok_or(Error::NotFound)?;
                    // Resolve secrets now, only because this candidate is being tried.
                    let backend = S3Backend::with_client(p.to_config()?, S3Backend::client());
                    backend
                        .get_object_watched(key, range, max_bytes, flowing)
                        .await
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

    /// Candidate `c`'s whole body if it hashes to `expected_sha256`; else why not.
    async fn fetch_one_verified(
        &self,
        c: &Candidate,
        expected_sha256: &str,
        size: Option<u64>,
        flowing: &AtomicBool,
    ) -> std::result::Result<Vec<u8>, String> {
        let bytes = self
            .fetch(c, None, size, Some(flowing))
            .await
            .map_err(|e| e.to_string())?;
        if hex::encode(sha256(&bytes)).eq_ignore_ascii_case(expected_sha256) {
            Ok(bytes)
        } else {
            Err("served bytes that do not match the manifest hash".to_string())
        }
    }

    /// Where each candidate for `uris` lives ([`Candidate::place`]), in the order they are
    /// tried: what the survivability drill checks a clone contacts.
    #[cfg(test)]
    pub(crate) fn candidate_places(&self, uris: &[String]) -> Vec<String> {
        self.candidates(uris).iter().map(Candidate::place).collect()
    }

    /// Why each of `uris` is not a copy this reader follows, one short phrase each, with the
    /// place as `host[:port]` or a bucket name (no path, no scheme separator, so it survives
    /// a caller's URL shortening): for a read that had no candidate at all.
    pub fn unfollowed(&self, uris: &[String]) -> Vec<String> {
        uris.iter()
            .map(|raw| {
                let uri = Uri(raw.clone());
                match uri.scheme() {
                    Some("https" | "http") => {
                        use super::publish::{publish_problem, PublishProblem as P};
                        let host = reqwest::Url::parse(raw).ok().and_then(|u| {
                            u.host_str().map(|h| match u.port() {
                                Some(p) => format!("{h}:{p}"),
                                None => h.to_string(),
                            })
                        });
                        let Some(host) = host else {
                            return "an address that does not parse".to_string();
                        };
                        let why = match publish_problem(raw) {
                            Some(P::PrivateHost) => "this machine or a private network",
                            Some(P::NotHttps) => "plain http",
                            Some(P::Credentials) => "a user name or password in it",
                            _ => "not a public https address",
                        };
                        format!("{host} ({why}: never followed from a manifest)")
                    }
                    Some("s3") => {
                        let bucket = uri.rest().and_then(|r| r.split('/').next()).unwrap_or("");
                        format!("S3 bucket {bucket} (read only through a storage profile of yours for it)")
                    }
                    Some("ipfs") => "an IPFS copy (no read gateway configured)".to_string(),
                    Some(other) => format!("a {other} copy (not a kind this client reads)"),
                    None => "an unparseable address".to_string(),
                }
            })
            .collect()
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
    ///
    /// When a copy verifies after a copy preferred to it failed, the read is recorded as a
    /// [`Fallback`] ([`Self::take_fallbacks`]).
    pub async fn fetch_verified(
        &self,
        uris: &[String],
        expected_sha256: &str,
        size: Option<u64>,
        budget: Option<Duration>,
    ) -> Result<Vec<u8>> {
        self.race(uris, expected_sha256, size, budget)
            .await
            .map(|served| served.note_on(self, expected_sha256))
            .map_err(Error::from)
    }

    /// [`Self::fetch_verified`] without recording anything: which copy served, and each
    /// failed copy's `place (why)` apart from the error text, so a caller with more copies
    /// (Platform chunks, other uploaders' copies) records one [`Fallback`] for the whole read.
    pub(crate) async fn race(
        &self,
        uris: &[String],
        expected_sha256: &str,
        size: Option<u64>,
        budget: Option<Duration>,
    ) -> std::result::Result<Served, Missed> {
        use futures::stream::{FuturesUnordered, StreamExt as _};
        let candidates = self.candidates(uris);
        if candidates.is_empty() {
            return Err(Missed::NoCandidate);
        }
        let started = Instant::now();
        let mut reasons = Vec::new();
        // The same failures, each `(candidate index, place (why))`, for a Fallback line.
        let mut places: Vec<(usize, String)> = Vec::new();
        // Set when the budget left candidates untried (said only if nothing serves).
        let mut budget_skipped = None;
        // At most RACE_WIDTH in flight, and a slot is refilled as soon as its candidate
        // fails: a dead host (connection refused, no DNS) costs milliseconds instead of
        // holding its slot until the slow gateway racing next to it gives up, while a slow
        // but healthy gateway keeps its own full deadline. The first verified copy wins (the
        // others are dropped = cancelled); every failure is kept so a tampering host is
        // named, not masked by a later 404.
        //
        // Until some candidate's body starts arriving, the copies in flight get
        // `first_byte_budget` ([`FIRST_BYTE_BUDGET`]): gateways that cannot find a CID hold
        // the request open for a minute each before they say so. If none sends a byte in
        // time they are dropped and the next ones start with a fresh budget; the read fails
        // only when no copy is left. Once bytes flow, every candidate keeps its own
        // size-scaled deadline, so a slow but healthy stream is never cut off.
        //
        // "Flowing" is per candidate: a copy that sent some bytes and then failed (a reset,
        // a wrong hash, an HTML error page) leaves the race, and if no other copy in flight
        // is streaming the budget starts again for the ones still waiting.
        let flags: &[AtomicBool] = &candidates
            .iter()
            .map(|_| AtomicBool::new(false))
            .collect::<Vec<_>>();
        // Candidates in flight: (index, label).
        let mut in_flight: Vec<(usize, String)> = Vec::new();
        let any_flowing = |in_flight: &[(usize, String)]| {
            in_flight
                .iter()
                .any(|(i, _)| flags[*i].load(Ordering::Relaxed))
        };
        let first_byte = tokio::time::sleep(self.first_byte_budget);
        tokio::pin!(first_byte);
        let mut pending = candidates.iter().enumerate();
        let mut race = FuturesUnordered::new();
        loop {
            while race.len() < self.race_width {
                let Some((i, c)) = pending.next() else { break };
                // Said once, and only when a candidate is actually left untried.
                if let Some(b) = budget.filter(|b| started.elapsed() >= *b) {
                    reasons.push(format!("gave up after the {}s budget", b.as_secs()));
                    budget_skipped = Some(b.as_secs());
                    pending = [].iter().enumerate();
                    break;
                }
                in_flight.push((i, c.label()));
                race.push(async move {
                    (
                        i,
                        self.fetch_one_verified(c, expected_sha256, size, &flags[i])
                            .await,
                    )
                });
            }
            let res = tokio::select! {
                // A finished candidate first: its own error beats "sent no data".
                biased;
                r = race.next() => r,
                () = &mut first_byte, if !any_flowing(&in_flight) => {
                    // A body may have started while this select was waiting.
                    if any_flowing(&in_flight) {
                        continue;
                    }
                    // The copies in flight stayed silent: drop them (cancelling their
                    // requests) and give the next ones a fresh budget. Only when none are left
                    // does the read fail, so a copy that could serve the pack is always tried.
                    let waited = self.first_byte_budget;
                    for (i, label) in in_flight.drain(..) {
                        reasons.push(format!("{label}: sent no data within {waited:?}"));
                        places.push((
                            i,
                            format!("{} (sent no data within {waited:?})", candidates[i].place()),
                        ));
                    }
                    race = FuturesUnordered::new();
                    first_byte
                        .as_mut()
                        .reset(tokio::time::Instant::now() + self.first_byte_budget);
                    continue;
                }
            };
            let Some((done, res)) = res else { break };
            let was_flowing = flags[done].load(Ordering::Relaxed);
            in_flight.retain(|(i, _)| *i != done);
            if was_flowing && !any_flowing(&in_flight) {
                // The only streaming copy is gone: the rest get a fresh first-byte budget.
                first_byte
                    .as_mut()
                    .reset(tokio::time::Instant::now() + self.first_byte_budget);
            }
            let c = &candidates[done];
            match res {
                Ok(bytes) => {
                    return Ok(Served {
                        bytes,
                        by: c.place(),
                        failed: preferred_failures(&candidates, uris, done, places),
                    })
                }
                Err(why) => {
                    let label = c.label();
                    tracing::debug!(candidate = %label, reason = %why, "external copy unusable");
                    places.push((done, format!("{} ({})", c.place(), brief_why(&why))));
                    reasons.push(format!("{label}: {why}"));
                }
            }
        }
        let mut places: Vec<String> = places.into_iter().map(|(_, p)| p).collect();
        if let Some(secs) = budget_skipped {
            places.push(format!(
                "the other copies (not tried: gave up after the {secs}s budget)"
            ));
        }
        Err(Missed::unverified(&candidates, &reasons, places))
    }

    /// Fetch `range` of the artifact (browse / partial reads). NOT hash-verified here — a
    /// slice cannot be checked against a whole-artifact hash; callers verify the objects
    /// they decode against their git OIDs.
    pub async fn fetch_range(&self, uris: &[String], range: ByteRange) -> Result<Vec<u8>> {
        let mut last = Error::NotFound;
        for c in self.candidates(uris) {
            match self.fetch(&c, Some(range), Some(range.len()), None).await {
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
        if may_fetch(base, &Trusted::default()) && !out.iter().any(|g| g == base) {
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
    fn unfollowed_copies_say_why_with_a_place_but_no_url() {
        // QW2-078: the cause was a mangled list ("127.0.0.1:9000 forge-byo").
        let r = PackReader::new(Vec::new(), &StorageProfiles::default());
        let uris = [
            "http://127.0.0.1:9000/forge-byo/packs/x.pack".to_string(),
            "http://files.example.org/x.pack".to_string(),
            "s3://forge-byo/packs/x.pack".to_string(),
        ];
        assert!(!r.has_candidates(&uris));
        let why = r.unfollowed(&uris);
        assert_eq!(
            why,
            vec![
                "127.0.0.1:9000 (this machine or a private network: never followed from a manifest)",
                "files.example.org (plain http: never followed from a manifest)",
                "S3 bucket forge-byo (read only through a storage profile of yours for it)",
            ]
        );
        assert!(why.iter().all(|w| !w.contains("://")), "{why:?}");
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
            "https://[64:ff9b::a00:1]/ipfs/bafyz".to_string(),
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

    /// A gateway that accepts, reads the request and never sends a byte: what a real one
    /// does for a CID it cannot find, until it answers 504 a minute later.
    fn silent_gateway() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let _held: Vec<_> = listener.incoming().take(16).collect();
            std::thread::sleep(std::time::Duration::from_secs(60));
        });
        format!("http://{addr}")
    }

    /// A host that sends the headers at once, then `body` one byte every `gap`.
    fn trickle(body: Vec<u8>, gap: std::time::Duration) -> String {
        use std::io::{BufRead as _, BufReader, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let body = body.clone();
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    loop {
                        let mut h = String::new();
                        if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                            break;
                        }
                    }
                    let _ = write!(
                        stream,
                        "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                        body.len()
                    );
                    for b in body {
                        std::thread::sleep(gap);
                        // TcpStream is unbuffered: each byte is sent as it is written.
                        if stream.write_all(&[b]).is_err() {
                            return;
                        }
                    }
                });
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn copies_that_never_send_a_byte_give_up_at_the_first_byte_budget() {
        // Three gateways that hold the request open without answering: before, each kept
        // its slot for its whole deadline (a minute on real gateways). Now each pair gets
        // one first-byte budget: the first two, then the third, then the read fails.
        let gws: Vec<String> = (0..3).map(|_| silent_gateway()).collect();
        let uris: Vec<String> = gws.iter().map(|g| format!("{g}/x")).collect();
        let r = PackReader::new(gws, &StorageProfiles::default())
            .with_candidate_timeout(std::time::Duration::from_secs(30))
            .with_first_byte_budget(std::time::Duration::from_millis(500));
        let started = std::time::Instant::now();
        let err = r
            .fetch_verified(&uris, &"0".repeat(64), None, None)
            .await
            .unwrap_err()
            .to_string();
        let took = started.elapsed();
        assert!(
            took >= std::time::Duration::from_millis(1000)
                && took < std::time::Duration::from_secs(5),
            "two budgets (a pair, then the last one): {took:?}"
        );
        // Every copy was tried and is named.
        assert_eq!(
            err.matches(": sent no data within 500ms").count(),
            3,
            "{err}"
        );
        for u in &uris {
            assert!(err.contains(&format!("{u}: sent no data")), "{err}");
        }
    }

    /// A host that sends the headers and one body byte, then closes the connection.
    fn one_byte_then_close() -> String {
        use std::io::{BufRead as _, BufReader, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                loop {
                    let mut h = String::new();
                    if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                        break;
                    }
                }
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-length: 100\r\nconnection: close\r\n\r\nx",
                );
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn a_silent_pair_gives_way_to_the_next_copies_which_still_serve_the_pack() {
        // Two gateways that never answer, then one that has the pack: the silent pair is
        // dropped after the first-byte budget and the third is tried with a fresh one. A
        // clone that can succeed must not fail because the first two were slow to say no.
        let good = b"the pack a third gateway has".to_vec();
        let hash = hex::encode(sha256(&good));
        let silent: Vec<String> = (0..2).map(|_| silent_gateway()).collect();
        let serving = serve(vec![("/x", good.clone())]);
        let mut gws = silent;
        gws.push(serving);
        let uris: Vec<String> = gws.iter().map(|g| format!("{g}/x")).collect();
        let r = PackReader::new(gws, &StorageProfiles::default())
            .with_candidate_timeout(std::time::Duration::from_secs(30))
            .with_first_byte_budget(std::time::Duration::from_millis(500));
        let started = std::time::Instant::now();
        let got = r.fetch_verified(&uris, &hash, None, None).await.unwrap();
        assert_eq!(got, good);
        let took = started.elapsed();
        assert!(
            took >= std::time::Duration::from_millis(500)
                && took < std::time::Duration::from_secs(5),
            "about one first-byte budget, then the transfer: {took:?}"
        );
    }

    #[tokio::test]
    async fn a_copy_that_streamed_then_failed_does_not_disable_the_first_byte_budget() {
        // One byte then a broken body, next to silent gateways: once the streaming copy is
        // gone, the silent ones must still be given up on at the first-byte budget.
        let broken = one_byte_then_close();
        let silent: Vec<String> = (0..2).map(|_| silent_gateway()).collect();
        let mut gws = vec![broken.clone()];
        gws.extend(silent);
        let uris: Vec<String> = gws.iter().map(|g| format!("{g}/x")).collect();
        let r = PackReader::new(gws, &StorageProfiles::default())
            .with_candidate_timeout(std::time::Duration::from_secs(30))
            .with_first_byte_budget(std::time::Duration::from_millis(800));
        let started = std::time::Instant::now();
        let err = r
            .fetch_verified(&uris, &"0".repeat(64), None, None)
            .await
            .unwrap_err()
            .to_string();
        assert!(
            started.elapsed() < std::time::Duration::from_secs(8),
            "the silent copies held their slots after the streaming one failed: {:?}",
            started.elapsed()
        );
        assert!(err.contains("sent no data within"), "{err}");
    }

    #[tokio::test]
    async fn a_slow_stream_that_has_started_is_not_cut_off_by_the_first_byte_budget() {
        let good = b"slow but healthy".to_vec();
        let hash = hex::encode(sha256(&good));
        // 16 bytes at 100 ms each: ~1.6 s, well past the 300 ms first-byte budget.
        let slow = trickle(good.clone(), std::time::Duration::from_millis(100));
        let r = PackReader::new(vec![slow.clone()], &StorageProfiles::default())
            .with_candidate_timeout(std::time::Duration::from_secs(20))
            .with_first_byte_budget(std::time::Duration::from_millis(300));
        let got = r
            .fetch_verified(&[format!("{slow}/pack")], &hash, None, None)
            .await
            .unwrap();
        assert_eq!(got, good);
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
    async fn a_copy_served_after_others_failed_is_recorded_as_a_fallback() {
        let good = b"the pack".to_vec();
        let hash = hex::encode(sha256(&good));
        let base = serve(vec![
            ("/good", good.clone()),
            ("/ipfs/bafyok", good.clone()),
        ]);
        let host = base.trim_start_matches("http://").to_string();
        let r = PackReader::new(vec![base.clone()], &StorageProfiles::default()).sequential();
        // The first choice serves: nothing to say.
        let got = r
            .fetch_verified(&[format!("{base}/good")], &hash, None, None)
            .await
            .unwrap();
        assert_eq!(got, good);
        assert_eq!(r.take_fallbacks(), []);
        // A missing copy, then one serving other bytes, then the gateway: the gateway's read is
        // a fallback naming both.
        let base2 = serve(vec![("/evil", b"not the pack".to_vec())]);
        let r = PackReader::new(
            vec![base.clone(), base2.clone()],
            &StorageProfiles::default(),
        )
        .sequential();
        let got = r
            .fetch_verified(
                &[
                    format!("{base}/gone"),
                    format!("{base2}/evil"),
                    "ipfs://bafyok".into(),
                ],
                &hash,
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(got, good);
        let host2 = base2.trim_start_matches("http://");
        assert_eq!(
            r.take_fallbacks(),
            [Fallback {
                pack: hash.clone(),
                served_by: format!("IPFS gateway {host}"),
                failed: vec![
                    format!("{host} (not found)"),
                    format!("{host2} (served bytes that do not match the manifest hash)"),
                ],
            }]
        );
        // Taken: the list starts over.
        assert_eq!(r.take_fallbacks(), []);
    }

    #[tokio::test]
    async fn no_fallback_when_the_first_choice_serves_or_only_a_default_gateway_missed() {
        let good = b"slow but first".to_vec();
        let hash = hex::encode(sha256(&good));
        // Racing: the first choice trickles the pack while the second answers 404 at once.
        // The second failed first, but it was never needed: nothing to say.
        let slow = trickle(good.clone(), std::time::Duration::from_millis(20));
        let fast404 = serve(vec![]);
        let r = PackReader::new(
            vec![slow.clone(), fast404.clone()],
            &StorageProfiles::default(),
        );
        let got = r
            .fetch_verified(
                &[format!("{slow}/pack"), format!("{fast404}/pack")],
                &hash,
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(got, good);
        assert_eq!(r.take_fallbacks(), []);
        // One gateway lacks the CID and the next serves it: the IPFS copy is fine.
        let lacking = serve(vec![]);
        let having = serve(vec![("/ipfs/bafyhas", good.clone())]);
        let r = PackReader::new(vec![lacking, having], &StorageProfiles::default()).sequential();
        let got = r
            .fetch_verified(&["ipfs://bafyhas".into()], &hash, None, None)
            .await
            .unwrap();
        assert_eq!(got, good);
        assert_eq!(r.take_fallbacks(), []);
    }

    #[test]
    fn fallback_lines_name_each_pack_then_count_the_rest() {
        let f = |n: u8| Fallback {
            pack: format!("{n:02x}").repeat(32),
            served_by: "Platform chunks".into(),
            failed: vec!["pub.example (HTTP 403 Forbidden)".into()],
        };
        assert_eq!(fallback_lines(&[], "o/r"), Vec::<String>::new());
        let lines = fallback_lines(&[f(1)], "o/r");
        assert_eq!(
            lines,
            [
                "warning: pack 010101010101… read from Platform chunks; unavailable: pub.example (HTTP 403 Forbidden)",
                "hint: a recorded copy of this repository is unavailable; `dg storage status o/r` checks every copy",
            ]
        );
        let lines = fallback_lines(&[f(1), f(2), f(3), f(4), f(5)], "o/r");
        assert_eq!(lines.len(), 5, "{lines:?}");
        assert_eq!(
            lines[3],
            "warning: and 2 more packs read from a fallback copy"
        );
    }

    #[test]
    fn brief_reasons_keep_the_status_and_drop_the_url_and_hints() {
        assert_eq!(
            brief_why("io error: GET http://h/b/k failed with status 403 Forbidden"),
            "HTTP 403 Forbidden"
        );
        assert_eq!(
            brief_why(
                "io error: S3 GET k failed with status 403 Forbidden (access denied — check the \
                 credentials): AccessDenied: Access Denied"
            ),
            "HTTP 403 Forbidden"
        );
        assert_eq!(
            brief_why("io error: GET request failed: could not connect: Connection refused"),
            "could not connect: Connection refused"
        );
        assert_eq!(brief_why("not found"), "not found");
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
