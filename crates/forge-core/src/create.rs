//! Creating a forge-v2 repository: one journaled, resumable session.
//!
//! A new repository is three documents in the network's forge-core contract, written in
//! this order because each one's consensus gate needs the one before it:
//!
//! 1. `repo` — the name slug, display name, description, default branch and visibility
//!    (anyone may create one; `(owner, name)` is unique).
//! 2. the owner's own `maintainer` document — only the repo's owner may create it, and
//!    without it the owner could not write the M-gated `config` (or push to a protected
//!    ref).
//! 3. the initial `config` — default branch and storage backend.
//!
//! A **private** repository (`docs/security/private-repos.md` §9 "Create") replaces step 3
//! with epoch 0 of its key: the owner's self-`repoKey` wrap of a fresh epoch key, then the
//! anchor `config` (sealed, `enc` v0x02, carrying the default branch). The identity must hold
//! an `ENCRYPTION` key, checked before anything is written. The epoch key is never stored
//! locally: a create interrupted after the wrap recovers it by unwrapping the wrap.
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
use crate::layout;
use crate::members::{doc_type, MemberReader};
use crate::network::ForgeIds;
use crate::platform::{
    self, BroadcastOutcome, FieldValue, LoadedContract, LoadedIdentity, PlatformClient,
    WriteEngine, WriteIntent,
};
use crate::repo::BACKEND_URIS_V2;
use crate::resolve::{find_named, repo_slug, DOC_REPO};
use crate::rules::v2::{Role, Visibility};
use crate::scope::RepoRef;

/// The initial `config` document type.
use crate::refs::DOC_CONFIG;
/// How often a just-created repo is looked up through its index, and the pause between.
const FIND_ATTEMPTS: usize = 6;
const FIND_DELAY: std::time::Duration = std::time::Duration::from_millis(1500);

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
    /// `config.backend.uris`: the public read bases readers can use (at most
    /// [`BACKEND_URIS_V2`]); empty = none recorded.
    pub backend_uris: Vec<String>,
    /// The visibility (immutable once created).
    pub visibility: Visibility,
    /// The parent repository's id when this is a fork (`repo.forkOf`, immutable).
    pub fork_of: Option<[u8; 32]>,
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
            backend_uris: Vec::new(),
            visibility: Visibility::Public,
            fork_of: None,
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
    match opts.visibility {
        Visibility::Public => {
            p.insert("visibility".into(), FieldValue::text("public"));
            p.insert(
                "defaultBranch".into(),
                FieldValue::text(&opts.default_branch),
            );
        }
        // A private repo's default branch lives only in its sealed config (§7 lists what a
        // `repo` document shows everyone; the branch is not on it).
        Visibility::Private => {
            p.insert("visibility".into(), FieldValue::text("private"));
        }
    }
    if !opts.description.is_empty() {
        p.insert("description".into(), FieldValue::text(&opts.description));
    }
    if !opts.display_name.is_empty() {
        p.insert("displayName".into(), FieldValue::text(&opts.display_name));
    }
    if let Some(parent) = opts.fork_of {
        p.insert("forkOf".into(), FieldValue::identifier(parent));
    }
    p
}

/// The initial `config` document's properties of a PUBLIC repository (no protected patterns:
/// an empty list is the same as none, and omitting it keeps the document small). A private
/// repository's first config is its sealed anchor (`private_epoch_zero`).
pub(crate) fn config_props(opts: &CreateRepoOpts) -> BTreeMap<String, FieldValue> {
    let mut p = BTreeMap::new();
    p.insert(
        "defaultBranch".into(),
        FieldValue::text(&opts.default_branch),
    );
    p.insert("backend".into(), backend_props(opts));
    p.insert("archived".into(), FieldValue::boolean(false));
    layout::stamp_public(&mut p);
    p
}

/// The initial `config.backend` object: the mode and the advertised read bases. Plaintext in
/// a private repository too (§7: storage URIs are visible metadata).
fn backend_props(opts: &CreateRepoOpts) -> FieldValue {
    let mut backend = BTreeMap::new();
    backend.insert(
        "mode".into(),
        FieldValue::integer(u64::from(opts.backend_mode)),
    );
    if !opts.backend_uris.is_empty() {
        backend.insert(
            "uris".into(),
            FieldValue::text_list(opts.backend_uris.iter().cloned()),
        );
    }
    FieldValue::Object(backend)
}

/// Re-broadcast a saved transition and decide whether its document exists. `false` means
/// it did not land and will not: the caller discards it and decides afresh.
///
/// * `Applied` / `AlreadyExists`: the proof (or a present document) says it landed.
/// * `NonceConsumed`: this transition landed earlier, or another write by the identity took
///   its nonce; a proved read decides.
/// * A consensus refusal that proves nothing executed (a stale protocol version, a unique
///   index already taken, a membership gate, a reference to a document or identity that does
///   not exist, a `propertyConstraints` rule such as forge-v2's `dense` when another create
///   took the saved number): it never landed; re-deciding adopts or re-signs. A rule or
///   reference refusal is conclusive because the node checks the nonce first, so a landed
///   transition fails its replay on the nonce, never on the rule or the reference.
/// * Anything else (the network) is returned: the transition may still land.
pub(crate) async fn replay_landed(
    engine: &WriteEngine<'_>,
    contract: &LoadedContract,
    doc_type: &str,
    intent: &WriteIntent,
) -> Result<bool> {
    replay_verdict(engine.replay(doc_type, intent).await, || {
        engine.landed(contract, doc_type, &intent.document_id, true)
    })
    .await
}

/// [`replay_landed`]'s decision over a replay's outcome; `landed` is the proved read asked
/// after a consumed nonce.
async fn replay_verdict<F, Fut>(outcome: Result<BroadcastOutcome>, landed: F) -> Result<bool>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<bool>>,
{
    match outcome {
        Ok(BroadcastOutcome::Applied | BroadcastOutcome::AlreadyExists) => Ok(true),
        Ok(BroadcastOutcome::NonceConsumed) => landed().await,
        Err(
            Error::StaleProtocolVersion(_)
            | Error::DuplicateUniqueIndex(_)
            | Error::NotAMember { .. }
            | Error::ReferenceNotFound { .. }
            | Error::RuleRefused { .. },
        ) => Ok(false),
        Err(e) => Err(e),
    }
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
    require_encryption_key(&opts, identity, bridge, &forge.core, client.network())?;
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
        &engine,
        &core,
        &mut journal,
        Step::Repo,
        || async {
            Ok(find_named(client, &forge, owner_bytes, &opts.name)
                .await?
                .map(|r| r.id().to_string()))
        },
        || repo_props(&opts),
    )
    .await?;
    steps.push((Step::Repo.doc_type(), outcome));
    let repo =
        find_repo_after_create(client, &forge, owner_bytes, &opts.name, &repo_doc_id).await?;
    // An existing repo is adopted only as what was asked for: finishing a private create as
    // a public one (or the reverse) would write the wrong kind of config into it.
    if repo.visibility != opts.visibility {
        return Err(Error::Config(format!(
            "{} already exists with the other visibility (visibility is immutable)",
            repo.display()
        )));
    }
    let scope = repo.scope()?;

    // 2. the owner's maintainer document
    let (_, outcome) = run_step(
        &engine,
        &core,
        &mut journal,
        Step::Maintainer,
        || async {
            Ok(MemberReader::new(client)
                .role_doc(&repo, &owner, Role::Maintainer)
                .await?
                .map(|m| m.document_id))
        },
        || {
            // The owner enrols itself: no `consentBy` (RC1 `member_consent`).
            let mut p = scope.props([("memberId", FieldValue::identifier(owner_bytes))]);
            layout::stamp_vis(&mut p, opts.visibility);
            p
        },
    )
    .await?;
    steps.push((Step::Maintainer.doc_type(), outcome));

    // 3. the initial config: for a private repo, epoch 0 (self-wrap, then the sealed anchor)
    if opts.visibility == Visibility::Private {
        steps.push(private_epoch_zero(client, identity, bridge, &repo, &opts).await?);
    } else {
        let (_, outcome) = run_step(
            &engine,
            &core,
            &mut journal,
            Step::Config,
            || async {
                Ok(client
                    .query_documents(&core, DOC_CONFIG, &scope.filters([]), &[], 1, None)
                    .await?
                    .into_iter()
                    .next()
                    .map(|d| d.id))
            },
            || scope.scoped(config_props(&opts)),
        )
        .await?;
        steps.push((Step::Config.doc_type(), outcome));
    }

    journal.finish();
    let balance_after = client.get_balance(&owner).await.unwrap_or(balance_before);
    Ok(CreateRepoResult {
        repo,
        steps,
        cost_credits: balance_before.saturating_sub(balance_after),
    })
}

/// A private create needs an `ENCRYPTION` key the identity file holds (§9 "Create"): checked
/// before anything is written.
fn require_encryption_key(
    opts: &CreateRepoOpts,
    identity: &LoadedIdentity,
    bridge: &BridgeIdentity,
    core: &str,
    network: &platform::Network,
) -> Result<()> {
    if opts.visibility == Visibility::Public {
        return Ok(());
    }
    let held = crate::keyring::EncryptionKeys::held(bridge, &identity.public_keys(), core, network);
    if held.sender().is_none() {
        return Err(crate::keyring::no_encryption_key(
            "your identity",
            "cannot create a private repository",
        ));
    }
    Ok(())
}

/// Step 3 of a private create: the owner's self-wrap of a fresh epoch key, then the anchor.
async fn private_epoch_zero(
    client: &PlatformClient,
    identity: &LoadedIdentity,
    bridge: &BridgeIdentity,
    repo: &RepoRef,
    opts: &CreateRepoOpts,
) -> Result<(&'static str, StepOutcome)> {
    let signer = crate::keyring::PrivateSigner {
        client,
        identity,
        bridge,
    };
    let wrote = crate::keyring::create_private_state(
        &signer,
        repo,
        &opts.default_branch,
        backend_props(opts),
    )
    .await?;
    let outcome = if wrote {
        StepOutcome::Created
    } else {
        StepOutcome::Existed
    };
    Ok(("repoKey + anchor config", outcome))
}

/// `opts` with the name normalized to its slug, or why it cannot be created.
fn validated(opts: &CreateRepoOpts) -> Result<CreateRepoOpts> {
    crate::repo::check_default_branch(&opts.default_branch)?;
    // RC1 `repo_shape`: a fork is public (`forkIsPublic`).
    if opts.fork_of.is_some() && opts.visibility != Visibility::Public {
        return Err(Error::Config(
            "a fork is always public: a private repository cannot be a fork".into(),
        ));
    }
    if !BACKEND_URIS_V2.fits(&opts.backend_uris) {
        return Err(Error::Config(format!(
            "config.backend.uris holds at most {} URLs of at most {} bytes each",
            BACKEND_URIS_V2.max_items, BACKEND_URIS_V2.max_item_len
        )));
    }
    let mut opts = opts.clone();
    opts.name = repo_slug(&opts.name)?;
    // RC1 `nameNotDotGit`: `foo.git` would read as the bare-repository form of `foo`.
    if opts.name.as_bytes().ends_with(b".git") {
        return Err(Error::Config(format!(
            "invalid repo name {:?}: a name may not end in .git",
            opts.name
        )));
    }
    Ok(opts)
}

/// One step: replay a saved transition, else adopt an existing document, else sign, save
/// and broadcast a new one. Returns the document id and how the step ended.
async fn run_step<E, EFut, P>(
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
        if replay_landed(engine, core, step.doc_type(), &intent).await? {
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
    for attempt in 0..FIND_ATTEMPTS {
        if let Some(repo) = find_named(client, forge, owner, name).await? {
            if repo.id() != expected_id {
                return Err(Error::Platform(format!(
                    "repo {name} resolves to {} but this session wrote {expected_id}",
                    repo.id()
                )));
            }
            return Ok(repo);
        }
        if attempt + 1 < FIND_ATTEMPTS {
            tokio::time::sleep(FIND_DELAY).await;
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

    /// A saved create refused on replay by a rule (forge-v2 `dense`: another create took its
    /// number) never landed: it is dropped, not retried with the same bytes forever.
    #[tokio::test]
    async fn a_replayed_create_refused_by_a_rule_never_landed() {
        let no_read = || async { panic!("a refusal needs no read") };
        let dense = Error::RuleRefused {
            document_type: "issue".into(),
            rule: "dense".into(),
            detail: "A document of type \"issue\" breaks its propertyConstraints rule \"dense\": it does not hold".into(),
        };
        assert!(!super::replay_verdict(Err(dense), no_read).await.unwrap());
        for e in [
            Error::DuplicateUniqueIndex("number".into()),
            Error::StaleProtocolVersion("13".into()),
            Error::NotAMember {
                document_type: "issue".into(),
                detail: "40120".into(),
            },
            Error::ReferenceNotFound {
                document_type: "patch".into(),
                path: "sourceRepoId".into(),
                detail: "40120".into(),
            },
        ] {
            assert!(!super::replay_verdict(Err(e), no_read).await.unwrap());
        }
        // A consumed nonce asks the proved read; a network error may still land: returned.
        assert!(
            super::replay_verdict(Ok(BroadcastOutcome::NonceConsumed), || async { Ok(true) })
                .await
                .unwrap()
        );
        assert!(
            super::replay_verdict(Err(Error::Platform("timeout".into())), no_read)
                .await
                .is_err()
        );
    }

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

        opts.visibility = Visibility::Private;
        let p = repo_props(&opts);
        assert_eq!(p.get("visibility"), Some(&FieldValue::text("private")));
        assert!(
            !p.contains_key("defaultBranch"),
            "a private repo's default branch is sealed in its config, not on the repo"
        );

        let c = config_props(&opts);
        assert!(!c.contains_key("repoId"), "the scope adds repoId");
        assert!(!c.contains_key("protectedPatterns"));
        assert!(matches!(c.get("backend"), Some(FieldValue::Object(b))
            if b.contains_key("mode") && !b.contains_key("uris")));
        opts.backend_mode = 2;
        opts.backend_uris = vec!["https://pub.r2.dev".into()];
        let c = config_props(&opts);
        assert!(matches!(c.get("backend"), Some(FieldValue::Object(b))
            if b.get("uris") == Some(&FieldValue::text_list(["https://pub.r2.dev"]))));
        assert!(validated(&opts).is_ok());
        opts.backend_uris = vec!["https://x".into(); 5];
        assert!(validated(&opts).is_err(), "more than 4 uris");
    }

    #[test]
    fn step_document_types_match_the_contract() {
        assert_eq!(Step::Repo.doc_type(), "repo");
        assert_eq!(Step::Maintainer.doc_type(), "maintainer");
        assert_eq!(Step::Config.doc_type(), "config");
    }
}
