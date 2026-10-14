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
//! The format, its reader and its appender are [`forge_core::members_git::ledger`] (shared with
//! `dg doctor`); this module only decides when a clone creates it.

use forge_core::members_git::ledger::{create_empty, path};

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

/// `git-remote-dash --init-ledger`: create the empty ledger of the repository in the current
/// directory, for a clone made before the helper created one. Only after the user confirmed the
/// clone never fetched members-only branches (`dg doctor --init-ledger` asks): an empty ledger
/// says "never held members-only commits". An existing ledger is left as it is.
pub fn init() -> anyhow::Result<()> {
    let dir = crate::git::LocalRepo::common_dir()?;
    let made = create_empty(&dir)?;
    println!(
        "{}",
        serde_json::json!({ "ledger": path(&dir), "created": made })
    );
    Ok(())
}

/// `git-remote-dash --install-hook`: install the `pre-push` hook in the directory git runs hooks
/// from (`core.hooksPath` included), keeping a pre-push hook it finds there as
/// [`forge_core::members_git::hook::CHAINED`].
pub fn install_hook() -> anyhow::Result<()> {
    let dir = crate::members::hooks_dir()?;
    let me = crate::members::this_helper()
        .ok_or_else(|| anyhow::anyhow!("can't tell where this git-remote-dash is installed"))?;
    let done = forge_core::members_git::hook::install(&dir, &me)?;
    println!(
        "{}",
        serde_json::json!({ "hook": dir.join("pre-push"), "installed": format!("{done:?}").to_lowercase() })
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::members_git::ledger::HEADER;

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
