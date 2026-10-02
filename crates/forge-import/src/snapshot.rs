//! The source read, cached beside `--state` so a run that dies part-way through its writes
//! resumes writing within minutes instead of reading the source again.
//!
//! Reading a large repository is the slow part of a run: dashpay/dash (about 7,700 issues and
//! PRs) takes nearly two hours and ten thousand GitHub API calls. A run that fails during its
//! writes left all of that behind. The snapshot keeps it: `<state>.source.json` holds what the
//! last read returned, keyed by the run's scope (source, classes, limit), the `since` it read
//! with and the merges it revisited, and stamped with when that read started.
//!
//! A run that finds a matching snapshot whose full read is younger than [`MAX_AGE_SECS`] does
//! not read everything again: it asks the source only for what changed since the snapshot's
//! last read or refresh started (less an overlap), and merges that in ([`merge`]). What is
//! already mirrored is still decided on chain, item by item, so the snapshot can only make a
//! run read less, never write twice. The snapshot is removed once a run completes and advances
//! `--state`. It can hold a private repository's plaintext, so only its owner may read it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use forge_core::collab::Imported;

use crate::model::{SrcCollab, SrcTarget};

/// The oldest full read a run reuses, however often it was refreshed since. Past this, the
/// source is read in full again, so edits to old comments, deleted items, and parts a read could
/// not list are picked up at least once a day.
const MAX_AGE_SECS: u64 = 24 * 3600;

/// Re-read this much before the snapshot's read started, so an item updated while that read
/// was running is seen again (it is diffed on chain, so seeing it twice costs nothing).
const OVERLAP_SECS: u64 = 600;

/// The snapshot file's format; a file of another format is ignored.
const FORMAT: u32 = 1;

/// What the snapshot file holds (`C`: the read, owned when loaded, borrowed when saved).
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotFile<C> {
    format: u32,
    /// The run's scope ([`crate::state::scope`]: source, classes, limit, version).
    scope: String,
    /// The `since` the read was made with (`None`: a full read).
    since: Option<String>,
    /// The merges it revisited ([`crate::state::SyncState::revisit`]).
    revisit: Vec<u32>,
    /// Unix seconds when the full read started (what [`MAX_AGE_SECS`] is measured from).
    read_at: u64,
    /// Unix seconds when the read or its last refresh started.
    fetched_at: u64,
    collab: C,
}

/// A snapshot that matched the run, ready to be refreshed.
pub struct Cached {
    /// When its full read started, unix seconds.
    pub read_at: u64,
    /// When its read or last refresh started, unix seconds.
    pub fetched_at: u64,
    /// What it holds.
    pub collab: SrcCollab,
}

impl Cached {
    /// The `since` to ask the source with for what changed after this snapshot (ISO 8601).
    pub fn refresh_since(&self) -> String {
        crate::github::unix_to_iso8601(self.fetched_at.saturating_sub(OVERLAP_SECS))
    }
}

/// The snapshot of a run's source read, at [`path_for`] its `--state` file.
pub struct Snapshot {
    path: PathBuf,
    scope: String,
    since: Option<String>,
    revisit: Vec<u32>,
}

/// Where the snapshot for state file `state` lives: beside it, `<state stem>.source.json`
/// (`dash.sync.json` → `dash.sync.source.json`).
pub fn path_for(state: &Path) -> PathBuf {
    state.with_extension("source.json")
}

impl Snapshot {
    /// The snapshot beside `state` for a run of `scope` reading with `since` and revisiting
    /// `revisit`.
    pub fn new(state: &Path, scope: &str, since: Option<&str>, revisit: &[u32]) -> Self {
        Self {
            path: path_for(state),
            scope: scope.to_string(),
            since: since.map(str::to_string),
            revisit: revisit.to_vec(),
        }
    }

    /// The file this snapshot is kept in.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The snapshot, when the file holds one for this run whose full read is younger than
    /// [`MAX_AGE_SECS`] at `now`. Anything else (no file, another scope or `since`, too old,
    /// unreadable) is `None`: the run reads the source in full.
    pub fn load(&self, now: u64) -> Option<Cached> {
        let bytes = std::fs::read(&self.path).ok()?;
        let file: SnapshotFile<SrcCollab> = match serde_json::from_slice(&bytes) {
            Ok(f) => f,
            Err(e) => {
                tracing::warn!(path = %self.path.display(), error = %e, "ignoring an unreadable source snapshot");
                return None;
            }
        };
        let matches = file.format == FORMAT
            && file.scope == self.scope
            && file.since == self.since
            && file.revisit == self.revisit;
        if !matches {
            tracing::info!(path = %self.path.display(), "the source snapshot is for another run; reading the source in full");
            return None;
        }
        // A clock that went backwards makes the snapshot "from the future": not trusted.
        if file.read_at > now || file.fetched_at > now || now - file.read_at > MAX_AGE_SECS {
            tracing::info!(path = %self.path.display(), "the source snapshot is too old; reading the source in full");
            return None;
        }
        Some(Cached {
            read_at: file.read_at,
            fetched_at: file.fetched_at,
            collab: file.collab,
        })
    }

    /// Save `collab`, fully read starting at `read_at` and last refreshed starting at
    /// `fetched_at`. Written to a temporary file (readable by its owner only) and renamed, so a
    /// run killed mid-write leaves the previous snapshot or none.
    pub fn save(&self, read_at: u64, fetched_at: u64, collab: &SrcCollab) -> Result<()> {
        let file = SnapshotFile {
            format: FORMAT,
            scope: self.scope.clone(),
            since: self.since.clone(),
            revisit: self.revisit.clone(),
            read_at,
            fetched_at,
            collab,
        };
        if let Some(dir) = self.path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
        let mut tmp = self.path.clone().into_os_string();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        let written = (|| -> Result<()> {
            let mut out = std::io::BufWriter::new(private_file(&tmp)?);
            serde_json::to_writer(&mut out, &file)?;
            std::io::Write::flush(&mut out)?;
            Ok(())
        })();
        if let Err(e) = written {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.context(format!("writing {}", tmp.display())));
        }
        std::fs::rename(&tmp, &self.path)
            .with_context(|| format!("writing {}", self.path.display()))
    }

    /// Remove the snapshot (the run it was kept for completed).
    pub fn remove(&self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// A new file at `path` (truncated if there is one) that only its owner can read.
fn private_file(path: &Path) -> std::io::Result<std::fs::File> {
    let mut open = std::fs::OpenOptions::new();
    open.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut open, 0o600);
    open.open(path)
}

/// `base` (a snapshot) brought up to date with `fresh` (what the source returned for the items
/// that changed since): an item in both takes `fresh`'s fields, and its comments and reviews
/// are the union by source URL (`fresh`'s copy wins), because a windowed read can return only
/// the comments updated in its window. Items only in `fresh` are added. Labels, releases and
/// the open PRs are read in full every time, so `fresh`'s replace `base`'s. Warnings are
/// joined, and the result is incomplete if either read was. `sort` puts the items back in
/// source order ([`crate::source::Source::sort_targets`]).
pub fn merge(base: SrcCollab, fresh: SrcCollab, sort: impl FnOnce(&mut [SrcTarget])) -> SrcCollab {
    let key = |t: &SrcTarget| (t.kind.transition_target().code(), t.number);
    let mut fresh_targets: BTreeMap<(u8, u32), SrcTarget> =
        fresh.targets.into_iter().map(|t| (key(&t), t)).collect();
    let mut targets: Vec<SrcTarget> = base
        .targets
        .into_iter()
        .map(|old| match fresh_targets.remove(&key(&old)) {
            Some(new) => merge_target(old, new),
            None => old,
        })
        .collect();
    targets.extend(fresh_targets.into_values());
    sort(&mut targets);
    let mut warnings = base.warnings;
    for w in fresh.warnings {
        if !warnings.contains(&w) {
            warnings.push(w);
        }
    }
    SrcCollab {
        targets,
        labels: fresh.labels.or(base.labels),
        releases: fresh.releases.or(base.releases),
        truncated: base.truncated || fresh.truncated,
        incomplete: base.incomplete || fresh.incomplete,
        open_pulls: fresh.open_pulls.or(base.open_pulls),
        warnings,
        incremental: base.incremental,
        refused: base.refused,
    }
}

/// One item read twice: `new`'s fields, with `old`'s comments and reviews that `new` lacks
/// (by source URL) kept, in source time order.
fn merge_target(old: SrcTarget, mut new: SrcTarget) -> SrcTarget {
    keep_unseen(old.comments, &mut new.comments, |c| &c.imported);
    keep_unseen(old.reviews, &mut new.reviews, |r| &r.imported);
    new
}

/// Add to `new` the entries of `old` whose source URL it lacks, then put them in source time
/// order (stable: entries of the same second keep the order they were read in).
fn keep_unseen<T>(old: Vec<T>, new: &mut Vec<T>, imported: impl Fn(&T) -> &Imported) {
    let have: std::collections::BTreeSet<&str> =
        new.iter().map(|e| imported(e).url.as_str()).collect();
    let mut kept: Vec<T> = old
        .into_iter()
        .filter(|e| !have.contains(imported(e).url.as_str()))
        .collect();
    if kept.is_empty() {
        return;
    }
    kept.append(new);
    kept.sort_by_key(|e| imported(e).created_at);
    *new = kept;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{SrcComment, SrcLabel};
    use forge_core::collab::v2::TargetKind;

    fn imported(url: &str, at: u64) -> Imported {
        Imported {
            author: "a".into(),
            created_at: at,
            url: url.into(),
        }
    }

    fn comment(n: u32, id: u32, at: u64, body: &str) -> SrcComment {
        SrcComment {
            body: body.into(),
            imported: imported(
                &format!("https://github.com/o/r/issues/{n}#issuecomment-{id}"),
                at,
            ),
            anchor: None,
            reply_key: None,
            review_key: None,
        }
    }

    fn item(n: u32, title: &str, comments: Vec<SrcComment>) -> SrcTarget {
        SrcTarget {
            kind: TargetKind::Issue,
            number: n,
            title: title.into(),
            body: String::new(),
            imported: imported(&format!("https://github.com/o/r/issues/{n}"), u64::from(n)),
            closed: false,
            close_reason: None,
            merged_oid: None,
            merged_without_sha: false,
            labels: std::collections::BTreeSet::new(),
            draft: false,
            patch: None,
            comments,
            reviews: Vec::new(),
        }
    }

    fn by_number(t: &mut [SrcTarget]) {
        t.sort_by_key(|t| t.number);
    }

    #[test]
    fn a_snapshot_round_trips_and_only_matches_its_own_run() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("dash.sync.json");
        assert_eq!(path_for(&state), dir.path().join("dash.sync.source.json"));
        let collab = SrcCollab {
            targets: vec![item(1, "one", vec![comment(1, 10, 5, "hi")])],
            labels: Some(vec![SrcLabel {
                name: "bug".into(),
                color: "ff0000".into(),
                description: String::new(),
            }]),
            warnings: vec!["w".into()],
            ..SrcCollab::default()
        };
        let snap = Snapshot::new(&state, "scope", None, &[]);
        assert!(snap.load(1_000).is_none(), "no file yet");
        snap.save(1_000, 1_000, &collab).unwrap();
        let back = snap.load(1_500).expect("matches");
        assert_eq!(back.fetched_at, 1_000);
        assert_eq!(back.collab.targets.len(), 1);
        assert_eq!(back.collab.targets[0].comments[0].body, "hi");
        assert_eq!(back.collab.labels.as_ref().unwrap()[0].name, "bug");
        assert_eq!(back.refresh_since(), crate::github::unix_to_iso8601(400));
        // Another scope, `since` or revisit list, too old, or from the future: not reused.
        assert!(Snapshot::new(&state, "other", None, &[])
            .load(1_500)
            .is_none());
        assert!(
            Snapshot::new(&state, "scope", Some("2026-01-01T00:00:00Z"), &[])
                .load(1_500)
                .is_none()
        );
        assert!(Snapshot::new(&state, "scope", None, &[7])
            .load(1_500)
            .is_none());
        assert!(snap.load(1_000 + MAX_AGE_SECS + 1).is_none());
        assert!(snap.load(999).is_none());
        // Refreshed lately, but its full read is over a day old: read in full again.
        snap.save(1_000, 80_000, &collab).unwrap();
        assert!(snap.load(80_100).is_some_and(|c| c.read_at == 1_000));
        assert!(snap.load(1_000 + MAX_AGE_SECS + 1).is_none());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(snap.path()).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0, "its owner's only: {mode:o}");
        }
        // A damaged file is ignored, never an error.
        std::fs::write(snap.path(), b"{nope").unwrap();
        assert!(snap.load(1_500).is_none());
        snap.save(1_000, 1_000, &collab).unwrap();
        snap.remove();
        assert!(!snap.path().exists());
    }

    /// A refresh replaces what changed, keeps the comments a windowed read did not return, adds
    /// new items in source order, and takes the fully-read lists from the refresh.
    #[test]
    fn a_refresh_is_merged_into_the_snapshot() {
        let base = SrcCollab {
            targets: vec![
                item(
                    1,
                    "one",
                    vec![comment(1, 10, 5, "old"), comment(1, 11, 6, "kept")],
                ),
                item(2, "two", Vec::new()),
                item(4, "four", Vec::new()),
            ],
            labels: Some(Vec::new()),
            open_pulls: Some(vec![2]),
            warnings: vec!["from the first read".into()],
            ..SrcCollab::default()
        };
        let fresh = SrcCollab {
            targets: vec![
                // #1 retitled, its first comment edited, a new comment; the window did not
                // return #1's second comment.
                item(
                    1,
                    "one!",
                    vec![comment(1, 10, 5, "edited"), comment(1, 12, 9, "new")],
                ),
                // #3 is new, and sorts between #2 and #4.
                item(3, "three", Vec::new()),
            ],
            labels: Some(vec![SrcLabel {
                name: "new".into(),
                color: "00ff00".into(),
                description: String::new(),
            }]),
            open_pulls: Some(vec![]),
            incomplete: true,
            warnings: vec!["from the first read".into(), "from the refresh".into()],
            ..SrcCollab::default()
        };
        let merged = merge(base, fresh, by_number);
        let numbers: Vec<u32> = merged.targets.iter().map(|t| t.number).collect();
        assert_eq!(numbers, [1, 2, 3, 4]);
        let one = &merged.targets[0];
        assert_eq!(one.title, "one!");
        let bodies: Vec<&str> = one.comments.iter().map(|c| c.body.as_str()).collect();
        assert_eq!(bodies, ["edited", "kept", "new"]);
        assert_eq!(merged.labels.unwrap()[0].name, "new");
        assert_eq!(merged.open_pulls, Some(vec![]));
        assert!(
            merged.incomplete,
            "either read incomplete: the run is partial"
        );
        assert_eq!(merged.warnings, ["from the first read", "from the refresh"]);
    }
}
