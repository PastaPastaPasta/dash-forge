//! The survivability drill (roadmap Phase 1 gate, launch criterion 3): any single storage
//! source can disappear and a clone still works from the others, and says which one failed.
//!
//! No chain: a push is recorded offline as in the round trip ([`super::roundtrip_tests`]) — the
//! production builders write the chunk, manifest, config and ref documents into memory — but
//! its packs go through the production replication engine ([`replicate`]) to REAL stores: an
//! S3 bucket on the local S3 fixture (RustFS, standing in for MinIO) and a kubo node, plus the
//! recorded Platform chunks. The manifest records exactly what a push would. A clone then reads
//! every pack through the production reader rule ([`super::read_manifest_copy`]: every recorded
//! copy raced with the gateway list, Platform chunks last), indexes it, folds the refs, and
//! must equal the source.
//!
//! Each scenario publishes repositories whose FIRST storage target is the one about to fail
//! (so the failure is on the read path, not masked by a faster copy), clones once while
//! everything is up (no warning), breaks that source for real, and clones again:
//! - **the bucket is deleted** (its objects, then the bucket): the S3 + IPFS repo is served by
//!   the gateway, the S3 + Platform repo by its chunks;
//! - **the IPFS gateway is stopped** (`docker stop` of the kubo container): the IPFS + S3 repo
//!   is served by the bucket, the IPFS + Platform repo by its chunks.
//!
//! After the break each repo is cloned twice: with the production racer (the data arrives),
//! and with candidates tried one at a time, so the [`Fallback`] warning git-remote-dash prints
//! ([`fallback_lines`]) is exact — it must name the dead source and why.
//!
//! The web host and the relay are not on the clone path at all: every candidate a clone tries
//! is a recorded storage copy or a configured gateway (checked for every pack), and no crate on
//! the read path depends on the relay ([`no_read_path_crate_depends_on_the_relay`], which runs
//! everywhere). The browser side of the drill is `forge-web/lib/view/survivability.drill.test.ts`
//! and the static-host / IPFS-build spec `forge-web/e2e-drill/web-host.spec.ts`.
//!
//! Opt-in (`FORGE_DRILL=1`), because it stops and restarts the kubo container:
//! `make survivability`, or `.github/workflows/survivability.yml`. Endpoints default to
//! `infra/docker-compose.yml`'s (`FORGE_DRILL_S3`, `FORGE_DRILL_KUBO_API`,
//! `FORGE_DRILL_GATEWAY`, `FORGE_DRILL_KUBO_CONTAINER` override them).

use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use super::roundtrip_tests::{
    apply_refs, commit, git, git_manifests, index_pack, init_bare, recorded_chunks, Recorded, OWNER,
};
use super::{public_ref_props, read_manifest_copy, PackManifestInput, StoredArtifact};
use crate::backends::ipfs::{IpfsBackend, IpfsConfig};
use crate::backends::platform::chunk_documents;
use crate::backends::s3::{S3Backend, S3Config, S3Credentials};
use crate::backends::{PackMeta, Uri};
use crate::error::Result;
use crate::scope::DocScope;
use crate::storage::read::{fallback_lines, Fallback};
use crate::storage::{replicate, ExternalTarget, PackReader, StorageProfiles, StorageTarget};

/// The fixture's root key (`infra/docker-compose.yml`, kept from the MinIO fixture).
const S3_KEY: &str = "minioadmin";

/// The drill's scenarios share the stores (one stops kubo): one at a time.
static DRILL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Where the fixture listens.
struct Env {
    s3: String,
    kubo_api: String,
    gateway: String,
    kubo_container: String,
}

impl Env {
    /// The endpoints, or `None` (skip) unless `FORGE_DRILL=1`. Once asked for, a store that
    /// is down fails the drill: it never passes by skipping.
    async fn get() -> Option<Self> {
        if !std::env::var("FORGE_DRILL").is_ok_and(|v| v == "1") {
            eprintln!(
                "SKIP survivability drill: set FORGE_DRILL=1 (it deletes buckets and stops the \
                 kubo container; `make survivability`)"
            );
            return None;
        }
        let var = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
        let env = Self {
            s3: var("FORGE_DRILL_S3", "http://127.0.0.1:9000"),
            kubo_api: var("FORGE_DRILL_KUBO_API", "http://127.0.0.1:5001"),
            gateway: var("FORGE_DRILL_GATEWAY", "http://127.0.0.1:8081"),
            kubo_container: var("FORGE_DRILL_KUBO_CONTAINER", "forge-e2e-kubo"),
        };
        for url in [
            format!("{}/health/ready", env.s3),
            format!("{}/ipfs/bafkqaaa", env.gateway),
        ] {
            assert!(answers(&url).await, "the drill needs {url} (make infra-up)");
        }
        Some(env)
    }

    /// `host:port` of `url`.
    fn host(url: &str) -> String {
        let u = reqwest::Url::parse(url).unwrap();
        format!("{}:{}", u.host_str().unwrap(), u.port().unwrap())
    }
}

/// Whether `url` answers 2xx within a few seconds.
async fn answers(url: &str) -> bool {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    client
        .get(url)
        .send()
        .await
        .is_ok_and(|r| r.status().is_success())
}

// ---------------------------------------------------------------------------------------------
// The sources, and breaking them
// ---------------------------------------------------------------------------------------------

/// A bucket of its own on the S3 fixture: anonymous reads (a public BYO bucket), signed writes.
struct Bucket {
    name: String,
}

impl Bucket {
    async fn create(env: &Env, scenario: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let name = format!("drill-{scenario}-{nanos}");
        let r = s3_admin(env, reqwest::Method::PUT, &format!("/{name}"), &[], b"").await;
        assert!(
            r.status().is_success(),
            "create bucket {name}: {}",
            r.status()
        );
        let policy = format!(
            r#"{{"Version":"2012-10-17","Statement":[{{"Effect":"Allow","Principal":"*","Action":["s3:GetObject"],"Resource":["arn:aws:s3:::{name}/*"]}}]}}"#
        );
        let r = s3_admin(
            env,
            reqwest::Method::PUT,
            &format!("/{name}"),
            &[("policy".into(), String::new())],
            policy.as_bytes(),
        )
        .await;
        assert!(r.status().is_success(), "bucket policy: {}", r.status());
        Self { name }
    }

    /// Delete every object `recs` recorded in this bucket, then the bucket itself — the owner
    /// closing the account, or a lifecycle rule gone wrong.
    async fn delete(&self, env: &Env, recs: &[&Recorded]) {
        let prefix = format!("s3://{}/", self.name);
        let keys: std::collections::BTreeSet<String> = recs
            .iter()
            .flat_map(|r| git_manifests(r))
            .flat_map(|m| m.uris)
            .filter_map(|u| u.strip_prefix(&prefix).map(str::to_string))
            .collect();
        assert!(!keys.is_empty(), "nothing was stored in {}", self.name);
        for key in &keys {
            let r = s3_admin(
                env,
                reqwest::Method::DELETE,
                &format!("/{}/{key}", self.name),
                &[],
                b"",
            )
            .await;
            assert!(r.status().is_success(), "delete {key}: {}", r.status());
        }
        let r = s3_admin(
            env,
            reqwest::Method::DELETE,
            &format!("/{}", self.name),
            &[],
            b"",
        )
        .await;
        assert!(
            r.status().is_success(),
            "delete bucket {}: {}",
            self.name,
            r.status()
        );
    }

    /// The target a push writes this bucket through.
    fn target(&self, env: &Env) -> ExternalTarget {
        ExternalTarget::new(
            "drill-s3",
            Box::new(S3Backend::new(S3Config {
                endpoint: env.s3.clone(),
                region: "us-east-1".into(),
                bucket: self.name.clone(),
                path_style: true,
                public_url: Some(format!("{}/{}", env.s3, self.name)),
                prefix: String::new(),
                credentials: Some(S3Credentials {
                    access_key_id: S3_KEY.into(),
                    secret_access_key: crate::keystore::Secret::new(S3_KEY),
                    session_token: None,
                }),
            })),
            None,
            true,
        )
    }
}

/// A SigV4-signed request to the S3 fixture's API (bucket administration the backend does
/// not offer).
async fn s3_admin(
    env: &Env,
    method: reqwest::Method,
    path: &str,
    query: &[(String, String)],
    body: &[u8],
) -> reqwest::Response {
    use crate::backends::sigv4::{
        canonical_query, sha256_hex, sign_request, AmzDate, RequestToSign, SigningKeys,
    };
    let payload = sha256_hex(body);
    let headers = sign_request(
        &RequestToSign {
            method: method.as_str(),
            host: &Env::host(&env.s3),
            canonical_uri: path,
            query,
            headers: &[],
            payload_hash: &payload,
            region: "us-east-1",
            service: "s3",
            content_sha256_header: true,
        },
        SigningKeys {
            access_key_id: S3_KEY,
            secret_access_key: S3_KEY,
            session_token: None,
        },
        &AmzDate::now(),
    );
    let mut url = format!("{}{path}", env.s3);
    if !query.is_empty() {
        url = format!("{url}?{}", canonical_query(query));
    }
    let mut req = reqwest::Client::new().request(method, url);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    req.body(body.to_vec()).send().await.expect("S3 fixture")
}

/// The kubo target a push writes through, recording its gateway URL (as a profile with a
/// public gateway does) next to `ipfs://`.
fn kubo_target(env: &Env) -> ExternalTarget {
    ExternalTarget::new(
        "drill-kubo",
        Box::new(IpfsBackend::new(IpfsConfig::local(
            &env.kubo_api,
            &env.gateway,
        ))),
        Some(env.gateway.clone()),
        true,
    )
}

/// The kubo container, stopped. [`Self::restart`] starts it and waits until the gateway
/// serves; if the scenario panics first, dropping this still starts it (best effort), so a
/// failed drill never leaves the fixture down.
struct KuboStopped<'e> {
    env: &'e Env,
    started: bool,
}

impl<'e> KuboStopped<'e> {
    async fn stop(env: &'e Env) -> Self {
        docker(&["stop", "-t", "2", &env.kubo_container]);
        let stopped = Self {
            env,
            started: false,
        };
        assert!(
            !answers(&stopped.probe()).await,
            "the gateway still answers after docker stop"
        );
        stopped
    }

    fn probe(&self) -> String {
        format!("{}/ipfs/bafkqaaa", self.env.gateway)
    }

    /// Start kubo again and wait (up to a minute) until its gateway serves: on Linux the
    /// published port accepts connections (docker-proxy) before kubo listens, so only an HTTP
    /// answer counts.
    async fn restart(mut self) {
        docker(&["start", &self.env.kubo_container]);
        self.started = true;
        for _ in 0..120 {
            if answers(&self.probe()).await {
                return;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        panic!(
            "kubo ({}) did not serve again within 60 s of docker start",
            self.env.kubo_container
        );
    }
}

impl Drop for KuboStopped<'_> {
    fn drop(&mut self) {
        if !self.started {
            let _ = std::process::Command::new("docker")
                .args(["start", &self.env.kubo_container])
                .output();
        }
    }
}

fn docker(args: &[&str]) {
    let out = std::process::Command::new("docker")
        .args(args)
        .output()
        .expect("docker (the drill stops and starts the kubo container)");
    assert!(
        out.status.success(),
        "docker {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// The Platform `chunk` tier, recorded: what [`crate::repo::PlatformChunkTarget`] writes.
struct Chunks<'a> {
    rec: &'a Mutex<Recorded>,
    scope: &'a DocScope,
}

#[async_trait::async_trait]
impl StorageTarget for Chunks<'_> {
    fn name(&self) -> &str {
        crate::storage::PLATFORM_PROFILE
    }

    fn is_platform(&self) -> bool {
        true
    }

    async fn store(&self, bytes: &[u8], meta: &PackMeta) -> Result<Vec<Uri>> {
        let mut rec = self.rec.lock().unwrap();
        for (_, props) in chunk_documents(bytes, meta.pack_hash_bytes()?) {
            rec.create("chunk", self.scope.scoped(props));
        }
        let owner = crate::platform::encode_identifier(OWNER);
        Ok(vec![Uri(self.scope.locator(&owner, &meta.pack_hash))])
    }
}

// ---------------------------------------------------------------------------------------------
// Push and clone
// ---------------------------------------------------------------------------------------------

/// Where a repository's packs go, in policy order (the first is the reader's first choice).
#[derive(Clone, Copy, Debug)]
enum Store {
    S3,
    Ipfs,
    Platform,
}

/// A repository pushed to its stores: the source, and what Platform holds.
struct Published {
    label: &'static str,
    src: tempfile::TempDir,
    scope: DocScope,
    rec: Recorded,
}

/// Push a small history (`main` + an annotated tag, then an incremental push moving `main`)
/// with every pack replicated to all of `stores` (N = all must confirm).
async fn publish(
    env: &Env,
    bucket: &Bucket,
    label: &'static str,
    repo_id: u8,
    stores: &[Store],
) -> Published {
    let src = tempfile::TempDir::new().unwrap();
    let s = src.path();
    let scope = DocScope {
        contract_id: "CORE".into(),
        repo_id: [repo_id; 32],
    };
    let rec = Mutex::new(Recorded::default());
    let s3 = bucket.target(env);
    let kubo = kubo_target(env);
    let chunks = Chunks {
        rec: &rec,
        scope: &scope,
    };
    let targets: Vec<&dyn StorageTarget> = stores
        .iter()
        .map(|st| -> &dyn StorageTarget {
            match st {
                Store::S3 => &s3,
                Store::Ipfs => &kubo,
                Store::Platform => &chunks,
            }
        })
        .collect();
    let config = crate::create::config_props(&crate::create::CreateRepoOpts::public(label));
    rec.lock().unwrap().create("config", scope.scoped(config));

    git(s, &["init", "-q", "-b", "main"]);
    commit(s, "README.md", &format!("# {label}\n"), "c1");
    let c2 = commit(s, "data.txt", &format!("{label}\n").repeat(400), "c2");
    git(s, &["tag", "-a", "v1.0", "-m", "v1.0"]);
    let tag = git(s, &["rev-parse", "refs/tags/v1.0"]);
    push(
        &rec,
        &scope,
        &targets,
        s,
        &[&c2, &tag],
        &[],
        &[
            ("refs/heads/main", &c2, None),
            ("refs/tags/v1.0", &tag, None),
        ],
    )
    .await;
    let c3 = commit(s, "data.txt", &format!("{label} v2\n").repeat(399), "c3");
    push(
        &rec,
        &scope,
        &targets,
        s,
        &[&c3],
        &[&c2],
        &[("refs/heads/main", &c3, Some(&c2))],
    )
    .await;
    drop(targets);
    Published {
        label,
        src,
        scope,
        rec: rec.into_inner().unwrap(),
    }
}

/// One push: the pack of `wants` over `haves` replicated to `targets`, its manifest, and a ref
/// update per `(name, new, prev)`.
async fn push(
    rec: &Mutex<Recorded>,
    scope: &DocScope,
    targets: &[&dyn StorageTarget],
    src: &Path,
    wants: &[&str],
    haves: &[&str],
    refs: &[(&str, &str, Option<&str>)],
) {
    let pack = crate::pack::build_pack(src, wants, haves).unwrap();
    let meta = PackMeta::for_bytes(&pack.bytes);
    let replication = replicate(targets, &pack.bytes, &meta, targets.len())
        .await
        .unwrap_or_else(|e| panic!("replicate: {e}"));
    let stored = StoredArtifact::from_replication(&replication, &pack.bytes).unwrap();
    let manifest = PackManifestInput {
        pack_hash: meta.pack_hash_bytes().unwrap(),
        kind: u64::from(crate::pack::KIND_GIT_PACK),
        size_bytes: pack.bytes.len() as u64,
        object_count: pack.parsed.object_count() as u64,
        chunk_count: stored.chunk_count,
        storage: stored.storage,
        uris: stored.uris,
        supersedes: Vec::new(),
        tips: Vec::new(),
    };
    let mut rec = rec.lock().unwrap();
    rec.create("packManifest", manifest.props(scope).unwrap());
    for (name, new, prev) in refs {
        let new = hex::decode(new).unwrap();
        let prev = prev.map(|p| hex::decode(p).unwrap());
        let props = public_ref_props(scope, name, &new, prev.as_deref(), false).unwrap();
        rec.create("refUpdate", props);
    }
}

/// A reader configured as the repo owner's machine would be: the drill bucket as an S3 profile
/// (its public URL is on the loopback fixture, so it must be a configured origin to be
/// followed) and the fixture's gateway as the read gateway list.
fn reader(env: &Env, bucket: &Bucket) -> PackReader {
    let profiles = StorageProfiles::parse(&format!(
        "[profiles.drill-s3]\nkind = \"s3\"\nendpoint = \"{s3}\"\nbucket = \"{b}\"\n\
         public_url = \"{s3}/{b}\"\n",
        s3 = env.s3,
        b = bucket.name
    ))
    .unwrap();
    PackReader::new(vec![env.gateway.clone()], &profiles)
        .with_first_byte_budget(Duration::from_secs(10))
        .with_candidate_timeout(Duration::from_secs(30))
}

/// Clone `p` through `reader` into a fresh repository and check it equals the source; the
/// [`Fallback`]s the reads recorded. Every candidate a pack read could contact must be a
/// recorded copy or the configured gateway: nothing else (no web host, no relay) is on the
/// path.
async fn clone(env: &Env, p: &Published, reader: &PackReader) -> Vec<Fallback> {
    let allowed = [
        Env::host(&env.s3),
        "S3 profile drill-s3".to_string(),
        format!("IPFS gateway {}", Env::host(&env.gateway)),
    ];
    let dst = tempfile::TempDir::new().unwrap();
    init_bare(dst.path());
    for m in git_manifests(&p.rec) {
        for place in reader.candidate_places(&m.uris) {
            assert!(
                allowed.contains(&place),
                "{}: a clone would contact {place}, which is not a storage copy",
                p.label
            );
        }
        let own = Uri(p.scope.locator(&m.owner_id, &hex::encode(m.pack_hash)));
        let bytes = read_manifest_copy(&m, &own, reader, |loc| {
            std::future::ready(recorded_chunks(&p.rec, &loc).map(|(b, _)| b))
        })
        .await
        .unwrap_or_else(|e| panic!("{}: pack unreadable: {e}", p.label));
        index_pack(dst.path(), &bytes);
    }
    apply_refs(&p.rec, dst.path());
    let src = p.src.path();
    git(dst.path(), &["fsck", "--strict", "--no-dangling"]);
    for r in ["refs/heads/main", "refs/tags/v1.0"] {
        assert_eq!(
            git(dst.path(), &["rev-parse", r]),
            git(src, &["rev-parse", r]),
            "{}: {r}",
            p.label
        );
    }
    let work = tempfile::TempDir::new().unwrap();
    let w = work.path().join("clone");
    git(
        work.path(),
        &[
            "clone",
            "-q",
            &dst.path().to_string_lossy(),
            &w.to_string_lossy(),
        ],
    );
    assert_eq!(
        std::fs::read_to_string(w.join("data.txt")).unwrap(),
        std::fs::read_to_string(src.join("data.txt")).unwrap(),
        "{}",
        p.label
    );
    reader.take_fallbacks()
}

/// Before a break: both readers clone `p` from its first choice, and say nothing.
async fn clone_before_break(env: &Env, bucket: &Bucket, p: &Published) {
    for sequential in [false, true] {
        let r = reader(env, bucket);
        let r = if sequential { r.sequential() } else { r };
        let fallbacks = clone(env, p, &r).await;
        assert_eq!(fallbacks, [], "{}: nothing is down yet", p.label);
    }
}

/// After a break: the production racer still clones `p`, and one-at-a-time reads record, for
/// every pack, that `served_by` served it and that `failed` (each a prefix of one `place (why)`)
/// did not. (The racer records the same, or nothing when the copy served before the dead one
/// answered — never anything else.) Returns the warning lines git-remote-dash prints for it.
async fn clone_after_break(
    env: &Env,
    bucket: &Bucket,
    p: &Published,
    served_by: &str,
    failed: &[&str],
) -> Vec<String> {
    // `exact`: one at a time, so the copy that serves is the first live one. Racing, any live
    // copy may win (the bucket's public URL or its S3 profile), but the failures are the same.
    let check = |f: &Fallback, exact: bool| {
        if exact {
            assert_eq!(f.served_by, served_by, "{}: {f}", p.label);
        }
        assert_eq!(f.failed.len(), failed.len(), "{}: {f}", p.label);
        // In any order: racing copies fail in whichever order they answer.
        for want in failed {
            assert!(
                f.failed.iter().any(|got| got.starts_with(want)),
                "{}: nothing in {:?} is {want:?}…",
                p.label,
                f.failed
            );
        }
    };
    for f in clone(env, p, &reader(env, bucket)).await {
        check(&f, false);
    }
    let fallbacks = clone(env, p, &reader(env, bucket).sequential()).await;
    let packs = git_manifests(&p.rec);
    assert_eq!(
        fallbacks.len(),
        packs.len(),
        "{}: every pack came from a fallback copy: {fallbacks:#?}",
        p.label
    );
    for (f, m) in fallbacks.iter().zip(&packs) {
        assert_eq!(f.pack, hex::encode(m.pack_hash), "{}", p.label);
        check(f, true);
    }
    let lines = fallback_lines(&fallbacks, p.label);
    for line in &lines {
        eprintln!("{}: dash: {line}", p.label);
    }
    lines
}

// ---------------------------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_deleted_bucket_is_survived_by_the_ipfs_and_platform_copies() {
    let Some(env) = Env::get().await else { return };
    let _one_at_a_time = DRILL.lock().await;
    let bucket = Bucket::create(&env, "bucket").await;
    let s3_ipfs = publish(&env, &bucket, "s3-ipfs", 1, &[Store::S3, Store::Ipfs]).await;
    let s3_chain = publish(&env, &bucket, "s3-chain", 2, &[Store::S3, Store::Platform]).await;
    for p in [&s3_ipfs, &s3_chain] {
        clone_before_break(&env, &bucket, p).await;
    }

    bucket.delete(&env, &[&s3_ipfs.rec, &s3_chain.rec]).await;

    // A deleted bucket answers an anonymous read 404 (AWS: NoSuchBucket) or 403 (RustFS, and
    // AWS when the caller may not list): either way the copy is gone, and the line says which.
    let gone = |line: &str, place: &str| {
        ["not found)", "HTTP 403", "HTTP 404"]
            .iter()
            .any(|why| line.contains(&format!("{place} ({}", why.trim_end_matches(')'))))
    };
    let s3 = Env::host(&env.s3);
    let gateway = format!("IPFS gateway {}", Env::host(&env.gateway));
    let lines = clone_after_break(&env, &bucket, &s3_ipfs, &gateway, &[&format!("{s3} (")]).await;
    assert!(
        lines[0].starts_with("warning: pack ")
            && lines[0].contains(&format!("read from {gateway}; unavailable: {s3} ("))
            && gone(&lines[0], &s3),
        "{lines:?}"
    );
    assert!(
        lines
            .last()
            .unwrap()
            .contains("`dg storage status s3-ipfs`"),
        "{lines:?}"
    );
    let lines = clone_after_break(
        &env,
        &bucket,
        &s3_chain,
        "Platform chunks",
        &[&format!("{s3} ("), "S3 profile drill-s3 ("],
    )
    .await;
    assert!(
        lines[0].contains(&format!("read from Platform chunks; unavailable: {s3} ("))
            && gone(&lines[0], &s3)
            && gone(&lines[0], "S3 profile drill-s3"),
        "{lines:?}"
    );
}

#[tokio::test]
async fn a_stopped_ipfs_gateway_is_survived_by_the_s3_and_platform_copies() {
    let Some(env) = Env::get().await else { return };
    let _one_at_a_time = DRILL.lock().await;
    let bucket = Bucket::create(&env, "gateway").await;
    let ipfs_s3 = publish(&env, &bucket, "ipfs-s3", 3, &[Store::Ipfs, Store::S3]).await;
    let ipfs_chain = publish(
        &env,
        &bucket,
        "ipfs-chain",
        4,
        &[Store::Ipfs, Store::Platform],
    )
    .await;
    for p in [&ipfs_s3, &ipfs_chain] {
        clone_before_break(&env, &bucket, p).await;
    }

    let kubo = KuboStopped::stop(&env).await;
    let gateway = format!("IPFS gateway {}", Env::host(&env.gateway));
    let dead = format!("{gateway} (could not connect");
    let lines = clone_after_break(&env, &bucket, &ipfs_s3, &Env::host(&env.s3), &[&dead]).await;
    assert!(
        lines[0].contains(&format!(
            "read from {}; unavailable: {gateway} (could not connect",
            Env::host(&env.s3)
        )),
        "{lines:?}"
    );
    let lines = clone_after_break(&env, &bucket, &ipfs_chain, "Platform chunks", &[&dead]).await;
    assert!(
        lines[0].contains(&format!(
            "read from Platform chunks; unavailable: {gateway} (could not connect"
        )),
        "{lines:?}"
    );
    kubo.restart().await;
    bucket.delete(&env, &[&ipfs_s3.rec, &ipfs_chain.rec]).await;
}

/// The relay delivers webhooks; nothing a clone or a browse reads goes through it, so a dead
/// relay cannot take either down. Held by the dependency graph: nothing on the read path — the
/// helper, `dg`, forge-core — links the relay, directly or through another crate (the resolved
/// graph from `cargo metadata`, normal and build dependencies). The web app has no relay client.
#[test]
fn no_read_path_crate_depends_on_the_relay() {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let out = std::process::Command::new(cargo)
        .args(["metadata", "--format-version", "1", "--locked", "--offline"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("cargo metadata");
    assert!(
        out.status.success(),
        "cargo metadata: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let meta: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let member = |name: &str| -> String {
        meta["packages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["name"] == name && p["source"].is_null())
            .unwrap_or_else(|| panic!("workspace member {name}"))["id"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let relay = member("forge-relay");
    let nodes: std::collections::BTreeMap<&str, &serde_json::Value> = meta["resolve"]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| (n["id"].as_str().unwrap(), n))
        .collect();
    for root in ["forge-core", "git-remote-dash", "dg"] {
        let mut todo = vec![member(root)];
        let mut seen = std::collections::BTreeSet::new();
        while let Some(id) = todo.pop() {
            assert_ne!(
                id, relay,
                "{root} links forge-relay: a dead relay would be on the read path"
            );
            if !seen.insert(id.clone()) {
                continue;
            }
            for dep in nodes[id.as_str()]["deps"].as_array().unwrap() {
                // Normal (`kind` null) and build dependencies ship; dev ones do not.
                let ships = dep["dep_kinds"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|k| k["kind"].is_null() || k["kind"] == "build");
                if ships {
                    todo.push(dep["pkg"].as_str().unwrap().to_string());
                }
            }
        }
        assert!(
            seen.len() > 10,
            "{root}: only {} crates walked; is the graph read?",
            seen.len()
        );
    }
}
