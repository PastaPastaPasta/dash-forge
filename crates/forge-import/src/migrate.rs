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

use forge_core::collab::v2::Collab;

use forge_core::members::{MemberReader, MemberService};
use forge_core::network::NetworkTarget;
use forge_core::pack::{split, KIND_GIT_PACK};
use forge_core::platform::PlatformClient;
use forge_core::repo::{
    PackManifestInfo, PackManifestInput, RepoReader, RepoService, MANIFEST_URIS_V2,
};
use forge_core::rules::v2::Role;
use forge_core::rules::RefState;
use forge_core::scope::RepoRef;
use forge_core::storage::PackReader;

use crate::budget::{git_doc_credits, Budget};
use crate::dest::{self, Signer, REPO_CREATE_CREDITS};
use crate::sink::{Ledger, Sink};
use crate::source_github::Classes;
use crate::source_v1::{Collaborator, V1Source};
use crate::summary::{Status, Summary};

/// Serialized size of a `packManifest` before its `uris`.
const MANIFEST_BYTES: u64 = 260;
/// Serialized size of a `refUpdate`.
const REF_UPDATE_BYTES: u64 = 200;
/// Per-`chunk` document overhead on top of its payload.
const CHUNK_OVERHEAD: u64 = 120;
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
        if !self.reupload() {
            return manifest;
        }
        let size = usize::try_from(self.manifest.size_bytes).unwrap_or(usize::MAX);
        let full = size / forge_core::pack::DOC_PAYLOAD_MAX;
        let rest = size % forge_core::pack::DOC_PAYLOAD_MAX;
        let mut chunks = git_doc_credits(forge_core::pack::DOC_PAYLOAD_MAX as u64 + CHUNK_OVERHEAD)
            .saturating_mul(full as u64);
        if rest > 0 {
            chunks += git_doc_credits(rest as u64 + CHUNK_OVERHEAD);
        }
        manifest + chunks
    }
}

/// The URIs of a v1 manifest a v2 reader can use: public http(s), `ipfs://` and `s3://`
/// copies. v1 `platform://` locators name the v1 contract and are dropped.
fn portable_uris(uris: &[String]) -> Vec<String> {
    let mut out: Vec<String> = uris
        .iter()
        .filter(|u| {
            let (scheme, rest) = u.split_once("://").unwrap_or_default();
            let host = rest.split(['/', ':']).next().unwrap_or_default();
            // A copy on a loopback / private host is only readable on the machine that
            // pushed it; referencing it would record a pack nobody else can read.
            let local = host == "localhost"
                || host.parse::<std::net::IpAddr>().is_ok_and(|ip| match ip {
                    std::net::IpAddr::V4(v4) => {
                        v4.is_loopback() || v4.is_private() || v4.is_link_local()
                    }
                    std::net::IpAddr::V6(v6) => v6.is_loopback(),
                });
            matches!(scheme, "https" | "http" | "ipfs" | "s3") && !local
        })
        .cloned()
        .collect();
    while !out.is_empty() && !MANIFEST_URIS_V2.fits(&out) {
        out.pop();
    }
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

/// Run a migration.
pub async fn run(cfg: &MigrateConfig) -> Summary {
    let mut summary = Summary::new(
        cfg.network.network.key(),
        format!("{} ({})", cfg.source, cfg.source_network.network.key()),
    );
    if let Err(e) = run_inner(cfg, &mut summary).await {
        summary.status = if e.downcast_ref::<crate::budget::CapExceeded>().is_some() {
            Status::CapExceeded
        } else {
            Status::Error
        };
        summary.error = Some(forge_core::user_error::redact(&format!("{e:#}")));
    }
    summary
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

#[allow(clippy::too_many_lines)]
async fn run_inner(cfg: &MigrateConfig, summary: &mut Summary) -> Result<()> {
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
    let packs: Vec<PackPlan> = live_packs(
        &reader
            .read_pack_manifests(&v1)
            .await
            .context("reading the v1 pack manifests")?,
    )
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
    let default_branch = source
        .default_branch()
        .await
        .unwrap_or_else(|| "main".into());

    // Destination.
    let client = PlatformClient::connect(cfg.network.clone())
        .await
        .with_context(|| format!("connecting to {}", cfg.network.network))?;
    let signer = match &cfg.key {
        Some(k) => Some(Signer::load(&client, k).await?),
        None if cfg.dry_run => None,
        None => bail!("no signing identity: pass --identity <file> or set DASH_FORGE_KEY"),
    };
    let signer_id = signer.as_ref().map(Signer::id);
    let spec = cfg
        .dest
        .clone()
        .unwrap_or_else(|| v1.name().to_ascii_lowercase());
    let mut dest = dest::resolve(&client, signer_id.as_deref(), &spec).await?;
    summary.repo = dest.info(false);

    // What is already there.
    let (have_packs, have_refs) = match (&dest.existing, &signer) {
        (Some(repo), Some(s)) => {
            let svc = RepoService::new(&client, &s.identity, &s.bridge);
            let have: BTreeSet<[u8; 32]> = svc
                .read_pack_manifests(repo)
                .await?
                .into_iter()
                .filter(|m| m.kind == u64::from(KIND_GIT_PACK))
                .map(|m| m.pack_hash)
                .collect();
            let refs = svc.read_refs(repo).await?;
            (have, refs)
        }
        (Some(repo), None) => {
            let r = RepoReader::new(&client);
            let have = r
                .read_pack_manifests(repo)
                .await?
                .into_iter()
                .map(|m| m.pack_hash)
                .collect();
            (have, r.read_refs(repo).await?)
        }
        (None, _) => (BTreeSet::new(), Vec::new()),
    };
    let (packs_todo, unreadable): (Vec<&PackPlan>, Vec<&PackPlan>) = packs
        .iter()
        .filter(|p| !have_packs.contains(&p.manifest.pack_hash))
        .partition(|p| p.reupload() || !p.external.is_empty());
    for p in &unreadable {
        summary.warnings.push(format!(
            "v1 pack {} is stored only at private or local addresses ({}); nobody else can \
             read it, so it is not copied",
            &hex::encode(p.manifest.pack_hash)[..12],
            p.manifest.uris.join(", ")
        ));
    }
    let refs_todo: Vec<(String, String, Option<String>)> = refs
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
    let members_todo: Vec<&Collaborator> = match &dest.existing {
        Some(repo) => {
            let current = MemberReader::new(&client).list(repo).await?;
            collaborators
                .iter()
                .filter(|c| {
                    let role = if c.maintainer {
                        Role::Maintainer
                    } else {
                        Role::Writer
                    };
                    !current
                        .iter()
                        .any(|m| m.identity_id == c.identity && m.role == role)
                })
                .collect()
        }
        None => collaborators.iter().collect(),
    };

    // Price.
    let create = dest.existing.is_none();
    let git_credits: u64 = packs_todo.iter().map(|p| p.credits()).sum::<u64>()
        + git_doc_credits(REF_UPDATE_BYTES) * refs_todo.len() as u64;
    let member_credits = git_doc_credits(MEMBER_BYTES) * members_todo.len() as u64;
    let collab_credits = {
        let mut dry = Sink::new(
            Collab::reader(&client),
            dest.existing.clone(),
            Ledger::new(&client, signer_id.clone(), true, Budget::new(None)),
        );
        dry.sync(&collab_src).await?;
        dry.ledger.budget.spent()
    };
    let create_credits = if create { REPO_CREATE_CREDITS } else { 0 };
    let total = create_credits + git_credits + member_credits + collab_credits;
    summary.estimate_credits = total;
    let mut budget = Budget::new(cfg.max_spend);
    budget.check_plan(total)?;
    let reupload = packs_todo.iter().filter(|p| p.reupload()).count();
    eprintln!(
        "{} → {}: {} packs ({} re-uploaded as Platform chunks, {} referenced), {} refs, {} members; estimated {:.6} DASH",
        summary.source,
        dest.url(),
        packs_todo.len(),
        reupload,
        packs_todo.len() - reupload,
        refs_todo.len(),
        members_todo.len(),
        forge_core::repo::credits_to_dash(total)
    );

    if cfg.dry_run {
        let mut dry = Sink::new(
            Collab::reader(&client),
            dest.existing.clone(),
            Ledger::new(&client, signer_id.clone(), true, Budget::new(None)),
        );
        dry.sync(&collab_src).await?;
        summary.counts = dry.ledger.counts;
        summary.counts.packs = packs_todo.len() as u64;
        summary.counts.pack_bytes = packs_todo.iter().map(|p| p.manifest.size_bytes).sum();
        summary.counts.refs = refs_todo.len() as u64;
        summary.counts.members = members_todo.len() as u64;
        summary.warnings.extend(dry.ledger.warnings);
        summary.status = Status::DryRun;
        return Ok(());
    }
    let signer = signer.expect("checked above");
    if total > 0 && !cfg.yes {
        use std::io::IsTerminal as _;
        if !std::io::stdin().is_terminal() {
            bail!("refusing to spend without confirmation on a non-interactive stdin; pass --yes");
        }
        eprint!(
            "Proceed (~{:.6} DASH)? [y/N] ",
            forge_core::repo::credits_to_dash(total)
        );
        let mut line = String::new();
        std::io::stdin().read_line(&mut line)?;
        if !matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
            bail!("cancelled");
        }
    }
    budget.start(signer.identity.balance());

    if create {
        budget.charge(REPO_CREATE_CREDITS, "creating the repository")?;
        let description = format!(
            "Migrated from forge-v1 {} ({})",
            v1.display(),
            cfg.source_network.network.key()
        );
        let created = dest::create(
            &client,
            &signer,
            &mut dest,
            &description,
            &default_branch,
            0,
        )
        .await?;
        summary.repo = dest.info(created);
    }
    let repo = dest.existing.clone().expect("created or existing");
    let role = dest::require_member(&client, &repo, &signer.id()).await?;
    let mut ledger = Ledger::new(&client, Some(signer.id()), false, budget);
    ledger.reconcile().await;

    // Git data: packs first (a ref must never name history that is not stored), then refs.
    let svc = RepoService::new(&client, &signer.identity, &signer.bridge);
    let pack_reader = PackReader::from_user_config();
    for p in &packs_todo {
        let hash = hex::encode(p.manifest.pack_hash);
        // Reading is free; charge only a pack that will actually be written.
        let bytes = match reader.fetch_artifact(&v1, &p.manifest, &pack_reader).await {
            Ok(b) => b,
            // An external pack no URI serves any more (v1 packs pushed to a local bucket):
            // nothing can read it, so there is nothing to copy. Its objects are missing
            // from the v1 repo too; a clone that needs them fails either way.
            Err(e) if !p.reupload() => {
                ledger.warn(format!(
                    "v1 pack {} is stored externally and no recorded copy is readable ({e}); \
                     not copied",
                    &hash[..12]
                ));
                continue;
            }
            Err(e) => return Err(anyhow::Error::from(e).context(format!("reading v1 pack {hash}"))),
        };
        ledger
            .budget
            .charge(p.credits(), format!("pack {}", &hash[..12]))?;
        let (storage, chunk_count, mut uris) = if p.reupload() {
            let meta = forge_core::backends::PackMeta::for_bytes(&bytes);
            let stored = svc
                .put_pack(&repo, &bytes, &meta)
                .await
                .with_context(|| format!("uploading pack {hash}"))?;
            (
                0,
                split(&bytes).len() as u64,
                stored.into_iter().map(|u| u.0).collect::<Vec<_>>(),
            )
        } else {
            (1, 0, Vec::new())
        };
        uris.extend(p.external.iter().cloned());
        while !MANIFEST_URIS_V2.fits(&uris) {
            uris.pop();
        }
        svc.write_pack_manifest(
            &repo,
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
    for (name, want, current) in &refs_todo {
        let (Ok(new_oid), prev) = (
            hex::decode(want),
            current
                .as_deref()
                .map(hex::decode)
                .transpose()
                .ok()
                .flatten(),
        ) else {
            ledger.warn(format!("ref {name} has an unreadable tip; skipped"));
            continue;
        };
        ledger
            .budget
            .charge(git_doc_credits(REF_UPDATE_BYTES), format!("ref {name}"))?;
        match svc
            .write_ref_update(&repo, name, &new_oid, prev.as_deref(), true)
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

    // Members.
    if !members_todo.is_empty() {
        if repo.owner_id() == signer.id() {
            let members = MemberService::new(&client, &signer.identity, &signer.bridge);
            for c in &members_todo {
                let role = if c.maintainer {
                    Role::Maintainer
                } else {
                    Role::Writer
                };
                ledger.budget.charge(
                    git_doc_credits(MEMBER_BYTES),
                    format!("member {}", c.identity),
                )?;
                match members.grant(&repo, &c.identity, role).await {
                    Ok(_) => ledger.counts.members += 1,
                    Err(forge_core::Error::Config(why)) if why.contains("not an identity") => {
                        ledger.warn(format!(
                            "v1 collaborator {} does not exist on {}; not added",
                            c.identity, cfg.network.network
                        ));
                    }
                    Err(e) => {
                        return Err(
                            anyhow::Error::from(e).context(format!("adding member {}", c.identity))
                        )
                    }
                }
                ledger.reconcile().await;
            }
        } else {
            ledger.warn(format!(
                "{} v1 collaborators were not added: only the repository owner ({}) can add members",
                members_todo.len(),
                repo.owner_id()
            ));
        }
    }

    // Issues, PRs and the rest.
    let mut sink = Sink::new(
        Collab::new(&client, &signer.identity, &signer.bridge),
        Some(repo),
        ledger,
    );
    let result = sink.sync(&collab_src).await;
    sink.ledger.reconcile().await;
    summary.counts = sink.ledger.counts;
    summary
        .warnings
        .extend(std::mem::take(&mut sink.ledger.warnings));
    summary.spent_credits = sink.ledger.budget.spent();
    summary.balance_credits = client.get_balance(&signer.id()).await.ok();
    summary.key = signer.key_info(&client).await;
    result?;
    if summary.counts.packs > 0 {
        summary.warnings.push(
            "the browse index (objectLocator) is not copied; the web app reads the repository \
             whole-pack until the next push or `dg repack`"
                .into(),
        );
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
    fn local_copies_are_not_referenced() {
        assert!(portable_uris(&[
            "http://127.0.0.1:9000/b/p.pack".into(),
            "http://localhost:8080/ipfs/x".into(),
            "https://10.1.2.3/p".into(),
        ])
        .is_empty());
    }
}
