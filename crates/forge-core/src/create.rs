//! Creating a forge-v2 repository: one journaled, resumable session.
//!
//! A new repository is three documents in the network's forge-core contract, written in
//! this order because each one's consensus gate needs the one before it:
//!
//! 1. `repo` — the name slug, display name, description, default branch and visibility
//!    (anyone may create one; `(owner, name)` is unique).
//! 2. the owner's own `maintainer` document — only the repo's owner may create it, and
//!    without it the owner could not write the M-gated `config` (or push to a protected
//!    ref). This is the v2 form of v1's "the owner is credited both tokens at creation".
//! 3. the initial `config` — default branch and storage backend.
//!
//! **Resumable, never double-paying.** Before each document is broadcast, its signed
//! transition is saved to a journal (`$XDG_STATE_HOME/dash-forge/journals/`). A session
//! that dies anywhere — before a broadcast, mid-broadcast, between steps — is resumed by
//! running the same create again: a step with a saved transition re-broadcasts those exact
//! bytes (which land at most once) and is then confirmed by fetching the document; a step
//! without one first checks whether its document already exists. Only a step that provably
//! has no document and no pending transition signs a new one. The journal is deleted once
//! all three documents exist.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::keystore::BridgeIdentity;
use crate::members::{doc_type, MemberReader};
use crate::network::ForgeIds;
use crate::platform::{
    self, FieldValue, LoadedContract, LoadedIdentity, PlatformClient, QueryFilter, WriteEngine,
    WriteIntent,
};
use crate::resolve::{find_v2, repo_slug, DOC_REPO};
use crate::rules::v2::{Role, Visibility};
use crate::scope::RepoRef;

/// The initial `config` document type.
const DOC_CONFIG: &str = "config";

/// What to create.
#[derive(Debug, Clone)]
pub struct CreateRepoOpts {
    /// The URL slug (normalized: ASCII letters are lower-cased).
    pub name: String,
    /// The display name (`repo.displayName`); empty = none.
    pub display_name: String,
    /// The description (`repo.description`); empty = none.
    pub description: String,
    /// The default branch (`repo.defaultBranch` and `config.defaultBranch`), e.g. `main`.
    pub default_branch: String,
    /// `config.backend.mode` (`0` platform, `1` ipfs, `2` s3, `3` https, `4` mixed).
    pub backend_mode: u8,
    /// The visibility. Only public is supported until the private-repo release.
    pub visibility: Visibility,
}

impl CreateRepoOpts {
    /// A public repository named `name` on the Platform backend, default branch `main`.
    pub fn public(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            display_name: String::new(),
            description: String::new(),
            default_branch: "main".into(),
            backend_mode: 0,
            visibility: Visibility::Public,
        }
    }
}

/// How one step of the session ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StepOutcome {
    /// Written by this run.
    Created,
    /// A transition saved by an interrupted run was re-broadcast and confirmed.
    Resumed,
    /// The document already existed; nothing was written.
    Existed,
}

/// The result of [`create_repo`].
#[derive(Debug, Clone)]
pub struct CreateRepoResult {
    /// The repository.
    pub repo: RepoRef,
    /// `repo`, `maintainer` and `config`, in order, with how each ended.
    pub steps: Vec<(&'static str, StepOutcome)>,
    /// The owner's balance change across the session, in credits (what it cost).
    pub cost_credits: u64,
}

impl CreateRepoResult {
    /// Whether every document already existed (a re-run of a finished create).
    pub fn already_existed(&self) -> bool {
        self.steps.iter().all(|(_, o)| *o == StepOutcome::Existed)
    }
}

/// The on-disk session record.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateJournal {
    /// The forge-core contract the session writes into.
    core: String,
    /// The owner identity.
    owner: String,
    /// The repo slug.
    name: String,
    /// The saved `repo` create, once signed.
    #[serde(default)]
    repo: Option<WriteIntent>,
    /// The saved owner `maintainer` create, once signed.
    #[serde(default)]
    maintainer: Option<WriteIntent>,
    /// The saved initial `config` create, once signed.
    #[serde(default)]
    config: Option<WriteIntent>,
}

/// The directory create journals live in: `$XDG_STATE_HOME/dash-forge/journals`, else
/// `~/.local/state/dash-forge/journals`.
pub fn default_journal_dir() -> Result<PathBuf> {
    if let Some(state) = std::env::var_os("XDG_STATE_HOME").filter(|s| !s.is_empty()) {
        return Ok(PathBuf::from(state).join("dash-forge/journals"));
    }
    let home = std::env::var_os("HOME").ok_or_else(|| {
        Error::Config("HOME is not set; cannot locate the journal directory".into())
    })?;
    Ok(PathBuf::from(home).join(".local/state/dash-forge/journals"))
}

/// The journal file of one create session.
fn journal_path(dir: &Path, network: &str, owner: &str, name: &str) -> PathBuf {
    dir.join(format!("create-{network}-{owner}-{name}.json"))
}

struct Journal {
    path: PathBuf,
    state: CreateJournal,
}

impl Journal {
    /// Load the session's journal, or start one. A journal for another contract (a
    /// re-registered forge-core) is ignored: its transitions target a contract that is not
    /// this network's forge any more.
    fn open(path: PathBuf, core: &str, owner: &str, name: &str) -> Self {
        let fresh = CreateJournal {
            core: core.into(),
            owner: owner.into(),
            name: name.into(),
            ..CreateJournal::default()
        };
        let state = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<CreateJournal>(&b).ok())
            .filter(|j| j.core == core && j.owner == owner && j.name == name)
            .unwrap_or(fresh);
        Self { path, state }
    }

    fn save(&self) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| Error::Io(e.to_string()))?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&self.state)?)
            .map_err(|e| Error::Io(e.to_string()))?;
        std::fs::rename(&tmp, &self.path).map_err(|e| Error::Io(e.to_string()))
    }

    fn slot(&mut self, step: Step) -> &mut Option<WriteIntent> {
        match step {
            Step::Repo => &mut self.state.repo,
            Step::Maintainer => &mut self.state.maintainer,
            Step::Config => &mut self.state.config,
        }
    }

    fn finish(self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    Repo,
    Maintainer,
    Config,
}

impl Step {
    fn doc_type(self) -> &'static str {
        match self {
            Step::Repo => DOC_REPO,
            Step::Maintainer => doc_type(Role::Maintainer),
            Step::Config => DOC_CONFIG,
        }
    }
}

/// The `repo` document's properties.
fn repo_props(opts: &CreateRepoOpts) -> BTreeMap<String, FieldValue> {
    let mut p = BTreeMap::new();
    p.insert("name".into(), FieldValue::text(&opts.name));
    p.insert("visibility".into(), FieldValue::text("public"));
    p.insert(
        "defaultBranch".into(),
        FieldValue::text(&opts.default_branch),
    );
    if !opts.description.is_empty() {
        p.insert("description".into(), FieldValue::text(&opts.description));
    }
    if !opts.display_name.is_empty() {
        p.insert("displayName".into(), FieldValue::text(&opts.display_name));
    }
    p
}

/// The initial `config` document's properties (no protected patterns: an empty list is the
/// same as none, and omitting it keeps the document small).
fn config_props(repo_id: [u8; 32], opts: &CreateRepoOpts) -> BTreeMap<String, FieldValue> {
    let mut backend = BTreeMap::new();
    backend.insert(
        "mode".into(),
        FieldValue::integer(u64::from(opts.backend_mode)),
    );
    let mut p = BTreeMap::new();
    p.insert("repoId".into(), FieldValue::identifier(repo_id));
    p.insert(
        "defaultBranch".into(),
        FieldValue::text(&opts.default_branch),
    );
    p.insert("backend".into(), FieldValue::Object(backend));
    p.insert("archived".into(), FieldValue::boolean(false));
    p
}

/// Re-broadcast a saved transition and confirm its document exists. `false` means the
/// transition never landed and never will (its nonce went to another write): the caller
/// discards it and decides afresh.
async fn replay_confirmed(
    client: &PlatformClient,
    engine: &WriteEngine<'_>,
    core: &LoadedContract,
    step: Step,
    intent: &WriteIntent,
) -> Result<bool> {
    engine.replay(step.doc_type(), intent).await?;
    // A proved read right after the landing proof can lag by a block; poll briefly.
    for attempt in 0..6 {
        if client
            .document_exists(core, step.doc_type(), &intent.document_id)
            .await?
        {
            return Ok(true);
        }
        if attempt < 5 {
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        }
    }
    Ok(false)
}

/// Create (or finish creating) the repository `opts` describes, owned by `identity`.
///
/// Idempotent: re-running a create that finished returns the existing repository with every
/// step [`StepOutcome::Existed`] and a cost of zero. `journal_dir` is where the session
/// record lives ([`default_journal_dir`] for the CLI).
pub async fn create_repo(
    client: &PlatformClient,
    identity: &LoadedIdentity,
    bridge: &BridgeIdentity,
    opts: &CreateRepoOpts,
    journal_dir: &Path,
) -> Result<CreateRepoResult> {
    let target = client.target();
    let forge: ForgeIds = target.v2.clone().ok_or_else(|| Error::V2NotDeployed {
        network: target.network.key(),
    })?;
    let opts = validated(opts)?;
    let owner = identity.id();
    let owner_bytes = platform::decode_identifier(&owner)?;
    let core = client.fetch_contract(&forge.core).await?;
    let engine = WriteEngine::new(client, identity, bridge.doc_op_key()?)?;
    let mut journal = Journal::open(
        journal_path(journal_dir, &target.network.key(), &owner, &opts.name),
        &forge.core,
        &owner,
        &opts.name,
    );
    let balance_before = client.get_balance(&owner).await?;
    let mut steps = Vec::with_capacity(3);

    // 1. repo
    let (repo_doc_id, outcome) = run_step(
        client,
        &engine,
        &core,
        &mut journal,
        Step::Repo,
        || async {
            Ok(find_v2(client, &forge, owner_bytes, &opts.name)
                .await?
                .map(|r| r.id().to_string()))
        },
        || repo_props(&opts),
    )
    .await?;
    steps.push(("repo", outcome));
    let repo =
        find_repo_after_create(client, &forge, owner_bytes, &opts.name, &repo_doc_id).await?;
    let repo_id = platform::decode_identifier(repo.id())?;

    // 2. the owner's maintainer document
    let (_, outcome) = run_step(
        client,
        &engine,
        &core,
        &mut journal,
        Step::Maintainer,
        || async {
            Ok(MemberReader::new(client)
                .roles_of(&repo, &owner)
                .await?
                .into_iter()
                .find(|m| m.role == Role::Maintainer)
                .map(|m| m.document_id))
        },
        || {
            repo.scope()
                .map(|s| s.props([("memberId", FieldValue::identifier(owner_bytes))]))
                .unwrap_or_default()
        },
    )
    .await?;
    steps.push(("maintainer", outcome));

    // 3. the initial config
    let (_, outcome) = run_step(
        client,
        &engine,
        &core,
        &mut journal,
        Step::Config,
        || async {
            Ok(client
                .query_documents(
                    &core,
                    DOC_CONFIG,
                    &[QueryFilter::eq("repoId", FieldValue::identifier(repo_id))],
                    &[],
                    1,
                    None,
                )
                .await?
                .into_iter()
                .next()
                .map(|d| d.id))
        },
        || config_props(repo_id, &opts),
    )
    .await?;
    steps.push(("config", outcome));

    journal.finish();
    let balance_after = client.get_balance(&owner).await.unwrap_or(balance_before);
    Ok(CreateRepoResult {
        repo,
        steps,
        cost_credits: balance_before.saturating_sub(balance_after),
    })
}

/// `opts` with the name normalized to its slug, or why it cannot be created.
fn validated(opts: &CreateRepoOpts) -> Result<CreateRepoOpts> {
    if opts.visibility == Visibility::Private {
        return Err(Error::Config(
            "private repositories are not supported by this version yet; create a public \
             repository"
                .into(),
        ));
    }
    if !crate::rules::is_legal_ref_name(&format!("refs/heads/{}", opts.default_branch)) {
        return Err(Error::Config(format!(
            "invalid default branch {:?}",
            opts.default_branch
        )));
    }
    let mut opts = opts.clone();
    opts.name = repo_slug(&opts.name)?;
    Ok(opts)
}

/// One step: replay a saved transition, else adopt an existing document, else sign, save
/// and broadcast a new one. Returns the document id and how the step ended.
async fn run_step<E, EFut, P>(
    client: &PlatformClient,
    engine: &WriteEngine<'_>,
    core: &LoadedContract,
    journal: &mut Journal,
    step: Step,
    existing: E,
    props: P,
) -> Result<(String, StepOutcome)>
where
    E: FnOnce() -> EFut,
    EFut: std::future::Future<Output = Result<Option<String>>>,
    P: FnOnce() -> BTreeMap<String, FieldValue>,
{
    if let Some(intent) = journal.slot(step).clone() {
        if replay_confirmed(client, engine, core, step, &intent).await? {
            return Ok((intent.document_id, StepOutcome::Resumed));
        }
        tracing::warn!(
            step = step.doc_type(),
            document = %intent.document_id,
            "a saved transition from an interrupted create never landed; discarding it"
        );
        *journal.slot(step) = None;
        journal.save()?;
    }
    if let Some(id) = existing().await? {
        return Ok((id, StepOutcome::Existed));
    }
    let prepared = engine
        .create_journaled(core, step.doc_type(), props(), |p| {
            *journal.slot(step) = Some(WriteIntent::for_prepared(0, p));
            journal.save()
        })
        .await?;
    Ok((prepared.document_id().to_string(), StepOutcome::Created))
}

/// The repository just created (or adopted), read back through the `(owner, name)` index so
/// the caller holds exactly what every other client resolves. Polls briefly for the proved
/// read to catch up with the write.
async fn find_repo_after_create(
    client: &PlatformClient,
    forge: &ForgeIds,
    owner: [u8; 32],
    name: &str,
    expected_id: &str,
) -> Result<RepoRef> {
    for attempt in 0..6 {
        if let Some(repo) = find_v2(client, forge, owner, name).await? {
            if repo.id() != expected_id {
                return Err(Error::Platform(format!(
                    "repo {name} resolves to {} but this session wrote {expected_id}",
                    repo.id()
                )));
            }
            return Ok(repo);
        }
        if attempt < 5 {
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        }
    }
    Err(Error::Platform(format!(
        "repo {expected_id} landed but is not yet readable through the (owner, name) index; \
         run the create again to finish it"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn intent(id: &str) -> WriteIntent {
        WriteIntent {
            seq: 0,
            document_id: id.into(),
            operation: platform::WriteOp::Create,
            transition: platform::SignedTransition {
                bytes: vec![1, 2, 3],
                nonce: 7,
            },
        }
    }

    #[test]
    fn a_journal_round_trips_and_resumes_the_same_intents() {
        let dir = tempfile::tempdir().unwrap();
        let path = journal_path(dir.path(), "devnet-moutai", "OWNER", "proj");
        let mut j = Journal::open(path.clone(), "CORE", "OWNER", "proj");
        assert!(j.state.repo.is_none());
        *j.slot(Step::Repo) = Some(intent("R1"));
        *j.slot(Step::Maintainer) = Some(intent("M1"));
        j.save().unwrap();

        let again = Journal::open(path.clone(), "CORE", "OWNER", "proj");
        assert_eq!(again.state.repo.as_ref().unwrap().document_id, "R1");
        assert_eq!(again.state.maintainer.as_ref().unwrap().document_id, "M1");
        assert!(again.state.config.is_none());
        assert_eq!(
            again.state.repo.as_ref().unwrap().transition.bytes,
            vec![1, 2, 3]
        );

        again.finish();
        assert!(!path.exists(), "a finished session removes its journal");
    }

    #[test]
    fn a_journal_for_another_forge_or_repo_is_not_resumed() {
        let dir = tempfile::tempdir().unwrap();
        let path = journal_path(dir.path(), "devnet-moutai", "OWNER", "proj");
        let mut j = Journal::open(path.clone(), "CORE", "OWNER", "proj");
        *j.slot(Step::Repo) = Some(intent("R1"));
        j.save().unwrap();
        // forge-core re-registered: the saved transition targets a dead contract.
        assert!(Journal::open(path.clone(), "CORE2", "OWNER", "proj")
            .state
            .repo
            .is_none());
        // A corrupt file is a fresh session, not an error.
        std::fs::write(&path, b"{not json").unwrap();
        assert!(Journal::open(path, "CORE", "OWNER", "proj")
            .state
            .repo
            .is_none());
    }

    #[test]
    fn journals_are_per_network_owner_and_name() {
        let d = Path::new("/j");
        assert_ne!(
            journal_path(d, "devnet-moutai", "A", "x"),
            journal_path(d, "testnet", "A", "x")
        );
        assert_ne!(
            journal_path(d, "n", "A", "x"),
            journal_path(d, "n", "B", "x")
        );
        assert_ne!(
            journal_path(d, "n", "A", "x"),
            journal_path(d, "n", "A", "y")
        );
    }

    #[test]
    fn documents_are_public_and_carry_only_set_fields() {
        let mut opts = CreateRepoOpts::public("proj");
        let p = repo_props(&opts);
        assert_eq!(p.get("visibility"), Some(&FieldValue::text("public")));
        assert_eq!(p.get("defaultBranch"), Some(&FieldValue::text("main")));
        assert!(!p.contains_key("description") && !p.contains_key("displayName"));
        opts.description = "d".into();
        opts.display_name = "Proj".into();
        let p = repo_props(&opts);
        assert!(p.contains_key("description") && p.contains_key("displayName"));

        let c = config_props([9; 32], &opts);
        assert_eq!(c.get("repoId"), Some(&FieldValue::identifier([9; 32])));
        assert!(!c.contains_key("protectedPatterns"));
        assert!(matches!(c.get("backend"), Some(FieldValue::Object(b)) if b.contains_key("mode")));
    }

    #[test]
    fn step_document_types_match_the_contract() {
        assert_eq!(Step::Repo.doc_type(), "repo");
        assert_eq!(Step::Maintainer.doc_type(), "maintainer");
        assert_eq!(Step::Config.doc_type(), "config");
    }
}
