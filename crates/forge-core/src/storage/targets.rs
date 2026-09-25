//! The push-side storage seam: [`StorageTarget`], the verified external target, and the
//! N-of-M [`replicate`] engine.
//!
//! The push path only ever talks to `&dyn StorageTarget`. The external kinds (S3, kubo,
//! pinning services) are implemented here over [`PackBackend`]s; the Platform `chunk` tier
//! is implemented next to the contract model (`crate::repo::PlatformChunkTarget`), so a
//! new contract generation replaces that one type and leaves this engine and the helper
//! untouched.
//!
//! **Ordering guarantee.** [`replicate`] returns `Ok` only when at least `required` targets
//! have stored AND verified the bytes. The caller writes the `packManifest`, and only then
//! the refs, after that `Ok` — so a ref never points at history fewer than N targets hold.

use std::fmt;

use crate::backends::cid::cid_v1_raw_leaves;
use crate::backends::{sha256, ByteRange, PackBackend, PackMeta, Uri};
use crate::error::{Error, Result};

/// Packs up to this size are verified by a full re-download + SHA-256. Larger ones by a
/// size check plus byte-exact comparison of the head and tail windows (the store already
/// checked the full body hash on upload: S3 via `x-amz-content-sha256`, IPFS via the CID).
pub const FULL_VERIFY_MAX: u64 = 16 * 1024 * 1024;

/// Window compared at each end of a large upload.
const EDGE_WINDOW: u64 = 64 * 1024;

/// One confirmed copy of an artifact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Replica {
    /// The profile name that stored it.
    pub target: String,
    /// The URIs the manifest records for it (public read URLs first).
    pub uris: Vec<Uri>,
    /// Whether this copy is on-chain `chunk` documents.
    pub platform: bool,
}

/// A target that did not confirm, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetFailure {
    /// The profile name.
    pub target: String,
    /// The error, one line.
    pub reason: String,
}

/// A successful replication (≥ N confirmed).
#[derive(Debug, Clone, Default)]
pub struct Replication {
    /// Confirmed copies, in policy order.
    pub replicas: Vec<Replica>,
    /// Targets that failed (fewer than would have broken the policy).
    pub failures: Vec<TargetFailure>,
}

impl Replication {
    /// Whether any external (off-chain) copy was confirmed.
    pub fn has_external(&self) -> bool {
        self.replicas.iter().any(|r| !r.platform)
    }

    /// Whether the on-chain copy was confirmed.
    pub fn has_platform(&self) -> bool {
        self.replicas.iter().any(|r| r.platform)
    }

    /// Every recorded URI, public URLs first, de-duplicated, in policy order.
    pub fn uris(&self) -> Vec<String> {
        let mut public = Vec::new();
        let mut rest = Vec::new();
        for r in &self.replicas {
            for u in &r.uris {
                let bucket = if matches!(u.scheme(), Some("https" | "http")) {
                    &mut public
                } else {
                    &mut rest
                };
                if !bucket.contains(&u.0) {
                    bucket.push(u.0.clone());
                }
            }
        }
        public.extend(rest);
        public
    }

    /// The URI list as the manifest's `uris` JSON, trimmed to fit `max_json_len`: private
    /// `s3://` locators are dropped first (readers without that profile cannot use them),
    /// then an error — never a silently truncated or empty list.
    pub fn manifest_uris(&self, max_json_len: usize) -> Result<Vec<String>> {
        let fits = |v: &Vec<String>| {
            serde_json::to_string(v).map_or(usize::MAX, |s| s.len()) <= max_json_len
        };
        let mut uris = self.uris();
        if fits(&uris) {
            return Ok(uris);
        }
        uris.retain(|u| !u.starts_with("s3://"));
        if fits(&uris) && !uris.is_empty() {
            return Ok(uris);
        }
        Err(Error::Config(format!(
            "the confirmed copies' URIs do not fit the manifest's {max_json_len}-byte uris field; \
             use shorter public URLs or fewer targets"
        )))
    }
}

/// Fewer than N targets confirmed.
#[derive(Debug, Clone)]
pub struct ReplicationError {
    /// Copies that DID confirm (a fallback can build on them).
    pub confirmed: Vec<Replica>,
    /// Confirmations the policy requires.
    pub required: usize,
    /// Targets that failed, with reasons.
    pub failures: Vec<TargetFailure>,
    /// Targets not attempted because the policy could no longer be met (Platform chunks
    /// are skipped rather than paid for when the result would be discarded anyway).
    pub skipped: Vec<String>,
}

impl fmt::Display for ReplicationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "storage policy not met: {} of {} required target(s) confirmed",
            self.confirmed.len(),
            self.required
        )?;
        for fail in &self.failures {
            write!(f, "; {}: {}", fail.target, fail.reason)?;
        }
        if !self.skipped.is_empty() {
            write!(
                f,
                "; skipped (would not change the outcome): {}",
                self.skipped.join(", ")
            )?;
        }
        Ok(())
    }
}

impl std::error::Error for ReplicationError {}

/// Where a push writes an artifact.
#[async_trait::async_trait]
pub trait StorageTarget: Send + Sync {
    /// The profile name (`r2-main`, `kubo`, `platform`).
    fn name(&self) -> &str;

    /// Whether this is the on-chain `chunk` tier (paid in credits; attempted last).
    fn is_platform(&self) -> bool;

    /// Store `bytes` and verify the store holds exactly them, returning the URIs to record.
    /// Must be idempotent for identical bytes (a re-push).
    async fn store(&self, bytes: &[u8], meta: &PackMeta) -> Result<Vec<Uri>>;
}

/// Store `bytes` on `targets`, requiring `required` verified confirmations.
///
/// External targets run in parallel. Platform targets run afterwards, and only if the
/// policy can still be met with them — so a push whose external copies failed does not
/// pay for chunk documents it is about to throw away. Returns [`ReplicationError`] (as
/// [`Error::Io`] carrying its message) when fewer than `required` confirm.
pub async fn replicate(
    targets: &[&dyn StorageTarget],
    bytes: &[u8],
    meta: &PackMeta,
    required: usize,
) -> std::result::Result<Replication, ReplicationError> {
    let (external, platform): (Vec<&dyn StorageTarget>, Vec<&dyn StorageTarget>) =
        targets.iter().copied().partition(|t| !t.is_platform());

    let results = futures::future::join_all(
        external
            .iter()
            .map(|t| async move { (*t, t.store(bytes, meta).await) }),
    )
    .await;

    let mut replicas = Vec::new();
    let mut failures = Vec::new();
    for (t, res) in results {
        match res {
            Ok(uris) => replicas.push(Replica {
                target: t.name().to_string(),
                uris,
                platform: false,
            }),
            Err(e) => failures.push(TargetFailure {
                target: t.name().to_string(),
                reason: one_line(&e.to_string()),
            }),
        }
    }

    let mut skipped = Vec::new();
    for (i, t) in platform.iter().enumerate() {
        let still_possible = replicas.len() + (platform.len() - i) >= required;
        if !still_possible {
            skipped.extend(platform[i..].iter().map(|t| t.name().to_string()));
            break;
        }
        match t.store(bytes, meta).await {
            Ok(uris) => replicas.push(Replica {
                target: t.name().to_string(),
                uris,
                platform: true,
            }),
            Err(e) => failures.push(TargetFailure {
                target: t.name().to_string(),
                reason: one_line(&e.to_string()),
            }),
        }
    }

    if replicas.len() >= required {
        Ok(Replication { replicas, failures })
    } else {
        Err(ReplicationError {
            confirmed: replicas,
            required,
            failures,
            skipped,
        })
    }
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// An external (S3 / IPFS) target: `put` through its backend, then re-read and verify.
pub struct ExternalTarget {
    name: String,
    backend: Box<dyn PackBackend>,
    /// A public https gateway to record next to `ipfs://` (IPFS profiles only).
    public_gateway: Option<String>,
    /// Whether the store can be re-read (an IPFS profile with no gateway cannot; its
    /// verification is the CID re-derivation + pin check inside the backend).
    reread: bool,
}

impl ExternalTarget {
    /// Wrap `backend` as the target `name`.
    pub fn new(
        name: impl Into<String>,
        backend: Box<dyn PackBackend>,
        public_gateway: Option<String>,
        reread: bool,
    ) -> Self {
        Self {
            name: name.into(),
            backend,
            public_gateway: public_gateway.map(|g| g.trim_end_matches('/').to_string()),
            reread,
        }
    }

    /// Build from a profile (resolving its secrets). Errors for the Platform kind.
    pub fn from_profile(
        name: &str,
        profile: &super::Profile,
        client: &reqwest::Client,
    ) -> Result<Self> {
        let backend = profile.build_backend(client)?.ok_or_else(|| {
            Error::Config(format!(
                "profile {name:?} is Platform storage, not external"
            ))
        })?;
        Ok(Self::new(
            name,
            backend,
            profile.public_gateway().map(str::to_string),
            profile.can_reread(),
        ))
    }

    /// Re-read what was stored at `uri` and check it is exactly `bytes`.
    async fn verify(&self, uri: &Uri, bytes: &[u8], meta: &PackMeta) -> Result<()> {
        let size = bytes.len() as u64;
        if size <= FULL_VERIFY_MAX {
            let got = self.backend.get(uri, None).await?;
            if hex::encode(sha256(&got)) != meta.pack_hash {
                return Err(Error::Io(format!(
                    "re-read of {uri} returned {} bytes that do not hash to the pack — the \
                     store (or a cache in front of it) is serving different content",
                    got.len()
                )));
            }
            return Ok(());
        }
        let health = self.backend.probe(uri).await?;
        if !health.ok || health.size.is_some_and(|s| s != size) {
            return Err(Error::Io(format!(
                "re-read of {uri}: object missing or wrong size ({:?} != {size})",
                health.size
            )));
        }
        for (start, end) in [
            (0, EDGE_WINDOW.min(size)),
            (size.saturating_sub(EDGE_WINDOW), size),
        ] {
            let range = ByteRange::new(start, end)?;
            let got = self.backend.get(uri, Some(range)).await?;
            let want =
                &bytes[usize::try_from(start).unwrap_or(0)..usize::try_from(end).unwrap_or(0)];
            if got != want {
                return Err(Error::Io(format!(
                    "re-read of {uri} bytes {start}..{end} differ from the pack"
                )));
            }
        }
        Ok(())
    }
}

#[async_trait::async_trait]
impl StorageTarget for ExternalTarget {
    fn name(&self) -> &str {
        &self.name
    }

    fn is_platform(&self) -> bool {
        false
    }

    async fn store(&self, bytes: &[u8], meta: &PackMeta) -> Result<Vec<Uri>> {
        let mut uris = self.backend.put(bytes, meta).await?;
        if uris.is_empty() {
            return Err(Error::Io(format!(
                "{} returned no URI for the upload",
                self.name
            )));
        }
        // IPFS: also record the public gateway URL (what browsers fetch), and verify
        // through it — that is the URL other people will rely on.
        if let (Some(gw), Some(first)) = (&self.public_gateway, uris.first().cloned()) {
            if first.scheme() == Some("ipfs") {
                let cid = crate::backends::IpfsBackend::cid_of(&first)?;
                uris.insert(0, Uri(format!("{gw}/ipfs/{cid}")));
            }
        }
        if self.reread {
            self.verify(&uris[0], bytes, meta).await?;
        } else if let Some(u) = uris.iter().find(|u| u.scheme() == Some("ipfs")) {
            // No gateway to re-read through: the backend already matched kubo's CID to a
            // local derivation and confirmed the pin. Re-check the CID here so this path
            // never records a URI that was not derived from these bytes.
            let cid = crate::backends::IpfsBackend::cid_of(u)?;
            if cid != cid_v1_raw_leaves(bytes) {
                return Err(Error::Io(format!(
                    "{}: CID {cid} does not match the bytes",
                    self.name
                )));
            }
        }
        Ok(uris)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A scripted target for policy tests.
    pub(crate) struct FakeTarget {
        pub name: String,
        pub platform: bool,
        pub fail: bool,
        pub calls: AtomicUsize,
    }

    impl FakeTarget {
        pub(crate) fn new(name: &str, platform: bool, fail: bool) -> Self {
            Self {
                name: name.into(),
                platform,
                fail,
                calls: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait::async_trait]
    impl StorageTarget for FakeTarget {
        fn name(&self) -> &str {
            &self.name
        }
        fn is_platform(&self) -> bool {
            self.platform
        }
        async fn store(&self, _bytes: &[u8], meta: &PackMeta) -> Result<Vec<Uri>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail {
                Err(Error::Io(format!("{} is down\n(detail)", self.name)))
            } else if self.platform {
                Ok(vec![Uri(format!("platform://c/{}", meta.pack_hash))])
            } else {
                Ok(vec![
                    Uri(format!("https://{}.example/{}", self.name, meta.pack_hash)),
                    Uri(format!("s3://{}/{}", self.name, meta.pack_hash)),
                ])
            }
        }
    }

    fn meta() -> PackMeta {
        PackMeta::for_bytes(b"pack")
    }

    #[tokio::test]
    async fn all_targets_confirm() {
        let a = FakeTarget::new("a", false, false);
        let b = FakeTarget::new("b", false, false);
        let rep = replicate(&[&a, &b], b"pack", &meta(), 2).await.unwrap();
        assert_eq!(rep.replicas.len(), 2);
        assert!(rep.has_external() && !rep.has_platform());
        let uris = rep.uris();
        assert!(uris[0].starts_with("https://a.example"));
        assert!(
            uris[1].starts_with("https://b.example"),
            "public URLs first"
        );
        assert!(uris[2].starts_with("s3://"));
    }

    #[tokio::test]
    async fn n_not_met_fails_with_every_reason() {
        let a = FakeTarget::new("a", false, false);
        let b = FakeTarget::new("b", false, true);
        let err = replicate(&[&a, &b], b"pack", &meta(), 2).await.unwrap_err();
        assert_eq!(err.confirmed.len(), 1);
        assert_eq!(err.confirmed[0].target, "a");
        assert_eq!(err.failures[0].target, "b");
        let msg = err.to_string();
        assert!(msg.contains("1 of 2"), "{msg}");
        assert!(
            msg.contains("b is down (detail)") && !msg.contains('\n'),
            "one line: {msg}"
        );
    }

    #[tokio::test]
    async fn n_of_m_tolerates_a_failure() {
        let a = FakeTarget::new("a", false, true);
        let b = FakeTarget::new("b", false, false);
        let rep = replicate(&[&a, &b], b"pack", &meta(), 1).await.unwrap();
        assert_eq!(rep.replicas.len(), 1);
        assert_eq!(rep.failures.len(), 1);
    }

    #[tokio::test]
    async fn platform_is_not_paid_for_when_the_policy_is_already_lost() {
        let a = FakeTarget::new("a", false, true);
        let b = FakeTarget::new("b", false, true);
        let chain = FakeTarget::new("platform", true, false);
        let err = replicate(&[&chain, &a, &b], b"pack", &meta(), 2)
            .await
            .unwrap_err();
        assert_eq!(chain.calls.load(Ordering::SeqCst), 0, "no chunk writes");
        assert_eq!(err.skipped, vec!["platform".to_string()]);
    }

    #[tokio::test]
    async fn platform_counts_toward_n_and_runs_after_externals() {
        let a = FakeTarget::new("a", false, false);
        let chain = FakeTarget::new("platform", true, false);
        let rep = replicate(&[&chain, &a], b"pack", &meta(), 2).await.unwrap();
        assert_eq!(rep.replicas[0].target, "a");
        assert_eq!(rep.replicas[1].target, "platform");
        assert!(rep.has_platform() && rep.has_external());
    }

    #[test]
    fn manifest_uris_drop_private_locators_first() {
        let rep = Replication {
            replicas: vec![Replica {
                target: "a".into(),
                uris: vec![
                    Uri(format!("https://h/{}", "x".repeat(40))),
                    Uri(format!("s3://b/{}", "y".repeat(40))),
                ],
                platform: false,
            }],
            failures: vec![],
        };
        assert_eq!(rep.manifest_uris(2600).unwrap().len(), 2);
        let trimmed = rep.manifest_uris(60).unwrap();
        assert_eq!(trimmed.len(), 1);
        assert!(trimmed[0].starts_with("https://"));
        assert!(rep.manifest_uris(10).is_err());
    }

    /// An in-memory backend whose reads can be made to lie.
    struct MemBackend {
        store: std::sync::Mutex<Option<Vec<u8>>>,
        lie: bool,
    }

    #[async_trait::async_trait]
    impl PackBackend for MemBackend {
        fn scheme(&self) -> &'static str {
            "https"
        }
        fn caps(&self) -> crate::backends::Caps {
            crate::backends::Caps::default()
        }
        async fn put(&self, bytes: &[u8], _meta: &PackMeta) -> Result<Vec<Uri>> {
            *self.store.lock().unwrap() = Some(bytes.to_vec());
            Ok(vec![Uri("https://mem/x".into())])
        }
        async fn get(&self, _uri: &Uri, range: Option<ByteRange>) -> Result<Vec<u8>> {
            let mut b = self.store.lock().unwrap().clone().ok_or(Error::NotFound)?;
            if self.lie {
                b[0] ^= 1;
            }
            Ok(match range {
                Some(r) => {
                    b[usize::try_from(r.start).unwrap()..usize::try_from(r.end).unwrap()].to_vec()
                }
                None => b,
            })
        }
        async fn probe(&self, _uri: &Uri) -> Result<crate::backends::Health> {
            let len = self.store.lock().unwrap().as_ref().map(|b| b.len() as u64);
            Ok(crate::backends::Health {
                ok: len.is_some(),
                size: len,
                latency: std::time::Duration::ZERO,
            })
        }
    }

    #[tokio::test]
    async fn external_target_rejects_a_store_that_serves_other_bytes() {
        let honest = ExternalTarget::new(
            "ok",
            Box::new(MemBackend {
                store: std::sync::Mutex::new(None),
                lie: false,
            }),
            None,
            true,
        );
        let m = PackMeta::for_bytes(b"pack-bytes");
        assert!(honest.store(b"pack-bytes", &m).await.is_ok());

        let liar = ExternalTarget::new(
            "liar",
            Box::new(MemBackend {
                store: std::sync::Mutex::new(None),
                lie: true,
            }),
            None,
            true,
        );
        let err = liar.store(b"pack-bytes", &m).await.unwrap_err().to_string();
        assert!(err.contains("do not hash"), "{err}");
    }

    #[tokio::test]
    async fn large_uploads_verify_by_size_and_edges() {
        let big = vec![3u8; usize::try_from(FULL_VERIFY_MAX).unwrap() + 10];
        let m = PackMeta::for_bytes(&big);
        let honest = ExternalTarget::new(
            "ok",
            Box::new(MemBackend {
                store: std::sync::Mutex::new(None),
                lie: false,
            }),
            None,
            true,
        );
        assert!(honest.store(&big, &m).await.is_ok());
        let liar = ExternalTarget::new(
            "liar",
            Box::new(MemBackend {
                store: std::sync::Mutex::new(None),
                lie: true,
            }),
            None,
            true,
        );
        assert!(liar.store(&big, &m).await.is_err());
    }
}
