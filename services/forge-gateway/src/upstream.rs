//! Where a mirror's truth comes from: the [`Upstream`] trait, and [`PlatformUpstream`], its
//! implementation over forge-core's proof-verified reads. Tests implement it over a local git
//! repository (`tests/gateway.rs`), so the serving, refresh, eviction and limit paths run with
//! no network.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{anyhow, Context as _, Result};
use async_trait::async_trait;
use forge_core::collab::v2::Collab;
use forge_core::error::Error as CoreError;
use forge_core::mirror::ManifestPack;
use forge_core::platform::{ChainTip, PlatformClient};
use forge_core::repo::{RefRecord, RepoService};
use forge_core::rules::v2::Visibility;
use forge_core::scope::RepoRef;
use forge_core::user_error::codes;

/// A repository as the gateway addresses it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoInfo {
    /// The `repo` document id (base58): the mirror's directory name.
    pub repo_id: String,
    /// The owner identity id (base58).
    pub owner_id: String,
    /// The repository's name (slug).
    pub name: String,
    /// Public: a private repository is never mirrored.
    pub public: bool,
}

/// A proof-verified snapshot of a repository's refs: what one refresh serves.
#[derive(Debug, Clone)]
pub struct Snapshot {
    /// Every ref ([`RepoService::read_ref_records`]).
    pub records: Vec<RefRecord>,
    /// The default branch the newest `config` names.
    pub default_branch: Option<String>,
    /// "As of": every ref update up to this time is reflected.
    pub tip: ChainTip,
    /// The recorded git packs (their sizes bound what a mirror costs on disk).
    pub packs: Vec<ManifestPack>,
}

impl Snapshot {
    /// The bytes the repository's packs hold (one copy of each).
    pub fn pack_bytes(&self) -> u64 {
        self.packs.iter().map(|p| p.size_bytes).sum()
    }

    /// The live refs, by name.
    pub fn tips(&self) -> BTreeMap<String, String> {
        self.records
            .iter()
            .filter_map(|r| r.tip.as_ref().map(|t| (t.name.clone(), t.oid.clone())))
            .collect()
    }
}

/// What `git fetch` reads a repository's objects from.
#[derive(Debug, Clone, Default)]
pub struct FetchSource {
    /// The remote URL (`dash://<repo id>`, or a local path in tests).
    pub url: String,
    /// Environment set for the fetch.
    pub env: Vec<(String, String)>,
    /// Environment removed for the fetch (an operator's own identity, say).
    pub env_remove: Vec<String>,
}

/// A CI check as a badge reads it: the newest run of each name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Check {
    /// The check's name.
    pub name: String,
    /// `queued`, `in_progress` or `completed`.
    pub status: String,
    /// The conclusion once completed.
    pub conclusion: String,
    /// Reported by a current maintainer, writer or runner.
    pub trusted: bool,
}

/// A release as a feed and a badge read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseEntry {
    /// The tag.
    pub tag: String,
    /// The display name.
    pub name: String,
    /// The notes (Markdown, shown as text).
    pub notes: String,
    /// `$createdAt` (ms).
    pub created_at: u64,
    /// Yanked.
    pub yanked: bool,
    /// The `release` document id.
    pub document_id: String,
}

/// An issue as a feed reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueEntry {
    /// Its number.
    pub number: u32,
    /// Its title.
    pub title: String,
    /// Its author's identity id.
    pub author: String,
    /// `$createdAt` (ms).
    pub created_at: u64,
    /// The `issue` document id.
    pub document_id: String,
}

/// The source of truth a gateway mirrors.
#[async_trait]
pub trait Upstream: Send + Sync + 'static {
    /// The network key the manifest names (`devnet-sakura`).
    fn network(&self) -> String;
    /// The forge-core contract id the manifest names.
    fn forge_core(&self) -> String;
    /// `owner/name` (owner an identity id or DPNS name), or `None` when there is no such
    /// repository. An error is a failed read, not an absence.
    async fn resolve(&self, owner: &str, name: &str) -> Result<Option<RepoInfo>>;
    /// The snapshot one refresh serves.
    async fn snapshot(&self, repo: &RepoInfo) -> Result<Snapshot>;
    /// Where `git fetch` reads the objects.
    fn fetch_source(&self, repo: &RepoInfo) -> FetchSource;
    /// The repository's description.
    async fn description(&self, repo: &RepoInfo) -> Result<String>;
    /// Its star count (proved).
    async fn stars(&self, repo: &RepoInfo) -> Result<u64>;
    /// Its open issues (proved counts).
    async fn open_issues(&self, repo: &RepoInfo) -> Result<u64>;
    /// The newest run per check name on `oid`.
    async fn checks(&self, repo: &RepoInfo, oid: &str) -> Result<Vec<Check>>;
    /// The live releases, in release order (highest version first).
    async fn releases(&self, repo: &RepoInfo) -> Result<Vec<ReleaseEntry>>;
    /// The newest issues no maintainer hid, newest first.
    async fn issues(&self, repo: &RepoInfo, limit: usize) -> Result<Vec<IssueEntry>>;
}

/// How long before the chain tip a manifest claims to reflect: a DAPI node answering the
/// ref read may be a few blocks behind the one that answered the tip read, and a manifest
/// must never claim more than it holds (`dg verify-mirror` calls that a mismatch).
pub const SNAPSHOT_MARGIN_MS: u64 = 60_000;

/// [`Upstream`] over Dash Platform, read anonymously with proofs.
pub struct PlatformUpstream {
    client: Arc<PlatformClient>,
    network: String,
    forge_core: String,
    helper_dir: Option<PathBuf>,
    home: PathBuf,
}

impl PlatformUpstream {
    /// Over `client`. `home` is the isolated `HOME` the fetch runs with (no operator identity,
    /// dg config or git config leaks in); `helper_dir` holds `git-remote-dash`.
    pub fn new(client: PlatformClient, home: PathBuf, helper_dir: Option<PathBuf>) -> Result<Self> {
        let forge_core = client.target().require_v2()?.core.clone();
        let network = client.target().network.key();
        Ok(Self {
            client: Arc::new(client),
            network,
            forge_core,
            helper_dir,
            home,
        })
    }

    /// The client (badges and the like read through it).
    pub fn client(&self) -> &PlatformClient {
        &self.client
    }

    fn repo_ref(&self, repo: &RepoInfo) -> Result<RepoRef> {
        if !repo.public {
            return Err(anyhow!("{} is private: never mirrored", repo.repo_id));
        }
        Ok(RepoRef {
            forge: self.client.target().require_v2()?.clone(),
            repo_id: repo.repo_id.clone(),
            owner_id: repo.owner_id.clone(),
            name: repo.name.clone(),
            visibility: Visibility::Public,
        })
    }
}

/// Whether `e` says the thing does not exist (rather than that the read failed).
fn is_absent(e: &CoreError) -> bool {
    match e {
        CoreError::NotFound => true,
        CoreError::User(u) => [codes::NOT_FOUND, codes::INVALID_REPO_REF].contains(&u.code),
        _ => false,
    }
}

fn info_of(r: &RepoRef) -> RepoInfo {
    RepoInfo {
        repo_id: r.repo_id.clone(),
        owner_id: r.owner_id.clone(),
        name: r.name.clone(),
        public: r.visibility == Visibility::Public,
    }
}

#[async_trait]
impl Upstream for PlatformUpstream {
    fn network(&self) -> String {
        self.network.clone()
    }

    fn forge_core(&self) -> String {
        self.forge_core.clone()
    }

    async fn resolve(&self, owner: &str, name: &str) -> Result<Option<RepoInfo>> {
        match forge_core::resolve::resolve_named(&self.client, owner, name).await {
            Ok(r) => Ok(Some(info_of(&r))),
            Err(e) if is_absent(&e) => Ok(None),
            Err(e) => Err(anyhow!(e).context(format!("resolving {owner}/{name}"))),
        }
    }

    async fn snapshot(&self, repo: &RepoInfo) -> Result<Snapshot> {
        let r = self.repo_ref(repo)?;
        let svc = RepoService::reader(&self.client);
        // The tip first: every update up to it is then in the reads that follow.
        let tip = self.client.chain_tip().await?;
        let (records, default_branch, manifests) = futures::try_join!(
            svc.read_ref_records(&r),
            svc.read_default_branch(&r),
            svc.read_pack_manifests(&r),
        )?;
        let mut packs: BTreeMap<String, ManifestPack> = BTreeMap::new();
        for m in &manifests {
            let hash = hex::encode(m.pack_hash);
            packs
                .entry(hash.clone())
                .and_modify(|p| p.copies += 1)
                .or_insert(ManifestPack {
                    pack_hash: hash,
                    copies: 1,
                    size_bytes: m.size_bytes,
                });
        }
        Ok(Snapshot {
            records,
            default_branch,
            tip: ChainTip {
                height: tip.height,
                time_ms: tip.time_ms.saturating_sub(SNAPSHOT_MARGIN_MS),
            },
            packs: packs.into_values().collect(),
        })
    }

    fn fetch_source(&self, repo: &RepoInfo) -> FetchSource {
        let mut env: Vec<(String, String)> = self
            .client
            .target()
            .env_vars()
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        let home = self.home.display().to_string();
        env.push(("HOME".into(), home.clone()));
        env.push(("XDG_CONFIG_HOME".into(), format!("{home}/.config")));
        env.push(("GIT_TERMINAL_PROMPT".into(), "0".into()));
        env.push(("GIT_CONFIG_NOSYSTEM".into(), "1".into()));
        if let Some(dir) = &self.helper_dir {
            let path = std::env::var("PATH").unwrap_or_default();
            env.push(("PATH".into(), format!("{}:{path}", dir.display())));
        }
        FetchSource {
            // By id: a DPNS name changing hands cannot redirect a mirror.
            url: format!("dash://{}", repo.repo_id),
            env,
            env_remove: [
                "DASH_FORGE_KEY",
                "DASH_FORGE_IDENTITY",
                "DASH_FORGE_PASSPHRASE",
            ]
            .map(String::from)
            .to_vec(),
        }
    }

    async fn description(&self, repo: &RepoInfo) -> Result<String> {
        let r = self.repo_ref(repo)?;
        Ok(forge_core::resolve::repo_description(&self.client, &r).await?)
    }

    async fn stars(&self, repo: &RepoInfo) -> Result<u64> {
        let r = self.repo_ref(repo)?;
        Ok(Collab::reader(&self.client).star_count(&r).await?)
    }

    async fn open_issues(&self, repo: &RepoInfo) -> Result<u64> {
        let r = self.repo_ref(repo)?;
        Ok(Collab::reader(&self.client)
            .repo_state_counts(&r)
            .await?
            .issues_open)
    }

    async fn checks(&self, repo: &RepoInfo, oid: &str) -> Result<Vec<Check>> {
        let r = self.repo_ref(repo)?;
        let runs = Collab::reader(&self.client)
            .check_runs(&r, oid)
            .await
            .context("reading check runs")?;
        Ok(runs
            .into_iter()
            .map(|c| Check {
                name: c.name,
                status: c.status,
                conclusion: c.conclusion,
                trusted: c.trusted,
            })
            .collect())
    }

    async fn releases(&self, repo: &RepoInfo) -> Result<Vec<ReleaseEntry>> {
        let r = self.repo_ref(repo)?;
        let list = Collab::reader(&self.client).releases(&r).await?;
        Ok(list
            .current
            .into_iter()
            .filter(|rel| !rel.is_draft() && rel.delta >= 0)
            .map(|rel| ReleaseEntry {
                tag: rel.tag_name,
                name: rel.name,
                notes: rel.notes,
                created_at: rel.created_at,
                yanked: rel.yanked,
                document_id: rel.document_id,
            })
            .collect())
    }

    async fn issues(&self, repo: &RepoInfo, limit: usize) -> Result<Vec<IssueEntry>> {
        use forge_core::rules::Event;
        let r = self.repo_ref(repo)?;
        let collab = Collab::reader(&self.client);
        let (mut all, _hidden) = collab.issues_with_state(&r).await?;
        all.sort_by_key(|v| std::cmp::Reverse(v.issue.created_at));
        // A few extra, so hidden ones leave the page close to full.
        all.truncate(limit + 10);
        let threads: Vec<(forge_core::collab::v2::Target, &[Event])> = all
            .iter()
            .map(|v| (v.issue.target(), v.log.events.as_slice()))
            .collect();
        let hides = collab.hidden_threads(&r, &threads).await;
        Ok(all
            .iter()
            .filter(|v| !hides.contains_key(&v.issue.document_id))
            .take(limit)
            .map(|v| IssueEntry {
                number: v.issue.number,
                title: v.issue.title.clone(),
                author: v.issue.author.clone(),
                created_at: v.issue.created_at,
                document_id: v.issue.document_id.clone(),
            })
            .collect())
    }
}
