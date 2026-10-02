//! `dg cost audit` — an identity's estimated Forge spend, from what it has created.
//!
//! forge-v2 keeps no spend ledger: a document records who created it (`$ownerId`) and when
//! (`$createdAt`), never what it cost. So this is not a balance-change history (the web app's
//! `forge-web/lib/spend.ts` keeps one, but only in the browser that made the writes) — it is
//! `(proved document count) x (that document type's typical create cost on bonsia)` (see
//! `docs/guides/costs.md` for how it and the web app's ledger can diverge: a refund, a
//! first-of-its-kind write, or a browser that never saw a write at all).
//!
//! Which contract holds which type is never hard-coded here: [`crate::layout::ForgeContract`]
//! is the one place that answers that, and its own test cross-checks it against the generated
//! contract JSON, so this module cannot drift from RC1's core / collab / community split the
//! way an earlier, hand-maintained copy of that map once did.
//!
//! ## Coverage
//!
//! Every forge-v2 document type but one is attributed to its creator, by whichever proved
//! query reaches it:
//!
//! * **[`GLOBAL_TYPES`]** (`repo`, `issue`, `patch`, `comment`, `star`, `follow`, `starBeat`,
//!   `watch`, and `profile` handled alongside them) carry `$ownerId` as an index's leading
//!   field, so a single query across the whole network finds every one the target created.
//!   `starBeat` is one of [`crate::layout::OPTIONAL_TYPES`]: RC2's fused star (C1) drops it and
//!   the star itself carries the trending week, so a contract without it is audited without it
//!   and its stars are priced at the fused figure ([`FUSED_STAR_CREDITS`]). An optional type
//!   the loaded contract leaves out is skipped, never queried (QW4-001: querying `starBeat` on
//!   RC2 aborted the whole audit with E101); any other missing type is still an error, since
//!   skipping it would understate the total without a word.
//! * **[`REPO_OWNER_FILTERED_TYPES`]** (`refUpdate`, `protectedRefUpdate`, `packManifest`,
//!   `consent`) index `repoId` and `$ownerId` together, so each repository the target could
//!   plausibly have written to is queried with both as equality filters. `chunk` is not queried
//!   here (see below).
//! * **[`REPO_SCANNED_TYPES`]** (`maintainer`, `writer`, `config`, `release`, `label`,
//!   `repoKey`, `runner`, `topic`, `event`, `authorEvent`, `checkRun`, `policy`, `webhook`,
//!   `milestone`, `transition`) index `repoId` alone, so each such repository's complete set is
//!   read and filtered to the target's own by [`FetchedDocument::owner_id`] (present on every
//!   document regardless of its index).
//! * **`chunk`** is counted, not queried: it has no `$createdAt` of its own and is by far the
//!   largest and most numerous type (a full ~14.7 KB body each), so paging every chunk document
//!   just to count rows would be both undatable and wasteful. Every pack's chunks are written by
//!   the same push as its `packManifest`, so `Auditor::repo_scoped_pass` instead reads that
//!   manifest's own required `chunkCount` and `$createdAt` and folds that many chunks in via
//!   [`Totals::record_n`] — one proved read stands in for however many chunks the pack has, and
//!   `--since` can actually date them. This misses chunks with no live manifest to derive them
//!   from: an interrupted push that uploaded chunks before failing (`RepoService::put_pack_resumable`
//!   keeps them for a retry to reuse), or one where the target's membership was revoked between
//!   its chunks and its manifest. Those chunks were still paid for; this audit cannot see them,
//!   the same structural gap as the repository-scope one above, not a bug to be engineered
//!   around further.
//! * **`review`** is the one type left out entirely: its only index, `patch [patchId,
//!   $createdAt]`, carries neither `repoId` nor `$ownerId`, so no proved query can find "every
//!   review `target` wrote" — reaching them would mean reading every patch's reviews on the
//!   network. A review the target wrote is still lost from its own total for this reason, same
//!   as it would be from a from-scratch reconstruction of forge-web's local ledger.
//!
//! "Each repository the target could plausibly have written to" ([`Auditor::repo_scope`]) is
//! the union of: every repository a `issue` or `patch` [`GLOBAL_TYPES`] document named in its
//! `repoId` field (filing either needs no membership), the repositories the `repo` query itself
//! found (the target owns them), and every repository a `maintainer`, `writer`, `runner` or
//! `repoKey` document's `byMember` index says the target belongs to — a target can have a
//! repo-scoped footprint (an `authorEvent`, a `webhook`) through any of these without being a
//! formal member. `repoKey` is included because it is never deleted on removal (unlike
//! `maintainer` / `writer` / `runner`), so it is the one membership trace that survives a
//! revocation — but only for a private repository (the only kind that has one). A member
//! removed from a **public** repo, who never filed an issue/patch or registered a CI runner
//! there, leaves no trace any proved query can find; this audit cannot see that repo-scoped
//! history at all, and says so in its output rather than silently under-reporting with no hint.
//!
//! A document type with no `$createdAt` field at all (`watch`, `follow`, `profile`, and `star`
//! before RC2's fused star, which requires one) is never dropped by `--since`: [`Totals::record`]
//! only excludes a document it can actually date before the cutoff, not one it cannot date at
//! all.

use std::collections::{BTreeMap, BTreeSet};

use crate::cost::push_fees;
use crate::error::{Error, Result};
use crate::layout::ForgeContract;
use crate::platform::{self, FetchedDocument, FieldValue, PlatformClient, QueryFilter, QueryOrder};
use crate::resolve;
use crate::user_error::{codes, UserError};

/// The label forge-web's local ledger uses for credits with no associated repository
/// (`forge-web/lib/spend.ts`'s `NO_REPO`) — kept identical so the two tools read the same.
pub const NO_REPO: &str = "(no repo)";

/// Document types no proved query can attribute to their author (see the module doc).
pub const EXCLUDED_TYPES: &[&str] = &["review"];

/// One document type's totals in an [`AuditReport`].
#[derive(Debug, Clone)]
pub struct TypeTotal {
    /// The forge-core / forge-collab / forge-community document type name.
    pub doc_type: String,
    /// How many of `doc_type` the identity created (within `--since`, if given).
    pub count: u64,
    /// Their estimated total cost, in credits.
    pub credits: u64,
}

/// One repository's totals in an [`AuditReport`], or the [`NO_REPO`] bucket.
#[derive(Debug, Clone)]
pub struct RepoTotal {
    /// A repo's base58 `repo` document id, or [`NO_REPO`].
    pub repo: String,
    /// How many documents the identity created there (within `--since`, if given).
    pub count: u64,
    /// Their estimated total cost, in credits.
    pub credits: u64,
}

/// What an identity has (estimated to have) spent on Forge.
#[derive(Debug, Clone)]
pub struct AuditReport {
    /// The audited identity, base58.
    pub identity_id: String,
    /// The `--since` lower bound applied to `$createdAt`, in epoch ms, if any.
    pub since_ms: Option<u64>,
    /// Total documents counted (sum of every [`TypeTotal::count`]).
    pub document_count: u64,
    /// Total estimated credits (sum of every [`TypeTotal::credits`]).
    pub total_credits: u64,
    /// Per document type, highest cost first.
    pub by_type: Vec<TypeTotal>,
    /// Per repository (plus [`NO_REPO`]), highest cost first.
    pub by_repo: Vec<RepoTotal>,
    /// [`EXCLUDED_TYPES`], for a caller that wants to say what was left out.
    pub excluded_types: Vec<&'static str>,
}

/// The typical create cost of one `doc_type` document, in credits: what the same write paid on
/// devnet bonsia (Platform 4.2.0-beta.7, 2026-09-30, QA wave 2's balance deltas), between a
/// repository's first of its kind and a later one where both were seen. A flat per-type
/// figure, not a measurement of any one document: an unusually large one costs more than its
/// row says (`docs/guides/costs.md` has the measured ranges).
///
/// QW2-021: this table was forge-web's moutai steady-state bases (a `packManifest` at 60M, a
/// `refUpdate` at 45M), and an identity that had created and pushed one repository was
/// audited at 0.00417 DASH for the 0.00685 it paid.
fn base_credits(doc_type: &str) -> u64 {
    match doc_type {
        // Measured, bonsia (credits):
        // - a first repository (web, OB-7): repo 81.7M, maintainer 48.1M, config 35.5M; a
        //   runner enrolment 47.3M;
        // - a first push to your own storage: 521.1M for four manifests (pack, browse index,
        //   the history index's two parts) and a ref's first update; a later one 410M;
        // - a repository's first issue 118.7M-120.9M, its second 80.1M; pull requests
        //   130.1M-133.9M; a comment 65.0M; an issue close 74.1M; an approving review 49.6M;
        // - a first release with one asset 93.9M, an unpublish revision 70.4M;
        // - a check run's first report 122.1M, a second name's 81.6M;
        // - forge-community (web, N-17): star 19.4M, starBeat 19.8M, a repository's first
        //   watch 37.6M, follow 47.2M, consent 30.8M.
        // Events are priced at the importer's calibrated 58.4M (beta.6); labels, milestones and
        // policies were not measured on bonsia.
        "repo" => 82_000_000,
        "maintainer" | "writer" | "runner" => 48_000_000,
        "config" => 36_000_000,
        "packManifest" | "issue" | "checkRun" => 100_000_000,
        "refUpdate" | "protectedRefUpdate" => 80_000_000,
        "release" => 85_000_000,
        "patch" => 130_000_000,
        "comment" => 65_000_000,
        "transition" => 74_000_000,
        "review" => 50_000_000,
        "event" | "authorEvent" => 58_000_000,
        "label" | "milestone" | "follow" => 45_000_000,
        "policy" => 40_000_000,
        "star" | "starBeat" => 20_000_000,
        "watch" => 35_000_000,
        "consent" => 31_000_000,
        // A chunk priced alone (its manifest's size, when it has one, prices it exactly:
        // [`chunk_credits`]).
        "chunk" => push_fees::CHUNK_FLAT,
        // profile, webhook, topic, repoKey: no measured figure of their own yet.
        _ => DEFAULT_BASE_CREDITS,
    }
}

/// The fallback for a document type with no measured figure.
const DEFAULT_BASE_CREDITS: u64 = 50_000_000;

/// A fused star's create cost (RC2 C1: the star carries the trending window itself, so there is
/// no `starBeat` beside it): devnet sakura's registration fee probe priced one at 45.49M credits
/// (`forge-contracts/schema/build.py`'s `fused_star` note), against 55.09M there for a star
/// and its `starBeat`. A probe, not a measured balance change like the figures above, so
/// rounded up.
const FUSED_STAR_CREDITS: u64 = 46_000_000;

/// What one `doc_type` document is estimated to have cost: [`base_credits`], except a fused
/// star ([`FUSED_STAR_CREDITS`]), which pays for the trending window a separate `starBeat` used
/// to.
fn unit_credits(doc_type: &str, fused_star: bool) -> u64 {
    if doc_type == "star" && fused_star {
        FUSED_STAR_CREDITS
    } else {
        base_credits(doc_type)
    }
}

/// What a pack manifest's `chunkCount` chunks cost, from its `sizeBytes` when it records one
/// (`git push`'s calibrated chunk fees, `push_fees::chunks`: a full 14.7 KB chunk is ~0.0055
/// DASH, not the flat figure), else the flat figure per chunk.
fn chunk_credits(chunk_count: u64, size_bytes: Option<u64>) -> u64 {
    match size_bytes {
        Some(bytes) if bytes > 0 && chunk_count > 0 => push_fees::chunks(bytes),
        _ => base_credits("chunk") * chunk_count,
    }
}

/// One [`GLOBAL_TYPES`] or [`REPO_SCANNED_TYPES`] entry: a document type, the contract that
/// holds it, and the ascending order fields applied after that pass's equality filter(s) — the
/// index's remaining fields, in index order (matching `forge_core::resolve::list_owned`'s and
/// `MemberReader::list_roles`'s convention for a query that filters a prefix and orders the
/// rest, so the read pages completely and deterministically).
struct TypeQuery {
    doc_type: &'static str,
    contract: ForgeContract,
    order: &'static [&'static str],
}

/// `$ownerId`-indexed document types, complete (see the module doc); `order` follows the
/// `$ownerId` equality filter. `profile` is handled alongside these in [`Auditor::global_pass`]
/// rather than listed here, since its unique index has no remaining field to order by and so it
/// reads as a single bounded page, not a paged scan.
const GLOBAL_TYPES: &[TypeQuery] = &[
    TypeQuery {
        doc_type: resolve::DOC_REPO,
        contract: ForgeContract::Core,
        order: &["name"],
    },
    TypeQuery {
        doc_type: "issue",
        contract: ForgeContract::Collab,
        order: &["repoId", "number"],
    },
    TypeQuery {
        doc_type: "patch",
        contract: ForgeContract::Collab,
        order: &["repoId", "number"],
    },
    TypeQuery {
        doc_type: "comment",
        contract: ForgeContract::Collab,
        order: &["$createdAt"],
    },
    // `star` / `follow` / `starBeat` / `watch` index only `$ownerId` (`byOwner`): the
    // equality filter already consumes the whole index, so there is no remaining field to
    // order by. Ordering by the filtered field itself (rather than an empty order) matches
    // `Collab::patches_from_source`'s convention for this shape of query. All four are
    // forge-community types; `starBeat` only where the contract still has it (not RC2's fused
    // star — [`skipped`]).
    TypeQuery {
        doc_type: "star",
        contract: ForgeContract::Community,
        order: &["$ownerId"],
    },
    TypeQuery {
        doc_type: "follow",
        contract: ForgeContract::Community,
        order: &["$ownerId"],
    },
    TypeQuery {
        doc_type: "starBeat",
        contract: ForgeContract::Community,
        order: &["$ownerId"],
    },
    TypeQuery {
        doc_type: "watch",
        contract: ForgeContract::Community,
        order: &["$ownerId"],
    },
];

/// The membership types whose `byMember [memberId]` index says which repositories the target
/// belongs to ([`Auditor::repo_scope`]).
const MEMBERSHIP_TYPES: [(ForgeContract, &str); 4] = [
    (ForgeContract::Core, "maintainer"),
    (ForgeContract::Core, "writer"),
    (ForgeContract::Community, "runner"),
    (ForgeContract::Collab, "repoKey"),
];

/// Whether `doc_type` is left out of the audit on `contract`: one of the types a contract build
/// may drop ([`crate::layout::OPTIONAL_TYPES`]: `starBeat` under RC2's fused star) that this
/// one does. Querying it would be a protocol error that aborts the whole audit (QW4-001). Any
/// other type is always queried: a contract missing one is the wrong contract, which an error
/// says better than a silently smaller total.
fn skipped(contract: &platform::LoadedContract, doc_type: &str) -> bool {
    crate::layout::OPTIONAL_TYPES.contains(&doc_type) && !contract.has_document_type(doc_type)
}

/// A type reached with `repoId` and `$ownerId` both filtered server-side, once per repository
/// in [`Auditor::repo_scope`] (see the module doc). All on forge-core.
struct RepoOwnerFilteredType {
    doc_type: &'static str,
    /// Ascending order fields after the `repoId` + `$ownerId` equality filters.
    order: &'static [&'static str],
}

const REPO_OWNER_FILTERED_TYPES: &[RepoOwnerFilteredType] = &[
    RepoOwnerFilteredType {
        doc_type: "refUpdate",
        order: &["$createdAt"],
    },
    RepoOwnerFilteredType {
        doc_type: "protectedRefUpdate",
        order: &["$createdAt"],
    },
    RepoOwnerFilteredType {
        doc_type: "packManifest",
        order: &["packHash"],
    },
    // `chunk` is deliberately absent: see the module doc — its count is derived from each
    // `packManifest`'s own `chunkCount`, not queried as a document type here.
    // `consent`'s `byRepoOwner [repoId, $ownerId]` index is unique: both equality filters
    // together already identify at most one document, so there is no remaining field to order
    // by.
    RepoOwnerFilteredType {
        doc_type: "consent",
        order: &[],
    },
];

/// Types reached with only `repoId` filtered server-side (`order` follows it), once per
/// repository in [`Auditor::repo_scope`], then kept only where [`FetchedDocument::owner_id`] is
/// the target (see the module doc).
const REPO_SCANNED_TYPES: &[TypeQuery] = &[
    TypeQuery {
        doc_type: "maintainer",
        contract: ForgeContract::Core,
        order: &["memberId"],
    },
    TypeQuery {
        doc_type: "writer",
        contract: ForgeContract::Core,
        order: &["memberId"],
    },
    TypeQuery {
        doc_type: "config",
        contract: ForgeContract::Core,
        order: &["$createdAt"],
    },
    TypeQuery {
        doc_type: "release",
        contract: ForgeContract::Core,
        order: &["$createdAt"],
    },
    TypeQuery {
        doc_type: "label",
        contract: ForgeContract::Core,
        order: &["name", "$createdAt"],
    },
    TypeQuery {
        doc_type: "topic",
        contract: ForgeContract::Core,
        order: &["name"],
    },
    // RC1 moved `repoKey` into forge-collab.
    TypeQuery {
        doc_type: "repoKey",
        contract: ForgeContract::Collab,
        order: &["memberId", "epoch", "$ownerId"],
    },
    // `transition`'s `feed [repoId, $createdAt]` index has no `$ownerId` of its own, but every
    // document still carries the system `$ownerId` this scan filters by.
    TypeQuery {
        doc_type: "transition",
        contract: ForgeContract::Collab,
        order: &["$createdAt"],
    },
    // RC1 moved these six into forge-community.
    TypeQuery {
        doc_type: "runner",
        contract: ForgeContract::Community,
        order: &["memberId"],
    },
    TypeQuery {
        doc_type: "event",
        contract: ForgeContract::Community,
        order: &["$createdAt"],
    },
    TypeQuery {
        doc_type: "authorEvent",
        contract: ForgeContract::Community,
        order: &["$createdAt"],
    },
    TypeQuery {
        doc_type: "checkRun",
        contract: ForgeContract::Community,
        order: &["$createdAt"],
    },
    TypeQuery {
        doc_type: "policy",
        contract: ForgeContract::Community,
        order: &["$createdAt"],
    },
    TypeQuery {
        doc_type: "webhook",
        contract: ForgeContract::Community,
        order: &["$createdAt"],
    },
    TypeQuery {
        doc_type: "milestone",
        contract: ForgeContract::Community,
        order: &["title", "$createdAt"],
    },
];

fn order_of(fields: &[&'static str]) -> Vec<QueryOrder> {
    fields.iter().map(|f| QueryOrder::asc(*f)).collect()
}

/// The repository this document's cost is attributed to: `repo` itself (its own id), else its
/// `repoId` field, else [`NO_REPO`]. Only `profile` and `follow` truly name no repository at
/// all; `star`, `watch` and `starBeat` do carry a `repoId` and are bucketed to it like anything
/// else here.
fn repo_bucket_for(doc_type: &str, doc: &FetchedDocument) -> String {
    if doc_type == resolve::DOC_REPO {
        return doc.id.clone();
    }
    doc.field_bytes32("repoId")
        .map_or_else(|| NO_REPO.to_string(), platform::encode_identifier)
}

/// One running `(count, credits)` total in [`Totals`].
#[derive(Default)]
struct Tally {
    count: u64,
    credits: u64,
}

/// The running totals [`audit`] folds documents into, split out so `audit` itself stays a
/// short outline of the three passes (global, repo-scope discovery, repo-scoped).
#[derive(Default)]
struct Totals {
    /// The `--since` cutoff [`Totals::record`] applies, in epoch ms, if any.
    since_ms: Option<u64>,
    by_type: BTreeMap<&'static str, Tally>,
    by_repo: BTreeMap<String, Tally>,
}

impl Totals {
    fn new(since_ms: Option<u64>) -> Self {
        Self {
            since_ms,
            ..Self::default()
        }
    }

    /// Fold one document in, applying `since_ms` first. A document this audit cannot date (its
    /// type has no `$createdAt` — see the module doc) is never excluded by `--since`: only a
    /// document with a known creation time strictly before the cutoff is dropped.
    fn record(&mut self, doc_type: &'static str, doc: &FetchedDocument) {
        self.record_n(doc_type, 1, doc);
    }

    /// Fold `n` documents of `doc_type` in at once, all dated and bucketed like `doc`.
    /// [`Totals::record`] is `record_n(doc_type, 1, doc)`; `n` greater than one is used only for
    /// `chunk`, whose own documents are never queried directly (see the module doc and
    /// [`Auditor::repo_scoped_pass`]) — there, `doc` is the `packManifest` standing in for its
    /// chunks, so `since_ms` is applied against the manifest's own `$createdAt`. A no-op for
    /// `n == 0`.
    fn record_n(&mut self, doc_type: &'static str, n: u64, doc: &FetchedDocument) {
        self.record_priced(doc_type, n, base_credits(doc_type) * n, doc);
    }

    /// [`Totals::record_n`] with the `n` documents' `credits` given (a pack's chunks, priced
    /// by its size).
    fn record_priced(
        &mut self,
        doc_type: &'static str,
        n: u64,
        credits: u64,
        doc: &FetchedDocument,
    ) {
        if n == 0 {
            return;
        }
        if let (Some(since), Some(created_at)) = (self.since_ms, doc.created_at) {
            if created_at < since {
                return;
            }
        }
        let type_tally = self.by_type.entry(doc_type).or_default();
        type_tally.count += n;
        type_tally.credits += credits;
        let repo_tally = self
            .by_repo
            .entry(repo_bucket_for(doc_type, doc))
            .or_default();
        repo_tally.count += n;
        repo_tally.credits += credits;
    }

    fn document_count(&self) -> u64 {
        self.by_type.values().map(|t| t.count).sum()
    }

    fn total_credits(&self) -> u64 {
        self.by_type.values().map(|t| t.credits).sum()
    }

    /// The rows for an [`AuditReport`], highest cost first.
    fn into_sorted(self) -> (Vec<TypeTotal>, Vec<RepoTotal>) {
        let mut by_type: Vec<TypeTotal> = self
            .by_type
            .into_iter()
            .map(|(doc_type, Tally { count, credits })| TypeTotal {
                doc_type: doc_type.to_string(),
                count,
                credits,
            })
            .collect();
        by_type.sort_by(|a, b| {
            b.credits
                .cmp(&a.credits)
                .then_with(|| a.doc_type.cmp(&b.doc_type))
        });

        let mut by_repo: Vec<RepoTotal> = self
            .by_repo
            .into_iter()
            .map(|(repo, Tally { count, credits })| RepoTotal {
                repo,
                count,
                credits,
            })
            .collect();
        by_repo.sort_by(|a, b| b.credits.cmp(&a.credits).then_with(|| a.repo.cmp(&b.repo)));

        (by_type, by_repo)
    }
}

/// The three forge-v2 contracts and the identity being audited, bundled so the per-pass
/// methods below don't each thread client/core/collab/community/target through as separate
/// arguments (and so stay under clippy's `too_many_arguments`).
struct Auditor<'a> {
    client: &'a PlatformClient,
    core: platform::LoadedContract,
    collab: platform::LoadedContract,
    community: platform::LoadedContract,
    target: [u8; 32],
    identity_id: String,
    /// Whether forge-community is RC2's fused star (no `starBeat`; the star carries the week).
    fused_star: bool,
}

impl Auditor<'_> {
    /// Whether `doc_type` on the `sel` contract is left out ([`skipped`]).
    fn skips(&self, sel: ForgeContract, doc_type: &str) -> bool {
        skipped(self.contract(sel), doc_type)
    }

    fn contract(&self, sel: ForgeContract) -> &platform::LoadedContract {
        match sel {
            ForgeContract::Core => &self.core,
            ForgeContract::Collab => &self.collab,
            ForgeContract::Community => &self.community,
        }
    }

    /// An equality filter on `field` (`$ownerId`, `memberId`) against the audited identity.
    fn target_is(&self, field: &str) -> QueryFilter {
        QueryFilter::eq(field, FieldValue::identifier(self.target))
    }

    /// The [`GLOBAL_TYPES`] pass plus `profile`: every document a single `$ownerId`-led query
    /// reaches, folded into `totals`. Returns every repository the `repo` query found (the
    /// target owns them) plus every repository an `issue` or `patch` named in its `repoId`
    /// field (filing either needs no membership) — for [`Auditor::repo_scope`] to extend
    /// further. `star` / `watch` / `starBeat` / `comment` also carry a `repoId`, but are left
    /// out of scope discovery: they name a repository the target merely interacted with, not
    /// one it could have written a repo-scoped document to, and including them would page a
    /// starred repo's full `event` / `checkRun` / `transition` feeds for no reason.
    async fn global_pass(&self, totals: &mut Totals) -> Result<BTreeSet<[u8; 32]>> {
        let mut discovered_repos = BTreeSet::new();
        for g in GLOBAL_TYPES {
            if self.skips(g.contract, g.doc_type) {
                continue;
            }
            let docs = self
                .client
                .query_all_documents(
                    self.contract(g.contract),
                    g.doc_type,
                    &[self.target_is("$ownerId")],
                    &order_of(g.order),
                )
                .await?;
            if g.doc_type == resolve::DOC_REPO {
                discovered_repos.extend(
                    docs.iter()
                        .filter_map(|d| platform::decode_identifier(&d.id).ok()),
                );
            } else if matches!(g.doc_type, "issue" | "patch") {
                discovered_repos.extend(docs.iter().filter_map(|d| d.field_bytes32("repoId")));
            }
            let credits = unit_credits(g.doc_type, self.fused_star);
            for d in &docs {
                totals.record_priced(g.doc_type, 1, credits, d);
            }
        }

        // `profile`: its `owner [$ownerId]` index is unique, so at most one document ever
        // exists for the target — a single bounded page (`MemberReader`'s `membership_doc`
        // pattern), not a paged scan.
        let profile_docs = self
            .client
            .query_documents(
                &self.community,
                "profile",
                &[self.target_is("$ownerId")],
                &[],
                1,
                None,
            )
            .await?;
        for d in &profile_docs {
            totals.record("profile", d);
        }
        Ok(discovered_repos)
    }

    /// Every repository the target could plausibly have written a [`REPO_OWNER_FILTERED_TYPES`]
    /// or [`REPO_SCANNED_TYPES`] document to: `discovered` (repositories [`Auditor::global_pass`]
    /// already found, passed in so they are not queried twice) plus every repository a
    /// `maintainer`, `writer`, `runner` or `repoKey` document's `byMember` index says the target
    /// belongs to. A target need not be a formal member to have a repo-scoped footprint —
    /// filing an issue or being a registered CI runner is enough — so `discovered` and this
    /// `byMember` union are both necessary; neither alone is complete. `repoKey` is included
    /// because, unlike the other three, it is never deleted when a membership is revoked, so it
    /// is the one trace of a private repo's former member this audit can still find — a public
    /// repo has no `repoKey` at all, so a removed writer/maintainer/runner there who never filed
    /// an issue/patch is genuinely unreachable (the module doc says so).
    async fn repo_scope(&self, discovered: BTreeSet<[u8; 32]>) -> Result<BTreeSet<[u8; 32]>> {
        let mut scope = discovered;
        for (contract, doc_type) in MEMBERSHIP_TYPES {
            let docs = self
                .client
                .query_all_documents(
                    self.contract(contract),
                    doc_type,
                    &[self.target_is("memberId")],
                    &[QueryOrder::asc("memberId")],
                )
                .await?;
            scope.extend(docs.iter().filter_map(|d| d.field_bytes32("repoId")));
        }
        Ok(scope)
    }

    /// The [`REPO_OWNER_FILTERED_TYPES`] and [`REPO_SCANNED_TYPES`] passes for one repository,
    /// folded into `totals`.
    async fn repo_scoped_pass(&self, repo_id: [u8; 32], totals: &mut Totals) -> Result<()> {
        let in_repo = || QueryFilter::eq("repoId", FieldValue::identifier(repo_id));
        for t in REPO_OWNER_FILTERED_TYPES {
            if self.skips(ForgeContract::Core, t.doc_type) {
                continue;
            }
            let docs = self
                .client
                .query_all_documents(
                    &self.core,
                    t.doc_type,
                    &[in_repo(), self.target_is("$ownerId")],
                    &order_of(t.order),
                )
                .await?;
            for d in &docs {
                totals.record(t.doc_type, d);
            }
            if t.doc_type == "packManifest" {
                // See the module doc: a pack's chunks are the same push as its manifest, so
                // the manifest's own `chunkCount` (required) stands in for paging every
                // ~14.7 KB `chunk` body just to count rows, and its `$createdAt` lets `--since`
                // actually date them.
                for d in &docs {
                    let n = d.field_u64("chunkCount").unwrap_or(0);
                    let credits = chunk_credits(n, d.field_u64("sizeBytes"));
                    totals.record_priced("chunk", n, credits, d);
                }
            }
        }
        for t in REPO_SCANNED_TYPES {
            if self.skips(t.contract, t.doc_type) {
                continue;
            }
            let docs = self
                .client
                .query_all_documents(
                    self.contract(t.contract),
                    t.doc_type,
                    &[in_repo()],
                    &order_of(t.order),
                )
                .await?;
            for d in docs.iter().filter(|d| d.owner_id == self.identity_id) {
                totals.record(t.doc_type, d);
            }
        }
        Ok(())
    }
}

/// An estimated audit of everything `identity` has created on forge-v2, priced at each
/// document type's flat create cost (see the module doc). `since_ms`, when given, keeps only
/// documents created at or after it (epoch ms; see [`parse_since`]).
pub async fn audit(
    client: &PlatformClient,
    identity: &str,
    since_ms: Option<u64>,
) -> Result<AuditReport> {
    let target = platform::decode_identifier(identity)?;
    let forge = client.target().require_v2()?;
    let community = client.fetch_contract(&forge.community).await?;
    let auditor = Auditor {
        client,
        core: client.fetch_contract(&forge.core).await?,
        collab: client.fetch_contract(&forge.collab).await?,
        fused_star: crate::collab::v2::fused_star(&community),
        community,
        target,
        identity_id: platform::encode_identifier(target),
    };

    let mut totals = Totals::new(since_ms);
    let discovered_repos = auditor.global_pass(&mut totals).await?;
    let scope = auditor.repo_scope(discovered_repos).await?;
    for repo_id in scope {
        auditor.repo_scoped_pass(repo_id, &mut totals).await?;
    }

    let document_count = totals.document_count();
    let total_credits = totals.total_credits();
    let (by_type, by_repo) = totals.into_sorted();

    Ok(AuditReport {
        identity_id: auditor.identity_id,
        since_ms,
        document_count,
        total_credits,
        by_type,
        by_repo,
        excluded_types: EXCLUDED_TYPES.to_vec(),
    })
}

/// Interpret a `--since` value as an inclusive lower bound on `$createdAt`, in epoch
/// milliseconds. No `chrono` / `time` dependency: a relative duration is computed from
/// `SystemTime::now()`, and an absolute date from Howard Hinnant's `days_from_civil`.
///
/// Two forms:
/// * a relative duration: digits followed by one of `h` (hours), `d` (days), `w` (weeks) or
///   `y` (365-day years) — `"24h"`, `"7d"`, `"2w"`, `"1y"` — subtracted from now;
/// * an absolute UTC date, `YYYY-MM-DD` — that day's midnight UTC.
pub fn parse_since(input: &str) -> Result<u64> {
    let input = input.trim();
    if let Some(ms) = parse_absolute_date(input)? {
        return Ok(ms);
    }
    parse_relative_duration(input)
}

fn since_error(input: &str) -> Error {
    UserError::new(codes::USAGE, format!("invalid --since value {input:?}"))
        .fix("use a duration like `24h`, `7d`, `2w`, `1y`, or an absolute date `YYYY-MM-DD`")
        .into()
}

/// `input` as a `YYYY-MM-DD` date's midnight UTC in epoch ms, or `None` when it is not shaped
/// like one (so the caller falls back to [`parse_relative_duration`]).
fn parse_absolute_date(input: &str) -> Result<Option<u64>> {
    let bytes = input.as_bytes();
    let digits_at = |range: std::ops::Range<usize>| bytes[range].iter().all(u8::is_ascii_digit);
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !digits_at(0..4)
        || !digits_at(5..7)
        || !digits_at(8..10)
    {
        return Ok(None);
    }
    let year: i64 = input[0..4].parse().map_err(|_| since_error(input))?;
    let month: u32 = input[5..7].parse().map_err(|_| since_error(input))?;
    let day: u32 = input[8..10].parse().map_err(|_| since_error(input))?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err(since_error(input));
    }
    let days = days_from_civil(year, month, day);
    let ms: i64 = days
        .checked_mul(86_400_000)
        .ok_or_else(|| since_error(input))?;
    Ok(Some(u64::try_from(ms).map_err(|_| since_error(input))?))
}

/// Days since the Unix epoch (1970-01-01) for a Gregorian calendar date — Howard Hinnant's
/// `days_from_civil` (http://howardhinnant.github.io/date_algorithms.html#days_from_civil),
/// valid for every year representable by `i64` and not just those after 1970.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (i64::from(m) + 9) % 12; // [0, 11], March-based
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// `input` as a relative duration before now, in epoch ms.
fn parse_relative_duration(input: &str) -> Result<u64> {
    if input.is_empty() {
        return Err(since_error(input));
    }
    let (digits, unit) = input.split_at(input.len() - 1);
    let n: u64 = digits.parse().map_err(|_| since_error(input))?;
    let secs = match unit {
        "h" => n.checked_mul(3_600),
        "d" => n.checked_mul(86_400),
        "w" => n.checked_mul(7 * 86_400),
        "y" => n.checked_mul(365 * 86_400),
        _ => None,
    }
    .ok_or_else(|| since_error(input))?;
    let since_ms = secs.checked_mul(1000).ok_or_else(|| since_error(input))?;
    Ok(now_ms().saturating_sub(since_ms))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::{COLLAB_TYPES, COMMUNITY_TYPES, CORE_TYPES};

    #[test]
    fn base_credits_has_a_figure_for_every_forge_v2_type_and_a_fallback() {
        for doc_type in [
            "repo",
            "maintainer",
            "writer",
            "config",
            "release",
            "label",
            "refUpdate",
            "protectedRefUpdate",
            "packManifest",
            "chunk",
            "issue",
            "patch",
            "comment",
            "event",
            "authorEvent",
            "review",
            "policy",
            "star",
            "follow",
            "starBeat",
            "watch",
            "milestone",
            "checkRun",
        ] {
            assert!(base_credits(doc_type) > 0, "{doc_type} has no figure");
        }
        for doc_type in ["profile", "webhook", "topic", "repoKey"] {
            assert_eq!(
                base_credits(doc_type),
                DEFAULT_BASE_CREDITS,
                "{doc_type} should use the fallback"
            );
        }
    }

    /// Every real forge-v2 document type ([`CORE_TYPES`] / [`COLLAB_TYPES`] /
    /// [`COMMUNITY_TYPES`], the layout module's own test-verified map) must show up either in
    /// one of this module's three query tables (or the `profile` special case), or in
    /// [`EXCLUDED_TYPES`] with a documented reason — never silently uncounted. This is the test
    /// that would have caught RC1's core/collab/community split not being reflected here.
    #[test]
    fn every_forge_v2_type_is_audited_or_explicitly_excluded() {
        let mut covered: BTreeSet<&str> = BTreeSet::new();
        covered.extend(GLOBAL_TYPES.iter().map(|g| g.doc_type));
        covered.extend(REPO_OWNER_FILTERED_TYPES.iter().map(|t| t.doc_type));
        covered.extend(REPO_SCANNED_TYPES.iter().map(|t| t.doc_type));
        covered.insert("profile"); // special-cased in `Auditor::global_pass`.
        covered.insert("chunk"); // derived from packManifest.chunkCount, see the module doc.
        covered.extend(EXCLUDED_TYPES.iter().copied());

        for doc_type in CORE_TYPES
            .iter()
            .chain(COLLAB_TYPES.iter())
            .chain(COMMUNITY_TYPES.iter())
        {
            assert!(
                covered.contains(doc_type),
                "{doc_type} is neither audited nor in EXCLUDED_TYPES"
            );
        }
    }

    /// Every type in [`GLOBAL_TYPES`] / [`REPO_SCANNED_TYPES`] must name the contract
    /// [`ForgeContract::of`] (the layout module's test-verified map) actually says it lives in
    /// — this is the check that would have caught RC1's contract moves not being reflected
    /// here.
    #[test]
    fn every_table_entry_names_its_real_contract() {
        for g in GLOBAL_TYPES {
            assert_eq!(
                ForgeContract::of(g.doc_type),
                Some(g.contract),
                "{} is tagged for the wrong contract",
                g.doc_type
            );
        }
        for t in REPO_SCANNED_TYPES {
            assert_eq!(
                ForgeContract::of(t.doc_type),
                Some(t.contract),
                "{} is tagged for the wrong contract",
                t.doc_type
            );
        }
        // REPO_OWNER_FILTERED_TYPES has no `contract` field: every member must really be Core,
        // since `Auditor::repo_scoped_pass` always queries it against `self.core`.
        for t in REPO_OWNER_FILTERED_TYPES {
            assert_eq!(
                ForgeContract::of(t.doc_type),
                Some(ForgeContract::Core),
                "{} is queried against forge-core but does not live there",
                t.doc_type
            );
        }
    }

    /// No document type appears in more than one query table — each must be reached exactly
    /// one way, or attribution could double-count it.
    #[test]
    fn the_three_query_tables_are_mutually_disjoint() {
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        for doc_type in GLOBAL_TYPES
            .iter()
            .map(|g| g.doc_type)
            .chain(REPO_OWNER_FILTERED_TYPES.iter().map(|t| t.doc_type))
            .chain(REPO_SCANNED_TYPES.iter().map(|t| t.doc_type))
        {
            assert!(
                seen.insert(doc_type),
                "{doc_type} appears in more than one query table"
            );
        }
    }

    /// Every audited type is declared by the contract this checkout registers (the committed
    /// `forge-contracts/contracts` build, RC2 on sakura), or is one a build may leave out
    /// ([`crate::layout::OPTIONAL_TYPES`]) and the audit skips where it is absent. QW4-001: the
    /// fused star dropped `starBeat` and the audit still queried it, failing E101.
    #[test]
    fn every_audited_type_is_on_the_registered_contracts_or_optional() {
        use crate::layout::OPTIONAL_TYPES;
        use crate::test_support::rc1::loaded;
        let tables = GLOBAL_TYPES
            .iter()
            .chain(REPO_SCANNED_TYPES)
            .map(|t| (t.contract, t.doc_type))
            .chain(
                REPO_OWNER_FILTERED_TYPES
                    .iter()
                    .map(|t| (ForgeContract::Core, t.doc_type)),
            );
        for (contract, doc_type) in tables {
            assert!(
                loaded(contract).has_document_type(doc_type) || OPTIONAL_TYPES.contains(&doc_type),
                "{doc_type} is audited but {} doesn't declare it",
                contract.name()
            );
            // What the audit queries on the committed contracts: every type they declare, and
            // none they don't.
            assert_eq!(
                skipped(&loaded(contract), doc_type),
                !loaded(contract).has_document_type(doc_type),
                "{doc_type}"
            );
        }
    }

    /// Only an optional type is ever skipped: a contract missing any other type is the wrong
    /// contract, and its query fails rather than quietly lowering the total.
    #[test]
    fn only_an_optional_type_a_contract_leaves_out_is_skipped() {
        use crate::test_support::rc1::loaded;
        let community = loaded(ForgeContract::Community);
        assert!(!skipped(&community, "star"));
        assert_eq!(
            skipped(&community, "starBeat"),
            !community.has_document_type("starBeat")
        );
        // Not a forge-community type, and not optional: queried (and refused by the node).
        assert!(!skipped(&community, "maintainer"));
        assert!(!skipped(&community, "noSuchType"));
    }

    /// Every query this audit sends is served by an index of the committed contracts: its
    /// equality filters then its order fields are a prefix of some index's properties. A
    /// query no index serves fails at the node, aborting the audit like QW4-001 did.
    #[test]
    fn every_audit_query_matches_an_index_on_the_registered_contracts() {
        fn schemas(contract: ForgeContract) -> serde_json::Value {
            let json = match contract {
                ForgeContract::Core => {
                    include_str!("../../../forge-contracts/contracts/forge-core.json")
                }
                ForgeContract::Collab => {
                    include_str!("../../../forge-contracts/contracts/forge-collab.json")
                }
                ForgeContract::Community => {
                    include_str!("../../../forge-contracts/contracts/forge-community.json")
                }
            };
            serde_json::from_str::<serde_json::Value>(json).unwrap()["documentSchemas"].clone()
        }
        fn served(contract: ForgeContract, doc_type: &str, filters: &[&str], order: &[&str]) {
            let schemas = schemas(contract);
            let Some(schema) = schemas.get(doc_type) else {
                assert!(crate::layout::OPTIONAL_TYPES.contains(&doc_type));
                return;
            };
            // An order on the (only) filtered field itself adds nothing (`star` and friends).
            let mut wanted: Vec<&str> = filters.to_vec();
            wanted.extend(order.iter().filter(|o| !filters.contains(o)));
            let ok = schema["indices"].as_array().unwrap().iter().any(|i| {
                let props: Vec<&str> = i["properties"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| p.as_object().unwrap().keys().next().unwrap().as_str())
                    .collect();
                props.starts_with(&wanted)
            });
            assert!(ok, "no {doc_type} index serves {wanted:?}");
        }
        for g in GLOBAL_TYPES {
            served(g.contract, g.doc_type, &["$ownerId"], g.order);
        }
        served(ForgeContract::Community, "profile", &["$ownerId"], &[]);
        for (contract, doc_type) in MEMBERSHIP_TYPES {
            served(contract, doc_type, &["memberId"], &[]);
        }
        for t in REPO_OWNER_FILTERED_TYPES {
            served(
                ForgeContract::Core,
                t.doc_type,
                &["repoId", "$ownerId"],
                t.order,
            );
        }
        for t in REPO_SCANNED_TYPES {
            served(t.contract, t.doc_type, &["repoId"], t.order);
        }
    }

    #[test]
    fn a_fused_star_is_priced_with_its_trending_window() {
        assert_eq!(unit_credits("star", true), FUSED_STAR_CREDITS);
        assert_eq!(unit_credits("star", false), base_credits("star"));
        // A fused star pays for the trending window too, so it costs more than a bare star.
        assert!(FUSED_STAR_CREDITS > base_credits("star"));
        assert_eq!(unit_credits("follow", true), base_credits("follow"));
    }

    /// `chunk` must stay out of every query table: it is deliberately derived from each owned
    /// `packManifest`'s `chunkCount` ([`Auditor::repo_scoped_pass`]), never queried as a
    /// document type in its own right. Re-adding it to any table would double-count every
    /// chunk (once queried, once derived) without the disjointness test above catching it,
    /// since `chunk` does not appear in a second table today.
    #[test]
    fn chunk_is_never_a_query_table_entry() {
        assert!(!GLOBAL_TYPES.iter().any(|g| g.doc_type == "chunk"));
        assert!(!REPO_OWNER_FILTERED_TYPES
            .iter()
            .any(|t| t.doc_type == "chunk"));
        assert!(!REPO_SCANNED_TYPES.iter().any(|t| t.doc_type == "chunk"));
    }

    #[test]
    fn relative_durations_go_back_from_now() {
        let now = now_ms();
        let day = parse_since("1d").unwrap();
        assert!(day <= now, "1d ago must not be in the future");
        assert!(
            now - day >= 86_400_000 - 1000,
            "1d ago should be ~1 day back"
        );
        let hour = parse_since("24h").unwrap();
        // 24h and 1d land within a second of each other (test wall-clock jitter aside).
        assert!(day.abs_diff(hour) < 2000);
    }

    #[test]
    fn relative_duration_units_are_h_d_w_y_only() {
        for bad in ["7m", "7", "d7", "", "-1d", "1.5d"] {
            assert!(parse_since(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn absolute_dates_parse_as_midnight_utc() {
        // 2026-09-29 UTC midnight, computed independently: days since epoch * 86_400_000.
        // days_from_civil(2026, 9, 29) = 20725 (cross-checked against Python's
        // `date(2026, 9, 29) - date(1970, 1, 1)`).
        assert_eq!(parse_since("2026-09-29").unwrap(), 20_725 * 86_400_000);
        // The epoch itself.
        assert_eq!(parse_since("1970-01-01").unwrap(), 0);
    }

    #[test]
    fn days_from_civil_matches_known_reference_points() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(1969, 12, 31), -1);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
        assert_eq!(days_from_civil(2026, 9, 29), 20_725);
    }

    #[test]
    fn absolute_dates_reject_bad_calendar_values() {
        for bad in ["2026-13-01", "2026-00-01", "2026-01-32", "2026-01-00"] {
            assert!(parse_since(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn not_date_shaped_falls_back_to_a_relative_duration() {
        // 10 characters but not `YYYY-MM-DD` (dashes in the wrong places): read as a
        // (nonsensical, and so refused) relative duration instead of silently misparsing.
        assert!(parse_since("2026/09/29").is_err());
    }

    fn fieldless_doc() -> FetchedDocument {
        FetchedDocument {
            id: "9cBMULwtQUMtxhBkgaTKb4tJtoczd8TEQ8gmiroDWf4F".to_string(),
            owner_id: "9cBMULwtQUMtxhBkgaTKb4tJtoczd8TEQ8gmiroDWf4F".to_string(),
            created_at: Some(0),
            created_at_block_height: None,
            updated_at_block_height: None,
            fields: BTreeMap::new(),
            revision: None,
        }
    }

    #[test]
    fn repo_bucket_uses_the_repo_documents_own_id_not_a_repoid_field() {
        let doc = fieldless_doc();
        assert_eq!(repo_bucket_for(resolve::DOC_REPO, &doc), doc.id);
    }

    #[test]
    fn repo_bucket_falls_back_to_no_repo_without_a_repoid_field() {
        let doc = fieldless_doc();
        assert_eq!(repo_bucket_for("profile", &doc), NO_REPO);
        assert_eq!(repo_bucket_for("follow", &doc), NO_REPO);
    }

    #[test]
    fn undatable_documents_are_never_dropped_by_since() {
        // No $createdAt at all (the type-level case `star` / `watch` / `follow` / `profile`
        // are all in — `chunk` no longer is, since it is now dated via its packManifest, see
        // `record_n_dates_by_the_manifest_it_is_derived_from`): `record` must not drop it even
        // though `created_at` is `None` and a `since` filter is active.
        let mut doc = fieldless_doc();
        doc.created_at = None;
        let mut totals = Totals::new(Some(u64::MAX));
        totals.record("star", &doc);
        assert_eq!(
            totals.document_count(),
            1,
            "an undatable document must be kept"
        );
    }

    #[test]
    fn datable_documents_before_since_are_dropped() {
        let mut doc = fieldless_doc();
        doc.created_at = Some(100);
        let mut totals = Totals::new(Some(200));
        totals.record("comment", &doc);
        assert_eq!(
            totals.document_count(),
            0,
            "a document before --since must be dropped"
        );
    }

    #[test]
    fn record_n_folds_in_n_documents_at_once_dated_and_bucketed_by_the_manifest() {
        let mut manifest = fieldless_doc();
        manifest.created_at = Some(500);
        manifest
            .fields
            .insert("repoId".to_string(), FieldValue::Identifier([7u8; 32]));
        let mut totals = Totals::new(Some(100));
        totals.record_n("chunk", 12, &manifest);
        assert_eq!(totals.document_count(), 12);
        assert_eq!(totals.total_credits(), base_credits("chunk") * 12);
        let (by_type, by_repo) = totals.into_sorted();
        assert_eq!(by_type[0].count, 12);
        assert_eq!(by_repo[0].repo, platform::encode_identifier([7u8; 32]));
        assert_eq!(by_repo[0].count, 12);
    }

    #[test]
    fn record_n_drops_the_whole_count_when_the_manifest_predates_since() {
        let mut manifest = fieldless_doc();
        manifest.created_at = Some(50);
        let mut totals = Totals::new(Some(100));
        totals.record_n("chunk", 12, &manifest);
        assert_eq!(
            totals.document_count(),
            0,
            "a manifest before --since must drop all of its chunks"
        );
    }

    /// QW2-021: an identity that created one repository and pushed it once to its own storage
    /// (repo, maintainer, config, four manifests, one ref update) paid 0.00685 DASH on bonsia,
    /// and was audited at 0.00417 (-39 %).
    #[test]
    fn a_created_and_pushed_repository_is_audited_near_its_charge() {
        let audited: u64 = ["repo", "maintainer", "config", "refUpdate"]
            .iter()
            .map(|t| base_credits(t))
            .sum::<u64>()
            + 4 * base_credits("packManifest");
        let paid = 685_000_000_u64;
        assert!(
            audited.abs_diff(paid) * 100 / paid <= 15,
            "{audited} vs {paid}"
        );
    }

    /// A pack's chunks are priced by its size, as `git push` prices them: a full chunk is far
    /// above the flat figure, and a manifest without a size falls back to it.
    #[test]
    fn chunks_are_priced_by_their_packs_size() {
        let full = crate::pack::DOC_PAYLOAD_MAX as u64;
        assert_eq!(
            chunk_credits(2, Some(2 * full)),
            push_fees::chunks(2 * full)
        );
        assert!(chunk_credits(1, Some(full)) > 3 * base_credits("chunk"));
        assert_eq!(chunk_credits(3, None), 3 * base_credits("chunk"));
        assert_eq!(chunk_credits(0, Some(100)), 0);
    }

    #[test]
    fn record_n_is_a_noop_for_zero_chunks() {
        let mut totals = Totals::new(None);
        totals.record_n("chunk", 0, &fieldless_doc());
        assert_eq!(totals.document_count(), 0);
    }
}
