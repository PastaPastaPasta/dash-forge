//! The clone's sealed-object ledger, `<common dir>/dash/sealed-ledger` (mixed-visibility design
//! D21, §4.3).
//!
//! The ledger will list every members-only commit this clone has fetched or pushed, so that a
//! later publication guard can refuse to push one to a public branch even without the
//! encryption key. Members-only branches do not exist yet, so this helper only **creates the
//! file empty**. The file then tells a later guard "this clone has been recorded since before
//! it could hold members-only commits" apart from "unknown".
//!
//! **Where.** One ledger per repository, in its common directory (`git rev-parse
//! --git-common-dir`), so every worktree of a clone shares it: with `git worktree`, `GIT_DIR` is
//! `.git/worktrees/<name>` and a per-worktree file would let a new worktree of a clone that holds
//! members-only objects start with an empty "never held" ledger. D21 names `$GIT_DIR/dash/sealed`;
//! that path is already the folder where a private push keeps its sealed pack for a retry, so
//! the ledger takes its own name.
//!
//! **When.** Only when the repository cannot have held anything yet: on a clone (`option
//! cloning`, or a `list` into a repository with no refs, which is how a clone of an empty
//! repository starts), and on a fetch into a repository with no refs (`git init`, then fetch).
//! Never merely because the file is missing: an older clone gets one from `dg doctor`, after the
//! user confirms it never fetched members-only branches.
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

/// `<common dir>/dash/sealed-ledger`.
pub fn path(common_dir: &Path) -> PathBuf {
    common_dir.join("dash").join("sealed-ledger")
}

/// Create the empty ledger in `common_dir` unless one exists. `Ok(true)` when it was created.
/// Never truncates: the file is opened with `create_new`.
pub fn create_empty(common_dir: &Path) -> std::io::Result<bool> {
    let p = path(common_dir);
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

/// Create the ledger of the repository git spawned the helper for, when it cannot have held
/// anything yet: a clone (`cloning`) or a repository with no refs. A failure is logged, never
/// fatal: the fetch is what the user asked for, and a missing ledger only makes a later guard
/// ask.
pub fn ensure_for_new_clone(cloning: bool) {
    if !cloning && crate::git::LocalRepo::has_refs() {
        return;
    }
    let Ok(dir) = crate::git::LocalRepo::common_dir() else {
        return;
    };
    if let Err(e) = create_empty(&dir) {
        tracing::warn!(error = %e, path = %path(&dir).display(), "could not create the sealed-object ledger");
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
    fn it_sits_beside_the_sealed_pack_cache() {
        // A private push keeps its sealed pack in `dash/sealed/`: both fit side by side.
        let d = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(d.path().join("dash").join("sealed")).unwrap();
        assert!(create_empty(d.path()).unwrap());
        assert!(d.path().join("dash").join("sealed").is_dir());
    }
}
