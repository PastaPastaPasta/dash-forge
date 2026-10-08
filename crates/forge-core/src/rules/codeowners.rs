//! Code owners (P1-6): which identities own which paths, read from a repository's `CODEOWNERS`
//! file, and whom a new pull request asks for review.
//!
//! A client convention shared by `dg pr create` and the web's "Open a pull request" and Files
//! tab (`forge-web/lib/rules/codeowners.ts`), held in parity by the `code_owners__*` and
//! `code_owner_requests__*` vectors in `forge-contracts/vectors/`. Nothing here is consensus:
//! a review request is an ordinary `event` / `authorEvent` of kind 13, gated as always
//! (`docs/contracts/forge-v2.md` §3).
//!
//! # The file
//!
//! The first regular file of [`CODEOWNERS_PATHS`] at the PR's **base** branch tip (GitHub reads
//! the base branch's file too), at most [`MAX_CODEOWNERS_BYTES`]. Line by line:
//!
//! * blank lines and lines starting with `#` are skipped;
//! * a GitLab section header, `[Name]`, `^[Name]` (optional) or `[Name][n]` (n approvals),
//!   followed by nothing or by whitespace and default owners, starts a section. A line that
//!   starts with `[` but goes on without whitespace after the brackets (`[id]/page.tsx @a`) is a
//!   rule, as on GitHub;
//! * any other line is a rule: a pattern up to the first unescaped space or tab, then owner
//!   tokens up to one that starts with `#` (a comment). A rule without owners takes its
//!   section's default owners (none outside a named section: the path then has no owner, which
//!   is how GitHub's "no owners" override reads too);
//! * a pattern starting with `!` (negation, which CODEOWNERS does not support) or holding `***`
//!   is an error: the line is skipped and reported.
//!
//! # Patterns
//!
//! gitignore semantics with GitHub's two CODEOWNERS exceptions (the behaviour of the widely used
//! `hmarr/codeowners` matcher, which follows GitHub's documented examples):
//!
//! * a leading `/` anchors the pattern at the root; a pattern with no `/` other than a trailing
//!   one matches at any depth (an implicit leading `**/`); any other pattern is anchored;
//! * a trailing `/` matches everything under a directory (`/**`), never a file of that name;
//! * `**` as a whole segment: leading, any leading directories; trailing, everything under;
//!   between, zero or more directories;
//! * `*` matches within one segment and `?` one character; `\x` is a literal `x`;
//! * the last segment also matches everything under a directory of that name (`docs` owns
//!   `docs/a/b.md`), **except** a last segment that is exactly `*`: `docs/*` owns the files
//!   directly in `docs/`, not `docs/a/b.md` (GitHub's exception to gitignore);
//! * `[` and `]` are literals, not character classes (GitHub's exception: Next.js route folders
//!   such as `app/[slug]/` mean themselves);
//! * matching is case-sensitive, over the path's Unicode characters.
//!
//! The owners of a path: in each section (the unnamed one first, then named sections in the
//! order they first appear; sections with the same name, compared case-insensitively, are one),
//! the **last** matching rule's owners; the sections' owners joined in that order, each token
//! once.
//!
//! # Tokens and requests
//!
//! [`owner_kind`] classifies a token: `@name` (a DPNS name), a base58 identity id (bare or after
//! `@`), `@org/team`, an e-mail address or GitLab's `@@role`. Only names and identities can be
//! asked for review; the caller resolves names (DPNS) and [`code_owner_requests`] picks whom to
//! ask: as on GitHub, where a code owner must have write access, only a current maintainer or
//! role-1 writer ([`RoleOracle::current_approver`]), never the PR's author, each identity once,
//! at most [`MAX_OWNER_REQUESTS`].
//!
//! # The merge rule (`policy.requireCodeOwners`, UPDATE-1)
//!
//! [`code_owner_review`]: with the branch policy's `requireCodeOwners` on, every changed path
//! (the same paths the requests read) that has owners needs an approval from one of them. An
//! owner's approval counts by the rules [`super::review::meets_policy`] uses: the reviewer's
//! standing verdict on the PR's current head is approve ([`super::v2::count_approvals`]: not
//! dismissed, not the PR's author, an approver when they reviewed) and their current role counts
//! toward the policy ([`super::review::counts_for`]: a maintainer, or with `approverRole` 0 a
//! role-1 writer). A path with no owners is unconstrained. The rule fails closed:
//!
//! * a code owners file that cannot be read (storage or git failed) blocks the merge;
//! * a path whose owners include nobody who could approve (only teams, e-mail, roles, names
//!   DPNS does not resolve, non-members, or the PR's author) stays pending, marked not
//!   approvable, until the file is fixed or a maintainer bypasses the policy.
//!
//! No code owners file at the base tip (or one too large or binary to read, as GitHub ignores
//! it) means no path has owners: the rule is met.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::review::{counts_for, Policy};
use super::v2::{Approvals, RoleOracle};

/// Where a repository's code owners file is looked for, in order: the first that exists wins.
/// `.forge/` first (Forge's own directory, as for issue templates), then GitHub's three places,
/// then GitLab's.
pub const CODEOWNERS_PATHS: [&str; 5] = [
    ".forge/CODEOWNERS",
    ".github/CODEOWNERS",
    "CODEOWNERS",
    "docs/CODEOWNERS",
    ".gitlab/CODEOWNERS",
];

/// The largest code owners file read (GitHub's limit): a larger one is ignored.
pub const MAX_CODEOWNERS_BYTES: usize = 3 * 1024 * 1024;

/// The most reviewers a new PR asks for on its code owners' behalf.
pub const MAX_OWNER_REQUESTS: usize = 15;

/// One segment of a compiled pattern.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Seg {
    /// `**`: any number of segments (see [`matches_from`] for where).
    Any,
    /// Exactly `*`: one segment.
    One,
    /// A segment glob: literals, `*` runs and `?`.
    Glob(Vec<Tok>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tok {
    Lit(char),
    Star,
    Quest,
}

/// One rule of a code owners file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerRule {
    /// The line it is on (1-based).
    pub line: u32,
    /// The pattern as written.
    pub pattern: String,
    /// Its owner tokens as written (or its section's default owners), in order.
    pub owners: Vec<String>,
    /// Which section it belongs to (an index into [`CodeOwners::sections`]).
    pub section: usize,
    segs: Vec<Seg>,
}

/// A line that was skipped as malformed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnersError {
    /// The line (1-based).
    pub line: u32,
    /// `negation` (a pattern starting with `!`) or `pattern` (a pattern holding `***`).
    pub error: String,
}

/// A parsed code owners file.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodeOwners {
    /// The rules, in file order.
    pub rules: Vec<OwnerRule>,
    /// The sections' names, lower-cased; index 0 is the unnamed section before any header.
    pub sections: Vec<String>,
    /// The lines skipped as malformed.
    pub errors: Vec<OwnersError>,
}

fn is_ws(c: char) -> bool {
    c == ' ' || c == '\t'
}

/// The owner tokens of `rest`, stopping at one that starts with `#`.
fn tokens(rest: &str) -> Vec<String> {
    rest.split(is_ws)
        .filter(|t| !t.is_empty())
        .take_while(|t| !t.starts_with('#'))
        .map(str::to_owned)
        .collect()
}

/// A section header: `(name, default owners)`, or `None` when `line` is not one.
fn section_header(line: &str) -> Option<(String, Vec<String>)> {
    let body = line.strip_prefix('^').unwrap_or(line);
    let inner = body.strip_prefix('[')?;
    let close = inner.find(']')?;
    let name = inner[..close].trim_matches(is_ws);
    if name.is_empty() {
        return None;
    }
    let mut rest = &inner[close + 1..];
    // `[Name][2]`: the approvals count GitLab reads (Forge asks one owner per path, so it is read past).
    if let Some(count) = rest.strip_prefix('[') {
        let end = count.find(']')?;
        if end == 0 || !count[..end].bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        rest = &count[end + 1..];
    }
    if !rest.is_empty() && !rest.starts_with(is_ws) {
        return None;
    }
    Some((name.to_lowercase(), tokens(rest)))
}

/// The pattern at the start of `line` (escapes kept) and the rest of the line.
fn split_pattern(line: &str) -> (&str, &str) {
    let mut escaped = false;
    for (i, c) in line.char_indices() {
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if is_ws(c) {
            return (&line[..i], &line[i..]);
        }
    }
    (line, "")
}

/// One segment's glob tokens (`\x` a literal `x`; a trailing lone `\` a literal backslash).
fn glob(seg: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    let mut chars = seg.chars();
    while let Some(c) = chars.next() {
        out.push(match c {
            '\\' => Tok::Lit(chars.next().unwrap_or('\\')),
            '*' => Tok::Star,
            '?' => Tok::Quest,
            c => Tok::Lit(c),
        });
    }
    out
}

/// Compile a pattern into segments (`None`: it matches nothing, as `/` alone does).
fn compile(pattern: &str) -> Option<Vec<Seg>> {
    let anchored = pattern.starts_with('/');
    let p = if anchored { &pattern[1..] } else { pattern };
    let trailing = p.ends_with('/') && !p.ends_with("\\/");
    let p = if trailing { &p[..p.len() - 1] } else { p };
    if p.is_empty() {
        return None;
    }
    let mut segs: Vec<Seg> = p
        .split('/')
        .map(|s| match s {
            "**" => Seg::Any,
            "*" => Seg::One,
            s => Seg::Glob(glob(s)),
        })
        .collect();
    if !anchored && segs.len() == 1 && segs[0] != Seg::Any {
        segs.insert(0, Seg::Any);
    }
    if trailing {
        segs.push(Seg::Any);
    }
    Some(segs)
}

/// Whether a segment glob matches a whole path segment.
fn glob_matches(toks: &[Tok], name: &[char]) -> bool {
    // The classic wildcard walk: on a mismatch, let the last `*` take one more character.
    let (mut t, mut n) = (0usize, 0usize);
    let mut star: Option<(usize, usize)> = None;
    while n < name.len() {
        match toks.get(t) {
            Some(Tok::Star) => {
                star = Some((t, n));
                t += 1;
            }
            Some(Tok::Quest) => {
                t += 1;
                n += 1;
            }
            Some(Tok::Lit(c)) if *c == name[n] => {
                t += 1;
                n += 1;
            }
            _ => match star {
                Some((st, sn)) => {
                    t = st + 1;
                    n = sn + 1;
                    star = Some((st, sn + 1));
                }
                None => return false,
            },
        }
    }
    toks[t..].iter().all(|k| *k == Tok::Star)
}

/// Whether `segs[i..]` matches `path[j..]`, memoized on `(i, j)`.
fn matches_from(
    segs: &[Seg],
    path: &[Vec<char>],
    i: usize,
    j: usize,
    memo: &mut BTreeMap<(usize, usize), bool>,
) -> bool {
    if let Some(&known) = memo.get(&(i, j)) {
        return known;
    }
    let last = i + 1 == segs.len();
    let got = match segs.get(i) {
        None => j == path.len(),
        // A trailing `**`: one or more segments (everything under); elsewhere zero or more.
        Some(Seg::Any) if last => j < path.len(),
        Some(Seg::Any) => (j..=path.len()).any(|k| matches_from(segs, path, i + 1, k, memo)),
        Some(_) if j == path.len() => false,
        // `docs/*` owns only what is directly in `docs/`.
        Some(Seg::One) if last => j + 1 == path.len(),
        Some(Seg::One) => matches_from(segs, path, i + 1, j + 1, memo),
        Some(Seg::Glob(toks)) => {
            // Any other last segment also owns everything under a directory of that name.
            glob_matches(toks, &path[j]) && (last || matches_from(segs, path, i + 1, j + 1, memo))
        }
    };
    memo.insert((i, j), got);
    got
}

/// A path split into segments of characters, as the matcher reads it.
fn path_parts(path: &str) -> Vec<Vec<char>> {
    path.split('/').map(|s| s.chars().collect()).collect()
}

impl OwnerRule {
    fn matches_parts(&self, parts: &[Vec<char>]) -> bool {
        !self.segs.is_empty() && matches_from(&self.segs, parts, 0, 0, &mut BTreeMap::new())
    }
}

/// Parse a code owners file (GitHub's or GitLab's format; see the module docs).
#[must_use]
pub fn parse_code_owners(text: &str) -> CodeOwners {
    let mut out = CodeOwners {
        sections: vec![String::new()],
        ..CodeOwners::default()
    };
    let mut section = 0usize;
    let mut defaults: Vec<String> = Vec::new();
    // A leading byte-order mark is no part of the first line (the web's decoder drops it too).
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    for (n, raw) in text.split('\n').enumerate() {
        let line_no = u32::try_from(n + 1).unwrap_or(u32::MAX);
        let line = raw.strip_suffix('\r').unwrap_or(raw).trim_matches(is_ws);
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((name, owners)) = section_header(line) {
            section = if let Some(i) = out.sections.iter().position(|s| *s == name) {
                i
            } else {
                out.sections.push(name);
                out.sections.len() - 1
            };
            defaults = owners;
            continue;
        }
        let (pattern, rest) = split_pattern(line);
        let error = if pattern.starts_with('!') {
            Some("negation")
        } else if pattern.contains("***") {
            Some("pattern")
        } else {
            None
        };
        if let Some(e) = error {
            out.errors.push(OwnersError {
                line: line_no,
                error: e.to_string(),
            });
            continue;
        }
        let mut owners = tokens(rest);
        if owners.is_empty() {
            owners.clone_from(&defaults);
        }
        out.rules.push(OwnerRule {
            line: line_no,
            pattern: pattern.to_string(),
            owners,
            section,
            segs: compile(pattern).unwrap_or_default(),
        });
    }
    out
}

impl CodeOwners {
    /// The owner tokens of `path`: each section's last matching rule's, sections in order,
    /// each token once.
    #[must_use]
    pub fn owners_of(&self, path: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for rule in self.deciding_rules(path) {
            for t in &rule.owners {
                if !out.contains(t) {
                    out.push(t.clone());
                }
            }
        }
        out
    }

    /// The rules that decide `path`'s owners: each section's last matching rule, in section
    /// order (one pass over the rules, newest first).
    #[must_use]
    pub fn deciding_rules(&self, path: &str) -> Vec<&OwnerRule> {
        let parts = path_parts(path);
        let mut found: Vec<Option<&OwnerRule>> = vec![None; self.sections.len()];
        let mut open = found.len();
        for rule in self.rules.iter().rev() {
            if open == 0 {
                break;
            }
            if found[rule.section].is_none() && rule.matches_parts(&parts) {
                found[rule.section] = Some(rule);
                open -= 1;
            }
        }
        found.into_iter().flatten().collect()
    }

    /// Every owner token of `paths`, each once, in the order of first appearance with the paths
    /// taken in code-point order (so the order does not depend on how a client listed them).
    #[must_use]
    pub fn owners_of_paths(&self, paths: &[String]) -> Vec<String> {
        let sorted: BTreeSet<&String> = paths.iter().collect();
        let mut out: Vec<String> = Vec::new();
        for p in sorted {
            for t in self.owners_of(p) {
                if !out.contains(&t) {
                    out.push(t);
                }
            }
        }
        out
    }
}

/// What an owner token names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OwnerKind {
    /// `@name` or `@name.dash`: a DPNS name under `dash` (a name under another parent domain
    /// is [`OwnerKind::Invalid`]).
    Name,
    /// A base58 identity id, bare or after `@`.
    Identity,
    /// `@org/team` (GitHub teams, GitLab groups): Forge has no teams.
    Team,
    /// `user@example.com`: Forge identities have no e-mail.
    Email,
    /// GitLab's `@@maintainer`-style roles.
    Role,
    /// Anything else.
    Invalid,
}

/// Whether `s` is a base58 identity id, as `dg` reads one anywhere
/// ([`crate::resolve::looks_like_identity_id`]).
#[must_use]
pub fn is_identity_token(s: &str) -> bool {
    crate::resolve::looks_like_identity_id(s)
}

/// Classify an owner token.
#[must_use]
pub fn owner_kind(token: &str) -> OwnerKind {
    if token.starts_with("@@") {
        return OwnerKind::Role;
    }
    if let Some(rest) = token.strip_prefix('@') {
        if rest.contains('/') {
            return OwnerKind::Team;
        }
        if is_identity_token(rest) {
            return OwnerKind::Identity;
        }
        // `label` or `label.dash` (any case): the names both clients look up in DPNS.
        return if crate::resolve::dpns_label(rest).is_some() {
            OwnerKind::Name
        } else {
            OwnerKind::Invalid
        };
    }
    if is_identity_token(token) {
        return OwnerKind::Identity;
    }
    match token.split_once('@') {
        Some((local, domain))
            if !local.is_empty() && domain.contains('.') && !domain.contains('@') =>
        {
            OwnerKind::Email
        }
        _ => OwnerKind::Invalid,
    }
}

/// The identity id an identity token names (`None` for any other kind).
#[must_use]
pub fn token_identity(token: &str) -> Option<&str> {
    (owner_kind(token) == OwnerKind::Identity).then(|| token.strip_prefix('@').unwrap_or(token))
}

/// Why a code owner was not asked for review.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkipReason {
    /// A team or group: Forge has none.
    Team,
    /// An e-mail address.
    Email,
    /// A GitLab role.
    Role,
    /// Not an owner token at all.
    Invalid,
    /// A name no DPNS record (or no successful lookup) resolves.
    Unresolved,
    /// The PR's author.
    Author,
    /// Not a current maintainer or role-1 writer of the repository (GitHub, likewise, ignores a
    /// code owner without write access).
    NotApprover,
    /// An identity an earlier token already named.
    Duplicate,
    /// Past [`MAX_OWNER_REQUESTS`].
    Cap,
}

/// A code owner left out of the requests, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkippedOwner {
    /// The token as written.
    pub token: String,
    /// Why.
    pub reason: SkipReason,
    /// The identity it resolved to, when it did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
}

/// Whom a new PR asks for review on its code owners' behalf.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerRequests {
    /// The identities to request, in token order.
    pub request: Vec<String>,
    /// The tokens left out.
    pub skipped: Vec<SkippedOwner>,
}

/// Pick the reviewers a new PR requests from its owner `tokens` (as [`CodeOwners::owners_of_paths`]
/// lists them): `resolved` maps each name token to the identity its DPNS name resolved to
/// (absent or `None`: unresolved); identity tokens need no entry.
#[must_use]
pub fn code_owner_requests(
    tokens: &[String],
    resolved: &BTreeMap<String, Option<String>>,
    oracle: &RoleOracle,
    author: &str,
) -> OwnerRequests {
    let mut out = OwnerRequests::default();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for token in tokens {
        let skip = |reason, identity: Option<&str>| SkippedOwner {
            token: token.clone(),
            reason,
            identity: identity.map(str::to_owned),
        };
        let identity = match owner_kind(token) {
            OwnerKind::Identity => token_identity(token).map(str::to_owned),
            OwnerKind::Name => resolved.get(token).cloned().flatten(),
            OwnerKind::Team => {
                out.skipped.push(skip(SkipReason::Team, None));
                continue;
            }
            OwnerKind::Email => {
                out.skipped.push(skip(SkipReason::Email, None));
                continue;
            }
            OwnerKind::Role => {
                out.skipped.push(skip(SkipReason::Role, None));
                continue;
            }
            OwnerKind::Invalid => {
                out.skipped.push(skip(SkipReason::Invalid, None));
                continue;
            }
        };
        let Some(id) = identity else {
            out.skipped.push(skip(SkipReason::Unresolved, None));
            continue;
        };
        let reason = if id == author {
            Some(SkipReason::Author)
        } else if seen.contains(&id) {
            Some(SkipReason::Duplicate)
        } else if !oracle.current_approver(&id) {
            Some(SkipReason::NotApprover)
        } else if out.request.len() >= MAX_OWNER_REQUESTS {
            Some(SkipReason::Cap)
        } else {
            None
        };
        if let Some(r) = reason {
            out.skipped.push(skip(r, Some(&id)));
        } else {
            seen.insert(id.clone());
            out.request.push(id);
        }
    }
    out
}

/// The code owners file a merge is judged against ([`code_owner_review`]).
#[derive(Debug, Clone, Copy)]
pub enum OwnersFile<'a> {
    /// No code owners file at the base tip (or one too large or binary to read): nothing is owned.
    Absent,
    /// The file could not be read: the rule fails closed.
    Unreadable,
    /// The parsed file.
    Parsed(&'a CodeOwners),
}

/// A changed path still waiting for one of its code owners' approval.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingFile {
    /// The path.
    pub path: String,
    /// Its owner tokens as written ([`CodeOwners::owners_of`]).
    pub owners: Vec<String>,
    /// Some owner could approve it: a resolved identity, not the PR's author, whose current
    /// role counts toward the policy. `false`: only fixing the code owners file or a
    /// maintainer's bypass lets the PR merge.
    pub approvable: bool,
}

/// Where a PR stands against `requireCodeOwners`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeOwnerStatus {
    /// Every owned path has an owner's approval (or the rule is off, or nothing is owned).
    pub met: bool,
    /// The code owners file could not be read (`met` is then false).
    pub unreadable: bool,
    /// The owned paths without an owner's approval, in code-point order.
    pub pending: Vec<PendingFile>,
}

/// Judge a PR against its branch policy's `requireCodeOwners` (the module docs' merge rule).
/// `paths` are the PR's changed paths from the merge base, submodules included (`git diff-tree -r
/// --name-only --no-renames --ignore-submodules=none`, as the web's tree diff lists them);
/// `approvals` the PR's counted approvals ([`super::v2::count_approvals`]); `resolved` maps each
/// name token to the identity DPNS resolved it to (absent or `None`: unresolved).
#[must_use]
pub fn code_owner_review(
    file: OwnersFile<'_>,
    paths: &[String],
    approvals: &Approvals,
    oracle: &RoleOracle,
    policy: &Policy,
    resolved: &BTreeMap<String, Option<String>>,
    author: &str,
) -> CodeOwnerStatus {
    let met = CodeOwnerStatus {
        met: true,
        ..CodeOwnerStatus::default()
    };
    if !policy.require_code_owners {
        return met;
    }
    let owners = match file {
        OwnersFile::Absent => return met,
        OwnersFile::Unreadable => {
            return CodeOwnerStatus {
                met: false,
                unreadable: true,
                pending: Vec::new(),
            }
        }
        OwnersFile::Parsed(o) => o,
    };
    let identity_of = |token: &str| -> Option<String> {
        match owner_kind(token) {
            OwnerKind::Identity => token_identity(token).map(str::to_owned),
            OwnerKind::Name => resolved.get(token).cloned().flatten(),
            _ => None,
        }
    };
    let mut pending = Vec::new();
    for path in paths.iter().collect::<BTreeSet<_>>() {
        let tokens = owners.owners_of(path);
        if tokens.is_empty() {
            continue;
        }
        let ids: Vec<String> = tokens.iter().filter_map(|t| identity_of(t)).collect();
        let approved = ids
            .iter()
            .any(|id| approvals.approvers.contains(id) && counts_for(oracle, policy, id));
        if approved {
            continue;
        }
        let approvable = ids
            .iter()
            .any(|id| id != author && counts_for(oracle, policy, id));
        pending.push(PendingFile {
            path: path.clone(),
            owners: tokens,
            approvable,
        });
    }
    CodeOwnerStatus {
        met: pending.is_empty(),
        unreadable: false,
        pending,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owns(file: &str, path: &str) -> Vec<String> {
        parse_code_owners(file).owners_of(path)
    }

    #[test]
    fn patterns_follow_githubs_documented_examples() {
        let file = "\
* @global
*.js @js
*.go docs@example.com
/build/logs/ @logs
docs/* @docs
apps/ @apps
/docs/ @rootdocs
/scripts/ @s1 @s2
/apps/github
**/logs @anylogs
";
        assert_eq!(owns(file, "README.md"), ["@global"]);
        assert_eq!(owns(file, "src/a.js"), ["@js"]);
        assert_eq!(owns(file, "x.go"), ["docs@example.com"]);
        // The later `**/logs` wins over `/build/logs/`.
        assert_eq!(owns(file, "build/logs/a/b.txt"), ["@anylogs"]);
        assert_eq!(owns(file, "build/x.txt"), ["@global"]);
        // `/docs/` (later) owns everything under docs; `docs/*` is anchored too.
        assert_eq!(owns(file, "docs/getting-started.md"), ["@rootdocs"]);
        assert_eq!(owns(file, "x/docs/a.md"), ["@global"]);
        // `docs/*` owns direct children only.
        assert_eq!(owns("docs/* @docs", "docs/a.md"), ["@docs"]);
        assert!(owns("docs/* @docs", "docs/build/a.md").is_empty());
        assert_eq!(owns(file, "deep/apps/a.txt"), ["@apps"]);
        // `/apps/github` with no owners: nobody owns it.
        assert!(owns(file, "apps/github/x").is_empty());
        assert_eq!(owns(file, "a/logs/x"), ["@anylogs"]);
        assert_eq!(owns(file, "scripts/run.sh"), ["@s1", "@s2"]);
    }

    #[test]
    fn brackets_are_literal_and_escapes_work() {
        let file = "app/[slug]/ @route\nmy\\ file.txt @space\n\\#hash @h\n";
        assert_eq!(owns(file, "app/[slug]/page.tsx"), ["@route"]);
        assert!(owns(file, "app/s/page.tsx").is_empty());
        assert_eq!(owns(file, "my file.txt"), ["@space"]);
        assert_eq!(owns(file, "#hash"), ["@h"]);
    }

    #[test]
    fn gitlab_sections_combine_their_last_matches() {
        let file = "\
* @all
[Docs] @docs-default
*.md
^[Backend][2] @be
/src/ @src
[docs]
README.md @readme
";
        let co = parse_code_owners(file);
        assert_eq!(co.sections, ["", "docs", "backend"]);
        assert_eq!(co.owners_of("guide.md"), ["@all", "@docs-default"]);
        assert_eq!(co.owners_of("README.md"), ["@all", "@readme"]);
        assert_eq!(co.owners_of("src/a.rs"), ["@all", "@src"]);
        // A bracketed path that is not a header is a rule.
        assert_eq!(owns("[id]/page.tsx @a", "[id]/page.tsx"), ["@a"]);
    }

    #[test]
    fn malformed_lines_are_reported_and_skipped() {
        let co = parse_code_owners("!x @a\na/***/b @b\n# c\n\nok @c # trailing comment\n");
        assert_eq!(
            co.errors,
            [
                OwnersError {
                    line: 1,
                    error: "negation".into()
                },
                OwnersError {
                    line: 2,
                    error: "pattern".into()
                }
            ]
        );
        assert_eq!(co.owners_of("ok"), ["@c"]);
    }

    #[test]
    fn code_owner_review_needs_an_owner_per_owned_path() {
        use crate::rules::v2::{Membership, Role};
        let member = |identity: &str, role| Membership {
            identity: identity.into(),
            role,
            created_at: 1,
        };
        let oracle = RoleOracle::new(vec![
            member("A", Role::Maintainer),
            member("W", Role::Writer),
            member("T", Role::Triage),
        ]);
        let co = parse_code_owners("/src/ @alice\n/docs/ @wri\n/ops/ @team/x @tri\n");
        let resolved: BTreeMap<String, Option<String>> = [
            ("@alice".to_string(), Some("A".to_string())),
            ("@wri".to_string(), Some("W".to_string())),
            ("@tri".to_string(), Some("T".to_string())),
        ]
        .into();
        let paths: Vec<String> = ["src/a.rs", "docs/x.md", "ops/run.sh", "README.md"]
            .map(String::from)
            .into();
        let mut policy = Policy {
            require_code_owners: true,
            ..Policy::default()
        };
        let approvals = Approvals {
            approvers: ["A".to_string()].into(),
            changes_requested: BTreeSet::new(),
        };
        let got = code_owner_review(
            OwnersFile::Parsed(&co),
            &paths,
            &approvals,
            &oracle,
            &policy,
            &resolved,
            "P",
        );
        assert!(!got.met);
        let pending: Vec<(&str, bool)> = got
            .pending
            .iter()
            .map(|p| (p.path.as_str(), p.approvable))
            .collect();
        assert_eq!(pending, [("docs/x.md", true), ("ops/run.sh", false)]);
        // Maintainers-only: the writer owner can no longer approve.
        policy.approver_role = 1;
        let got = code_owner_review(
            OwnersFile::Parsed(&co),
            &paths,
            &approvals,
            &oracle,
            &policy,
            &resolved,
            "P",
        );
        assert!(!got.pending[0].approvable);
        let off = Policy::default();
        let none = |f| code_owner_review(f, &paths, &approvals, &oracle, &off, &resolved, "P");
        assert!(none(OwnersFile::Unreadable).met);
        let unread = code_owner_review(
            OwnersFile::Unreadable,
            &paths,
            &approvals,
            &oracle,
            &policy,
            &resolved,
            "P",
        );
        assert!(!unread.met && unread.unreadable);
        let absent = code_owner_review(
            OwnersFile::Absent,
            &paths,
            &approvals,
            &oracle,
            &policy,
            &resolved,
            "P",
        );
        assert!(absent.met);
    }

    #[test]
    fn tokens_are_classified() {
        let id = "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB";
        assert_eq!(owner_kind(id), OwnerKind::Identity);
        assert_eq!(owner_kind(&format!("@{id}")), OwnerKind::Identity);
        assert_eq!(owner_kind("@alice"), OwnerKind::Name);
        assert_eq!(owner_kind("@alice.dash"), OwnerKind::Name);
        assert_eq!(owner_kind("@org/team"), OwnerKind::Team);
        assert_eq!(owner_kind("a@b.io"), OwnerKind::Email);
        assert_eq!(owner_kind("@@maintainer"), OwnerKind::Role);
        assert_eq!(owner_kind("alice"), OwnerKind::Invalid);
    }
}
