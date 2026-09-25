//! Ref-update reads: every ref's complete `refUpdate` + `protectedRefUpdate` history.
//!
//! Shared by [`crate::repo::RepoService::read_refs`] (list every ref) and the PR base-tip
//! reader in [`crate::collab`] (one ref). forge-web's `lib/repo/refs.ts` implements the same
//! reads the same way; the two must agree, because the fold over their output
//! ([`crate::rules::resolve_ref`]) is only as parity-safe as its input.
//!
//! ## Why a keyset scan, and never a cursor over the `refState` index
//!
//! The `refState` index is `(refNameHash, $createdAt)`. Paging it with a `startAfter`
//! document cursor LOSES rows on testnet (protocol 13): measured on the nightly repo, 32 of
//! 229 updates never came back. Drive's v0 path-query lowering applies the cursor
//! document's lower-level bounds (its `$createdAt`, then its `$id`) to every *sibling*
//! `refNameHash` branch instead of only the cursor's own branch, so a page silently omits
//! rows from later refs and can come back short — and a short page is the only end-of-data
//! signal a pager has, so everything after it vanishes too. This is the multi-branch cursor
//! family dashpay/platform#4396 fixed for `in` queries at protocol 14; the `orderBy`-only
//! shape used here is one it lists as still unfixed.
//!
//! A range *where-clause* has no cursor document to leak, so this module never sends one on
//! a multi-branch query. It pages by key instead:
//!
//! 1. `refNameHash > last` ordered `(refNameHash, $createdAt)`, `limit 100`. Every ref on
//!    a full page except the last one is complete; the next page starts after the last
//!    complete ref, re-reading the one that may have been cut off.
//! 2. A ref that fills a whole page by itself is read on its own with an equality query
//!    (`refNameHash == h`), which is single-branch — the cursor bug needs sibling branches —
//!    and the scan resumes after it.
//!
//! Each round must strictly advance `last` — the scan checks it — so it terminates without
//! leaning on a page cap, and a one-ref read costs pages of that ref only, not of the whole
//! repo.
//!
//! ## When the scan is not trusted
//!
//! The scan is abandoned, and every update of both types is re-read in `$createdAt`
//! (`reflog`) order instead — the result then comes from that read ALONE, deduplicated by
//! `$id` — when either:
//!
//! * a page comes back out of `refNameHash` order, holds a row at or below its
//!   `refNameHash > last` bound, or would not advance `last` (the node did not honor the
//!   query, so nothing it returned is trusted); or
//! * the completeness check fails. Every non-null `prevOid` a pusher records is the tip it
//!   saw, which is some earlier update's `newOid` for the same ref; an update whose
//!   `prevOid` matches nothing is evidence of a missing row. A dangling `prevOid` can also
//!   be written on purpose (by a WRITE holder), which costs the fallback's extra reads but
//!   never changes the answer.
//!
//! ## What the completeness check cannot see
//!
//! It finds a gap only in the MIDDLE of a chain. A missing newest update, or a ref missing
//! entirely, leaves no dangling `prevOid`, so the ref would quietly resolve to an older tip
//! (or not be listed). The scan itself does not drop rows that way — it is cursor-free,
//! which is the point — so this is a limit of the safety net, not a known failure.
//!
//! One path does still use a cursor: a ref with more than a page of updates is read with
//! `refNameHash == h` paged by `startAfter`. That is single-branch, so the sibling-branch
//! drop cannot happen, but protocol 13 still skips rows sharing the page boundary's
//! `$createdAt` (docs/BUILDING.md, "same-block ties"), and repo-v1 ref updates do not return
//! `$createdAt` from a proved query, so the tie probe cannot repair it. That read is the one
//! `base_ref_tips` always used; it goes away with forge-v2 on protocol 14, whose cursor is
//! bounded by document id. The mock's `ref_history` is exact, so no test here covers it.

use std::collections::{BTreeMap, BTreeSet};

use crate::error::{Error, Result};
use crate::platform::{
    FetchedDocument, FieldValue, LoadedContract, PlatformClient, QueryFilter, QueryOrder,
};
use crate::rules::RefUpdate;

/// The plain ref-update document type.
pub(crate) const DOC_REF_UPDATE: &str = "refUpdate";
/// The MAINTAIN-gated ref-update document type.
pub(crate) const DOC_PROTECTED_REF_UPDATE: &str = "protectedRefUpdate";

/// Both ref-update types, each with the `protected` flag its updates carry into the fold.
const REF_UPDATE_TYPES: [(&str, bool); 2] =
    [(DOC_REF_UPDATE, false), (DOC_PROTECTED_REF_UPDATE, true)];

/// Rows per keyset page — Drive's per-query maximum.
pub(crate) const KEYSET_PAGE: u32 = 100;

/// A backstop against a node that never lets the scan finish. Every round advances past at
/// least one ref, so this is a bound on distinct refs per type (with every ref on its own
/// round), not on updates.
const MAX_KEYSET_ROUNDS: usize = 100_000;

/// Every ref's history, keyed by the raw `refNameHash`.
pub type RefHistories = BTreeMap<[u8; 32], Vec<RefUpdate>>;

/// The three reads the scan is built from. A trait so the scan (the part that decides
/// whether a read is complete) runs against a mock in tests; [`PlatformRefSource`] is the
/// live implementation.
pub(crate) trait RefDocSource {
    /// One page of `doc_type` ordered `(refNameHash, $createdAt)`, restricted to
    /// `refNameHash > after` when `after` is set, at most [`KEYSET_PAGE`] rows. No cursor.
    async fn keyset_page(
        &self,
        doc_type: &str,
        after: Option<[u8; 32]>,
    ) -> Result<Vec<FetchedDocument>>;

    /// Every `doc_type` update of one ref (an equality read, paged to exhaustion).
    async fn ref_history(&self, doc_type: &str, hash: [u8; 32]) -> Result<Vec<FetchedDocument>>;

    /// Every `doc_type` update in `$createdAt` order — the fallback.
    async fn full_scan(&self, doc_type: &str) -> Result<Vec<FetchedDocument>>;
}

/// [`RefDocSource`] over a live Platform connection.
pub(crate) struct PlatformRefSource<'a> {
    pub(crate) client: &'a PlatformClient,
    pub(crate) contract: &'a LoadedContract,
}

impl RefDocSource for PlatformRefSource<'_> {
    async fn keyset_page(
        &self,
        doc_type: &str,
        after: Option<[u8; 32]>,
    ) -> Result<Vec<FetchedDocument>> {
        let filters: Vec<QueryFilter> = after
            .map(|h| QueryFilter::gt("refNameHash", FieldValue::bytes32(h)))
            .into_iter()
            .collect();
        self.client
            .query_documents(
                self.contract,
                doc_type,
                &filters,
                &[
                    QueryOrder::asc("refNameHash"),
                    QueryOrder::asc("$createdAt"),
                ],
                KEYSET_PAGE,
                None,
            )
            .await
    }

    async fn ref_history(&self, doc_type: &str, hash: [u8; 32]) -> Result<Vec<FetchedDocument>> {
        self.client
            .query_all_documents(
                self.contract,
                doc_type,
                &[QueryFilter::eq("refNameHash", FieldValue::bytes32(hash))],
                &[QueryOrder::asc("$createdAt")],
            )
            .await
    }

    async fn full_scan(&self, doc_type: &str) -> Result<Vec<FetchedDocument>> {
        self.client
            .query_all_documents(
                self.contract,
                doc_type,
                &[],
                &[QueryOrder::asc("$createdAt")],
            )
            .await
    }
}

/// Read every ref's complete history from a live repo contract. See the module docs.
pub async fn read_all_ref_updates(
    client: &PlatformClient,
    contract: &LoadedContract,
) -> Result<RefHistories> {
    read_all_with(&PlatformRefSource { client, contract }).await
}

/// Read one ref's complete history (both types) from a live repo contract.
pub async fn read_ref_history(
    client: &PlatformClient,
    contract: &LoadedContract,
    ref_name_hash: [u8; 32],
) -> Result<Vec<RefUpdate>> {
    ref_history_with(&PlatformRefSource { client, contract }, ref_name_hash).await
}

pub(crate) async fn ref_history_with(
    src: &impl RefDocSource,
    hash: [u8; 32],
) -> Result<Vec<RefUpdate>> {
    let hash_hex = hex::encode(hash);
    let mut out = Vec::new();
    for (doc_type, protected) in REF_UPDATE_TYPES {
        for d in src.ref_history(doc_type, hash).await? {
            out.push(ref_update_from_doc(&d, &hash_hex, protected));
        }
    }
    Ok(out)
}

/// The scan behind [`read_all_ref_updates`], over any [`RefDocSource`].
pub(crate) async fn read_all_with(src: &impl RefDocSource) -> Result<RefHistories> {
    let mut docs: Vec<(Vec<FetchedDocument>, bool, &str)> = Vec::new();
    let mut misbehaved = false;
    for (doc_type, protected) in REF_UPDATE_TYPES {
        let Some(rows) = keyset_scan(src, doc_type).await? else {
            misbehaved = true;
            break;
        };
        docs.push((rows, protected, doc_type));
    }
    if misbehaved {
        tracing::warn!(
            "a ref-update keyset page came back out of order or out of range; re-reading \
             every update in reflog order"
        );
    } else {
        let by_hash = group(&docs)?;
        let dangling = by_hash.values().filter(|u| has_missing_parent(u)).count();
        if dangling == 0 {
            return Ok(by_hash);
        }
        tracing::warn!(
            refs_with_missing_parent = dangling,
            "ref-update keyset scan is missing parents; re-reading every update in reflog order"
        );
    }
    // The fallback stands alone: a scan that misbehaved or lost rows is not trusted for any
    // of them, and the reflog read is complete on its own.
    let mut full = Vec::with_capacity(REF_UPDATE_TYPES.len());
    for (doc_type, protected) in REF_UPDATE_TYPES {
        full.push((dedupe(src.full_scan(doc_type).await?), protected, doc_type));
    }
    group(&full)
}

/// Drop repeated `$id`s, keeping the first occurrence.
fn dedupe(rows: Vec<FetchedDocument>) -> Vec<FetchedDocument> {
    let mut seen = BTreeSet::new();
    rows.into_iter()
        .filter(|d| seen.insert(d.id.clone()))
        .collect()
}

/// Page one type by key (see the module docs). `None` when the node did not honor the
/// query: a page out of order, a row at or below the `refNameHash > after` bound, or a round
/// that would not move `after` forward. The caller then discards the scan entirely.
async fn keyset_scan(
    src: &impl RefDocSource,
    doc_type: &str,
) -> Result<Option<Vec<FetchedDocument>>> {
    let mut out: Vec<FetchedDocument> = Vec::new();
    let mut after: Option<[u8; 32]> = None;
    for _ in 0..MAX_KEYSET_ROUNDS {
        let page = src.keyset_page(doc_type, after).await?;
        let hashes = page
            .iter()
            .map(|d| ref_hash(d, doc_type))
            .collect::<Result<Vec<_>>>()?;
        let in_order = hashes.windows(2).all(|w| w[0] <= w[1]);
        let in_range = after.is_none_or(|a| hashes.iter().all(|h| *h > a));
        if !in_order || !in_range {
            return Ok(None);
        }

        if page.len() < KEYSET_PAGE as usize {
            out.extend(page);
            return Ok(Some(dedupe(out)));
        }
        let last = *hashes.last().expect("a full page is non-empty");
        let cut = hashes.iter().position(|h| *h == last).unwrap_or(0);
        let next = if cut == 0 {
            // One ref filled the page: read it on its own, then move past it.
            out.extend(src.ref_history(doc_type, last).await?);
            last
        } else {
            // Every ref before the last is whole; the last may be cut off, so it is
            // re-read from its start on the next page.
            out.extend(page.into_iter().take(cut));
            hashes[cut - 1]
        };
        // In-range pages already imply progress; this guards the invariant the loop's
        // termination rests on rather than the node's behavior.
        if after.is_some_and(|a| next <= a) {
            return Ok(None);
        }
        after = Some(next);
    }
    Err(Error::IncompleteRead {
        document_type: doc_type.to_string(),
        fetched: out.len(),
        reason: format!("the ref keyset scan did not finish in {MAX_KEYSET_ROUNDS} rounds"),
    })
}

/// Group rows per ref. Within a ref, plain updates come before protected ones and each
/// source keeps its read order; the fold re-sorts by `(createdAt, id)` regardless.
fn group(docs: &[(Vec<FetchedDocument>, bool, &str)]) -> Result<RefHistories> {
    let mut by_hash = RefHistories::new();
    for (rows, protected, doc_type) in docs {
        for d in rows {
            let hash = ref_hash(d, doc_type)?;
            by_hash.entry(hash).or_default().push(ref_update_from_doc(
                d,
                &hex::encode(hash),
                *protected,
            ));
        }
    }
    Ok(by_hash)
}

/// The document's `refNameHash`. A row without one cannot be attributed to a ref; the schema
/// forbids it, and skipping it would make the answer wrong rather than partial.
fn ref_hash(d: &FetchedDocument, doc_type: &str) -> Result<[u8; 32]> {
    d.field_bytes("refNameHash")
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
        .ok_or_else(|| Error::Platform(format!("{doc_type} {} has no 32-byte refNameHash", d.id)))
}

/// Whether some update's non-null `prevOid` is no update's `newOid` in the same ref — a
/// parent that should have been read and was not. Parity: forge-web `hasMissingParent`.
pub fn has_missing_parent(updates: &[RefUpdate]) -> bool {
    let tips: BTreeSet<&str> = updates.iter().map(|u| u.new_oid.as_str()).collect();
    updates.iter().any(|u| {
        let null = u.prev_oid.is_empty() || u.prev_oid.bytes().all(|b| b == b'0');
        !null && !tips.contains(u.prev_oid.as_str())
    })
}

/// Flatten a ref-update document to the [`RefUpdate`] shape the fold consumes.
pub(crate) fn ref_update_from_doc(
    d: &FetchedDocument,
    hash_hex: &str,
    protected: bool,
) -> RefUpdate {
    RefUpdate {
        id: d.id.clone(),
        ref_name_hash: hash_hex.to_string(),
        ref_name: d.field_str("refName").unwrap_or_default(),
        prev_oid: d.field_hex("prevOid").unwrap_or_default(),
        new_oid: d.field_hex("newOid").unwrap_or_default(),
        force: d.field_bool("force"),
        protected,
        author: d.owner_id.clone(),
        created_at: d.created_at.unwrap_or(0),
    }
}

#[cfg(test)]
// The mocks below answer synchronously; `async fn` keeps them shaped like the live source.
#[allow(clippy::unused_async_trait_impl)]
mod tests {
    use super::{
        has_missing_parent, read_all_with, ref_history_with, RefDocSource, DOC_REF_UPDATE,
        KEYSET_PAGE,
    };
    use crate::error::Result;
    use crate::platform::{FetchedDocument, FieldValue};
    use std::cell::{Cell, RefCell};
    use std::collections::{BTreeMap, BTreeSet};

    /// A refUpdate row. `ref_seed` picks the ref (its hash is `[ref_seed; 32]`), `id` its
    /// `$id`; oids are one byte repeated so a chain is easy to spell.
    fn row(ref_seed: u8, id: u32, prev: u8, new: u8) -> FetchedDocument {
        let mut fields = BTreeMap::new();
        fields.insert("refNameHash".into(), FieldValue::Bytes32([ref_seed; 32]));
        fields.insert(
            "refName".into(),
            FieldValue::Text(format!("refs/heads/r{ref_seed}")),
        );
        fields.insert("newOid".into(), FieldValue::Bytes(vec![new; 20]));
        if prev != 0 {
            fields.insert("prevOid".into(), FieldValue::Bytes(vec![prev; 20]));
        }
        FetchedDocument {
            id: format!("id{id:06}"),
            owner_id: "pusher".into(),
            // The deployed repo-v1 type never recorded `$createdAt` (design-freeze-2 §3).
            created_at: None,
            fields,
        }
    }

    /// A ref with `n` linear updates (1 → 2 → … → n), ids drawn from `ids`.
    fn chain(ref_seed: u8, n: u8, ids: &mut u32) -> Vec<FetchedDocument> {
        (1..=n)
            .map(|k| {
                *ids += 1;
                row(ref_seed, *ids, k - 1, k)
            })
            .collect()
    }

    fn hash_of(d: &FetchedDocument) -> [u8; 32] {
        <[u8; 32]>::try_from(d.field_bytes("refNameHash").unwrap()).unwrap()
    }

    /// An in-memory Drive for one document type, in `refState` order
    /// (`refNameHash`, then — `$createdAt` being absent — `$id`).
    ///
    /// `cursor_page` reproduces the protocol-13 multi-branch cursor lowering: the cursor
    /// document's `$id` bound leaks into every later `refNameHash` branch, so rows there
    /// with a smaller `$id` are skipped. `drop_on_keyset` removes one id from keyset pages,
    /// standing in for a node that answers a correct query incompletely.
    struct MockDrive {
        rows: Vec<FetchedDocument>,
        drop_on_keyset: Option<String>,
        /// Serve keyset pages ignoring `refNameHash > after` (a node not honoring the query).
        ignore_range: bool,
        keyset_calls: Cell<usize>,
        history_calls: RefCell<Vec<[u8; 32]>>,
        full_scans: Cell<usize>,
    }

    impl MockDrive {
        fn new(mut rows: Vec<FetchedDocument>) -> Self {
            rows.sort_by(|a, b| hash_of(a).cmp(&hash_of(b)).then_with(|| a.id.cmp(&b.id)));
            Self {
                rows,
                drop_on_keyset: None,
                ignore_range: false,
                keyset_calls: Cell::new(0),
                history_calls: RefCell::new(Vec::new()),
                full_scans: Cell::new(0),
            }
        }

        /// The `startAfter` page the old reader requested, with the v0 sibling-branch drop.
        fn cursor_page(&self, after_id: Option<&str>) -> Vec<FetchedDocument> {
            let Some(after_id) = after_id else {
                return self
                    .rows
                    .iter()
                    .take(KEYSET_PAGE as usize)
                    .cloned()
                    .collect();
            };
            let cursor = self.rows.iter().find(|d| d.id == after_id).unwrap();
            let pos = self.rows.iter().position(|d| d.id == after_id).unwrap();
            self.rows[pos + 1..]
                .iter()
                .filter(|d| hash_of(d) == hash_of(cursor) || d.id > cursor.id)
                .take(KEYSET_PAGE as usize)
                .cloned()
                .collect()
        }
    }

    impl RefDocSource for MockDrive {
        async fn keyset_page(
            &self,
            _doc_type: &str,
            after: Option<[u8; 32]>,
        ) -> Result<Vec<FetchedDocument>> {
            self.keyset_calls.set(self.keyset_calls.get() + 1);
            Ok(self
                .rows
                .iter()
                .filter(|d| self.ignore_range || after.is_none_or(|a| hash_of(d) > a))
                .filter(|d| self.drop_on_keyset.as_deref() != Some(d.id.as_str()))
                .take(KEYSET_PAGE as usize)
                .cloned()
                .collect())
        }

        async fn ref_history(
            &self,
            _doc_type: &str,
            hash: [u8; 32],
        ) -> Result<Vec<FetchedDocument>> {
            self.history_calls.borrow_mut().push(hash);
            Ok(self
                .rows
                .iter()
                .filter(|d| hash_of(d) == hash)
                .cloned()
                .collect())
        }

        async fn full_scan(&self, _doc_type: &str) -> Result<Vec<FetchedDocument>> {
            self.full_scans.set(self.full_scans.get() + 1);
            Ok(self.rows.clone())
        }
    }

    /// Serves only the plain type; protected reads come back empty.
    struct PlainOnly(MockDrive);

    impl RefDocSource for PlainOnly {
        async fn keyset_page(
            &self,
            t: &str,
            after: Option<[u8; 32]>,
        ) -> Result<Vec<FetchedDocument>> {
            if t == DOC_REF_UPDATE {
                self.0.keyset_page(t, after).await
            } else {
                Ok(Vec::new())
            }
        }
        async fn ref_history(&self, t: &str, hash: [u8; 32]) -> Result<Vec<FetchedDocument>> {
            if t == DOC_REF_UPDATE {
                self.0.ref_history(t, hash).await
            } else {
                Ok(Vec::new())
            }
        }
        async fn full_scan(&self, t: &str) -> Result<Vec<FetchedDocument>> {
            if t == DOC_REF_UPDATE {
                self.0.full_scan(t).await
            } else {
                Ok(Vec::new())
            }
        }
    }

    /// 60 refs × 1..4 updates with ids interleaved across refs — the shape of the nightly
    /// repo, where every run pushes several refs and ids are random with respect to hashes.
    fn nightly_like() -> Vec<FetchedDocument> {
        let mut ids = 0u32;
        let mut rows = Vec::new();
        for r in 1..=60u8 {
            rows.extend(chain(r, 1 + r % 4, &mut ids));
        }
        // Scramble ids against hash order: reverse them.
        let n = rows.len();
        for (i, d) in rows.iter_mut().enumerate() {
            d.id = format!("id{:06}", n - i);
        }
        rows
    }

    #[test]
    fn the_mock_reproduces_the_cursor_drop() {
        // The old reader: refState order, paged by `startAfter`, stop at a short page.
        let drive = MockDrive::new(nightly_like());
        let total = drive.rows.len();
        assert!(total > KEYSET_PAGE as usize, "needs more than one page");
        let mut got = 0;
        let mut after: Option<String> = None;
        loop {
            let page = drive.cursor_page(after.as_deref());
            got += page.len();
            if page.len() < KEYSET_PAGE as usize {
                break;
            }
            after = page.last().map(|d| d.id.clone());
        }
        assert!(
            got < total,
            "the cursor read should lose rows ({got} of {total})"
        );
    }

    #[tokio::test]
    async fn keyset_scan_reads_every_update_without_a_cursor() {
        let drive = PlainOnly(MockDrive::new(nightly_like()));
        let total = drive.0.rows.len();
        let got = read_all_with(&drive).await.unwrap();
        assert_eq!(got.len(), 60);
        assert_eq!(got.values().map(Vec::len).sum::<usize>(), total);
        assert_eq!(
            drive.0.full_scans.get(),
            0,
            "a consistent scan needs no fallback"
        );
        // ~2 pages for ~150 rows, not one round-trip per ref.
        assert!(
            drive.0.keyset_calls.get() <= 3,
            "{} pages",
            drive.0.keyset_calls.get()
        );
    }

    #[tokio::test]
    async fn a_ref_that_fills_a_page_is_read_on_its_own() {
        let mut ids = 0u32;
        let mut rows = chain(5, 3, &mut ids);
        rows.extend(chain(7, 150, &mut ids)); // one hot ref, more than a page
        rows.extend(chain(9, 2, &mut ids));
        let drive = PlainOnly(MockDrive::new(rows));
        let got = read_all_with(&drive).await.unwrap();
        assert_eq!(got[&[7; 32]].len(), 150);
        assert_eq!(got[&[5; 32]].len(), 3);
        assert_eq!(got[&[9; 32]].len(), 2);
        assert_eq!(*drive.0.history_calls.borrow(), vec![[7u8; 32]]);
        assert_eq!(drive.0.full_scans.get(), 0);
    }

    #[tokio::test]
    async fn an_out_of_range_page_abandons_the_scan_for_the_full_read() {
        // A node that ignores `refNameHash > after` serves the first page forever: the scan
        // must stop at once (not loop, not merge) and answer from the reflog read alone.
        let mut drive = MockDrive::new(nightly_like());
        drive.ignore_range = true;
        let drive = PlainOnly(drive);
        let got = read_all_with(&drive).await.unwrap();
        assert_eq!(drive.0.keyset_calls.get(), 2, "stops on the first bad page");
        assert_eq!(drive.0.full_scans.get(), 1);
        assert_eq!(
            got.values().map(Vec::len).sum::<usize>(),
            drive.0.rows.len()
        );
    }

    #[tokio::test]
    async fn a_missing_parent_falls_back_to_the_full_scan_alone() {
        let mut rows = nightly_like();
        // Drop the middle update of a 3-update ref from keyset pages only.
        let victim = rows
            .iter()
            .find(|d| hash_of(d) == [2; 32] && d.field_hex("newOid") == Some("02".repeat(20)))
            .unwrap()
            .id
            .clone();
        rows.sort_by(|a, b| a.id.cmp(&b.id));
        let mut drive = MockDrive::new(rows);
        drive.drop_on_keyset = Some(victim);
        let drive = PlainOnly(drive);
        let got = read_all_with(&drive).await.unwrap();
        assert_eq!(drive.0.full_scans.get(), 1);
        assert_eq!(got[&[2; 32]].len(), 3, "the dropped update is recovered");
        assert_eq!(
            got.values().map(Vec::len).sum::<usize>(),
            drive.0.rows.len(),
            "and nothing is counted twice"
        );
    }

    #[tokio::test]
    async fn ref_history_reads_both_types() {
        let mut ids = 0u32;
        let drive = MockDrive::new(chain(3, 4, &mut ids));
        // The mock serves the same rows for both types; each is tagged with its source.
        let got = ref_history_with(&drive, [3; 32]).await.unwrap();
        assert_eq!(got.len(), 8);
        assert_eq!(got.iter().filter(|u| u.protected).count(), 4);
        let ids: BTreeSet<&str> = got.iter().map(|u| u.id.as_str()).collect();
        assert_eq!(ids.len(), 4);
    }

    #[test]
    fn missing_parent_detection() {
        let u = |prev: &str, new: &str| crate::rules::RefUpdate {
            id: new.into(),
            ref_name_hash: "h".into(),
            ref_name: "refs/heads/x".into(),
            prev_oid: prev.into(),
            new_oid: new.into(),
            force: false,
            protected: false,
            author: "a".into(),
            created_at: 0,
        };
        assert!(!has_missing_parent(&[u("", "aa"), u("aa", "bb")]));
        assert!(
            !has_missing_parent(&[u("0000", "aa"), u("aa", "0000")]),
            "create + delete"
        );
        assert!(has_missing_parent(&[u("", "aa"), u("cc", "dd")]));
    }
}
