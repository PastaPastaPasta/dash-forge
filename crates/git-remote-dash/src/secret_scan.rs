//! The secret scan of a public push: warnings, and E807 for the likely secrets a push would
//! publish for the first time (mixed-visibility design §4.5; the rules are [`forge_secrets`]).
//!
//! **What is scanned.** Every file a commit new to Forge introduces: the commits reachable from
//! the pushed tips and not from the remote's current tips as Forge lists them (`git log <tips>
//! --not <remote tips>`; a tip this clone does not hold only means more is scanned). For a
//! merge, only the files that differ from every parent (`-c`), so a merge of an old branch does
//! not re-report that branch's files as the merge's. A tag of a tree or a blob is scanned too:
//! every file of the tree, or the blob under the tag's name.
//!
//! **New or history.** Forge records no import marker in git, so the import point is when the
//! repository was created on Forge (its `repo` document's `$createdAt`), less
//! [`IMPORT_GRACE_MS`]. A file whose every introducing commit is older (by committer date) is
//! imported history, and its findings only warn. A push that forge-import makes
//! (`DASH_FORGE_SPAWNED_BY=forge-import`) is all history: a mirror republishes its source. When
//! the creation time cannot be read, every new commit counts as new.
//!
//! **Allowing.** `-o allow-secret=<fingerprint>` silences a finding for the whole push. The
//! `.forge/secret-scan-allow` file at a ref's tip applies to that ref only: its fingerprints
//! silence, its path globs turn a refusal into a printed warning ([`forge_secrets::decide`]).
//! Warnings (which refuse nothing) are silenced by a fingerprint in any pushed ref's file.
//!
//! **Refusing.** A ref is refused (wire reason [`WIRE`]) when its new history introduces a
//! finding that refuses under its own allow file. Other refs in the push go ahead.
//!
//! **When the scan cannot run** (git fails), [`scan_names_only`] still refuses a new `.env`
//! file found by listing the tips' trees; if that fails too, the push goes ahead with a warning.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::Result;
use forge_core::user_error::{codes, UserError};
use forge_secrets::{
    decide, is_env_file_name, scan_file, scan_unread, AllowList, Finding, Rule, Severity, Verdict,
    WarnReason, ALLOW_FILE, ALLOW_PUSH_OPTION, FINGERPRINT_HEX, MAX_SCAN_BYTES,
};
use serde_json::json;

use crate::git::{git_read_in, git_read_ok_in};

/// Commits made this long before the repository was created on Forge still count as new: the
/// usual `git init`, commit, `dg repo create`, push takes minutes, not a day.
pub const IMPORT_GRACE_MS: u64 = 24 * 60 * 60 * 1000;

/// File bytes read from history (before the import point) at most; later history files are
/// matched by name only. History only ever warns, and an import can be gigabytes.
pub const HISTORY_CONTENT_BUDGET: u64 = 64 << 20;

/// File bytes read from new commits at most; later files are matched by name only.
pub const NEW_CONTENT_BUDGET: u64 = 256 << 20;

/// File bytes read per `git cat-file --batch` call.
const READ_CHUNK_BYTES: u64 = 8 << 20;

/// Warnings printed one per line; the rest are counted.
pub const MAX_WARNINGS_SHOWN: usize = 20;

/// The per-ref reason git prints: `! [remote rejected] main -> main (possible secret in new files)`.
pub const WIRE: &str = "possible secret in new files";

/// One ref the push writes.
#[derive(Debug, Clone)]
pub struct Tip {
    /// Its index in the push plan.
    pub index: usize,
    /// The new tip (a commit, or a tag object).
    pub oid: String,
    /// The ref name (`refs/tags/v1`): the path of a blob a tag points at.
    pub name: String,
}

/// What to scan.
pub struct Request<'a> {
    /// The repository (`None`: the one git spawned the helper for).
    pub repo: Option<&'a Path>,
    /// Each ref the push writes (not deletions).
    pub tips: Vec<Tip>,
    /// The remote's current tips as Forge lists them. Ones this clone does not hold are skipped.
    pub known: Vec<String>,
    /// When the repository was created on Forge (ms), when known.
    pub created_at_ms: Option<u64>,
    /// forge-import's mirror push: everything is history.
    pub mirror: bool,
    /// Fingerprints from `-o allow-secret=`.
    pub allow: AllowList,
}

/// Fingerprints from the push options; a malformed one is ignored, and said so without echoing
/// it (someone may have pasted the secret itself).
pub fn allow_from_options(options: &crate::options::OptionState) -> AllowList {
    let mut allow = AllowList::new();
    for fp in options.push_option_values(ALLOW_PUSH_OPTION) {
        if !allow.add_fingerprint(fp) {
            eprintln!(
                "dash: warning: an -o {ALLOW_PUSH_OPTION} value is not a fingerprint ({FINGERPRINT_HEX} hex digits), ignored"
            );
        }
    }
    allow
}

/// One finding and what it does.
#[derive(Debug, Clone)]
pub struct Item {
    /// The finding.
    pub finding: Finding,
    /// Refuse or warn, and why.
    pub verdict: Verdict,
    /// Every commit (or tag object) that introduced this file version, newest first.
    commits: Vec<String>,
}

impl Item {
    /// The newest commit (or tag object) that introduced the file.
    pub fn commit(&self) -> &str {
        &self.commits[0]
    }
}

/// The scan's result.
#[derive(Debug, Default)]
pub struct Scan {
    /// Findings that warn.
    pub warnings: Vec<Item>,
    /// Findings that refuse at least one ref.
    pub refusals: Vec<Item>,
    /// The plan index of each ref refused.
    pub refused: Vec<usize>,
    /// Findings a fingerprint silenced.
    pub allowed: usize,
    /// Files matched by name only: over a content budget, or not readable.
    pub unscanned: usize,
}

/// A file version a new commit introduces.
struct Introduced {
    path: String,
    blob: String,
    /// `(commit or tag object, committer time in seconds)`, newest first. A tag of a tree or
    /// blob has no time: `u64::MAX` (always new).
    commits: Vec<(String, u64)>,
}

/// Whether `s` looks like a git object id (40 or 64 hex digits), so it can go on a batch
/// command's stdin.
fn is_oid(s: &str) -> bool {
    matches!(s.len(), 40 | 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Scan the push in `req`.
pub fn scan(req: &Request<'_>) -> Result<Scan> {
    let mut scan = Scan::default();
    let peeled = peel(req.repo, &req.tips)?;
    let commit_tips: BTreeSet<String> = peeled
        .iter()
        .filter(|(_, _, kind)| kind == "commit")
        .map(|(_, oid, _)| oid.clone())
        .collect();
    let known: Vec<String> = peel_known(req.repo, &req.known)?;
    let mut files = if commit_tips.is_empty() {
        Vec::new()
    } else {
        introduced(
            req.repo,
            &commit_tips.into_iter().collect::<Vec<_>>(),
            &known,
        )?
    };
    files.extend(tag_files(req.repo, &req.tips, &peeled)?);
    if files.is_empty() {
        return Ok(scan);
    }
    let per_tip_allow = committed_allow_lists(req.repo, &req.tips)?;
    let mut any_tip_fingerprints = AllowList::new();
    for a in &per_tip_allow {
        any_tip_fingerprints.extend(a.fingerprints_only());
    }
    let new_since = |secs: u64| {
        !req.mirror
            && req
                .created_at_ms
                .is_none_or(|c| secs.saturating_mul(1000).saturating_add(IMPORT_GRACE_MS) >= c)
    };
    let history: Vec<bool> = files
        .iter()
        .map(|f| !f.commits.iter().any(|(_, t)| new_since(*t)))
        .collect();

    let (read, over_budget) = files_to_read(req.repo, &files, &history)?;
    let (mut findings, unreadable) = find_all(req.repo, &files, &read)?;
    scan.unscanned = over_budget + unreadable;

    findings.sort_by(|(_, a), (_, b)| {
        (&a.path, a.line, a.rule, &a.fingerprint).cmp(&(&b.path, b.line, b.rule, &b.fingerprint))
    });
    let mut refused: BTreeSet<usize> = BTreeSet::new();
    for (i, finding) in findings {
        let commits: Vec<String> = files[i].commits.iter().map(|(c, _)| c.clone()).collect();
        // `-o allow-secret` applies to the whole push.
        let Some(v) = decide(&finding, history[i], &req.allow) else {
            scan.allowed += 1;
            continue;
        };
        if v.severity == Severity::Warn {
            if any_tip_fingerprints.allows_fingerprint(&finding) {
                scan.allowed += 1;
            } else {
                scan.warnings.push(Item {
                    finding,
                    verdict: v,
                    commits,
                });
            }
            continue;
        }
        // A refusal: each ref that carries it judges it by its own allow file.
        let (mut blocks, mut path_allowed) = (false, false);
        for (t, tip) in req.tips.iter().enumerate() {
            if !carries(req.repo, &commits, &tip.oid) {
                continue;
            }
            match decide(&finding, history[i], &per_tip_allow[t]) {
                Some(v) if v.severity == Severity::Refuse => {
                    blocks = true;
                    refused.insert(tip.index);
                }
                Some(_) => path_allowed = true,
                None => {}
            }
        }
        if blocks {
            scan.refusals.push(Item {
                finding,
                verdict: v,
                commits,
            });
        } else if path_allowed {
            scan.warnings.push(Item {
                finding,
                verdict: Verdict {
                    severity: Severity::Warn,
                    reason: Some(WarnReason::AllowedPath),
                },
                commits,
            });
        } else {
            scan.allowed += 1;
        }
    }
    scan.refused = refused.into_iter().collect();
    Ok(scan)
}

/// Whether the ref at `tip` carries a file introduced by one of `commits`.
fn carries(repo: Option<&Path>, commits: &[String], tip: &str) -> bool {
    commits
        .iter()
        .any(|c| c == tip || git_read_ok_in(repo, &["merge-base", "--is-ancestor", c, tip]))
}

/// The name-based check, for when [`scan`] cannot run: a `.env` file (the `env_file` name rule)
/// at a tip's tree that is not, with the same content, at any of the remote's tips. History and
/// content are not judged; a fingerprint from `-o allow-secret` or the tip's allow file
/// silences, a path glob there warns.
pub fn scan_names_only(req: &Request<'_>) -> Result<Scan> {
    let mut scan = Scan::default();
    if req.mirror {
        return Ok(scan);
    }
    let mut public: BTreeSet<(String, String)> = BTreeSet::new();
    for k in req.known.iter().filter(|k| is_oid(k)) {
        if let Ok(entries) = tree_files(req.repo, k) {
            public.extend(entries);
        }
    }
    let per_tip_allow = committed_allow_lists(req.repo, &req.tips).unwrap_or_default();
    let mut refused = BTreeSet::new();
    let mut listed = 0;
    for (t, tip) in req.tips.iter().enumerate() {
        let Ok(entries) = tree_files(req.repo, &tip.oid) else {
            continue;
        };
        listed += 1;
        for (path, blob) in entries {
            if !is_env_file_name(&path) || public.contains(&(path.clone(), blob.clone())) {
                continue;
            }
            for finding in scan_unread(&path, &blob) {
                if req.allow.allows_fingerprint(&finding) {
                    scan.allowed += 1;
                    continue;
                }
                let allow = per_tip_allow.get(t).cloned().unwrap_or_default();
                let commits = vec![tip.oid.clone()];
                match decide(&finding, false, &allow) {
                    Some(v) if v.severity == Severity::Refuse => {
                        refused.insert(tip.index);
                        scan.refusals.push(Item {
                            finding,
                            verdict: v,
                            commits,
                        });
                    }
                    Some(v) => scan.warnings.push(Item {
                        finding,
                        verdict: v,
                        commits,
                    }),
                    None => scan.allowed += 1,
                }
            }
        }
    }
    if listed == 0 && !req.tips.is_empty() {
        anyhow::bail!("could not list the files of any pushed ref");
    }
    scan.refused = refused.into_iter().collect();
    Ok(scan)
}

/// `(path, blob)` of every regular file in the tree of `rev`.
fn tree_files(repo: Option<&Path>, rev: &str) -> Result<Vec<(String, String)>> {
    let out = git_read_in(repo, &["ls-tree", "-r", "-z", "--full-tree", rev], None)?;
    Ok(out
        .split(|&b| b == 0)
        .filter_map(|entry| {
            let entry = String::from_utf8_lossy(entry);
            let (meta, path) = entry.split_once('\t')?;
            let mut f = meta.split(' ');
            let (mode, kind, oid) = (f.next()?, f.next()?, f.next()?);
            (kind == "blob" && matches!(mode, "100644" | "100755"))
                .then(|| (path.to_string(), oid.to_string()))
        })
        .collect())
}

/// `(tip index in req.tips, peeled oid, type)` of each tip that resolves (tags peeled).
fn peel(repo: Option<&Path>, tips: &[Tip]) -> Result<Vec<(usize, String, String)>> {
    let ok: Vec<(usize, &str)> = tips
        .iter()
        .enumerate()
        .filter(|(_, t)| is_oid(&t.oid))
        .map(|(i, t)| (i, t.oid.as_str()))
        .collect();
    if ok.is_empty() {
        return Ok(Vec::new());
    }
    let revs: Vec<&str> = ok.iter().map(|(_, o)| *o).collect();
    let out = git_read_in(
        repo,
        &["cat-file", "--batch-check=%(objectname) %(objecttype)"],
        Some(lines(&revs, "^{}").as_bytes()),
    )?;
    Ok(ok
        .iter()
        .zip(String::from_utf8_lossy(&out).lines())
        .filter_map(|((i, _), l)| {
            let (oid, kind) = l.split_once(' ')?;
            (kind != "missing" && is_oid(oid)).then(|| (*i, oid.to_string(), kind.to_string()))
        })
        .collect())
}

/// The commits among the remote's tips this clone holds (tags peeled).
fn peel_known(repo: Option<&Path>, known: &[String]) -> Result<Vec<String>> {
    let tips: Vec<Tip> = known
        .iter()
        .map(|k| Tip {
            index: 0,
            oid: k.clone(),
            name: String::new(),
        })
        .collect();
    let commits: BTreeSet<String> = peel(repo, &tips)?
        .into_iter()
        .filter(|(_, _, kind)| kind == "commit")
        .map(|(_, oid, _)| oid)
        .collect();
    Ok(commits.into_iter().collect())
}

/// The files of the tips that are tags of a tree (every file in it) or of a blob (the blob,
/// under the ref's name), introduced by the tip object itself (so only that ref carries them).
fn tag_files(
    repo: Option<&Path>,
    tips: &[Tip],
    peeled: &[(usize, String, String)],
) -> Result<Vec<Introduced>> {
    let mut out = Vec::new();
    for (i, oid, kind) in peeled {
        let tip = &tips[*i];
        let commits = vec![(tip.oid.clone(), u64::MAX)];
        match kind.as_str() {
            "tree" => {
                for (path, blob) in tree_files(repo, oid)? {
                    out.push(Introduced {
                        path,
                        blob,
                        commits: commits.clone(),
                    });
                }
            }
            "blob" => out.push(Introduced {
                path: tip.name.clone(),
                blob: oid.clone(),
                commits,
            }),
            _ => {}
        }
    }
    Ok(out)
}

/// The `.forge/secret-scan-allow` file at each tip, in `tips` order (one `cat-file --batch`; a
/// tip without the file, or with something other than a file there, has an empty list).
fn committed_allow_lists(repo: Option<&Path>, tips: &[Tip]) -> Result<Vec<AllowList>> {
    let specs: Vec<String> = tips
        .iter()
        .map(|t| format!("{}:{ALLOW_FILE}", t.oid))
        .collect();
    let mut lists = vec![AllowList::new(); tips.len()];
    for (list, (kind, bytes)) in lists.iter_mut().zip(read_batch(repo, &specs)?) {
        if kind == "blob" {
            *list = AllowList::parse(&String::from_utf8_lossy(&bytes));
        }
    }
    Ok(lists)
}

/// The blobs to read, with their sizes: within [`MAX_SCAN_BYTES`], and within
/// [`NEW_CONTENT_BUDGET`] (new files, read first) or [`HISTORY_CONTENT_BUDGET`] (history); and
/// how many files a budget left unread.
fn files_to_read<'f>(
    repo: Option<&Path>,
    files: &'f [Introduced],
    history: &[bool],
) -> Result<(BTreeMap<&'f str, u64>, usize)> {
    let blobs: BTreeSet<&str> = files.iter().map(|f| f.blob.as_str()).collect();
    let sizes = blob_sizes(repo, &blobs.into_iter().collect::<Vec<_>>())?;
    let mut read: BTreeMap<&str, u64> = BTreeMap::new();
    let mut over_budget = 0;
    let (mut new_bytes, mut history_bytes) = (0u64, 0u64);
    let mut order: Vec<usize> = (0..files.len()).collect();
    // New files first, so the history budget never takes from them.
    order.sort_by_key(|&i| history[i]);
    for i in order {
        let blob = files[i].blob.as_str();
        let Some(&size) = sizes.get(blob) else {
            continue;
        };
        if size > MAX_SCAN_BYTES as u64 || read.contains_key(blob) {
            continue;
        }
        let (used, budget) = if history[i] {
            (&mut history_bytes, HISTORY_CONTENT_BUDGET)
        } else {
            (&mut new_bytes, NEW_CONTENT_BUDGET)
        };
        if *used + size > budget {
            over_budget += 1;
            continue;
        }
        *used += size;
        read.insert(blob, size);
    }
    Ok((read, over_budget))
}

/// Every finding in `files`: the blobs in `read` by content, read in chunks of
/// [`READ_CHUNK_BYTES`] so memory stays bounded; the others, and any blob git did not return,
/// by name. Also the count of files git did not return.
fn find_all(
    repo: Option<&Path>,
    files: &[Introduced],
    read: &BTreeMap<&str, u64>,
) -> Result<(Vec<(usize, Finding)>, usize)> {
    let mut by_blob: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for (i, f) in files.iter().enumerate() {
        by_blob.entry(f.blob.as_str()).or_default().push(i);
    }
    let mut chunks: Vec<Vec<String>> = Vec::new();
    let mut chunk_bytes = 0;
    for (&blob, &size) in read {
        match chunks.last_mut() {
            Some(c) if chunk_bytes + size <= READ_CHUNK_BYTES => c.push(blob.to_string()),
            _ => {
                chunks.push(vec![blob.to_string()]);
                chunk_bytes = 0;
            }
        }
        chunk_bytes += size;
    }
    let mut findings: Vec<(usize, Finding)> = Vec::new();
    let mut scanned: BTreeSet<usize> = BTreeSet::new();
    for chunk in &chunks {
        for (blob, (_, bytes)) in chunk.iter().zip(read_batch(repo, chunk)?) {
            for &i in by_blob.get(blob.as_str()).into_iter().flatten() {
                scanned.insert(i);
                findings.extend(
                    scan_file(&files[i].path, &bytes)
                        .into_iter()
                        .map(|f| (i, f)),
                );
            }
        }
    }
    let mut unreadable = 0;
    for (i, f) in files.iter().enumerate() {
        if !scanned.contains(&i) {
            unreadable += usize::from(read.contains_key(f.blob.as_str()));
            findings.extend(scan_unread(&f.path, &f.blob).into_iter().map(|x| (i, x)));
        }
    }
    Ok((findings, unreadable))
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

/// Every file version the commits reachable from `tips` and not from `known` introduce.
fn introduced(repo: Option<&Path>, tips: &[String], known: &[String]) -> Result<Vec<Introduced>> {
    let mut revs = lines(tips, "");
    for k in known {
        revs.push('^');
        revs.push_str(k);
        revs.push('\n');
    }
    let out = git_read_in(
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

/// The size of each blob in `blobs` (missing ones are left out).
fn blob_sizes(repo: Option<&Path>, blobs: &[&str]) -> Result<BTreeMap<String, u64>> {
    let out = git_read_in(
        repo,
        &["cat-file", "--batch-check=%(objectname) %(objectsize)"],
        Some(lines(blobs, "").as_bytes()),
    )?;
    Ok(String::from_utf8_lossy(&out)
        .lines()
        .filter_map(|l| {
            let (oid, size) = l.split_once(' ')?;
            Some((oid.to_string(), size.trim().parse().ok()?))
        })
        .collect())
}

/// `(type, bytes)` of each object in `specs`, in order (`git cat-file --batch`); a missing one
/// is `("missing", [])`.
fn read_batch(repo: Option<&Path>, specs: &[String]) -> Result<Vec<(String, Vec<u8>)>> {
    let out = git_read_in(
        repo,
        &["cat-file", "--batch"],
        Some(lines(specs, "").as_bytes()),
    )?;
    let mut res = Vec::with_capacity(specs.len());
    let mut rest = &out[..];
    while let Some(nl) = rest.iter().position(|&b| b == b'\n') {
        let header = String::from_utf8_lossy(&rest[..nl]).into_owned();
        rest = &rest[nl + 1..];
        // `<oid> <type> <size>`, or `<spec> missing` (also `ambiguous`), with no body.
        let mut parts = header.rsplitn(3, ' ');
        let (Some(size), Some(kind)) = (parts.next(), parts.next()) else {
            res.push(("missing".to_string(), Vec::new()));
            continue;
        };
        let Ok(size) = size.parse::<usize>() else {
            res.push(("missing".to_string(), Vec::new()));
            continue;
        };
        if rest.len() < size {
            break;
        }
        res.push((kind.to_string(), rest[..size].to_vec()));
        rest = rest.get(size + 1..).unwrap_or_default();
    }
    Ok(res)
}

// --- what the user sees -------------------------------------------------------------------

fn short(oid: &str) -> &str {
    &oid[..oid.len().min(7)]
}

/// `path` safe to print on a terminal: control characters (a file name can hold a newline or
/// an escape sequence) are written as escapes.
fn shown(path: &str) -> String {
    path.chars()
        .flat_map(|c| -> Box<dyn Iterator<Item = char>> {
            if c.is_control() {
                Box::new(c.escape_default())
            } else {
                Box::new(std::iter::once(c))
            }
        })
        .collect()
}

/// `path` as one shell word: as is when it is plain, else single-quoted.
fn shell_word(path: &str) -> String {
    let plain = !path.is_empty()
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'/' | b'_' | b'-'));
    if plain {
        path.to_string()
    } else {
        format!("'{}'", shown(path).replace('\'', "'\\''"))
    }
}

/// `path line N` (or `path`), printable.
fn location(f: &Finding) -> String {
    match f.line {
        Some(n) => format!("{} line {n}", shown(&f.path)),
        None => shown(&f.path),
    }
}

fn why(reason: Option<WarnReason>) -> &'static str {
    match reason {
        Some(WarnReason::TestPath) => " (test folder)",
        Some(WarnReason::History) => " (history from before the import)",
        Some(WarnReason::AllowedPath) => " (its path is in the allow file)",
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
                        "commit": w.commit(),
                    })
                );
            } else if n < MAX_WARNINGS_SHOWN {
                eprintln!(
                    "dash: warning: {} {}{} [{}]",
                    location(f),
                    f.rule.describe(),
                    why(w.verdict.reason),
                    f.fingerprint
                );
            }
        }
        if json {
            return;
        }
        if self.warnings.len() > MAX_WARNINGS_SHOWN {
            eprintln!(
                "dash: warning: {} more possible secrets not shown",
                self.warnings.len() - MAX_WARNINGS_SHOWN
            );
        }
        if self.unscanned > 0 {
            eprintln!(
                "dash: warning: {} large or unreadable files were checked by name only",
                self.unscanned
            );
        }
        if !self.warnings.is_empty() {
            eprintln!(
                "dash: these are warnings only. To silence one, add its fingerprint to {ALLOW_FILE}."
            );
        }
    }

    /// The E807 block for the refused refs (`refs`: their names); `None` when nothing is
    /// refused. Every refusal is in some refused ref's new history, so all are listed.
    pub fn refusal(&self, refs: &[String]) -> Option<UserError> {
        if self.refused.is_empty() || self.refusals.is_empty() {
            return None;
        }
        let items = &self.refusals;
        let who = list(refs, " refs");
        let verb = if refs.len() == 1 { "adds" } else { "add" };
        let what = match items.as_slice() {
            [one] => format!(
                "{}, which {}",
                shown(&one.finding.path),
                one.finding.rule.describe()
            ),
            many => {
                let mut paths: Vec<String> = many.iter().map(|i| shown(&i.finding.path)).collect();
                paths.dedup();
                format!("{} possible secrets in {}", many.len(), list(&paths, ""))
            }
        };
        let first_fix = match items.iter().find(|i| i.finding.rule == Rule::EnvFile) {
            Some(env) => format!(
                "keep {p} out of git: `git rm --cached {w}`, add it to .gitignore, then amend or rebase the commits that added it",
                p = shown(&env.finding.path),
                w = shell_word(&env.finding.path),
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
                location(f),
                f.rule.describe(),
                short(r.commit()),
                f.fingerprint
            );
        }
    }
}

/// Whether this push was spawned by forge-import (a mirror run). Only forge-import sets the
/// variable; a stray one in a user's shell would only turn refusals into warnings.
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
            scan(&self.request(tips, known, created_s, allow)).unwrap()
        }

        fn request(
            &self,
            tips: &[&str],
            known: &[&str],
            created_s: Option<u64>,
            allow: &[&str],
        ) -> Request<'_> {
            let mut list = AllowList::new();
            for fp in allow {
                assert!(list.add_fingerprint(fp));
            }
            Request {
                repo: Some(self.dir.path()),
                tips: tips
                    .iter()
                    .enumerate()
                    .map(|(i, t)| Tip {
                        index: i,
                        oid: (*t).to_string(),
                        name: format!("refs/tags/t{i}"),
                    })
                    .collect(),
                known: known.iter().map(|k| (*k).to_string()).collect(),
                created_at_ms: created_s.map(|s| s * 1000),
                mirror: false,
                allow: list,
            }
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
        assert_eq!(s.refused, vec![0]);
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
        assert_eq!(s.refused, vec![1]);
    }

    #[test]
    fn an_allow_file_path_warns_and_its_fingerprint_silences() {
        let r = Repo::new();
        let tip = r.commit(
            &[
                ("deploy/key.pem", &pem()),
                (ALLOW_FILE, "# revoked test key\ndeploy/*.pem\n"),
            ],
            T0,
        );
        let s = r.scan(&[&tip], &[], Some(T0), &[]);
        assert!(s.refused.is_empty(), "{s:?}");
        assert_eq!(s.warnings.len(), 1);
        assert_eq!(s.warnings[0].verdict.reason, Some(WarnReason::AllowedPath));
        let fp = s.warnings[0].finding.fingerprint.clone();
        let tip = r.commit(&[(ALLOW_FILE, &format!("{fp}\n"))], T0 + 1);
        let s = r.scan(&[&tip], &[], Some(T0), &[]);
        assert!(s.refused.is_empty() && s.warnings.is_empty(), "{s:?}");
        assert_eq!(s.allowed, 1);
    }

    #[test]
    fn each_ref_is_judged_by_its_own_allow_file() {
        let r = Repo::new();
        let base = r.commit(&[("README", "hi\n")], T0);
        let with_env = r.commit(&[(".env", "A=1\n")], T0 + 1);
        let fp = r.scan(&[&with_env], &[&base], Some(T0), &[]).refusals[0]
            .finding
            .fingerprint
            .clone();
        // main allows it in its own allow file; dev carries the same .env without one.
        let main = r.commit(&[(ALLOW_FILE, &format!("{fp}\n"))], T0 + 2);
        let s = r.scan(&[&main, &with_env], &[&base], Some(T0), &[]);
        assert_eq!(s.refused, vec![1], "{s:?}");
    }

    #[test]
    fn a_tag_of_a_blob_or_tree_is_scanned() {
        let r = Repo::new();
        let base = r.commit(&[("README", "hi\n")], T0);
        std::fs::write(r.dir.path().join("k.pem"), pem()).unwrap();
        let blob = r.git(&["hash-object", "-w", "k.pem"], T0);
        let s = r.scan(&[&blob], &[&base], Some(T0), &[]);
        assert_eq!(s.refused, vec![0], "{s:?}");
        assert_eq!(s.refusals[0].finding.path, "refs/tags/t0");
        r.git(&["add", "k.pem"], T0);
        let tree = r.git(&["write-tree"], T0);
        let s = r.scan(&[&tree], &[&base], Some(T0), &[]);
        assert_eq!(s.refused, vec![0], "{s:?}");
        assert_eq!(s.refusals[0].finding.path, "k.pem");
    }

    #[test]
    fn the_name_only_fallback_refuses_a_new_env() {
        let r = Repo::new();
        let base = r.commit(&[(".env.example", "A=\n"), ("app/.env", "A=1\n")], T0);
        let tip = r.commit(&[(".env", "B=2\n")], T0 + 1);
        let req = r.request(&[&tip], &[&base], Some(T0), &[]);
        let s = scan_names_only(&req).unwrap();
        assert_eq!(s.refused, vec![0], "{s:?}");
        let paths: Vec<&str> = s.refusals.iter().map(|i| i.finding.path.as_str()).collect();
        assert_eq!(paths, [".env"], "app/.env is already public");
    }

    #[test]
    fn a_real_env_under_tests_is_refused() {
        let r = Repo::new();
        let tip = r.commit(&[("tests/.env", "A=1\n"), ("tests/k.pem", &pem())], T0);
        let s = r.scan(&[&tip], &[], Some(T0), &[]);
        assert_eq!(s.refusals.len(), 1, "{s:?}");
        assert_eq!(s.refusals[0].finding.path, "tests/.env");
        assert_eq!(s.warnings[0].finding.path, "tests/k.pem");
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
            s.warnings[0].commit(),
            tip,
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
            "refs/heads/main and refs/heads/dev add 3 possible secrets in .env, a/.env and 1 more"
        );
        let text = e.render("", false);
        assert_eq!(text.matches("-o allow-secret=").count(), 3, "{text}");
        assert!(text.contains("git rm --cached .env"), "{text}");
    }

    #[test]
    fn paths_are_printable_and_quoted_for_the_shell() {
        assert_eq!(shown("a\u{1b}[2Jb\nc"), "a\\u{1b}[2Jb\\nc");
        assert_eq!(shell_word("app/.env"), "app/.env");
        assert_eq!(shell_word("my app/.env"), "'my app/.env'");
        assert_eq!(shell_word("it's/.env"), "'it'\\''s/.env'");
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
