//! The source-neutral model both importers produce: what the destination forge-v2 repo
//! should hold. `import` builds it from GitHub; the
//! [`crate::sink`] diffs it against the chain and writes only what is missing.
//!
//! Every item carries a stable `key`, recorded in the destination document's
//! `imported.url`. It is how a re-run recognizes what it already wrote, so running an
//! import again costs nothing when nothing changed.

use std::collections::{BTreeMap, BTreeSet};

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
    /// Assets of the source release left out: the rest do not fit the 4096 bytes a release
    /// lists (the run warns, and the notes' footer says so: [`notes_with_footer`]).
    pub dropped: usize,
    /// The release's page at the source (empty when unknown).
    pub source_url: String,
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
    /// Some of what was asked for could not be read (the token may not read comments or
    /// labels): the incremental state must not advance, so a run that can read them sees
    /// these items again.
    pub incomplete: bool,
    /// Open PRs/MRs (source numbers) whose heads the git push mirrors. `None`: not read
    /// (not asked for, or the source refused the listing); the heads push is then skipped
    /// entirely, since its `--prune` would delete every head already mirrored.
    pub open_pulls: Option<Vec<u64>>,
    /// Things the user should know about what was read.
    pub warnings: Vec<String>,
}

/// An item URL split into (`host/repository`, the item: `issues/12`,
/// `pull/3#pullrequestreview-9`, `merge_requests/4#note_7`), lower-cased (GitHub and GitLab
/// paths are case-insensitive).
///
/// * GitHub: `https://github.com/<owner>/<repo>/<item>`.
/// * GitLab (any host): `https://<host>/<group>/<subgroups…>/<project>/-/<item>`. The `/-/`
///   separator ends a project path of any depth. GitLab now shows issues at `/-/work_items/`
///   and still serves `/-/issues/`; both name the same issue.
fn split_item(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("https://")?.to_ascii_lowercase();
    let (host, path) = rest.split_once('/')?;
    let (repo, item) = if host == "github.com" {
        match path.splitn(3, '/').collect::<Vec<_>>().as_slice() {
            [owner, repo, item] if !owner.is_empty() && !repo.is_empty() => {
                (format!("{owner}/{repo}"), (*item).to_string())
            }
            _ => return None,
        }
    } else {
        let (repo, item) = path.split_once("/-/")?;
        let item = match item.strip_prefix("work_items/") {
            Some(n) => format!("issues/{n}"),
            None => item.to_string(),
        };
        (repo.to_string(), item)
    };
    (!repo.is_empty() && !item.is_empty()).then(|| (format!("{host}/{repo}"), item))
}

/// Whether two item keys name the same source item: the same key, or the same repository
/// (case-insensitive) and item. The repository must match: a document anyone can write must
/// not claim an item of this mirror by its number alone.
pub fn same_item(a: &str, b: &str) -> bool {
    a == b || matches!((split_item(a), split_item(b)), (Some(x), Some(y)) if x == y)
}

/// Whether two keys name the same item of possibly different repositories on the same
/// host (a renamed or transferred repository keeps its item paths). Only for documents the
/// mirror itself wrote: its own earlier copy of an item survives a rename.
pub fn same_item_renamed(a: &str, b: &str) -> bool {
    let host = |r: &str| r.split('/').next().unwrap_or_default().to_string();
    same_item(a, b)
        || matches!((split_item(a), split_item(b)),
            (Some((ra, x)), Some((rb, y))) if x == y && host(&ra) == host(&rb))
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

/// A label definition within the contract (`None` for a blank name).
pub fn label(name: &str, color_hex: &str, description: Option<&str>) -> Option<SrcLabel> {
    (!name.trim().is_empty()).then(|| SrcLabel {
        name: label_name(name),
        color: color(color_hex),
        description: clip(description.unwrap_or(""), 200, 400),
    })
}

/// A release within the contract: the title defaults to the tag, and the assets are the
/// ones [`fit_assets`] keeps within the release's 4096-byte `assets` field. `source_url` is
/// the release's page at the source, which the notes' footer links when assets are left out
/// ([`notes_with_footer`]).
pub fn release(
    tag_name: &str,
    name: Option<&str>,
    notes: Option<&str>,
    assets: Vec<ReleaseAsset>,
    source_url: String,
) -> SrcRelease {
    // Sized as recorded: with the 64-hex hash the importer fills in for an asset the source
    // gives none (D-517), so the list never outgrows the field once hashed.
    let sized: Vec<ReleaseAsset> = assets
        .iter()
        .map(|a| ReleaseAsset {
            sha256: "0".repeat(64),
            ..a.clone()
        })
        .collect();
    let keep = fit_indices(&sized);
    let total = assets.len();
    let assets = select(assets, &keep);
    SrcRelease {
        tag_name: tag_name.to_string(),
        name: clip(name.unwrap_or(tag_name), 120, 480),
        notes: clip(notes.unwrap_or(""), NOTES_MAX, NOTES_MAX),
        dropped: total - assets.len(),
        assets,
        source_url,
    }
}

/// The most bytes a release's `assets` JSON may take (forge-core `release.assets`).
const ASSETS_MAX: usize = 4096;

/// The most bytes a release's `notes` may take (forge-core `release.notes`).
const NOTES_MAX: usize = 5120;

/// How much an asset is worth keeping when a release lists more than 4096 bytes of them;
/// lower is kept first. Checksum lists come first (`SHA256SUMS`, `checksums.txt` and their
/// signatures: one file verifies every other download), then the common platform builds,
/// in order: Linux x86-64, Windows x64, macOS arm64, macOS x86-64, Linux arm64. Then source
/// archives, then everything else. Documented in docs/guides/mirror-a-github-repo.md.
fn asset_rank(name: &str) -> u8 {
    // Lower-cased once, and split into its `-`/`.`/`+`… delimited tokens, so a word matches
    // only whole (`darwinia` is not macOS, `armadillo` is not ARM); `x86-64` is one token.
    let n = name.to_ascii_lowercase().replace("x86-64", "x86_64");
    let tokens: Vec<&str> = n
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|t| !t.is_empty())
        .collect();
    let has = |words: &[&str]| tokens.iter().any(|t| words.contains(t));
    let starts = |prefixes: &[&str]| {
        tokens
            .iter()
            .any(|t| prefixes.iter().any(|p| t.starts_with(p)))
    };
    let ext = tokens.last().copied().unwrap_or("");
    let linux = has(&["linux"]);
    let windows = has(&["win", "win32", "win64", "windows"]) || matches!(ext, "exe" | "msi");
    let mac = has(&["darwin", "apple", "macos", "mac", "osx", "osx64"]) || ext == "dmg";
    let x86_64 = has(&["x86_64", "amd64", "x64", "win64", "osx64"]);
    let arm64 = has(&["aarch64", "arm64"]);
    if starts(&["sha256sum", "sha512sum", "sha1sum", "checksum"]) {
        0
    } else if linux && x86_64 {
        1
    } else if windows {
        2
    } else if mac && arm64 {
        3
    } else if mac {
        4
    } else if linux && arm64 {
        5
    } else if matches!(ext, "gz" | "xz" | "tgz" | "zip")
        && !linux
        && !mac
        && !has(&[
            "arm", "armhf", "armel", "i686", "i386", "x86", "android", "freebsd",
        ])
        && !starts(&["armv", "riscv"])
    {
        6
    } else {
        7
    }
}

/// The file a detached signature or per-file checksum is for (`a.tar.gz.asc` → `a.tar.gz`).
fn signed_subject(name: &str) -> Option<&str> {
    [
        ".asc",
        ".sig",
        ".minisig",
        ".sha256",
        ".sha256sum",
        ".sha512",
    ]
    .iter()
    .find_map(|ext| name.strip_suffix(ext))
    .filter(|s| !s.is_empty())
}

/// The assets of `assets` a release keeps within [`ASSETS_MAX`] bytes, as indices (in the
/// source's order). Chosen by [`asset_rank`], each file with its signature (`.asc`, `.sig`,
/// …) right behind it, so a kept download keeps what verifies it; a pair that does not fit
/// may keep the file alone. Every asset that fits after the higher-ranked ones is kept, so a
/// large one never blocks smaller ones behind it.
fn fit_indices(assets: &[ReleaseAsset]) -> BTreeSet<usize> {
    let size = |i: usize| serde_json::to_string(&assets[i]).map_or(usize::MAX, |s| s.len());
    let by_name: BTreeMap<&str, usize> = assets
        .iter()
        .enumerate()
        .map(|(i, a)| (a.name.as_str(), i))
        .collect();
    // A signature whose subject is listed travels with it; any other asset is its own unit.
    let mut sigs: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    let mut roots = Vec::new();
    for (i, a) in assets.iter().enumerate() {
        match signed_subject(&a.name).and_then(|s| by_name.get(s).copied()) {
            Some(s) if s != i => sigs.entry(s).or_default().push(i),
            _ => roots.push(i),
        }
    }
    // Stable: equal ranks keep the source's order.
    roots.sort_by_key(|&i| asset_rank(&assets[i].name));
    // `[` + entries joined by `,` + `]`.
    let mut used = 2usize;
    let mut keep = BTreeSet::new();
    let mut take = |i: usize| {
        let add = size(i).saturating_add(usize::from(!keep.is_empty()));
        let fits = used.saturating_add(add) <= ASSETS_MAX;
        if fits {
            used += add;
            keep.insert(i);
        }
        fits
    };
    for root in roots {
        // The file first; its signatures only with it.
        if take(root) {
            for &sig in sigs.get(&root).into_iter().flatten() {
                take(sig);
            }
        }
    }
    keep
}

/// The entries of `assets` whose index is in `keep`, in order.
fn select(assets: Vec<ReleaseAsset>, keep: &BTreeSet<usize>) -> Vec<ReleaseAsset> {
    assets
        .into_iter()
        .enumerate()
        .filter(|(i, _)| keep.contains(i))
        .map(|(_, a)| a)
        .collect()
}

/// The assets of `assets` a release keeps within its 4096-byte `assets` field ([`fit_indices`]:
/// checksum files and signatures, then the common platform builds), in the source's order.
pub fn fit_assets(assets: Vec<ReleaseAsset>) -> Vec<ReleaseAsset> {
    let keep = fit_indices(&assets);
    select(assets, &keep)
}

/// The line the importer ends a release's notes with when `omitted` of its `total` assets are
/// not listed: readers (forge-web) show it as "N more assets not mirrored" with the link.
/// The release has no field for it on the current contracts; a release asset manifest does
/// away with the limit (docs/design/release-asset-manifest.md).
fn assets_footer(omitted: usize, total: usize, source_url: &str) -> String {
    let link = if source_url.starts_with("https://") {
        // A `(`, `)` or space would end the markdown link early (and the web's parse of it).
        let url = source_url
            .replace('(', "%28")
            .replace(')', "%29")
            .replace(|c: char| c.is_whitespace(), "%20");
        format!(" Download them from the [source release]({url}).")
    } else {
        String::new()
    };
    format!(
        "\n\n---\n_forge-import: {omitted} of {total} assets are not mirrored here (a release \
         lists at most 4,096 bytes of them).{link}_"
    )
}

/// `notes` with [`assets_footer`] appended, the notes clipped so both fit the 5120-byte
/// field. No footer when nothing was omitted.
pub fn notes_with_footer(notes: &str, omitted: usize, total: usize, source_url: &str) -> String {
    if omitted == 0 {
        return notes.to_string();
    }
    let footer = assets_footer(omitted, total, source_url);
    let room = NOTES_MAX.saturating_sub(footer.len());
    format!("{}{footer}", clip(notes, room, room))
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
    fn items_match_by_repository_and_number_and_renames_only_for_own_copies() {
        let a = "https://github.com/old/name/issues/12";
        assert!(same_item(a, "https://github.com/OLD/Name/issues/12"));
        // Another repository's #12 is not this item (a stranger's squat by number).
        assert!(!same_item(a, "https://github.com/new/renamed/issues/12"));
        assert!(!same_item(a, "https://github.com/attacker/x/issues/12"));
        assert!(!same_item(a, "https://github.com/old/name/issues/13"));
        assert!(!same_item(a, "https://github.com/old/name/pull/12"));
        // The mirror's own copy survives a rename.
        assert!(same_item_renamed(
            a,
            "https://github.com/new/renamed/issues/12"
        ));
        assert!(!same_item_renamed(
            a,
            "https://github.com/new/renamed/issues/13"
        ));
        assert!(same_item_renamed(
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
    fn gitlab_items_match_by_project_path_of_any_depth() {
        let a = "https://gitlab.com/Group/Sub/proj/-/issues/12";
        assert!(same_item(
            a,
            "https://gitlab.com/group/sub/proj/-/issues/12"
        ));
        // GitLab's newer URL for the same issue.
        assert!(same_item(
            a,
            "https://gitlab.com/group/sub/proj/-/work_items/12"
        ));
        assert!(!same_item(
            a,
            "https://gitlab.com/group/sub/proj/-/issues/13"
        ));
        assert!(!same_item(
            a,
            "https://gitlab.com/group/sub/proj/-/merge_requests/12"
        ));
        assert!(!same_item(a, "https://gitlab.com/group/other/-/issues/12"));
        // A self-hosted instance is another repository, even at the same path.
        assert!(!same_item(
            a,
            "https://git.example.org/group/sub/proj/-/issues/12"
        ));
        // Renames keep the item, on the same host only.
        assert!(same_item_renamed(
            a,
            "https://gitlab.com/new/name/-/issues/12"
        ));
        assert!(!same_item_renamed(
            a,
            "https://git.example.org/new/name/-/issues/12"
        ));
        assert!(!same_item_renamed(
            a,
            "https://github.com/group/proj/issues/12"
        ));
        let note = "https://gitlab.com/g/p/-/merge_requests/3#note_99";
        assert!(same_item(
            note,
            "https://gitlab.com/G/P/-/merge_requests/3#note_99"
        ));
        assert!(!same_item(
            note,
            "https://gitlab.com/g/p/-/merge_requests/3#note_98"
        ));
        // Without the `/-/` separator a URL is not a GitLab item (only the exact key matches).
        assert!(!same_item(
            "https://gitlab.com/g/p/issues/1",
            "https://gitlab.com/g/q/issues/1"
        ));
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

    /// dashpay/dash v22.1.3 as GitHub lists it (21 assets, alphabetical). Stored in order, 16
    /// fitted and `SHA256SUMS.asc`, the Linux x86-64 and source tarballs and their signatures
    /// were the ones left out.
    fn dash_22_1_3() -> Vec<ReleaseAsset> {
        let names = [
            "dashcore-22.1.3-aarch64-linux-gnu.tar.gz",
            "dashcore-22.1.3-aarch64-linux-gnu.tar.gz.asc",
            "dashcore-22.1.3-arm64-apple-darwin.tar.gz",
            "dashcore-22.1.3-arm64-apple-darwin.tar.gz.asc",
            "dashcore-22.1.3-arm64-apple-darwin.zip",
            "dashcore-22.1.3-arm64-apple-darwin.zip.asc",
            "dashcore-22.1.3-riscv64-linux-gnu.tar.gz",
            "dashcore-22.1.3-riscv64-linux-gnu.tar.gz.asc",
            "dashcore-22.1.3-win64-setup.exe",
            "dashcore-22.1.3-win64-setup.exe.asc",
            "dashcore-22.1.3-win64.zip",
            "dashcore-22.1.3-win64.zip.asc",
            "dashcore-22.1.3-x86_64-apple-darwin.tar.gz",
            "dashcore-22.1.3-x86_64-apple-darwin.tar.gz.asc",
            "dashcore-22.1.3-x86_64-apple-darwin.zip",
            "dashcore-22.1.3-x86_64-apple-darwin.zip.asc",
            "dashcore-22.1.3-x86_64-linux-gnu.tar.gz",
            "dashcore-22.1.3-x86_64-linux-gnu.tar.gz.asc",
            "dashcore-22.1.3.tar.gz",
            "dashcore-22.1.3.tar.gz.asc",
            "SHA256SUMS.asc",
        ];
        names
            .iter()
            .map(|n| ReleaseAsset {
                name: (*n).to_string(),
                sha256: "0".repeat(64),
                size_bytes: 12_345_678,
                uris: vec![format!(
                    "https://github.com/dashpay/dash/releases/download/v22.1.3/{n}"
                )],
                uri: None,
            })
            .collect()
    }

    #[test]
    fn truncation_keeps_checksums_signatures_and_the_common_builds() {
        let all = dash_22_1_3();
        let kept = fit_assets(all.clone());
        let json = serde_json::to_string(&kept).unwrap();
        assert!(json.len() <= ASSETS_MAX, "{}", json.len());
        assert!(kept.len() < all.len(), "the list must not fit whole");
        let names: Vec<&str> = kept.iter().map(|a| a.name.as_str()).collect();
        for must in [
            "SHA256SUMS.asc",
            "dashcore-22.1.3-x86_64-linux-gnu.tar.gz",
            "dashcore-22.1.3-x86_64-linux-gnu.tar.gz.asc",
            "dashcore-22.1.3-win64-setup.exe",
            "dashcore-22.1.3-win64-setup.exe.asc",
            "dashcore-22.1.3-arm64-apple-darwin.tar.gz",
            "dashcore-22.1.3-arm64-apple-darwin.tar.gz.asc",
            "dashcore-22.1.3-x86_64-apple-darwin.tar.gz",
            "dashcore-22.1.3-aarch64-linux-gnu.tar.gz",
        ] {
            assert!(names.contains(&must), "{must} missing from {names:?}");
        }
        // The riscv build goes first (ranked last); the source's order is kept.
        assert!(!names.contains(&"dashcore-22.1.3-riscv64-linux-gnu.tar.gz"));
        let pos = |n: &str| all.iter().position(|a| a.name == n).unwrap();
        assert!(kept.windows(2).all(|w| pos(&w[0].name) < pos(&w[1].name)));
        // A kept signature always has its file kept.
        for a in &kept {
            if let Some(subject) = signed_subject(&a.name) {
                if all.iter().any(|x| x.name == subject) {
                    assert!(
                        names.contains(&subject),
                        "{} kept without {subject}",
                        a.name
                    );
                }
            }
        }
    }

    #[test]
    fn a_list_that_fits_is_kept_whole_and_in_order() {
        let few: Vec<ReleaseAsset> = dash_22_1_3().into_iter().rev().take(5).collect();
        let names = |v: &[ReleaseAsset]| v.iter().map(|a| a.name.clone()).collect::<Vec<_>>();
        assert_eq!(names(&fit_assets(few.clone())), names(&few));
        assert!(fit_assets(Vec::new()).is_empty());
    }

    #[test]
    fn asset_ranks_follow_the_documented_priority() {
        let order = [
            "SHA256SUMS",
            "checksums.txt",
            "tool-1.0-x86_64-unknown-linux-musl.tar.gz",
            "tool-1.0-x86_64-pc-windows-msvc.zip",
            "tool-1.0-aarch64-apple-darwin.tar.gz",
            "tool-1.0-x86_64-apple-darwin.tar.gz",
            "tool-1.0-aarch64-unknown-linux-gnu.tar.gz",
            "tool-1.0.tar.gz",
            "tool-1.0-riscv64-linux-gnu.tar.gz",
        ];
        let ranks: Vec<u8> = order.iter().map(|n| asset_rank(n)).collect();
        assert!(ranks.windows(2).all(|w| w[0] <= w[1]), "{ranks:?}");
        // Whole tokens only: no platform read into a longer word.
        assert_eq!(asset_rank("darwinia-1.0.tar.gz"), 6, "not macOS");
        assert_eq!(asset_rank("armadillo-1.0.zip"), 6, "not an ARM build");
        assert_eq!(asset_rank("linuxkit-docs.pdf"), 7, "not Linux");
        assert_eq!(asset_rank("tool-x86-64-linux.tar.gz"), 1);
        assert_eq!(asset_rank("SHA256SUMS.asc"), 0);
        assert_eq!(signed_subject("a.tar.gz.asc"), Some("a.tar.gz"));
        assert_eq!(signed_subject("a.tar.gz"), None);
    }

    #[test]
    fn omitted_assets_are_named_in_the_notes_with_the_source_link() {
        let url = "https://github.com/dashpay/dash/releases/tag/v22.1.3";
        assert_eq!(notes_with_footer("n", 0, 3, url), "n");
        let n = notes_with_footer("Release notes", 5, 21, url);
        assert!(n.starts_with("Release notes\n\n---\n"), "{n}");
        assert!(n.contains("5 of 21 assets are not mirrored here"), "{n}");
        assert!(n.contains(&format!("[source release]({url})")), "{n}");
        // Long notes are clipped so the footer always fits the field.
        let long = notes_with_footer(&"x".repeat(NOTES_MAX), 1, 2, url);
        assert!(long.len() <= NOTES_MAX, "{}", long.len());
        assert!(long.ends_with(")._"), "{long}");
        // No https source: no link; a URL with parentheses or spaces stays one link.
        assert!(!notes_with_footer("n", 1, 2, "").contains("source release"));
        let odd = notes_with_footer("n", 1, 2, "https://example.org/r/v1 (final)");
        assert!(
            odd.contains("(https://example.org/r/v1%20%28final%29)"),
            "{odd}"
        );
        // Through `release`: the source URL and the dropped count travel with it.
        let r = release("v22.1.3", None, Some("n"), dash_22_1_3(), url.into());
        assert_eq!(r.dropped, 21 - r.assets.len());
        assert_eq!(r.source_url, url);
    }
}
