//! Delta caches of the append-only document types (`platform-parity-spec.md` §3.4).
//!
//! `refUpdate`, `protectedRefUpdate`, `config` and `packManifest` (forge-core) and `event` and
//! `authorEvent` (forge-collab) are immutable and non-deletable, and each has a
//! `(repoId, $createdAt)` index. A copy of a repository's rows of such a type is therefore
//! complete up to its newest `$createdAt`: nothing below it can change or disappear, and
//! `$createdAt` is the block time, so a row that lands later never sorts below a row already
//! seen. Bringing the copy up to date is one read of `repoId == R AND $createdAt >= cursor`,
//! where `cursor` is the newest `$createdAt` held (`>=`, not `>`: rows of the cursor's own
//! block that were not yet visible are picked up, and every row is deduplicated by `$id`).
//!
//! A repository's current state then costs O(new rows), not O(history), and the reads of
//! several types go out as ONE composite request ([`PlatformClient::query_batch`]).
//!
//! Where the copies live ([`HistoryStore`]): in memory for the process, and on disk as one
//! JSON-lines file per `(network, contract id, contract version, repository, type)`, under
//! `~/.cache/dash-forge/history/` by default or the directory a caller sets (git-remote-dash
//! uses the repository's own `.git/dash/history/`). A file that does not parse is dropped and
//! rebuilt from the network. Rows are kept exactly as Platform returned them: a private
//! repository's are ciphertext, opened by the reader each time, never stored decrypted.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Mutex;

use crate::error::Result;
use crate::platform::{
    BatchRead, FetchedDocument, FieldValue, LoadedContract, PlatformClient, QueryFilter, QueryOrder,
};
use crate::scope::DocScope;

/// Rows per delta page (Drive's maximum).
const PAGE: u32 = 100;

/// One append-only type of one repository: what to read, and where its copy is kept.
#[derive(Debug, Clone)]
pub struct HistorySpec<'c> {
    /// The contract holding the type.
    pub contract: &'c LoadedContract,
    /// The document type (must be immutable, non-deletable, with a `(repoId, $createdAt)`
    /// index).
    pub document_type: &'c str,
    /// The repository.
    pub repo_id: [u8; 32],
}

impl<'c> HistorySpec<'c> {
    /// `document_type` of the repository `scope` names, in `contract`.
    pub fn new(contract: &'c LoadedContract, document_type: &'c str, scope: &DocScope) -> Self {
        Self {
            contract,
            document_type,
            repo_id: scope.repo_id,
        }
    }

    /// The cache key: network, contract id and version, repository, type. A re-registered
    /// contract (a new id) or an in-place update (a new version) is a different key, so a
    /// copy made against one is never read against the other.
    fn key(&self, network: &str) -> String {
        format!(
            "{network}/{}-v{}/{}/{}",
            self.contract.id(),
            self.contract.version(),
            crate::platform::encode_identifier(self.repo_id),
            self.document_type
        )
    }

    fn read(&self, cursor: Option<u64>) -> BatchRead<'c> {
        let mut filters = vec![QueryFilter::eq(
            "repoId",
            FieldValue::identifier(self.repo_id),
        )];
        if let Some(t) = cursor {
            filters.push(QueryFilter::gte("$createdAt", FieldValue::uint64(t)));
        }
        BatchRead {
            contract: self.contract,
            document_type: self.document_type,
            filters,
            order: vec![QueryOrder::asc("$createdAt")],
            limit: PAGE,
            bind: None,
        }
    }
}

/// The copies of this process (in memory), backed by a directory on disk.
#[derive(Debug, Default)]
pub struct HistoryStore {
    rows: Mutex<BTreeMap<String, Vec<FetchedDocument>>>,
    /// Keys brought up to date by this process: a [`Freshness::Synced`] read of one of them
    /// sends nothing.
    synced: Mutex<BTreeSet<String>>,
    /// Overrides the default directory (`<cache>/history`).
    dir: Mutex<Option<PathBuf>>,
}

impl HistoryStore {
    /// Keep the on-disk copies under `dir` instead of the user cache.
    pub fn set_dir(&self, dir: PathBuf) {
        *lock(&self.dir) = Some(dir);
    }

    fn path(&self, key: &str) -> Option<PathBuf> {
        let base = lock(&self.dir)
            .clone()
            .or_else(|| crate::cache::dir().map(|d| d.join("history")))?;
        let p = key
            .split('/')
            .fold(base, |p, part| p.join(crate::cache::component(part)));
        Some(p.with_extension("jsonl"))
    }

    /// The held copy of `key`: memory, else disk, else empty.
    fn load(&self, key: &str) -> Vec<FetchedDocument> {
        if let Some(rows) = lock(&self.rows).get(key) {
            return rows.clone();
        }
        let rows = self
            .path(key)
            .and_then(|p| crate::cache::read(&p))
            .and_then(|bytes| parse_lines(&bytes))
            .unwrap_or_default();
        lock(&self.rows).insert(key.to_string(), rows.clone());
        rows
    }

    fn save(&self, key: &str, rows: Vec<FetchedDocument>, changed: bool) {
        if changed {
            if let Some(p) = self.path(key) {
                crate::cache::write(&p, &to_lines(&rows));
            }
        }
        lock(&self.rows).insert(key.to_string(), rows);
        lock(&self.synced).insert(key.to_string());
    }

    fn is_synced(&self, key: &str) -> bool {
        lock(&self.synced).contains(key)
    }
}

/// Lock `m`, recovering the data of a mutex a panicking holder poisoned (every value behind
/// these locks is a cache, valid whatever the panic interrupted).
pub(crate) fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The `N` results of a [`sync`] of `N` specs, as an array.
pub fn take<const N: usize>(rows: Vec<Vec<FetchedDocument>>) -> [Vec<FetchedDocument>; N] {
    let mut it = rows.into_iter();
    std::array::from_fn(|_| it.next().unwrap_or_default())
}

fn parse_lines(bytes: &[u8]) -> Option<Vec<FetchedDocument>> {
    let text = std::str::from_utf8(bytes).ok()?;
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str::<FetchedDocument>(l).ok())
        .collect()
}

fn to_lines(rows: &[FetchedDocument]) -> Vec<u8> {
    let mut out = Vec::new();
    for r in rows {
        if let Ok(line) = serde_json::to_vec(r) {
            out.extend_from_slice(&line);
            out.push(b'\n');
        }
    }
    out
}

/// Where one type's sync stands.
struct Pending {
    rows: Vec<FetchedDocument>,
    held: BTreeSet<String>,
    cursor: Option<u64>,
    changed: bool,
    done: bool,
}

impl Pending {
    fn new(rows: Vec<FetchedDocument>) -> Self {
        let held = rows.iter().map(|d| d.id.clone()).collect();
        let cursor = rows.iter().filter_map(|d| d.created_at).max();
        Self {
            rows,
            held,
            cursor,
            changed: false,
            done: false,
        }
    }

    /// Take one delta page: [`Absorbed::Complete`] when a short page proved the copy complete,
    /// [`Absorbed::More`] when the cursor moved and another page is due, [`Absorbed::Stuck`]
    /// when a full page could not move it.
    fn absorb(&mut self, page: Vec<FetchedDocument>) -> Absorbed {
        let full = page.len() >= PAGE as usize;
        let page_max = page.iter().filter_map(|d| d.created_at).max();
        let mut fresh = 0usize;
        for d in page {
            if self.held.insert(d.id.clone()) {
                self.rows.push(d);
                fresh += 1;
            }
        }
        if fresh > 0 {
            self.changed = true;
            sort(&mut self.rows);
        }
        if !full {
            self.done = true;
            return Absorbed::Complete;
        }
        match page_max {
            // A full page that does not move the cursor is a single `$createdAt` holding a
            // page or more of rows: `>=` cannot get past it. Read the type completely.
            Some(t) if Some(t) > self.cursor => {
                self.cursor = Some(t);
                Absorbed::More
            }
            _ => Absorbed::Stuck,
        }
    }
}

enum Absorbed {
    Complete,
    More,
    Stuck,
}

fn sort(rows: &mut [FetchedDocument]) {
    rows.sort_by(|a, b| {
        a.created_at
            .unwrap_or(0)
            .cmp(&b.created_at.unwrap_or(0))
            .then_with(|| a.id.cmp(&b.id))
    });
}

/// How current a [`sync`] must be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Freshness {
    /// Read the network now (one delta request for all the types).
    Now,
    /// A copy this process already brought up to date is good enough (no request); anything
    /// else is read now. For folds over state the command just read, e.g. every PR row's base
    /// ref, or the config a push routes each ref update by.
    Synced,
}

/// Whether a [`sync`] at `freshness` must read the network for a copy this process has
/// (`synced`) or has not yet brought up to date. [`Freshness::Now`] always reads: it is what
/// every read that decides a write uses (the protected-ref routing of a ref update, a settings
/// write building on the newest config), so a config that landed since the process's first
/// read is never missed.
fn needs_read(freshness: Freshness, synced: bool) -> bool {
    match freshness {
        Freshness::Now => true,
        Freshness::Synced => !synced,
    }
}

/// Bring the copies of `specs` up to date and return each one's complete rows, ascending by
/// `($createdAt, $id)`. Every round reads all the types still behind in ONE batched request,
/// so the usual cost is one request for all of them.
pub async fn sync(
    client: &PlatformClient,
    specs: &[HistorySpec<'_>],
    freshness: Freshness,
) -> Result<Vec<Vec<FetchedDocument>>> {
    let network = client.network().key();
    let keys: Vec<String> = specs.iter().map(|s| s.key(&network)).collect();
    let store = client.history();
    let mut pending: Vec<Pending> = keys.iter().map(|k| Pending::new(store.load(k))).collect();
    for (p, k) in pending.iter_mut().zip(&keys) {
        p.done = !needs_read(freshness, store.is_synced(k));
    }
    loop {
        let behind: Vec<usize> = (0..specs.len()).filter(|&i| !pending[i].done).collect();
        if behind.is_empty() {
            break;
        }
        let reads: Vec<BatchRead<'_>> = behind
            .iter()
            .map(|&i| specs[i].read(pending[i].cursor))
            .collect();
        let pages = client.query_batch(&reads).await?;
        for (&i, page) in behind.iter().zip(pages) {
            if let Absorbed::Stuck = pending[i].absorb(page) {
                let whole = specs[i].read(None);
                let all = client
                    .query_all_documents(
                        whole.contract,
                        whole.document_type,
                        &whole.filters,
                        &whole.order,
                    )
                    .await?;
                let mut fresh = Pending::new(Vec::new());
                fresh.absorb(all);
                fresh.changed = true;
                fresh.done = true;
                pending[i] = fresh;
            }
        }
    }
    Ok(keys
        .iter()
        .zip(pending)
        .map(|(k, p)| {
            store.save(k, p.rows.clone(), p.changed);
            p.rows
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::{needs_read, parse_lines, sort, to_lines, Absorbed, Freshness, Pending, PAGE};

    /// Review finding (M-3): a read that routes a write must see a config that landed after
    /// this process first synced. `Now` reads the network even for a synced copy; only
    /// `Synced` may skip it.
    #[test]
    fn now_always_reads_and_synced_reuses_a_synced_copy() {
        assert!(
            needs_read(Freshness::Now, true),
            "Now must re-read a synced copy"
        );
        assert!(needs_read(Freshness::Now, false));
        assert!(!needs_read(Freshness::Synced, true));
        assert!(needs_read(Freshness::Synced, false));
    }

    /// The reads that decide a write use `Now` (source check: a regression to `Synced` here
    /// silently routes a newly protected ref as a plain, inert `refUpdate`).
    #[test]
    fn write_routing_reads_use_now() {
        let refs = include_str!("refs.rs");
        let at = refs.find("pub async fn read_config_history").unwrap();
        let body = &refs[at..at + 400];
        assert!(body.contains("Freshness::Now"), "{body}");
        let repo = include_str!("repo.rs");
        for f in ["pub async fn current_config", "pub async fn update_config"] {
            let at = repo.find(f).unwrap_or_else(|| panic!("{f}"));
            let body = &repo[at..(at + 2500).min(repo.len())];
            assert!(
                body.contains("newest_config(&scope, &contract, crate::history::Freshness::Now)"),
                "{f} must read the config now"
            );
        }
    }
    use crate::platform::{FetchedDocument, FieldValue};
    use std::collections::BTreeMap;

    fn row(id: u32, t: u64) -> FetchedDocument {
        let mut fields = BTreeMap::new();
        fields.insert("newOid".into(), FieldValue::Bytes(vec![1; 20]));
        FetchedDocument {
            id: format!("id{id:05}"),
            owner_id: "o".into(),
            created_at: Some(t),
            created_at_block_height: Some(t / 1000),
            updated_at_block_height: None,
            revision: None,
            fields,
        }
    }

    #[test]
    fn a_short_page_completes_and_ties_are_deduplicated() {
        let mut p = Pending::new(vec![row(1, 10), row(2, 20)]);
        assert_eq!(p.cursor, Some(20));
        // `>= 20` re-reads row 2 and brings a new tie and a newer row.
        assert!(matches!(
            p.absorb(vec![row(2, 20), row(3, 20), row(4, 30)]),
            Absorbed::Complete
        ));
        assert_eq!(p.rows.len(), 4);
        assert!(p.changed);
    }

    #[test]
    fn a_full_page_moves_the_cursor_or_is_stuck() {
        let mut p = Pending::new(Vec::new());
        let page: Vec<_> = (0..PAGE).map(|i| row(i, u64::from(i))).collect();
        assert!(matches!(p.absorb(page), Absorbed::More));
        assert_eq!(p.cursor, Some(u64::from(PAGE - 1)));
        // A whole page on one timestamp cannot advance `>=`.
        let mut q = Pending::new(vec![row(0, 5)]);
        let tied: Vec<_> = (1..=PAGE).map(|i| row(i, 5)).collect();
        assert!(matches!(q.absorb(tied), Absorbed::Stuck));
    }

    #[test]
    fn nothing_new_changes_nothing() {
        let mut p = Pending::new(vec![row(1, 10)]);
        assert!(matches!(p.absorb(vec![row(1, 10)]), Absorbed::Complete));
        assert!(!p.changed, "an unchanged copy is not rewritten");
    }

    #[test]
    fn copies_round_trip_through_their_file_and_a_torn_file_is_dropped() {
        let mut rows = vec![row(2, 20), row(1, 10)];
        sort(&mut rows);
        let bytes = to_lines(&rows);
        assert_eq!(parse_lines(&bytes).unwrap(), rows);
        let torn = &bytes[..bytes.len() - 5];
        assert!(
            parse_lines(torn).is_none(),
            "a torn line invalidates the copy"
        );
    }
}
