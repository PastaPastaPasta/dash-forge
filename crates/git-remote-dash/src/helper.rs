//! The stateful helper: resolves config, connects to Platform lazily, and implements the
//! `list` / `fetch` / `push` operations against `forge-core`'s [`RepoService`].
//!
//! Data flow (architecture §6):
//! - **list** → `resolve_repo` → `read_refs` (proof-verified, folded by `FORGE_RULES_V1`) →
//!   `<oid> <ref>` lines + the `HEAD` symref from the repo's default branch.
//! - **fetch** → collect `packManifest`s (kind 0) → `get_pack` each (SHA-256-verified) →
//!   `git index-pack` into the local odb. A `--filter` partial clone re-packs the download
//!   through a scratch repo and writes the `.promisor` marker (S0.9).
//! - **push** → fast-forward check vs remote refs → `build_pack` (thin + `--fix-thin` =
//!   self-contained) → `put_pack` (pipelined chunk STs) → `write_pack_manifest` →
//!   `write_ref_update` (prevOid recorded; non-FF refused without `+`) → post-push ref
//!   re-read for a lost-race late non-fast-forward.

use std::path::PathBuf;

use anyhow::{anyhow, bail, Context, Result};
use forge_core::backends::{PackMeta, Uri};
use forge_core::keystore::BridgeIdentity;
use forge_core::pack::{build_pack, split, KIND_GIT_PACK};
use forge_core::platform::{LoadedIdentity, Network, PlatformClient};
use forge_core::repo::{PackManifestInput, RepoHandle, RepoService};
use forge_core::rules::RefState;

use crate::git::{LocalRepo, ScratchRepo};
use crate::options::OptionState;
use crate::url::DashUrl;

/// A single want from a `fetch <oid> <name>` line.
#[derive(Debug, Clone)]
pub struct Want {
    /// The wanted object id (40-hex). For a lazy promisor fetch this is a bare blob/tree.
    pub oid: String,
}

/// A parsed `push [+]<src>:<dst>` refspec.
#[derive(Debug, Clone)]
pub struct PushSpec {
    /// The `+` force flag.
    pub force: bool,
    /// The local source ref/oid (empty for a deletion).
    pub src: String,
    /// The remote destination ref.
    pub dst: String,
}

/// The per-ref outcome of a push batch, emitted as `ok <dst>` / `error <dst> <reason>`.
#[derive(Debug, Clone)]
pub enum PushOutcome {
    /// The ref update landed.
    Ok(String),
    /// The ref update was refused.
    Error(String, String),
}

impl PushOutcome {
    /// The exact status line (no trailing newline).
    pub fn wire(&self) -> String {
        match self {
            PushOutcome::Ok(dst) => format!("ok {dst}"),
            PushOutcome::Error(dst, why) => format!("error {dst} {why}"),
        }
    }
}

/// A live Platform connection plus the resolved repo handle.
struct Conn {
    client: PlatformClient,
    identity: LoadedIdentity,
    bridge: BridgeIdentity,
    repo: RepoHandle,
}

/// The remote helper, holding parsed config and a lazily-established connection.
pub struct Helper {
    url: DashUrl,
    key_path: PathBuf,
    network: Network,
    conn: Option<Conn>,
}

impl Helper {
    /// Build a helper for `url`, reading identity + network config from the environment.
    ///
    /// `DASH_FORGE_KEY` names the bridge-format identity JSON (falling back to
    /// `~/.config/dash-forge/identities/<owner>.identity.json`); `DASH_FORGE_NETWORK`
    /// selects the network (testnet default).
    pub fn new(url: DashUrl) -> Result<Self> {
        let key_path = resolve_key_path(&url)?;
        let network = network_from_env();
        Ok(Self {
            url,
            key_path,
            network,
            conn: None,
        })
    }

    /// Establish (once) the Platform connection and resolve the repo.
    async fn ensure_conn(&mut self) -> Result<&Conn> {
        if self.conn.is_none() {
            let bridge = BridgeIdentity::load_from_file(&self.key_path).with_context(|| {
                format!(
                    "loading identity from {} (set DASH_FORGE_KEY)",
                    self.key_path.display()
                )
            })?;
            let client = PlatformClient::connect(self.network)
                .await
                .context("connecting to Dash Platform")?;
            let identity = client
                .fetch_identity(&bridge.identity_id)
                .await
                .with_context(|| format!("fetching identity {}", bridge.identity_id))?;
            let repo = {
                let svc = RepoService::new(&client, &identity, &bridge);
                svc.resolve_repo(&self.url.owner, &self.url.repo)
                    .await
                    .with_context(|| {
                        format!("resolving repo {}/{}", self.url.owner, self.url.repo)
                    })?
            };
            tracing::info!(
                repo_contract = %repo.repo_contract_id,
                owner = %repo.owner_id,
                "resolved dash:// repo"
            );
            self.conn = Some(Conn {
                client,
                identity,
                bridge,
                repo,
            });
        }
        Ok(self.conn.as_ref().expect("conn populated"))
    }

    /// The `list` / `list for-push` response lines: `<oid> <refname>` per resolved ref and
    /// an `@refs/heads/<default> HEAD` symref.
    pub async fn list(&mut self) -> Result<Vec<String>> {
        let conn = self.ensure_conn().await?;
        let svc = RepoService::new(&conn.client, &conn.identity, &conn.bridge);
        let refs = svc.read_refs(&conn.repo).await?;
        let default_branch = svc
            .read_default_branch(&conn.repo)
            .await?
            .unwrap_or_else(|| "main".to_string());

        let mut lines = Vec::new();
        let mut names: Vec<String> = Vec::new();
        for (name, state) in &refs {
            // Emission guard (defense-in-depth with rules::is_update_valid): never advertise
            // a ref name carrying control chars/whitespace — it could inject a spoofed
            // advertisement line into git's parse of this output (S0.9 wire protocol).
            if !forge_core::rules::is_legal_ref_name(name) {
                tracing::warn!(ref_name = %name.escape_debug(), "skipping illegal ref name in list");
                continue;
            }
            if let Some(oid) = tip_oid(state) {
                lines.push(format!("{oid} {name}"));
                names.push(name.clone());
            }
        }

        // Emit the HEAD symref when the default branch exists (a fresh/empty repo has no
        // head yet — git handles the absence).
        let default_ref = format!("refs/heads/{default_branch}");
        if names.iter().any(|n| n == &default_ref) {
            lines.push(format!("@{default_ref} HEAD"));
        } else if let Some(first_head) = names.iter().find(|n| n.starts_with("refs/heads/")) {
            // No default branch present but some head is — point HEAD at it so clone can
            // check something out rather than warning about a dangling HEAD.
            lines.push(format!("@{first_head} HEAD"));
        }
        Ok(lines)
    }

    /// Serve a `fetch` batch: download the packs covering the wanted objects and index them
    /// into the local odb. Full clone indexes the self-contained packs directly; a
    /// `--filter` partial clone re-packs through a scratch repo and writes `.promisor`.
    pub async fn fetch(&mut self, wants: &[Want], options: &OptionState) -> Result<()> {
        // The local git odb is the cache — never re-download objects git already has
        // (architecture §6). For a plain (non-filter) fetch, if every wanted object is
        // already present locally there is nothing to transfer. (A promisor fetch still
        // runs, since a present commit may need its filtered blobs materialized.)
        if options.filter.is_none()
            && !wants.is_empty()
            && wants.iter().all(|w| LocalRepo::object_exists(&w.oid))
        {
            tracing::info!(
                wants = wants.len(),
                "all wanted objects already local; skipping fetch"
            );
            return Ok(());
        }

        let conn = self.ensure_conn().await?;
        let svc = RepoService::new(&conn.client, &conn.identity, &conn.bridge);

        let manifests = svc.read_pack_manifests(&conn.repo).await?;
        let git_packs: Vec<_> = manifests
            .into_iter()
            .filter(|m| m.kind == u64::from(KIND_GIT_PACK))
            .collect();

        if git_packs.is_empty() {
            // Nothing stored: an empty repo. git tolerates a fetch that delivers no objects
            // as long as the wants were not real (they cannot be, with no packs).
            tracing::warn!("no git packs stored for repo; delivering nothing");
            return Ok(());
        }

        // Download + verify every pack (M1: whole-repo packs; the want-set is served by the
        // union of stored packs, and git dedups objects it already has).
        let mut downloaded: Vec<Vec<u8>> = Vec::with_capacity(git_packs.len());
        for m in &git_packs {
            let uri = match m.uris.first() {
                Some(u) => Uri(u.clone()),
                None => default_platform_uri(&conn.repo.repo_contract_id, &m.pack_hash),
            };
            let bytes = svc
                .get_pack(&conn.repo, &uri, None)
                .await
                .with_context(|| format!("downloading pack {}", hex::encode(m.pack_hash)))?;
            // Integrity: reassembled bytes must match the manifest packHash (SHA-256).
            let got = PackMeta::for_bytes(&bytes).pack_hash;
            let expected = hex::encode(m.pack_hash);
            if !got.eq_ignore_ascii_case(&expected) {
                bail!("pack integrity check failed: expected {expected}, got {got}");
            }
            downloaded.push(bytes);
        }

        if let Some(filter) = options.filter.as_deref() {
            // Partial clone: re-pack the downloaded objects through a scratch repo applying
            // the filter, then index the filtered pack and mark it promisor.
            let scratch = ScratchRepo::init()?;
            for bytes in &downloaded {
                scratch.index_pack(bytes)?;
            }
            let want_oids: Vec<String> = wants.iter().map(|w| w.oid.clone()).collect();
            if want_oids.is_empty() {
                return Ok(());
            }
            let filtered = scratch.pack_filtered(&want_oids, Some(filter))?;
            let sha = LocalRepo::index_pack(&filtered)?;
            LocalRepo::write_promisor_marker(&sha)?;
            tracing::info!(filter, pack = %sha, "indexed filtered promisor pack");
        } else {
            for bytes in &downloaded {
                let sha = LocalRepo::index_pack(bytes)?;
                tracing::info!(pack = %sha, "indexed pack into local odb");
            }
        }
        Ok(())
    }

    /// Serve a `push` batch: fast-forward-check each refspec against the current remote
    /// state, upload one self-contained pack covering the accepted updates, write the
    /// `packManifest`, then a `refUpdate` per ref, and finally re-read refs to surface a
    /// lost concurrent race as a late non-fast-forward.
    pub async fn push(
        &mut self,
        specs: &[PushSpec],
        options: &OptionState,
    ) -> Result<Vec<PushOutcome>> {
        let git_dir = LocalRepo::git_dir()?;
        let dry_run = options.dry_run;
        let conn = self.ensure_conn().await?;
        let svc = RepoService::new(&conn.client, &conn.identity, &conn.bridge);

        let remote_refs = svc.read_refs(&conn.repo).await?;
        let planned = plan_pushes(specs, &remote_refs);

        // Build + upload one pack covering all accepted, non-delete updates.
        let want_tips: Vec<String> = planned
            .iter()
            .filter(|p| p.reject.is_none())
            .filter_map(|p| p.new_oid.clone())
            .collect();
        if !want_tips.is_empty() && !dry_run {
            upload_push_pack(&svc, &conn.repo, &git_dir, &want_tips, &remote_refs).await?;
        }

        // Apply ref updates for accepted specs.
        if !dry_run {
            for p in planned.iter().filter(|p| p.reject.is_none()) {
                let new_bytes = match &p.new_oid {
                    Some(oid) => oid_to_bytes(oid)?,
                    None => vec![0u8; 20], // delete = zero oid
                };
                let prev_bytes = match &p.prev_oid {
                    Some(oid) => Some(oid_to_bytes(oid)?),
                    None => None,
                };
                svc.write_ref_update(
                    &conn.repo,
                    &p.spec.dst,
                    &new_bytes,
                    prev_bytes.as_deref(),
                    p.spec.force,
                )
                .await
                .with_context(|| format!("writing ref update for {}", p.spec.dst))?;
            }
        }

        // Post-push re-read: a same-prevOid race lost to a concurrent pusher surfaces here
        // as a divergence → report a late non-fast-forward rather than a silent orphan.
        // Platform reads are eventually consistent, so a re-read *immediately* after the
        // write can lag (not yet reflect our update). Poll until every accepted ref shows
        // its pushed tip (convergence) or the retries are exhausted — the write itself has
        // already landed idempotently; this only decides what status we report to git.
        let final_refs = if dry_run {
            remote_refs
        } else {
            self.read_refs_until_converged(&planned).await?
        };
        Ok(finalize_outcomes(planned, &final_refs, dry_run))
    }

    /// Re-read refs, retrying briefly until every accepted non-delete spec resolves to its
    /// pushed tip (tolerating read-after-write lag), or the retry budget is spent.
    async fn read_refs_until_converged(
        &self,
        planned: &[Planned],
    ) -> Result<Vec<(String, RefState)>> {
        const MAX_ATTEMPTS: usize = 6;
        let conn = self.conn.as_ref().expect("connected before finalize");
        let svc = RepoService::new(&conn.client, &conn.identity, &conn.bridge);
        let expected: Vec<(&str, &str)> = planned
            .iter()
            .filter(|p| p.reject.is_none())
            .filter_map(|p| p.new_oid.as_deref().map(|oid| (p.spec.dst.as_str(), oid)))
            .collect();

        let mut last = svc.read_refs(&conn.repo).await?;
        for attempt in 1..=MAX_ATTEMPTS {
            let converged = expected.iter().all(|(dst, oid)| {
                matches!(last.iter().find(|(n, _)| n == dst),
                    Some((_, RefState::Resolved { oid: got, .. })) if got == oid)
            });
            if converged || expected.is_empty() {
                break;
            }
            if attempt < MAX_ATTEMPTS {
                tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                last = svc.read_refs(&conn.repo).await?;
            }
        }
        Ok(last)
    }
}

/// The provisional tip oid of a resolved (or diverged, newest-head) ref; `None` for an
/// unborn ref. The single mapping every ref-state read goes through.
fn tip_oid(state: &RefState) -> Option<String> {
    match state {
        RefState::Resolved { oid, .. } => Some(oid.clone()),
        RefState::Diverged { heads } => heads.first().map(|h| h.oid.clone()),
        RefState::Unborn => None,
    }
}

/// The current remote tip of `name` within a resolved ref list.
fn remote_tip(refs: &[(String, RefState)], name: &str) -> Option<String> {
    refs.iter()
        .find(|(n, _)| n == name)
        .and_then(|(_, s)| tip_oid(s))
}

/// A push refspec resolved to its intended write, with any pre-write rejection.
struct Planned {
    spec: PushSpec,
    /// New tip oid (`None` = delete).
    new_oid: Option<String>,
    /// Recorded previous tip (`None` = ref did not exist remotely).
    prev_oid: Option<String>,
    /// Set when the spec is rejected before any write (e.g. non-fast-forward).
    reject: Option<String>,
}

/// Decide accept/reject for every refspec up front (no writes): deletions and new refs are
/// accepted; an update is accepted iff forced, a no-op, or a fast-forward — otherwise
/// rejected as `non-fast-forward` (§2.3 / PRD 02).
fn plan_pushes(specs: &[PushSpec], remote_refs: &[(String, RefState)]) -> Vec<Planned> {
    let mut planned = Vec::with_capacity(specs.len());
    for spec in specs {
        let prev = remote_tip(remote_refs, &spec.dst);
        if spec.src.is_empty() {
            // Deletion.
            planned.push(Planned {
                spec: spec.clone(),
                new_oid: None,
                prev_oid: prev,
                reject: None,
            });
            continue;
        }
        let Some(new_oid) = LocalRepo::rev_parse(&spec.src) else {
            planned.push(Planned {
                spec: spec.clone(),
                new_oid: None,
                prev_oid: prev,
                reject: Some(format!("cannot resolve local source {:?}", spec.src)),
            });
            continue;
        };
        let reject = match &prev {
            None => None, // new ref
            Some(tip) => {
                let fast_forward =
                    spec.force || tip == &new_oid || LocalRepo::is_ancestor(tip, &new_oid);
                if fast_forward {
                    None
                } else {
                    Some("non-fast-forward".to_string())
                }
            }
        };
        planned.push(Planned {
            spec: spec.clone(),
            new_oid: Some(new_oid),
            prev_oid: prev,
            reject,
        });
    }
    planned
}

/// Build one self-contained pack for `want_tips` (excluding remote tips already local as
/// thin-pack bases), upload its chunks, and record the `packManifest`.
async fn upload_push_pack(
    svc: &RepoService<'_>,
    repo: &RepoHandle,
    git_dir: &std::path::Path,
    want_tips: &[String],
    remote_refs: &[(String, RefState)],
) -> Result<()> {
    let have_bases: Vec<String> = remote_refs
        .iter()
        .filter_map(|(_, s)| tip_oid(s))
        .filter(|oid| LocalRepo::object_exists(oid))
        .collect();

    let want_refs: Vec<&str> = want_tips.iter().map(String::as_str).collect();
    let base_refs: Vec<&str> = have_bases.iter().map(String::as_str).collect();
    let report =
        build_pack(git_dir, &want_refs, &base_refs).context("building self-contained push pack")?;
    let bytes = &report.pack.bytes;
    let meta = PackMeta::for_bytes(bytes);
    let pack_hash = meta.pack_hash_bytes()?;
    let object_count = report.pack.parsed.object_count() as u64;
    let chunk_vec_len = split(bytes).len();
    let chunk_count = chunk_vec_len as u64;
    let chunk_count_u32 = u32::try_from(chunk_vec_len)
        .map_err(|_| anyhow!("pack has too many chunks ({chunk_vec_len}) for a u32 journal"))?;
    tracing::info!(
        pack_hash = %meta.pack_hash,
        bytes = bytes.len(),
        objects = object_count,
        chunks = chunk_count,
        premium = report.premium_ratio(),
        "uploading push pack"
    );

    // Resumable upload: a journal under .git/dash/journal/<packHash>.json records confirmed
    // chunks so an interrupted push resumes without re-paying (PRD 02 §A). Re-broadcasts of
    // an already-stored chunk/manifest also idempotently no-op via the unique-index →
    // AlreadyExists classification, so a re-run is safe even if the journal is lost.
    let jpath = crate::journal::journal_path(git_dir, &meta.pack_hash);
    let mut journal = crate::journal::load_or_new(&jpath, &meta.pack_hash, chunk_count_u32);
    let already = journal.uploaded.len();
    if already > 0 {
        tracing::info!(
            resumed_chunks = already,
            total = chunk_count,
            "resuming interrupted push from journal"
        );
    }
    let store = crate::journal::FileJournalStore::new(jpath.clone());
    let uris = svc
        .put_pack_resumable(repo, bytes, &meta, &mut journal, &store)
        .await
        .context("uploading pack chunks")?;
    svc.write_pack_manifest(
        repo,
        &PackManifestInput {
            pack_hash,
            kind: u64::from(KIND_GIT_PACK),
            size_bytes: bytes.len() as u64,
            object_count,
            chunk_count,
            storage: 0,
            offset_index_parts: 0,
            uris: uris.iter().map(|u| u.0.clone()).collect(),
            // An incremental push supersedes nothing and carries no flatIndex tips.
            supersedes: Vec::new(),
            tips: Vec::new(),
        },
    )
    .await
    .context("writing pack manifest")?;

    // Push fully landed (chunks + manifest): retire the journal.
    let _ = std::fs::remove_file(&jpath);
    Ok(())
}

/// Turn the plan + post-push ref state into per-ref outcomes. A rejected spec keeps its
/// pre-write reason; an accepted one is confirmed only if the ref converged to the pushed
/// tip (or vanished, for a delete) — a lingering divergence is a late non-fast-forward.
fn finalize_outcomes(
    planned: Vec<Planned>,
    final_refs: &[(String, RefState)],
    dry_run: bool,
) -> Vec<PushOutcome> {
    let mut outcomes = Vec::with_capacity(planned.len());
    for p in planned {
        if let Some(why) = p.reject {
            outcomes.push(PushOutcome::Error(p.spec.dst, why));
            continue;
        }
        if dry_run {
            outcomes.push(PushOutcome::Ok(p.spec.dst));
            continue;
        }
        let state = final_refs
            .iter()
            .find(|(n, _)| *n == p.spec.dst)
            .map(|(_, s)| s);
        let outcome = match &p.new_oid {
            None => match state {
                None | Some(RefState::Unborn) => PushOutcome::Ok(p.spec.dst),
                _ => PushOutcome::Error(p.spec.dst, "delete did not take effect".to_string()),
            },
            Some(expected) => match state {
                Some(RefState::Resolved { oid, .. }) if oid == expected => {
                    PushOutcome::Ok(p.spec.dst)
                }
                Some(RefState::Diverged { .. }) => PushOutcome::Error(
                    p.spec.dst,
                    "non-fast-forward (lost concurrent race)".to_string(),
                ),
                _ => {
                    PushOutcome::Error(p.spec.dst, "ref did not converge to pushed tip".to_string())
                }
            },
        };
        outcomes.push(outcome);
    }
    outcomes
}

/// Decode a 40-hex git oid to its 20 raw bytes.
fn oid_to_bytes(oid: &str) -> Result<Vec<u8>> {
    let raw = hex::decode(oid).map_err(|e| anyhow!("oid {oid:?} is not hex: {e}"))?;
    if raw.len() != 20 {
        bail!("oid {oid:?} is not 20 bytes (sha1)");
    }
    Ok(raw)
}

/// The default `platform://<contract>/<packHashHex>` locator when a manifest recorded no
/// explicit URI (platform-tier packs are addressable by contract + packHash).
fn default_platform_uri(contract_id: &str, pack_hash: &[u8; 32]) -> Uri {
    Uri(format!(
        "platform://{contract_id}/{}",
        hex::encode(pack_hash)
    ))
}

/// Select the network from `DASH_FORGE_NETWORK` (testnet default).
pub(crate) fn network_from_env() -> Network {
    match std::env::var("DASH_FORGE_NETWORK").as_deref() {
        Ok("mainnet") => Network::Mainnet,
        Ok("devnet") => Network::Devnet,
        _ => Network::Testnet,
    }
}

/// Resolve the identity key file: `DASH_FORGE_KEY` if set, else
/// `~/.config/dash-forge/identities/<owner>.identity.json`.
fn resolve_key_path(url: &DashUrl) -> Result<PathBuf> {
    if let Some(p) = std::env::var_os("DASH_FORGE_KEY") {
        return Ok(PathBuf::from(p));
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("neither DASH_FORGE_KEY nor HOME is set; cannot locate identity"))?;
    Ok(home
        .join(".config/dash-forge/identities")
        .join(format!("{}.identity.json", url.owner)))
}

#[cfg(test)]
mod tests {
    use super::{oid_to_bytes, PushOutcome};

    #[test]
    fn oid_round_trips_to_20_bytes() {
        let oid = "0123456789abcdef0123456789abcdef01234567";
        let bytes = oid_to_bytes(oid).unwrap();
        assert_eq!(bytes.len(), 20);
        assert_eq!(hex::encode(bytes), oid);
    }

    #[test]
    fn oid_rejects_bad_input() {
        assert!(oid_to_bytes("nothex").is_err());
        assert!(oid_to_bytes("abcd").is_err()); // too short
    }

    #[test]
    fn push_outcome_wire_format() {
        assert_eq!(
            PushOutcome::Ok("refs/heads/main".into()).wire(),
            "ok refs/heads/main"
        );
        assert_eq!(
            PushOutcome::Error("refs/heads/main".into(), "non-fast-forward".into()).wire(),
            "error refs/heads/main non-fast-forward"
        );
    }
}
