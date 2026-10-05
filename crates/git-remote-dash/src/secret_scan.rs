//! The secret scan of a public push: warnings, and E807 for the likely secrets a push would
//! publish for the first time (mixed-visibility design §4.5; the rules are [`forge_secrets`]).
//!
//! **What is scanned.** Every file a commit new to Forge introduces: the commits reachable from
//! the pushed tips and not from the remote's current tips this clone holds (`git log <tips>
//! --not <remote tips>`). For a merge, only the files that differ from every parent (`-c`), so
//! a merge of an old branch does not re-report that branch's files as the merge's.
//!
//! **New or history.** Forge records no import marker in git, so the import point is when the
//! repository was created on Forge (its `repo` document's `$createdAt`), less
//! [`IMPORT_GRACE_MS`]. A file whose every introducing commit is older (by committer date) is
//! imported history, and its findings only warn. A push that forge-import makes
//! (`DASH_FORGE_SPAWNED_BY=forge-import`) is all history: a mirror republishes its source. When
//! the creation time cannot be read, every new commit counts as new.
//!
//! **Allowing.** `-o allow-secret=<fingerprint>` and the `.forge/secret-scan-allow` file at
//! the tip of any branch or tag in the push ([`forge_secrets::AllowList`]).
//!
//! **Refusing.** A ref is refused (wire reason [`WIRE`]) when its new commits introduce a
//! finding that refuses. Other refs in the push go ahead.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::Result;
use forge_core::user_error::{codes, UserError};
use forge_secrets::{
    scan_file, verdict, AllowList, Finding, Rule, Severity, Verdict, WarnReason, ALLOW_FILE,
    ALLOW_PUSH_OPTION, MAX_SCAN_BYTES,
};
use serde_json::json;

use crate::git::{git_in, git_ok_in};

/// Commits made this long before the repository was created on Forge still count as new: the
/// usual `git init`, commit, `dg repo create`, push takes minutes, not a day.
pub const IMPORT_GRACE_MS: u64 = 24 * 60 * 60 * 1000;

/// File bytes read from history (before the import point) at most; later history files are
/// matched by name only. History only ever warns, and an import can be gigabytes.
pub const HISTORY_CONTENT_BUDGET: u64 = 64 << 20;

/// File bytes read per `git cat-file --batch` call.
const READ_CHUNK_BYTES: u64 = 8 << 20;

/// Warnings printed one per line; the rest are counted.
pub const MAX_WARNINGS_SHOWN: usize = 20;

/// The per-ref reason git prints: `! [remote rejected] main -> main (possible secret in new files)`.
pub const WIRE: &str = "possible secret in new files";

/// What to scan.
pub struct Request<'a> {
    /// The repository (`None`: the one git spawned the helper for).
    pub repo: Option<&'a Path>,
    /// `(index, new tip)` of each ref the push writes (not deletions).
    pub tips: Vec<(usize, String)>,
    /// The remote's current tips this clone holds.
    pub known: Vec<String>,
    /// When the repository was created on Forge (ms), when known.
    pub created_at_ms: Option<u64>,
    /// forge-import's mirror push: everything is history.
    pub mirror: bool,
    /// Fingerprints from `-o allow-secret=`.
    pub allow: AllowList,
}

impl Request<'_> {
    /// Fingerprints from the push options; a malformed one is ignored (and said so).
    pub fn allow_from_options(options: &crate::options::OptionState) -> AllowList {
        let mut allow = AllowList::new();
        for fp in options.push_option_values(ALLOW_PUSH_OPTION) {
            if !allow.add_fingerprint(fp) {
                eprintln!(
                    "dash: warning: -o {ALLOW_PUSH_OPTION}={fp} is not a fingerprint (12 hex digits), ignored"
                );
            }
        }
        allow
    }
}

/// One finding and what it does.
#[derive(Debug, Clone)]
pub struct Item {
    /// The finding.
    pub finding: Finding,
    /// The newest commit that introduced the file (40 hex).
    pub commit: String,
    /// Refuse or warn, and why.
    pub verdict: Verdict,
    /// Every commit that introduced this file version.
    commits: Vec<String>,
}

/// The scan's result.
#[derive(Debug, Default)]
pub struct Scan {
    /// Findings that warn.
    pub warnings: Vec<Item>,
    /// Findings that refuse.
    pub refusals: Vec<Item>,
    /// `(ref index, refusal indices)` of each ref refused.
    pub refused: Vec<(usize, Vec<usize>)>,
    /// Findings the allow list allowed.
    pub allowed: usize,
    /// History files matched by name only (over [`HISTORY_CONTENT_BUDGET`]).
    pub unscanned_history: usize,
}

/// A file version a new commit introduces.
struct Introduced {
    path: String,
    blob: String,
    /// `(commit, committer time in seconds)`, newest first.
    commits: Vec<(String, u64)>,
}

/// Scan the push in `req`.
pub fn scan(req: &Request<'_>) -> Result<Scan> {
    let mut scan = Scan::default();
    let tips = commits_only(
        req.repo,
        &req.tips.iter().map(|(_, t)| t.clone()).collect::<Vec<_>>(),
    )?;
    if tips.is_empty() {
        return Ok(scan);
    }
    let known = commits_only(req.repo, &req.known)?;
    let files = introduced(req.repo, &tips, &known)?;
    if files.is_empty() {
        return Ok(scan);
    }
    let mut allow = req.allow.clone();
    for tip in &tips {
        let spec = format!("{tip}:{ALLOW_FILE}");
        if let Ok(text) = git_in(req.repo, &["cat-file", "-p", &spec], None) {
            allow.extend(AllowList::parse(&String::from_utf8_lossy(&text)));
        }
    }
    let new_since = |secs: u64| {
        !req.mirror
            && req
                .created_at_ms
                .is_none_or(|c| secs.saturating_mul(1000) + IMPORT_GRACE_MS >= c)
    };
    let history: Vec<bool> = files
        .iter()
        .map(|f| !f.commits.iter().any(|(_, t)| new_since(*t)))
        .collect();

    let (read, unscanned) = files_to_read(req.repo, &files, &history)?;
    scan.unscanned_history = unscanned;
    let mut findings = find_all(req.repo, &files, &read)?;

    findings.sort_by(|(_, a), (_, b)| {
        (&a.path, a.line, a.rule, &a.fingerprint).cmp(&(&b.path, b.line, b.rule, &b.fingerprint))
    });
    for (i, finding) in findings {
        if allow.allows(&finding) {
            scan.allowed += 1;
            continue;
        }
        let v = verdict(&finding, history[i]);
        let item = Item {
            finding,
            commit: files[i].commits[0].0.clone(),
            verdict: v,
            commits: files[i].commits.iter().map(|(c, _)| c.clone()).collect(),
        };
        match v.severity {
            Severity::Refuse => scan.refusals.push(item),
            Severity::Warn => scan.warnings.push(item),
        }
    }

    scan.refused = refused_refs(req, &scan.refusals);
    Ok(scan)
}

/// The blobs to read, with their sizes: within [`MAX_SCAN_BYTES`], and history only within
/// [`HISTORY_CONTENT_BUDGET`]; and how many history files the budget left unread.
fn files_to_read<'f>(
    repo: Option<&Path>,
    files: &'f [Introduced],
    history: &[bool],
) -> Result<(BTreeMap<&'f str, u64>, usize)> {
    let mut blobs: Vec<&str> = files.iter().map(|f| f.blob.as_str()).collect();
    blobs.sort_unstable();
    blobs.dedup();
    let sizes = blob_sizes(repo, &blobs)?;
    let mut read: BTreeMap<&str, u64> = BTreeMap::new();
    let mut unscanned = 0;
    let mut history_bytes = 0u64;
    let mut order: Vec<usize> = (0..files.len()).collect();
    // New files first, so the budget only ever limits history.
    order.sort_by_key(|&i| history[i]);
    for i in order {
        let blob = files[i].blob.as_str();
        let Some(&size) = sizes.get(blob) else {
            continue;
        };
        if size > MAX_SCAN_BYTES as u64 || read.contains_key(blob) {
            continue;
        }
        if history[i] {
            if history_bytes + size > HISTORY_CONTENT_BUDGET {
                unscanned += 1;
                continue;
            }
            history_bytes += size;
        }
        read.insert(blob, size);
    }
    Ok((read, unscanned))
}

/// Every finding in `files`: the blobs in `read` by content, read in chunks of
/// [`READ_CHUNK_BYTES`] so memory stays bounded; the others by name.
fn find_all(
    repo: Option<&Path>,
    files: &[Introduced],
    read: &BTreeMap<&str, u64>,
) -> Result<Vec<(usize, Finding)>> {
    let mut by_blob: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for (i, f) in files.iter().enumerate() {
        by_blob.entry(f.blob.as_str()).or_default().push(i);
    }
    let mut findings: Vec<(usize, Finding)> = Vec::new();
    let mut chunks: Vec<Vec<&str>> = vec![Vec::new()];
    let mut chunk_bytes = 0;
    for (&blob, &size) in read {
        if chunk_bytes + size > READ_CHUNK_BYTES && chunks.last().is_some_and(|c| !c.is_empty()) {
            chunks.push(Vec::new());
            chunk_bytes = 0;
        }
        chunks.last_mut().expect("one chunk").push(blob);
        chunk_bytes += size;
    }
    for chunk in chunks.iter().filter(|c| !c.is_empty()) {
        for (blob, bytes) in read_blobs(repo, chunk)? {
            for &i in by_blob.get(blob.as_str()).into_iter().flatten() {
                findings.extend(
                    scan_file(&files[i].path, Some(&bytes))
                        .into_iter()
                        .map(|f| (i, f)),
                );
            }
        }
    }
    for (i, f) in files.iter().enumerate() {
        if !read.contains_key(f.blob.as_str()) {
            findings.extend(scan_file(&f.path, None).into_iter().map(|x| (i, x)));
        }
    }
    Ok(findings)
}

/// `(ref index, refusal indices)` for each ref in `req` whose new history holds a refusal.
fn refused_refs(req: &Request<'_>, refusals: &[Item]) -> Vec<(usize, Vec<usize>)> {
    let mut out = Vec::new();
    for (index, tip) in &req.tips {
        let hits: Vec<usize> = refusals
            .iter()
            .enumerate()
            .filter(|(_, r)| {
                r.commits.iter().any(|c| {
                    c == tip || git_ok_in(req.repo, &["merge-base", "--is-ancestor", c, tip])
                })
            })
            .map(|(k, _)| k)
            .collect();
        if !hits.is_empty() {
            out.push((*index, hits));
        }
    }
    out
}

/// One `<item><suffix>\n` line per item: the stdin of a batch git command.
fn lines<T: std::fmt::Display>(items: &[T], suffix: &str) -> String {
    let mut out = String::new();
    for i in items {
        out.push_str(&i.to_string());
        out.push_str(suffix);
        out.push('\n');
    }
    out
}

/// The commits among `revs` (tags peeled); a tag of a tree or blob is left out.
fn commits_only(repo: Option<&Path>, revs: &[String]) -> Result<Vec<String>> {
    if revs.is_empty() {
        return Ok(Vec::new());
    }
    let input = lines(revs, "^{}");
    let out = git_in(
        repo,
        &["cat-file", "--batch-check=%(objectname) %(objecttype)"],
        Some(input.as_bytes()),
    )?;
    let mut commits: Vec<String> = String::from_utf8_lossy(&out)
        .lines()
        .filter_map(|l| l.strip_suffix(" commit"))
        .map(str::to_string)
        .collect();
    commits.sort();
    commits.dedup();
    Ok(commits)
}

/// Every file version the commits reachable from `tips` and not from `known` introduce.
fn introduced(repo: Option<&Path>, tips: &[String], known: &[String]) -> Result<Vec<Introduced>> {
    let mut revs = String::new();
    for t in tips {
        revs.push_str(t);
        revs.push('\n');
    }
    for k in known {
        revs.push('^');
        revs.push_str(k);
        revs.push('\n');
    }
    let out = git_in(
        repo,
        &[
            "-c",
            "log.showSignature=false",
            "log",
            "--stdin",
            "--no-color",
            "--no-renames",
            "--no-ext-diff",
            "--root",
            "-c",
            "--raw",
            "--no-abbrev",
            "-z",
            "--format=%x01%H %ct",
        ],
        Some(revs.as_bytes()),
    )?;
    Ok(parse_log(&out))
}

/// Parse [`introduced`]'s `git log -z --raw -c` output: `\x01<commit> <time>` headers, then
/// per changed file a `:…` (one colon per parent) metadata token and a path token. Kept: files
/// whose result is a regular file (mode 100644 or 100755) and not deleted.
fn parse_log(out: &[u8]) -> Vec<Introduced> {
    let mut by_file: BTreeMap<(String, String), Vec<(String, u64)>> = BTreeMap::new();
    let mut commit: Option<(String, u64)> = None;
    let mut tokens = out.split(|&b| b == 0).peekable();
    while let Some(tok) = tokens.next() {
        let tok = String::from_utf8_lossy(tok);
        let tok = tok.trim_start_matches('\n');
        if let Some(header) = tok.strip_prefix('\x01') {
            let mut parts = header.split(' ');
            let h = parts.next().unwrap_or_default().to_string();
            let t = parts
                .next()
                .and_then(|t| t.trim().parse().ok())
                .unwrap_or(0);
            commit = Some((h, t));
            continue;
        }
        let colons = tok.bytes().take_while(|&b| b == b':').count();
        if colons == 0 {
            continue;
        }
        let path = tokens
            .next()
            .map(|p| String::from_utf8_lossy(p).into_owned())
            .unwrap_or_default();
        let fields: Vec<&str> = tok[colons..].split(' ').collect();
        // `colons + 1` modes, `colons + 1` oids, then the status.
        if fields.len() < 2 * (colons + 1) {
            continue;
        }
        let mode = fields[colons];
        let blob = fields[2 * colons + 1];
        let deleted = blob.bytes().all(|b| b == b'0');
        if deleted || !matches!(mode, "100644" | "100755") || path.is_empty() {
            continue;
        }
        if let Some(c) = &commit {
            by_file
                .entry((path, blob.to_string()))
                .or_default()
                .push(c.clone());
        }
    }
    by_file
        .into_iter()
        .map(|((path, blob), mut commits)| {
            commits.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            commits.dedup();
            Introduced {
                path,
                blob,
                commits,
            }
        })
        .collect()
}

/// The size of each blob in `blobs`.
fn blob_sizes(repo: Option<&Path>, blobs: &[&str]) -> Result<BTreeMap<String, u64>> {
    let input = lines(blobs, "");
    let out = git_in(
        repo,
        &["cat-file", "--batch-check=%(objectname) %(objectsize)"],
        Some(input.as_bytes()),
    )?;
    Ok(String::from_utf8_lossy(&out)
        .lines()
        .filter_map(|l| {
            let (oid, size) = l.split_once(' ')?;
            Some((oid.to_string(), size.trim().parse().ok()?))
        })
        .collect())
}

/// The bytes of each blob in `blobs` (`git cat-file --batch`).
fn read_blobs(repo: Option<&Path>, blobs: &[&str]) -> Result<Vec<(String, Vec<u8>)>> {
    let input = lines(blobs, "");
    let out = git_in(repo, &["cat-file", "--batch"], Some(input.as_bytes()))?;
    let mut res = Vec::with_capacity(blobs.len());
    let mut rest = &out[..];
    while let Some(nl) = rest.iter().position(|&b| b == b'\n') {
        let header = String::from_utf8_lossy(&rest[..nl]).into_owned();
        rest = &rest[nl + 1..];
        let mut parts = header.split(' ');
        let (Some(oid), Some(_kind), Some(size)) = (parts.next(), parts.next(), parts.next())
        else {
            continue; // `<oid> missing`
        };
        let Ok(size) = size.parse::<usize>() else {
            continue;
        };
        if rest.len() < size {
            break;
        }
        res.push((oid.to_string(), rest[..size].to_vec()));
        rest = rest.get(size + 1..).unwrap_or_default();
    }
    Ok(res)
}

// --- what the user sees -------------------------------------------------------------------

fn short(oid: &str) -> &str {
    &oid[..oid.len().min(7)]
}

fn why(reason: Option<WarnReason>) -> &'static str {
    match reason {
        Some(WarnReason::TestPath) => " (test folder)",
        Some(WarnReason::History) => " (history from before the import)",
        _ => "",
    }
}

/// `a`, `a and b`, or `a, b and N more`.
fn list(items: &[String], noun_more: &str) -> String {
    match items {
        [] => String::new(),
        [a] => a.clone(),
        [a, b] => format!("{a} and {b}"),
        [a, b, rest @ ..] => format!("{a}, {b} and {} more{noun_more}", rest.len()),
    }
}

impl Scan {
    /// Print the warnings (always: git keeps warnings under `-q` too) and their JSON events.
    pub fn print_warnings(&self, json: bool) {
        for (n, w) in self.warnings.iter().enumerate() {
            let f = &w.finding;
            if json {
                eprintln!(
                    "{}",
                    json!({
                        "event": "secretWarning",
                        "path": f.path,
                        "line": f.line,
                        "rule": f.rule.id(),
                        "fingerprint": f.fingerprint,
                        "reason": w.verdict.reason.map(WarnReason::id),
                        "commit": w.commit,
                    })
                );
            } else if n < MAX_WARNINGS_SHOWN {
                eprintln!(
                    "dash: warning: {} {}{} [{}]",
                    f.location(),
                    f.rule.describe(),
                    why(w.verdict.reason),
                    f.fingerprint
                );
            }
        }
        if json || self.warnings.is_empty() {
            return;
        }
        if self.warnings.len() > MAX_WARNINGS_SHOWN {
            eprintln!(
                "dash: warning: {} more possible secrets not shown",
                self.warnings.len() - MAX_WARNINGS_SHOWN
            );
        }
        if self.unscanned_history > 0 {
            eprintln!(
                "dash: warning: {} older files were checked by name only",
                self.unscanned_history
            );
        }
        eprintln!(
            "dash: these are warnings only. To silence one, add its fingerprint to {ALLOW_FILE}."
        );
    }

    /// The E807 block for the refused refs (`refs`: their names, in the order of
    /// [`Scan::refused`]); `None` when nothing is refused.
    pub fn refusal(&self, refs: &[String]) -> Option<UserError> {
        if self.refused.is_empty() {
            return None;
        }
        let mut hit: Vec<usize> = self.refused.iter().flat_map(|(_, h)| h.clone()).collect();
        hit.sort_unstable();
        hit.dedup();
        let items: Vec<&Item> = hit.iter().map(|&k| &self.refusals[k]).collect();
        let who = list(refs, " refs");
        let verb = if refs.len() == 1 { "adds" } else { "add" };
        let what = match items.as_slice() {
            [one] => format!(
                "{}, which {}",
                one.finding.location(),
                one.finding.rule.describe()
            ),
            many => format!(
                "{} possible secrets: {}",
                many.len(),
                list(
                    &many
                        .iter()
                        .map(|i| i.finding.location())
                        .collect::<Vec<_>>(),
                    ""
                )
            ),
        };
        let first_fix = match items.iter().find(|i| i.finding.rule == Rule::EnvFile) {
            Some(env) => format!(
                "keep {p} out of git: `git rm --cached {p}`, add it to .gitignore, then amend or rebase the commits that added it",
                p = env.finding.path
            ),
            None => "remove it from the commits that added it (amend or rebase), then replace the secret if anyone else could have seen it".to_string(),
        };
        let options: Vec<String> = items
            .iter()
            .map(|i| format!("-o {ALLOW_PUSH_OPTION}={}", i.finding.fingerprint))
            .collect();
        let fingerprints = if items.len() == 1 {
            "fingerprint"
        } else {
            "fingerprints"
        };
        Some(
            UserError::new(codes::SECRET_IN_PUSH, format!("{who} {verb} {what}"))
                .cause("nothing pushed to a public branch can be taken back")
                .fix(first_fix)
                .fix(format!("or push with {} if you're sure", options.join(" ")))
                .fix(format!(
                    "or add the {fingerprints} to {ALLOW_FILE} and commit it"
                ))
                .note("checked before anything was signed or stored: these refs were not pushed"),
        )
    }

    /// One line per refused finding, before the error block.
    pub fn print_refusals(&self) {
        for r in &self.refusals {
            let f = &r.finding;
            eprintln!(
                "dash: possible secret: {} {} (added in {}) [{}]",
                f.location(),
                f.rule.describe(),
                short(&r.commit),
                f.fingerprint
            );
        }
    }
}

/// Whether this push was spawned by forge-import (a mirror run).
pub fn spawned_by_import() -> bool {
    std::env::var("DASH_FORGE_SPAWNED_BY").is_ok_and(|v| v == "forge-import")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch repo, and a `git` that runs in it with a fixed identity and committer date.
    struct Repo {
        dir: tempfile::TempDir,
    }

    impl Repo {
        fn new() -> Self {
            let r = Self {
                dir: tempfile::TempDir::new().unwrap(),
            };
            r.git(&["init", "-q", "-b", "main"], 1_700_000_000);
            r
        }

        fn git(&self, args: &[&str], date: u64) -> String {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(self.dir.path())
                .args(args)
                .env_remove("GIT_DIR")
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@e.x")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@e.x")
                .env("GIT_AUTHOR_DATE", format!("@{date} +0000"))
                .env("GIT_COMMITTER_DATE", format!("@{date} +0000"))
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }

        fn commit(&self, files: &[(&str, &str)], date: u64) -> String {
            for (path, body) in files {
                let p = self.dir.path().join(path);
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                std::fs::write(p, body).unwrap();
            }
            self.git(&["add", "-A"], date);
            self.git(&["commit", "-q", "-m", "c"], date);
            self.git(&["rev-parse", "HEAD"], date)
        }

        fn scan(
            &self,
            tips: &[&str],
            known: &[&str],
            created_s: Option<u64>,
            allow: &[&str],
        ) -> Scan {
            let mut list = AllowList::new();
            for fp in allow {
                assert!(list.add_fingerprint(fp));
            }
            scan(&Request {
                repo: Some(self.dir.path()),
                tips: tips
                    .iter()
                    .enumerate()
                    .map(|(i, t)| (i, (*t).to_string()))
                    .collect(),
                known: known.iter().map(|k| (*k).to_string()).collect(),
                created_at_ms: created_s.map(|s| s * 1000),
                mirror: false,
                allow: list,
            })
            .unwrap()
        }
    }

    const T0: u64 = 1_750_000_000;
    const DAY: u64 = 24 * 60 * 60;

    fn pem() -> String {
        let line = "VGhpcyBpcyBub3QgYSByZWFsIGtleSwgaXQgaXMgYSBGb3JnZSB0ZXN0LiBUaGlz";
        let label = format!("RSA {}", "PRIVATE KEY");
        format!("-----BEGIN {label}-----\n{line}\n{line}\n-----END {label}-----\n")
    }

    #[test]
    fn a_new_env_refuses_and_names_the_path() {
        let r = Repo::new();
        let base = r.commit(&[("README", "hi\n")], T0);
        let tip = r.commit(&[(".env", "DB_PASSWORD=not-real\n")], T0 + 10);
        let s = r.scan(&[&tip], &[&base], Some(T0 - 5), &[]);
        assert_eq!(s.refusals.len(), 1, "{s:?}");
        assert_eq!(s.refusals[0].finding.path, ".env");
        assert_eq!(s.refused, vec![(0, vec![0])]);
        let e = s.refusal(&["refs/heads/main".into()]).unwrap();
        assert_eq!(e.code, "E807");
        assert_eq!(
            e.message,
            "refs/heads/main adds .env, which looks like a secret file"
        );
        let fp = &s.refusals[0].finding.fingerprint;
        assert!(
            e.render("", false)
                .contains(&format!("-o allow-secret={fp}")),
            "{}",
            e.render("", false)
        );

        // `-o allow-secret=<fp>` lets it through.
        let s = r.scan(&[&tip], &[&base], Some(T0 - 5), &[fp]);
        assert!(s.refused.is_empty() && s.refusals.is_empty());
        assert_eq!(s.allowed, 1);

        // Already on the remote: nothing new to scan.
        let s = r.scan(&[&tip], &[&tip], Some(T0 - 5), &[]);
        assert!(s.refusals.is_empty() && s.warnings.is_empty());
    }

    #[test]
    fn templates_test_folders_and_envrc_only_warn() {
        let r = Repo::new();
        let tip = r.commit(
            &[
                (".env.example", "DB_PASSWORD=changeme\n"),
                (".envrc", "export API_URL=https://forge.example\n"),
                ("test/key.pem", &pem()),
            ],
            T0,
        );
        let s = r.scan(&[&tip], &[], Some(T0 - 5), &[]);
        assert!(s.refused.is_empty(), "{s:?}");
        let got: Vec<(&str, Rule)> = s
            .warnings
            .iter()
            .map(|w| (w.finding.path.as_str(), w.finding.rule))
            .collect();
        assert_eq!(
            got,
            [(".envrc", Rule::Envrc), ("test/key.pem", Rule::PrivateKey)]
        );
    }

    #[test]
    fn history_before_the_import_point_warns_but_new_history_refuses() {
        let r = Repo::new();
        // A key added long before the repo was created, removed later: history.
        r.commit(&[("deploy/key.pem", &pem())], T0 - 30 * DAY);
        r.git(&["rm", "-q", "deploy/key.pem"], T0 - 29 * DAY);
        let old = {
            r.git(&["commit", "-q", "-m", "rm"], T0 - 29 * DAY);
            r.git(&["rev-parse", "HEAD"], T0)
        };
        let s = r.scan(&[&old], &[], Some(T0), &[]);
        assert!(s.refused.is_empty());
        assert_eq!(s.warnings.len(), 1);
        assert_eq!(s.warnings[0].verdict.reason, Some(WarnReason::History));
        // The same history pushed to a repo created before it: refused, though the file is gone.
        let s = r.scan(&[&old], &[], Some(T0 - 60 * DAY), &[]);
        assert_eq!(s.refused.len(), 1);
        // Within the grace period of the creation: new.
        let s = r.scan(&[&old], &[], Some(T0 - 30 * DAY + DAY / 2), &[]);
        assert_eq!(s.refused.len(), 1);
    }

    #[test]
    fn only_the_refs_that_carry_the_secret_are_refused() {
        let r = Repo::new();
        let base = r.commit(&[("README", "hi\n")], T0);
        r.git(&["switch", "-q", "-c", "clean"], T0);
        let clean = r.commit(&[("docs.md", "ok\n")], T0 + 1);
        r.git(&["switch", "-q", "main"], T0);
        let dirty = r.commit(&[("app/.env.local", "TOKEN=not-real\n")], T0 + 2);
        let s = r.scan(&[&clean, &dirty], &[&base], Some(T0), &[]);
        assert_eq!(s.refused, vec![(1, vec![0])]);
    }

    #[test]
    fn the_committed_allow_file_allows_by_path() {
        let r = Repo::new();
        let tip = r.commit(
            &[
                ("deploy/key.pem", &pem()),
                (ALLOW_FILE, "# revoked test key\ndeploy/*.pem\n"),
            ],
            T0,
        );
        let s = r.scan(&[&tip], &[], Some(T0), &[]);
        assert!(s.refused.is_empty() && s.warnings.is_empty(), "{s:?}");
        assert_eq!(s.allowed, 1);
    }

    #[test]
    fn a_merge_reports_only_its_own_changes() {
        let r = Repo::new();
        let base = r.commit(&[("README", "hi\n")], T0);
        r.git(&["switch", "-q", "-c", "side"], T0);
        r.commit(&[("test/key.pem", &pem())], T0 + 1);
        r.git(&["switch", "-q", "main"], T0);
        r.commit(&[("a", "1\n")], T0 + 2);
        r.git(&["merge", "-q", "--no-edit", "side"], T0 + 3);
        let tip = r.git(&["rev-parse", "HEAD"], T0);
        let s = r.scan(&[&tip], &[&base], Some(T0), &[]);
        assert_eq!(s.warnings.len(), 1, "{s:?}");
        assert_ne!(
            s.warnings[0].commit, tip,
            "attributed to the side commit, not the merge"
        );
    }

    #[test]
    fn many_refusals_are_listed_with_every_option() {
        let r = Repo::new();
        let tip = r.commit(
            &[
                (".env", "A=1\n"),
                ("a/.env", "B=2\n"),
                ("deploy/k.pem", &pem()),
            ],
            T0,
        );
        let s = r.scan(&[&tip], &[], Some(T0), &[]);
        let e = s
            .refusal(&["refs/heads/main".into(), "refs/heads/dev".into()])
            .unwrap();
        assert_eq!(
            e.message,
            "refs/heads/main and refs/heads/dev add 3 possible secrets: .env, a/.env and 1 more"
        );
        let text = e.render("", false);
        assert_eq!(text.matches("-o allow-secret=").count(), 3, "{text}");
        assert!(text.contains("git rm --cached .env"), "{text}");
    }

    #[test]
    fn parse_log_reads_plain_and_combined_entries() {
        let z = "0".repeat(40);
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let c = "c".repeat(40);
        let out = format!(
            "\x01{c} 100\0\n:000000 100644 {z} {a} A\0x/.env\0:100644 000000 {a} {z} D\0gone\0:000000 160000 {z} {b} A\0sub\0\x01{b} 200\0\0::100644 100644 100644 {a} {a} {b} MM\0m\0"
        );
        let got = parse_log(out.as_bytes());
        let got: Vec<(&str, &str, &str)> = got
            .iter()
            .map(|i| (i.path.as_str(), i.blob.as_str(), i.commits[0].0.as_str()))
            .collect();
        assert_eq!(
            got,
            [
                ("m", b.as_str(), b.as_str()),
                ("x/.env", a.as_str(), c.as_str())
            ]
        );
    }
}
