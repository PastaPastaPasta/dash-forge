//! The history index (`packManifest.kind == 3`): for one tip commit, each path's last
//! first-parent change and the branch's exact commit count, computed at push time from the
//! pusher's local repository (`docs/design/history-index.md`).
//!
//! The web's file list shows each entry's last commit. Without this index it walks history in
//! the browser, 400 first-parent commits at a time; with it, one artifact answers every
//! directory of the tip.
//!
//! Semantics match the web's walk (`forge-web/lib/view/commit-log.ts`): a path's commit is the
//! newest first-parent commit whose tree entry at that path (`mode:oid`) differs from its first
//! parent's, and a root commit adds everything. Directories are keyed by their full path like
//! files. One pass of
//! `git log --first-parent --diff-merges=first-parent --no-renames --root -t --raw -z` reports
//! exactly those changes: `-t` includes the changed trees, `--no-renames` makes a rename a
//! delete plus an add, and first-parent diffs show a merge as what it brought into the branch.
//!
//! Serialized, then gzip-compressed as a whole:
//!
//! ```text
//! "DFHI" | version u8 (1)
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
//! v1 writes no section.
//!
//! `v` is an LEB128 varint; times are author times in seconds. A **delta** index (non-zero
//! base) lists only the paths changed since its base's tip; its counts are its own tip's.

use super::build::{ensure_safe_rev, git_capture};
use super::parse::OID_LEN;
use crate::error::{Error, Result};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{Read as _, Write as _};
use std::path::Path;

const MAGIC: &[u8; 4] = b"DFHI";
const VERSION: u8 = 1;
/// A commit subject is clipped to this many bytes (at a UTF-8 boundary): the column shows one
/// truncated line.
pub const SUBJECT_MAX: usize = 200;
/// Paths and commits one index may hold: far past any real tree, and a bound for a reader
/// parsing hostile bytes.
const MAX_ROWS: u64 = 4_000_000;

/// One commit an index refers to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexedCommit {
    /// Commit oid.
    pub oid: [u8; OID_LEN],
    /// Author time, seconds since the epoch.
    pub author_time: u64,
    /// First line of the message, trimmed, clipped to [`SUBJECT_MAX`] bytes.
    pub subject: String,
}

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
    pub paths: BTreeMap<Vec<u8>, u32>,
}

impl HistoryIndex {
    /// The last change of `path`, if the index lists it.
    pub fn last_change(&self, path: &[u8]) -> Option<&IndexedCommit> {
        self.paths
            .get(path)
            .and_then(|&i| self.commits.get(i as usize))
    }

    /// Serialize and gzip.
    pub fn to_compressed(&self) -> Result<Vec<u8>> {
        let mut b = Vec::new();
        b.extend_from_slice(MAGIC);
        b.push(VERSION);
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
        let mut enc = GzEncoder::new(Vec::new(), Compression::new(9));
        enc.write_all(&b).map_err(|e| Error::Io(e.to_string()))?;
        enc.finish().map_err(|e| Error::Io(e.to_string()))
    }

    /// Parse a gzip-compressed index. Refuses anything malformed rather than guessing.
    pub fn parse(compressed: &[u8]) -> Result<Self> {
        let mut body = Vec::new();
        GzDecoder::new(compressed)
            .read_to_end(&mut body)
            .map_err(|e| Error::Io(format!("history index: {e}")))?;
        let mut r = Cursor {
            buf: &body,
            pos: 0,
        };
        if r.take(4)? != MAGIC || r.take(1)?[0] < VERSION {
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
            let len = r.len()?;
            let subject = std::str::from_utf8(r.take(len)?)
                .map_err(|_| bad("a subject is not UTF-8"))?
                .to_string();
            commits.push(IndexedCommit {
                oid,
                author_time,
                subject,
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
            let commit = u32::try_from(r.varint()?).map_err(|_| bad("commit index overflow"))?;
            if commit as usize >= commits.len() {
                return Err(bad("a path names a commit the table does not hold"));
            }
            if path <= prev && !paths.is_empty() {
                return Err(bad("paths are not strictly sorted"));
            }
            paths.insert(path.clone(), commit);
            prev = path;
        }
        // Extension sections a later version adds: whole `(tag, len, bytes)` records, skipped.
        while r.pos < body.len() {
            let _tag = r.varint()?;
            let len = r.len()?;
            r.take(len)?;
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
        })
    }
}

/// Compute the history index of `tip` in the repository at `repo`.
///
/// `since`: the tip of a full index this one extends. When it is on `tip`'s first-parent
/// chain the result is a **delta** listing only the paths some commit in `(since, tip]`
/// changed (still present at `tip`), with `base` left for the caller to set (the base's
/// `packHash`). When it is not on the chain, `None` is returned for the caller to publish a
/// full index instead. `since == None` computes a full index.
pub fn compute(repo: &Path, tip: &str, since: Option<&str>) -> Result<Option<HistoryIndex>> {
    ensure_safe_rev(tip)?;
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
    let listing = git_capture(
        repo,
        &["ls-tree", "-r", "-t", "-z", "--name-only", "--end-of-options", &tip_hex],
        None,
    )?;
    let mut open: BTreeSet<Vec<u8>> = listing
        .split(|&b| b == 0)
        .filter(|p| !p.is_empty())
        .map(<[u8]>::to_vec)
        .collect();

    // One first-parent pass, newest first; each commit record starts with \x01<oid>.
    let range = match &since_hex {
        Some(s) => format!("{s}..{tip_hex}"),
        None => tip_hex.clone(),
    };
    let log = git_capture(
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
            "--root",
            "-t",
            "--raw",
            "--no-abbrev",
            "-z",
            "--format=%x01%H",
            "--end-of-options",
            &range,
        ],
        None,
    )?;
    let mut found: BTreeMap<Vec<u8>, [u8; OID_LEN]> = BTreeMap::new();
    let mut current: Option<[u8; OID_LEN]> = None;
    let mut toks = log.split(|&b| b == 0).peekable();
    while let Some(tok) = toks.next() {
        if open.is_empty() {
            break;
        }
        let tok = tok.strip_prefix(b"\n").unwrap_or(tok);
        if let Some(oid) = tok.strip_prefix(b"\x01") {
            current = Some(parse_hex_oid(oid)?);
        } else if tok.first() == Some(&b':') {
            // `:<mode> <mode> <oid> <oid> <status>` then the path as the next token.
            let path = toks.next().ok_or_else(|| bad("git log: a raw line has no path"))?;
            let commit = current.ok_or_else(|| bad("git log: a change before any commit"))?;
            if open.remove(path) {
                found.insert(path.to_vec(), commit);
            }
        }
    }
    if since_hex.is_none() && !open.is_empty() {
        // A full walk reaches the root commit, which adds every path it has: a path no commit
        // added cannot exist.
        return Err(bad("git log did not account for every path of the tip"));
    }

    let (commits, paths) = commit_table(repo, &found)?;
    let commit_count = rev_count(repo, &tip_hex, false)?;
    let first_parent_count = rev_count(repo, &tip_hex, true)?;
    let root = git_capture(
        repo,
        &["rev-list", "--first-parent", "--max-parents=0", "--end-of-options", &tip_hex],
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
        tip_time: times[0].0,
        root_time: times[1].0,
        commits,
        paths,
    }))
}

/// Build the commit table (each referenced commit once, with its subject and author time) and
/// the path map pointing into it.
fn commit_table(
    repo: &Path,
    found: &BTreeMap<Vec<u8>, [u8; OID_LEN]>,
) -> Result<(Vec<IndexedCommit>, BTreeMap<Vec<u8>, u32>)> {
    let distinct: Vec<[u8; OID_LEN]> = found
        .values()
        .copied()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let meta = commit_meta(repo, &distinct)?;
    let slot: HashMap<[u8; OID_LEN], u32> = distinct
        .iter()
        .enumerate()
        .map(|(i, o)| (*o, u32::try_from(i).unwrap_or(u32::MAX)))
        .collect();
    let commits = distinct
        .iter()
        .zip(meta)
        .map(|(oid, (author_time, subject))| IndexedCommit {
            oid: *oid,
            author_time,
            subject,
        })
        .collect();
    let paths = found.iter().map(|(p, o)| (p.clone(), slot[o])).collect();
    Ok((commits, paths))
}

/// Author time and subject of each commit, in order, read in one `git cat-file --batch`.
fn commit_meta(repo: &Path, oids: &[[u8; OID_LEN]]) -> Result<Vec<(u64, String)>> {
    if oids.is_empty() {
        return Ok(Vec::new());
    }
    let input: String = oids.iter().map(|o| format!("{}\n", hex::encode(o))).collect();
    let out = git_capture(repo, &["cat-file", "--batch"], Some(input.as_bytes()))?;
    let mut pos = 0;
    let mut meta = Vec::with_capacity(oids.len());
    for _ in oids {
        let nl = out[pos..]
            .iter()
            .position(|&b| b == b'\n')
            .ok_or_else(|| bad("cat-file: truncated header"))?;
        let header = std::str::from_utf8(&out[pos..pos + nl]).map_err(|_| bad("cat-file header"))?;
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

/// `(author time, subject)` of a raw commit, as the web's `parseCommit` + `commitSubject` read
/// them: the first `author` header, and the message's first line, trimmed.
pub fn parse_commit_meta(raw: &[u8]) -> (u64, String) {
    let text = String::from_utf8_lossy(raw);
    let (header, message) = text.split_once("\n\n").unwrap_or((&text, ""));
    let author_time = header
        .lines()
        .find_map(|l| l.strip_prefix("author "))
        .map_or(0, ident_time);
    let first = message.split('\n').next().unwrap_or_default().trim();
    (author_time, clip(first, SUBJECT_MAX).to_string())
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
    let chain = git_capture(
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
    let out = git_capture(repo, &args, None)?;
    String::from_utf8_lossy(&out)
        .trim()
        .parse()
        .map_err(|_| bad("rev-list --count"))
}

fn rev_parse(repo: &Path, rev: &str) -> Result<[u8; OID_LEN]> {
    let spec = format!("{rev}^{{commit}}");
    let out = git_capture(
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
        let s = self.buf.get(self.pos..end).ok_or_else(|| bad("truncated"))?;
        self.pos = end;
        Ok(s)
    }

    fn varint(&mut self) -> Result<u64> {
        let mut r = 0u64;
        for shift in (0..64).step_by(7) {
            let b = self.take(1)?[0];
            r |= u64::from(b & 0x7f) << shift;
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
}
