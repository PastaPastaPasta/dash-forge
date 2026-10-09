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
use forge_core::platform::{ChainTip, FetchedDocument, LoadedContract, PlatformClient};
use forge_core::repo::{RefRecord, RepoService};
use forge_core::resolve::DOC_REPO;
use forge_core::rules::v2::Visibility;
use forge_core::scope::{visibility_of, RepoRef};
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

/// A repository's open issues, as the issues badge reads them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct OpenIssues {
    /// How many are open (proved). The count is public and includes the members-only ones: that
    /// an issue exists, who opened it and its state are public.
    pub open: u64,
    /// How many of those are members-only, so the badge can say so ("3 open (2 members-only)").
    pub members_only: u64,
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

/// What a share link names inside a repository: an issue or a pull request, by number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ItemKind {
    /// `/<owner>/<name>/issues/<n>`.
    Issue,
    /// `/<owner>/<name>/pull/<n>`.
    Pull,
}

impl ItemKind {
    /// The short-URL segment (`issues`, `pull`).
    pub fn segment(self) -> &'static str {
        match self {
            ItemKind::Issue => "issues",
            ItemKind::Pull => "pull",
        }
    }
}

/// Where an issue or pull request stands, as its preview card says.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemState {
    /// Open.
    Open,
    /// A pull request marked draft (open).
    Draft,
    /// Closed (an issue, or a pull request closed without a merge).
    Closed,
    /// A pull request whose merge counted.
    Merged,
}

/// An issue or pull request everyone may read, as a link preview shows it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Item {
    /// Its title.
    pub title: String,
    /// Its body as stored (a long body's prefix, without the trailer naming the rest).
    pub body: String,
    /// Open, closed, merged or draft.
    pub state: ItemState,
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
    /// The snapshot one refresh serves, or `None` when Platform proves `repo` gone: its `repo`
    /// document (or the forge-core contract holding it) is absent, or it no longer is the
    /// public repository `repo` names. An error is a failed read, never a "gone".
    async fn snapshot(&self, repo: &RepoInfo) -> Result<Option<Snapshot>>;
    /// Whether `repo` is still on Platform: `false` only when proved gone, as for
    /// [`Self::snapshot`]. Cheaper than a snapshot (no ref reads).
    async fn exists(&self, repo: &RepoInfo) -> Result<bool>;
    /// Where `git fetch` reads the objects.
    fn fetch_source(&self, repo: &RepoInfo) -> FetchSource;
    /// The repository's description.
    async fn description(&self, repo: &RepoInfo) -> Result<String>;
    /// Its star count (proved).
    async fn stars(&self, repo: &RepoInfo) -> Result<u64>;
    /// Its open issues (proved counts), and how many of them are members-only.
    async fn open_issues(&self, repo: &RepoInfo) -> Result<OpenIssues>;
    /// The newest run per check name on `oid`.
    async fn checks(&self, repo: &RepoInfo, oid: &str) -> Result<Vec<Check>>;
    /// The live releases, in release order (highest version first).
    async fn releases(&self, repo: &RepoInfo) -> Result<Vec<ReleaseEntry>>;
    /// The newest issues no maintainer hid, newest first.
    async fn issues(&self, repo: &RepoInfo, limit: usize) -> Result<Vec<IssueEntry>>;
    /// Issue or pull request `number`, when everyone may read it: `None` when there is none,
    /// it is malformed, it is members-only (this reader is anonymous, so it cannot open it),
    /// or a maintainer hid it (or its author is banned). A preview card shows nothing of a
    /// `None` item beyond what its link already says.
    async fn item(&self, repo: &RepoInfo, kind: ItemKind, number: u32) -> Result<Option<Item>>;
}

/// How long after a `repo` document read absent it is read again before the repository counts
/// as gone. A repository is never deleted (forge-core's `repo` has `canBeDeleted: false`), so
/// one node's "absent" is as likely a node behind the one that resolved a repository just
/// created as a reset network.
const CONFIRM_GONE_AFTER: std::time::Duration = std::time::Duration::from_secs(5);

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

    /// How many of `r`'s open issues are members-only (sealed for members; a specific-people
    /// letter is not one): 0 for a repository without a members key, else read from its issues.
    async fn members_only_open(&self, collab: &Collab<'_>, r: &RepoRef) -> Result<u64> {
        if !forge_core::keyring::has_members_key(&self.client, r).await? {
            return Ok(0);
        }
        let sealed = collab.issues_with_state_read(r).await?.members_only;
        Ok(sealed
            .iter()
            .filter(|x| {
                x.state.open && x.placeholder.audience == forge_core::rules::v2::Audience::Members
            })
            .count() as u64)
    }

    /// Whether `e` proves the thing read absent. A missing forge contract counts only once a
    /// proved read of forge-core confirms it: one node's `contract not found` proves nothing.
    async fn proves_absent(&self, e: &CoreError) -> bool {
        match failure(e) {
            Failure::Absent => true,
            Failure::Read => false,
            Failure::ContractsMissing => self
                .client
                .contract_proved_absent(&self.forge_core)
                .await
                .unwrap_or(false),
        }
    }

    /// Whether the `repo` document with `repo`'s id is still the public repository `repo`
    /// names, proved. An absence is read again [`CONFIRM_GONE_AFTER`] later before it counts.
    async fn read_repo(
        &self,
        core: &LoadedContract,
        repo: &RepoInfo,
    ) -> forge_core::error::Result<bool> {
        let read = || async {
            let doc = self
                .client
                .fetch_document(core, DOC_REPO, &repo.repo_id)
                .await?;
            Ok::<_, CoreError>(doc.is_some_and(|d| still_same(&d, repo)))
        };
        if read().await? {
            return Ok(true);
        }
        tokio::time::sleep(CONFIRM_GONE_AFTER).await;
        read().await
    }

    /// [`Upstream::snapshot`]'s reads: the `repo` document by id with the chain tip, then (the
    /// repository still there) every ref, the default branch and the packs. On a reset network
    /// a repository's refs read as none at all, so without the document check a repository
    /// that is gone would be served as an empty one.
    async fn read_snapshot(
        &self,
        r: &RepoRef,
        repo: &RepoInfo,
    ) -> forge_core::error::Result<Option<Snapshot>> {
        let core = self.client.fetch_contract(&r.forge.core).await?;
        // The tip first: every update up to it is then in the ref reads that follow.
        let (present, tip) =
            futures::try_join!(self.read_repo(&core, repo), self.client.chain_tip())?;
        if !present {
            return Ok(None);
        }
        let svc = RepoService::reader(&self.client);
        let (records, default_branch, manifests) = futures::try_join!(
            svc.read_ref_records(r),
            svc.read_default_branch(r),
            svc.read_pack_manifests(r),
        )?;
        // A repository made public (private-repos.md §18.2): the packs it stored while private
        // are sealed, and the gateway, a non-member, opens only those whose keys the owner
        // published. git-remote-dash skips the rest without downloading them, so they neither
        // count toward the mirror's size nor appear in its manifest.
        let skipped = sealed_packs(&svc, r, &manifests).await;
        let mut packs: BTreeMap<String, ManifestPack> = BTreeMap::new();
        for m in manifests.iter().filter(|m| !skipped.contains(&m.pack_hash)) {
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
        Ok(Some(Snapshot {
            records,
            default_branch,
            tip: ChainTip {
                height: tip.height,
                time_ms: tip.time_ms.saturating_sub(SNAPSHOT_MARGIN_MS),
            },
            packs: packs.into_values().collect(),
        }))
    }
}

/// The git packs of a repository made public that this anonymous reader skips without
/// downloading ([`RepoService::skip_before_download`] with the published keys). Empty for any
/// other repository, and when the facts cannot be read (every pack then counts, as before).
async fn sealed_packs(
    svc: &RepoService<'_>,
    repo: &RepoRef,
    manifests: &[forge_core::repo::PackManifestInfo],
) -> std::collections::BTreeSet<[u8; 32]> {
    let mut out = std::collections::BTreeSet::new();
    let Ok(Some(conversion)) = svc.conversion(repo).await else {
        return out;
    };
    let Ok(contract) = svc.repo_contract(repo).await else {
        return out;
    };
    let keys = svc.public_keys(repo).await;
    let roles = svc.copy_roles(repo).await.unwrap_or_default();
    let git: Vec<forge_core::repo::PackManifestInfo> = manifests
        .iter()
        .filter(|m| m.kind == u64::from(forge_core::pack::KIND_GIT_PACK))
        .cloned()
        .collect();
    let reader = svc.repo_reader(repo, &git, &roles).await;
    for (hash, copies) in forge_core::repo::group_by_hash(&git) {
        if svc
            .skip_before_download(
                repo,
                &contract,
                &copies,
                &reader,
                &conversion,
                keys.as_deref(),
            )
            .await
            .is_some()
        {
            out.insert(hash);
        }
    }
    out
}

/// What a failed read says about the thing it read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Failure {
    /// Platform proved it absent.
    Absent,
    /// A forge contract may be missing (a reset devnet); confirm before acting on it.
    ContractsMissing,
    /// The read failed: nothing is known.
    Read,
}

fn failure(e: &CoreError) -> Failure {
    match e {
        CoreError::NotFound => Failure::Absent,
        CoreError::User(u) if [codes::NOT_FOUND, codes::INVALID_REPO_REF].contains(&u.code) => {
            Failure::Absent
        }
        CoreError::ContractsMissing { .. } => Failure::ContractsMissing,
        CoreError::User(u) if u.code == codes::NOT_DEPLOYED => Failure::ContractsMissing,
        _ => Failure::Read,
    }
}

/// Whether `doc`, the `repo` document with `repo`'s id, is still the public repository `repo`
/// names (same owner and name). A repository that moved owner or name, or turned private, is
/// not the one this mirror serves.
fn still_same(doc: &FetchedDocument, repo: &RepoInfo) -> bool {
    doc.id == repo.repo_id
        && doc.owner_id == repo.owner_id
        && doc.field_str("name").as_deref() == Some(repo.name.as_str())
        && visibility_of(doc) == Visibility::Public
}

/// Whether a preview card may show `doc`'s own words (its title and body): only when it is
/// plaintext (no `enc`) and stamped `vis: "public"`. A document this anonymous reader opened is
/// not enough: a specific-people letter (`enc` v0x04) is never a public card, and a repository
/// made public keeps what was written while it was private as `vis: "private"` even where the
/// owner published the keys that open it (`private-repos.md` §18.1). A post its author made
/// public is plaintext and `vis: "public"` again. `issue` and `patch` require `vis`
/// (`forge-contracts/contracts/forge-collab.json`, `layout::VIS_TYPES`), so one without it is
/// not shown either.
fn titled(doc: &FetchedDocument) -> bool {
    doc.field_str(forge_core::layout::VIS).as_deref() == Some(Visibility::Public.as_str())
        && doc
            .fields
            .get("enc")
            .is_none_or(|e| e.as_bytes().is_some_and(|b| b.is_empty()))
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
            Err(e) if self.proves_absent(&e).await => Ok(None),
            Err(e) => Err(anyhow!(e).context(format!("resolving {owner}/{name}"))),
        }
    }

    async fn snapshot(&self, repo: &RepoInfo) -> Result<Option<Snapshot>> {
        let r = self.repo_ref(repo)?;
        match Box::pin(self.read_snapshot(&r, repo)).await {
            Ok(s) => Ok(s),
            Err(e) if self.proves_absent(&e).await => Ok(None),
            Err(e) => Err(anyhow!(e).context(format!("reading {}", repo.repo_id))),
        }
    }

    async fn exists(&self, repo: &RepoInfo) -> Result<bool> {
        let r = self.repo_ref(repo)?;
        let read = async {
            let core = self.client.fetch_contract(&r.forge.core).await?;
            self.read_repo(&core, repo).await
        };
        match read.await {
            Ok(present) => Ok(present),
            Err(e) if self.proves_absent(&e).await => Ok(false),
            Err(e) => Err(anyhow!(e).context(format!("reading {}", repo.repo_id))),
        }
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

    async fn open_issues(&self, repo: &RepoInfo) -> Result<OpenIssues> {
        let r = self.repo_ref(repo)?;
        let collab = Collab::reader(&self.client);
        let open = collab.repo_state_counts(&r).await?.issues_open;
        // The members-only share is read from the issues themselves, and only for a repository
        // that has members-only content turned on: any other repo's badge costs what it did. A
        // read that fails leaves the proved count unlabelled rather than the badge unavailable.
        let members_only = if open > 0 {
            match self.members_only_open(&collab, &r).await {
                Ok(n) => n,
                Err(e) => {
                    tracing::warn!(error = %format!("{e:#}"), "members-only issues not counted");
                    0
                }
            }
        } else {
            0
        };
        Ok(OpenIssues {
            open,
            members_only: members_only.min(open),
        })
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

    async fn item(&self, repo: &RepoInfo, kind: ItemKind, number: u32) -> Result<Option<Item>> {
        use forge_core::collab::v2::{issue_from_doc, patch_from_doc, TargetKind, TargetRead};
        use forge_core::rules::long_body::{self, LongBody};
        let r = self.repo_ref(repo)?;
        let collab = Collab::reader(&self.client);
        let target_kind = match kind {
            ItemKind::Issue => TargetKind::Issue,
            ItemKind::Pull => TargetKind::Patch,
        };
        // By number, as this anonymous reader reads it: a members-only issue or PR is its
        // placeholder (DESIGN D14), never opened here, so nothing of it reaches a card.
        let doc = match collab.target_read(&r, target_kind, number).await {
            Ok(Some(TargetRead::Readable(d))) if titled(&d) => d,
            Ok(Some(_) | None) => return Ok(None),
            Err(e) if self.proves_absent(&e).await => return Ok(None),
            Err(e) => {
                return Err(anyhow!(e).context(format!("reading {} #{number}", kind.segment())))
            }
        };
        let (target, title, body, log, state) = match kind {
            ItemKind::Issue => {
                let issue = issue_from_doc(&doc);
                let log = collab.target_log(&r, &issue.document_id).await?;
                let open =
                    forge_core::rules::v2::issue_state_v2(log.state_code(), &log.events).open;
                let state = if open {
                    ItemState::Open
                } else {
                    ItemState::Closed
                };
                (issue.target(), issue.title, issue.body, log, state)
            }
            ItemKind::Pull => {
                let patch = patch_from_doc(&doc);
                let target = patch.target();
                let (title, body) = (patch.title.clone(), patch.body.clone());
                let view = collab.patch_view(&r, patch).await?;
                let state = match (view.state.merged, view.state.open, view.state.draft) {
                    (true, _, _) => ItemState::Merged,
                    (false, false, _) => ItemState::Closed,
                    (false, true, true) => ItemState::Draft,
                    (false, true, false) => ItemState::Open,
                };
                (target, title, body, view.log, state)
            }
        };
        // A thread a maintainer hid, or whose author is banned, collapses on the web: its card
        // shows no more of it than of a members-only one.
        let id = target.id.clone();
        if collab
            .hidden_threads(&r, &[(target, log.events.as_slice())])
            .await
            .contains_key(&id)
        {
            return Ok(None);
        }
        // A long body's field is its prefix and a trailer naming the rest (forge-v2.md §6.3).
        let body = match long_body::parse(&body) {
            LongBody::Plain => body,
            LongBody::Continued { prefix, .. } | LongBody::Unsupported { prefix } => {
                prefix.to_string()
            }
        };
        Ok(Some(Item { title, body, state }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::platform::FieldValue;
    use forge_core::user_error::UserError;

    #[test]
    fn only_a_proved_absence_or_a_missing_contract_is_more_than_a_failed_read() {
        assert_eq!(failure(&CoreError::NotFound), Failure::Absent);
        assert_eq!(
            failure(&UserError::new(codes::NOT_FOUND, "no DPNS name").into()),
            Failure::Absent
        );
        // E702 on a reset devnet: the contract has to be proved absent before it counts.
        let missing = CoreError::ContractsMissing {
            network: "devnet sakura".into(),
            detail: "contract X: Platform proved it absent".into(),
        };
        assert_eq!(failure(&missing), Failure::ContractsMissing);
        assert_eq!(
            failure(&UserError::new(codes::NOT_DEPLOYED, "not deployed").into()),
            Failure::ContractsMissing
        );
        for read in [
            CoreError::Platform("proved chain-tip read failed: timeout".into()),
            UserError::new(codes::UNEXPECTED, "boom").into(),
        ] {
            assert_eq!(failure(&read), Failure::Read, "{read:?}");
        }
    }

    #[test]
    fn only_plaintext_public_documents_are_titled() {
        let doc = |fields: Vec<(&str, FieldValue)>| FetchedDocument {
            id: "I1".into(),
            owner_id: "O1".into(),
            created_at: None,
            created_at_block_height: None,
            updated_at_block_height: None,
            updated_at: None,
            fields: fields
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .chain([("title".to_string(), FieldValue::text("secret title"))])
                .collect(),
            revision: None,
        };
        let public = ("vis", FieldValue::text("public"));
        let private = ("vis", FieldValue::text("private"));
        // A plain public issue, and one its author made public (enc dropped, vis public).
        assert!(titled(&doc(vec![public.clone()])));
        assert!(titled(&doc(vec![
            public.clone(),
            ("enc", FieldValue::Bytes(vec![]))
        ])));
        // Members-only (enc v0x03) in a public repository, even when this reader opened it.
        assert!(!titled(&doc(vec![
            public.clone(),
            ("enc", FieldValue::Bytes(vec![0x03, 1, 2]))
        ])));
        // A specific-people letter (enc v0x04).
        assert!(!titled(&doc(vec![
            public.clone(),
            ("enc", FieldValue::Bytes(vec![0x04, 1, 2]))
        ])));
        // Written before its repository was made public: still private, sealed or not.
        assert!(!titled(&doc(vec![private.clone()])));
        assert!(!titled(&doc(vec![
            private,
            ("enc", FieldValue::Bytes(vec![0x01, 1]))
        ])));
        // No stamp at all: not shown.
        assert!(!titled(&doc(vec![])));
        // An `enc` of any other shape counts as sealed.
        assert!(!titled(&doc(vec![
            public,
            ("enc", FieldValue::text("03ab"))
        ])));
    }

    #[test]
    fn a_repo_document_must_still_be_the_public_repo_the_mirror_serves() {
        let repo = RepoInfo {
            repo_id: "R1".into(),
            owner_id: "O1".into(),
            name: "proj".into(),
            public: true,
        };
        let doc = |id: &str, owner: &str, name: &str, visibility: Option<&str>| {
            let mut fields = BTreeMap::from([("name".to_string(), FieldValue::text(name))]);
            if let Some(v) = visibility {
                fields.insert("visibility".into(), FieldValue::text(v));
            }
            FetchedDocument {
                id: id.into(),
                owner_id: owner.into(),
                created_at: None,
                created_at_block_height: None,
                updated_at_block_height: None,
                updated_at: None,
                fields,
                revision: None,
            }
        };
        assert!(still_same(&doc("R1", "O1", "proj", None), &repo));
        assert!(still_same(&doc("R1", "O1", "proj", Some("public")), &repo));
        assert!(!still_same(&doc("R2", "O1", "proj", None), &repo));
        assert!(!still_same(&doc("R1", "O2", "proj", None), &repo));
        assert!(!still_same(&doc("R1", "O1", "renamed", None), &repo));
        assert!(!still_same(
            &doc("R1", "O1", "proj", Some("private")),
            &repo
        ));
    }
}
