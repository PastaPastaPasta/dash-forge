//! Git data through the ordinary remote helper: pushing a bare mirror to `dash://…`.
//!
//! No special path (PRD 06): the helper's pack pipeline, storage policy (`dash.storage`,
//! `dash.replicas`, ...), resumable chunk journal and idempotency all apply. A ref already at
//! its tip is not pushed and a pack already recorded is not stored again, so re-running a
//! sync with nothing new costs nothing.
//!
//! **The cap reaches into the push.** A push is first priced with a dry run (the helper
//! builds the pack and estimates, storing nothing); that estimate is charged to the run's
//! budget, and only then is the real push made. The importer reads the helper's JSON
//! progress events (`GIT_DASH_JSON=1`) for what each push planned and charged.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;

use forge_core::network::NetworkTarget;

/// Serialized size the helper assumes for one `refUpdate`.
const REF_UPDATE_BYTES: u64 = 200;

/// The refspecs a mirror push sends: branches and tags (forced, so a force-push upstream is
/// mirrored as one), and PR heads under `refs/mirror/pull/<n>/head` so imported PRs are
/// checkoutable. Deletions come from `--prune`.
fn refspecs(pull_heads: bool) -> Vec<&'static str> {
    let mut v = vec!["+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"];
    if pull_heads {
        v.push("+refs/pull/*/head:refs/mirror/pull/*/head");
    }
    v
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
    /// What the helper measured as charged, when it reported one.
    pub charged_credits: Option<u64>,
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
            Some("done") if v.get("charge").and_then(Value::as_str) == Some("measured") => {
                r.charged_credits = v.get("chargedCredits").and_then(Value::as_u64);
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
    /// Mirror PR heads too.
    pub pull_heads: bool,
}

/// Price the first push into a repository that does not exist yet (so the helper cannot
/// be asked): build the whole pack locally and price it as Platform chunks, plus a
/// manifest and browse-index fragment, plus a ref update per ref. An upper bound when the
/// storage policy puts the pack on your own storage instead.
pub fn estimate_fresh(git_dir: &Path, pull_heads: bool) -> Result<PushReport> {
    let mut patterns = vec!["refs/heads/", "refs/tags/"];
    if pull_heads {
        patterns.push("refs/pull/");
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
    let chunk = |len: u64| crate::budget::git_doc_credits(len + CHUNK_OVERHEAD);
    let payload = forge_core::pack::DOC_PAYLOAD_MAX as u64;
    let chunks = |len: u64| {
        let tail = if len.is_multiple_of(payload) {
            0
        } else {
            chunk(len % payload)
        };
        (len / payload) * chunk(payload) + tail
    };
    let locator = LOCATOR_HEADER + LOCATOR_ROW * objects;
    let est = chunks(bytes)
        + chunks(locator)
        + 2 * crate::budget::git_doc_credits(MANIFEST_BYTES)
        + refs * crate::budget::git_doc_credits(REF_UPDATE_BYTES);
    Ok(PushReport {
        refs,
        packs: 1,
        pack_bytes: bytes,
        est_credits: est,
        charged_credits: None,
    })
}

/// Per-`chunk` overhead, manifest size and browse-index geometry, as the helper prices them.
const CHUNK_OVERHEAD: u64 = 120;
const MANIFEST_BYTES: u64 = 400;
const LOCATOR_HEADER: u64 = 1_100;
const LOCATOR_ROW: u64 = 36;

impl GitPusher {
    /// Price the push: the helper builds the pack and estimates, storing nothing. The
    /// estimate never counts fewer ref updates than git reports.
    pub fn estimate(&self) -> Result<PushReport> {
        let mut r = self.run(true)?;
        // The helper prices documents by their bytes; forge-v2 index storage adds about
        // GIT_DOC_INDEX_OVERHEAD per document (measured). Add it for the documents the helper
        // said it would write: two manifests per pack, a chunk per ~14.7 KB, a ref update per ref.
        let payload = forge_core::pack::DOC_PAYLOAD_MAX as u64;
        let docs = r.refs + r.packs * (2 + r.pack_bytes.div_ceil(payload.max(1)));
        r.est_credits = r
            .est_credits
            .saturating_add(docs * crate::budget::GIT_DOC_INDEX_OVERHEAD);
        Ok(r)
    }

    /// Push for real. The caller has already charged [`Self::estimate`] to its budget; the
    /// helper's own guard is off (`dash.confirm=never`) so nothing waits on a terminal.
    pub fn push(&self) -> Result<PushReport> {
        self.run(false)
    }

    fn run(&self, dry_run: bool) -> Result<PushReport> {
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(&self.git_dir).args([
            "-c",
            "dash.confirm=never",
            "push",
            "--porcelain",
            "--prune",
        ]);
        if dry_run {
            cmd.arg("--dry-run");
        }
        cmd.arg(&self.url).args(refspecs(self.pull_heads));
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
                charged_credits: Some(1100),
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
    fn pr_heads_are_pushed_only_when_asked() {
        assert!(refspecs(true)
            .iter()
            .any(|s| s.contains("refs/mirror/pull")));
        assert!(!refspecs(false)
            .iter()
            .any(|s| s.contains("refs/mirror/pull")));
    }
}
