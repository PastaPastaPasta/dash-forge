//! The source-neutral model both importers produce: what the destination forge-v2 repo
//! should hold. `import` builds it from GitHub, `migrate` from a forge-v1 repository; the
//! [`crate::sink`] diffs it against the chain and writes only what is missing.
//!
//! Every item carries a stable `key`, recorded in the destination document's
//! `imported.url`. It is how a re-run recognizes what it already wrote, so running an
//! import again costs nothing when nothing changed.

use std::collections::BTreeSet;

use forge_core::collab::v2::TargetKind;
use forge_core::collab::{CommentAnchor, Imported, ReleaseAsset, Verdict};

/// An issue or pull request to mirror.
#[derive(Debug, Clone)]
pub struct SrcTarget {
    /// Issue or pull request.
    pub kind: TargetKind,
    /// Its number, kept as in the source (numbers may leave gaps; §6 allows it).
    pub number: u32,
    /// Title (truncated to the contract's bounds).
    pub title: String,
    /// Body, including the provenance header.
    pub body: String,
    /// Provenance; `imported.url` is the idempotency key.
    pub imported: Imported,
    /// Closed in the source.
    pub closed: bool,
    /// The merge commit, when a pull request was merged.
    pub merged_oid: Option<Vec<u8>>,
    /// Labels applied in the source now.
    pub labels: BTreeSet<String>,
    /// Draft (pull requests).
    pub draft: bool,
    /// Pull-request specifics.
    pub patch: Option<SrcPatch>,
    /// Comments, oldest first.
    pub comments: Vec<SrcComment>,
    /// Reviews (pull requests), oldest first.
    pub reviews: Vec<SrcReview>,
}

/// What a pull request points at.
#[derive(Debug, Clone)]
pub struct SrcPatch {
    /// Base ref, `refs/heads/<branch>`.
    pub base_ref_name: String,
    /// Where the head is kept in the destination (`refs/mirror/pull/<n>/head`), if pushed.
    pub source_ref_name: Option<String>,
    /// Head commit (20 bytes).
    pub head_oid: Vec<u8>,
}

/// A comment to mirror.
#[derive(Debug, Clone)]
pub struct SrcComment {
    /// Body, including the provenance header.
    pub body: String,
    /// Provenance (`url` is the key).
    pub imported: Imported,
    /// A line anchor (review comments).
    pub anchor: Option<CommentAnchor>,
}

/// A review to mirror.
#[derive(Debug, Clone)]
pub struct SrcReview {
    /// Approve / request changes / comment.
    pub verdict: Verdict,
    /// The commit reviewed.
    pub commit_oid: Vec<u8>,
    /// Body, including the provenance header.
    pub body: String,
    /// Provenance (`url` is the key).
    pub imported: Imported,
}

/// A label definition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SrcLabel {
    /// Name (≤ 30 chars).
    pub name: String,
    /// `#rrggbb`, lower case.
    pub color: String,
    /// Description.
    pub description: String,
}

/// A release.
#[derive(Debug, Clone)]
pub struct SrcRelease {
    /// Tag.
    pub tag_name: String,
    /// Title.
    pub name: String,
    /// Notes.
    pub notes: String,
    /// Assets referenced by URL and sha256 (never re-uploaded).
    pub assets: Vec<ReleaseAsset>,
}

/// Everything one run mirrors (beyond git data).
#[derive(Debug, Clone, Default)]
pub struct SrcCollab {
    /// Issues and pull requests.
    pub targets: Vec<SrcTarget>,
    /// Label definitions (`None`: labels are not synced).
    pub labels: Option<Vec<SrcLabel>>,
    /// Releases (`None`: releases are not synced).
    pub releases: Option<Vec<SrcRelease>>,
}

// ---------------------------------------------------------------------------------------
// Text bounds (the contract counts characters AND bytes; both must fit)
// ---------------------------------------------------------------------------------------

/// `s` cut to at most `max_chars` characters and `max_bytes` UTF-8 bytes.
pub fn clip(s: &str, max_chars: usize, max_bytes: usize) -> String {
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i >= max_chars || out.len() + c.len_utf8() > max_bytes {
            break;
        }
        out.push(c);
    }
    out
}

/// A title within the contract (1..=256 chars, ≤ 1024 bytes); an empty one becomes `fallback`.
pub fn title(s: &str, fallback: &str) -> String {
    let t = clip(s.trim(), 256, 1024);
    if t.is_empty() {
        clip(fallback, 256, 1024)
    } else {
        t
    }
}

/// The contract's body bound (5120 chars and 5120 bytes).
pub const BODY_MAX: usize = 5120;

/// `header` + `text`, cut to the body bound; a cut body says where the full text is.
pub fn body(header: &str, text: &str, full_at: &str) -> String {
    let whole = if text.trim().is_empty() {
        header.trim_end().to_string()
    } else {
        format!("{header}{text}")
    };
    if whole.chars().count() <= BODY_MAX && whole.len() <= BODY_MAX {
        return whole;
    }
    let note = format!("\n\n… (truncated; the full text is at {full_at})");
    let room = BODY_MAX.saturating_sub(note.len());
    format!("{}{note}", clip(&whole, room, room))
}

/// Provenance within the contract (author ≤ 120 chars / 480 bytes, url ≤ 300 bytes).
pub fn imported(author: &str, created_at: u64, url: &str) -> Imported {
    Imported {
        author: clip(author, 120, 480),
        created_at,
        url: clip(url, 300, 300),
    }
}

/// A GitHub `rrggbb` (or `#rrggbb`) as the contract's `#rrggbb`, else a neutral grey.
pub fn color(c: &str) -> String {
    let c = c.trim().trim_start_matches('#');
    if c.len() == 6 && c.chars().all(|ch| ch.is_ascii_hexdigit()) {
        format!("#{}", c.to_ascii_lowercase())
    } else {
        "#ededed".to_string()
    }
}

/// A label name within the contract (≤ 30 chars, ≤ 60 bytes); also the `event.value`.
pub fn label_name(s: &str) -> String {
    clip(s.trim(), 30, 60)
}

/// `YYYY-MM-DD` of unix seconds, for headers.
pub fn date(secs: u64) -> String {
    crate::github::unix_to_iso8601(secs)[..10].to_string()
}

/// Hex oid to bytes (`None` unless 20 or 32 bytes).
pub fn oid(hex_oid: &str) -> Option<Vec<u8>> {
    hex::decode(hex_oid)
        .ok()
        .filter(|b| b.len() == 20 || b.len() == 32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_respects_chars_and_bytes() {
        assert_eq!(clip("hello", 3, 100), "hel");
        assert_eq!(clip("éééé", 10, 5), "éé");
        assert_eq!(clip("", 3, 3), "");
    }

    #[test]
    fn titles_are_never_empty() {
        assert_eq!(title("   ", "Issue #4"), "Issue #4");
        assert_eq!(title(&"x".repeat(300), "f").chars().count(), 256);
    }

    #[test]
    fn long_bodies_are_cut_with_a_pointer_to_the_full_text() {
        let b = body("> h\n\n", &"é".repeat(6000), "https://x/1");
        assert!(b.len() <= BODY_MAX && b.chars().count() <= BODY_MAX);
        assert!(b.ends_with("the full text is at https://x/1)"));
        assert_eq!(body("> h\n\n", "short", "u"), "> h\n\nshort");
        assert_eq!(body("> h\n\n", "", "u"), "> h");
    }

    #[test]
    fn colors_and_oids_normalize() {
        assert_eq!(color("EE0701"), "#ee0701");
        assert_eq!(color("#abcdef"), "#abcdef");
        assert_eq!(color("nope"), "#ededed");
        assert_eq!(oid(&"ab".repeat(20)).unwrap().len(), 20);
        assert!(oid("abcd").is_none());
        assert!(oid("zz").is_none());
    }
}
