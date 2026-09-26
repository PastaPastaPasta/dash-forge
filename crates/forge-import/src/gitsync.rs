//! Git data through the ordinary remote helper: pushing a bare mirror to `dash://…`.
//!
//! No special path (PRD 06): the helper's pack pipeline, storage policy (`dash.storage`,
//! `dash.replicas`, ...), resumable chunk journal and idempotency all apply. A ref already at
//! its tip is not pushed and a pack already recorded is not stored again, so re-running a
//! sync with nothing new costs nothing.
//!
//! **The cap reaches into the push.** A push is first priced with a dry run (the helper
//! builds the pack and estimates, storing nothing); that estimate is charged to the run's
//! budget, and only then is the real push made, with the helper's own cost guard set to the
//! run's remaining budget (`dash.costWarnThreshold`; there is no terminal, so above it the
//! helper refuses before storing anything). The importer reads the helper's JSON progress
//! events (`GIT_DASH_JSON=1`) for what each push planned and charged.
//!
//! Branches and tags are one push; the heads of **open** PRs (`refs/mirror/pull/<n>/head`)
//! are a second, so a stranger's large PR can fail only its own push, never the mirror of
//! branches, tags and issues.

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
            Refs::PullHeads(open) => open
                .iter()
                .map(|n| format!("+refs/pull/{n}/head:refs/mirror/pull/{n}/head"))
                .collect(),
        }
    }

    /// `for-each-ref` patterns of what this push sends (the fresh estimate).
    fn local_patterns(&self) -> Vec<String> {
        match self {
            Refs::Code => vec!["refs/heads/".into(), "refs/tags/".into()],
            Refs::PullHeads(open) => open.iter().map(|n| format!("refs/pull/{n}/head")).collect(),
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
    /// The helper's estimate of what it stores.
    pub est_credits: u64,
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
            Some("platform") => r.est_credits += num("estCredits"),
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

/// Price the first push into a repository that does not exist yet (so the helper cannot
/// be asked): build the whole pack locally and price it as Platform chunks, plus a
/// manifest and browse-index fragment, plus a ref update per ref. An upper bound when the
/// storage policy puts the pack on your own storage instead.
pub fn estimate_fresh(git_dir: &Path, refs: &Refs) -> Result<PushReport> {
    let patterns = refs.local_patterns();
    if patterns.is_empty() {
        return Ok(PushReport::default());
    }
    let out = Command::new("git")
        .arg("-C")
        .arg(git_dir)
        .args(["for-each-ref", "--format=%(objectname)"])
        .args(&patterns)
        .output()
        .context("listing the mirror's refs")?;
    if !out.status.success() {
        bail!("git for-each-ref failed in {}", git_dir.display());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let tips: Vec<&str> = text.lines().filter(|l| !l.is_empty()).collect();
    let refs = tips.len() as u64;
    if tips.is_empty() {
        return Ok(PushReport::default());
    }
    let mut unique = tips.clone();
    unique.sort_unstable();
    unique.dedup();
    let pack =
        forge_core::pack::build_pack(git_dir, &unique, &[]).context("sizing the first push")?;
    let bytes = pack.bytes.len() as u64;
    let objects = pack.parsed.object_count() as u64;
    let locator = LOCATOR_HEADER + LOCATOR_ROW * objects;
    let est = chunked_credits(bytes)
        + chunked_credits(locator)
        + 2 * git_doc_credits(MANIFEST_BYTES)
        + refs * git_doc_credits(REF_UPDATE_BYTES);
    Ok(PushReport {
        refs,
        packs: 1,
        pack_bytes: bytes,
        est_credits: est,
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
        let docs = r.refs + r.packs * (2 + r.pack_bytes.div_ceil(payload.max(1)));
        r.est_credits = r.est_credits.saturating_add(docs * GIT_DOC_INDEX_OVERHEAD);
        Ok(r)
    }

    /// Push for real. The caller has already charged [`Self::estimate`] to its budget.
    /// `max_credits` (the run's remaining budget) arms the helper's cost guard: a push the
    /// helper prices above it is refused before anything is stored.
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
            // No terminal: above the threshold the helper refuses (E801), below it proceeds.
            Some(max) => cmd.args([
                "-c".to_string(),
                "dash.confirm=auto".to_string(),
                "-c".to_string(),
                format!("dash.costWarnThreshold={}", threshold_dash(max)),
            ]),
            None => cmd.args(["-c", "dash.confirm=never"]),
        };
        cmd.args(["push", "--porcelain"]);
        if self.refs == Refs::Code {
            cmd.arg("--prune");
        }
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
            vec![
                "+refs/pull/3/head:refs/mirror/pull/3/head",
                "+refs/pull/7/head:refs/mirror/pull/7/head"
            ]
        );
        assert!(Refs::PullHeads(Vec::new()).refspecs().is_empty());
    }

    #[test]
    fn the_guard_threshold_never_rounds_up_past_the_budget() {
        assert_eq!(threshold_dash(123_456_789), "0.00123456");
        assert_eq!(threshold_dash(0), "0.00000000");
    }
}
