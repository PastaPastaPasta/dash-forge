//! The history index (`packManifest.kind == 3`): for one tip commit, each path's first-parent
//! changes and the branch's exact commit count, computed at push time from the pusher's local
//! repository (`docs/design/history-index.md`).
//!
//! The web's file list shows each entry's last commit, and Blame and a path's History need the
//! commits that changed it. Without this index the browser walks history for them, one commit
//! and the trees along the path per step; with it, one artifact answers every path of the tip.
//!
//! Semantics match the web's walk (`forge-web/lib/view/commit-log.ts`, `path-history.ts`): a
//! path's change is a first-parent commit whose tree entry at that path (`mode:oid`) differs
//! from its first parent's, and a root commit adds everything. A path's list ends at the commit
//! that added it (the newest one, if it was deleted and added again). Directories are keyed by
//! their full path like files. One pass of
//! `git log --first-parent --diff-merges=first-parent --no-renames --root -t --raw -z` reports
//! exactly those changes: `-t` includes the changed trees, `--no-renames` makes a rename a
//! delete plus an add, and first-parent diffs show a merge as what it brought into the branch.
//!
//! Serialized, then gzip-compressed as a whole:
//!
//! ```text
//! "DFHI" | version u8 (1, or 2 with the versions section)
//! tip oid (20) | base packHash (32; zero for a full index)
//! commitCount v | firstParentCount v | rootTime v | tipTime v
//! nCommits v | (oid (20) | authorTime v | subjectLen v | subject)*
//! nPaths v   | (shared v | suffixLen v | suffix | commit v)*      byte-sorted, front-coded
//! (tag v | len v | bytes)*                                          extension sections
//! ```
//!
//! **Extending it.** Everything up to the paths is fixed for every version. What a later
//! version adds goes in a tagged section after them; a reader skips a tag it does not know, so
//! v1 readers read a v2 index (the last-change column and the counts) and ignore what v2 added.
//! `version` names the newest layout the writer used; a reader accepts any version from 1 on.
//!
//! **v2: the path versions section** (tag [`TAG_VERSIONS`]), one list per path row, in row order:
//!
//! ```text
//! limit v | oidLen u8
//! nAuthors v | (len v | name)*                   distinct author names
//! (author v)*                                     one per commit of the table, in its order
//! per path row: (count << 1 | complete) v | (commit v | mode v | oid prefix (oidLen))*
//! ```
//!
//! Each list names the path's newest first-parent changes, newest first, at most `limit`: the
//! commit (an index into the commit table), the path's mode after it and, for a blob mode (a
//! file or a symlink), the first `oidLen` bytes of its blob oid. A reader resolves the prefix
//! through the repository's object locator, so Blame reads each version with one object read and
//! no commit or tree reads. `complete` says the list reaches the commit that added the path: its
//! whole first-parent history. A count of 0 without `complete` says nothing is known.
//!
//! `v` is an LEB128 varint; times are author times in seconds. A **delta** index (non-zero
//! base) lists only the paths changed since its base's tip, and each of their lists holds only
//! the changes since then; its counts are its own tip's.

use super::build::{ensure_safe_rev, git_at};
use super::parse::OID_LEN;
use crate::error::{Error, Result};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{BufRead as _, Read as _, Write as _};
use std::path::Path;

const MAGIC: &[u8; 4] = b"DFHI";
/// The layout without the versions section.
const VERSION_V1: u8 = 1;
/// The layout with the path versions section ([`TAG_VERSIONS`]).
pub const VERSION_V2: u8 = 2;
/// The section tag of the per-path version lists (v2).
pub const TAG_VERSIONS: u64 = 1;
/// Changes listed per path. Blame compares at most 200 versions (201 entries; the web's
/// `BLAME_MAX_VERSIONS`), so a file blamed within that bound needs no walk, and a path's History
/// gets six 40-commit pages from the index. dashpay/dash's hottest file lists 490 changes.
pub const VERSIONS_PER_PATH: u32 = 256;
/// The most a reader accepts as a writer's per-path bound.
const MAX_VERSIONS_PER_PATH: u32 = 4096;
/// Bytes of each blob oid a version list stores: a 12-hex-digit prefix, the length git itself
/// abbreviates to in large repositories. Half the artifact of whole oids on dashpay/dash.
pub const OID_PREFIX_LEN: u8 = 6;
/// The shortest oid prefix a reader accepts.
const MIN_OID_PREFIX_LEN: u8 = 4;
/// A commit subject is clipped to this many bytes (at a UTF-8 boundary): the column shows one
/// truncated line. Author names are clipped the same way.
pub const SUBJECT_MAX: usize = 200;
/// Paths, commits and version entries one index may hold: far past any real tree, and a bound
/// for a reader parsing hostile bytes.
pub const MAX_ROWS: u64 = 4_000_000;
/// The most a history index may inflate to (dashpay/dash's v2 is ~1.6 MB): a gzip bomb stops
/// here.
pub const MAX_INFLATED: u64 = 64 * 1024 * 1024;
/// git's tree mode.
const MODE_TREE: u32 = 0o40000;
/// git's gitlink (submodule) mode.
const MODE_GITLINK: u32 = 0o160_000;

/// A blob mode (a file or a symlink): its version lists carry the blob's oid prefix.
pub fn is_blob_mode(mode: u32) -> bool {
    mode != MODE_TREE && mode != MODE_GITLINK
}

/// One commit an index refers to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexedCommit {
    /// Commit oid.
    pub oid: [u8; OID_LEN],
    /// Author time, seconds since the epoch.
    pub author_time: u64,
    /// First line of the message, trimmed, clipped to [`SUBJECT_MAX`] bytes.
    pub subject: String,
    /// The author's name, as the web reads it (clipped to [`SUBJECT_MAX`] bytes). Carried by the
    /// versions section: empty in an index without one.
    pub author: String,
}

/// `path → index into the commit table`, byte-ordered.
pub type PathMap = BTreeMap<Vec<u8>, u32>;

/// One change of a path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathVersion {
    /// The commit that changed it (an index into the commit table).
    pub commit: u32,
    /// The path's mode after that commit.
    pub mode: u32,
    /// For a blob mode: the first `oid_len` bytes of the blob oid after that commit. Empty for a
    /// directory or a gitlink.
    pub oid: Vec<u8>,
}

/// A path's newest first-parent changes, newest first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionList {
    pub versions: Vec<PathVersion>,
    /// The list reaches the commit that added the path: nothing older changed it.
    pub complete: bool,
}

/// The v2 versions section.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Versions {
    /// The most versions a list holds.
    pub limit: u32,
    /// Bytes of each blob oid kept.
    pub oid_len: u8,
    /// `path → its list`, for paths of the index (a path without one is unknown).
    pub lists: VersionLists,
}

/// `path → its version list`, byte-ordered.
pub type VersionLists = BTreeMap<Vec<u8>, VersionList>;

/// A parsed (or freshly built) history index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryIndex {
    /// The tip commit it describes.
    pub tip: [u8; OID_LEN],
    /// The full index this delta extends (its `packHash`), or `None` for a full index.
    pub base: Option<[u8; 32]>,
    /// `git rev-list --count <tip>`: every commit reachable from the tip.
    pub commit_count: u64,
    /// `git rev-list --first-parent --count <tip>`.
    pub first_parent_count: u64,
    /// Author time of the first-parent root commit (seconds).
    pub root_time: u64,
    /// Author time of the tip (seconds).
    pub tip_time: u64,
    /// The referenced commits, each once.
    pub commits: Vec<IndexedCommit>,
    /// `path → index into commits`, byte-ordered.
    pub paths: PathMap,
    /// The per-path version lists (v2), or `None` for a v1 index.
    pub versions: Option<Versions>,
}

impl HistoryIndex {
    /// The last change of `path`, if the index lists it.
    pub fn last_change(&self, path: &[u8]) -> Option<&IndexedCommit> {
        self.paths
            .get(path)
            .and_then(|&i| self.commits.get(i as usize))
    }

    /// The layout this index is written in: 2 with version lists, else 1.
    pub fn version(&self) -> u8 {
        if self.versions.is_some() {
            VERSION_V2
        } else {
            VERSION_V1
        }
    }

    /// Serialize and gzip.
    pub fn to_compressed(&self) -> Result<Vec<u8>> {
        let mut b = Vec::new();
        b.extend_from_slice(MAGIC);
        b.push(self.version());
        b.extend_from_slice(&self.tip);
        b.extend_from_slice(&self.base.unwrap_or([0; 32]));
        for v in [
            self.commit_count,
            self.first_parent_count,
            self.root_time,
            self.tip_time,
            self.commits.len() as u64,
        ] {
            write_varint(&mut b, v);
        }
        for c in &self.commits {
            b.extend_from_slice(&c.oid);
            write_varint(&mut b, c.author_time);
            write_varint(&mut b, c.subject.len() as u64);
            b.extend_from_slice(c.subject.as_bytes());
        }
        write_varint(&mut b, self.paths.len() as u64);
        let mut prev: &[u8] = &[];
        for (path, &commit) in &self.paths {
            let shared = prev.iter().zip(path).take_while(|(a, b)| a == b).count();
            write_varint(&mut b, shared as u64);
            write_varint(&mut b, (path.len() - shared) as u64);
            b.extend_from_slice(&path[shared..]);
            write_varint(&mut b, u64::from(commit));
            prev = path;
        }
        if let Some(v) = &self.versions {
            let section = self.versions_section(v)?;
            write_varint(&mut b, TAG_VERSIONS);
            write_varint(&mut b, section.len() as u64);
            b.extend_from_slice(&section);
        }
        let mut enc = GzEncoder::new(Vec::new(), Compression::new(9));
        enc.write_all(&b).map_err(|e| Error::Io(e.to_string()))?;
        enc.finish().map_err(|e| Error::Io(e.to_string()))
    }

    /// The body of the versions section.
    fn versions_section(&self, v: &Versions) -> Result<Vec<u8>> {
        let mut s = Vec::new();
        write_varint(&mut s, u64::from(v.limit));
        s.push(v.oid_len);
        let mut names: HashMap<&str, u64> = HashMap::new();
        let mut order: Vec<&str> = Vec::new();
        for c in &self.commits {
            if !names.contains_key(c.author.as_str()) {
                names.insert(&c.author, order.len() as u64);
                order.push(&c.author);
            }
        }
        write_varint(&mut s, order.len() as u64);
        for name in &order {
            write_varint(&mut s, name.len() as u64);
            s.extend_from_slice(name.as_bytes());
        }
        for c in &self.commits {
            write_varint(&mut s, names[c.author.as_str()]);
        }
        for path in self.paths.keys() {
            let Some(list) = v.lists.get(path) else {
                write_varint(&mut s, 0);
                continue;
            };
            if list.versions.len() > v.limit as usize {
                return Err(bad("a version list is longer than its limit"));
            }
            write_varint(
                &mut s,
                ((list.versions.len() as u64) << 1) | u64::from(list.complete),
            );
            for e in &list.versions {
                let want = if is_blob_mode(e.mode) {
                    usize::from(v.oid_len)
                } else {
                    0
                };
                if e.oid.len() != want {
                    return Err(bad("a version's oid prefix has the wrong length"));
                }
                write_varint(&mut s, u64::from(e.commit));
                write_varint(&mut s, u64::from(e.mode));
                s.extend_from_slice(&e.oid);
            }
        }
        Ok(s)
    }

    /// Parse a gzip-compressed index. Refuses anything malformed rather than guessing.
    pub fn parse(compressed: &[u8]) -> Result<Self> {
        Self::parse_bounded(compressed, MAX_INFLATED)
    }

    /// [`Self::parse`] refusing a body that inflates past `max_inflated` bytes.
    pub fn parse_bounded(compressed: &[u8], max_inflated: u64) -> Result<Self> {
        let mut body = Vec::new();
        GzDecoder::new(compressed)
            .take(max_inflated + 1)
            .read_to_end(&mut body)
            .map_err(|e| Error::Io(format!("history index: {e}")))?;
        if body.len() as u64 > max_inflated {
            return Err(bad("inflates past its size limit"));
        }
        let mut r = Cursor { buf: &body, pos: 0 };
        if r.take(4)? != MAGIC || r.take(1)?[0] < VERSION_V1 {
            return Err(bad("not a history index"));
        }
        let tip: [u8; OID_LEN] = r.take(OID_LEN)?.try_into().expect("20 bytes");
        let base: [u8; 32] = r.take(32)?.try_into().expect("32 bytes");
        let commit_count = r.varint()?;
        let first_parent_count = r.varint()?;
        let root_time = r.varint()?;
        let tip_time = r.varint()?;
        let n_commits = r.count()?;
        let mut commits = Vec::with_capacity(n_commits.min(1 << 16));
        for _ in 0..n_commits {
            let oid = r.take(OID_LEN)?.try_into().expect("20 bytes");
            let author_time = r.varint()?;
            let subject = r.text("a subject")?;
            commits.push(IndexedCommit {
                oid,
                author_time,
                subject,
                author: String::new(),
            });
        }
        let n_paths = r.count()?;
        let mut paths = BTreeMap::new();
        let mut prev: Vec<u8> = Vec::new();
        for _ in 0..n_paths {
            let shared = usize::try_from(r.varint()?).unwrap_or(usize::MAX);
            if shared > prev.len() {
                return Err(bad("a path shares more than its predecessor holds"));
            }
            let suffix_len = r.len()?;
            let mut path = prev[..shared].to_vec();
            path.extend_from_slice(r.take(suffix_len)?);
            let commit = r.index(
                commits.len(),
                "a path names a commit the table does not hold",
            )?;
            if path <= prev && !paths.is_empty() {
                return Err(bad("paths are not strictly sorted"));
            }
            paths.insert(path.clone(), commit);
            prev = path;
        }
        // Extension sections: whole `(tag, len, bytes)` records. The versions section is read;
        // any other tag (a later version's) is skipped.
        let mut versions = None;
        while r.pos < body.len() {
            let tag = r.varint()?;
            let len = r.len()?;
            let bytes = r.take(len)?;
            if tag == TAG_VERSIONS {
                if versions.is_some() {
                    return Err(bad("the versions section appears twice"));
                }
                let mut s = Cursor { buf: bytes, pos: 0 };
                versions = Some(parse_versions(&mut s, &mut commits, &paths)?);
                if s.pos != bytes.len() {
                    return Err(bad("the versions section has trailing bytes"));
                }
            }
        }
        Ok(Self {
            tip,
            base: (base != [0; 32]).then_some(base),
            commit_count,
            first_parent_count,
            root_time,
            tip_time,
            commits,
            paths,
            versions,
        })
    }
}

/// Read the versions section, filling in each commit's author.
fn parse_versions(
    r: &mut Cursor<'_>,
    commits: &mut [IndexedCommit],
    paths: &PathMap,
) -> Result<Versions> {
    let limit = r.varint()?;
    if limit == 0 || limit > u64::from(MAX_VERSIONS_PER_PATH) {
        return Err(bad("the version list limit is out of range"));
    }
    let limit = u32::try_from(limit).expect("bounded");
    let oid_len = r.take(1)?[0];
    if !(usize::from(MIN_OID_PREFIX_LEN)..=OID_LEN).contains(&usize::from(oid_len)) {
        return Err(bad("the oid prefix length is out of range"));
    }
    let n_authors = r.count()?;
    let mut authors = Vec::with_capacity(n_authors.min(1 << 16));
    for _ in 0..n_authors {
        authors.push(r.text("an author")?);
    }
    for c in commits.iter_mut() {
        let a = r.index(
            authors.len(),
            "a commit names an author the table does not hold",
        )?;
        c.author.clone_from(&authors[a as usize]);
    }
    let mut lists = BTreeMap::new();
    let mut entries = 0u64;
    for path in paths.keys() {
        let head = r.varint()?;
        let (n, complete) = (head >> 1, head & 1 == 1);
        if n > u64::from(limit) {
            return Err(bad("a version list is longer than its limit"));
        }
        entries += n;
        if entries > MAX_ROWS {
            return Err(bad("too many rows"));
        }
        if n == 0 && !complete {
            continue;
        }
        let mut versions = Vec::with_capacity(usize::try_from(n).unwrap_or(0));
        for _ in 0..n {
            let commit = r.index(
                commits.len(),
                "a version names a commit the table does not hold",
            )?;
            let mode = u32::try_from(r.varint()?).map_err(|_| bad("a mode overflows"))?;
            let oid = if is_blob_mode(mode) {
                r.take(usize::from(oid_len))?.to_vec()
            } else {
                Vec::new()
            };
            versions.push(PathVersion { commit, mode, oid });
        }
        lists.insert(path.clone(), VersionList { versions, complete });
    }
    Ok(Versions {
        limit,
        oid_len,
        lists,
    })
}

/// A path's version list with its commits resolved to oids: what [`overlay_versions`] merges.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedList {
    /// `(commit oid, mode, blob oid prefix)`, newest first.
    pub versions: Vec<([u8; OID_LEN], u32, Vec<u8>)>,
    pub complete: bool,
}

impl HistoryIndex {
    /// Every path's version list with commit oids in place of table indexes, or `None` for a v1
    /// index.
    pub fn resolved_versions(&self) -> Option<BTreeMap<Vec<u8>, ResolvedList>> {
        let v = self.versions.as_ref()?;
        Some(
            v.lists
                .iter()
                .map(|(p, l)| {
                    let versions = l
                        .versions
                        .iter()
                        .map(|e| (self.commits[e.commit as usize].oid, e.mode, e.oid.clone()))
                        .collect();
                    (
                        p.clone(),
                        ResolvedList {
                            versions,
                            complete: l.complete,
                        },
                    )
                })
                .collect(),
        )
    }
}

/// The version lists of a delta's tip, from its full base's and the delta's (the web reader's
/// `overlayHistory` applies the same rule; `docs/design/history-index.md`):
///
/// - a path the delta does not list is unchanged since the base's tip: the base's list stands;
/// - a path the delta lists with a **complete** list was added since the base: the delta's list
///   is its whole history;
/// - otherwise the delta's changes come first, then the base's list, deduplicated and cut to
///   `limit`; complete when the base's was and nothing was cut;
/// - a path the delta lists (it changed) without a list of its own (a v1 delta) is unknown.
///
/// `None` when neither index has version lists.
pub fn overlay_versions(
    base: Option<&BTreeMap<Vec<u8>, ResolvedList>>,
    delta: Option<&BTreeMap<Vec<u8>, ResolvedList>>,
    delta_paths: &PathMap,
    limit: u32,
) -> Option<BTreeMap<Vec<u8>, ResolvedList>> {
    if base.is_none() && delta.is_none() {
        return None;
    }
    let mut out = base.cloned().unwrap_or_default();
    for path in delta_paths.keys() {
        let Some(d) = delta.and_then(|d| d.get(path)) else {
            out.remove(path);
            continue;
        };
        if d.complete {
            out.insert(path.clone(), d.clone());
            continue;
        }
        let Some(b) = base.and_then(|b| b.get(path)) else {
            out.insert(path.clone(), d.clone());
            continue;
        };
        let mut seen = BTreeSet::new();
        let mut versions: Vec<_> = d
            .versions
            .iter()
            .chain(&b.versions)
            .filter(|e| seen.insert(e.0))
            .cloned()
            .collect();
        let cut = versions.len() > limit as usize;
        versions.truncate(limit as usize);
        out.insert(
            path.clone(),
            ResolvedList {
                versions,
                complete: b.complete && !cut,
            },
        );
    }
    Some(out)
}

/// Compute the history index of `tip` in the repository at `repo`.
///
/// `since`: the tip of a full index this one extends. When it is on `tip`'s first-parent
/// chain the result is a **delta** listing only the paths some commit in `(since, tip]`
/// changed (still present at `tip`), with `base` left for the caller to set (the base's
/// `packHash`). When it is not on the chain, `None` is returned for the caller to publish a
/// full index instead. `since == None` computes a full index.
///
/// Reads the repository's real object graph: replace refs and grafts are ignored (they would
/// make git describe a history the published packs do not hold). A shallow repository is
/// refused: its history stops at the shallow boundary, so its commits and counts would be wrong.
pub fn compute(repo: &Path, tip: &str, since: Option<&str>) -> Result<Option<HistoryIndex>> {
    compute_with(repo, tip, since, VERSIONS_PER_PATH)
}

/// [`compute`] listing at most `limit` versions per path.
pub fn compute_with(
    repo: &Path,
    tip: &str,
    since: Option<&str>,
    limit: u32,
) -> Result<Option<HistoryIndex>> {
    let limit = limit.clamp(1, MAX_VERSIONS_PER_PATH);
    ensure_safe_rev(tip)?;
    if capture(repo, &["rev-parse", "--is-shallow-repository"], None)?.trim_ascii() == b"true" {
        return Err(bad(
            "the repository is a shallow clone; its history is incomplete",
        ));
    }
    // The repository's own grafts file, in its common git dir (`git_real` points
    // GIT_GRAFT_FILE elsewhere, which `--git-path info/grafts` would report instead).
    let common = capture(repo, &["rev-parse", "--git-common-dir"], None)?;
    let grafts = repo
        .join(String::from_utf8_lossy(&common).trim())
        .join("info")
        .join("grafts");
    if grafts.exists() {
        return Err(bad(
            "the repository has an info/grafts file; its history is rewritten",
        ));
    }
    let tip_oid = rev_parse(repo, tip)?;
    let tip_hex = hex::encode(tip_oid);
    let since_hex = match since {
        Some(s) => {
            ensure_safe_rev(s)?;
            let s = hex::encode(rev_parse(repo, s)?);
            if !on_first_parent_chain(repo, &tip_hex, &s)? {
                return Ok(None);
            }
            Some(s)
        }
        None => None,
    };

    // Every path of the tip (files, symlinks, gitlinks and directories).
    let listing = capture(
        repo,
        &[
            "ls-tree",
            "-r",
            "-t",
            "-z",
            "--name-only",
            "--end-of-options",
            &tip_hex,
        ],
        None,
    )?;
    let tip_paths: BTreeSet<Vec<u8>> = listing
        .split(|&b| b == 0)
        .filter(|p| !p.is_empty())
        .map(<[u8]>::to_vec)
        .collect();

    let range = match &since_hex {
        Some(s) => format!("{s}..{tip_hex}"),
        None => tip_hex.clone(),
    };
    let found = first_parent_changes(repo, &range, &tip_paths, limit as usize)?;
    if since_hex.is_none() && found.len() != tip_paths.len() {
        // A full walk reaches the root commit, which adds every path it has: a path no commit
        // added cannot exist.
        return Err(bad("git log did not account for every path of the tip"));
    }

    let (commits, paths, lists) = assemble(repo, found)?;
    let commit_count = rev_count(repo, &tip_hex, false)?;
    let first_parent_count = rev_count(repo, &tip_hex, true)?;
    let root = capture(
        repo,
        &[
            "rev-list",
            "--first-parent",
            "--max-parents=0",
            "--end-of-options",
            &tip_hex,
        ],
        None,
    )?;
    let root_oid = parse_hex_oid(
        String::from_utf8_lossy(&root)
            .lines()
            .last()
            .unwrap_or_default()
            .trim()
            .as_bytes(),
    )?;
    let times = commit_meta(repo, &[tip_oid, root_oid])?;
    Ok(Some(HistoryIndex {
        tip: tip_oid,
        base: None,
        commit_count,
        first_parent_count,
        tip_time: times[0].author_time,
        root_time: times[1].author_time,
        commits,
        paths,
        versions: Some(Versions {
            limit,
            oid_len: OID_PREFIX_LEN,
            lists,
        }),
    }))
}

/// The commit table, the column (each path's newest change) and the version lists, from the
/// changes the log reported.
fn assemble(
    repo: &Path,
    found: BTreeMap<Vec<u8>, RawList>,
) -> Result<(Vec<IndexedCommit>, PathMap, VersionLists)> {
    let distinct: BTreeSet<[u8; OID_LEN]> = found
        .values()
        .flat_map(|l| l.versions.iter().map(|v| v.commit))
        .collect();
    let (commits, slot) = commit_table(repo, distinct)?;
    let paths = found
        .iter()
        .map(|(p, l)| (p.clone(), slot[&l.versions[0].commit]))
        .collect();
    let lists = found
        .into_iter()
        .map(|(p, l)| {
            let versions = l
                .versions
                .into_iter()
                .map(|v| PathVersion {
                    commit: slot[&v.commit],
                    mode: v.mode,
                    oid: if is_blob_mode(v.mode) {
                        v.oid[..usize::from(OID_PREFIX_LEN)].to_vec()
                    } else {
                        Vec::new()
                    },
                })
                .collect();
            (
                p,
                VersionList {
                    versions,
                    complete: l.complete,
                },
            )
        })
        .collect();
    Ok((commits, paths, lists))
}

/// `git` in `repo` reading the real object graph: no replace refs, no grafts.
fn git_real(repo: &Path, args: &[&str]) -> std::process::Command {
    let mut cmd = git_at(repo, &[]);
    cmd.env("GIT_NO_REPLACE_OBJECTS", "1")
        // A grafts file that cannot exist: git reads none, whatever the repository holds.
        .env("GIT_GRAFT_FILE", "/nonexistent/dash-forge-no-grafts")
        .arg("--no-replace-objects")
        .args(args);
    cmd
}

/// Run [`git_real`] fed `stdin`, returning its stdout on success.
fn capture(repo: &Path, args: &[&str], stdin: Option<&[u8]>) -> Result<Vec<u8>> {
    let (out, written) = super::build::run_feeding(&mut git_real(repo, args), stdin)
        .map_err(|e| Error::Io(format!("running git: {e}")))?;
    if !out.status.success() {
        return Err(Error::Io(format!(
            "git {} failed: {}",
            args.first().copied().unwrap_or_default(),
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    written.map_err(|e| Error::Io(format!("write git stdin: {e}")))?;
    Ok(out.stdout)
}

/// One change of a path, as the log reports it.
struct RawVersion {
    commit: [u8; OID_LEN],
    mode: u32,
    oid: [u8; OID_LEN],
}

/// A path's changes found so far.
#[derive(Default)]
struct RawList {
    versions: Vec<RawVersion>,
    complete: bool,
}

/// What one commit's raw lines say about a path: whether its first parent had it, and its
/// entry after the commit. A type change between a tree and a blob is two lines (a delete and
/// an add), folded into one change here, as the web's `mode:oid` comparison sees it.
#[derive(Default)]
struct Touch {
    in_parent: bool,
    after: Option<(u32, [u8; OID_LEN])>,
}

/// One first-parent pass over `range`, newest first, listing each path of `paths` changed in
/// it: at most `limit` changes per path, ending at the commit that added it. The log is read as
/// it streams, and git is stopped as soon as every path's list is done: an old repository's
/// early commits are never listed once no open path needs them.
fn first_parent_changes(
    repo: &Path,
    range: &str,
    paths: &BTreeSet<Vec<u8>>,
    limit: usize,
) -> Result<BTreeMap<Vec<u8>, RawList>> {
    let mut child = git_real(
        repo,
        &[
            "-c",
            "log.showSignature=false",
            "log",
            "--first-parent",
            "--diff-merges=first-parent",
            "--no-renames",
            "--no-relative",
            "--no-ext-diff",
            "--no-textconv",
            "--ignore-submodules=none",
            "--root",
            "-t",
            "--raw",
            "--no-abbrev",
            "-z",
            "--format=%x01%H",
            "--end-of-options",
            range,
        ],
    )
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped())
    .spawn()
    .map_err(|e| Error::Io(format!("running git log: {e}")))?;
    let stdout = child.stdout.take().expect("piped");
    let mut reader = std::io::BufReader::with_capacity(1 << 16, stdout);
    let mut lists: BTreeMap<Vec<u8>, RawList> = BTreeMap::new();
    let mut open: BTreeSet<&[u8]> = paths.iter().map(Vec::as_slice).collect();
    let mut current: Option<[u8; OID_LEN]> = None;
    let mut touched: BTreeMap<Vec<u8>, Touch> = BTreeMap::new();
    let mut tok = Vec::new();
    let read = |reader: &mut std::io::BufReader<_>, tok: &mut Vec<u8>| -> Result<bool> {
        tok.clear();
        let n = reader
            .read_until(0, tok)
            .map_err(|e| Error::Io(format!("reading git log: {e}")))?;
        if tok.last() == Some(&0) {
            tok.pop();
        }
        Ok(n > 0)
    };
    let walked = (|| -> Result<()> {
        while !open.is_empty() && read(&mut reader, &mut tok)? {
            let t = tok.strip_prefix(b"\n").unwrap_or(&tok);
            if let Some(oid) = t.strip_prefix(b"\x01") {
                settle(current, &mut touched, &mut open, &mut lists, limit)?;
                current = Some(parse_hex_oid(oid)?);
            } else if let Some(raw) = t.strip_prefix(b":") {
                // `<mode> <mode> <oid> <oid> <status>`, then the path as the next token.
                let (src_mode, dst_mode, dst_oid) = parse_raw(raw)?;
                if !read(&mut reader, &mut tok)? {
                    return Err(bad("git log: a raw line has no path"));
                }
                if open.contains(tok.as_slice()) {
                    let touch = touched.entry(tok.clone()).or_default();
                    touch.in_parent |= src_mode != 0;
                    if dst_mode != 0 {
                        touch.after = Some((dst_mode, dst_oid));
                    }
                }
            }
        }
        settle(current, &mut touched, &mut open, &mut lists, limit)
    })();
    // Every list done with git still writing: stop it rather than read the rest.
    let stopped_early = open.is_empty();
    if stopped_early {
        let _ = child.kill();
    }
    drop(reader);
    let mut stderr = Vec::new();
    if let Some(mut e) = child.stderr.take() {
        let _ = e.read_to_end(&mut stderr);
    }
    let status = child
        .wait()
        .map_err(|e| Error::Io(format!("waiting for git log: {e}")))?;
    walked?;
    if !stopped_early && !status.success() {
        return Err(Error::Io(format!(
            "git log failed: {}",
            String::from_utf8_lossy(&stderr).trim()
        )));
    }
    Ok(lists)
}

/// Append the changes one commit made (`touched`) to their paths' lists, closing each list that
/// reached its add or `limit`.
fn settle(
    commit: Option<[u8; OID_LEN]>,
    touched: &mut BTreeMap<Vec<u8>, Touch>,
    open: &mut BTreeSet<&[u8]>,
    lists: &mut BTreeMap<Vec<u8>, RawList>,
    limit: usize,
) -> Result<()> {
    for (path, t) in std::mem::take(touched) {
        let commit = commit.ok_or_else(|| bad("git log: a change before any commit"))?;
        let (mode, oid) = t
            .after
            .ok_or_else(|| bad("git log: a listed path is absent after its change"))?;
        let list = lists.entry(path.clone()).or_default();
        list.versions.push(RawVersion { commit, mode, oid });
        list.complete = !t.in_parent;
        if list.complete || list.versions.len() >= limit {
            open.remove(path.as_slice());
        }
    }
    Ok(())
}

/// `(src mode, dst mode, dst oid)` of a raw line after its `:`.
fn parse_raw(raw: &[u8]) -> Result<(u32, u32, [u8; OID_LEN])> {
    let mut f = raw.split(|&b| b == b' ');
    let mut mode = || -> Result<u32> {
        let m = f.next().ok_or_else(|| bad("git log: a short raw line"))?;
        u32::from_str_radix(std::str::from_utf8(m).unwrap_or("x"), 8)
            .map_err(|_| bad("git log: a raw line's mode is not octal"))
    };
    let (src, dst) = (mode()?, mode()?);
    let _src_oid = f.next();
    let dst_oid = f.next().ok_or_else(|| bad("git log: a short raw line"))?;
    Ok((src, dst, parse_hex_oid(dst_oid)?))
}

/// The commit table and each commit's slot in it.
type CommitTable = (Vec<IndexedCommit>, HashMap<[u8; OID_LEN], u32>);

/// The commit table (each commit once, oid-ordered, with its subject, author and author time)
/// and each commit's slot in it.
fn commit_table(repo: &Path, distinct: BTreeSet<[u8; OID_LEN]>) -> Result<CommitTable> {
    let distinct: Vec<[u8; OID_LEN]> = distinct.into_iter().collect();
    let meta = commit_meta(repo, &distinct)?;
    let slot = distinct
        .iter()
        .enumerate()
        .map(|(i, o)| (*o, u32::try_from(i).unwrap_or(u32::MAX)))
        .collect();
    let commits = distinct
        .iter()
        .zip(meta)
        .map(|(oid, m)| IndexedCommit {
            oid: *oid,
            author_time: m.author_time,
            subject: m.subject,
            author: m.author,
        })
        .collect();
    Ok((commits, slot))
}

/// What the index keeps of a commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitMeta {
    /// Author time (s).
    pub author_time: u64,
    /// The message's first line, trimmed, clipped to [`SUBJECT_MAX`] bytes.
    pub subject: String,
    /// The author's name, clipped to [`SUBJECT_MAX`] bytes.
    pub author: String,
}

/// Each commit's [`CommitMeta`], in order, read in one `git cat-file --batch`.
fn commit_meta(repo: &Path, oids: &[[u8; OID_LEN]]) -> Result<Vec<CommitMeta>> {
    if oids.is_empty() {
        return Ok(Vec::new());
    }
    let mut input = String::with_capacity(oids.len() * 41);
    for o in oids {
        input.push_str(&hex::encode(o));
        input.push('\n');
    }
    let out = capture(repo, &["cat-file", "--batch"], Some(input.as_bytes()))?;
    let mut pos = 0;
    let mut meta = Vec::with_capacity(oids.len());
    for _ in oids {
        let nl = out[pos..]
            .iter()
            .position(|&b| b == b'\n')
            .ok_or_else(|| bad("cat-file: truncated header"))?;
        let header =
            std::str::from_utf8(&out[pos..pos + nl]).map_err(|_| bad("cat-file header"))?;
        let mut parts = header.split(' ');
        let (_, kind, size) = (parts.next(), parts.next(), parts.next());
        if kind != Some("commit") {
            return Err(bad("cat-file: an indexed change is not a commit"));
        }
        let size: usize = size
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| bad("cat-file: bad size"))?;
        let start = pos + nl + 1;
        let body = out
            .get(start..start + size)
            .ok_or_else(|| bad("cat-file: truncated body"))?;
        meta.push(parse_commit_meta(body));
        pos = start + size + 1;
    }
    Ok(meta)
}

/// A raw commit's [`CommitMeta`], as the web's `parseCommit` + `commitSubject` read it: the
/// first `author` header (its name and date), and the message's first line, trimmed.
pub fn parse_commit_meta(raw: &[u8]) -> CommitMeta {
    let text = String::from_utf8_lossy(raw);
    let (header, message) = text.split_once("\n\n").unwrap_or((&text, ""));
    let author = header
        .lines()
        .find_map(|l| l.strip_prefix("author "))
        .map(str::trim);
    let first = message.split('\n').next().unwrap_or_default().trim();
    CommitMeta {
        author_time: author.map_or(0, ident_time),
        subject: clip(first, SUBJECT_MAX).to_string(),
        author: clip(author.map_or("", ident_name), SUBJECT_MAX).to_string(),
    }
}

/// The name of a git ident line as the web's `parseIdent` reads it: before ` <`, or the whole
/// line when there is no `<…>` after it.
fn ident_name(line: &str) -> &str {
    match (line.find(" <"), line.rfind('>')) {
        (Some(open), Some(close)) if close > open + 1 => &line[..open],
        _ => line,
    }
}

/// The date of a git ident line as git's `parse_commit_date` reads it: after the last `>`,
/// whitespace skipped, the leading digits; 0 when there are none.
fn ident_time(line: &str) -> u64 {
    let Some(close) = line.rfind('>') else {
        return 0;
    };
    let digits: String = line[close + 1..]
        .trim_start()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().unwrap_or(0)
}

/// `s` clipped to at most `max` bytes at a character boundary.
fn clip(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Whether `ancestor` is on `tip`'s first-parent chain.
fn on_first_parent_chain(repo: &Path, tip: &str, ancestor: &str) -> Result<bool> {
    if tip == ancestor {
        return Ok(true);
    }
    // The first-parent chain is one oid per commit (8k lines for dashpay/dash): cheap.
    let chain = capture(
        repo,
        &["rev-list", "--first-parent", "--end-of-options", tip],
        None,
    )?;
    Ok(chain
        .split(|&b| b == b'\n')
        .any(|l| l == ancestor.as_bytes()))
}

fn rev_count(repo: &Path, tip: &str, first_parent: bool) -> Result<u64> {
    let mut args = vec!["rev-list", "--count"];
    if first_parent {
        args.push("--first-parent");
    }
    args.extend(["--end-of-options", tip]);
    let out = capture(repo, &args, None)?;
    String::from_utf8_lossy(&out)
        .trim()
        .parse()
        .map_err(|_| bad("rev-list --count"))
}

fn rev_parse(repo: &Path, rev: &str) -> Result<[u8; OID_LEN]> {
    let spec = format!("{rev}^{{commit}}");
    let out = capture(
        repo,
        &["rev-parse", "--verify", "--end-of-options", &spec],
        None,
    )?;
    parse_hex_oid(String::from_utf8_lossy(&out).trim().as_bytes())
}

/// A 40-hex commit id as bytes.
pub fn parse_hex_oid(hex_bytes: &[u8]) -> Result<[u8; OID_LEN]> {
    let bytes = hex::decode(hex_bytes).map_err(|_| bad("not a hex oid"))?;
    bytes.try_into().map_err(|_| bad("an oid is not 20 bytes"))
}

fn bad(what: &str) -> Error {
    Error::Config(format!("history index: {what}"))
}

fn write_varint(buf: &mut Vec<u8>, mut v: u64) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            buf.push(b);
            return;
        }
        buf.push(b | 0x80);
    }
}

struct Cursor<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self.pos.checked_add(n).ok_or_else(|| bad("truncated"))?;
        let s = self
            .buf
            .get(self.pos..end)
            .ok_or_else(|| bad("truncated"))?;
        self.pos = end;
        Ok(s)
    }

    fn varint(&mut self) -> Result<u64> {
        let mut r = 0u64;
        for shift in (0..64).step_by(7) {
            let b = self.take(1)?[0];
            let bits = u64::from(b & 0x7f);
            // The tenth byte holds bit 63 alone: anything more does not fit a u64.
            if shift == 63 && bits > 1 {
                return Err(bad("varint overflow"));
            }
            r |= bits << shift;
            if b & 0x80 == 0 {
                return Ok(r);
            }
        }
        Err(bad("varint overflow"))
    }

    /// A row count, bounded by [`MAX_ROWS`].
    fn count(&mut self) -> Result<usize> {
        let n = self.varint()?;
        if n > MAX_ROWS {
            return Err(bad("too many rows"));
        }
        usize::try_from(n).map_err(|_| bad("too many rows"))
    }

    /// A byte length, bounded by what is left.
    fn len(&mut self) -> Result<usize> {
        let n = usize::try_from(self.varint()?).map_err(|_| bad("length overflow"))?;
        if n > self.buf.len() - self.pos {
            return Err(bad("truncated"));
        }
        Ok(n)
    }

    /// A length-prefixed UTF-8 string.
    fn text(&mut self, what: &str) -> Result<String> {
        let len = self.len()?;
        std::str::from_utf8(self.take(len)?)
            .map(str::to_string)
            .map_err(|_| bad(&format!("{what} is not UTF-8")))
    }

    /// An index into a table of `n` rows.
    fn index(&mut self, n: usize, what: &str) -> Result<u32> {
        let i = self.varint()?;
        if i >= n as u64 {
            return Err(bad(what));
        }
        u32::try_from(i).map_err(|_| bad(what))
    }
}
