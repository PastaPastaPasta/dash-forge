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
//!   `chunk`, `consent`) index `repoId` and `$ownerId` together, so each repository the target
//!   could plausibly have written to is queried with both as equality filters.
//! * **[`REPO_SCANNED_TYPES`]** (`maintainer`, `writer`, `config`, `release`, `label`,
//!   `repoKey`, `runner`, `topic`, `event`, `authorEvent`, `checkRun`, `policy`, `webhook`,
//!   `milestone`, `transition`) index `repoId` alone, so each such repository's complete set is
//!   read and filtered to the target's own by [`FetchedDocument::owner_id`] (present on every
//!   document regardless of its index).
//! * **`review`** is the one type left out: its only index, `patch [patchId, $createdAt]`,
//!   carries neither `repoId` nor `$ownerId`, so no proved query can find "every review
//!   `target` wrote" — reaching them would mean reading every patch's reviews on the network.
//!   A review the target wrote is still lost from its own total for this reason, same as it
//!   would be from a from-scratch reconstruction of forge-web's local ledger.
//!
//! "Each repository the target could plausibly have written to" ([`Auditor::repo_scope`]) is
//! the union of: every repository a [`GLOBAL_TYPES`] document named in its `repoId` field
//! (an `issue` or `patch` the target filed needs no membership), the repositories the `repo`
//! query itself found (the target owns them), and every repository a `maintainer`, `writer` or
//! `runner` document's `byMember` index says the target belongs to — a target can have a
//! repo-scoped footprint (an `authorEvent`, a `webhook`) through any of these without being a
//! formal member.
//!
//! A document type with no `$createdAt` field at all (`chunk`, `star`, `watch`, `follow`,
//! `profile`) is never dropped by `--since`: [`Totals::record`] only excludes a document it can
//! actually date before the cutoff, not one it cannot date at all.

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

/// A type reached by one `$ownerId`-led query across the whole network (see the module doc).
struct GlobalType {
    doc_type: &'static str,
    contract: ForgeContract,
    /// Ascending order fields applied after the `$ownerId` equality filter — the index's
    /// remaining fields, in index order (matching `forge_core::resolve::list_owned`'s and
    /// `MemberReader::list_roles`'s convention for a query that filters a prefix and orders
    /// the rest, so the read pages completely and deterministically).
    order: &'static [&'static str],
}

/// `$ownerId`-indexed document types, complete (see the module doc). `profile` is handled
/// alongside these in [`Auditor::global_pass`] rather than listed here, since its unique index
/// has no remaining field to order by and so it reads as a single bounded page, not a paged
/// scan.
const GLOBAL_TYPES: &[GlobalType] = &[
    GlobalType {
        doc_type: resolve::DOC_REPO,
        contract: ForgeContract::Core,
        order: &["name"],
    },
    GlobalType {
        doc_type: "issue",
        contract: ForgeContract::Collab,
        order: &["repoId", "number"],
    },
    GlobalType {
        doc_type: "patch",
        contract: ForgeContract::Collab,
        order: &["repoId", "number"],
    },
    GlobalType {
        doc_type: "comment",
        contract: ForgeContract::Collab,
        order: &["$createdAt"],
    },
    // `star` / `follow` / `starBeat` / `watch` index only `$ownerId` (`byOwner`): the
    // equality filter already consumes the whole index, so there is no remaining field to
    // order by. Ordering by the filtered field itself (rather than an empty order) matches
    // `Collab::patches_from_source`'s convention for this shape of query. All four are
    // forge-community types.
    GlobalType {
        doc_type: "star",
        contract: ForgeContract::Community,
        order: &["$ownerId"],
    },
    GlobalType {
        doc_type: "follow",
        contract: ForgeContract::Community,
        order: &["$ownerId"],
    },
    GlobalType {
        doc_type: "starBeat",
        contract: ForgeContract::Community,
        order: &["$ownerId"],
    },
    GlobalType {
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
    RepoOwnerFilteredType {
        doc_type: "chunk",
        order: &["packHash", "seq"],
    },
    // `consent`'s `byRepoOwner [repoId, $ownerId]` index is unique: both equality filters
    // together already identify at most one document, so there is no remaining field to order
    // by.
    RepoOwnerFilteredType {
        doc_type: "consent",
        order: &[],
    },
];

/// A type reached with only `repoId` filtered server-side, once per repository in
/// [`Auditor::repo_scope`], then kept only where [`FetchedDocument::owner_id`] is the target
/// (see the module doc).
struct RepoScannedType {
    doc_type: &'static str,
    contract: ForgeContract,
    /// Ascending order fields after the `repoId` equality filter.
    order: &'static [&'static str],
}

const REPO_SCANNED_TYPES: &[RepoScannedType] = &[
    RepoScannedType {
        doc_type: "maintainer",
        contract: ForgeContract::Core,
        order: &["memberId"],
    },
    RepoScannedType {
        doc_type: "writer",
        contract: ForgeContract::Core,
        order: &["memberId"],
    },
    RepoScannedType {
        doc_type: "config",
        contract: ForgeContract::Core,
        order: &["$createdAt"],
    },
    RepoScannedType {
        doc_type: "release",
        contract: ForgeContract::Core,
        order: &["$createdAt"],
    },
    RepoScannedType {
        doc_type: "label",
        contract: ForgeContract::Core,
        order: &["name", "$createdAt"],
    },
    RepoScannedType {
        doc_type: "topic",
        contract: ForgeContract::Core,
        order: &["name"],
    },
    // RC1 moved `repoKey` into forge-collab.
    RepoScannedType {
        doc_type: "repoKey",
        contract: ForgeContract::Collab,
        order: &["memberId", "epoch", "$ownerId"],
    },
    // `transition`'s `feed [repoId, $createdAt]` index has no `$ownerId` of its own, but every
    // document still carries the system `$ownerId` this scan filters by.
    RepoScannedType {
        doc_type: "transition",
        contract: ForgeContract::Collab,
        order: &["$createdAt"],
    },
    // RC1 moved these six into forge-community.
    RepoScannedType {
        doc_type: "runner",
        contract: ForgeContract::Community,
        order: &["memberId"],
    },
    RepoScannedType {
        doc_type: "event",
        contract: ForgeContract::Community,
        order: &["$createdAt"],
    },
    RepoScannedType {
        doc_type: "authorEvent",
        contract: ForgeContract::Community,
        order: &["$createdAt"],
    },
    RepoScannedType {
        doc_type: "checkRun",
        contract: ForgeContract::Community,
        order: &["$createdAt"],
    },
    RepoScannedType {
        doc_type: "policy",
        contract: ForgeContract::Community,
        order: &["$createdAt"],
    },
    RepoScannedType {
        doc_type: "webhook",
        contract: ForgeContract::Community,
        order: &["$createdAt"],
    },
    RepoScannedType {
        doc_type: "milestone",
        contract: ForgeContract::Community,
        order: &["title", "$createdAt"],
    },
];

fn order_of(fields: &[&'static str]) -> Vec<QueryOrder> {
    fields.iter().map(|f| QueryOrder::asc(*f)).collect()
}

/// The repository this document's cost is attributed to: `repo` itself (its own id), else its
/// `repoId` field, else [`NO_REPO`] (`profile`, `follow`, `star`, `watch`, `starBeat`: none
/// names a repository the way this report buckets by).
fn repo_bucket_for(doc_type: &str, doc: &FetchedDocument) -> String {
    if doc_type == resolve::DOC_REPO {
        return doc.id.clone();
    }
    doc.field_bytes32("repoId")
        .map_or_else(|| NO_REPO.to_string(), platform::encode_identifier)
}

/// The running totals [`audit`] folds documents into, split out so `audit` itself stays a
/// short outline of the three passes (global, repo-scope discovery, repo-scoped).
#[derive(Default)]
struct Totals {
    by_type: BTreeMap<&'static str, (u64, u64)>,
    by_repo: BTreeMap<String, (u64, u64)>,
}

impl Totals {
    /// Fold one document in, applying `since_ms` first. A document this audit cannot date (its
    /// type has no `$createdAt` — see the module doc) is never excluded by `--since`: only a
    /// document with a known creation time strictly before the cutoff is dropped.
    fn record(&mut self, doc_type: &'static str, doc: &FetchedDocument, since_ms: Option<u64>) {
        if let (Some(since), Some(created_at)) = (since_ms, doc.created_at) {
            if created_at < since {
                return;
            }
        }
        let credits = base_credits(doc_type);
        let t = self.by_type.entry(doc_type).or_insert((0, 0));
        t.0 += 1;
        t.1 += credits;
        let r = self
            .by_repo
            .entry(repo_bucket_for(doc_type, doc))
            .or_insert((0, 0));
        r.0 += 1;
        r.1 += credits;
    }

    fn document_count(&self) -> u64 {
        self.by_type.values().map(|(count, _)| count).sum()
    }

    fn total_credits(&self) -> u64 {
        self.by_type.values().map(|(_, credits)| credits).sum()
    }

    /// The rows for an [`AuditReport`], highest cost first.
    fn into_sorted(self) -> (Vec<TypeTotal>, Vec<RepoTotal>) {
        let mut by_type: Vec<TypeTotal> = self
            .by_type
            .into_iter()
            .map(|(doc_type, (count, credits))| TypeTotal {
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
            .map(|(repo, (count, credits))| RepoTotal {
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

    /// The [`GLOBAL_TYPES`] pass plus `profile`: every document a single `$ownerId`-led query
    /// reaches, folded into `totals`. Returns every repository named in a result's `repoId`
    /// field (an `issue` or `patch` the target filed, say) plus, for `repo` itself, the
    /// repositories it owns — for [`Auditor::repo_scope`] to extend further.
    async fn global_pass(
        &self,
        since_ms: Option<u64>,
        totals: &mut Totals,
    ) -> Result<Vec<[u8; 32]>> {
        let mut discovered_repos = Vec::new();
        for g in GLOBAL_TYPES {
            let contract = self.contract(g.contract);
            let docs = self
                .client
                .query_all_documents(
                    contract,
                    g.doc_type,
                    &[QueryFilter::eq(
                        "$ownerId",
                        FieldValue::identifier(self.target),
                    )],
                    &order_of(g.order),
                )
                .await?;
            if g.doc_type == resolve::DOC_REPO {
                discovered_repos.extend(
                    docs.iter()
                        .filter_map(|d| platform::decode_identifier(&d.id).ok()),
                );
            } else {
                discovered_repos.extend(docs.iter().filter_map(|d| d.field_bytes32("repoId")));
            }
            for d in &docs {
                totals.record(g.doc_type, d, since_ms);
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
                &[QueryFilter::eq(
                    "$ownerId",
                    FieldValue::identifier(self.target),
                )],
                &[],
                1,
                None,
            )
            .await?;
        for d in &profile_docs {
            totals.record("profile", d, since_ms);
        }
        Ok(discovered_repos)
    }

    /// Every repository the target could plausibly have written a [`REPO_OWNER_FILTERED_TYPES`]
    /// or [`REPO_SCANNED_TYPES`] document to: `discovered` (repositories [`Auditor::global_pass`]
    /// already found, passed in so they are not queried twice) plus every repository a
    /// `maintainer`, `writer` or `runner` document's `byMember` index says the target belongs
    /// to. A target need not be a formal member to have a repo-scoped footprint — filing an
    /// issue or being a registered CI runner is enough — so `discovered` and this `byMember`
    /// union are both necessary; neither alone is complete.
    async fn repo_scope(
        &self,
        discovered: impl IntoIterator<Item = [u8; 32]>,
    ) -> Result<BTreeSet<[u8; 32]>> {
        let mut scope: BTreeSet<[u8; 32]> = discovered.into_iter().collect();
        for (contract, doc_type) in [
            (&self.core, "maintainer"),
            (&self.core, "writer"),
            (&self.community, "runner"),
        ] {
            let docs = self
                .client
                .query_all_documents(
                    contract,
                    doc_type,
                    &[QueryFilter::eq(
                        "memberId",
                        FieldValue::identifier(self.target),
                    )],
                    &[QueryOrder::asc("memberId")],
                )
                .await?;
            scope.extend(docs.iter().filter_map(|d| d.field_bytes32("repoId")));
        }
        Ok(scope)
    }

    /// The [`REPO_OWNER_FILTERED_TYPES`] and [`REPO_SCANNED_TYPES`] passes for one repository,
    /// folded into `totals`.
    async fn repo_scoped_pass(
        &self,
        repo_id: [u8; 32],
        since_ms: Option<u64>,
        totals: &mut Totals,
    ) -> Result<()> {
        for t in REPO_OWNER_FILTERED_TYPES {
            let docs = self
                .client
                .query_all_documents(
                    &self.core,
                    t.doc_type,
                    &[
                        QueryFilter::eq("repoId", FieldValue::identifier(repo_id)),
                        QueryFilter::eq("$ownerId", FieldValue::identifier(self.target)),
                    ],
                    &order_of(t.order),
                )
                .await?;
            for d in &docs {
                totals.record(t.doc_type, d, since_ms);
            }
        }
        for t in REPO_SCANNED_TYPES {
            let contract = self.contract(t.contract);
            let docs = self
                .client
                .query_all_documents(
                    contract,
                    t.doc_type,
                    &[QueryFilter::eq("repoId", FieldValue::identifier(repo_id))],
                    &order_of(t.order),
                )
                .await?;
            for d in docs.iter().filter(|d| d.owner_id == self.identity_id) {
                totals.record(t.doc_type, d, since_ms);
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
    let identity_id = platform::encode_identifier(target);
    let forge = client.target().require_v2()?;
    let auditor = Auditor {
        client,
        core: client.fetch_contract(&forge.core).await?,
        collab: client.fetch_contract(&forge.collab).await?,
        community: client.fetch_contract(&forge.community).await?,
        target,
        identity_id: identity_id.clone(),
    };

    let mut totals = Totals::default();
    let discovered_repos = auditor.global_pass(since_ms, &mut totals).await?;
    let scope = auditor.repo_scope(discovered_repos).await?;
    for repo_id in scope {
        auditor
            .repo_scoped_pass(repo_id, since_ms, &mut totals)
            .await?;
    }

    let document_count = totals.document_count();
    let total_credits = totals.total_credits();
    let (by_type, by_repo) = totals.into_sorted();

    Ok(AuditReport {
        identity_id,
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
        // No $createdAt at all (the type-level case `chunk` / `star` / `watch` / `follow` /
        // `profile` are all in): `record` must not drop it even though `created_at` is `None`
        // and a `since` filter is active.
        let mut doc = fieldless_doc();
        doc.created_at = None;
        let mut totals = Totals::default();
        totals.record("chunk", &doc, Some(u64::MAX));
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
        let mut totals = Totals::default();
        totals.record("comment", &doc, Some(200));
        assert_eq!(
            totals.document_count(),
            0,
            "a document before --since must be dropped"
        );
    }
}
