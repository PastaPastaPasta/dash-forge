//! The allow list: `.forge/secret-scan-allow` and `-o allow-secret=<fingerprint>`.
//!
//! File format, one entry per line:
//!
//! ```text
//! 3f9a1c2d4e5f      # the staging .env, reviewed 2026-10-05
//! # revoked demo keys: still printed, never refused
//! docs/examples/**/*.pem
//! ```
//!
//! - A line is trimmed; an empty line, or one starting with `#`, is ignored. Text after ` #`
//!   (whitespace then `#`) is a comment.
//! - Exactly [`crate::FINGERPRINT_HEX`] hex digits is a fingerprint (case-insensitive).
//! - Anything else is a path glob ([`crate::path_matches`]), matched from the repository's root.
//!
//! A fingerprint silences its finding. A path glob only turns a refusal into a printed warning:
//! it never silences, so a broad path entry cannot hide a secret nobody has looked at.

use std::collections::BTreeSet;

use crate::{path_matches, Finding, FINGERPRINT_HEX};

/// Fingerprints and path globs whose findings are allowed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AllowList {
    fingerprints: BTreeSet<String>,
    globs: Vec<String>,
}

impl AllowList {
    /// An empty list.
    pub fn new() -> Self {
        Self::default()
    }

    /// Parse an allow file (see the module docs). Never fails: every line is an entry or a
    /// comment.
    pub fn parse(text: &str) -> Self {
        let mut list = Self::new();
        for line in text.lines() {
            let entry = strip_comment(line).trim();
            if entry.is_empty() {
                continue;
            }
            if !list.add_fingerprint(entry) {
                list.globs.push(entry.to_string());
            }
        }
        list
    }

    /// Add `fp` when it is a fingerprint ([`is_fingerprint`]); `false` (nothing added) when not.
    pub fn add_fingerprint(&mut self, fp: &str) -> bool {
        let ok = is_fingerprint(fp);
        if ok {
            self.fingerprints.insert(fp.to_ascii_lowercase());
        }
        ok
    }

    /// Add every entry of `other`.
    pub fn extend(&mut self, other: AllowList) {
        self.fingerprints.extend(other.fingerprints);
        for g in other.globs {
            if !self.globs.contains(&g) {
                self.globs.push(g);
            }
        }
    }

    /// Whether `finding`'s fingerprint is listed (it is silenced).
    pub fn allows_fingerprint(&self, finding: &Finding) -> bool {
        self.fingerprints.contains(&finding.fingerprint)
    }

    /// Whether a path glob covers `finding`'s path (a refusal becomes a warning).
    pub fn allows_path(&self, finding: &Finding) -> bool {
        self.globs.iter().any(|g| path_matches(g, &finding.path))
    }

    /// Only the fingerprints of this list (what another ref's allow file may contribute).
    #[must_use]
    pub fn fingerprints_only(&self) -> AllowList {
        AllowList {
            fingerprints: self.fingerprints.clone(),
            globs: Vec::new(),
        }
    }

    /// Whether the list has no entries.
    pub fn is_empty(&self) -> bool {
        self.fingerprints.is_empty() && self.globs.is_empty()
    }
}

/// Whether `s` is a fingerprint: exactly [`FINGERPRINT_HEX`] hex digits.
pub fn is_fingerprint(s: &str) -> bool {
    s.len() == FINGERPRINT_HEX && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `line` without a comment: everything when it starts with `#`, else from the first `#` that
/// follows whitespace.
fn strip_comment(line: &str) -> &str {
    let t = line.trim_start();
    if t.starts_with('#') {
        return "";
    }
    let b = t.as_bytes();
    (1..b.len())
        .find(|&i| b[i] == b'#' && b[i - 1].is_ascii_whitespace())
        .map_or(t, |i| &t[..i])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Rule;

    fn f(path: &str, fp: &str) -> Finding {
        Finding {
            rule: Rule::EnvFile,
            path: path.into(),
            line: None,
            fingerprint: fp.into(),
        }
    }

    #[test]
    fn fingerprints_globs_and_comments() {
        let list = AllowList::parse(
            "# header\n\n  3F9A1C2D4E5F   # staging\nsrc/test/data/key_io_valid.json\nnot#acomment\n",
        );
        assert!(list.allows_fingerprint(&f(".env", "3f9a1c2d4e5f")));
        assert!(!list.allows_path(&f(".env", "3f9a1c2d4e5f")));
        let vectors = f("src/test/data/key_io_valid.json", "000000000000");
        assert!(list.allows_path(&vectors) && !list.allows_fingerprint(&vectors));
        assert!(!list.allows_path(&f("other", "000000000000")));
        assert!(list.allows_path(&f("not#acomment", "000000000000")));
        assert!(list
            .fingerprints_only()
            .allows_fingerprint(&f(".env", "3f9a1c2d4e5f")));
        assert!(!list.fingerprints_only().allows_path(&vectors));
        assert!(AllowList::parse("# only\n").is_empty());
    }

    #[test]
    fn only_exact_length_hex_is_a_fingerprint() {
        let mut l = AllowList::new();
        assert!(!l.add_fingerprint("3f9a"));
        assert!(!l.add_fingerprint("3f9a1c2d4e5g"));
        assert!(l.add_fingerprint("3f9a1c2d4e5f"));
    }
}
