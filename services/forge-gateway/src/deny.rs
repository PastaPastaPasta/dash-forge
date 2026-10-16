//! The operator's deny list (`GATEWAY_DENY`): repositories and owners this gateway refuses with
//! `451 Unavailable For Legal Reasons` (RFC 7725), for a valid notice against one repository or
//! one identity's repositories. A refusal is the gateway's alone: the repository stays on Dash
//! Platform and `git clone dash://…` (git-remote-dash) still reads it.
//!
//! The file has one entry per line, `#` starts a comment:
//!
//! ```text
//! 7xK3...repoId                  # a repository, by its id
//! 5Ey9...ownerId                 # every repository of an identity
//! alice/project                  # <owner id or DPNS name>/<repository name>
//! ```
//!
//! It is read when the gateway starts and again when its modification time or size changes
//! (checked at most every [`CHECK_EVERY`], by whoever asks), so no restart is needed. A list that
//! cannot be read or is too large is not applied and the last good one stays: a takedown
//! never lapses because an editor left the file half-written. To lift every entry, empty the
//! file (do not delete it).
//!
//! A name is matched as the request wrote it, and again as the ids it resolves to
//! ([`DenyList::denies`]); [`DenyList::resolve_names`] resolves the listed names in the
//! background, so `alice/project` also refuses the request that names the repository by its
//! owner's id.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use crate::upstream::{RepoInfo, Upstream};

/// How often the file's modification time is looked at (at most).
pub const CHECK_EVERY: Duration = Duration::from_secs(5);

/// The largest deny file read.
const MAX_FILE_BYTES: u64 = 4 << 20;

/// How many listed names one [`DenyList::resolve_names`] pass reads.
const RESOLVE_PER_PASS: usize = 32;

/// A name that could not be read is tried again after this; one that read as absent (the
/// repository may not exist yet) after [`ABSENT_RETRY`].
const READ_RETRY: Duration = Duration::from_secs(60);
const ABSENT_RETRY: Duration = Duration::from_secs(600);

/// A deny list's lines, parsed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Entries {
    /// Repository ids and owner identity ids.
    ids: HashSet<String>,
    /// `(owner, name)`: the owner an identity id or a DPNS name.
    named: Vec<(String, String)>,
}

/// Whether `s` is an identifier as Platform writes one (base58, 32 to 50 characters) rather
/// than a DPNS name.
fn is_identifier(s: &str) -> bool {
    (32..=50).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() && !b"0OIl".contains(&b))
}

fn token_ok(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && !s.starts_with('.')
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
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
            match line.split_once('/') {
                None if token_ok(line, 64) => {
                    out.ids.insert(line.to_string());
                }
                Some((owner, name)) if token_ok(owner, 64) => {
                    let name = name.strip_suffix(".git").unwrap_or(name);
                    if token_ok(name, 100) {
                        let entry = (owner.to_string(), name.to_string());
                        if !out.named.contains(&entry) {
                            out.named.push(entry);
                        }
                    } else {
                        rejected.push(i + 1);
                    }
                }
                _ => rejected.push(i + 1),
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

    /// Whether `owner/name`, as a request or a listing wrote them, is listed. A DPNS name
    /// matches without regard to case; an id and a repository name exactly.
    fn names(&self, owner: &str, name: &str) -> bool {
        self.named.iter().any(|(o, n)| {
            n == name && (o == owner || (!is_identifier(o) && o.eq_ignore_ascii_case(owner)))
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
    resolved: HashMap<(String, String), Resolution>,
    /// The ids in `resolved`, for the lookup.
    resolved_ids: HashSet<String>,
    generation: u64,
    /// The file was found missing or unreadable (logged once per episode).
    unreadable: bool,
}

/// The list, from `GATEWAY_DENY`.
#[derive(Debug)]
pub struct DenyList {
    path: Option<PathBuf>,
    every: Duration,
    state: Mutex<State>,
}

impl DenyList {
    /// The list in `path` (`None`: nothing is denied), read now and re-read when it changes.
    pub fn new(path: Option<PathBuf>, every: Duration) -> Self {
        let list = Self {
            path,
            every,
            state: Mutex::default(),
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

    /// Look at the file now, if its stamp moved apply it. `true` when the list changed.
    pub fn reload_now(&self) -> bool {
        let mut st = self.state();
        st.checked = Some(Instant::now());
        self.load(&mut st)
    }

    /// Look at the file if it was last looked at more than `every` ago.
    fn state_fresh(&self) -> MutexGuard<'_, State> {
        let mut st = self.state();
        if self.path.is_some() && st.checked.is_none_or(|t| t.elapsed() >= self.every) {
            st.checked = Some(Instant::now());
            self.load(&mut st);
        }
        st
    }

    fn load(&self, st: &mut State) -> bool {
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
            // Not there (yet): nothing is denied until it is. The same state after a list was
            // loaded keeps that list.
            Err(e) => return unreadable(st, e.to_string()),
        };
        let stamp = (
            meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            meta.len(),
        );
        if st.stamp == Some(stamp) {
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
        st.stamp = Some(stamp);
        st.generation += 1;
        // What was resolved stays for the names still listed.
        st.resolved
            .retain(|k, _| entries.named.iter().any(|(o, n)| (o, n) == (&k.0, &k.1)));
        st.resolved_ids = st
            .resolved
            .values()
            .filter_map(|r| r.repo_id.clone())
            .collect();
        st.entries = Arc::new(entries);
        true
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

    /// Read the repositories the listed names stand for, so a request that names one by its
    /// owner's id is refused too. A few names a pass; the ones that could not be read, or are
    /// not there yet, are tried again later. `true` when a name resolved to a new repository.
    pub async fn resolve_names(&self, upstream: &dyn Upstream) -> bool {
        let due: Vec<(String, String)> = {
            let st = self.state_fresh();
            st.entries
                .named
                .iter()
                .filter(|k| match st.resolved.get(*k) {
                    None => true,
                    Some(r) if !r.read => r.at.elapsed() >= READ_RETRY,
                    Some(r) => r.repo_id.is_none() && r.at.elapsed() >= ABSENT_RETRY,
                })
                .take(RESOLVE_PER_PASS)
                .cloned()
                .collect()
        };
        let mut found = false;
        for key in due {
            let read = upstream.resolve(&key.0, &key.1).await;
            let resolution = match read {
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
            let mut st = self.state();
            // The list may have changed while Platform was read.
            if !st.entries.named.contains(&key) {
                continue;
            }
            if let Some(id) = &resolution.repo_id {
                found |= st.resolved_ids.insert(id.clone());
            }
            st.resolved.insert(key, resolution);
        }
        found
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

    const OWNER_ID: &str = "5Ey9uWQXnJcBq8d2YxgxJmzS6b7tK3mRnLpVfTaHcDeA";

    fn info(repo: &str, owner: &str, name: &str) -> RepoInfo {
        RepoInfo {
            repo_id: repo.into(),
            owner_id: owner.into(),
            name: name.into(),
            public: true,
        }
    }

    #[test]
    fn lines_parse_into_ids_and_names() {
        let (e, rejected) = Entries::parse(&format!(
            "# takedowns\n\n  RepoA  # notice 1\n{OWNER_ID}\nalice/proj.git\nalice/proj\nBob/Tool # again\nbad line\n/x\na/b/c\nalice/\n"
        ));
        assert_eq!(
            e.ids,
            HashSet::from(["RepoA".to_string(), OWNER_ID.to_string()])
        );
        // `.git` is not part of a name, and a repeated entry is kept once.
        assert_eq!(
            e.named,
            vec![
                ("alice".to_string(), "proj".to_string()),
                ("Bob".to_string(), "Tool".to_string())
            ]
        );
        assert_eq!(rejected, vec![8, 9, 10, 11]);
        assert_eq!(e.len(), 4);
        assert!(Entries::parse("# nothing\n\n").0.is_empty());
    }

    #[test]
    fn decisions_cover_ids_owners_and_names() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("deny");
        std::fs::write(&file, format!("RepoA\n{OWNER_ID}\nalice/proj\n")).unwrap();
        let list = DenyList::new(Some(file.clone()), Duration::ZERO);
        assert_eq!(list.len(), 3);

        // By repository id, and by the owner's id.
        assert!(list.denies(&info("RepoA", "O1", "x"), "O1", "x"));
        assert!(list.denies(&info("RepoZ", OWNER_ID, "x"), OWNER_ID, "x"));
        // By the name a request used, DPNS names without regard to case, repository names
        // exactly.
        assert!(list.denies_request("alice", "proj"));
        assert!(list.denies_request("ALICE", "proj"));
        assert!(!list.denies_request("alice", "Proj"));
        assert!(!list.denies_request("alice", "other"));
        assert!(!list.denies_request("mallory", "proj"));
        assert!(list.denies(&info("RepoZ", "O2", "proj"), "alice", "proj"));
        // Anything else is served.
        assert!(!list.denies(&info("RepoZ", "O2", "x"), "O2", "x"));

        // `<owner id>/<name>` refuses that repository, whatever the request called its owner.
        std::fs::write(&file, format!("{OWNER_ID}/thing\n")).unwrap();
        assert!(list.reload_now());
        assert!(list.denies(&info("RepoZ", OWNER_ID, "thing"), "alice", "thing"));
        assert!(!list.denies(&info("RepoZ", OWNER_ID, "other"), "alice", "other"));
        assert!(!list.denies(&info("RepoZ", "O2", "thing"), "bob", "thing"));
    }

    #[test]
    fn the_file_is_reread_when_it_changes_and_survives_going_wrong() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("deny");
        // Not there yet: nothing is denied, and creating it applies it.
        let list = DenyList::new(Some(file.clone()), Duration::ZERO);
        assert!(list.is_empty());
        let g0 = list.generation();
        std::fs::write(&file, "RepoA\n").unwrap();
        assert!(list.denies(&info("RepoA", "O", "n"), "O", "n"));
        assert!(list.generation() > g0);

        // Changed: the new list replaces the old one.
        std::fs::write(&file, "RepoB\nRepoCC\n").unwrap();
        assert!(!list.denies(&info("RepoA", "O", "n"), "O", "n"));
        assert!(list.denies(&info("RepoB", "O", "n"), "O", "n"));

        // Deleted or too large: the last good list stays.
        std::fs::remove_file(&file).unwrap();
        assert!(list.denies(&info("RepoB", "O", "n"), "O", "n"));
        std::fs::write(
            &file,
            vec![b'a'; usize::try_from(MAX_FILE_BYTES).unwrap() + 1],
        )
        .unwrap();
        assert!(list.denies(&info("RepoB", "O", "n"), "O", "n"));

        // Emptied: nothing is denied.
        std::fs::write(&file, "# lifted\n").unwrap();
        assert!(list.is_empty());
        assert!(!list.denies(&info("RepoB", "O", "n"), "O", "n"));
    }

    #[test]
    fn the_file_is_looked_at_once_per_interval() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("deny");
        std::fs::write(&file, "RepoA\n").unwrap();
        let list = DenyList::new(Some(file.clone()), Duration::from_secs(3600));
        std::fs::write(&file, "RepoBB\n").unwrap();
        // Within the interval the edit is not seen yet; `reload_now` sees it.
        assert!(list.denies(&info("RepoA", "O", "n"), "O", "n"));
        assert!(list.reload_now());
        assert!(list.denies(&info("RepoBB", "O", "n"), "O", "n"));
    }

    #[test]
    fn no_file_denies_nothing() {
        let list = DenyList::none();
        assert!(list.is_empty());
        assert!(!list.denies_request("alice", "proj"));
        assert!(!list.denies(&info("R", "O", "n"), "O", "n"));
        assert!(!list.reload_now());
    }
}
