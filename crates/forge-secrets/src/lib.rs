//! Likely secrets in files about to be published: one rule set for every Forge client.
//!
//! The push helper (`git-remote-dash`) runs it over the files a public push publishes for the
//! first time; the web editor and the publish dialog are to run the same rules later
//! (mixed-visibility design §4.5). This crate is **pure**: no I/O, no clock, no randomness.
//! Give it a path and the file's bytes ([`scan_file`]), or a path and the git blob id of a file
//! that was not read ([`scan_unread`]), and it returns the same findings everywhere. A
//! TypeScript port must reproduce the conformance vectors in
//! `forge-contracts/vectors/secret_scan/` byte for byte (findings, severities, fingerprints).
//!
//! # The rules
//!
//! Every rule is listed here and in [`Rule`]. Thresholds and word lists are the `pub const`s
//! below, so a port copies data, not behaviour.
//!
//! | Rule id | Severity | Matches |
//! |---|---|---|
//! | `env_file` | refuse | A file named `.env`, or `.env.<anything>` not ending in one of [`ENV_TEMPLATE_SUFFIXES`] (`.env.local` included), in any folder, names compared case-insensitively, that sets at least one variable to a non-empty value (`NAME=value`, `export NAME=value` or `NAME: value`; a leading UTF-8 BOM is ignored). A file that was not read counts as setting one. |
//! | `envrc` | warn | A file named `.envrc` (direnv, case-insensitive) that sets a variable to a non-empty value. |
//! | `private_key` | refuse | A PEM block `-----BEGIN <label>-----` … `-----END <label>-----` whose label is `PGP PRIVATE KEY BLOCK` or ends in `PRIVATE KEY` (RSA, EC, DSA, OPENSSH, ENCRYPTED, plain), with at least [`PEM_MIN_BODY`] base64 characters between the markers. `\n` escapes count as line breaks; header lines (with a `:`) are skipped. A mention of the marker alone is not a key. A block whose body is not a key does not hide a later `BEGIN` inside it. At most [`PEM_MAX_MARKERS`] `BEGIN` markers per file are examined. |
//! | `aws_key_pair` | refuse | An AWS access key id (`AKIA`, `ASIA`, `ABIA`, `ACCA` or `A3T?`, then 16 of `A-Z2-7`) **and**, in the same file, a 40-character secret (`A-Za-z0-9/+`, with an upper-case letter, a lower-case letter and a digit or `/`/`+`, not all hex). Either containing `EXAMPLE` (AWS's documentation pair) does not count. An id alone is not a finding. |
//! | `github_token` | refuse | `ghp_`, `gho_`, `ghu_`, `ghs_` or `ghr_` and 36 alphanumerics whose last 6 are the CRC32 checksum of the 30 before them, in base62 ([`github_checksum_ok`]). |
//! | `gitlab_token` | refuse | A GitLab routable token ([`GITLAB_PREFIXES`], a base64url payload of 27–300 characters, `.`, an optional 2-character version and `.`, the 2-character payload length and a 7-character CRC32, all base36) whose length and checksum agree ([`gitlab_checksum_ok`]). |
//! | `unverified_token` | warn | A GitHub or GitLab prefix whose checksum does not match, a fine-grained `github_pat_` token, or a legacy 20-character `glpat-` token (neither has a published checksum). |
//! | `wif` | warn | A 51- or 52-character base58 word that decodes, with a valid double-SHA-256 checksum, to a private key with a Dash or Bitcoin WIF version byte ([`WIF_VERSIONS`]). |
//! | `secret_assignment` | warn | One line `name = value` (also `:`, `:=`, `=>`, `export name=`, quoted), whose name contains one of [`SECRET_NAME_WORDS`] and whose value is [`ASSIGNMENT_MIN_LEN`]–[`ASSIGNMENT_MAX_LEN`] characters of `A-Za-z0-9+/=_-.~` with a Shannon entropy of at least [`ASSIGNMENT_MIN_ENTROPY`] bits per character and none of [`PLACEHOLDER_WORDS`]. Not reported on a line that already has another finding. |
//!
//! A file larger than [`MAX_SCAN_BYTES`], or with a NUL byte in its first [`BINARY_SNIFF_BYTES`]
//! bytes, is matched by name only (pass `None` as its content). Content is read as UTF-8 with
//! invalid bytes replaced (U+FFFD), as a browser's `TextDecoder` does; line numbers count `\n`.
//!
//! # From a finding to a verdict
//!
//! [`verdict`] turns a refusing content rule (`private_key`, `aws_key_pair`, `github_token`,
//! `gitlab_token`) into a warning when the file is under a test folder ([`TEST_DIRS`], any
//! folder of the path). The `env_file` name rule is never downgraded by a test folder: a real
//! `tests/.env` is refused. Any refusal becomes a warning when the finding is in **history**
//! (the caller decides what history is: the push helper uses commits from before the
//! repository's import point). Warning rules stay warnings. [`decide`] then applies an allow
//! list.
//!
//! # Fingerprints
//!
//! A finding's fingerprint is the first [`FINGERPRINT_HEX`] hex digits of
//! `SHA-256("forge-secrets/v1" 0x00 rule-id 0x00 path 0x00 material)`, where the material is
//! the file's git blob id for `env_file` and `envrc` (lower-case hex: [`git_blob_id`] of its
//! bytes, or the id the caller gives for a file it did not read), the base64 body for
//! `private_key`, `<id>:<secret>` for `aws_key_pair`, the token, the WIF, or `<name>=<value>`
//! for `secret_assignment`. It names one secret in one file and stays the same across commits
//! while the secret and the path do. It is a short hash, not a secret: for a tiny file or a
//! short value, someone holding the fingerprint could guess the content offline.
//!
//! # Allowing a finding
//!
//! [`AllowList`] reads `.forge/secret-scan-allow` ([`ALLOW_FILE`]): one fingerprint or path glob
//! per line, `#` comments. `git push -o allow-secret=<fingerprint>` ([`ALLOW_PUSH_OPTION`]) adds
//! fingerprints for one push. A listed **fingerprint** silences its finding. A **path** glob
//! only turns a refusal under it into a printed warning (reason `allowed_path`); it never
//! silences anything, so a path entry cannot hide a secret nobody looked at.

#![forbid(unsafe_code)]

mod allow;
mod content;
mod glob;
mod util;

pub use allow::{is_fingerprint, AllowList};
pub use content::{github_checksum_ok, gitlab_checksum_ok};
pub use glob::path_matches;

use sha2::{Digest, Sha256};

/// Files larger than this are matched by name only.
pub const MAX_SCAN_BYTES: usize = 1 << 20;
/// A NUL byte this early marks a binary file: matched by name only.
pub const BINARY_SNIFF_BYTES: usize = 8000;
/// Hex digits in a fingerprint.
pub const FINGERPRINT_HEX: usize = 12;
/// Folders whose content findings warn instead of refusing (any folder of the path, exact
/// name). The design lists `test`, `testdata` and `fixtures`; `tests` is added (Rust, Python).
pub const TEST_DIRS: &[&str] = &["test", "tests", "testdata", "fixtures"];
/// `.env.<name>` files with these endings are templates, not secrets.
pub const ENV_TEMPLATE_SUFFIXES: &[&str] = &[".example", ".sample", ".template"];
/// The committed allow file, at the root of a pushed branch or tag.
pub const ALLOW_FILE: &str = ".forge/secret-scan-allow";
/// `git push -o allow-secret=<fingerprint>`.
pub const ALLOW_PUSH_OPTION: &str = "allow-secret";
/// Fewest base64 characters in a PEM body for it to be a key.
pub const PEM_MIN_BODY: usize = 64;
/// `-----BEGIN ` markers examined per file at most (a file of thousands of markers stays cheap).
pub const PEM_MAX_MARKERS: usize = 64;
/// WIF version bytes: Bitcoin mainnet (0x80), Dash mainnet (0xCC), testnet and regtest (0xEF).
pub const WIF_VERSIONS: &[u8] = &[0x80, 0xCC, 0xEF];
/// GitHub token prefixes whose last six characters are a CRC32 checksum.
pub const GITHUB_PREFIXES: &[&str] = &["ghp_", "gho_", "ghu_", "ghs_", "ghr_"];
/// GitHub's fine-grained personal access token prefix (no published checksum).
pub const GITHUB_FINE_GRAINED_PREFIX: &str = "github_pat_";
/// GitLab token prefixes checked for the routable format.
pub const GITLAB_PREFIXES: &[&str] = &[
    "glpat-", "glrt-", "glcbt-", "gldt-", "glptt-", "glft-", "glimt-", "glagent-", "glsoat-",
    "gloas-",
];
/// AWS access key id prefixes (`A3T` takes one more character of the id alphabet).
pub const AWS_ID_PREFIXES: &[&str] = &["AKIA", "ASIA", "ABIA", "ACCA", "A3T"];
/// Words that make a setting's name secret-like (matched in its lower-cased name).
pub const SECRET_NAME_WORDS: &[&str] = &[
    "secret",
    "token",
    "password",
    "passwd",
    "api_key",
    "apikey",
    "api-key",
    "private_key",
    "privatekey",
    "access_key",
    "accesskey",
    "auth_key",
    "credential",
];
/// Values containing one of these (lower-cased) are placeholders.
pub const PLACEHOLDER_WORDS: &[&str] = &[
    "example",
    "changeme",
    "change_me",
    "placeholder",
    "xxxx",
    "your_",
    "your-",
    "${",
    "<",
];
/// Shortest value a `secret_assignment` reports.
pub const ASSIGNMENT_MIN_LEN: usize = 16;
/// Longest value a `secret_assignment` reports.
pub const ASSIGNMENT_MAX_LEN: usize = 256;
/// Fewest bits of Shannon entropy per character for a `secret_assignment`.
pub const ASSIGNMENT_MIN_ENTROPY: f64 = 3.5;

/// One rule of the set (see the crate docs for exactly what each matches).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Rule {
    /// A `.env` file with values.
    EnvFile,
    /// A direnv `.envrc` with values.
    Envrc,
    /// A PEM private-key block.
    PrivateKey,
    /// An AWS access key id with its secret.
    AwsKeyPair,
    /// A GitHub token with a valid checksum.
    GithubToken,
    /// A GitLab routable token with a valid checksum.
    GitlabToken,
    /// A GitHub or GitLab token prefix without a checksum that verifies.
    UnverifiedToken,
    /// A Dash or Bitcoin WIF private key.
    Wif,
    /// A random-looking value assigned to a secret-named setting.
    SecretAssignment,
}

impl Rule {
    /// Every rule, in report order.
    pub const ALL: [Rule; 9] = [
        Rule::EnvFile,
        Rule::Envrc,
        Rule::PrivateKey,
        Rule::AwsKeyPair,
        Rule::GithubToken,
        Rule::GitlabToken,
        Rule::UnverifiedToken,
        Rule::Wif,
        Rule::SecretAssignment,
    ];

    /// The stable id (vectors, fingerprints, JSON events).
    pub fn id(self) -> &'static str {
        match self {
            Rule::EnvFile => "env_file",
            Rule::Envrc => "envrc",
            Rule::PrivateKey => "private_key",
            Rule::AwsKeyPair => "aws_key_pair",
            Rule::GithubToken => "github_token",
            Rule::GitlabToken => "gitlab_token",
            Rule::UnverifiedToken => "unverified_token",
            Rule::Wif => "wif",
            Rule::SecretAssignment => "secret_assignment",
        }
    }

    /// The rule with id `id`.
    pub fn from_id(id: &str) -> Option<Rule> {
        Rule::ALL.into_iter().find(|r| r.id() == id)
    }

    /// Whether a finding of this rule refuses a push (before [`verdict`]'s exceptions).
    pub fn refuses(self) -> bool {
        matches!(
            self,
            Rule::EnvFile
                | Rule::PrivateKey
                | Rule::AwsKeyPair
                | Rule::GithubToken
                | Rule::GitlabToken
        )
    }

    /// What the file holds, as the end of a sentence about it ("`.env` looks like a secret
    /// file").
    pub fn describe(self) -> &'static str {
        match self {
            Rule::EnvFile => "looks like a secret file",
            Rule::Envrc => "is a direnv file that sets variables",
            Rule::PrivateKey => "holds a private key",
            Rule::AwsKeyPair => "holds an AWS access key and its secret",
            Rule::GithubToken => "holds a GitHub token",
            Rule::GitlabToken => "holds a GitLab token",
            Rule::UnverifiedToken => "holds what looks like a GitHub or GitLab token",
            Rule::Wif => "holds what looks like a Dash or Bitcoin private key",
            Rule::SecretAssignment => "sets a secret-named value to a random-looking string",
        }
    }
}

/// One likely secret in one file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finding {
    /// The rule that matched.
    pub rule: Rule,
    /// The file's path in the tree, `/`-separated.
    pub path: String,
    /// The 1-based line of the match; `None` for a whole-file rule.
    pub line: Option<u32>,
    /// Stable short id of this secret in this file (see the crate docs).
    pub fingerprint: String,
}

impl Finding {
    /// `path` or `path line N`.
    pub fn location(&self) -> String {
        match self.line {
            Some(n) => format!("{} line {n}", self.path),
            None => self.path.clone(),
        }
    }
}

/// What a finding does to a push.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    /// The push is refused unless the finding is allowed.
    Refuse,
    /// The push goes ahead with a warning.
    Warn,
}

/// Why a finding only warns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WarnReason {
    /// The rule only ever warns.
    Rule,
    /// The file is under a test folder ([`TEST_DIRS`]).
    TestPath,
    /// The finding is in history (before the import point).
    History,
    /// A path glob in the allow file covers a refusal.
    AllowedPath,
}

impl WarnReason {
    /// The stable id (vectors, JSON events).
    pub fn id(self) -> &'static str {
        match self {
            WarnReason::Rule => "rule",
            WarnReason::TestPath => "test_path",
            WarnReason::History => "history",
            WarnReason::AllowedPath => "allowed_path",
        }
    }
}

/// A finding's severity, and the reason when it only warns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Verdict {
    /// Refuse or warn.
    pub severity: Severity,
    /// Why it only warns; `None` when it refuses.
    pub reason: Option<WarnReason>,
}

/// The verdict on `finding`: a refusing rule warns instead under a test folder or in history.
pub fn verdict(finding: &Finding, history: bool) -> Verdict {
    let warn = |reason| Verdict {
        severity: Severity::Warn,
        reason: Some(reason),
    };
    if !finding.rule.refuses() {
        warn(WarnReason::Rule)
    } else if finding.rule != Rule::EnvFile && is_test_path(&finding.path) {
        warn(WarnReason::TestPath)
    } else if history {
        warn(WarnReason::History)
    } else {
        Verdict {
            severity: Severity::Refuse,
            reason: None,
        }
    }
}

/// [`verdict`] with an allow list applied: `None` when a listed fingerprint silences the
/// finding; a refusal whose path a glob covers becomes a warning ([`WarnReason::AllowedPath`]).
pub fn decide(finding: &Finding, history: bool, allow: &AllowList) -> Option<Verdict> {
    if allow.allows_fingerprint(finding) {
        return None;
    }
    let v = verdict(finding, history);
    if v.severity == Severity::Refuse && allow.allows_path(finding) {
        return Some(Verdict {
            severity: Severity::Warn,
            reason: Some(WarnReason::AllowedPath),
        });
    }
    Some(v)
}

/// Whether any folder of `path` is one of [`TEST_DIRS`].
pub fn is_test_path(path: &str) -> bool {
    path.rsplit_once('/')
        .is_some_and(|(dirs, _)| dirs.split('/').any(|d| TEST_DIRS.contains(&d)))
}

/// The file name of `path` (its last `/`-separated part).
fn base_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Whether `path` names an env file the `env_file` rule covers (case-insensitive).
pub fn is_env_file_name(path: &str) -> bool {
    let name = base_name(path).to_ascii_lowercase();
    name == ".env"
        || (name.starts_with(".env.") && !ENV_TEMPLATE_SUFFIXES.iter().any(|s| name.ends_with(s)))
}

/// The git blob id of `bytes` (SHA-1 of `blob <len>` 0x00 bytes, lower-case hex), as
/// `git hash-object` prints it in a SHA-1 repository.
pub fn git_blob_id(bytes: &[u8]) -> String {
    use sha1::{Digest as _, Sha1};
    let mut h = Sha1::new();
    h.update(format!("blob {}\0", bytes.len()).as_bytes());
    h.update(bytes);
    hex(&h.finalize())
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    bytes
        .iter()
        .flat_map(|b| [HEX[usize::from(b >> 4)], HEX[usize::from(b & 0x0f)]])
        .map(char::from)
        .collect()
}

/// Whether `content` is text worth matching: within [`MAX_SCAN_BYTES`] and no NUL in its first
/// [`BINARY_SNIFF_BYTES`] bytes.
pub fn is_scannable(content: &[u8]) -> bool {
    content.len() <= MAX_SCAN_BYTES && !content.iter().take(BINARY_SNIFF_BYTES).any(|&b| b == 0)
}

/// Every finding in the file at `path` (`/`-separated, relative to the tree's root), from its
/// bytes. Content that is not [`is_scannable`] is matched by name only. Findings come in a
/// fixed order: whole-file rules first, then by line, then by rule, then by fingerprint.
pub fn scan_file(path: &str, bytes: &[u8]) -> Vec<Finding> {
    scan(
        path,
        Some(bytes).filter(|b| is_scannable(b)),
        &git_blob_id(bytes),
    )
}

/// The findings of a file that was not read (too large, or over a budget), by its name and its
/// git blob id (which goes into an `env_file` or `envrc` fingerprint).
pub fn scan_unread(path: &str, blob_id: &str) -> Vec<Finding> {
    scan(path, None, &blob_id.to_ascii_lowercase())
}

fn scan(path: &str, content: Option<&[u8]>, blob_id: &str) -> Vec<Finding> {
    let mut out = Vec::new();
    let name = base_name(path).to_ascii_lowercase();
    let text = content.map(String::from_utf8_lossy);
    let sets_values = text.as_deref().is_none_or(content::sets_a_value);
    if is_env_file_name(path) && sets_values {
        out.push(finding(Rule::EnvFile, path, None, blob_id.as_bytes()));
    } else if name == ".envrc" && sets_values {
        out.push(finding(Rule::Envrc, path, None, blob_id.as_bytes()));
    }
    if let Some(text) = text.as_deref() {
        let matches = content::scan_text(text);
        let starts = util::line_starts(text);
        let mut lines_with_findings = std::collections::BTreeSet::new();
        for m in &matches {
            if m.rule != Rule::SecretAssignment {
                lines_with_findings.insert(util::line_at(&starts, m.offset));
                if let Some(also) = m.also {
                    lines_with_findings.insert(util::line_at(&starts, also));
                }
            }
        }
        for m in matches {
            let line = util::line_at(&starts, m.offset);
            if m.rule == Rule::SecretAssignment && lines_with_findings.contains(&line) {
                continue;
            }
            out.push(finding(m.rule, path, Some(line), m.material.as_bytes()));
        }
    }
    out.sort_by(|a, b| {
        (a.line.unwrap_or(0), a.rule, &a.fingerprint).cmp(&(
            b.line.unwrap_or(0),
            b.rule,
            &b.fingerprint,
        ))
    });
    out.dedup();
    out
}

fn finding(rule: Rule, path: &str, line: Option<u32>, material: &[u8]) -> Finding {
    Finding {
        rule,
        path: path.to_string(),
        line,
        fingerprint: fingerprint(rule, path, material),
    }
}

/// The fingerprint of `material` found by `rule` in `path` (see the crate docs).
pub fn fingerprint(rule: Rule, path: &str, material: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(b"forge-secrets/v1\0");
    h.update(rule.id().as_bytes());
    h.update([0]);
    h.update(path.as_bytes());
    h.update([0]);
    h.update(material);
    hex(&h.finalize()[..FINGERPRINT_HEX / 2])
}

#[cfg(test)]
mod tests;
