//! The clone's sealed-object ledger, `<git common dir>/dash/sealed-ledger` (DESIGN D21, §4.3,
//! §12 item 1; `docs/security/private-repos.md` §19.5).
//!
//! It lists every members-only commit a clone has fetched from a members-only pack or pushed to a
//! members-only ref, and every members-only pack it indexed, so that the publication guard can
//! refuse to publish one even when the encryption key is not at hand.
//!
//! **Where.** One ledger per repository, in its common directory (`git rev-parse
//! --git-common-dir`), so every worktree of a clone shares it (`$GIT_DIR` is per worktree, and
//! `$GIT_DIR/dash/sealed` is already the private push's retry-pack directory).
//!
//! **When it is created.** Empty, on a clone or on the first fetch into a repository with no
//! refs, never merely because it is missing ([`create_empty`]): a missing file means "unknown",
//! and the guard fails closed on it (E806) in a repository with members-only content.
//!
//! # Format, version 1
//!
//! UTF-8 text, `\n`-terminated lines, append-only:
//!
//! ```text
//! # dash sealed-object ledger v1
//! commit <40 or 64 hex> [<audience>]   a members-only commit this clone fetched or pushed, or
//!                                      the tag object a members-only tag names (every
//!                                      members-only ref's newOid is recorded, whatever its type)
//! pack <64 hex> [<audience>]           a members-only pack this clone indexed
//! ```
//!
//! - The first line is exactly [`HEADER`]. Any other first line (a newer version, or a file this
//!   reader does not know) makes the ledger **unknown**, never empty: the guard fails closed.
//! - Later lines starting with `#` are comments, and blank lines are skipped. Every other line is
//!   an entry, a keyword, one space and a lower-case hex id of the keyword's length, then
//!   optionally one space and an audience; anything else (another keyword, a tab, upper case)
//!   makes the ledger unknown. A new entry type is a new version, never an entry a reader skips.
//! - The optional third column is the entry's **audience**: absent or `members` for the members
//!   key; any other token (`[a-z0-9:._-]`, e.g. a narrower branch's, phase 3F) is narrower than
//!   Members and opaque here. The guard refuses publishing a commit to any ref wider than its
//!   narrowest recorded audience.
//! - A file holding only the header records no members-only object.

use std::collections::BTreeMap;
use std::io::{BufRead as _, Write as _};
use std::path::{Path, PathBuf};

/// The first line of a version-1 ledger.
pub const HEADER: &str = "# dash sealed-object ledger v1";

/// `<common dir>/dash/sealed-ledger`.
#[must_use]
pub fn path(common_dir: &Path) -> PathBuf {
    common_dir.join("dash").join("sealed-ledger")
}

/// Who a ledger entry is for.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EntryAudience {
    /// The members key (no third column, or `members`).
    Members,
    /// A narrower audience, by its opaque token (phase 3F).
    Narrower(String),
}

impl EntryAudience {
    /// The audience a ledger token names; `None` for a token outside `[a-z0-9:._-]+`.
    #[must_use]
    pub fn parse(token: &str) -> Option<Self> {
        if token == "members" {
            return Some(Self::Members);
        }
        let ok = !token.is_empty()
            && token
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b":._-".contains(&b));
        ok.then(|| Self::Narrower(token.to_owned()))
    }

    /// The token written for it (none for Members, the default).
    #[must_use]
    pub fn token(&self) -> Option<&str> {
        match self {
            Self::Members => None,
            Self::Narrower(t) => Some(t),
        }
    }

    /// The narrower of two audiences: any narrower audience is narrower than Members; two
    /// different narrower ones keep the first recorded (both stay refused for Members refs).
    #[must_use]
    pub fn narrowest(self, other: Self) -> Self {
        match (self, other) {
            (Self::Members, o) => o,
            (n, _) => n,
        }
    }
}

/// What a ledger line records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    /// A members-only commit (`commit`).
    Commit,
    /// A members-only pack's `packHash` (`pack`).
    Pack,
}

/// One ledger line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// `commit` or `pack`.
    pub kind: EntryKind,
    /// Lower-case hex: 40 or 64 for a commit, 64 for a pack.
    pub id: String,
    /// Who it is for.
    pub audience: EntryAudience,
}

impl Entry {
    /// The line written for it, without the newline. `None` for an id that is not lower-case hex
    /// of the kind's length.
    #[must_use]
    pub fn line(&self) -> Option<String> {
        if !valid_id(self.kind, &self.id) {
            return None;
        }
        let keyword = match self.kind {
            EntryKind::Commit => "commit",
            EntryKind::Pack => "pack",
        };
        Some(match self.audience.token() {
            Some(t) => format!("{keyword} {} {t}", self.id),
            None => format!("{keyword} {}", self.id),
        })
    }
}

fn valid_id(kind: EntryKind, id: &str) -> bool {
    let len_ok = match kind {
        EntryKind::Commit => id.len() == 40 || id.len() == 64,
        EntryKind::Pack => id.len() == 64,
    };
    len_ok
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A readable ledger: each recorded commit and pack with its narrowest recorded audience.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Ledger {
    /// Commits by hex id.
    pub commits: BTreeMap<String, EntryAudience>,
    /// Packs by `packHash` hex.
    pub packs: BTreeMap<String, EntryAudience>,
}

impl Ledger {
    /// Whether it records nothing (the "never held members-only objects" state).
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.commits.is_empty() && self.packs.is_empty()
    }
}

/// The ledger as a guard reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    /// No file: unknown whether this clone ever held members-only objects.
    Absent,
    /// A file this reader cannot read (another version, a damaged entry): unknown, fail closed.
    Unknown,
    /// The ledger.
    Present(Ledger),
}

/// Parse a ledger's text. `None` is [`State::Unknown`].
#[must_use]
pub fn parse(text: &str) -> Option<Ledger> {
    let mut lines = text.lines();
    if lines.next() != Some(HEADER) {
        return None;
    }
    let mut out = Ledger::default();
    for line in lines {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split(' ');
        let (kind, map) = match parts.next() {
            Some("commit") => (EntryKind::Commit, &mut out.commits),
            Some("pack") => (EntryKind::Pack, &mut out.packs),
            _ => return None, // a later entry type is a later version: fail closed
        };
        let id = parts.next()?;
        if !valid_id(kind, id) {
            return None;
        }
        let audience = match parts.next() {
            Some(t) => EntryAudience::parse(t)?,
            None => EntryAudience::Members,
        };
        if parts.next().is_some() {
            return None;
        }
        let narrowest = match map.remove(id) {
            Some(prev) => prev.narrowest(audience),
            None => audience,
        };
        map.insert(id.to_owned(), narrowest);
    }
    Some(out)
}

/// Read the ledger of the repository whose common directory is `common_dir`.
pub fn read(common_dir: &Path) -> std::io::Result<State> {
    match std::fs::read_to_string(path(common_dir)) {
        Ok(text) => Ok(parse(&text).map_or(State::Unknown, State::Present)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(State::Absent),
        Err(e) if e.kind() == std::io::ErrorKind::InvalidData => Ok(State::Unknown),
        Err(e) => Err(e),
    }
}

/// Create the empty ledger in `common_dir` unless one exists. `Ok(true)` when it was created.
/// Never truncates or replaces a ledger: the header is written to a temporary file and linked into
/// place, which fails when one exists, so a crash never leaves a ledger without its header.
pub fn create_empty(common_dir: &Path) -> std::io::Result<bool> {
    let p = path(common_dir);
    let dir = p.parent().expect("the ledger path has a directory");
    std::fs::create_dir_all(dir)?;
    if p.exists() {
        return Ok(false);
    }
    let tmp = dir.join(format!(
        "sealed-ledger.tmp-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos())
    ));
    let written = (|| {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        f.write_all(HEADER.as_bytes())?;
        f.write_all(b"\n")?;
        f.sync_all()?;
        std::fs::hard_link(&tmp, &p)
    })();
    let _ = std::fs::remove_file(&tmp);
    match written {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e),
    }
}

/// Append `entries` to the existing ledger in `common_dir`, after checking its first line is
/// [`HEADER`]. Refused (`InvalidData`) when the file is a version this writer does not know or an
/// entry is not well formed, and (`NotFound`) when there is no ledger: the caller decides whether
/// it may create one ([`create_empty`]). Synced before returning, so a push or fetch that records
/// what it holds never reports success with the record still in a buffer.
pub fn append(common_dir: &Path, entries: &[Entry]) -> std::io::Result<()> {
    let invalid = |m: &str| std::io::Error::new(std::io::ErrorKind::InvalidData, m.to_owned());
    let lines: Vec<String> = entries
        .iter()
        .map(|e| e.line().ok_or_else(|| invalid("not a ledger entry")))
        .collect::<std::io::Result<_>>()?;
    let p = path(common_dir);
    let mut f = std::fs::OpenOptions::new()
        .read(true)
        .append(true)
        .open(&p)?;
    let mut first = String::new();
    std::io::BufReader::new(&f).read_line(&mut first)?;
    if first.trim_end_matches('\n') != HEADER {
        return Err(invalid(
            "the sealed-object ledger is a version this client does not write",
        ));
    }
    if lines.is_empty() {
        return Ok(());
    }
    let mut buf = lines.join("\n");
    buf.push('\n');
    f.write_all(buf.as_bytes())?;
    f.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit(id: char, audience: EntryAudience) -> Entry {
        Entry {
            kind: EntryKind::Commit,
            id: id.to_string().repeat(40),
            audience,
        }
    }

    #[test]
    fn created_once_appended_and_read_back() {
        let d = tempfile::TempDir::new().unwrap();
        assert_eq!(read(d.path()).unwrap(), State::Absent);
        assert!(create_empty(d.path()).unwrap());
        assert!(!create_empty(d.path()).unwrap(), "never truncated");
        assert_eq!(read(d.path()).unwrap(), State::Present(Ledger::default()));
        let narrow = EntryAudience::parse("branch:abcd").unwrap();
        append(
            d.path(),
            &[
                commit('a', EntryAudience::Members),
                commit('b', narrow.clone()),
                commit('a', narrow.clone()),
                Entry {
                    kind: EntryKind::Pack,
                    id: "c".repeat(64),
                    audience: EntryAudience::Members,
                },
            ],
        )
        .unwrap();
        let State::Present(l) = read(d.path()).unwrap() else {
            panic!("readable");
        };
        assert_eq!(l.commits.len(), 2);
        assert_eq!(
            l.commits["a".repeat(40).as_str()],
            narrow,
            "the narrowest audience wins"
        );
        assert_eq!(l.packs.len(), 1);
        assert!(!l.is_empty());
    }

    #[test]
    fn unknown_versions_and_damaged_entries_fail_closed() {
        assert_eq!(parse("# dash sealed-object ledger v2\n"), None);
        assert_eq!(parse(""), None);
        let h = format!("{HEADER}\n");
        assert_eq!(parse(&format!("{h}commit xyz\n")), None);
        assert_eq!(parse(&format!("{h}commit {} BAD\n", "a".repeat(40))), None);
        assert_eq!(parse(&format!("{h}pack {}\n", "a".repeat(40))), None);
        // a comment and a blank line are skipped; an entry type this version does not know, a
        // tab or upper case is a later version or damage: unknown
        let l = parse(&format!("{h}# note\n\n")).unwrap();
        assert!(l.is_empty());
        assert_eq!(parse(&format!("{h}tree {}\n", "a".repeat(40))), None);
        assert_eq!(parse(&format!("{h}commit\t{}\n", "a".repeat(40))), None);
        assert_eq!(parse(&format!("{h}Commit {}\n", "a".repeat(40))), None);
        let d = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(d.path().join("dash")).unwrap();
        std::fs::write(path(d.path()), "# dash sealed-object ledger v2\n").unwrap();
        assert_eq!(read(d.path()).unwrap(), State::Unknown);
        let err = append(d.path(), &[commit('a', EntryAudience::Members)]).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
        let missing = tempfile::TempDir::new().unwrap();
        assert_eq!(
            append(missing.path(), &[]).unwrap_err().kind(),
            std::io::ErrorKind::NotFound,
            "append never creates the ledger"
        );
    }
}
