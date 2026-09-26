//! Git data through the ordinary remote helper: pushing a bare mirror to `dash://…`.
//!
//! No special path (PRD 06): the helper's pack pipeline, storage policy (`dash.storage`,
//! `dash.replicas`, ...), resumable chunk journal and idempotency all apply. A ref already at
//! its tip is not pushed and a pack already recorded is not stored again, so re-running a
//! sync with nothing new costs nothing.
//!
//! **The cap reaches into the push.** A push is first priced with a dry run (the helper
//! builds the pack and estimates, storing nothing); that estimate is charged to the run's
//! budget, and only then is the real push made, with the helper's own cost guard set to what
//! the budget had left before the charge, in the helper's own units (its raw price, without
//! the forge-v2 index overhead the importer adds), and `dash.confirm=refuse`: the helper
//! never asks, even on a terminal, and refuses above the threshold before storing anything.
//! The importer reads the helper's JSON progress events (`GIT_DASH_JSON=1`) for what each
//! push planned and charged.
//!
//! Branches and tags are one push; the heads of **open** PRs (`refs/mirror/pull/<n>/head`)
//! are a second, optional one, so a stranger's large PR can fail only its own push, never the
//! mirror of branches, tags and issues. It prunes the heads of PRs that closed.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;

use forge_core::network::NetworkTarget;

use crate::budget::{chunked_credits, git_doc_credits, GIT_DOC_INDEX_OVERHEAD, REF_UPDATE_BYTES};

/// What one push sends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refs {
    /// Branches and tags (forced, so a force-push upstream is mirrored as one); deletions
    /// come from `--prune`.
    Code,
    /// The heads of these open PRs, as `refs/mirror/pull/<n>/head` (checkoutable).
    PullHeads(Vec<u64>),
}

impl Refs {
    fn refspecs(&self) -> Vec<String> {
        match self {
            Refs::Code => vec![
                "+refs/heads/*:refs/heads/*".into(),
                "+refs/tags/*:refs/tags/*".into(),
            ],
            // One wildcard over the mirror's local `refs/mirror/pull/*`, which
            // [`sync_pull_heads`] keeps to exactly the open PRs, so `--prune` deletes the
            // heads of PRs that closed (also when none is open any more: the push then only
            // deletes).
            Refs::PullHeads(_) => vec!["+refs/mirror/pull/*:refs/mirror/pull/*".into()],
        }
    }

    /// `for-each-ref` patterns of what this push sends (the fresh estimate).
    fn local_patterns(&self) -> Vec<String> {
        match self {
            Refs::Code => vec!["refs/heads/".into(), "refs/tags/".into()],
            Refs::PullHeads(_) => vec!["refs/mirror/pull/".into()],
        }
    }
}

/// What a push did (or would do), from the helper's progress events.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PushReport {
    /// Refs git updated (created, moved or deleted).
    pub refs: u64,
    /// Packs stored.
    pub packs: u64,
    /// Bytes in them.
    pub pack_bytes: u64,
    /// The estimate of what it stores (credits), forge-v2 index overhead included.
    pub est_credits: u64,
    /// The helper's own price for it (no index overhead): what its cost guard compares
    /// `dash.costWarnThreshold` against.
    pub helper_credits: u64,
    /// Documents the helper said it writes (chunks + manifests + ref updates), when it
    /// reported them.
    pub docs: u64,
}

impl PushReport {
    /// What [`Self::est_credits`] adds on top of the helper's price.
    pub fn overhead(&self) -> u64 {
        self.est_credits.saturating_sub(self.helper_credits)
    }
}

/// Fold the helper's JSON events (`stderr`, one object per line) and git's porcelain
/// (`stdout`) into a [`PushReport`].
pub fn parse_push(stdout: &str, stderr: &str) -> PushReport {
    let mut r = PushReport::default();
    for line in stderr.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let num = |k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(0);
        match v.get("event").and_then(Value::as_str) {
            Some("plan") if num("objects") > 0 => {
                r.packs += 1;
                r.pack_bytes += num("bytes");
            }
            Some("platform") => {
                r.docs += num("chunks") + num("manifests") + num("refUpdates");
                r.est_credits += num("estCredits");
                r.helper_credits += num("estCredits");
            }
            _ => {}
        }
    }
    // Porcelain: `<flag>\t<from>:<to>\t<summary>`; `=` is up to date, `!` rejected.
    r.refs = stdout
        .lines()
        .filter(|l| l.contains('\t'))
        .filter(|l| matches!(l.chars().next(), Some(' ' | '+' | '-' | '*')))
        .count() as u64;
    r
}

/// Pushes a bare mirror to a `dash://` remote through `git-remote-dash`.
pub struct GitPusher {
    /// The bare mirror.
    pub git_dir: PathBuf,
    /// `dash://owner/name`.
    pub url: String,
    /// The signing identity source (a file path or an inline `dfk1:` key).
    pub key: PathBuf,
    /// The network (its env vars are handed to the helper).
    pub network: NetworkTarget,
    /// What to push.
    pub refs: Refs,
}

/// Make the mirror's local `refs/mirror/pull/<n>/head` exactly the heads of the `open` PRs
/// it fetched (`refs/pull/<n>/head`); a PR whose head was not fetched is left out.
pub fn sync_pull_heads(git_dir: &Path, open: &[u64]) -> Result<()> {
    use std::fmt::Write as _;
    let git = |args: &[&str]| -> Result<String> {
        let out = Command::new("git")
            .arg("-C")
            .arg(git_dir)
            .args(args)
            .output()
            .context("running git")?;
        if !out.status.success() {
            bail!(
                "git {} failed: {}",
                args.first().unwrap_or(&""),
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    };
    let mut script = String::new();
    let mut keep = std::collections::BTreeSet::new();
    for n in open {
        let src = format!("refs/pull/{n}/head");
        if let Ok(oid) = git(&["rev-parse", "--verify", "--quiet", &src]) {
            let dst = format!("refs/mirror/pull/{n}/head");
            let _ = writeln!(script, "update {dst} {}", oid.trim());
            keep.insert(dst);
        }
    }
    for name in git(&["for-each-ref", "--format=%(refname)", "refs/mirror/pull/"])?.lines() {
        if !keep.contains(name) {
            let _ = writeln!(script, "delete {name}");
        }
    }
    let mut child = Command::new("git")
        .arg("-C")
        .arg(git_dir)
        .args(["update-ref", "--stdin"])
        .stdin(std::process::Stdio::piped())
        .spawn()
        .context("running git update-ref")?;
    {
        use std::io::Write as _;
        child
            .stdin
            .take()
            .expect("piped")
            .write_all(script.as_bytes())?;
    }
    if !child.wait()?.success() {
        bail!("git update-ref failed in {}", git_dir.display());
    }
    Ok(())
}

/// The tips of the mirror's refs matching `patterns`.
fn local_tips(git_dir: &Path, patterns: &[String]) -> Result<Vec<String>> {
    if patterns.is_empty() {
        return Ok(Vec::new());
    }
    let out = Command::new("git")
        .arg("-C")
        .arg(git_dir)
        .args(["for-each-ref", "--format=%(objectname)"])
        .args(patterns)
        .output()
        .context("listing the mirror's refs")?;
    if !out.status.success() {
        bail!("git for-each-ref failed in {}", git_dir.display());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect())
}

/// Price the first push into a repository that does not exist yet (so the helper cannot
/// be asked): build the pack locally and price it as Platform chunks, plus a manifest and
/// browse-index fragment, plus a ref update per ref. The PR heads' pack leaves out what the
/// branches and tags already carry (it is pushed after them). An upper bound when the
/// storage policy puts the pack on your own storage instead.
pub fn estimate_fresh(git_dir: &Path, refs: &Refs) -> Result<PushReport> {
    let tips = local_tips(git_dir, &refs.local_patterns())?;
    let refs_n = tips.len() as u64;
    if tips.is_empty() {
        return Ok(PushReport::default());
    }
    let mut unique: Vec<&str> = tips.iter().map(String::as_str).collect();
    unique.sort_unstable();
    unique.dedup();
    let bases = match refs {
        Refs::Code => Vec::new(),
        Refs::PullHeads(_) => local_tips(git_dir, &Refs::Code.local_patterns())?,
    };
    let bases: Vec<&str> = bases.iter().map(String::as_str).collect();
    let pack =
        forge_core::pack::build_pack(git_dir, &unique, &bases).context("sizing the first push")?;
    let bytes = pack.bytes.len() as u64;
    let objects = pack.parsed.object_count() as u64;
    let locator = LOCATOR_HEADER + LOCATOR_ROW * objects;
    let est = chunked_credits(bytes)
        + chunked_credits(locator)
        + 2 * git_doc_credits(MANIFEST_BYTES)
        + refs_n * git_doc_credits(REF_UPDATE_BYTES);
    Ok(PushReport {
        refs: refs_n,
        packs: 1,
        pack_bytes: bytes,
        est_credits: est,
        // No helper price for a repo that does not exist yet; the estimate stands in.
        helper_credits: est,
        docs: 0,
    })
}

/// Manifest size and browse-index geometry, as the helper prices them.
const MANIFEST_BYTES: u64 = 400;
const LOCATOR_HEADER: u64 = 1_100;
const LOCATOR_ROW: u64 = 36;

impl GitPusher {
    /// Price the push: the helper builds the pack and estimates, storing nothing. The
    /// estimate never counts fewer ref updates than git reports.
    pub fn estimate(&self) -> Result<PushReport> {
        let mut r = self.run(true, None)?;
        // The helper prices documents by their bytes; forge-v2 index storage adds about
        // GIT_DOC_INDEX_OVERHEAD per document (measured). Add it for the documents the helper
        // said it would write: two manifests per pack, a chunk per ~14.7 KB, a ref update per ref.
        let payload = forge_core::pack::DOC_PAYLOAD_MAX as u64;
        let guessed = r.refs + r.packs * (2 + r.pack_bytes.div_ceil(payload.max(1)));
        let docs = if r.docs > 0 { r.docs } else { guessed };
        r.est_credits = r.est_credits.saturating_add(docs * GIT_DOC_INDEX_OVERHEAD);
        Ok(r)
    }

    /// Push for real. The caller has already charged [`Self::estimate`] to its budget.
    /// `max_credits` (in the helper's units: the budget left before that charge, less the
    /// estimate's index overhead) arms the helper's cost guard: a push the helper prices
    /// above it is refused before anything is stored.
    pub fn push(&self, max_credits: Option<u64>) -> Result<PushReport> {
        self.run(false, max_credits)
    }

    fn run(&self, dry_run: bool, max_credits: Option<u64>) -> Result<PushReport> {
        let spec = self.refs.refspecs();
        if spec.is_empty() {
            return Ok(PushReport::default());
        }
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(&self.git_dir);
        match max_credits {
            // Never a prompt (even on a terminal): above the threshold the helper refuses
            // (E801), below it proceeds.
            Some(max) => cmd.args([
                "-c".to_string(),
                "dash.confirm=refuse".to_string(),
                "-c".to_string(),
                format!("dash.costWarnThreshold={}", threshold_dash(max)),
            ]),
            None => cmd.args(["-c", "dash.confirm=never"]),
        };
        cmd.args(["push", "--porcelain", "--prune"]);
        if dry_run {
            cmd.arg("--dry-run");
        }
        cmd.arg(&self.url).args(&spec);
        cmd.env("PATH", helper_path()?)
            .env("DASH_FORGE_KEY", &self.key)
            .env("GIT_DASH_JSON", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .envs(self.network.env_vars());
        let out = cmd.output().context("running git")?;
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        if !out.status.success() {
            let why: Vec<&str> = stderr
                .lines()
                .filter(|l| !l.trim_start().starts_with('{'))
                .collect();
            bail!(
                "pushing to {}{} failed:\n{}",
                self.url,
                if dry_run { " (dry run)" } else { "" },
                why.join("\n").trim()
            );
        }
        Ok(parse_push(&stdout, &stderr))
    }
}

/// Whether a push error is the helper's cost guard refusing before it stored anything
/// (E801 with its "nothing was stored or paid for" note).
pub fn refused_before_storing(e: &anyhow::Error) -> bool {
    let text = format!("{e:#}");
    text.contains("E801") && text.contains("nothing was stored or paid for")
}

/// A credit amount as the DASH string `dash.costWarnThreshold` takes, rounded DOWN (to
/// 10⁻⁸ DASH) so the guard never admits more than the budget.
fn threshold_dash(credits: u64) -> String {
    let units = credits / 1_000; // 1 DASH = 10¹¹ credits = 10⁸ units of 10³ credits
    format!("{}.{:08}", units / 100_000_000, units % 100_000_000)
}

/// `PATH` with the directory of this binary first, so the `git-remote-dash` shipped next
/// to it is the one git runs.
fn helper_path() -> Result<String> {
    let dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .ok_or_else(|| anyhow!("cannot locate this binary's directory"))?;
    let path = std::env::var("PATH").unwrap_or_default();
    Ok(format!("{}:{path}", dir.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_events_and_porcelain_fold_into_a_report() {
        let stderr = r#"{"event":"plan","repo":"o/r","refs":["main"],"tip":"ab","objects":3,"bytes":900}
{"event":"targets","estCredits":5}
{"event":"platform","chunks":1,"manifests":2,"refUpdates":2,"estCredits":1234}
{"event":"done","chargedCredits":1100,"charge":"measured","remainingCredits":9}
dash: some human line"#;
        let stdout = "To dash://o/r\n*\trefs/heads/main:refs/heads/main\t[new branch]\n=\trefs/tags/v1:refs/tags/v1\t[up to date]\n-\t:refs/heads/old\t[deleted]\nDone\n";
        assert_eq!(
            parse_push(stdout, stderr),
            PushReport {
                refs: 2,
                packs: 1,
                pack_bytes: 900,
                est_credits: 1234,
                helper_credits: 1234,
                docs: 5,
            }
        );
    }

    #[test]
    fn an_up_to_date_push_reports_nothing() {
        let r = parse_push(
            "=\trefs/heads/main:refs/heads/main\t[up to date]\nDone\n",
            "",
        );
        assert_eq!(r, PushReport::default());
    }

    #[test]
    fn code_and_open_pr_heads_are_separate_pushes() {
        let code = Refs::Code.refspecs();
        assert!(code.iter().all(|s| !s.contains("pull")));
        assert_eq!(
            Refs::PullHeads(vec![3, 7]).refspecs(),
            vec!["+refs/mirror/pull/*:refs/mirror/pull/*"]
        );
        // No PR open: still pushed, so the last closed head is pruned.
        assert_eq!(Refs::PullHeads(Vec::new()).refspecs().len(), 1);
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {out:?}");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn local_pull_heads_follow_the_open_prs_only() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        git(d, &["init", "-q"]);
        git(d, &["commit", "-q", "--allow-empty", "-m", "a"]);
        let oid = git(d, &["rev-parse", "HEAD"]);
        for n in ["1", "2", "3"] {
            git(d, &["update-ref", &format!("refs/pull/{n}/head"), &oid]);
        }
        sync_pull_heads(d, &[1, 2, 9]).unwrap();
        let heads = || {
            git(
                d,
                &["for-each-ref", "--format=%(refname)", "refs/mirror/pull/"],
            )
        };
        assert_eq!(heads(), "refs/mirror/pull/1/head\nrefs/mirror/pull/2/head");
        // PR 1 closed: its head leaves the local namespace, so `--prune` deletes it.
        sync_pull_heads(d, &[2]).unwrap();
        assert_eq!(heads(), "refs/mirror/pull/2/head");
    }

    #[test]
    fn the_guard_threshold_never_rounds_up_past_the_budget() {
        assert_eq!(threshold_dash(123_456_789), "0.00123456");
        assert_eq!(threshold_dash(0), "0.00000000");
    }
}
