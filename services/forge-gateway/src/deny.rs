//! The operator's deny list (`GATEWAY_DENY`): repositories and owners this gateway refuses with
//! `451 Unavailable For Legal Reasons` (RFC 7725), for a valid notice against one repository or
//! one identity's repositories. A refusal is the gateway's alone: the repository stays on Dash
//! Platform and `git clone dash://…` (git-remote-dash) still reads it.
//!
//! The file has one entry per line, `#` starts a comment:
//!
//! ```text
//! 29d2S7vB453rNYFdR5Ycwt7y9haRT5fwVwL9zTmBhfV2   # a repository id, or an owner identity id
//! alice/project                                  # <owner id or DPNS name>/<repository name>
//! ```
//!
//! A bare entry is a base58 Platform id (a repository's, or an owner's: every repository of that
//! identity). A `<owner>/<name>` entry names its owner by id or by DPNS name; names are compared
//! the way Platform and forge-core compare them: a repository name lower-cased without `.git`
//! ([`normalize_repo_name`]), a DPNS name without `.dash` in its homograph-safe form
//! ([`dpns_normalize`]: `Alice`, `alice.dash` and `a1ice` are one name). A line that is neither is
//! ignored and logged, so a typo never silently denies nothing.
//!
//! It is read when the gateway starts and again when its modification time or size changes
//! (checked at most every [`CHECK_EVERY`], by whoever asks, and only once the file has not been
//! modified for [`SETTLE`], so a half-written file is never applied; write a temporary file in the
//! same directory and `mv` it over). A list that cannot be read or is too large is not applied
//! and the last good one stays: a takedown never lapses because an editor left the file
//! half-written. To lift every entry, empty the file (do not delete it).
//!
//! A name entry whose owner is a DPNS name is also resolved to the repository it names
//! ([`DenyList::resolve_names`], in the background), so a request that names the repository by
//! its owner's id is refused too. Until that has run, [`DenyList::unsettled_for`] tells the
//! server which entries it must settle before it serves a repository of that name
//! ([`DenyList::settle`]), or answer `503`: the list fails closed.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use forge_core::platform::decode_identifier;
use forge_core::platform::identity::dpns_normalize;
use forge_core::resolve::looks_like_identity_id;
use forge_core::rules::v2::normalize_repo_name;

use crate::upstream::{RepoInfo, Upstream};

/// How often the file's modification time is looked at (at most).
pub const CHECK_EVERY: Duration = Duration::from_secs(5);

/// A file modified more recently than this is not applied yet (it may be half-written).
pub const SETTLE: Duration = Duration::from_secs(1);

/// The largest deny file read.
const MAX_FILE_BYTES: u64 = 4 << 20;

/// How many listed names one [`DenyList::resolve_names`] pass reads.
const RESOLVE_PER_PASS: usize = 32;

/// A name that could not be read is tried again after this; one that read as absent (the
/// repository may not exist yet) after [`ABSENT_RETRY`]. A request for a repository of the
/// listed name looks again sooner ([`ABSENT_RECHECK`]).
const READ_RETRY: Duration = Duration::from_secs(60);
const ABSENT_RETRY: Duration = Duration::from_secs(600);
const ABSENT_RECHECK: Duration = Duration::from_secs(30);
/// Inline settles (reads made for a request, [`DenyList::settle`]) in flight at once. A request
/// that finds them all busy is refused with 503 without a read, so a flood of requests for a
/// listed name while its reads fail is not passed on to Platform one for one.
const INLINE_SETTLES: usize = 4;

/// A listed owner: an identity id (exact), or a DPNS name in its homograph-safe form.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum Owner {
    Id(String),
    Name(String),
}

/// A listed `<owner>/<name>` as it is compared: the owner, and the repository name normalised.
type Key = (Owner, String);

/// `s` as an owner: a Platform id exactly, else a DPNS label (`.dash` dropped, homograph-safe).
/// `None` when it is neither.
fn owner_key(s: &str) -> Option<Owner> {
    // As forge-core resolves an owner: an id is 40-44 base58 characters; anything else is a name.
    if looks_like_identity_id(s) {
        return Some(Owner::Id(s.to_string()));
    }
    let lower = s.to_ascii_lowercase();
    let label = lower.strip_suffix(".dash").unwrap_or(&lower);
    let ok = !label.is_empty()
        && label.len() <= 63
        && label
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-');
    ok.then(|| Owner::Name(dpns_normalize(label)))
}

/// `n` as a repository name: lower-cased, without `.git`, and valid. `None` when it is not.
fn name_key(n: &str) -> Option<String> {
    let lower = n.to_ascii_lowercase();
    normalize_repo_name(lower.strip_suffix(".git").unwrap_or(&lower))
}

/// A listed name entry, as it is read from Platform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NamedEntry {
    key: Key,
    /// The owner as the file wrote it (an id or a DPNS name), for the read.
    owner: String,
    /// The repository name, normalised.
    name: String,
}

/// A deny list's lines, parsed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Entries {
    /// Repository ids and owner identity ids.
    ids: HashSet<String>,
    /// `<owner>/<name>` entries by their normalised key, with the owner as written.
    named: HashMap<Key, String>,
}

impl Entries {
    /// Parse a deny file. The lines that are not an entry are returned (1-based line numbers)
    /// so the operator can be told; they deny nothing.
    pub fn parse(text: &str) -> (Self, Vec<usize>) {
        let mut out = Self::default();
        let mut rejected = Vec::new();
        for (i, raw) in text.lines().enumerate() {
            let line = raw.split('#').next().unwrap_or_default().trim();
            if line.is_empty() {
                continue;
            }
            let ok = match line.split_once('/') {
                None => decode_identifier(line)
                    .is_ok()
                    .then(|| out.ids.insert(line.to_string()))
                    .is_some(),
                Some((owner, name)) => match (owner_key(owner), name_key(name)) {
                    (Some(o), Some(n)) => {
                        out.named.entry((o, n)).or_insert_with(|| owner.to_string());
                        true
                    }
                    _ => false,
                },
            };
            if !ok {
                rejected.push(i + 1);
            }
        }
        (out, rejected)
    }

    /// How many entries there are.
    pub fn len(&self) -> usize {
        self.ids.len() + self.named.len()
    }

    /// Whether the list denies nothing.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Whether `owner/name`, as a request or a repository record spells them, is listed.
    fn names(&self, owner: &str, name: &str) -> bool {
        match (owner_key(owner), name_key(name)) {
            (Some(o), Some(n)) => self.named.contains_key(&(o, n)),
            _ => false,
        }
    }

    /// The listed `<DPNS name>/<name>` entries for repository name `name` (normalised), filtered
    /// before anything is cloned.
    fn named_entries_called<'a>(&'a self, name: &'a str) -> impl Iterator<Item = NamedEntry> + 'a {
        self.named
            .iter()
            .filter(move |((owner, n), _)| matches!(owner, Owner::Name(_)) && n == name)
            .map(|(key, owner)| NamedEntry {
                key: key.clone(),
                owner: owner.clone(),
                name: key.1.clone(),
            })
    }

    fn named_entries(&self) -> impl Iterator<Item = NamedEntry> + '_ {
        self.named.iter().map(|(key, owner)| NamedEntry {
            key: key.clone(),
            owner: owner.clone(),
            name: key.1.clone(),
        })
    }
}

/// What the background resolution of a listed name found.
#[derive(Debug)]
struct Resolution {
    repo_id: Option<String>,
    at: Instant,
    /// The read worked (`repo_id` `None` then means there is no such repository, yet).
    read: bool,
}

#[derive(Debug, Default)]
struct State {
    checked: Option<Instant>,
    /// The file as last applied.
    stamp: Option<(SystemTime, u64)>,
    entries: Arc<Entries>,
    /// Listed names resolved to repository ids.
    resolved: HashMap<Key, Resolution>,
    /// The ids in `resolved`, for the lookup.
    resolved_ids: HashSet<String>,
    generation: u64,
    /// A good list has been applied.
    loaded: bool,
    /// The latest look at the file failed: the list in force may be out of date.
    unreadable: bool,
}

/// The list, from `GATEWAY_DENY`.
#[derive(Debug)]
pub struct DenyList {
    path: Option<PathBuf>,
    every: Duration,
    settle: Duration,
    state: Mutex<State>,
    inline_settles: tokio::sync::Semaphore,
}

impl DenyList {
    /// The list in `path` (`None`: nothing is denied), read now and re-read when it changes.
    pub fn new(path: Option<PathBuf>, every: Duration) -> Self {
        Self::with_settle(path, every, SETTLE)
    }

    /// [`Self::new`] applying a changed file only once it has not been modified for `settle`.
    pub fn with_settle(path: Option<PathBuf>, every: Duration, settle: Duration) -> Self {
        let list = Self {
            path,
            every,
            settle,
            state: Mutex::default(),
            inline_settles: tokio::sync::Semaphore::new(INLINE_SETTLES),
        };
        list.reload_now();
        list
    }

    /// A list that denies nothing.
    pub fn none() -> Self {
        Self::new(None, CHECK_EVERY)
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Look at the file now, whatever its age: if its stamp moved, apply it. `true` when the
    /// list changed.
    pub fn reload_now(&self) -> bool {
        let mut st = self.state();
        st.checked = Some(Instant::now());
        self.load(&mut st, true)
    }

    /// Look at the file if it was last looked at more than `every` ago.
    fn state_fresh(&self) -> MutexGuard<'_, State> {
        let mut st = self.state();
        if self.path.is_some() && st.checked.is_none_or(|t| t.elapsed() >= self.every) {
            st.checked = Some(Instant::now());
            self.load(&mut st, false);
        }
        st
    }

    fn load(&self, st: &mut State, force: bool) -> bool {
        let Some(path) = &self.path else {
            return false;
        };
        let unreadable = |st: &mut State, why: String| {
            if !st.unreadable {
                tracing::warn!(file = %path.display(), %why, "deny list not applied; keeping the last one");
            }
            st.unreadable = true;
            false
        };
        let meta = match std::fs::metadata(path) {
            Ok(m) => m,
            // Not there: nothing is denied until it is (a gateway refuses to start without
            // it); the same state after a list was loaded keeps that list.
            Err(e) => return unreadable(st, e.to_string()),
        };
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let stamp = (modified, meta.len());
        if st.stamp == Some(stamp) {
            st.unreadable = false;
            return false;
        }
        // Modified a moment ago: perhaps still being written. Look again at the next check.
        if !force && modified.elapsed().is_ok_and(|age| age < self.settle) {
            return false;
        }
        if meta.len() > MAX_FILE_BYTES {
            return unreadable(st, format!("larger than {MAX_FILE_BYTES} bytes"));
        }
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) => return unreadable(st, e.to_string()),
        };
        let (entries, rejected) = Entries::parse(&text);
        if !rejected.is_empty() {
            tracing::warn!(file = %path.display(), lines = ?rejected, "deny list lines that are not an entry were ignored");
        }
        tracing::info!(file = %path.display(), entries = entries.len(), "deny list loaded");
        st.unreadable = false;
        st.loaded = true;
        st.stamp = Some(stamp);
        st.generation += 1;
        // What was resolved stays for the names still listed.
        st.resolved.retain(|k, _| entries.named.contains_key(k));
        st.resolved_ids = st
            .resolved
            .values()
            .filter_map(|r| r.repo_id.clone())
            .collect();
        st.entries = Arc::new(entries);
        true
    }

    /// Whether a file is configured (`GATEWAY_DENY` is set).
    pub fn configured(&self) -> bool {
        self.path.is_some()
    }

    /// Whether a good list has been applied (always `false` without a file).
    pub fn loaded(&self) -> bool {
        self.state().loaded
    }

    /// Whether the latest look at the file failed, so the list in force may be out of date.
    pub fn unreadable(&self) -> bool {
        self.state_fresh().unreadable
    }

    /// Bumped each time the applied list changes.
    pub fn generation(&self) -> u64 {
        self.state_fresh().generation
    }

    /// How many entries are applied.
    pub fn len(&self) -> usize {
        self.state_fresh().entries.len()
    }

    /// Whether nothing is denied.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Whether a request for `owner/name` is refused before anything is read from Platform.
    pub fn denies_request(&self, owner: &str, name: &str) -> bool {
        let st = self.state_fresh();
        !st.entries.is_empty() && st.entries.names(owner, name)
    }

    /// Whether `info`, which a request named `owner/name`, is refused: by its repository id,
    /// its owner's id, either spelling of its name, or a listed name that resolved to it.
    pub fn denies(&self, info: &RepoInfo, owner: &str, name: &str) -> bool {
        let st = self.state_fresh();
        let e = &st.entries;
        !e.is_empty()
            && (e.ids.contains(&info.repo_id)
                || e.ids.contains(&info.owner_id)
                || st.resolved_ids.contains(&info.repo_id)
                || e.names(owner, name)
                || e.names(&info.owner_id, &info.name))
    }

    /// The listed names that might stand for `info` but are not resolved yet: entries whose
    /// owner is a DPNS name and whose repository name is `info`'s, with no read, a failed read,
    /// or an absent repository when last read (looked at again after [`ABSENT_RECHECK`]).
    /// The server settles them before it serves `info` ([`Self::settle`]).
    pub fn unsettled_for(&self, info: &RepoInfo) -> Vec<NamedEntry> {
        let st = self.state_fresh();
        if st.entries.named.is_empty() {
            return Vec::new();
        }
        let Some(name) = name_key(&info.name) else {
            return Vec::new();
        };
        st.entries
            .named_entries_called(&name)
            .filter(|e| match st.resolved.get(&e.key) {
                None => true,
                Some(r) if !r.read => true,
                Some(r) => r.repo_id.is_none() && r.at.elapsed() >= ABSENT_RECHECK,
            })
            .collect()
    }

    /// Read the repositories `entries` stand for. `false` when a read failed: the caller cannot
    /// tell whether the repository is listed and must not serve it.
    pub async fn settle(&self, upstream: &dyn Upstream, entries: Vec<NamedEntry>) -> bool {
        let Ok(_permit) = self.inline_settles.try_acquire() else {
            return false;
        };
        let mut all_read = true;
        for e in entries {
            all_read &= self.read_entry(upstream, &e).await;
        }
        all_read
    }

    /// Read one listed name; `true` when the read worked.
    async fn read_entry(&self, upstream: &dyn Upstream, e: &NamedEntry) -> bool {
        let resolution = match upstream.resolve(&e.owner, &e.name).await {
            Ok(info) => Resolution {
                repo_id: info.map(|i| i.repo_id),
                at: Instant::now(),
                read: true,
            },
            Err(_) => Resolution {
                repo_id: None,
                at: Instant::now(),
                read: false,
            },
        };
        let read = resolution.read;
        let mut st = self.state();
        // The list may have changed while Platform was read.
        if st.entries.named.contains_key(&e.key) {
            if let Some(id) = &resolution.repo_id {
                st.resolved_ids.insert(id.clone());
            }
            st.resolved.insert(e.key.clone(), resolution);
        }
        read
    }

    /// Read the repositories the listed names stand for, so a request that names one by its
    /// owner's id is refused too. A few names a pass; the ones that could not be read, or are
    /// not there yet, are tried again later. `true` when a name resolved to a new repository.
    pub async fn resolve_names(&self, upstream: &dyn Upstream) -> bool {
        let due: Vec<NamedEntry> = {
            let st = self.state_fresh();
            st.entries
                .named_entries()
                .filter(|e| match st.resolved.get(&e.key) {
                    None => true,
                    Some(r) if !r.read => r.at.elapsed() >= READ_RETRY,
                    Some(r) => r.repo_id.is_none() && r.at.elapsed() >= ABSENT_RETRY,
                })
                .take(RESOLVE_PER_PASS)
                .collect()
        };
        let before = self.state().resolved_ids.len();
        for e in &due {
            self.read_entry(upstream, e).await;
        }
        self.state().resolved_ids.len() > before
    }
}

impl Default for DenyList {
    fn default() -> Self {
        Self::none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Valid Platform ids (32 bytes in base58).
    const OWNER_ID: &str = "3JF3sEqM796hk5WFqA6EtmEwJQ9quALszsfJyvXNQKy3";
    const REPO_A: &str = "29d2S7vB453rNYFdR5Ycwt7y9haRT5fwVwL9zTmBhfV2";
    const REPO_B: &str = "4Ss5JMkXAD9Z7cktFEdrqeMuT6jGMF1pVozTyPHZ6zT4";

    fn info(repo: &str, owner: &str, name: &str) -> RepoInfo {
        RepoInfo {
            repo_id: repo.into(),
            owner_id: owner.into(),
            name: name.into(),
            public: true,
        }
    }

    /// A list over `text` in a temporary file, applied at once.
    fn list(text: &str) -> (DenyList, tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("deny");
        std::fs::write(&file, text).unwrap();
        (
            DenyList::with_settle(Some(file.clone()), Duration::ZERO, Duration::ZERO),
            dir,
            file,
        )
    }

    #[test]
    fn lines_parse_into_ids_and_names() {
        let (e, rejected) = Entries::parse(&format!(
            "# takedowns\n\n  {REPO_A}  # notice 1\n{OWNER_ID}\nalice/proj.git\nalice/proj\nBob/Tool # again\nbad line\n/x\na/b/c\nalice/\nRepoA\n{OWNER_ID}/thing\n"
        ));
        assert_eq!(
            e.ids,
            HashSet::from([REPO_A.to_string(), OWNER_ID.to_string()])
        );
        // `.git` and case are not part of a name, a repeated entry is kept once, and an owner
        // that is an id is kept exactly.
        let keys: HashSet<Key> = e.named.keys().cloned().collect();
        assert_eq!(
            keys,
            HashSet::from([
                (Owner::Name(dpns_normalize("alice")), "proj".to_string()),
                (Owner::Name(dpns_normalize("bob")), "tool".to_string()),
                (Owner::Id(OWNER_ID.to_string()), "thing".to_string()),
            ])
        );
        // A bare token that is not an id (S1) is rejected, not stored as one.
        assert_eq!(rejected, vec![8, 9, 10, 11, 12]);
        assert_eq!(e.len(), 5);
        assert!(Entries::parse("# nothing\n\n").0.is_empty());
    }

    #[test]
    fn names_match_however_platform_would_spell_them() {
        let (l, _dir, _f) = list("Alice/Proj.git\n");
        // Before any resolution has run: case, `.git`, `.dash` and homographs.
        for (owner, name) in [
            ("alice", "proj"),
            ("ALICE", "PROJ"),
            ("Alice", "proj.git"),
            ("alice.dash", "proj"),
            ("Alice.DASH", "Proj.GIT"),
            ("a1ice", "proj"),
            ("a11ce", "proj"),
            ("aLiCe", "proj"),
        ] {
            assert!(l.denies_request(owner, name), "{owner}/{name}");
        }
        for (owner, name) in [
            ("alice", "proj2"),
            ("alice", "other"),
            ("alic", "proj"),
            ("mallory", "proj"),
            ("alice", "-bad"),
        ] {
            assert!(!l.denies_request(owner, name), "{owner}/{name}");
        }
        // An id owner is exact, and is not folded like a name.
        let (l, _dir, _f) = list(&format!("{OWNER_ID}/Thing\n"));
        assert!(l.denies_request(OWNER_ID, "thing"));
        assert!(l.denies_request(OWNER_ID, "THING.git"));
        assert!(!l.denies_request(&OWNER_ID.to_ascii_lowercase(), "thing"));
        // The record's own spelling is compared too: owner id and name from the repository.
        assert!(l.denies(&info(REPO_A, OWNER_ID, "thing"), "alice", "thing"));
        assert!(!l.denies(&info(REPO_A, OWNER_ID, "other"), "alice", "other"));
    }

    #[test]
    fn decisions_cover_ids_owners_and_names() {
        let (l, _dir, file) = list(&format!("{REPO_A}\n{OWNER_ID}\nalice/proj\n"));
        assert_eq!(l.len(), 3);
        // By repository id, and by the owner's id.
        assert!(l.denies(&info(REPO_A, "O1", "x"), "O1", "x"));
        assert!(l.denies(&info(REPO_B, OWNER_ID, "x"), OWNER_ID, "x"));
        // By the name a request used.
        assert!(l.denies(&info(REPO_B, "O2", "proj"), "alice", "proj"));
        assert!(l.denies_request("ALICE", "proj"));
        assert!(!l.denies_request("alice", "other"));
        assert!(!l.denies_request("mallory", "proj"));
        // Anything else is served.
        assert!(!l.denies(&info(REPO_B, "O2", "x"), "O2", "x"));

        // `<owner id>/<name>` refuses that repository, whatever the request called its owner.
        std::fs::write(&file, format!("{OWNER_ID}/thing\n")).unwrap();
        assert!(l.reload_now());
        assert!(l.denies(&info(REPO_B, OWNER_ID, "thing"), "alice", "thing"));
        assert!(!l.denies(&info(REPO_B, OWNER_ID, "other"), "alice", "other"));
        assert!(!l.denies(&info(REPO_B, "O2", "thing"), "bob", "thing"));
    }

    #[test]
    fn a_name_not_resolved_yet_is_unsettled_for_a_repository_of_that_name() {
        let (l, _dir, _f) = list(&format!("alice/Proj\n{OWNER_ID}/thing\n"));
        // The owner-id spelling of `alice/proj` is not caught by the names: the server must
        // settle the entry before it serves a repository called `proj`.
        let repo = info(REPO_B, "O2", "Proj");
        assert!(!l.denies(&repo, "O2", "Proj"));
        let pending = l.unsettled_for(&repo);
        assert_eq!(pending.len(), 1);
        assert_eq!(
            (pending[0].owner.as_str(), pending[0].name.as_str()),
            ("alice", "proj")
        );
        // Another name has nothing pending, and an id-owner entry never does.
        assert!(l.unsettled_for(&info(REPO_B, "O2", "other")).is_empty());
        assert!(l.unsettled_for(&info(REPO_B, "O2", "thing")).is_empty());
    }

    #[test]
    fn the_file_is_reread_when_it_changes_and_survives_going_wrong() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("deny");
        // Not there yet: nothing is denied and nothing is loaded; creating it applies it.
        let l = DenyList::with_settle(Some(file.clone()), Duration::ZERO, Duration::ZERO);
        assert!(l.is_empty() && l.configured() && !l.loaded() && l.unreadable());
        let g0 = l.generation();
        std::fs::write(&file, format!("{REPO_A}\n")).unwrap();
        assert!(l.denies(&info(REPO_A, "O", "n"), "O", "n"));
        assert!(l.generation() > g0 && l.loaded() && !l.unreadable());

        // Changed: the new list replaces the old one.
        std::fs::write(&file, format!("{REPO_B}\n{OWNER_ID}\n")).unwrap();
        assert!(!l.denies(&info(REPO_A, "O", "n"), "O", "n"));
        assert!(l.denies(&info(REPO_B, "O", "n"), "O", "n"));

        // Deleted or too large: the last good list stays, and the state says it is stale.
        std::fs::remove_file(&file).unwrap();
        assert!(l.denies(&info(REPO_B, "O", "n"), "O", "n"));
        assert!(l.unreadable());
        std::fs::write(
            &file,
            vec![b'a'; usize::try_from(MAX_FILE_BYTES).unwrap() + 1],
        )
        .unwrap();
        assert!(l.denies(&info(REPO_B, "O", "n"), "O", "n"));

        // Emptied: nothing is denied.
        std::fs::write(&file, "# lifted\n").unwrap();
        assert!(l.is_empty() && !l.unreadable());
        assert!(!l.denies(&info(REPO_B, "O", "n"), "O", "n"));
    }

    #[test]
    fn the_file_is_looked_at_once_per_interval() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("deny");
        std::fs::write(&file, format!("{REPO_A}\n")).unwrap();
        let l = DenyList::with_settle(
            Some(file.clone()),
            Duration::from_secs(3600),
            Duration::ZERO,
        );
        std::fs::write(&file, format!("{REPO_B}\n\n")).unwrap();
        // Within the interval the edit is not seen yet; `reload_now` sees it.
        assert!(l.denies(&info(REPO_A, "O", "n"), "O", "n"));
        assert!(l.reload_now());
        assert!(l.denies(&info(REPO_B, "O", "n"), "O", "n"));
    }

    #[test]
    fn a_file_just_written_waits_until_it_has_settled() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("deny");
        std::fs::write(&file, format!("{REPO_A}\n")).unwrap();
        // The startup load does not wait; later periodic looks apply a file only once it has
        // not been modified for the settle time.
        let l = DenyList::with_settle(
            Some(file.clone()),
            Duration::ZERO,
            Duration::from_secs(3600),
        );
        assert!(l.denies(&info(REPO_A, "O", "n"), "O", "n"));
        std::fs::write(&file, format!("{REPO_B}\n\n")).unwrap();
        assert!(
            !l.denies(&info(REPO_B, "O", "n"), "O", "n"),
            "possibly half-written"
        );
        assert!(l.denies(&info(REPO_A, "O", "n"), "O", "n"));
        // An operator's explicit reload does not wait.
        assert!(l.reload_now());
        assert!(l.denies(&info(REPO_B, "O", "n"), "O", "n"));
    }

    #[test]
    fn no_file_denies_nothing() {
        let l = DenyList::none();
        assert!(l.is_empty() && !l.configured() && !l.loaded());
        assert!(!l.denies_request("alice", "proj"));
        assert!(!l.denies(&info("R", "O", "n"), "O", "n"));
        assert!(!l.reload_now());
    }
}
