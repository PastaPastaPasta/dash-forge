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
    /// The source verdict: recorded in the body header only. The mirror writes every
    /// review as a comment, so no source reviewer's approval counts as a member's.
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
    /// The source listed more issues/PRs than this run took (`--limit`): the incremental
    /// state must not advance past items that were never read.
    pub truncated: bool,
    /// Open PRs (GitHub numbers) whose heads the git push mirrors.
    pub open_pulls: Vec<u64>,
}

/// The part of a GitHub item URL after `github.com/<owner>/<repo>/` (`issues/12`,
/// `pull/3#pullrequestreview-9`), lower-cased: what survives a renamed or transferred repo.
fn tail(url: &str) -> String {
    let path = url
        .trim_start_matches("https://github.com/")
        .to_ascii_lowercase();
    match path.splitn(3, '/').collect::<Vec<_>>().as_slice() {
        [_, _, rest] => (*rest).to_string(),
        _ => String::new(),
    }
}

/// Whether two item keys name the same source item, tolerating a renamed or transferred
/// source repository (same `issues/N`, `pull/N`, comment or review anchor).
pub fn same_item(a: &str, b: &str) -> bool {
    let gh = |u: &str| u.starts_with("https://github.com/");
    a == b || (gh(a) && gh(b) && !tail(a).is_empty() && tail(a) == tail(b))
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

/// How a source review's verdict reads in its header.
pub fn verdict_word(v: Verdict) -> &'static str {
    match v {
        Verdict::Approve => "approved",
        Verdict::RequestChanges => "requested changes",
        _ => "commented",
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

/// Whether `uri` is a copy anyone can read, so it may be republished on chain under the
/// migrator's identity: `https`/`http` on a public host (no credentials, no query, so no
/// presigned or token URL that expires or leaks), or a content-addressed `ipfs://` CID.
/// `s3://` depends on the pusher's endpoint profile, and `platform://` names another
/// contract; both are refused, as is anything on a loopback, private, link-local, CGNAT or
/// unspecified address, or a `localhost` / `.local` / `.internal` name.
pub fn is_public_uri(uri: &str) -> bool {
    let Ok(u) = url::Url::parse(uri) else {
        return false;
    };
    if !u.username().is_empty() || u.password().is_some() || u.query().is_some() {
        return false;
    }
    match u.scheme() {
        "ipfs" => u
            .host_str()
            .is_some_and(|cid| !cid.is_empty() && cid.chars().all(|c| c.is_ascii_alphanumeric())),
        "https" | "http" => match u.host() {
            Some(url::Host::Domain(d)) => {
                let d = d.trim_end_matches('.').to_ascii_lowercase();
                !(d.is_empty()
                    || d == "localhost"
                    || [".localhost", ".local", ".internal", ".localdomain"]
                        .iter()
                        .any(|s| d.ends_with(s)))
            }
            Some(url::Host::Ipv4(ip)) => public_v4(ip),
            Some(url::Host::Ipv6(ip)) => {
                if let Some(v4) = ip.to_ipv4_mapped() {
                    return public_v4(v4);
                }
                let first = ip.segments()[0];
                !(ip.is_loopback()
                    || ip.is_unspecified()
                    || (first & 0xfe00) == 0xfc00 // unique local fc00::/7
                    || (first & 0xffc0) == 0xfe80) // link local fe80::/10
            }
            None => false,
        },
        _ => false,
    }
}

fn public_v4(ip: std::net::Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    !(ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || a == 0
        || (a == 100 && (64..128).contains(&b))) // CGNAT 100.64.0.0/10
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
    fn only_public_uris_are_republished() {
        for ok in [
            "https://bucket.example/p.pack",
            "http://mirror.example.org:8080/x",
            "ipfs://bafybeigdyrzt5",
            "https://8.8.8.8/p",
        ] {
            assert!(is_public_uri(ok), "{ok}");
        }
        for bad in [
            "https://user:pw@127.0.0.1/p",
            "https://user@bucket.example/p",
            "https://bucket.example/p?X-Amz-Signature=abc",
            "http://127.0.0.1:9000/b/p.pack",
            "http://localhost:8080/ipfs/x",
            "http://a.localhost/x",
            "http://nas.local/x",
            "https://10.1.2.3/p",
            "https://100.64.1.1/p",
            "https://0.0.0.0/p",
            "https://[::1]/p",
            "https://[fd00::1]/p",
            "https://[fe80::1]/p",
            "https://[::ffff:192.168.1.1]/p",
            "s3://bucket/key",
            "platform://C/abcd",
            "file:///etc/passwd",
            "ftp://x/y",
            "not a uri",
        ] {
            assert!(!is_public_uri(bad), "{bad}");
        }
    }

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
    fn items_survive_a_repo_rename_but_not_a_different_number() {
        let a = "https://github.com/old/name/issues/12";
        assert!(same_item(a, "https://github.com/new/renamed/issues/12"));
        assert!(!same_item(a, "https://github.com/old/name/issues/13"));
        assert!(!same_item(a, "https://github.com/old/name/pull/12"));
        assert!(same_item(
            "https://github.com/o/r/pull/3#pullrequestreview-9",
            "https://github.com/x/y/pull/3#pullrequestreview-9"
        ));
        assert!(same_item("dash-v1://C/issues/4", "dash-v1://C/issues/4"));
        assert!(!same_item("dash-v1://C/issues/4", "dash-v1://C/pulls/4"));
        assert!(!same_item(
            "https://github.com/o/r/issues/4",
            "dash-v1://C/issues/4"
        ));
        assert!(!same_item("", "https://github.com/o/r/issues/1"));
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
