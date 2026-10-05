//! End to end over a real listener with a stub [`Upstream`]: a local git repository plays
//! Platform (its refs are the "proved" snapshot, a `git fetch` from it plays git-remote-dash).
//! A stock `git` client clones, fetches and is refused a push; the manifest checks out with
//! `forge_core::mirror::compare`; Platform going down leaves the mirror serving.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use forge_core::mirror::{compare, parse_ls_remote, Manifest, ManifestPack, Verdict};
use forge_core::platform::ChainTip;
use forge_core::repo::{RefRecord, RefTip};
use forge_gateway::metrics::Metrics;
use forge_gateway::mirror::{Mirrors, Unavailable};
use forge_gateway::upstream::{
    Check, FetchSource, IssueEntry, ReleaseEntry, RepoInfo, Snapshot, Upstream,
};
use forge_gateway::{router, AppState, Config};

/// "Platform": repositories by `owner/name`, each backed by a local git repository.
#[derive(Default)]
struct World {
    repos: BTreeMap<(String, String), (RepoInfo, PathBuf)>,
    down: bool,
    pack_bytes: u64,
    time_ms: u64,
    /// Snapshots read.
    snapshots: usize,
}

#[derive(Clone, Default)]
struct Stub(Arc<Mutex<World>>);

impl Stub {
    fn world(&self) -> std::sync::MutexGuard<'_, World> {
        self.0.lock().unwrap()
    }

    fn add(&self, owner: &str, name: &str, public: bool, src: &Path) -> RepoInfo {
        let info = RepoInfo {
            repo_id: format!("R{name}{owner}"),
            owner_id: format!("O{owner}"),
            name: name.into(),
            public,
        };
        self.world().repos.insert(
            (owner.into(), name.into()),
            (info.clone(), src.to_path_buf()),
        );
        info
    }

    fn src(&self, repo: &RepoInfo) -> Result<PathBuf> {
        let w = self.world();
        if w.down {
            return Err(anyhow!("Platform is down"));
        }
        w.repos
            .values()
            .find(|(i, _)| i.repo_id == repo.repo_id)
            .map(|(_, p)| p.clone())
            .ok_or_else(|| anyhow!("no such repo"))
    }
}

#[async_trait]
impl Upstream for Stub {
    fn network(&self) -> String {
        "devnet-stub".into()
    }
    fn forge_core(&self) -> String {
        "CoreContract".into()
    }
    async fn resolve(&self, owner: &str, name: &str) -> Result<Option<RepoInfo>> {
        let w = self.world();
        if w.down {
            return Err(anyhow!("Platform is down"));
        }
        Ok(w.repos
            .get(&(owner.to_string(), name.to_string()))
            .map(|(i, _)| i.clone()))
    }
    async fn snapshot(&self, repo: &RepoInfo) -> Result<Snapshot> {
        let src = self.src(repo)?;
        let (time_ms, pack_bytes) = {
            let mut w = self.world();
            w.snapshots += 1;
            (w.time_ms, w.pack_bytes)
        };
        let refs = git_out(&src, &["for-each-ref", "--format=%(objectname) %(refname)"]);
        let records = refs
            .lines()
            .filter_map(|l| l.split_once(' '))
            .map(|(oid, name)| RefRecord {
                name: name.into(),
                tip: Some(RefTip {
                    name: name.into(),
                    oid: oid.into(),
                    ref_update_id: format!("U-{name}"),
                    document_type: "refUpdate".into(),
                    created_at: time_ms,
                    diverged: false,
                }),
                tips_ever: [oid.to_string()].into(),
                changed_at: time_ms,
            })
            .collect();
        Ok(Snapshot {
            records,
            default_branch: Some("main".into()),
            tip: ChainTip {
                height: 7,
                time_ms: time_ms + 1,
            },
            packs: vec![ManifestPack {
                pack_hash: "00".into(),
                copies: 1,
                size_bytes: pack_bytes,
            }],
        })
    }
    fn fetch_source(&self, repo: &RepoInfo) -> FetchSource {
        FetchSource {
            url: self
                .src(repo)
                .map(|p| p.display().to_string())
                .unwrap_or_default(),
            ..FetchSource::default()
        }
    }
    async fn description(&self, repo: &RepoInfo) -> Result<String> {
        self.src(repo)?;
        Ok("A <test> repository".into())
    }
    async fn stars(&self, repo: &RepoInfo) -> Result<u64> {
        self.src(repo)?;
        Ok(42)
    }
    async fn open_issues(&self, repo: &RepoInfo) -> Result<u64> {
        self.src(repo)?;
        Ok(3)
    }
    async fn checks(&self, repo: &RepoInfo, _oid: &str) -> Result<Vec<Check>> {
        self.src(repo)?;
        Ok(vec![Check {
            name: "build".into(),
            status: "completed".into(),
            conclusion: "success".into(),
            trusted: true,
        }])
    }
    async fn releases(&self, repo: &RepoInfo) -> Result<Vec<ReleaseEntry>> {
        self.src(repo)?;
        Ok(vec![ReleaseEntry {
            tag: "v1.0.0".into(),
            name: "First".into(),
            notes: "notes & more".into(),
            created_at: 1_700_000_000_000,
            yanked: false,
            document_id: "Rel1".into(),
        }])
    }
    async fn issues(&self, repo: &RepoInfo, _limit: usize) -> Result<Vec<IssueEntry>> {
        self.src(repo)?;
        Ok(vec![IssueEntry {
            number: 1,
            title: "It <breaks>".into(),
            author: "Alice".into(),
            created_at: 1_700_000_000_000,
            document_id: "Iss1".into(),
        }])
    }
}

fn git(dir: &Path, args: &[&str]) -> std::process::Output {
    Command::new("git")
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .args(args)
        .output()
        .expect("git runs")
}

fn git_out(dir: &Path, args: &[&str]) -> String {
    let o = git(dir, args);
    assert!(
        o.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&o.stderr)
    );
    String::from_utf8(o.stdout).unwrap()
}

/// A source repository with `main` (two commits), `feature` and an annotated tag.
fn source(dir: &Path) -> PathBuf {
    let src = dir.join("src");
    std::fs::create_dir_all(&src).unwrap();
    git_out(&src, &["init", "-q", "-b", "main"]);
    for i in 0..2 {
        std::fs::write(src.join("f.txt"), format!("v{i}\n")).unwrap();
        git_out(&src, &["add", "f.txt"]);
        git_out(&src, &["commit", "-q", "-m", &format!("commit {i}")]);
    }
    git_out(&src, &["branch", "feature"]);
    git_out(&src, &["tag", "-a", "v1.0.0", "-m", "v1"]);
    src
}

struct Gateway {
    base: String,
    stub: Stub,
    mirrors: Arc<Mirrors>,
    _tmp: tempfile::TempDir,
    tmp: PathBuf,
}

async fn start(tune: impl FnOnce(&mut Config)) -> Gateway {
    let tmp = tempfile::tempdir().unwrap();
    let mut cfg = Config::for_tests(tmp.path().join("data"));
    tune(&mut cfg);
    let cfg = Arc::new(cfg);
    let stub = Stub::default();
    stub.world().time_ms = 1_000;
    let metrics = Arc::new(Metrics::default());
    let mirrors = Arc::new(
        Mirrors::new(
            Arc::clone(&cfg),
            Arc::new(stub.clone()),
            Arc::clone(&metrics),
        )
        .unwrap(),
    );
    let state = Arc::new(AppState::new(
        Arc::clone(&cfg),
        Arc::clone(&mirrors),
        metrics,
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(
            listener,
            router(state).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    Gateway {
        base: format!("http://{addr}"),
        stub,
        mirrors,
        tmp: tmp.path().to_path_buf(),
        _tmp: tmp,
    }
}

impl Gateway {
    async fn get(&self, path: &str) -> (u16, String, String) {
        let r = reqwest::get(format!("{}{path}", self.base)).await.unwrap();
        let status = r.status().as_u16();
        let ct = r
            .headers()
            .get("content-type")
            .map(|v| v.to_str().unwrap().to_string())
            .unwrap_or_default();
        (status, ct, r.text().await.unwrap_or_default())
    }

    /// `git` in a blocking thread (the server runs on this runtime).
    async fn git(&self, dir: PathBuf, args: Vec<String>) -> std::process::Output {
        tokio::task::spawn_blocking(move || {
            let a: Vec<&str> = args.iter().map(String::as_str).collect();
            git(&dir, &a)
        })
        .await
        .unwrap()
    }

    async fn clone(&self, url_path: &str, into: &str) -> std::process::Output {
        self.git(
            self.tmp.clone(),
            vec![
                "clone".into(),
                "-q".into(),
                format!("{}{url_path}", self.base),
                into.into(),
            ],
        )
        .await
    }

    async fn manifest(&self, path: &str) -> Manifest {
        let (status, _, body) = self.get(&format!("{path}/forge-manifest.json")).await;
        assert_eq!(status, 200, "{body}");
        serde_json::from_str(&body).unwrap()
    }

    /// Refresh `owner/name` now and wait for it: `None` on success.
    async fn refresh(&self, info: &RepoInfo) -> Option<Unavailable> {
        let slot = self.mirrors.slot(info);
        tokio::time::timeout(Duration::from_secs(60), self.mirrors.refresh_wait(&slot))
            .await
            .expect("the refresh ends")
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn plain_git_clones_a_verifiable_read_only_mirror() {
    let gw = start(|_| {}).await;
    let src = source(&gw.tmp);
    let records_src = src.clone();
    gw.stub.add("alice", "proj", true, &src);

    let out = gw.clone("/alice/proj.git", "clone").await;
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let cloned = gw.tmp.join("clone");
    assert_eq!(
        git_out(&cloned, &["rev-parse", "HEAD"]),
        git_out(&src, &["rev-parse", "main"])
    );
    assert_eq!(
        git_out(&cloned, &["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
        "main"
    );

    // The advertisement is exactly the snapshot: no staging refs.
    let ls = gw
        .git(
            gw.tmp.clone(),
            vec!["ls-remote".into(), format!("{}/alice/proj.git", gw.base)],
        )
        .await;
    let ls = String::from_utf8(ls.stdout).unwrap();
    assert!(!ls.contains("forge-gateway"), "{ls}");
    let served = parse_ls_remote(&ls);
    assert_eq!(served.len(), 3, "{ls}");

    // The manifest names the snapshot, and checks out against the "proved" refs.
    let m = gw.manifest("/alice/proj.git").await;
    assert_eq!(m.network, "devnet-stub");
    assert_eq!(m.repo_id, "Rprojalice");
    assert_eq!(m.default_branch.as_deref(), Some("main"));
    assert_eq!(m.platform_height, 7);
    assert!(m
        .refs
        .iter()
        .all(|r| r.ref_update_id == format!("U-{}", r.name)));
    let records = gw
        .stub
        .snapshot(&gw.stub.resolve("alice", "proj").await.unwrap().unwrap())
        .await
        .unwrap()
        .records;
    let c = compare(&served, &records, Some(m.platform_time_ms));
    assert_eq!(c.verdict, Verdict::Match, "{c:?}");
    drop(records_src);

    // Read only: a push is refused.
    let push = gw
        .git(
            cloned.clone(),
            vec![
                "push".into(),
                "origin".into(),
                "HEAD:refs/heads/evil".into(),
            ],
        )
        .await;
    assert!(!push.status.success());
    assert!(
        String::from_utf8_lossy(&push.stderr).contains("403"),
        "{}",
        String::from_utf8_lossy(&push.stderr)
    );

    // Smart HTTP only: no dumb file serving.
    let (s, _, _) = gw.get("/alice/proj.git/info/refs").await;
    assert_eq!(s, 403);
    let (s, _, _) = gw.get("/alice/proj.git/HEAD").await;
    assert_eq!(s, 404);
    let (s, _, _) = gw.get("/alice/proj.git/objects/info/packs").await;
    assert_eq!(s, 404);
    // The bare path redirects to the web app.
    let r = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
        .get(format!("{}/alice/proj", gw.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 302);
    assert_eq!(
        r.headers()["location"],
        "https://forge.dashhq.org/alice/proj"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refresh_follows_platform_and_platform_down_keeps_serving() {
    let gw = start(|_| {}).await;
    let src = source(&gw.tmp);
    let info = gw.stub.add("alice", "proj", true, &src);
    assert!(gw.clone("/alice/proj.git", "c1").await.status.success());

    // Platform moves: a new commit on main, and `feature` is deleted.
    std::fs::write(src.join("f.txt"), "v9\n").unwrap();
    git_out(&src, &["commit", "-q", "-am", "commit 9"]);
    git_out(&src, &["branch", "-D", "feature"]);
    gw.stub.world().time_ms = 5_000;
    assert_eq!(gw.refresh(&info).await, None);
    let c1 = gw.tmp.join("c1");
    let fetch = gw
        .git(
            c1.clone(),
            vec!["fetch".into(), "-q".into(), "--prune".into()],
        )
        .await;
    assert!(
        fetch.status.success(),
        "{}",
        String::from_utf8_lossy(&fetch.stderr)
    );
    assert_eq!(
        git_out(&c1, &["rev-parse", "origin/main"]),
        git_out(&src, &["rev-parse", "main"])
    );
    assert!(!git_out(&c1, &["branch", "-r"]).contains("feature"));
    let m = gw.manifest("/alice/proj.git").await;
    assert_eq!(m.refs.len(), 2);
    assert_eq!(m.platform_time_ms, 5_001);

    // Badges and feeds render while Platform is up.
    let (s, ct, body) = gw.get("/badge/alice/proj/stars.svg").await;
    assert_eq!((s, ct.as_str()), (200, "image/svg+xml; charset=utf-8"));
    assert!(body.contains(">42<"), "{body}");

    // Platform goes down: the mirror keeps serving its last snapshot.
    gw.stub.world().down = true;
    assert!(matches!(
        gw.refresh(&info).await,
        Some(Unavailable::Failed(_))
    ));
    assert!(gw.clone("/alice/proj.git", "c2").await.status.success());
    assert_eq!(gw.manifest("/alice/proj.git").await.platform_time_ms, 5_001);
    // A cached badge is served stale; an uncached one says "unavailable".
    let (s, _, body) = gw.get("/badge/alice/proj/stars.svg").await;
    assert_eq!(s, 200);
    assert!(body.contains(">42<"));
    let (s, _, body) = gw.get("/badge/alice/proj/issues.svg").await;
    assert_eq!(s, 200);
    assert!(body.contains("unavailable"), "{body}");
    // A repository never resolved cannot be looked up: unavailable, not "not found".
    let (s, _, body) = gw.get("/badge/alice/other/stars.svg").await;
    assert_eq!(s, 503);
    assert!(
        body.contains("unavailable") && !body.contains("not found"),
        "{body}"
    );
    let (s, _, _) = gw.get("/readyz").await;
    assert_eq!(s, 503);
    let (s, _, metrics) = gw.get("/metrics").await;
    assert_eq!(s, 200);
    assert!(
        metrics.contains("forge_gateway_refresh_failed_total 1"),
        "{metrics}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn private_unknown_and_oversized_repos_are_refused() {
    let gw = start(|c| c.repo_max_bytes = 1 << 20).await;
    let src = source(&gw.tmp);
    gw.stub.add("alice", "secret", false, &src);
    gw.stub.add("alice", "big", true, &src);

    for path in [
        "/alice/secret.git/info/refs?service=git-upload-pack",
        "/alice/secret.git/forge-manifest.json",
        "/alice/nothing.git/info/refs?service=git-upload-pack",
    ] {
        let (s, _, body) = gw.get(path).await;
        assert_eq!(s, 404, "{path}: {body}");
        assert!(body.contains("no public repository"), "{body}");
    }
    let out = gw.clone("/alice/secret.git", "s").await;
    assert!(!out.status.success());
    assert!(!gw
        .tmp
        .join("data/mirrors/devnet-stub/Rsecretalice.git")
        .exists());

    gw.stub.world().pack_bytes = 2 << 20;
    let (s, _, body) = gw
        .get("/alice/big.git/info/refs?service=git-upload-pack")
        .await;
    assert_eq!(s, 403, "{body}");
    assert!(body.contains("larger than this gateway mirrors"), "{body}");
    let out = gw.clone("/alice/big.git", "b").await;
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success());
    assert!(
        err.contains("larger than this gateway mirrors") || err.contains("403"),
        "{err}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn badges_feeds_and_previews() {
    let gw = start(|_| {}).await;
    let src = source(&gw.tmp);
    gw.stub.add("alice", "proj", true, &src);

    let (s, ct, body) = gw.get("/badge/alice/proj/ci.json").await;
    assert_eq!((s, ct.as_str()), (200, "application/json"));
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["message"], "passing");
    let (_, _, body) = gw.get("/badge/alice/proj/release.svg").await;
    assert!(body.contains("v1.0.0"));
    let (s, _, body) = gw.get("/badge/alice/nope/stars.svg").await;
    assert_eq!(s, 404);
    assert!(body.contains("repo not found"));
    let (s, _, _) = gw.get("/badge/alice/proj/bogus.svg").await;
    assert_eq!(s, 404);

    let (s, ct, body) = gw.get("/feed/alice/proj/releases.atom").await;
    assert_eq!(
        (s, ct.as_str()),
        (200, "application/atom+xml; charset=utf-8")
    );
    assert!(body.contains("<title>First</title>"));
    assert!(body.contains("https://forge.dashhq.org/alice/proj/releases/tag/v1.0.0"));
    assert!(body.contains("notes &amp; more"));
    let (_, _, body) = gw.get("/feed/alice/proj/issues.atom").await;
    assert!(body.contains("#1 It &lt;breaks&gt;"));
    let (s, _, body) = gw.get("/feed/alice/proj/commits.atom").await;
    assert_eq!(s, 200, "{body}");
    assert!(body.contains("<title>commit 1</title>"), "{body}");
    assert!(body.contains(&format!(
        "https://forge.dashhq.org/alice/proj/commit/{}",
        git_out(&src, &["rev-parse", "main"]).trim()
    )));

    let (s, ct, body) = gw.get("/og/alice/proj").await;
    assert_eq!((s, ct.as_str()), (200, "text/html; charset=utf-8"));
    assert!(body.contains("og:image\" content=\"http://127.0.0.1:8080/og/alice/proj.png\""));
    assert!(body.contains("A &lt;test&gt; repository"));
    let r = reqwest::get(format!("{}/og/alice/proj.png", gw.base))
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 200);
    assert_eq!(r.headers()["content-type"], "image/png");
    assert_eq!(&r.bytes().await.unwrap()[..4], b"\x89PNG");
}

#[tokio::test(flavor = "multi_thread")]
async fn limits_and_eviction() {
    let gw = start(|c| {
        c.rate_per_min = 5;
        c.cache_max_bytes = 1;
    })
    .await;
    let src = source(&gw.tmp);
    let a = gw.stub.add("alice", "a", true, &src);
    let b = gw.stub.add("alice", "b", true, &src);
    assert_eq!(gw.refresh(&a).await, None);
    assert_eq!(gw.refresh(&b).await, None);
    // Over the cap: the least recently served mirror went (a refresh holds its own).
    tokio::time::sleep(Duration::from_millis(300)).await;
    gw.mirrors.evict().await;
    let dirs = std::fs::read_dir(gw.tmp.join("data/mirrors/devnet-stub"))
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().ends_with(".git"))
        .count();
    assert_eq!(
        dirs, 0,
        "every unserved mirror over a 1-byte cap is evicted"
    );

    // The per-client rate limit answers 429 with Retry-After.
    let mut limited = None;
    for _ in 0..10 {
        let r = reqwest::get(format!("{}/badge/alice/a/stars.svg", gw.base))
            .await
            .unwrap();
        if r.status().as_u16() == 429 {
            limited = Some(r);
            break;
        }
    }
    let r = limited.expect("rate limited");
    assert!(r.headers().contains_key("retry-after"));
    // Health probes are never limited.
    let (s, _, _) = gw.get("/healthz").await;
    assert_eq!(s, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_trickling_its_request_body_holds_no_gateway_slot() {
    use tokio::io::AsyncWriteExt as _;
    let gw = start(|c| c.clones_max = 1).await;
    let src = source(&gw.tmp);
    let info = gw.stub.add("alice", "proj", true, &src);
    assert_eq!(gw.refresh(&info).await, None);

    // A request that announces a body and never finishes sending it.
    let addr = gw.base.trim_start_matches("http://");
    let mut slow = tokio::net::TcpStream::connect(addr).await.unwrap();
    slow.write_all(
        format!(
            "POST /alice/proj.git/git-upload-pack HTTP/1.1\r\nhost: {addr}\r\n\
             content-type: application/x-git-upload-pack-request\r\n\
             content-length: 1000\r\n\r\n0032want"
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;

    // The only clone slot is still free for a real clone.
    let out = gw.clone("/alice/proj.git", "clone").await;
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    drop(slow);
}

#[tokio::test(flavor = "multi_thread")]
async fn badges_for_branches_a_repo_lacks_read_platform_once() {
    let gw = start(|_| {}).await;
    let src = source(&gw.tmp);
    gw.stub.add("alice", "proj", true, &src);

    let (s, _, body) = gw.get("/badge/alice/proj/ci.json?branch=feature").await;
    assert_eq!(s, 200, "{body}");
    assert!(body.contains("passing"), "{body}");
    assert_eq!(gw.stub.world().snapshots, 1);
    for n in 0..5 {
        let (s, _, body) = gw
            .get(&format!("/badge/alice/proj/ci.json?branch=nope{n}"))
            .await;
        assert_eq!(s, 200, "{body}");
        assert!(body.contains("no branch"), "{body}");
    }
    // Other badges ignore the parameter.
    let (s, _, body) = gw.get("/badge/alice/proj/stars.svg?branch=nope").await;
    assert_eq!(s, 200, "{body}");
    assert_eq!(gw.stub.world().snapshots, 1, "one snapshot read per TTL");
}
