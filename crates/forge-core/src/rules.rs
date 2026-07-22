//! `FORGE_RULES_V1` — ref resolution, event folds, and protected-pattern matching.
//!
//! These rules exist twice by necessity (Rust here, TypeScript in forge-web) and are
//! held in parity by shared JSON conformance vectors (`forge-contracts/vectors/`).
//! This module fixes the versioned identifier and the type surface; the normative
//! fold algorithms land alongside the vectors.

use serde::{Deserialize, Serialize};

/// The versioned rules identifier shared with forge-web and the conformance vectors.
pub const FORGE_RULES_V1: &str = "FORGE_RULES_V1";

/// A 20-byte git object id (SHA-1). SHA-256 repos are a later concern.
pub type Oid = [u8; 20];

/// The resolved state of a single ref after folding its `refUpdate` history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefState {
    /// The ref points at a single object.
    Present {
        /// Current tip.
        oid: Oid,
    },
    /// The ref has been deleted (folded from a zero-OID update).
    Deleted,
    /// A lost same-`prevOid` race left two tips live at consensus; the ref is
    /// provisional until a superseding merge/force push resolves it
    /// (see `docs/contracts/data-contracts.md` §2.3).
    Diverged {
        /// The competing live tips.
        tips: Vec<Oid>,
    },
}

/// A single append-only `refUpdate` / `protectedRefUpdate` event.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefUpdateEvent {
    /// Hex-encoded 32-byte hash of the ref name (ref names may exceed the 63-char
    /// indexed-string limit, so the hash is indexed instead).
    pub ref_name_hash: String,
    /// Previous OID recorded for force/fast-forward detection (hex; zero = create).
    pub prev_oid: String,
    /// New OID (hex; zero = delete).
    pub new_oid: String,
    /// Whether the pusher set the force flag.
    pub force: bool,
    /// Whether this came in via the MAINTAIN-gated `protectedRefUpdate` type.
    pub protected: bool,
    /// Consensus timestamp (ms), used for as-of protected-pattern evaluation.
    pub timestamp_ms: u64,
}

/// A collaboration event kind that participates in an open/closed event fold
/// (`docs/architecture.md` §4.2 / data-contracts §3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EventKind {
    /// Issue/patch closed.
    Close,
    /// Issue/patch reopened.
    Reopen,
    /// Patch merged.
    Merge,
    /// Label added/removed.
    Label,
    /// Assignment changed.
    Assign,
}

/// Fold the ordered `refUpdate` history of a single ref into its [`RefState`].
///
/// Implemented in Stage 2 against the shared conformance vectors; the signature is
/// fixed now so callers and the vector runner can be written against it.
#[allow(clippy::needless_pass_by_value)]
#[must_use]
pub fn fold_ref(_events: Vec<RefUpdateEvent>) -> Option<RefState> {
    // Stage 2: newest-non-superseded fold with divergence detection.
    None
}

/// Whether `ref_name` matches a protected-ref glob `pattern`.
///
/// Supports `*` (matches any run of characters, including `/`). This is the
/// client-side rule that routes matching refs through the MAINTAIN-gated
/// `protectedRefUpdate` type.
#[must_use]
pub fn matches_protected(pattern: &str, ref_name: &str) -> bool {
    glob_match(pattern.as_bytes(), ref_name.as_bytes())
}

/// Iterative `*`-glob matcher (no regex dependency).
fn glob_match(pattern: &[u8], text: &[u8]) -> bool {
    let (mut p, mut t) = (0usize, 0usize);
    let (mut star, mut mark) = (None::<usize>, 0usize);

    while t < text.len() {
        if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            mark = t;
            p += 1;
        } else if p < pattern.len() && pattern[p] == text[t] {
            p += 1;
            t += 1;
        } else if let Some(sp) = star {
            p = sp + 1;
            mark += 1;
            t = mark;
        } else {
            return false;
        }
    }

    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

#[cfg(test)]
mod tests {
    use super::{fold_ref, matches_protected};

    #[test]
    fn protected_exact_and_wildcard() {
        assert!(matches_protected("refs/heads/main", "refs/heads/main"));
        assert!(!matches_protected("refs/heads/main", "refs/heads/dev"));
        assert!(matches_protected("refs/heads/*", "refs/heads/main"));
        assert!(matches_protected("refs/heads/*", "refs/heads/feature/x"));
        assert!(matches_protected("refs/tags/v*", "refs/tags/v1.2.3"));
        assert!(!matches_protected("refs/tags/v*", "refs/heads/main"));
        assert!(matches_protected("*", "anything/at/all"));
    }

    #[test]
    fn fold_ref_is_unimplemented_placeholder() {
        assert!(fold_ref(Vec::new()).is_none());
    }
}
