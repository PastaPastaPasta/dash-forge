//! `dg migrate <v1 repo>`: copy a forge-v1 repository (one contract per repo, read only)
//! into a forge-v2 repository, possibly on another network.
//!
//! * **Git data, pack by pack.** Every live git pack of the v1 repo is fetched and
//!   hash-verified. A pack stored externally is *referenced*: the v2 manifest records the
//!   same public URIs, costing one document. A pack stored as v1 Platform chunks is
//!   *re-uploaded* as v2 chunks (priced before anything is written). Then each v1 ref is
//!   written at its tip. Packs and refs already in the destination are skipped.
//! * **Members.** The v1 token holders become `maintainer` (MAINTAIN) or `writer` (WRITE)
//!   documents. Frozen holdings are not carried over; identities that do not exist on the
//!   destination network are reported and skipped.
//! * **Issues, PRs, comments, reviews, labels, releases** keep their numbers, with
//!   provenance pointing at the v1 documents, through the same diffing sink as `import`.
//!
//! Reading the v1 repository needs no identity; the signer (the destination's owner, or a
//! maintainer of an existing one) writes everything.

use std::collections::BTreeSet;
use std::path::PathBuf;

use anyhow::{bail, Context, Result};

use forge_core::members::{MemberReader, MemberService};
use forge_core::network::{NetworkSettings, NetworkTarget};
use forge_core::pack::{split, KIND_GIT_PACK};
use forge_core::platform::PlatformClient;
use forge_core::repo::{
    credits_to_dash, PackManifestInfo, PackManifestInput, RepoReader, RepoService, MANIFEST_URIS_V2,
};
use forge_core::rules::v2::Role;
use forge_core::rules::RefState;
use forge_core::scope::RepoRef;
use forge_core::storage::PackReader;

use crate::budget::{chunked_credits, git_doc_credits, Budget, REF_UPDATE_BYTES};
use crate::dest::{self, Outcome, Signer, REPO_CREATE_CREDITS};
use crate::sink::Ledger;
use crate::source_github::Classes;
use crate::source_v1::{Collaborator, V1Source};
use crate::summary::{Status, Summary};

/// Serialized size of a `packManifest` before its `uris`.
const MANIFEST_BYTES: u64 = 260;
/// Serialized size of a membership document.
const MEMBER_BYTES: u64 = 200;

/// What the CLI resolved.
pub struct MigrateConfig {
    /// The v1 repository: `owner/name` or its contract id.
    pub source: String,
    /// The network it lives on.
    pub source_network: NetworkTarget,
    /// The destination spec (default: the v1 name, owned by the signer).
    pub dest: Option<String>,
    /// The destination network.
    pub network: NetworkTarget,
    /// Collaboration classes (`code` is always copied).
    pub classes: Classes,
    /// Members (token holders → membership documents).
    pub members: bool,
    /// Hard cap, credits.
    pub max_spend: Option<u64>,
    /// Plan and price only.
    pub dry_run: bool,
    /// No prompt.
    pub yes: bool,
    /// The signer.
    pub key: Option<PathBuf>,
}

/// The network a v1 repository lives on (`--from-network` / `--from-devnet-name`).
pub fn source_network(network: &str, devnet_name: Option<String>) -> Result<NetworkTarget> {
    NetworkSettings::from_flags(Some(network.to_string()), devnet_name, None)
        .resolve()
        .context("resolving --from-network")
}

/// One v1 pack to carry over.
struct PackPlan {
    manifest: PackManifestInfo,
    /// Public URIs the v2 manifest can reference (external copies).
    external: Vec<String>,
}

impl PackPlan {
    /// Re-uploaded (v1 Platform chunks), or referenced (external copies)?
    fn reupload(&self) -> bool {
        self.manifest.storage == 0
    }

    fn credits(&self) -> u64 {
        let uris: u64 = self.external.iter().map(|u| u.len() as u64 + 4).sum();
        let manifest = git_doc_credits(MANIFEST_BYTES + uris + 120);
        if self.reupload() {
            manifest + chunked_credits(self.manifest.size_bytes)
        } else {
            manifest
        }
    }
}

/// Drop trailing URIs until the list fits a v2 manifest's `uris`.
fn fit_uris(uris: &mut Vec<String>) {
    while !uris.is_empty() && !MANIFEST_URIS_V2.fits(uris) {
        uris.pop();
    }
}

/// The URIs of a v1 manifest the v2 manifest may reference: public copies only (see
/// [`crate::model::is_public_uri`]). v1 `platform://` locators name the v1 contract, and a
/// private or credentialed copy is either unreadable to others or a leak; both are dropped.
fn portable_uris(uris: &[String]) -> Vec<String> {
    let mut out: Vec<String> = uris
        .iter()
        .filter(|u| crate::model::is_public_uri(u))
        .cloned()
        .collect();
    fit_uris(&mut out);
    out
}

/// The live git packs of a v1 repo: kind-0, not superseded by another kind-0 manifest.
fn live_packs(manifests: &[PackManifestInfo]) -> Vec<PackManifestInfo> {
    let git: Vec<&PackManifestInfo> = manifests
        .iter()
        .filter(|m| m.kind == u64::from(KIND_GIT_PACK))
        .collect();
    let superseded: BTreeSet<[u8; 32]> = git
        .iter()
        .flat_map(|m| m.supersedes.iter().copied())
        .collect();
    let mut seen = BTreeSet::new();
    let mut out: Vec<PackManifestInfo> = git
        .into_iter()
        .filter(|m| !superseded.contains(&m.pack_hash) && seen.insert(m.pack_hash))
        .cloned()
        .collect();
    // Oldest first: the pack space a v2 reader builds follows first-upload order.
    out.sort_by(|a, b| (a.created_at, &a.document_id).cmp(&(b.created_at, &b.document_id)));
    out
}

/// A ref's tip, when it has one (a diverged ref takes its newest head).
fn tip(state: &RefState) -> Option<String> {
    match state {
        RefState::Resolved { oid, .. } => Some(oid.clone()),
        RefState::Diverged { heads } => heads.first().map(|h| h.oid.clone()),
        RefState::Unborn => None,
    }
}

/// Run a migration. Always returns a summary (a failure is its status and error; what was
/// spent before it is still reported).
pub async fn run(cfg: &MigrateConfig) -> Summary {
    let mut summary = Summary::new(
        cfg.network.network.key(),
        format!("{} ({})", cfg.source, cfg.source_network.network.key()),
    );
    let client = match PlatformClient::connect(cfg.network.clone()).await {
        Ok(c) => c,
        Err(e) => {
            let err =
                anyhow::Error::from(e).context(format!("connecting to {}", cfg.network.network));
            return dest::finish(summary, Outcome::default(), Err(err)).await;
        }
    };
    let signer = match Signer::load_opt(&client, cfg.key.as_deref(), cfg.dry_run).await {
        Ok(s) => s,
        Err(e) => return dest::finish(summary, Outcome::default(), Err(e)).await,
    };
    let mut outcome = Outcome {
        ledger: None,
        signer: signer.as_ref().map(|s| (&client, s)),
    };
    let result = run_inner(cfg, &client, signer.as_ref(), &mut summary, &mut outcome).await;
    dest::finish(summary, outcome, result).await
}

async fn resolve_v1(client: &PlatformClient, spec: &str) -> Result<RepoRef> {
    let spec = spec
        .trim()
        .trim_start_matches("dash://")
        .trim_end_matches('/');
    let repo = match spec.split_once('/') {
        Some((owner, name)) => forge_core::resolve::resolve_named(client, owner, name).await,
        None => forge_core::resolve::resolve_id(client, spec).await,
    }
    .with_context(|| format!("resolving {spec} on {}", client.target().network))?;
    if !repo.is_v1() {
        bail!(
            "{} is already a forge-v2 repository; nothing to migrate",
            repo.display()
        );
    }
    Ok(repo)
}

/// What the migration has left to write (everything the destination does not hold yet).
struct Todo<'p> {
    /// Every live v1 pack.
    all: &'p [PackPlan],
    /// Those the destination does not hold yet (and can be copied).
    packs: Vec<&'p PackPlan>,
    /// Live packs with no public copy: not copied. Refs are then written only where their
    /// history is complete without them (checked in [`copy_git`]).
    uncopyable: BTreeSet<[u8; 32]>,
    /// `(ref name, wanted tip, current tip)`.
    refs: Vec<(String, String, Option<String>)>,
    members: Vec<Collaborator>,
}

impl Todo<'_> {
    fn git_credits(&self) -> u64 {
        self.packs.iter().map(|p| p.credits()).sum::<u64>()
            + git_doc_credits(REF_UPDATE_BYTES) * self.refs.len() as u64
    }

    fn member_credits(&self) -> u64 {
        git_doc_credits(MEMBER_BYTES) * self.members.len() as u64
    }
}

/// Diff the v1 packs, refs and members against the destination (signer-free reads).
async fn todo<'p>(
    client: &PlatformClient,
    existing: Option<&RepoRef>,
    packs: &'p [PackPlan],
    refs: &[(String, RefState)],
    collaborators: Vec<Collaborator>,
    warnings: &mut Vec<String>,
) -> Result<Todo<'p>> {
    let (have_packs, have_refs, have_members) = match existing {
        Some(repo) => {
            let r = RepoReader::new(client);
            let packs: BTreeSet<[u8; 32]> = r
                .read_pack_manifests(repo)
                .await?
                .into_iter()
                .filter(|m| m.kind == u64::from(KIND_GIT_PACK))
                .map(|m| m.pack_hash)
                .collect();
            let members = MemberReader::new(client).list(repo).await?;
            (packs, r.read_refs(repo).await?, members)
        }
        None => Default::default(),
    };
    let packs_all = packs;
    let (packs, unreadable): (Vec<&PackPlan>, Vec<&PackPlan>) = packs
        .iter()
        .filter(|p| !have_packs.contains(&p.manifest.pack_hash))
        .partition(|p| p.reupload() || !p.external.is_empty());
    for p in &unreadable {
        warnings.push(format!(
            "v1 pack {} has no public copy (only private, local or credentialed addresses); \
             it is not copied",
            &hex::encode(p.manifest.pack_hash)[..12],
        ));
    }
    if !unreadable.is_empty() {
        warnings.push(format!(
            "{} v1 pack(s) cannot be copied; a ref is written only when its whole history is \
             stored without them (often the case: a later push re-sent their objects)",
            unreadable.len()
        ));
    }
    let uncopyable = unreadable.iter().map(|p| p.manifest.pack_hash).collect();
    let refs = refs
        .iter()
        .filter_map(|(name, state)| {
            let want = tip(state)?;
            let current = have_refs
                .iter()
                .find(|(n, _)| n == name)
                .and_then(|(_, s)| tip(s));
            (current.as_deref() != Some(want.as_str())).then(|| (name.clone(), want, current))
        })
        .collect();
    let members = collaborators
        .into_iter()
        .filter(|c| {
            !have_members
                .iter()
                .any(|m| m.identity_id == c.identity && m.role == c.role)
        })
        .collect();
    Ok(Todo {
        all: packs_all,
        packs,
        uncopyable,
        refs,
        members,
    })
}

#[allow(clippy::too_many_lines)] // one sequential run: read, price, confirm, write
async fn run_inner<'a>(
    cfg: &MigrateConfig,
    client: &'a PlatformClient,
    signer: Option<&'a Signer>,
    summary: &mut Summary,
    outcome: &mut Outcome<'a>,
) -> Result<()> {
    // Source (read only, no identity).
    let src_client = PlatformClient::connect(cfg.source_network.clone())
        .await
        .with_context(|| format!("connecting to {}", cfg.source_network.network))?;
    let v1 = resolve_v1(&src_client, &cfg.source).await?;
    summary.source = format!(
        "{} ({}, v1)",
        v1.display(),
        cfg.source_network.network.key()
    );
    let source = V1Source::new(&src_client, v1.clone()).await?;
    let reader = RepoReader::new(&src_client);
    let refs = reader.read_refs(&v1).await.context("reading the v1 refs")?;
    let manifests = reader
        .read_pack_manifests(&v1)
        .await
        .context("reading the v1 pack manifests")?;
    let packs: Vec<PackPlan> = live_packs(&manifests)
        .into_iter()
        .map(|m| PackPlan {
            external: if m.storage == 1 {
                portable_uris(&m.uris)
            } else {
                Vec::new()
            },
            manifest: m,
        })
        .collect();
    let collaborators = if cfg.members {
        source.collaborators().await?
    } else {
        Vec::new()
    };
    let collab_src = source.collect(cfg.classes).await?;

    // Destination.
    let signer_id = signer.map(Signer::id);
    let spec = cfg
        .dest
        .clone()
        .unwrap_or_else(|| v1.name().to_ascii_lowercase());
    let mut dest = dest::resolve(client, signer_id.as_deref(), &spec).await?;
    summary.repo = dest.info(false);
    let todo = todo(
        client,
        dest.existing.as_ref(),
        &packs,
        &refs,
        collaborators,
        &mut summary.warnings,
    )
    .await?;

    // Price.
    let create = dest.existing.is_none();
    let dry = dest::dry_collab(client, dest.existing.clone(), signer_id, &collab_src).await?;
    let create_credits = if create { REPO_CREATE_CREDITS } else { 0 };
    let total = create_credits + todo.git_credits() + todo.member_credits() + dry.budget.spent();
    summary.estimate_credits = total;
    let mut budget = Budget::new(cfg.max_spend);
    let reupload = todo.packs.iter().filter(|p| p.reupload()).count();
    eprintln!(
        "{} → {}: {} packs ({} re-uploaded as Platform chunks, {} referenced), {} refs, {} \
         members; estimated {:.6} DASH",
        summary.source,
        dest.url(),
        todo.packs.len(),
        reupload,
        todo.packs.len() - reupload,
        todo.refs.len(),
        todo.members.len(),
        credits_to_dash(total)
    );

    if cfg.dry_run {
        summary.counts = dry.counts;
        summary.counts.packs = todo.packs.len() as u64;
        summary.counts.pack_bytes = todo.packs.iter().map(|p| p.manifest.size_bytes).sum();
        summary.counts.refs = todo.refs.len() as u64;
        summary.counts.members = todo.members.len() as u64;
        summary.warnings.extend(dry.warnings);
        if let Err(e) = budget.check_plan(total) {
            summary.warnings.push(format!("a real run would stop: {e}"));
        }
        summary.status = Status::DryRun;
        return Ok(());
    }
    let signer = signer.expect("load_opt returns a signer outside a dry run");
    let key_left = signer.key_info(client).await.remaining_credits;
    budget.check_funds(total, signer.identity.balance(), key_left)?;
    dest::confirm(cfg.yes, total)?;
    budget.start(signer.identity.balance());
    outcome.ledger = Some(Ledger::new(client, Some(signer.id()), false, budget));
    let ledger = outcome.ledger.as_mut().expect("just set");

    if create {
        ledger
            .budget
            .charge(REPO_CREATE_CREDITS, "creating the repository")?;
        let description = format!(
            "Migrated from forge-v1 {} ({})",
            v1.display(),
            cfg.source_network.network.key()
        );
        let default_branch = source
            .default_branch()
            .await
            .unwrap_or_else(|| "main".into());
        let created =
            dest::create(client, signer, &mut dest, &description, &default_branch).await?;
        summary.repo = dest.info(created);
        ledger.reconcile().await;
    }
    let repo = dest.existing.clone().expect("created or existing");
    let role = dest::require_member(client, &repo, &signer.id()).await?;

    copy_git(&reader, &v1, client, signer, &repo, role, &todo, ledger).await?;
    add_members(client, signer, &repo, &todo.members, &cfg.network, ledger).await?;
    let copied_packs = ledger.counts.packs;
    dest::write_collab(client, signer, role, repo, &collab_src, outcome).await?;
    if copied_packs > 0 {
        summary.warnings.push(
            "the browse index (objectLocator) is not copied; the web app reads the repository \
             whole-pack until the next push or `dg repack`"
                .into(),
        );
    }
    Ok(())
}

/// Copy the git data: packs first (a ref must never name history that is not stored), then
/// refs. Every write is charged to the ledger's budget before it is signed.
#[allow(clippy::too_many_arguments)]
async fn copy_git(
    reader: &RepoReader<'_>,
    v1: &RepoRef,
    client: &PlatformClient,
    signer: &Signer,
    repo: &RepoRef,
    role: Role,
    todo: &Todo<'_>,
    ledger: &mut Ledger<'_>,
) -> Result<()> {
    let svc = RepoService::new(client, &signer.identity, &signer.bridge);
    let pack_reader = PackReader::from_user_config();
    let mut uncopied = todo.uncopyable.clone();
    for p in &todo.packs {
        let hash = hex::encode(p.manifest.pack_hash);
        // Reading is free; charge only a pack that will actually be written.
        let bytes = match read_v1_pack(reader, v1, p, &pack_reader).await {
            Ok(b) => b,
            // An external pack no URI serves any more: nothing can read it, so there is
            // nothing to copy. Its objects are missing from the v1 repo too.
            Err(e) if !p.reupload() => {
                ledger.warn(format!(
                    "v1 pack {} is stored externally and no public copy is readable ({e:#}); \
                     not copied",
                    &hash[..12]
                ));
                uncopied.insert(p.manifest.pack_hash);
                continue;
            }
            Err(e) => return Err(e),
        };
        ledger
            .budget
            .charge(p.credits(), format!("pack {}", &hash[..12]))?;
        let (storage, chunk_count, mut uris) = if p.reupload() {
            let meta = forge_core::backends::PackMeta::for_bytes(&bytes);
            let stored = svc
                .put_pack(repo, &bytes, &meta)
                .await
                .with_context(|| format!("uploading pack {hash}"))?;
            let uris = stored.into_iter().map(|u| u.0).collect::<Vec<_>>();
            (0, split(&bytes).len() as u64, uris)
        } else {
            (1, 0, Vec::new())
        };
        uris.extend(p.external.iter().cloned());
        fit_uris(&mut uris);
        svc.write_pack_manifest(
            repo,
            &PackManifestInput {
                pack_hash: p.manifest.pack_hash,
                kind: u64::from(KIND_GIT_PACK),
                size_bytes: bytes.len() as u64,
                object_count: p.manifest.object_count,
                chunk_count,
                storage,
                offset_index_parts: 0,
                uris,
                supersedes: Vec::new(),
                tips: Vec::new(),
            },
        )
        .await
        .with_context(|| format!("recording pack {hash}"))?;
        ledger.counts.packs += 1;
        ledger.counts.pack_bytes += bytes.len() as u64;
        ledger.reconcile().await;
    }
    // A ref must never name history the repository does not store: with packs left out,
    // write only the refs whose history the copied packs hold in full.
    let complete = if uncopied.is_empty() {
        None
    } else {
        let tips: Vec<&str> = todo.refs.iter().map(|(_, want, _)| want.as_str()).collect();
        Some(complete_tips(reader, v1, todo.all, &uncopied, &tips, &pack_reader).await?)
    };
    for (name, want, current) in &todo.refs {
        if complete.as_ref().is_some_and(|c| !c.contains(want)) {
            ledger.skip(format!(
                "ref {name} is not written: its history needs a v1 pack that could not be copied"
            ));
            continue;
        }
        let prev = current.as_deref().map(hex::decode).transpose();
        let (Ok(new_oid), Ok(prev)) = (hex::decode(want), prev) else {
            ledger.warn(format!("ref {name} has an unreadable tip; skipped"));
            continue;
        };
        ledger
            .budget
            .charge(git_doc_credits(REF_UPDATE_BYTES), format!("ref {name}"))?;
        match svc
            .write_ref_update(repo, name, &new_oid, prev.as_deref(), true)
            .await
        {
            Ok(_) => ledger.counts.refs += 1,
            Err(forge_core::Error::NotAMember { .. }) if role == Role::Writer => {
                ledger.warn(format!(
                    "{name} is protected in the destination; a writer cannot set it"
                ));
            }
            Err(e) => return Err(anyhow::Error::from(e).context(format!("writing ref {name}"))),
        }
        ledger.reconcile().await;
    }
    Ok(())
}

/// Read one v1 pack, hash-verified. An external pack is read through the public URIs the v2
/// manifest will record only, so a copy readable just here (a local mirror) cannot vouch
/// for unreachable ones.
async fn read_v1_pack(
    reader: &RepoReader<'_>,
    v1: &RepoRef,
    p: &PackPlan,
    pack_reader: &PackReader,
) -> Result<Vec<u8>> {
    let hash = hex::encode(p.manifest.pack_hash);
    if p.reupload() {
        return reader
            .fetch_artifact(v1, &p.manifest, pack_reader)
            .await
            .with_context(|| format!("reading v1 pack {hash}"));
    }
    // External only, so there are no chunks to fall back on and the reader would try every
    // candidate (each CID on every gateway) at its full deadline: minutes per dead pack. A
    // migrate bounds it instead: no new candidate after EXTERNAL_START_BUDGET, and the
    // whole read within external_deadline(size).
    let size = (p.manifest.size_bytes > 0).then_some(p.manifest.size_bytes);
    let read = pack_reader.fetch_verified(&p.external, &hash, size, Some(EXTERNAL_START_BUDGET));
    match tokio::time::timeout(external_deadline(size), read).await {
        Ok(r) => r.with_context(|| format!("reading v1 pack {hash}")),
        Err(_) => bail!(
            "reading v1 pack {hash}: no public copy answered within {}s",
            external_deadline(size).as_secs()
        ),
    }
}

/// How long a migrate keeps starting new candidates for one external pack.
const EXTERNAL_START_BUDGET: std::time::Duration = std::time::Duration::from_secs(20);

/// The whole-read deadline for one external pack: 45 s, or twice the time to stream it at
/// the reader's minimum rate (1 MiB/s), whichever is longer. A dead mirror costs at most
/// this; a large pack streaming from a healthy one is not cut off.
fn external_deadline(size: Option<u64>) -> std::time::Duration {
    let stream = size
        .unwrap_or(0)
        .div_ceil(forge_core::storage::read::MIN_TRANSFER_RATE)
        .saturating_mul(2);
    std::time::Duration::from_secs(45.max(stream))
}

/// Which of `tips` have their whole history in the live packs outside `skip`: the packs
/// are indexed into a scratch repository, and a tip counts when `git rev-list --objects`
/// walks it without a missing object.
async fn complete_tips(
    reader: &RepoReader<'_>,
    v1: &RepoRef,
    all: &[PackPlan],
    skip: &BTreeSet<[u8; 32]>,
    tips: &[&str],
    pack_reader: &PackReader,
) -> Result<BTreeSet<String>> {
    let dir = std::env::temp_dir().join(format!(
        "forge-migrate-verify-{}-{}",
        v1.id(),
        std::process::id()
    ));
    let _cleanup = crate::importer::TempDir(dir.clone());
    git(&dir, &["init", "--bare", "-q", "."], None)?;
    for p in all.iter().filter(|p| !skip.contains(&p.manifest.pack_hash)) {
        let bytes = read_v1_pack(reader, v1, p, pack_reader).await?;
        git(&dir, &["index-pack", "--stdin", "--fix-thin"], Some(&bytes))?;
    }
    Ok(tips
        .iter()
        .filter(|tip| git(&dir, &["rev-list", "--objects", "--quiet", tip], None).is_ok())
        .map(|t| (*t).to_string())
        .collect())
}

/// Run `git` in `dir` (created if missing), feeding `stdin`; an error on a nonzero exit.
fn git(dir: &std::path::Path, args: &[&str], stdin: Option<&[u8]>) -> Result<()> {
    use std::io::Write as _;
    use std::process::{Command, Stdio};
    std::fs::create_dir_all(dir)?;
    let mut child = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .context("running git")?;
    if let Some(bytes) = stdin {
        child
            .stdin
            .take()
            .expect("piped")
            .write_all(bytes)
            .context("writing to git")?;
    }
    let out = child.wait_with_output()?;
    if !out.status.success() {
        bail!(
            "git {} failed: {}",
            args.first().unwrap_or(&""),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}

/// Grant the v1 collaborators their roles (only the repository owner can).
async fn add_members(
    client: &PlatformClient,
    signer: &Signer,
    repo: &RepoRef,
    members: &[Collaborator],
    network: &NetworkTarget,
    ledger: &mut Ledger<'_>,
) -> Result<()> {
    if members.is_empty() {
        return Ok(());
    }
    if repo.owner_id() != signer.id() {
        ledger.warn(format!(
            "{} v1 collaborators were not added: only the repository owner ({}) can add members",
            members.len(),
            repo.owner_id()
        ));
        return Ok(());
    }
    let svc = MemberService::new(client, &signer.identity, &signer.bridge);
    for c in members {
        ledger.budget.charge(
            git_doc_credits(MEMBER_BYTES),
            format!("member {}", c.identity),
        )?;
        match svc.grant(repo, &c.identity, c.role).await {
            Ok(_) => ledger.counts.members += 1,
            Err(forge_core::Error::Config(why)) if why.contains("not an identity") => {
                ledger.warn(format!(
                    "v1 collaborator {} does not exist on {}; not added",
                    c.identity, network.network
                ));
            }
            Err(e) => {
                return Err(anyhow::Error::from(e).context(format!("adding member {}", c.identity)))
            }
        }
        ledger.reconcile().await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(hash: u8, kind: u64, at: u64, supersedes: Vec<[u8; 32]>) -> PackManifestInfo {
        PackManifestInfo {
            document_id: format!("d{hash}"),
            created_at: at,
            owner_id: "O".into(),
            pack_hash: [hash; 32],
            kind,
            size_bytes: 10,
            object_count: 1,
            chunk_count: 1,
            storage: 0,
            offset_index_parts: 0,
            uris: Vec::new(),
            supersedes,
        }
    }

    #[test]
    fn only_live_git_packs_are_copied_oldest_first() {
        let packs = live_packs(&[
            m(3, 0, 30, vec![[1; 32], [2; 32]]),
            m(2, 0, 20, vec![]),
            m(1, 0, 10, vec![]),
            m(9, 1, 5, vec![]),
            m(4, 0, 5, vec![]),
        ]);
        let hashes: Vec<u8> = packs.iter().map(|p| p.pack_hash[0]).collect();
        assert_eq!(hashes, vec![4, 3]);
    }

    #[test]
    fn only_portable_uris_are_referenced() {
        let u = portable_uris(&[
            "platform://V1CONTRACT/abcd".into(),
            "https://bucket.example/p.pack".into(),
            "ipfs://bafy".into(),
            "ftp://x".into(),
        ]);
        assert_eq!(u, vec!["https://bucket.example/p.pack", "ipfs://bafy"]);
    }

    #[test]
    fn a_dead_external_pack_costs_under_a_minute_but_a_big_one_may_stream() {
        assert_eq!(external_deadline(None).as_secs(), 45);
        assert_eq!(external_deadline(Some(10_000)).as_secs(), 45);
        // 200 MiB at 1 MiB/s, doubled.
        assert_eq!(external_deadline(Some(200 * 1024 * 1024)).as_secs(), 400);
    }

    #[test]
    fn a_platform_pack_costs_its_chunks_and_an_external_one_only_its_manifest() {
        let mut big = m(1, 0, 0, vec![]);
        big.size_bytes = 1_000_000;
        let reupload = PackPlan {
            manifest: big.clone(),
            external: Vec::new(),
        };
        big.storage = 1;
        let referenced = PackPlan {
            manifest: big,
            external: vec!["https://x/p".into()],
        };
        assert!(reupload.reupload() && !referenced.reupload());
        assert!(reupload.credits() > 100 * referenced.credits());
    }

    #[test]
    fn local_and_credentialed_copies_are_not_referenced() {
        assert!(portable_uris(&[
            "http://127.0.0.1:9000/b/p.pack".into(),
            "http://localhost:8080/ipfs/x".into(),
            "https://10.1.2.3/p".into(),
            "https://user:pw@bucket.example/p".into(),
            "s3://bucket/p".into(),
        ])
        .is_empty());
    }
}
