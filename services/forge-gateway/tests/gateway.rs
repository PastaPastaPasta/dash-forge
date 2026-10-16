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
use forge_gateway::config::TrustProxy;
use forge_gateway::curation::Hidden;
use forge_gateway::metrics::Metrics;
use forge_gateway::mirror::{Mirrors, Unavailable};
use forge_gateway::upstream::{
    Check, FetchSource, IssueEntry, Item, ItemKind, ItemState, OpenIssues, ReleaseEntry, RepoInfo,
    Snapshot, Upstream,
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
    /// How many of the open issues are members-only.
    members_only_issues: u64,
    /// Issues and pull requests by (`issues` | `pull`, number): `(item, public)`. A members-only
    /// or hidden one (`public == false`) is read as `None`, as [`Upstream::item`] promises.
    items: BTreeMap<(&'static str, u32), (Item, bool)>,
    /// Item reads.
    item_reads: usize,
    /// The repositories' issue + pull request count (default: the highest item number held).
    item_total: Option<u64>,
    /// Item count reads.
    item_count_reads: usize,
    /// DPNS names cannot be read (an owner given by id still can).
    fail_name_reads: bool,
    /// Members-only branches of the stub's source repository: Platform shows only their count,
    /// and `git-remote-dash` (as an anonymous reader) never lists or fetches them.
    sealed: Vec<String>,
}

#[derive(Clone, Default)]
struct Stub(Arc<Mutex<World>>);

impl Stub {
    fn world(&self) -> std::sync::MutexGuard<'_, World> {
        self.0.lock().unwrap()
    }

    fn add(&self, owner: &str, name: &str, public: bool, src: &Path) -> RepoInfo {
        self.add_id(&format!("R{name}{owner}"), owner, name, public, src)
    }

    fn add_id(&self, id: &str, owner: &str, name: &str, public: bool, src: &Path) -> RepoInfo {
        let info = RepoInfo {
            repo_id: id.into(),
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

    /// [`Self::add_id`] with the owner's identity id given.
    fn add_with(
        &self,
        id: &str,
        owner_id: &str,
        owner: &str,
        name: &str,
        public: bool,
        src: &Path,
    ) -> RepoInfo {
        let info = RepoInfo {
            repo_id: id.into(),
            owner_id: owner_id.into(),
            name: name.into(),
            public,
        };
        self.world().repos.insert(
            (owner.into(), name.into()),
            (info.clone(), src.to_path_buf()),
        );
        info
    }

    /// Delete `owner/name` from "Platform" (proved absent from now on).
    fn remove(&self, owner: &str, name: &str) {
        self.world()
            .repos
            .remove(&(owner.to_string(), name.to_string()));
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
        // The owner as an identity id, or as a DPNS name (`alice`, `Alice.dash` and `a1ice` are
        // one name, as on Platform); a repository name is lower-case.
        let is_id = w.repos.values().any(|(i, _)| i.owner_id == owner);
        if w.fail_name_reads && !is_id {
            return Err(anyhow!("DPNS names cannot be read"));
        }
        let dpns = |s: &str| {
            let lower = s.to_ascii_lowercase();
            forge_core::platform::identity::dpns_normalize(
                lower.strip_suffix(".dash").unwrap_or(&lower),
            )
        };
        let name = name.to_ascii_lowercase();
        Ok(w.repos
            .iter()
            .find(|((o, n), (i, _))| {
                *n == name && (i.owner_id == owner || (!is_id && dpns(o) == dpns(owner)))
            })
            .map(|(_, (i, _))| i.clone()))
    }
    async fn snapshot(&self, repo: &RepoInfo) -> Result<Option<Snapshot>> {
        {
            let w = self.world();
            // Proved gone: nothing has the id any more (a failed read is `down`, an error).
            if !w.down && !w.repos.values().any(|(i, _)| i.repo_id == repo.repo_id) {
                return Ok(None);
            }
        }
        let src = self.src(repo)?;
        let (time_ms, pack_bytes) = {
            let mut w = self.world();
            w.snapshots += 1;
            (w.time_ms, w.pack_bytes)
        };
        let (sealed, members_only_refs) = {
            let w = self.world();
            (w.sealed.clone(), w.sealed.len())
        };
        let refs = git_out(&src, &["for-each-ref", "--format=%(objectname) %(refname)"]);
        let records = refs
            .lines()
            .filter_map(|l| l.split_once(' '))
            .filter(|(_, name)| !sealed.iter().any(|s| s == name))
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
        Ok(Some(Snapshot {
            records,
            members_only_refs,
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
        }))
    }
    async fn exists(&self, repo: &RepoInfo) -> Result<bool> {
        let w = self.world();
        if w.down {
            return Err(anyhow!("Platform is down"));
        }
        Ok(w.repos.values().any(|(i, _)| i.repo_id == repo.repo_id))
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
    async fn open_issues(&self, repo: &RepoInfo) -> Result<OpenIssues> {
        self.src(repo)?;
        let members_only = self.world().members_only_issues;
        Ok(OpenIssues {
            open: 3,
            members_only,
        })
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
    async fn item_count(&self, repo: &RepoInfo) -> Result<u64> {
        self.src(repo)?;
        let mut w = self.world();
        w.item_count_reads += 1;
        let held = w
            .items
            .keys()
            .map(|(_, n)| u64::from(*n))
            .max()
            .unwrap_or(0);
        Ok(w.item_total.unwrap_or(held))
    }
    async fn item(&self, repo: &RepoInfo, kind: ItemKind, number: u32) -> Result<Option<Item>> {
        self.src(repo)?;
        let mut w = self.world();
        w.item_reads += 1;
        Ok(w.items
            .get(&(kind.segment(), number))
            .filter(|(_, public)| *public)
            .map(|(i, _)| i.clone()))
    }
}

/// `GET <base><path>`: status, headers and body.
async fn request(base: &str, path: &str) -> (u16, reqwest::header::HeaderMap, String) {
    let r = reqwest::get(format!("{base}{path}")).await.unwrap();
    let status = r.status().as_u16();
    let headers = r.headers().clone();
    (status, headers, r.text().await.unwrap_or_default())
}

/// The `X-Forge-Stale` age a response carries, if any.
fn stale_secs(h: &reqwest::header::HeaderMap) -> Option<u64> {
    h.get(forge_gateway::server::STALE_HEADER)
        .map(|v| v.to_str().unwrap().parse().unwrap())
}

/// Wait (at most 10 s) until `done` holds.
async fn eventually(what: &str, mut done: impl FnMut() -> bool) {
    for _ in 0..200 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting until {what}");
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
    state: Arc<AppState>,
    _tmp: tempfile::TempDir,
    tmp: PathBuf,
}

async fn start(tune: impl FnOnce(&mut Config)) -> Gateway {
    let tmp = tempfile::tempdir().unwrap();
    let stub = Stub::default();
    stub.world().time_ms = 1_000;
    let (base, mirrors, state) = serve_full(tmp.path(), &stub, tune, None).await;
    Gateway {
        base,
        stub,
        mirrors,
        state,
        tmp: tmp.path().to_path_buf(),
        _tmp: tmp,
    }
}

/// A gateway over `<dir>/data` and `stub`, the mirrors a previous one left there loaded (a
/// restart): its base URL and mirrors.
async fn serve(dir: &Path, stub: &Stub, tune: impl FnOnce(&mut Config)) -> (String, Arc<Mirrors>) {
    let (base, mirrors, _) = serve_full(dir, stub, tune, None).await;
    (base, mirrors)
}

/// [`serve`], also returning the state, and with `hidden` as the curation list when given.
async fn serve_full(
    dir: &Path,
    stub: &Stub,
    tune: impl FnOnce(&mut Config),
    hidden: Option<Hidden>,
) -> (String, Arc<Mirrors>, Arc<AppState>) {
    let mut cfg = Config::for_tests(dir.join("data"));
    tune(&mut cfg);
    let cfg = Arc::new(cfg);
    let metrics = Arc::new(Metrics::default());
    let mirrors = Arc::new(
        Mirrors::new(
            Arc::clone(&cfg),
            Arc::new(stub.clone()),
            Arc::clone(&metrics),
        )
        .unwrap(),
    );
    mirrors.load_existing().await.unwrap();
    let mut state = AppState::new(Arc::clone(&cfg), Arc::clone(&mirrors), metrics);
    if let Some(hidden) = hidden {
        state = state.with_hidden(hidden);
    }
    let state = Arc::new(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let served = Arc::clone(&state);
    tokio::spawn(async move {
        axum::serve(
            listener,
            router(served).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    (format!("http://{addr}"), mirrors, state)
}

impl Gateway {
    async fn get(&self, path: &str) -> (u16, String, String) {
        let (status, headers, body) = request(&self.base, path).await;
        let ct = headers
            .get("content-type")
            .map(|v| v.to_str().unwrap().to_string())
            .unwrap_or_default();
        (status, ct, body)
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
    // What is served from the old snapshot says how old it is.
    for path in [
        "/alice/proj.git/info/refs?service=git-upload-pack",
        "/alice/proj.git/forge-manifest.json",
    ] {
        let (s, headers, _) = request(&gw.base, path).await;
        assert_eq!(s, 200, "{path}");
        assert!(stale_secs(&headers).is_some(), "{path}: {headers:?}");
    }
    let (s, _, _) = gw.get("/readyz").await;
    assert_eq!(s, 503);
    let (s, _, metrics) = gw.get("/metrics").await;
    assert_eq!(s, 200);
    assert!(
        metrics.contains("forge_gateway_refresh_failed_total 1"),
        "{metrics}"
    );
    // A failed read is never taken for a deleted repository.
    assert!(
        metrics.contains("forge_gateway_mirrors_gone_total 0"),
        "{metrics}"
    );
    assert!(gw
        .tmp
        .join("data/mirrors/devnet-stub/Rprojalice.git")
        .exists());
    // Platform back: fresh again, no header.
    gw.stub.world().down = false;
    assert_eq!(gw.refresh(&info).await, None);
    let (_, headers, _) = request(&gw.base, "/alice/proj.git/forge-manifest.json").await;
    assert_eq!(stale_secs(&headers), None);
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
    // `/metrics` is public: no counter tells a private repository from a missing one.
    let (_, _, metrics) = gw.get("/metrics").await;
    assert!(
        metrics
            .lines()
            .filter(|l| !l.starts_with('#'))
            .all(|l| !l.contains("private")),
        "{metrics}"
    );
    assert!(
        metrics.contains("forge_gateway_repo_not_found_total "),
        "{metrics}"
    );
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

/// Q5-D04: the issues badge counts every open issue and labels the members-only share, as the
/// web's tab does ("Issues 3 (2 members-only)").
#[tokio::test(flavor = "multi_thread")]
async fn the_issues_badge_labels_members_only_issues() {
    let gw = start(|_| {}).await;
    let src = source(&gw.tmp);
    gw.stub.add("alice", "proj", true, &src);

    let (s, _, body) = gw.get("/badge/alice/proj/issues.json").await;
    assert_eq!(s, 200);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["message"], "3 open");

    // A new render (a fresh repo, so nothing cached) with two of the three members-only.
    gw.stub.world().members_only_issues = 2;
    gw.stub.add("alice", "mixed", true, &src);
    let (_, _, body) = gw.get("/badge/alice/mixed/issues.json").await;
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["message"], "3 open (2 members-only)");
    let (_, _, body) = gw.get("/badge/alice/mixed/issues.svg").await;
    assert!(body.contains("3 open (2 members-only)"), "{body}");
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

/// A repository with members-only branches (mixed-visibility DESIGN §7): the gateway serves the
/// public lane only, says how many refs it leaves out, and nothing it renders names or leaks one.
#[tokio::test(flavor = "multi_thread")]
async fn members_only_branches_are_counted_and_never_served() {
    let gw = start(|_| {}).await;
    let src = source(&gw.tmp);
    // A members-only branch with content of its own; `git-remote-dash` as an anonymous reader
    // never lists it (the stub's source hides it from the fetch).
    git_out(&src, &["checkout", "-q", "-b", "embargo-fix"]);
    std::fs::write(src.join("exploit.txt"), "SEALED-BRANCH-CONTENT\n").unwrap();
    git_out(&src, &["add", "exploit.txt"]);
    git_out(
        &src,
        &["commit", "-q", "-m", "fix the SEALED-COMMIT-SUBJECT hole"],
    );
    let sealed_oid = git_out(&src, &["rev-parse", "HEAD"]).trim().to_string();
    git_out(&src, &["checkout", "-q", "main"]);
    git_out(
        &src,
        &["config", "uploadpack.hideRefs", "refs/heads/embargo-fix"],
    );
    let info = gw.stub.add("alice", "proj", true, &src);
    gw.stub.world().sealed = vec!["refs/heads/embargo-fix".into()];

    let out = gw.clone("/alice/proj.git", "clone").await;
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let ls = gw
        .git(
            gw.tmp.clone(),
            vec!["ls-remote".into(), format!("{}/alice/proj.git", gw.base)],
        )
        .await;
    let ls = String::from_utf8(ls.stdout).unwrap();
    let served = parse_ls_remote(&ls);
    assert_eq!(served.len(), 3, "main, feature and the tag only: {ls}");
    assert!(!ls.contains("embargo") && !ls.contains(&sealed_oid), "{ls}");

    // The mirror holds no object of the members-only branch.
    let mirror = gw.mirrors.slot(&info).dir.clone();
    assert!(!git(&mirror, &["cat-file", "-e", &sealed_oid])
        .status
        .success());
    assert!(
        !git(&gw.tmp.join("clone"), &["cat-file", "-e", &sealed_oid])
            .status
            .success()
    );

    // The manifest says how many it leaves out, and checks out against the public refs.
    let (s, _, raw) = gw.get("/alice/proj.git/forge-manifest.json").await;
    assert_eq!(s, 200);
    let m: Manifest = serde_json::from_str(&raw).unwrap();
    assert_eq!(m.members_only_refs_not_served, 1);
    assert!(raw.contains("\"membersOnlyRefsNotServed\": 1"), "{raw}");
    assert_eq!(m.refs.len(), 3);
    let snap = gw.stub.snapshot(&info).await.unwrap().unwrap();
    assert_eq!(snap.members_only_refs, 1);
    let c = compare(&served, &snap.records, Some(m.platform_time_ms));
    assert_eq!(c.verdict, Verdict::Match, "{c:?}");

    // Nothing the gateway renders names the branch, its commit or its content.
    let mut seen = vec![raw];
    for path in [
        "/alice/proj.git/info/refs?service=git-upload-pack",
        "/feed/alice/proj/commits.atom",
        "/feed/alice/proj/releases.atom",
        "/feed/alice/proj/issues.atom",
        "/badge/alice/proj/ci.json",
        "/badge/alice/proj/ci.json?branch=embargo-fix",
        "/badge/alice/proj/issues.svg",
        "/og/alice/proj",
        "/",
    ] {
        let (_, _, body) = gw.get(path).await;
        seen.push(body);
    }
    for body in &seen {
        for secret in [
            "embargo",
            "SEALED-COMMIT-SUBJECT",
            "SEALED-BRANCH-CONTENT",
            sealed_oid.as_str(),
        ] {
            assert!(!body.contains(secret), "{secret} in {body}");
        }
    }
    // A badge for the branch answers as for a branch that does not exist.
    let (_, _, hidden) = gw.get("/badge/alice/proj/ci.json?branch=embargo-fix").await;
    let (_, _, absent) = gw.get("/badge/alice/proj/ci.json?branch=nope").await;
    assert_eq!(hidden, absent);

    // More members-only branches move the count with the next refresh; none, and the manifest
    // goes back to saying nothing of them.
    gw.stub
        .world()
        .sealed
        .push("refs/heads/other-embargo".into());
    gw.stub.world().time_ms = 9_000;
    assert_eq!(gw.refresh(&info).await, None);
    assert_eq!(
        gw.manifest("/alice/proj.git")
            .await
            .members_only_refs_not_served,
        2
    );
    git_out(&src, &["branch", "-D", "embargo-fix"]);
    gw.stub.world().sealed.clear();
    gw.stub.world().time_ms = 12_000;
    assert_eq!(gw.refresh(&info).await, None);
    let (_, _, raw) = gw.get("/alice/proj.git/forge-manifest.json").await;
    assert!(!raw.contains("membersOnly"), "{raw}");
}

/// The `content` of the `<meta>` tag `prop` names in `html`.
fn meta<'a>(html: &'a str, prop: &str) -> &'a str {
    let needle = format!("\"{prop}\" content=\"");
    let at = html
        .find(&needle)
        .unwrap_or_else(|| panic!("no {prop} in {html}"));
    let rest = &html[at + needle.len()..];
    &rest[..rest.find('"').unwrap()]
}

/// A gateway at `https://gw.example` serving `alice/proj` (public, with public issue 7 and
/// pull request 3, members-only issue 8 and pull request 4) and `alice/secret` (private).
async fn share_gateway() -> Gateway {
    let gw = start(|c| c.public_url = Some("https://gw.example".into())).await;
    let src = source(&gw.tmp);
    gw.stub.add("alice", "proj", true, &src);
    gw.stub.add("alice", "secret", false, &src);
    let item = |title: &str, state| Item {
        title: title.into(),
        body: "Steps:\n\n1. run it <!-- hint -->".into(),
        state,
    };
    let mut w = gw.stub.world();
    w.items
        .insert(("issues", 7), (item("It <breaks>", ItemState::Open), true));
    w.items.insert(
        ("pull", 3),
        (item("Faster parser", ItemState::Merged), true),
    );
    // Members-only (or hidden): Platform has it, the card must show none of it.
    w.items.insert(
        ("issues", 8),
        (item("SECRET members-only title", ItemState::Open), false),
    );
    w.items.insert(
        ("pull", 4),
        (item("SECRET members-only pull", ItemState::Open), false),
    );
    drop(w);
    gw
}

#[tokio::test(flavor = "multi_thread")]
async fn share_links_preview_public_issues_and_pull_requests() {
    let gw = share_gateway().await;
    // An issue: its title and body, its own card image, people sent to the web app's short URL.
    let (s, ct, body) = gw.get("/og/alice/proj/issues/7").await;
    assert_eq!(
        (s, ct.as_str()),
        (200, "text/html; charset=utf-8"),
        "{body}"
    );
    assert_eq!(
        meta(&body, "og:title"),
        "It &lt;breaks&gt; · Issue #7 · alice/proj"
    );
    assert_eq!(meta(&body, "og:description"), "Steps: 1. run it");
    assert_eq!(
        meta(&body, "og:image"),
        "https://gw.example/og/alice/proj/issues/7.png"
    );
    assert_eq!(
        meta(&body, "og:url"),
        "https://gw.example/og/alice/proj/issues/7"
    );
    assert!(body.contains(
        "<link rel=\"canonical\" href=\"https://forge.dashhq.org/alice/proj/issues/7\">"
    ));
    assert!(body.contains("href=\"https://forge.dashhq.org/alice/proj/issues/7\">Open"));
    let r = reqwest::get(format!("{}/og/alice/proj/issues/7.png", gw.base))
        .await
        .unwrap();
    assert_eq!(
        (
            r.status().as_u16(),
            r.headers()["content-type"].to_str().unwrap()
        ),
        (200, "image/png")
    );
    assert_eq!(&r.bytes().await.unwrap()[..4], b"\x89PNG");

    // A pull request, on any of its tabs: one item read per TTL, whatever the tab.
    let reads = gw.stub.world().item_reads;
    for path in [
        "/og/alice/proj/pull/3",
        "/og/alice/proj/pull/3/files",
        "/og/alice/proj/pull/003/checks",
    ] {
        let (s, _, body) = gw.get(path).await;
        assert_eq!(s, 200, "{path}: {body}");
        assert_eq!(
            meta(&body, "og:title"),
            "Faster parser · Pull request #3 · alice/proj",
            "{path}"
        );
        let short = path.strip_prefix("/og").unwrap();
        assert_eq!(
            meta(&body, "og:url"),
            format!("https://gw.example/og{short}")
        );
        assert!(
            body.contains(&format!(
                "canonical\" href=\"https://forge.dashhq.org{short}\""
            )),
            "{body}"
        );
    }
    assert_eq!(
        gw.stub.world().item_reads,
        reads + 1,
        "cached per item, not per path"
    );

    // Platform down: what was read is still served; with nothing cached, the site's card,
    // briefly cacheable.
    gw.stub.world().down = true;
    let (s, _, body) = gw.get("/og/alice/proj/issues/7").await;
    assert_eq!(s, 200, "{body}");
    assert_eq!(
        meta(&body, "og:title"),
        "It &lt;breaks&gt; · Issue #7 · alice/proj"
    );
    let r = reqwest::get(format!("{}/og/bob/other/issues/1", gw.base))
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 200);
    assert_eq!(r.headers()["cache-control"], "public, max-age=60");
    assert_eq!(meta(&r.text().await.unwrap(), "og:title"), "Dash Forge");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_share_link_read_before_platform_failed_is_served_stale() {
    let gw = start(|c| {
        c.public_url = Some("https://gw.example".into());
        c.render_ttl_secs = 1;
    })
    .await;
    let src = source(&gw.tmp);
    gw.stub.add("alice", "proj", true, &src);
    gw.stub.world().items.insert(
        ("issues", 7),
        (
            Item {
                title: "It breaks".into(),
                body: String::new(),
                state: ItemState::Closed,
            },
            true,
        ),
    );
    let (s, _, _) = gw.get("/og/alice/proj/issues/7").await;
    assert_eq!(s, 200);
    gw.stub.world().down = true;
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let r = reqwest::get(format!("{}/og/alice/proj/issues/7", gw.base))
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 200);
    // Briefly cacheable: at most 60 s (here the 1 s TTL).
    assert_eq!(r.headers()["cache-control"], "public, max-age=1");
    assert!(stale_secs(r.headers()).is_some(), "marked stale");
    let body = r.text().await.unwrap();
    assert_eq!(meta(&body, "og:title"), "It breaks · Issue #7 · alice/proj");
}

#[tokio::test(flavor = "multi_thread")]
async fn share_links_show_nothing_of_members_only_items_or_private_repos() {
    let gw = share_gateway().await;
    let repo_png = reqwest::get(format!("{}/og/alice/proj.png", gw.base))
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    // Members-only (or hidden, or absent): the link's own words and the repository's image.
    for (path, noun) in [
        ("/og/alice/proj/issues/8", "Issue #8"),
        ("/og/alice/proj/pull/4/files", "Pull request #4"),
        ("/og/alice/proj/issues/99", "Issue #99"),
    ] {
        let (s, _, body) = gw.get(path).await;
        assert_eq!(s, 200, "{path}: {body}");
        assert!(
            !body.contains("SECRET") && !body.contains("Steps"),
            "{path}: {body}"
        );
        assert_eq!(meta(&body, "og:title"), format!("{noun} · alice/proj"));
        assert_eq!(
            meta(&body, "og:image"),
            "https://gw.example/og/alice/proj.png"
        );
    }
    // Their image route draws the repository's card, never the item's.
    for path in ["/og/alice/proj/issues/8.png", "/og/alice/proj/pull/4.png"] {
        let r = reqwest::get(format!("{}{path}", gw.base)).await.unwrap();
        assert_eq!(r.status().as_u16(), 200, "{path}");
        assert_eq!(r.bytes().await.unwrap(), repo_png, "{path}");
    }
    // A private repository answers exactly as an absent one: the site's card.
    for path in [
        "/og/alice/secret",
        "/og/alice/secret/issues/7",
        "/og/alice/secret/pull/3",
        "/og/alice/nothing/issues/7",
    ] {
        let (s, _, body) = gw.get(path).await;
        assert_eq!(s, 200, "{path}: {body}");
        assert_eq!(meta(&body, "og:title"), "Dash Forge", "{path}");
        assert_eq!(
            meta(&body, "og:image"),
            "https://forge.dashhq.org/og.png",
            "{path}"
        );
        assert!(
            !body.contains("It &lt;breaks") && !body.contains("A &lt;test"),
            "{path}: {body}"
        );
        let short = path.strip_prefix("/og").unwrap();
        assert!(
            body.contains(&format!(
                "canonical\" href=\"https://forge.dashhq.org{short}\""
            )),
            "{body}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn share_links_carry_their_path_to_the_web_app_and_nothing_else() {
    let gw = share_gateway().await;
    // Any other view: the repository's card, the path carried through as written (a `%2F` ref
    // stays one segment), and the `?repo=` pin with it; other query strings dropped.
    let id = "G6D3ejKx123456789abcdefXYZ9abcdefghijk";
    let (s, _, body) = gw
        .get(&format!(
            "/og/alice/proj/tree/feature%2Fx/src?repo={id}&utm=x"
        ))
        .await;
    assert_eq!(s, 200, "{body}");
    assert_eq!(meta(&body, "og:title"), "alice/proj");
    assert_eq!(meta(&body, "og:description"), "A &lt;test&gt; repository");
    assert!(
        body.contains(&format!("canonical\" href=\"https://forge.dashhq.org/alice/proj/tree/feature%2Fx/src?repo={id}\"")),
        "{body}"
    );
    assert!(!body.contains("utm"), "{body}");
    // A duplicate or malformed query is ignored, never a 400: the first valid pin wins.
    let (s, _, body) = gw
        .get(&format!(
            "/og/alice/proj/issues/7?repo=bad&repo={id}&repo=%zz&x"
        ))
        .await;
    assert_eq!(s, 200, "{body}");
    assert!(body.contains(&format!("issues/7?repo={id}\"")), "{body}");
    let (_, _, body) = gw.get("/og/alice/proj/releases?repo=not-an-id").await;
    assert!(
        body.contains("canonical\" href=\"https://forge.dashhq.org/alice/proj/releases\""),
        "{body}"
    );
    // Not a short URL: refused, never redirected. (Escaped dot segments, `%2e%2e`, are refused
    // too: `og::tests`; an HTTP client normalizes them away before sending, as browsers do.)
    for path in [
        "/og/alice/proj/a%2",
        "/og/alice/proj/x%zz/y",
        "/og/alice",
        "/og/al%20ice/proj",
    ] {
        let (s, _, body) = gw.get(path).await;
        assert_eq!(s, 404, "{path}: {body}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn security_txt_is_served_as_plain_text_and_matches_the_web_app() {
    // Without a public URL there is no Canonical line (a gateway does not guess its own name).
    let gw = start(|_| {}).await;
    let (s, ct, body) = gw.get("/.well-known/security.txt").await;
    assert_eq!(s, 200);
    assert_eq!(ct, "text/plain; charset=utf-8");
    assert!(body.contains("Contact: mailto:security@dashhq.org\n"));
    assert!(body.contains(
        "Contact: https://github.com/PastaPastaPasta/dash-forge/security/advisories/new\n"
    ));
    assert!(body.contains("\nExpires: "));
    assert!(!body.contains("Canonical:"));

    // With one, Canonical names it. Every other line is the web app's file, word for word.
    let gw = start(|c| c.public_url = Some("https://git-forge.dashhq.org/".into())).await;
    let (_, _, body) = gw.get("/.well-known/security.txt").await;
    assert!(body.contains("\nCanonical: https://git-forge.dashhq.org/.well-known/security.txt\n"));
    let web = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../forge-web/public/.well-known/security.txt"),
    )
    .unwrap();
    let keep = |t: &str| {
        t.lines()
            .filter(|l| !l.starts_with("Canonical:"))
            .map(str::to_string)
            .collect::<Vec<_>>()
    };
    assert_eq!(keep(&body), keep(&web));

    // The dot-directory path is not a repository: an owner cannot start with a dot.
    let (s, _, _) = gw.get("/.well-known/other").await;
    assert_eq!(s, 404);
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

#[tokio::test(flavor = "multi_thread")]
async fn a_repo_platform_proves_gone_is_removed_and_answers_404() {
    let gw = start(|_| {}).await;
    let src = source(&gw.tmp);
    let info = gw.stub.add("alice", "proj", true, &src);
    assert!(gw.clone("/alice/proj.git", "c1").await.status.success());
    for path in [
        "/badge/alice/proj/stars.svg",
        "/feed/alice/proj/commits.atom",
        "/og/alice/proj",
    ] {
        let (s, _, body) = gw.get(path).await;
        assert_eq!(s, 200, "{path}: {body}");
    }
    let dir = gw.tmp.join("data/mirrors/devnet-stub/Rprojalice.git");
    assert!(dir.exists());

    // Deleted on Platform (or the chain reset): the next refresh proves it gone.
    gw.stub.remove("alice", "proj");
    assert_eq!(gw.refresh(&info).await, Some(Unavailable::Gone));
    assert!(!gw.mirrors.known(&info.repo_id));
    eventually("the mirror's files are deleted", || !dir.exists()).await;

    // Nothing cached keeps it alive: every route answers as for an unknown repository.
    for path in [
        "/alice/proj.git/info/refs?service=git-upload-pack",
        "/alice/proj.git/forge-manifest.json",
        "/feed/alice/proj/commits.atom",
        "/feed/alice/proj/releases.atom",
        "/og/alice/proj.png",
    ] {
        let (s, _, body) = gw.get(path).await;
        assert_eq!(s, 404, "{path}: {body}");
        assert!(body.contains("no public repository"), "{path}: {body}");
    }
    // A share link still unfurls, as the site's own card: nothing of the repository is shown.
    let (s, _, body) = gw.get("/og/alice/proj").await;
    assert_eq!(s, 200, "{body}");
    assert!(body.contains("og:title\" content=\"Dash Forge\""), "{body}");
    assert!(!body.contains("A &lt;test&gt; repository"), "{body}");
    let (s, _, body) = gw.get("/badge/alice/proj/stars.svg").await;
    assert_eq!(s, 404);
    assert!(body.contains("repo not found"), "{body}");
    assert!(!gw.clone("/alice/proj.git", "c2").await.status.success());
    assert!(!dir.exists(), "no request made the mirror again");
    let (_, _, metrics) = gw.get("/metrics").await;
    assert!(
        metrics.contains("forge_gateway_mirrors_gone_total 1"),
        "{metrics}"
    );
    assert!(
        metrics.contains("forge_gateway_refresh_failed_total 0"),
        "{metrics}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stale_render_says_how_old_it_is() {
    let gw = start(|c| c.render_ttl_secs = 0).await;
    let src = source(&gw.tmp);
    gw.stub.add("alice", "proj", true, &src);
    let (s, headers, _) = request(&gw.base, "/badge/alice/proj/stars.svg").await;
    assert_eq!((s, stale_secs(&headers)), (200, None));
    gw.stub.world().down = true;
    let (s, headers, body) = request(&gw.base, "/badge/alice/proj/stars.svg").await;
    assert_eq!(s, 200);
    assert!(body.contains(">42<"), "{body}");
    assert!(stale_secs(&headers).is_some(), "{headers:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restart_keeps_warm_only_the_mirrors_people_were_served() {
    let gw = start(|_| {}).await;
    let src = source(&gw.tmp);
    gw.stub.add("alice", "served", true, &src);
    let polled = gw.stub.add("alice", "polled", true, &src);
    assert!(gw.clone("/alice/served.git", "c").await.status.success());
    // Refreshed (as the poller does) but never served: its manifest is new all the same.
    assert_eq!(gw.refresh(&polled).await, None);
    let marker = gw
        .tmp
        .join("data/mirrors/devnet-stub/Rservedalice.git")
        .join(forge_gateway::mirror::SERVED_FILE);
    eventually("the serve is recorded", || marker.exists()).await;

    let (_, again) = serve(&gw.tmp, &gw.stub, |_| {}).await;
    assert!(again.known(&polled.repo_id));
    let warm: Vec<String> = again
        .warm()
        .iter()
        .map(|s| s.repo.repo_id.clone())
        .collect();
    assert_eq!(warm, ["Rservedalice"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repo_created_again_under_its_name_drops_the_old_mirror() {
    let gw = start(|_| {}).await;
    let src = source(&gw.tmp);
    let old = gw.stub.add("alice", "proj", true, &src);
    assert!(gw.clone("/alice/proj.git", "c1").await.status.success());
    let old_dir = gw.tmp.join("data/mirrors/devnet-stub/Rprojalice.git");

    // A reset chain: the repository is created again under its name, with a new id. A
    // restarted gateway still finds the old mirror on disk.
    gw.stub.remove("alice", "proj");
    gw.stub.add_id("Rnew", "alice", "proj", true, &src);
    let (base, mirrors) = serve(&gw.tmp, &gw.stub, |_| {}).await;
    assert!(mirrors.known(&old.repo_id));

    // The name resolves to the new repository, and the old mirror is proved gone and removed.
    let (s, _, body) = request(&base, "/alice/proj.git/forge-manifest.json").await;
    assert_eq!(s, 200, "{body}");
    let m: Manifest = serde_json::from_str(&body).unwrap();
    assert_eq!(m.repo_id, "Rnew");
    eventually("the old mirror is removed", || {
        !mirrors.known(&old.repo_id) && !old_dir.exists()
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restart_after_a_network_reset_removes_the_mirrors_platform_lost() {
    let gw = start(|_| {}).await;
    let src = source(&gw.tmp);
    let old = gw.stub.add("alice", "proj", true, &src);
    let kept = gw.stub.add("alice", "kept", true, &src);
    assert_eq!(gw.refresh(&old).await, None);
    assert_eq!(gw.refresh(&kept).await, None);

    // The reset: `alice` now names a new identity, which creates `proj` again.
    gw.stub.remove("alice", "proj");
    gw.stub.add_id("Rnew", "alice", "proj", true, &src);
    gw.stub
        .world()
        .repos
        .get_mut(&("alice".to_string(), "proj".to_string()))
        .unwrap()
        .0
        .owner_id = "Onew".into();

    // A failed read keeps every mirror.
    gw.stub.world().down = true;
    let (_, down) = serve(&gw.tmp, &gw.stub, |_| {}).await;
    down.sweep_gone().await;
    assert!(down.known(&old.repo_id) && down.known(&kept.repo_id));

    gw.stub.world().down = false;
    let (_, mirrors) = serve(&gw.tmp, &gw.stub, |_| {}).await;
    mirrors.sweep_gone().await;
    assert!(!mirrors.known(&old.repo_id));
    assert!(mirrors.known(&kept.repo_id));
    let old_dir = gw.tmp.join("data/mirrors/devnet-stub/Rprojalice.git");
    eventually("the lost mirror's files are deleted", || !old_dir.exists()).await;
    assert!(gw
        .tmp
        .join("data/mirrors/devnet-stub/Rkeptalice.git")
        .exists());
}

// ---------------------------------------------------------------------------------------
// WS-G3: the deny list, curation, refresh backoff and permits, the item-count short-circuit,
// IPv6 /48 keys, the proxy-header notice and /readyz's version.
// ---------------------------------------------------------------------------------------

/// Valid Platform ids (32 bytes in base58): a deny list's bare entries must be ids.
const ID_PROJ: &str = "29d2S7vB453rNYFdR5Ycwt7y9haRT5fwVwL9zTmBhfV2";
const ID_ALICE: &str = "3JF3sEqM796hk5WFqA6EtmEwJQ9quALszsfJyvXNQKy3";
const ID_OTHER: &str = "4Ss5JMkXAD9Z7cktFEdrqeMuT6jGMF1pVozTyPHZ6zT4";
const ID_THING: &str = "5bV6jUfhDHCQVA1WfKBUnXUsboJgoKgkzkKcxr3joew5";
const ID_BOB: &str = "6k78AbasGMFFrhG95Pj6jQbqkVt7FQMhVgemxJovWKR6";
const ID_BOB_PROJ: &str = "7tj9biW3KRJ7EEWmVUGigHiouCTXhV2dzcyvwma7Cyu7";

/// Alice (`ID_ALICE`) owns `proj` and `other`, Bob (`ID_BOB`) owns `thing`.
fn deny_world(gw: &Gateway, src: &Path) {
    gw.stub
        .add_with(ID_PROJ, ID_ALICE, "alice", "proj", true, src);
    gw.stub
        .add_with(ID_OTHER, ID_ALICE, "alice", "other", true, src);
    gw.stub
        .add_with(ID_THING, ID_BOB, "bob", "thing", true, src);
}

#[tokio::test(flavor = "multi_thread")]
#[allow(clippy::too_many_lines)] // one scenario, start to finish
async fn the_deny_list_answers_451_deletes_the_mirror_and_reloads_without_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("deny.txt");
    std::fs::write(&file, "# no entries yet\n").unwrap();
    let path = file.clone();
    let gw = start(move |c| {
        c.deny_file = Some(path);
        c.public_url = Some("https://gw.example".into());
    })
    .await;
    let src = source(&gw.tmp);
    deny_world(&gw, &src);
    assert!(gw.clone("/alice/proj.git", "c1").await.status.success());
    assert!(gw.clone("/alice/other.git", "c2").await.status.success());
    let mirrors = gw.tmp.join("data/mirrors/devnet-stub");
    let proj_dir = mirrors.join(format!("{ID_PROJ}.git"));
    assert!(proj_dir.exists());
    let deny = gw.state.deny();
    assert!(deny.is_empty() && deny.loaded());

    // /readyz says how the list stands, and /metrics counts it.
    let (_, _, body) = gw.get("/readyz").await;
    let ready: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(ready["deny"]["state"], "ok");
    assert_eq!(ready["deny"]["entries"], 0);

    // Written: applied without a restart.
    std::fs::write(
        &file,
        "# notice 2026-10-16\nalice/proj # DPNS owner and name\n",
    )
    .unwrap();
    assert!(deny.reload_now());
    let (_, _, body) = gw.get("/readyz").await;
    let ready: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(ready["deny"]["entries"], 1);
    let (_, _, metrics) = gw.get("/metrics").await;
    assert!(
        metrics.contains("forge_gateway_deny_entries 1"),
        "{metrics}"
    );

    // The git, manifest, badge, feed and share routes refuse with 451 and say `dash://` still
    // works; the refusal is not cacheable and names the gateway as the blocker.
    for path in [
        "/alice/proj.git/info/refs?service=git-upload-pack",
        "/alice/proj.git/forge-manifest.json",
        "/badge/alice/proj/stars.svg",
        "/badge/alice/proj/ci.json",
        "/feed/alice/proj/releases.atom",
        "/feed/alice/proj/commits.atom",
        "/og/alice/proj",
        "/og/alice/proj/issues/7",
        "/og/alice/proj.png",
    ] {
        let (s, headers, body) = request(&gw.base, path).await;
        assert_eq!(s, 451, "{path}: {body}");
        assert_eq!(headers["cache-control"], "no-store", "{path}");
        if path.starts_with("/badge/") {
            assert!(body.contains("not served here"), "{path}: {body}");
        } else {
            assert!(
                body.contains("git clone dash://alice/proj"),
                "{path}: {body}"
            );
            assert_eq!(
                headers["link"], "<https://gw.example>; rel=\"blocked-by\"",
                "{path}"
            );
        }
    }
    // `/<owner>/<name>` itself only redirects to the web app, which has its own policy.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let r = client
        .get(format!("{}/alice/proj", gw.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 302);
    let out = gw.clone("/alice/proj.git", "c3").await;
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("451"));

    // The sweep resolves the listed name to its repository and deletes the mirror and
    // everything cached about it.
    assert_eq!(gw.state.enforce_deny().await, 1);
    assert!(!gw.mirrors.known(ID_PROJ));
    eventually("the mirror's files are deleted", || !proj_dir.exists()).await;
    let (s, _, body) = gw
        .get(&format!("/{ID_ALICE}/proj.git/forge-manifest.json"))
        .await;
    assert_eq!(s, 451, "named by its owner's id too: {body}");
    // The others are served.
    assert!(gw.clone("/alice/other.git", "c4").await.status.success());
    let (s, _, _) = gw.get("/badge/bob/thing/stars.svg").await;
    assert_eq!(s, 200);

    // By repository id: refused after the name resolved, and the mirror goes with the request.
    let other_dir = mirrors.join(format!("{ID_OTHER}.git"));
    assert!(other_dir.exists());
    std::fs::write(&file, format!("{ID_OTHER}\n")).unwrap();
    assert!(deny.reload_now());
    let (s, _, body) = gw.get("/alice/other.git/forge-manifest.json").await;
    assert_eq!(s, 451, "{body}");
    eventually("the mirror is deleted", || !other_dir.exists()).await;
    // The one listed before is served again: the list was replaced, not added to.
    assert!(gw.clone("/alice/proj.git", "c5").await.status.success());

    // By owner id: every repository of the identity.
    std::fs::write(&file, format!("{ID_BOB}\n")).unwrap();
    assert!(deny.reload_now());
    let (s, _, body) = gw.get("/badge/bob/thing/stars.svg").await;
    assert_eq!(s, 451, "{body}");
    let (s, _, _) = gw.get("/badge/alice/proj/stars.svg").await;
    assert_eq!(s, 200);

    // A deleted file keeps the list and says it may be out of date; an emptied one lifts it.
    std::fs::remove_file(&file).unwrap();
    assert!(!deny.reload_now());
    let (s, _, _) = gw.get("/badge/bob/thing/stars.svg").await;
    assert_eq!(s, 451);
    let (_, _, body) = gw.get("/readyz").await;
    let ready: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(ready["deny"]["state"], "unreadable");
    let (_, _, metrics) = gw.get("/metrics").await;
    assert!(
        metrics.contains("forge_gateway_deny_unreadable 1"),
        "{metrics}"
    );
    std::fs::write(&file, "# lifted\n").unwrap();
    assert!(deny.reload_now());
    let (s, _, _) = gw.get("/badge/bob/thing/stars.svg").await;
    assert_eq!(s, 200);

    let (_, _, metrics) = gw.get("/metrics").await;
    assert!(
        metrics.contains("forge_gateway_mirrors_purged_total 2"),
        "{metrics}"
    );
    assert!(
        metrics
            .lines()
            .any(|l| l.starts_with("forge_gateway_denied_total ") && !l.ends_with(" 0")),
        "{metrics}"
    );
}

/// M1: a listed `<DPNS name>/<name>` refuses the repository however the request spells it,
/// before any background resolution has run: case, `.git`, `.dash`, homograph spellings, and
/// the owner's id.
#[tokio::test(flavor = "multi_thread")]
async fn a_listed_name_refuses_every_spelling_before_it_has_been_resolved() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("deny.txt");
    std::fs::write(&file, "Alice/Proj.git\n").unwrap();
    let path = file.clone();
    let gw = start(move |c| c.deny_file = Some(path)).await;
    let src = source(&gw.tmp);
    deny_world(&gw, &src);
    // A repository of the same name that is somebody else's.
    gw.stub
        .add_with(ID_BOB_PROJ, ID_BOB, "bob", "proj", true, &src);

    // (No `enforce_deny` has run: nothing is resolved.)
    for path in [
        "alice/proj",
        "ALICE/PROJ",
        "Alice/Proj.git",
        "alice.dash/proj",
        "Alice.DASH/proj",
        "a1ice/proj",
        "a11ce/proj",
    ] {
        let (s, _, body) = gw
            .get(&format!("/{path}.git/forge-manifest.json").replace(".git.git", ".git"))
            .await;
        assert_eq!(s, 451, "{path}: {body}");
    }
    // By the owner's id the name does not match; the server settles the entry first.
    for path in [
        format!("/{ID_ALICE}/proj.git/forge-manifest.json"),
        format!("/{ID_ALICE}/PROJ.git/forge-manifest.json"),
        format!("/badge/{ID_ALICE}/proj/stars.svg"),
        format!("/feed/{ID_ALICE}/proj/releases.atom"),
        format!("/og/{ID_ALICE}/proj"),
    ] {
        let (s, _, body) = gw.get(&path).await;
        assert_eq!(s, 451, "{path}: {body}");
    }
    // Another owner's `proj` is served, and so is another name of alice's.
    let (s, _, body) = gw
        .get(&format!("/{ID_BOB}/proj.git/forge-manifest.json"))
        .await;
    assert_eq!(s, 200, "{body}");
    let (s, _, body) = gw
        .get(&format!("/{ID_ALICE}/other.git/forge-manifest.json"))
        .await;
    assert_eq!(s, 200, "{body}");
}

/// M1, failing closed: when the listed name cannot be settled, a repository of that name is
/// not served.
#[tokio::test(flavor = "multi_thread")]
async fn a_repository_that_may_be_a_listed_name_is_not_served_while_it_cannot_be_checked() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("deny.txt");
    std::fs::write(&file, "alice/proj\n").unwrap();
    let path = file.clone();
    let gw = start(move |c| c.deny_file = Some(path)).await;
    let src = source(&gw.tmp);
    deny_world(&gw, &src);

    // DPNS names cannot be read (the owner id still can).
    gw.stub.world().fail_name_reads = true;
    let (s, _, body) = gw
        .get(&format!("/{ID_ALICE}/proj.git/forge-manifest.json"))
        .await;
    assert_eq!(s, 503, "{body}");
    assert!(body.contains("deny list"), "{body}");
    // Another name has nothing to settle.
    let (s, _, _) = gw
        .get(&format!("/{ID_ALICE}/other.git/forge-manifest.json"))
        .await;
    assert_eq!(s, 200);
    // Readable again: the entry is settled, and the request is refused for what it is.
    gw.stub.world().fail_name_reads = false;
    let (s, _, body) = gw
        .get(&format!("/{ID_ALICE}/proj.git/forge-manifest.json"))
        .await;
    assert_eq!(s, 451, "{body}");
    // A repository of that name that is not the listed one is served once the entry is
    // settled (it resolved to alice's).
    gw.stub
        .add_with(ID_BOB_PROJ, ID_BOB, "bob", "proj", true, &src);
    let (s, _, body) = gw
        .get(&format!("/{ID_BOB}/proj.git/forge-manifest.json"))
        .await;
    assert_eq!(s, 200, "{body}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hidden_repository_gets_the_sites_card_and_is_still_served() {
    let tmp = tempfile::tempdir().unwrap();
    let stub = Stub::default();
    stub.world().time_ms = 1_000;
    let hidden = Hidden::parse(
        &format!(
            r#"{{"networks": {{"devnet-stub": {{
            "hiddenRepos": [{{ "id": "{ID_PROJ}", "added": "2026-10-16", "note": "x" }}],
            "hiddenIdentities": [{{ "id": "{ID_BOB}", "added": "2026-10-16", "note": "y" }}]
        }}}}}}"#
        ),
        "devnet-stub",
    )
    .unwrap();
    let (base, _, _) = serve_full(tmp.path(), &stub, |_| {}, Some(hidden)).await;
    let src = source(tmp.path());
    stub.add_with(ID_PROJ, ID_ALICE, "alice", "proj", true, &src);
    stub.add_with(ID_OTHER, ID_ALICE, "alice", "shown", true, &src);
    stub.add_with(ID_THING, ID_BOB, "bob", "thing", true, &src);

    for path in ["/og/alice/proj", "/og/bob/thing", "/og/alice/proj/issues/7"] {
        let (s, _, body) = request(&base, path).await;
        assert_eq!(s, 200, "{path}: {body}");
        assert_eq!(meta(&body, "og:title"), "Dash Forge", "{path}");
        assert_eq!(meta(&body, "og:image"), "https://forge.dashhq.org/og.png");
        assert!(!body.contains("A &lt;test"), "{path}: {body}");
    }
    // The card image is the site's, by redirect.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    for path in ["/og/alice/proj.png", "/og/bob/thing/issues/1.png"] {
        let r = client.get(format!("{base}{path}")).send().await.unwrap();
        assert_eq!(r.status().as_u16(), 302, "{path}");
        assert_eq!(r.headers()["location"], "https://forge.dashhq.org/og.png");
    }
    // Another repository keeps its own card.
    let (_, _, body) = request(&base, "/og/alice/shown").await;
    assert_eq!(meta(&body, "og:title"), "alice/shown");

    // Hiding is not delisting: clones, badges and feeds go on.
    for path in [
        "/alice/proj.git/forge-manifest.json",
        "/badge/alice/proj/stars.svg",
        "/feed/alice/proj/releases.atom",
        "/badge/bob/thing/stars.svg",
    ] {
        let (s, _, body) = request(&base, path).await;
        assert_eq!(s, 200, "{path}: {body}");
    }
    let out = tokio::task::spawn_blocking({
        let (url, dir) = (format!("{base}/alice/proj.git"), tmp.path().to_path_buf());
        move || git(&dir, &["clone", "-q", &url, "hidden-clone"])
    })
    .await
    .unwrap();
    assert!(out.status.success());
}

/// S3: a repository in backoff is fetched again as soon as its snapshot moves (a push, seen on
/// a relay wake), and a wake that finds the snapshot that failed changes nothing.
#[tokio::test(flavor = "multi_thread")]
async fn a_new_snapshot_ends_a_backoff_and_the_same_one_does_not() {
    let gw = start(|c| c.repo_max_bytes = 1 << 20).await;
    let src = source(&gw.tmp);
    let big = gw.stub.add("alice", "big", true, &src);
    gw.stub.world().pack_bytes = 2 << 20;
    assert!(matches!(
        gw.refresh(&big).await,
        Some(Unavailable::TooLarge { .. })
    ));
    let slot = gw.mirrors.slot(&big);
    let reads = gw.stub.world().snapshots;

    // A wake: the snapshot is read, found to be the one that failed, and nothing is fetched.
    gw.mirrors.trigger_wake(&slot);
    eventually("the snapshot is looked at", || {
        gw.stub.world().snapshots == reads + 1
    })
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!slot.ready());
    assert!(matches!(
        gw.refresh(&big).await,
        Some(Unavailable::TooLarge { .. })
    ));

    // A push changes the packs: the next wake fetches at once, backoff or not.
    gw.stub.world().pack_bytes = 100;
    gw.mirrors.trigger_wake(&slot);
    eventually("the new snapshot is mirrored", || slot.ready()).await;
    assert!(!slot.refresh_failing());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repository_whose_data_fails_backs_off_but_platform_failing_does_not() {
    let gw = start(|c| c.repo_max_bytes = 1 << 20).await;
    let src = source(&gw.tmp);
    let big = gw.stub.add("alice", "big", true, &src);
    gw.stub.world().pack_bytes = 2 << 20;

    // Too large: refused, and not read again until the backoff ends (one snapshot, not one
    // per request).
    assert!(matches!(
        gw.refresh(&big).await,
        Some(Unavailable::TooLarge { .. })
    ));
    let reads = gw.stub.world().snapshots;
    for _ in 0..3 {
        assert!(matches!(
            gw.refresh(&big).await,
            Some(Unavailable::TooLarge { .. })
        ));
        let (s, _, body) = gw
            .get("/alice/big.git/info/refs?service=git-upload-pack")
            .await;
        assert_eq!(s, 403, "{body}");
    }
    assert_eq!(
        gw.stub.world().snapshots,
        reads,
        "no read while backing off"
    );

    // Platform down is nobody's fault: tried again at once, as before.
    gw.stub.world().pack_bytes = 0;
    let ok = gw.stub.add("alice", "ok", true, &src);
    assert_eq!(gw.refresh(&ok).await, None);
    gw.stub.world().down = true;
    assert!(matches!(
        gw.refresh(&ok).await,
        Some(Unavailable::Failed(_))
    ));
    gw.stub.world().down = false;
    assert_eq!(gw.refresh(&ok).await, None);
}

#[test]
fn the_backoff_schedule_is_1_minute_5_minutes_30_minutes_then_6_hours() {
    use forge_gateway::mirror::backoff;
    let secs = |n| backoff(n).as_secs();
    assert_eq!(
        (secs(0), secs(1), secs(2), secs(3), secs(4), secs(40)),
        (0, 60, 300, 1800, 6 * 3600, 6 * 3600)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn pinned_mirrors_refresh_on_permits_that_unpinned_ones_cannot_take() {
    let gw = start(|c| {
        c.refresh_max = 1;
        c.pinned_refresh_max = 1;
    })
    .await;
    let src = source(&gw.tmp);
    let pinned = gw.stub.add("alice", "pinned", true, &src);
    let other = gw.stub.add("alice", "other", true, &src);

    // A hostile unpinned repository holds every unpinned permit.
    let hold = gw.mirrors.refresh_permits(false).acquire().await.unwrap();
    let slot = gw.mirrors.slot(&other);
    gw.mirrors.trigger(&slot);
    gw.mirrors.pin(&pinned);
    assert_eq!(gw.refresh(&pinned).await, None, "the pinned refresh runs");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!slot.ready(), "the unpinned one waits for its permit");
    drop(hold);
    eventually("the unpinned refresh runs", || slot.ready()).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn unpinned_repositories_have_a_lower_size_cap_than_pinned_ones() {
    let gw = start(|c| {
        c.repo_max_bytes = 8 << 20;
        c.unpinned_repo_max_bytes = 1 << 20;
        c.cache_max_bytes = 64 << 20;
    })
    .await;
    let src = source(&gw.tmp);
    let stranger = gw.stub.add("alice", "stranger", true, &src);
    let listed = gw.stub.add("alice", "listed", true, &src);
    gw.stub.world().pack_bytes = 2 << 20;
    let (s, _, body) = gw
        .get("/alice/stranger.git/info/refs?service=git-upload-pack")
        .await;
    assert_eq!(s, 403, "{body}");
    assert!(body.contains("larger than this gateway mirrors"), "{body}");
    assert!(matches!(
        gw.refresh(&stranger).await,
        Some(Unavailable::TooLarge { cap, .. }) if cap == 1 << 20
    ));
    gw.mirrors.pin(&listed);
    assert_eq!(
        gw.refresh(&listed).await,
        None,
        "a --repos mirror gets the full cap"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_card_for_an_item_above_the_repositorys_count_reads_no_item() {
    let gw = share_gateway().await;
    // The stub's count is the highest item number (8): the card for 50 is the repository's.
    let repo_png = reqwest::get(format!("{}/og/alice/proj.png", gw.base))
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    let reads = gw.stub.world().item_reads;
    for n in [9, 50, 4_000_000_000_u32] {
        let (s, _, body) = gw.get(&format!("/og/alice/proj/issues/{n}")).await;
        assert_eq!(s, 200, "{body}");
        assert_eq!(meta(&body, "og:title"), format!("Issue #{n} · alice/proj"));
        assert_eq!(
            meta(&body, "og:image"),
            "https://gw.example/og/alice/proj.png"
        );
        let r = reqwest::get(format!("{}/og/alice/proj/pull/{n}.png", gw.base))
            .await
            .unwrap();
        assert_eq!(r.status().as_u16(), 200);
        assert_eq!(r.bytes().await.unwrap(), repo_png);
    }
    assert_eq!(gw.stub.world().item_reads, reads, "no item was read");
    // One count read for the lot (cached per repository), none per number.
    assert_eq!(gw.stub.world().item_count_reads, 1);
    let (_, _, metrics) = gw.get("/metrics").await;
    assert!(
        metrics.contains("forge_gateway_items_beyond_count_total 6"),
        "{metrics}"
    );
    // A number within the count is read as before.
    let (_, _, body) = gw.get("/og/alice/proj/issues/7").await;
    assert_eq!(
        meta(&body, "og:title"),
        "It &lt;breaks&gt; · Issue #7 · alice/proj"
    );
    assert_eq!(gw.stub.world().item_reads, reads + 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn costly_limits_key_ipv6_clients_by_their_48() {
    let gw = start(|c| {
        c.trust_proxy = TrustProxy::Cloudflare;
        c.new_mirrors_per_hour = 1;
    })
    .await;
    let src = source(&gw.tmp);
    for name in ["a", "b", "c"] {
        gw.stub.add("alice", name, true, &src);
    }
    let client = reqwest::Client::new();
    let from = |ip: &'static str, path: &'static str| {
        let (client, base) = (client.clone(), gw.base.clone());
        async move {
            client
                .get(format!("{base}{path}"))
                .header("cf-connecting-ip", ip)
                .send()
                .await
                .unwrap()
                .status()
                .as_u16()
        }
    };
    // The first new mirror from 2001:db8:1::/48 starts; a second /64 of it has no allowance
    // of its own; another /48 does.
    assert_eq!(
        from("2001:db8:1:1::1", "/alice/a.git/forge-manifest.json").await,
        200
    );
    assert_eq!(
        from("2001:db8:1:2::1", "/alice/b.git/forge-manifest.json").await,
        429
    );
    assert_eq!(
        from("2001:db8:2:1::1", "/alice/c.git/forge-manifest.json").await,
        200
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn readyz_reports_the_version() {
    let gw = start(|_| {}).await;
    let (s, _, body) = gw.get("/readyz").await;
    assert_eq!(s, 200, "{body}");
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["version"]["crate"], env!("CARGO_PKG_VERSION"));
    // The commit is named only when the build was told (DASH_FORGE_BUILD_SHA); never "unknown".
    assert_ne!(v["version"]["buildSha"], "unknown");
    assert_eq!(
        v["version"]["buildSha"].as_str(),
        option_env!("DASH_FORGE_BUILD_SHA")
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != "unknown")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn cloudflare_trust_without_the_header_is_counted() {
    let gw = start(|c| c.trust_proxy = TrustProxy::Cloudflare).await;
    let src = source(&gw.tmp);
    gw.stub.add("alice", "proj", true, &src);
    // Probes never count (the container's health check sends no header), nor does a request
    // that has it.
    let (s, _, _) = gw.get("/healthz").await;
    assert_eq!(s, 200);
    let r = reqwest::Client::new()
        .get(format!("{}/badge/alice/proj/stars.svg", gw.base))
        .header("cf-connecting-ip", "198.51.100.7")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 200);
    let (_, _, metrics) = gw.get("/metrics").await;
    assert!(
        metrics.contains("forge_gateway_proxy_header_missing_total 0"),
        "{metrics}"
    );
    for _ in 0..2 {
        let (s, _, _) = gw.get("/badge/alice/proj/stars.svg").await;
        assert_eq!(s, 200);
    }
    let (_, _, metrics) = gw.get("/metrics").await;
    assert!(
        metrics.contains("forge_gateway_proxy_header_missing_total 2"),
        "{metrics}"
    );
}
