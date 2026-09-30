//! `dg cost` — pre-write estimates and a per-operation / storage audit.

use anyhow::{Context, Result};
use serde_json::json;

use forge_core::cost::{estimate, push_fees};
use forge_core::cost_audit::{self, AuditReport};
use forge_core::pack::DOC_PAYLOAD_MAX;
use forge_core::private::pack::{sealed_upper_bound, HEADER_LEN};
use forge_core::repo::{prepare_history_index, HistoryCost, HistoryPlan};
use forge_core::storage::human_bytes;
use forge_import::budget::{collab_doc_credits, CollabDoc};

use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, REPO_CREATE_ESTIMATE_CREDITS};
use crate::quote::FIRST_OF_KIND_EXTRA;
use crate::{Backend, CostCommand};

/// Dispatch a `cost` subcommand.
pub async fn run(ctx: &Ctx, cmd: &CostCommand) -> Result<()> {
    match cmd {
        CostCommand::Estimate {
            backend,
            bytes,
            path,
            private,
        } => estimate_cmd(ctx, *backend, *bytes, path.as_deref(), *private),
        CostCommand::Audit { owner, since, repo } => {
            audit(ctx, owner.as_deref(), since.as_deref(), repo.as_deref()).await
        }
        CostCommand::Prices => {
            prices_cmd(ctx);
            Ok(())
        }
    }
}

/// The static per-operation price reference (`dg cost audit`'s home before it became an
/// identity spend estimate; moved here so it stays reachable — see `docs/guides/costs.md`
/// §What each action costs).
fn prices_cmd(ctx: &Ctx) {
    let price = ctx.usd_price();
    let ops = price_table();
    let rows: Vec<_> = ops
        .iter()
        .map(|(op, credits)| json!({ "op": op, "cost": cost_json(*credits, price) }))
        .collect();
    ctx.emit(
        json!({
            "mode": "per_operation_estimates",
            "operations": rows,
            "note": "upper bounds: each write priced as the first of its kind (a repository's first issue, a thread's first comment), from fees measured on devnets moutai and bonsia; for what one identity has actually spent, use `dg cost audit`",
        }),
        || {
            println!("Per-operation cost reference (upper bounds; see `dg cost audit` for what you've spent):");
            if price.is_none() {
                println!("  ({} on {})", crate::fmt::NO_CASH_VALUE, ctx.network_label());
            }
            for (op, credits) in ops {
                println!("  {op:<26} {}", cost_line(credits, price));
            }
        },
    );
}

/// `dg cost prices`' rows: upper bounds from the fees measured on moutai and bonsia
/// (`push_fees`, the importer's calibrated collaboration model); docs/guides/costs.md has the
/// measured table.
fn price_table() -> [(&'static str, u64); 6] {
    [
        ("repo create", REPO_CREATE_ESTIMATE_CREDITS),
        ("ref update", push_fees::REF_FIRST),
        ("pack manifest", push_fees::MANIFEST_FIRST),
        (
            "pack chunk (14.7 KB)",
            push_fees::chunks(DOC_PAYLOAD_MAX as u64),
        ),
        (
            "issue (~500 B)",
            collab_doc_credits(CollabDoc::Target, 500) + FIRST_OF_KIND_EXTRA,
        ),
        (
            "comment (~500 B)",
            collab_doc_credits(CollabDoc::Comment, 500) + FIRST_OF_KIND_EXTRA,
        ),
    ]
}

/// Pack bytes per object assumed when only a size is known (`--bytes`, a file), for the browse
/// index a push publishes (36 bytes per object). A typical density, not a bound: a pack of many
/// small deltas holds more objects, so a size-only Platform quote says the count is assumed and
/// does not call itself an upper bound. `--path <repository>` counts the real objects.
const BYTES_PER_OBJECT: u64 = 512;

/// What `dg cost estimate` prices: a first push of `bytes` of pack (`objects` objects).
#[derive(Debug, Clone)]
struct PushInput {
    /// What was measured, for the heading (`1.0 MiB`, `the repository at .`).
    what: String,
    bytes: u64,
    objects: u64,
    /// The history index of the repository's `HEAD`, when it was computed (`--path`).
    history: Option<HistoryCost>,
    /// The repository, when one was measured (its storage policy is the default backend).
    repo: Option<std::path::PathBuf>,
    /// A private repository (`--private`): its pack and indexes are stored sealed. Visibility
    /// is set when the repository is created on chain, so a local clone cannot tell.
    sealed: bool,
    /// Why the repository's history index could not be computed (its push publishes none).
    history_skipped: Option<String>,
}

impl PushInput {
    /// Only a size is known: objects are assumed ([`BYTES_PER_OBJECT`]), the history index is
    /// not.
    fn sized(what: String, bytes: u64) -> Self {
        Self {
            what,
            bytes,
            objects: bytes.div_ceil(BYTES_PER_OBJECT).max(1),
            history: None,
            repo: None,
            sealed: false,
            history_skipped: None,
        }
    }

    /// The objects were counted in a repository (else assumed from the size).
    fn counted(&self) -> bool {
        self.repo.is_some()
    }
}

/// Where a quoted push stores its pack bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Target {
    /// `platform`, `s3`, or a repository's profiles (`r2-main, platform`).
    label: String,
    /// Platform stores the bytes as `chunk` documents.
    platform: bool,
    /// External targets: each adds its URIs to every manifest.
    external: u64,
}

impl Target {
    /// A `--backend`: `platform` stores on Platform, `mixed` on Platform and one bucket, and
    /// `s3`, `ipfs` and `https` in one bucket or node of your own.
    fn backend(b: Backend) -> Self {
        Self {
            label: b.label().to_string(),
            platform: matches!(b, Backend::Platform | Backend::Mixed),
            external: u64::from(b != Backend::Platform),
        }
    }

    /// The storage `git push` in `dir` would use: its forge remote's `remote.<name>.dash*`
    /// settings over `dash.*` (`storage::push_policy_in`, the helper's rule), resolved against
    /// the storage profiles; Platform when none is set.
    fn repository(dir: &std::path::Path) -> Result<Self> {
        use forge_core::storage::StorageProfiles;
        let policy = crate::storage::push_policy_in(dir)?;
        if policy.is_platform_only() {
            return Ok(Self::backend(Backend::Platform));
        }
        let resolved = policy
            .resolve(&StorageProfiles::load()?)
            .context("resolving this repository's dash.storage (`--backend` prices another)")?;
        Ok(Self {
            label: format!("{} (dash.storage)", resolved.target_names().join(", ")),
            platform: resolved.platform,
            external: resolved.external.len() as u64,
        })
    }
}

/// A first push's on-chain price, as `git push` quotes it (`push_fees`; every write priced as
/// the first of its kind, so an upper bound: later pushes pay less).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PushQuote {
    /// The manifests (the pack's, its browse index's, the history index's) and the ref update:
    /// on Platform whatever stores the bytes.
    metadata: u64,
    /// The `chunk` documents (pack, browse index, the history index when it is known): only
    /// when Platform stores the bytes.
    chunks: u64,
    /// The storage deposit within `chunks` (Platform packs are never deleted, so never refunded).
    deposit: u64,
    /// `packManifest` documents written.
    manifests: u32,
    /// Platform stores the history index's chunks, but its size is unknown (only a size was
    /// given), so they are not in the total.
    history_chunks_unpriced: bool,
}

impl PushQuote {
    fn total(&self) -> u64 {
        self.metadata + self.chunks
    }
}

/// Price a first push of `input` to `target` from the primitives git-remote-dash prices one
/// with (`PackJob::estimate`): its pack and browse index (`push_fees::estimate_push`), one ref
/// update, and the history index a push to the default branch publishes
/// (`HistoryCost::credits`). External storage keeps the bytes off-chain: Platform bills only
/// the manifests (with each target's URIs) and the ref update.
fn quote(target: &Target, input: &PushInput) -> PushQuote {
    let (platform, external, sealed) = (target.platform, target.external, input.sealed);
    let push = push_fees::estimate_push(&push_fees::PushShape {
        pack_bytes: input.bytes,
        objects: input.objects,
        index_objects: input.objects,
        refs: 1,
        external_targets: external,
        platform_bytes: platform,
        sealed,
    });
    // A first history index: each part pays the first-of-kind fee. A repository it could not be
    // computed in publishes none (the push skips it); from a size alone it is priced as the two
    // manifests a first one writes, without chunks.
    let (history_manifests, history_meta, history_chunks, history_bytes) = match input.history {
        Some(h) => {
            let meta = h.credits(sealed, external, false);
            let all = h.credits(sealed, external, platform);
            (h.manifests(), meta, all - meta, h.plain_len())
        }
        None if input.counted() => (0, 0, 0, 0),
        None => (
            2,
            2 * push_fees::history_index(0, sealed, external, false, true),
            0,
            0,
        ),
    };
    let deposit = if platform {
        // What each artifact takes stored: a private repository's are sealed (a header and a
        // tag per segment, each history part its own sealed artifact).
        let stored = |plain: u64, parts: u64| {
            if sealed && plain > 0 {
                let extra = parts.saturating_sub(1) * (HEADER_LEN as u64 + 16);
                sealed_upper_bound(plain) + extra
            } else {
                plain
            }
        };
        est_deposit(
            stored(input.bytes, 1)
                + stored(push_fees::locator_bytes(input.objects), 1)
                + stored(history_bytes, u64::from(history_manifests)),
        )
    } else {
        0
    };
    PushQuote {
        metadata: push.metadata_credits + history_meta,
        chunks: push.chunk_credits + history_chunks,
        deposit,
        manifests: 2 + history_manifests,
        history_chunks_unpriced: platform && !input.counted() && input.history.is_none(),
    }
}

/// What `--bytes` / `--path` name: a size, a file's size, or a repository (a directory; the
/// current one when neither is given), whose objects are counted and whose history index is
/// computed, as a push computes it.
fn estimate_input(bytes: Option<u64>, path: Option<&std::path::Path>) -> Result<PushInput> {
    if let Some(b) = bytes {
        return Ok(PushInput::sized(human_bytes(b), b));
    }
    let dir = match path {
        Some(p) => p.to_path_buf(),
        None => std::env::current_dir().context("reading the current directory")?,
    };
    let meta = std::fs::metadata(&dir).with_context(|| format!("stat {}", dir.display()))?;
    if meta.is_file() {
        return Ok(PushInput::sized(
            format!("{} ({})", dir.display(), human_bytes(meta.len())),
            meta.len(),
        ));
    }
    let no_size = |why: &str| {
        crate::errors::usage(format!(
            "nothing to price: {} {why}; pass --bytes <N>, or --path <a repository or a file>",
            dir.display()
        ))
    };
    // A push sends the whole repository whatever directory it runs in: name its root.
    let Ok(root) = crate::git::git(&dir, &["rev-parse", "--show-toplevel"], &[]) else {
        return Err(no_size("is not a git repository (or has no working tree)"));
    };
    let dir = std::path::PathBuf::from(root);
    let Ok(tip_hex) = crate::git::git(
        &dir,
        &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        &[],
    ) else {
        return Err(no_size("has no commit to push yet"));
    };
    let tip = forge_core::pack::historyindex::parse_hex_oid(tip_hex.as_bytes())
        .map_err(|e| no_size(&format!("has a HEAD ({tip_hex}) this cannot price: {e}")))?;
    // The pack a first push of HEAD uploads, built as git builds it; else (git could not
    // build it) every object stored, loose and packed.
    let count = crate::git::ObjectCount::pack_of(&dir, &tip_hex)
        .or_else(|| crate::git::ObjectCount::of(&dir))
        .ok_or_else(|| {
            no_size("could not be measured (`git pack-objects` and `git count-objects` failed)")
        })?;
    // Local only, as `git push` computes it. Where it cannot be computed (a shallow clone) the
    // push publishes none, so none is priced; the reason is shown.
    let (history, history_skipped) = match prepare_history_index(&dir, tip, &HistoryPlan::fresh()) {
        Ok(p) => (p.map(|p| p.cost()), None),
        Err(e) => (None, Some(e.to_string())),
    };
    Ok(PushInput {
        what: format!(
            "the repository at {} (HEAD: {}, {} objects)",
            dir.display(),
            human_bytes(count.bytes),
            count.objects
        ),
        bytes: count.bytes,
        objects: count.objects,
        history,
        repo: Some(dir),
        sealed: false,
        history_skipped,
    })
}

/// A pre-write quote for a first push (`dg cost estimate`): what Platform bills for the pack,
/// its browse index and history index, and one ref update, on the chosen backend (else the
/// repository's own storage policy, else Platform). Only Platform storage pays for the bytes;
/// the rest bill the manifests and the ref.
fn estimate_cmd(
    ctx: &Ctx,
    backend: Option<Backend>,
    bytes: Option<u64>,
    path: Option<&std::path::Path>,
    private: bool,
) -> Result<()> {
    let input = PushInput {
        sealed: private,
        ..estimate_input(bytes, path)?
    };
    let target = match (backend, input.repo.as_deref()) {
        (Some(b), _) => Target::backend(b),
        (None, Some(dir)) => Target::repository(dir)?,
        (None, None) => Target::backend(Backend::Platform),
    };
    let q = quote(&target, &input);
    let price = ctx.usd_price();
    let label = target.label.as_str();
    // Objects only price the browse index's chunks, which only Platform storage pays for.
    let assumed = if input.counted() || q.chunks == 0 {
        String::new()
    } else {
        format!(" (~{} objects assumed)", input.objects)
    };
    let unpriced = "the history index's chunks: their size depends on the repository; `dg cost estimate --path <repository>` prices them";
    ctx.emit(
        json!({
            "mode": "first_push",
            "bytes": input.bytes,
            "objects": input.objects,
            "objectsCounted": input.counted(),
            "sealed": input.sealed,
            "backend": label,
            "platformStoresBytes": target.platform,
            "externalTargets": target.external,
            "manifests": q.manifests,
            "refUpdates": 1,
            "historyIndexBytes": input.history.map(|h| h.plain_len()),
            "historyIndexSkipped": input.history_skipped,
            "metadataCredits": q.metadata,
            "chunkCredits": q.chunks,
            "depositCredits": q.deposit,
            "totalCredits": q.total(),
            "cost": cost_json(q.total(), price),
            "storageDeposit": cost_json(q.deposit, price),
            "notPriced": q.history_chunks_unpriced.then_some(unpriced),
            "upperBound": !q.history_chunks_unpriced,
            "note": "every write is priced as the first of its kind, as `git push` quotes it; later pushes pay less",
        }),
        || {
            let private = if input.sealed { " (private: stored sealed)" } else { "" };
            println!("Estimate for a first push of {}{assumed} to {label}{private}:", input.what);
            let kind = if q.history_chunks_unpriced {
                "not counting the history index's chunks"
            } else {
                "an upper bound, as `git push` quotes it"
            };
            println!("  total:       {}  ({kind}; later pushes pay less)", cost_line(q.total(), price));
            println!(
                "  metadata:    {}  {} manifests + 1 ref update, on Platform",
                cost_line(q.metadata, price),
                q.manifests
            );
            if q.chunks > 0 {
                let what = if input.history.is_some() { "pack + browse index + history index" } else { "pack + browse index" };
                println!(
                    "  chunks:      {}  {what} on Platform; {} of it is the storage deposit, never refunded (Platform packs are permanent)",
                    cost_line(q.chunks, price),
                    cost_line(q.deposit, price)
                );
            }
            if target.external > 0 {
                let whose = if target.platform { "a copy also on your own storage" } else { "on your own storage" };
                println!("  pack bytes:  {whose} ({label}), billed by your provider, not by Platform");
            }
            if q.history_chunks_unpriced {
                println!("  not priced:  {unpriced}");
            }
            if let Some(why) = &input.history_skipped {
                println!("  no history index: `git push` would publish none here ({why}); `dg repo reindex` adds one later");
            }
        },
    );
    Ok(())
}

/// A cost audit. With a repo, tally its on-chain pack storage (locked deposit + prompt
/// refund). Without one, estimate an identity's total Forge spend from what it has proved to
/// have created (`forge_core::cost_audit`; there is no spend ledger on forge-v2).
async fn audit(
    ctx: &Ctx,
    identity: Option<&str>,
    since: Option<&str>,
    repo: Option<&str>,
) -> Result<()> {
    let price = ctx.usd_price();

    let Some(repo) = repo else {
        return identity_audit(ctx, identity, since, price).await;
    };

    // Live storage tally for a repo.
    // A read: a public repository's key is never opened (QW-034).
    let reader = crate::common::Reader::open(ctx, repo).await?;
    let handle = &reader.repo;
    // A failed read is an error, not an empty repository (QW2-021: it read as "0 packs").
    let manifests = reader
        .service()
        .read_pack_manifests(handle)
        .await
        .context("reading the repository's pack manifests")?;
    let tally = StorageTally::of(&manifests);

    ctx.emit(
        json!({
            "mode": "repo_storage_tally",
            "repoId": handle.id(),
            "packCount": manifests.len(),
            "packBytes": tally.platform.bytes + tally.external.bytes,
            "platformPacks": tally.platform.count,
            "platformBytes": tally.platform.bytes,
            "externalPacks": tally.external.count,
            "externalBytes": tally.external.bytes,
            "depositLocked": cost_json(tally.deposit_locked(), price),
        }),
        || {
            println!("Storage tally for {}:", handle.display());
            println!(
                "  packs:           {} ({} bytes)",
                manifests.len(),
                tally.platform.bytes + tally.external.bytes
            );
            println!(
                "  on Platform:     {} ({} bytes), deposit locked {}{}",
                tally.platform.count,
                tally.platform.bytes,
                cost_line(tally.deposit_locked(), price),
                if tally.platform.count > 0 {
                    " (packs are permanent: the deposit is not refundable)"
                } else {
                    ""
                }
            );
            if tally.external.count > 0 {
                println!(
                    "  elsewhere:       {} ({} bytes) off Platform (a bucket or IPFS, or a fork's parent), no Platform deposit",
                    tally.external.count, tally.external.bytes
                );
            }
        },
    );
    Ok(())
}

/// Packs and their bytes.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct Stored {
    count: usize,
    bytes: u64,
}

/// A repository's pack manifests split by where the bytes are: Platform `chunk` documents
/// (storage tier 0, which lock a deposit), or external storage (tier 1: a bucket, IPFS, or a
/// fork's reference to its parent's copies), which Platform holds no bytes of (QW2-021).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct StorageTally {
    platform: Stored,
    external: Stored,
}

impl StorageTally {
    fn of(manifests: &[forge_core::repo::PackManifestInfo]) -> Self {
        let mut t = Self::default();
        for m in manifests {
            let side = if m.storage == 0 && m.chunk_count > 0 {
                &mut t.platform
            } else {
                &mut t.external
            };
            side.count += 1;
            side.bytes += m.size_bytes;
        }
        t
    }

    /// The storage deposit Platform's chunks of these packs hold.
    fn deposit_locked(&self) -> u64 {
        est_deposit(self.platform.bytes)
    }
}

/// An identity-wide spend estimate: total, per document type, per repository. With neither
/// `--owner` nor a cached identity-id hint, this falls back to the signing identity
/// (`Ctx::signer_on`), which does open — and, if sealed, prompt to unseal — a key; the key is
/// used only to learn its id, never to sign anything, since this is a read-only audit (mirrors
/// `repo list`'s owner resolution, L-12).
async fn identity_audit(
    ctx: &Ctx,
    identity: Option<&str>,
    since: Option<&str>,
    price: Option<f64>,
) -> Result<()> {
    let client = ctx.connect().await?;
    let identity_id = match identity {
        Some(i) => forge_core::resolve::resolve_owner(&client, i)
            .await
            .with_context(|| format!("resolving identity {i}"))?,
        None => match ctx.identity_id_hint() {
            Some(id) => id,
            None => ctx.signer_on(&client).await?.1.id(),
        },
    };
    let since_ms = since.map(cost_audit::parse_since).transpose()?;

    let report = cost_audit::audit(&client, &identity_id, since_ms)
        .await
        .context("auditing spend")?;

    ctx.emit(audit_json(&report, price), || print_audit(&report, price));
    Ok(())
}

/// The `--json` payload for an identity spend [`AuditReport`].
fn audit_json(report: &AuditReport, price: Option<f64>) -> serde_json::Value {
    json!({
        "mode": "identity_spend_estimate",
        "identityId": report.identity_id,
        "sinceMs": report.since_ms,
        "documentCount": report.document_count,
        "totalCredits": report.total_credits,
        "cost": cost_json(report.total_credits, price),
        "byType": report.by_type.iter().map(|t| json!({
            "docType": t.doc_type,
            "count": t.count,
            "cost": cost_json(t.credits, price),
        })).collect::<Vec<_>>(),
        "byRepo": report.by_repo.iter().map(|r| json!({
            "repo": r.repo,
            "count": r.count,
            "cost": cost_json(r.credits, price),
        })).collect::<Vec<_>>(),
        "excludedTypes": report.excluded_types,
        "note": "an estimate from proved document counts x each type's flat create cost; forge-v2 keeps no spend ledger",
        "scopeNote": SCOPE_NOTE,
        "chunkGapNote": CHUNK_GAP_NOTE,
    })
}

/// The human-readable rendering of an identity spend [`AuditReport`].
fn print_audit(report: &AuditReport, price: Option<f64>) {
    println!("Spend estimate for {}:", report.identity_id);
    if let Some(since_ms) = report.since_ms {
        println!("  since:  {} UTC", format_utc(since_ms));
    }
    println!(
        "  total:  {} across {} document(s)",
        cost_line(report.total_credits, price),
        report.document_count
    );
    println!("\n  by document type:");
    for t in &report.by_type {
        println!(
            "    {:<20} {:>4}  {}",
            t.doc_type,
            t.count,
            cost_line(t.credits, price)
        );
    }
    println!("\n  by repository:");
    for r in &report.by_repo {
        println!(
            "    {:<46} {:>4}  {}",
            r.repo,
            r.count,
            cost_line(r.credits, price)
        );
    }
    if !report.excluded_types.is_empty() {
        println!(
            "\n  note: excludes {} (no proved query can attribute them to their author)",
            report.excluded_types.join(", ")
        );
    }
    println!("  note: {SCOPE_NOTE}");
    println!("  note: {CHUNK_GAP_NOTE}");
}

/// The repository-scope caveat every audit's output carries: which repositories it can find a
/// repo-scoped write in, and the one case it structurally cannot (see
/// `forge_core::cost_audit`'s module doc, `Auditor::repo_scope`).
const SCOPE_NOTE: &str = "covers every repo owned, filed an issue/patch to, or still a \
    maintainer/writer/CI-runner/private-repo-key-holder of; a membership revoked with no other \
    trace in that repo cannot be found by any proved query";

/// The `chunk`-counting caveat every audit's output carries: chunks are derived from each
/// owned `packManifest`'s `chunkCount`, not queried directly (see `forge_core::cost_audit`'s
/// module doc), so chunks written by an interrupted push or before a mid-push membership
/// revocation — with no live manifest to derive them from — are not counted here.
const CHUNK_GAP_NOTE: &str = "chunk counts come from each owned pack's own manifest; chunks \
    uploaded by a push that never finished with a manifest are not counted";

/// The refundable storage deposit for `bytes` (the deposit half of the estimate).
fn est_deposit(bytes: u64) -> u64 {
    estimate(bytes).deposit
}

/// `ms` (epoch milliseconds) as `YYYY-MM-DD HH:MM:SS`, so `--since` prints back as a date a
/// person gave it as, not the raw milliseconds `forge_core::cost_audit::parse_since` produced.
/// No `chrono` / `time` dependency: the importer's existing `unix_to_iso8601` (Howard
/// Hinnant's `civil_from_days`) does the calendar math.
fn format_utc(ms: u64) -> String {
    // `YYYY-MM-DDTHH:MM:SSZ` -> `YYYY-MM-DD HH:MM:SS`.
    forge_import::github::unix_to_iso8601(ms / 1000)
        .trim_end_matches('Z')
        .replacen('T', " ", 1)
}

#[cfg(test)]
mod estimate_tests {
    use super::*;
    use forge_core::cost::push_fees::{
        chunks, index_chunks, HISTORY_FIRST_EXTRA, MANIFEST_FIRST, REF_FIRST, URIS_PER_TARGET,
    };
    use forge_core::cost::CREDITS_PER_DASH;
    use std::path::Path;
    use std::process::Command;

    const MIB: u64 = 1 << 20;

    /// Charged on devnet bonsia (Platform 4.2.0-beta.7, 2026-09-30, cli-dx QA stream): a first
    /// push of a tiny repository with packs on your own storage (07-init.txt), and with packs
    /// on Platform (the highest seen: fixes/cli-cost/live-first-push-vs-quote.txt), history index
    /// included in both.
    const BONSIA_FIRST_PUSH_OWN_STORAGE: u64 = 521_149_000;
    const BONSIA_FIRST_PUSH_PLATFORM: u64 = 1_037_810_440;

    fn sized(bytes: u64) -> PushInput {
        PushInput::sized(format!("{bytes} bytes"), bytes)
    }

    /// Two pack manifests and two first history-index manifests, each with one target's URIs,
    /// and one ref update: all a push to your own storage writes on Platform.
    fn own_storage_metadata() -> u64 {
        2 * (MANIFEST_FIRST + URIS_PER_TARGET)
            + REF_FIRST
            + 2 * (MANIFEST_FIRST + HISTORY_FIRST_EXTRA + URIS_PER_TARGET)
    }

    /// QW-008: `--backend s3` quoted the Platform price (0.39 DASH for 1 MiB). S3 keeps the
    /// bytes: Platform bills the manifests and the ref update, whatever the size.
    #[test]
    fn s3_bills_only_the_manifests_and_the_ref() {
        for bytes in [0, 388, MIB, 256 * MIB] {
            let q = quote(&Target::backend(Backend::S3), &sized(bytes));
            assert_eq!(q.chunks, 0, "{bytes}");
            assert_eq!(q.deposit, 0, "{bytes}");
            assert!(!q.history_chunks_unpriced);
            assert_eq!(q.manifests, 4);
            assert_eq!(q.total(), own_storage_metadata(), "{bytes}");
        }
        let total = quote(&Target::backend(Backend::S3), &sized(MIB)).total();
        // ~0.0066 DASH: what `git push` quoted for the same push, above the 0.0052 it paid.
        assert!(total >= BONSIA_FIRST_PUSH_OWN_STORAGE, "{total}");
        assert!(total < CREDITS_PER_DASH / 100, "{total}");
        // A MiB on Platform costs ~75x more.
        assert!(50 * total < quote(&Target::backend(Backend::Platform), &sized(MIB)).total());
    }

    #[test]
    fn ipfs_and_https_price_like_s3() {
        for bytes in [388, MIB] {
            let s3 = quote(&Target::backend(Backend::S3), &sized(bytes));
            assert_eq!(quote(&Target::backend(Backend::Ipfs), &sized(bytes)), s3);
            assert_eq!(quote(&Target::backend(Backend::Https), &sized(bytes)), s3);
        }
    }

    /// Platform stores the pack and its browse index as chunks, on top of the metadata; the
    /// history index's chunks are unknown from a size alone and said to be left out.
    #[test]
    fn platform_bills_the_pack_and_its_index_as_chunks() {
        let input = sized(MIB);
        let q = quote(&Target::backend(Backend::Platform), &input);
        assert_eq!(input.objects, MIB / BYTES_PER_OBJECT);
        assert_eq!(q.chunks, chunks(MIB) + index_chunks(input.objects, false));
        assert_eq!(
            q.metadata,
            2 * MANIFEST_FIRST + REF_FIRST + 2 * (MANIFEST_FIRST + HISTORY_FIRST_EXTRA)
        );
        assert!(q.history_chunks_unpriced);
        // At least what the old quote said (it priced the pack's chunks alone).
        assert!(q.total() > 39_384_827_200, "{q:?}");
        assert!(q.deposit < q.chunks);
        // Mixed: the same chunks, plus the second target's URIs on each manifest.
        let mixed = quote(&Target::backend(Backend::Mixed), &input);
        assert_eq!(mixed.chunks, q.chunks);
        assert_eq!(mixed.metadata, q.metadata + 4 * URIS_PER_TARGET);
    }

    fn git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .current_dir(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@example.org"])
            .args([
                "-c",
                "commit.gpgsign=false",
                "-c",
                "init.defaultBranch=main",
            ])
            .args(args)
            .output()
            .expect("git")
            .status
            .success();
        assert!(ok, "git {args:?}");
    }

    /// A repository like the one bonsia's first pushes carried: three small files, one commit.
    fn tiny_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q"]);
        for (name, body) in [("README.md", "# qa\n"), ("a.txt", "a\n"), ("b.txt", "b\n")] {
            std::fs::write(dir.path().join(name), body).unwrap();
        }
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "-q", "-m", "first"]);
        dir
    }

    /// `--path <repository>` counts the objects and computes the history index, as a push does,
    /// so the quote covers what a first push of such a repository paid on bonsia. The old
    /// `--path .` priced the directory entry's own size (192 bytes, 0.0015 DASH for a push that
    /// cost 0.0101).
    #[test]
    fn a_repository_is_priced_as_its_first_push() {
        let repo = tiny_repo();
        let input = estimate_input(None, Some(repo.path())).unwrap();
        assert!(input.counted());
        assert_eq!(input.objects, 5, "{input:?}");
        // HEAD's objects as stored, not `count-objects`' 4 KiB disk blocks per loose object.
        assert!(input.bytes < 4096, "{input:?}");
        assert!(input.history.is_some(), "{input:?}");

        let platform = quote(&Target::backend(Backend::Platform), &input);
        assert!(!platform.history_chunks_unpriced);
        assert!(
            platform.total() >= BONSIA_FIRST_PUSH_PLATFORM,
            "{platform:?}"
        );
        // The history index's two chunks are in: more than the pack and browse index alone.
        let without = quote(
            &Target::backend(Backend::Platform),
            &PushInput {
                history: None,
                ..input.clone()
            },
        );
        assert!(platform.chunks > without.chunks);

        let s3 = quote(&Target::backend(Backend::S3), &input);
        assert_eq!(s3.chunks, 0);
        assert_eq!(s3.total(), own_storage_metadata());
        assert!(s3.total() >= BONSIA_FIRST_PUSH_OWN_STORAGE);
    }

    /// `--private` prices what a private repository's push stores: every artifact sealed, so
    /// its chunks and their deposit are larger; external storage still pays only metadata.
    #[test]
    fn a_private_repository_is_priced_sealed() {
        let repo = tiny_repo();
        let public = estimate_input(None, Some(repo.path())).unwrap();
        let private = PushInput {
            sealed: true,
            ..public.clone()
        };
        let platform = Target::backend(Backend::Platform);
        let (open, sealed) = (quote(&platform, &public), quote(&platform, &private));
        assert!(sealed.chunks > open.chunks, "{open:?} vs {sealed:?}");
        assert!(sealed.deposit > open.deposit, "{open:?} vs {sealed:?}");
        assert_eq!(sealed.metadata, open.metadata);
        // Recorded on moutai (forge_core::cost's calibration): a private 20 KiB first push paid
        // 1,123,943,560 credits; the sealed quote of 20 KiB of pack stays above it.
        let twenty = PushInput {
            sealed: true,
            ..sized(21_011)
        };
        assert!(quote(&platform, &twenty).total() >= 1_123_943_560);
        let s3 = Target::backend(Backend::S3);
        assert_eq!(quote(&s3, &private), quote(&s3, &public));
    }

    /// With no `--backend`, a repository is priced on the storage its own `git push` would use:
    /// Platform when `dash.storage` names none, and a malformed policy is an error, not a guess.
    #[test]
    fn a_repositorys_own_storage_policy_is_the_default_backend() {
        let repo = tiny_repo();
        git(repo.path(), &["config", "dash.storage", "platform"]);
        assert_eq!(
            Target::repository(repo.path()).unwrap(),
            Target::backend(Backend::Platform)
        );
        git(repo.path(), &["config", "dash.replicas", "many"]);
        let err = Target::repository(repo.path()).unwrap_err();
        assert!(err.to_string().contains("dash.replicas"), "{err}");
    }

    /// The forge remote's own `remote.<name>.dashStorage` wins over `dash.storage`, as it does
    /// for `git push` (a profile that does not exist would otherwise fail to resolve).
    #[test]
    fn the_forge_remotes_storage_overrides_the_repository_wide_one() {
        let repo = tiny_repo();
        git(
            repo.path(),
            &["config", "dash.storage", "no-such-profile-qw008"],
        );
        assert!(Target::repository(repo.path()).is_err());
        git(
            repo.path(),
            &["remote", "add", "origin", "dash://owner/name"],
        );
        git(
            repo.path(),
            &["config", "remote.origin.dashStorage", "platform"],
        );
        assert_eq!(
            Target::repository(repo.path()).unwrap(),
            Target::backend(Backend::Platform)
        );
    }

    /// A subdirectory prices the whole repository (a push sends all of it), named by its root.
    #[test]
    fn a_subdirectory_prices_its_repository() {
        let repo = tiny_repo();
        let sub = repo.path().join("src");
        std::fs::create_dir(&sub).unwrap();
        let input = estimate_input(None, Some(&sub)).unwrap();
        let root = std::fs::canonicalize(repo.path()).unwrap();
        assert_eq!(input.repo.as_deref(), Some(root.as_path()));
        assert_eq!(input.objects, 5);
    }

    /// A shallow clone's push publishes no history index, so none is priced, and the quote
    /// stays an upper bound (it said "not priced" and added two manifests before).
    #[test]
    fn a_repository_without_a_history_index_prices_none() {
        let origin = tiny_repo();
        std::fs::write(origin.path().join("c.txt"), "c\n").unwrap();
        git(origin.path(), &["add", "c.txt"]);
        git(origin.path(), &["commit", "-q", "-m", "second"]);
        let parent = tempfile::tempdir().unwrap();
        let url = format!("file://{}", origin.path().display());
        git(
            parent.path(),
            &["clone", "-q", "--depth", "1", &url, "shallow"],
        );
        let input = estimate_input(None, Some(&parent.path().join("shallow"))).unwrap();
        assert!(input.history.is_none(), "{input:?}");
        assert!(input.history_skipped.is_some(), "{input:?}");

        let s3 = quote(&Target::backend(Backend::S3), &input);
        assert_eq!(s3.manifests, 2);
        assert_eq!(
            s3.total(),
            2 * (MANIFEST_FIRST + URIS_PER_TARGET) + REF_FIRST
        );
        let platform = quote(&Target::backend(Backend::Platform), &input);
        assert!(!platform.history_chunks_unpriced);
    }

    /// The pack a first push sends is what git packs for HEAD: a second branch's objects stay
    /// out of it.
    #[test]
    fn a_repository_is_measured_by_heads_pack() {
        let repo = tiny_repo();
        git(repo.path(), &["checkout", "-q", "-b", "side"]);
        std::fs::write(repo.path().join("big.bin"), vec![7u8; 50_000]).unwrap();
        git(repo.path(), &["add", "big.bin"]);
        git(repo.path(), &["commit", "-q", "-m", "side"]);
        git(repo.path(), &["checkout", "-q", "main"]);
        let head = estimate_input(None, Some(repo.path())).unwrap();
        assert_eq!(head.objects, 5, "{head:?}");
        assert!(head.bytes < 4096, "{head:?}");
    }

    #[test]
    fn a_file_is_priced_by_its_size_and_a_plain_directory_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("pack.bin");
        std::fs::write(&file, vec![0u8; 5000]).unwrap();
        let input = estimate_input(None, Some(&file)).unwrap();
        assert_eq!((input.bytes, input.counted()), (5000, false));
        assert!(input.history.is_none());

        let err = estimate_input(None, Some(dir.path())).unwrap_err();
        assert!(err.to_string().contains("not a git repository"), "{err}");

        git(dir.path(), &["init", "-q"]);
        let err = estimate_input(None, Some(dir.path())).unwrap_err();
        assert!(err.to_string().contains("no commit"), "{err}");

        // --bytes wins without touching the filesystem.
        assert_eq!(estimate_input(Some(7), None).unwrap().bytes, 7);
    }

    /// QW-038: `dg cost prices` called its rows upper bounds, but a repository's first issue
    /// (120.9M credits on bonsia) paid more than the issue row (108.7M).
    #[test]
    fn the_price_table_covers_a_repositorys_first_issue() {
        let row = |op: &str| {
            price_table()
                .into_iter()
                .find(|(o, _)| o.starts_with(op))
                .unwrap()
                .1
        };
        assert!(row("issue") >= 120_878_000);
        assert!(row("comment") >= collab_doc_credits(CollabDoc::Comment, 500));
    }
}

#[cfg(test)]
mod tally_tests {
    use super::*;
    use forge_core::repo::PackManifestInfo;

    fn manifest(storage: u64, chunk_count: u64, size_bytes: u64) -> PackManifestInfo {
        PackManifestInfo {
            document_id: String::new(),
            created_at: 0,
            owner_id: String::new(),
            pack_hash: [0; 32],
            kind: 0,
            size_bytes,
            object_count: 1,
            chunk_count,
            storage,
            uris: Vec::new(),
            supersedes: Vec::new(),
            tips: Vec::new(),
            created_at_block_height: 0,
        }
    }

    /// QW2-021: four packs on your own storage (storage tier 1, no chunks) claimed a locked
    /// Platform deposit of ~0.00050814 DASH.
    #[test]
    fn packs_on_your_own_storage_lock_no_platform_deposit() {
        let external: Vec<_> = [388, 500, 600, 394].map(|b| manifest(1, 0, b)).into();
        let t = StorageTally::of(&external);
        assert_eq!(t.platform, Stored::default());
        assert_eq!(
            t.external,
            Stored {
                count: 4,
                bytes: 1882
            }
        );
        assert_eq!(t.deposit_locked(), 0);
    }

    /// Only Platform chunks hold a deposit, on their bytes alone.
    #[test]
    fn platform_packs_lock_a_deposit_on_their_bytes() {
        let mixed = [manifest(0, 1, 5000), manifest(1, 0, 9000)];
        let t = StorageTally::of(&mixed);
        assert_eq!(
            t.platform,
            Stored {
                count: 1,
                bytes: 5000
            }
        );
        assert_eq!(
            t.external,
            Stored {
                count: 1,
                bytes: 9000
            }
        );
        assert_eq!(t.deposit_locked(), est_deposit(5000));
    }
}

#[cfg(test)]
mod format_utc_tests {
    use super::format_utc;

    #[test]
    fn round_trips_known_dates() {
        // Same reference point cost_audit's own tests use.
        assert_eq!(format_utc(20_725 * 86_400_000), "2026-09-29 00:00:00");
        assert_eq!(format_utc(0), "1970-01-01 00:00:00");
    }

    #[test]
    fn keeps_the_time_of_day() {
        assert_eq!(
            format_utc(20_725 * 86_400_000 + 3_661_000),
            "2026-09-29 01:01:01"
        );
    }
}
