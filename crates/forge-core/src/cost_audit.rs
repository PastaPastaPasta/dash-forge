//! `dg cost audit` — an identity's estimated Forge spend, from what it has created.
//!
//! forge-v2 keeps no spend ledger: a document records who created it (`$ownerId`) and when
//! (`$createdAt`), never what it cost. So this is not a balance-change history (the web app's
//! `forge-web/lib/spend.ts` keeps one, but only in the browser that made the writes) — it is
//! `(proved document count) x (that document type's flat create cost)`, the same estimate
//! shape as forge-web's `BASE_CREDITS` table (see `docs/guides/costs.md` for how the two can
//! diverge: a refund, a first-of-its-kind write, or a browser that never saw a write at all).
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
//! A document type with no `$createdAt` field at all (`star`, `watch`, `follow`, `profile`) is
//! never dropped by `--since`: [`Totals::record`] only excludes a document it can actually date
//! before the cutoff, not one it cannot date at all.

use std::collections::{BTreeMap, BTreeSet};

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

/// The estimated create cost of one `doc_type` document, in credits — forge-web's
/// `BASE_CREDITS` table (`forge-web/lib/spend.ts`), so the CLI and the web app agree. A flat
/// per-type figure, not a measurement of any one document: a first-of-its-kind write (a
/// repo's first push, an index's first fill) or an unusually large one costs more than its
/// row here says (`docs/guides/costs.md` has the measured ranges).
fn base_credits(doc_type: &str) -> u64 {
    match doc_type {
        "repo" => 56_500_000,
        "maintainer" | "writer" => 40_000_000,
        "config" => 35_500_000,
        "release" => 53_300_000,
        "label" | "refUpdate" | "protectedRefUpdate" | "milestone" | "checkRun" => 45_000_000,
        "packManifest" => 60_000_000,
        "chunk" => 140_000_000,
        "issue" => 59_000_000,
        "patch" => 72_000_000,
        "comment" => 52_000_000,
        "event" => 43_000_000,
        "authorEvent" => 41_500_000,
        "review" => 35_900_000,
        "policy" => 34_000_000,
        "star" => 18_000_000,
        "follow" => 28_300_000,
        "starBeat" => 15_300_000,
        "watch" => 27_400_000,
        // profile, webhook, runner, topic, repoKey, consent, transition: no measured figure of
        // their own yet, so forge-web falls back to a round default and so do we.
        _ => DEFAULT_BASE_CREDITS,
    }
}

/// forge-web's fallback for a document type it has no measured figure for.
const DEFAULT_BASE_CREDITS: u64 = 50_000_000;

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
    // forge-community types.
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
        if n == 0 {
            return;
        }
        if let (Some(since), Some(created_at)) = (self.since_ms, doc.created_at) {
            if created_at < since {
                return;
            }
        }
        let credits = base_credits(doc_type) * n;
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
}

impl Auditor<'_> {
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
            for d in &docs {
                totals.record(g.doc_type, d);
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
        for (contract, doc_type) in [
            (&self.core, "maintainer"),
            (&self.core, "writer"),
            (&self.community, "runner"),
            (&self.collab, "repoKey"),
        ] {
            let docs = self
                .client
                .query_all_documents(
                    contract,
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
                    totals.record_n("chunk", d.field_u64("chunkCount").unwrap_or(0), d);
                }
            }
        }
        for t in REPO_SCANNED_TYPES {
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
    let auditor = Auditor {
        client,
        core: client.fetch_contract(&forge.core).await?,
        collab: client.fetch_contract(&forge.collab).await?,
        community: client.fetch_contract(&forge.community).await?,
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
        for doc_type in [
            "profile",
            "webhook",
            "runner",
            "topic",
            "repoKey",
            "consent",
            "transition",
        ] {
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

    #[test]
    fn record_n_is_a_noop_for_zero_chunks() {
        let mut totals = Totals::new(None);
        totals.record_n("chunk", 0, &fieldless_doc());
        assert_eq!(totals.document_count(), 0);
    }
}
