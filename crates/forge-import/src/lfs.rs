//! Git LFS detection (FEAT-18). A repository that tracks files with LFS holds small pointer
//! files in git; the large files themselves live on the source's LFS server and are not part of
//! any pack. A mirror of it is therefore missing them, silently, unless the run says so.

use std::path::Path;
use std::process::Command;

/// The warning a run adds (to its output and the Mirror Action's job summary) for such a source.
pub const WARNING: &str = "this repository tracks files with Git LFS (a .gitattributes sets \
filter=lfs): the mirror holds the LFS pointer files only, not the large files they stand for, \
which stay on the source; Dash Forge does not mirror LFS objects";

/// Whether any `.gitattributes` at `rev` of the repository at `git_dir` (a bare mirror) sets
/// `filter=lfs`, at the top or in a directory. `rev` is the default branch (`HEAD` when the
/// source named none). A repository that cannot be read counts as "no": the run goes on.
pub fn detect(git_dir: &Path, default_branch: &str) -> bool {
    let rev = if default_branch.is_empty() {
        "HEAD".to_string()
    } else {
        format!("refs/heads/{default_branch}")
    };
    let out = Command::new("git")
        .arg("--git-dir")
        .arg(git_dir)
        .args([
            "grep",
            "-l",
            "-E",
            r"(^|[[:space:]])filter=lfs([[:space:]]|$)",
        ])
        .arg(&rev)
        .args(["--", ":(glob)**/.gitattributes"])
        .output();
    match out {
        // 0: a match; 1: none.
        Ok(o) => o.status.success(),
        Err(e) => {
            tracing::warn!(error = %e, "could not look for Git LFS in the mirror");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .current_dir(dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .args(args)
            .output()
            .expect("git runs");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A repository on `main` holding `files` (path, contents).
    fn repo(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q", "-b", "main"]);
        for (path, body) in files {
            let full = dir.path().join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, body).unwrap();
            git(dir.path(), &["add", path]);
        }
        git(dir.path(), &["commit", "-q", "-m", "x"]);
        dir
    }

    fn found(files: &[(&str, &str)], branch: &str) -> bool {
        let dir = repo(files);
        detect(&dir.path().join(".git"), branch)
    }

    #[test]
    fn lfs_filters_in_a_gitattributes_are_found() {
        let lfs = "*.psd filter=lfs diff=lfs merge=lfs -text\n";
        assert!(found(&[(".gitattributes", lfs)], "main"));
        assert!(
            found(&[(".gitattributes", lfs)], ""),
            "HEAD when no branch is named"
        );
        // In a directory too, and with the filter last on the line.
        assert!(found(
            &[("assets/.gitattributes", "*.bin -text filter=lfs")],
            "main"
        ));
    }

    #[test]
    fn other_attributes_and_other_branches_are_not_lfs() {
        assert!(!found(&[(".gitattributes", "*.sh text eol=lf\n")], "main"));
        assert!(!found(&[("a.txt", "x")], "main"));
        // A near miss is not the lfs filter, and a file that only mentions it is not a
        // `.gitattributes`.
        assert!(!found(&[(".gitattributes", "*.x filter=lfsx\n")], "main"));
        assert!(!found(&[("notes.md", "use filter=lfs\n")], "main"));
        // A branch that is not there, or a directory that is no repository: no.
        assert!(!found(&[(".gitattributes", "*.x filter=lfs\n")], "nope"));
        assert!(!detect(Path::new("/nonexistent/forge-import-lfs"), "main"));
    }
}
