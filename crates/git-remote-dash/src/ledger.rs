//! The clone's sealed-object ledger, `$GIT_DIR/dash/sealed` (mixed-visibility design D21, §4.3).
//!
//! The ledger will list every members-only commit this clone has fetched or pushed, so that a
//! later publication guard can refuse to push one to a public branch even without the
//! encryption key. Members-only branches do not exist yet, so this helper only **creates the
//! file empty**: on every clone (an empty repository's too), and on the first fetch into a
//! clone that has no `dash/` folder yet. An existing file is never rewritten. The file then tells a later guard "this clone has
//! been recorded since before it could hold members-only commits" apart from "unknown" (an
//! older clone, where `dg doctor` will ask before creating it).
//!
//! # Format, version 1
//!
//! UTF-8 text, `\n`-terminated lines, append-only:
//!
//! ```text
//! # dash sealed-object ledger v1
//! commit <40 or 64 hex>     a members-only commit this clone fetched or pushed
//! pack <64 hex>             a members-only pack this clone indexed
//! ```
//!
//! - The first line is exactly [`HEADER`]. A reader that finds any other first line (a newer
//!   version, or a file it does not know) must treat the ledger as unknown and fail closed;
//!   it must never read such a file as empty.
//! - Later lines starting with `#` are comments. Entry lines are a keyword, one space and a
//!   lower-case hex id; a reader skips keywords it does not know, so entries can be added
//!   without a version bump.
//! - A file holding only the header records no members-only object.

use std::io::Write as _;
use std::path::{Path, PathBuf};

/// The first line of a version-1 ledger.
pub const HEADER: &str = "# dash sealed-object ledger v1";

/// `$GIT_DIR/dash/sealed`.
pub fn path(git_dir: &Path) -> PathBuf {
    git_dir.join("dash").join("sealed")
}

/// Create the empty ledger in `git_dir` unless one exists. `Ok(true)` when it was created.
/// Never truncates: the file is opened with `create_new`.
pub fn create_empty(git_dir: &Path) -> std::io::Result<bool> {
    let p = path(git_dir);
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&p)
    {
        Ok(mut f) => {
            f.write_all(HEADER.as_bytes())?;
            f.write_all(b"\n")?;
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e),
    }
}

/// Create the ledger when a `list` starts a clone or a first fetch: the repo has no refs yet
/// (`fresh`) and no `dash/` folder. git announces a clone only before `fetch`, and a clone of an
/// empty repository never fetches, so this is where such a clone gets its ledger. An
/// `ls-remote` run inside an existing repository creates nothing.
pub fn ensure_on_list(git_dir: &Path, fresh: bool) {
    if fresh {
        ensure_on_fetch(git_dir, false);
    }
}

/// Create the ledger on a clone (`cloning`), or on the first fetch into a clone with no
/// `dash/` folder. A failure is logged, never fatal: the fetch itself is what the user asked
/// for, and a missing ledger only makes a later guard ask.
pub fn ensure_on_fetch(git_dir: &Path, cloning: bool) {
    if !cloning && git_dir.join("dash").exists() {
        return;
    }
    if let Err(e) = create_empty(git_dir) {
        tracing::warn!(error = %e, path = %path(git_dir).display(), "could not create the sealed-object ledger");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn created_once_with_the_header_and_never_truncated() {
        let d = tempfile::TempDir::new().unwrap();
        assert!(create_empty(d.path()).unwrap());
        let p = path(d.path());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), format!("{HEADER}\n"));
        std::fs::write(&p, format!("{HEADER}\ncommit {}\n", "a".repeat(40))).unwrap();
        assert!(!create_empty(d.path()).unwrap());
        assert!(std::fs::read_to_string(&p).unwrap().contains("commit "));
    }

    #[test]
    fn a_fetch_creates_it_only_in_a_clone_without_a_dash_folder() {
        let d = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(d.path().join("dash").join("fetched")).unwrap();
        ensure_on_fetch(d.path(), false);
        assert!(
            !path(d.path()).exists(),
            "an older clone is left to `dg doctor`"
        );
        ensure_on_fetch(d.path(), true);
        assert!(path(d.path()).exists(), "a clone always gets one");

        let fresh = tempfile::TempDir::new().unwrap();
        ensure_on_fetch(fresh.path(), false);
        assert!(path(fresh.path()).exists(), "a first fetch gets one");

        let listed = tempfile::TempDir::new().unwrap();
        ensure_on_list(listed.path(), false);
        assert!(
            !path(listed.path()).exists(),
            "ls-remote in a repo with refs"
        );
        ensure_on_list(listed.path(), true);
        assert!(
            path(listed.path()).exists(),
            "a clone of an empty repository"
        );
    }
}
