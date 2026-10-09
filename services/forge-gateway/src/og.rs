//! Link previews. A share link is the web app's short URL on the gateway under `/og`
//! (`/og/<owner>/<name>/issues/7` for `https://forge.dashhq.org/<owner>/<name>/issues/7`): a
//! small HTML page carrying `og:` and `twitter:` tags that sends people on to the web app. The
//! web app itself is static, and a static host answers its short URLs with a 404 page, so
//! unfurlers (Slack, Discord, forums) never see a card there (#454). Crawlers read the tags; a
//! person's browser is sent on at once. The cards are 1200×630 PNGs: one per repository
//! (`/og/<owner>/<name>.png`) and one per public issue or pull request
//! (`/og/<owner>/<name>/issues/7.png`).
//!
//! Public data only: a card shows what Platform shows an anonymous reader, and nothing of a
//! members-only or hidden issue or pull request, or of a private repository.

use std::fmt::Write as _;
use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use resvg::{tiny_skia, usvg};

use crate::badge::{clip, xml_escape};
use crate::upstream::{Item, ItemKind, ItemState};

/// The card's size (the size every major unfurler crops to).
pub const WIDTH: u32 = 1200;
/// The card's height.
pub const HEIGHT: u32 = 630;

/// The fonts the cards are drawn with: the system's, plus `extra`.
pub fn fonts(extra: Option<&Path>) -> Arc<usvg::fontdb::Database> {
    let mut db = usvg::fontdb::Database::new();
    db.load_system_fonts();
    if let Some(dir) = extra {
        db.load_fonts_dir(dir);
    }
    if db.is_empty() {
        tracing::warn!("no fonts found: link-preview images will have no text (install fonts-dejavu-core or set GATEWAY_FONT_DIR)");
    }
    Arc::new(db)
}

/// What a card shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Card {
    /// The owner as the link named it (a DPNS name or an id, shortened).
    pub owner: String,
    /// The repository's name.
    pub name: String,
    /// Its description.
    pub description: String,
    /// Its star count, when it could be read.
    pub stars: Option<u64>,
    /// Its default branch.
    pub default_branch: Option<String>,
    /// The site the card names (`forge.dashhq.org`).
    pub site: String,
}

/// An owner id shortened for display (`G6D3ej…k9`); a DPNS name as is.
pub fn short_owner(owner: &str) -> String {
    if owner.len() > 20 {
        format!("{}…{}", &owner[..6], &owner[owner.len() - 4..])
    } else {
        owner.to_string()
    }
}

/// Greedy word wrap into at most `lines` lines of `width` characters.
fn wrap(s: &str, width: usize, lines: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    for word in s.split_whitespace() {
        let word = clip(word, width);
        if !cur.is_empty() && cur.chars().count() + 1 + word.chars().count() > width {
            out.push(std::mem::take(&mut cur));
            if out.len() == lines {
                break;
            }
        }
        if !cur.is_empty() {
            cur.push(' ');
        }
        cur.push_str(&word);
    }
    if out.len() < lines && !cur.is_empty() {
        out.push(cur);
    } else if out.len() == lines {
        if let Some(last) = out.last_mut() {
            *last = clip(&format!("{last} …"), width);
        }
    }
    out
}

/// The card as SVG.
pub fn card_svg(c: &Card) -> String {
    const FONT: &str = "DejaVu Sans, Helvetica, Arial, sans-serif";
    let owner = xml_escape(&clip(&c.owner, 40));
    let name = xml_escape(&clip(&c.name, 32));
    let mut desc = String::new();
    for (i, line) in wrap(&c.description, 56, 3).iter().enumerate() {
        let y = 380 + i * 44;
        let _ = write!(
            desc,
            r##"<text x="80" y="{y}" font-family="{FONT}" font-size="32" fill="#cbd5e1">{}</text>"##,
            xml_escape(line)
        );
    }
    let mut facts = Vec::new();
    if let Some(s) = c.stars {
        facts.push(format!("★ {s} {}", if s == 1 { "star" } else { "stars" }));
    }
    if let Some(b) = &c.default_branch {
        facts.push(format!("default branch {}", clip(b, 30)));
    }
    let facts = xml_escape(&facts.join("   ·   "));
    let site = xml_escape(&clip(&c.site, 48));
    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}" viewBox="0 0 {WIDTH} {HEIGHT}"><rect width="{WIDTH}" height="{HEIGHT}" fill="#0f172a"/><rect width="{WIDTH}" height="10" fill="#008de4"/><text x="80" y="110" font-family="{FONT}" font-size="34" font-weight="bold" fill="#38bdf8">Dash Forge</text><text x="80" y="215" font-family="{FONT}" font-size="44" fill="#94a3b8">{owner} /</text><text x="80" y="300" font-family="{FONT}" font-size="76" font-weight="bold" fill="#f8fafc">{name}</text>{desc}<text x="80" y="570" font-family="{FONT}" font-size="30" fill="#e2e8f0">{facts}</text><text x="1120" y="570" text-anchor="end" font-family="{FONT}" font-size="26" fill="#64748b">{site}</text></svg>"##
    )
}

/// `svg` drawn as a PNG.
pub fn render_png(svg: &str, fonts: Arc<usvg::fontdb::Database>) -> Result<Vec<u8>> {
    let opt = usvg::Options {
        fontdb: fonts,
        ..usvg::Options::default()
    };
    let tree = usvg::Tree::from_str(svg, &opt)?;
    let mut pixmap =
        tiny_skia::Pixmap::new(WIDTH, HEIGHT).ok_or_else(|| anyhow!("cannot allocate the card"))?;
    resvg::render(
        &tree,
        tiny_skia::Transform::identity(),
        &mut pixmap.as_mut(),
    );
    Ok(pixmap.encode_png()?)
}

/// An issue or pull request card: [`card_svg`]'s layout with the item's title in place of the
/// repository's name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemCard {
    /// `owner / name`, the owner as the link named it (shortened).
    pub repo: String,
    /// Issue or pull request.
    pub kind: ItemKind,
    /// Its number.
    pub number: u32,
    /// Its title, body and state.
    pub item: Item,
    /// The site the card names (`forge.dashhq.org`).
    pub site: String,
}

/// "Issue #7" / "Pull request #7".
pub fn item_label(kind: ItemKind, number: u32) -> String {
    match kind {
        ItemKind::Issue => format!("Issue #{number}"),
        ItemKind::Pull => format!("Pull request #{number}"),
    }
}

/// A body as one line of plain text for a card: whitespace collapsed, HTML comments (the
/// templates' hints) dropped, at most `max` characters.
pub fn excerpt(body: &str, max: usize) -> String {
    let mut text = String::new();
    let mut rest = body;
    while let Some(at) = rest.find("<!--") {
        text.push_str(&rest[..at]);
        text.push(' ');
        rest = rest[at..]
            .find("-->")
            .map_or("", |end| &rest[at + end + 3..]);
    }
    text.push_str(rest);
    clip(&text.split_whitespace().collect::<Vec<_>>().join(" "), max)
}

/// The item card as SVG.
pub fn item_svg(c: &ItemCard) -> String {
    const FONT: &str = "DejaVu Sans, Helvetica, Arial, sans-serif";
    let repo = xml_escape(&clip(&c.repo, 48));
    let mut lines = String::new();
    let title = wrap(&c.item.title, 30, 2);
    for (i, line) in title.iter().enumerate() {
        let y = 270 + i * 72;
        let _ = write!(
            lines,
            r##"<text x="80" y="{y}" font-family="{FONT}" font-size="56" font-weight="bold" fill="#f8fafc">{}</text>"##,
            xml_escape(line)
        );
    }
    let body_top = 270 + title.len().max(1) * 72 + 10;
    for (i, line) in wrap(&excerpt(&c.item.body, 400), 56, 2).iter().enumerate() {
        let y = body_top + i * 42;
        let _ = write!(
            lines,
            r##"<text x="80" y="{y}" font-family="{FONT}" font-size="30" fill="#cbd5e1">{}</text>"##,
            xml_escape(line)
        );
    }
    let (state, color) = match c.item.state {
        ItemState::Open => ("Open", "#4ade80"),
        ItemState::Draft => ("Draft", "#94a3b8"),
        ItemState::Closed => ("Closed", "#f87171"),
        ItemState::Merged => ("Merged", "#c084fc"),
    };
    let label = xml_escape(&item_label(c.kind, c.number));
    let site = xml_escape(&clip(&c.site, 48));
    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}" viewBox="0 0 {WIDTH} {HEIGHT}"><rect width="{WIDTH}" height="{HEIGHT}" fill="#0f172a"/><rect width="{WIDTH}" height="10" fill="#008de4"/><text x="80" y="110" font-family="{FONT}" font-size="34" font-weight="bold" fill="#38bdf8">Dash Forge</text><text x="80" y="180" font-family="{FONT}" font-size="36" fill="#94a3b8">{repo}</text>{lines}<text x="80" y="570" font-family="{FONT}" font-size="30" fill="#e2e8f0"><tspan font-weight="bold" fill="{color}">● {state}</tspan>   ·   {label}</text><text x="1120" y="570" text-anchor="end" font-family="{FONT}" font-size="26" fill="#64748b">{site}</text></svg>"##
    )
}

/// The site-wide description, as the web app's own pages give it.
pub const SITE_DESCRIPTION: &str =
    "Git hosting with no server, on Dash Platform. Your browser verifies every branch and file it shows.";

/// What a share page names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page {
    /// `og:title`.
    pub title: String,
    /// `og:description` (never empty).
    pub description: String,
    /// The card image's URL.
    pub image: String,
    /// This page's own URL: `og:url`. Facebook's crawler treats `og:url` as the canonical
    /// address and re-reads the page there (Meta, "Specify a Canonical URL"), so it must be the
    /// card page itself: the web app's short URL is a static host's 404 page.
    pub url: String,
    /// The web app page people are sent to.
    pub target: String,
}

impl Page {
    /// The site's own card, naming nothing a link does not: for a repository that is private,
    /// absent or not served here, and while Platform cannot be read.
    pub fn site(web_base: &str, url: String, target: String) -> Self {
        Self {
            title: "Dash Forge".into(),
            description: SITE_DESCRIPTION.into(),
            image: format!("{web_base}/og.png"),
            url,
            target,
        }
    }

    /// A public repository's card (`repo` is `owner/name`).
    pub fn repo(repo: &str, description: &str, image: String, url: String, target: String) -> Self {
        Self {
            title: repo.to_string(),
            description: if description.trim().is_empty() {
                format!("{repo}: a repository on Dash Forge, the git forge on Dash Platform.")
            } else {
                description.to_string()
            },
            image,
            url,
            target,
        }
    }

    /// An issue's or pull request's card. Without `item` (members-only, hidden, absent, or
    /// unreadable) it says only what the link does: which repository, which kind and number;
    /// `image` is then the repository's card.
    pub fn item(
        repo: &str,
        kind: ItemKind,
        number: u32,
        item: Option<&Item>,
        image: String,
        url: String,
        target: String,
    ) -> Self {
        let label = item_label(kind, number);
        let (title, description) = match item {
            Some(i) => (
                format!("{} · {label} · {repo}", i.title),
                Some(excerpt(&i.body, 300)).filter(|d| !d.is_empty()),
            ),
            None => (format!("{label} · {repo}"), None),
        };
        Self {
            title,
            description: description.unwrap_or_else(|| {
                let noun = match kind {
                    ItemKind::Issue => "An issue",
                    ItemKind::Pull => "A pull request",
                };
                format!("{noun} in {repo} on Dash Forge, the git forge on Dash Platform.")
            }),
            image,
            url,
            target,
        }
    }
}

/// The share page: tags for crawlers, and a script that sends people on to the web app (with a
/// link for when scripts are off). There is deliberately no `<meta http-equiv="refresh">`:
/// Facebook's crawler follows one like a redirect and would read the web app's page instead.
/// Crawlers and people get the same bytes, so a cache in front never mixes two variants.
pub fn page_html(p: &Page) -> String {
    let title = xml_escape(&clip(&p.title, 160));
    let desc = xml_escape(&clip(&p.description, 300));
    let image = xml_escape(&p.image);
    let url = xml_escape(&p.url);
    let target = xml_escape(&p.target);
    let head_title = if p.title == "Dash Forge" {
        title.clone()
    } else {
        format!("{title} · Dash Forge")
    };
    format!(
        r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{head_title}</title>
<meta name="description" content="{desc}">
<meta name="robots" content="noindex">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Dash Forge">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{image}">
<meta property="og:image:width" content="{WIDTH}">
<meta property="og:image:height" content="{HEIGHT}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="{image}">
<link rel="canonical" href="{target}">
</head><body style="font-family:sans-serif;margin:2rem">
<p><a id="forge-target" href="{target}">Open {title} on Dash Forge</a></p>
<script>location.replace(document.getElementById("forge-target").href)</script>
</body></html>
"#
    )
}

/// What a share link's path after `/og/<owner>/<name>/` names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Share {
    /// A view of the repository (`tree/main/src`, `releases`, …): the repository's card.
    Repo,
    /// An issue's or pull request's page (`issues/7`, `pull/7`, `pull/7/files`).
    Item(ItemKind, u32),
    /// An issue's or pull request's card image (`issues/7.png`, `pull/7.png`).
    ItemImage(ItemKind, u32),
}

/// The longest share path after the repository, and the most segments in it.
const MAX_REST_BYTES: usize = 1024;
const MAX_REST_SEGMENTS: usize = 32;

/// One raw (still percent-encoded) path segment a web short URL can hold: RFC 3986 `pchar`s
/// with every `%` starting a valid escape, never `.` or `..`.
fn rest_segment_ok(s: &str) -> bool {
    if s.is_empty() || s == "." || s == ".." {
        return false;
    }
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if b[i + 1..]
                .iter()
                .take(2)
                .filter(|c| c.is_ascii_hexdigit())
                .count()
                == 2 =>
            {
                i += 3;
            }
            c if c.is_ascii_alphanumeric() || b"-._~!$&'()*+,;=:@".contains(&c) => i += 1,
            _ => return false,
        }
    }
    true
}

/// An item number as a short URL writes it (`7`, `007`): 1 or more, at most 10 digits.
fn item_number(s: &str) -> Option<u32> {
    if s.is_empty() || s.len() > 10 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok().filter(|n| *n > 0)
}

/// What `rest`, the raw path after `/og/<owner>/<name>/` (empty for the repository itself),
/// names; `None` when it is not a path a web short URL can have.
pub fn parse_share(rest: &str) -> Option<Share> {
    if rest.is_empty() {
        return Some(Share::Repo);
    }
    let segs: Vec<&str> = rest.split('/').collect();
    if rest.len() > MAX_REST_BYTES
        || segs.len() > MAX_REST_SEGMENTS
        || !segs.iter().all(|s| rest_segment_ok(s))
    {
        return None;
    }
    let kind = match segs[0] {
        "issues" => ItemKind::Issue,
        "pull" => ItemKind::Pull,
        _ => return Some(Share::Repo),
    };
    Some(match segs[1..] {
        [n] => match n.strip_suffix(".png").map(item_number) {
            Some(Some(n)) => Share::ItemImage(kind, n),
            Some(None) => Share::Repo,
            None => item_number(n).map_or(Share::Repo, |n| Share::Item(kind, n)),
        },
        [n, "files" | "commits" | "checks"] if kind == ItemKind::Pull => {
            item_number(n).map_or(Share::Repo, |n| Share::Item(kind, n))
        }
        _ => Share::Repo,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card() -> Card {
        Card {
            owner: "alice".into(),
            name: "project".into(),
            description: "A <tiny> project & more words than fit on a single line of the card, so it wraps onto a second line".into(),
            stars: Some(3),
            default_branch: Some("main".into()),
            site: "forge.dashhq.org".into(),
        }
    }

    #[test]
    fn the_card_escapes_and_wraps() {
        let svg = card_svg(&card());
        assert!(svg.contains("A &lt;tiny&gt; project &amp; more"));
        assert_eq!(
            svg.matches("font-size=\"32\"").count(),
            2,
            "two description lines"
        );
        assert!(svg.contains("★ 3 stars"));
    }

    #[test]
    fn the_card_renders_to_a_png() {
        let png = render_png(&card_svg(&card()), fonts(None)).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert!(png.len() > 1000);
    }

    #[test]
    fn wrap_caps_the_lines() {
        let w = wrap(&"word ".repeat(100), 20, 3);
        assert_eq!(w.len(), 3);
        assert!(w[2].ends_with('…'));
        assert!(wrap("", 20, 3).is_empty());
    }

    #[test]
    fn the_page_escapes_its_values() {
        let html = page_html(&Page {
            title: "a/b".into(),
            description: "\"><script>alert(1)</script>".into(),
            image: "https://g/og/a/b.png".into(),
            url: "https://g/og/a/b".into(),
            target: "https://w/a/b?repo=x&y".into(),
        });
        assert!(!html.contains("<script>alert"));
        assert!(html.contains("&quot;&gt;&lt;script&gt;alert(1)"));
        assert!(html.contains("og:image\" content=\"https://g/og/a/b.png\""));
        // og:url is the share page itself (Facebook re-reads the page og:url names).
        assert!(html.contains("og:url\" content=\"https://g/og/a/b\""));
        assert!(html.contains("<link rel=\"canonical\" href=\"https://w/a/b?repo=x&amp;y\">"));
        assert!(html.contains("href=\"https://w/a/b?repo=x&amp;y\">Open a/b on Dash Forge</a>"));
        // People are sent on by script, never by a refresh a crawler would follow.
        assert!(html.contains("location.replace(document.getElementById(\"forge-target\").href)"));
        assert!(!html.contains("http-equiv"));
    }

    fn item(title: &str, body: &str, state: ItemState) -> Item {
        Item {
            title: title.into(),
            body: body.into(),
            state,
        }
    }

    #[test]
    fn item_pages_say_only_what_they_may() {
        let i = item(
            "It <breaks>",
            "Steps:\n\n1. run   it <!-- template hint -->\n2. boom",
            ItemState::Open,
        );
        let p = Page::item(
            "alice/proj",
            ItemKind::Issue,
            7,
            Some(&i),
            "img".into(),
            "u".into(),
            "t".into(),
        );
        assert_eq!(p.title, "It <breaks> · Issue #7 · alice/proj");
        assert_eq!(p.description, "Steps: 1. run it 2. boom");
        // Members-only, hidden or absent: the link's own words, nothing of the item.
        let p = Page::item(
            "alice/proj",
            ItemKind::Pull,
            3,
            None,
            "img".into(),
            "u".into(),
            "t".into(),
        );
        assert_eq!(p.title, "Pull request #3 · alice/proj");
        assert_eq!(
            p.description,
            "A pull request in alice/proj on Dash Forge, the git forge on Dash Platform."
        );
        // A public item with no body.
        let p = Page::item(
            "alice/proj",
            ItemKind::Issue,
            1,
            Some(&item("t", " ", ItemState::Closed)),
            "i".into(),
            "u".into(),
            "t".into(),
        );
        assert_eq!(
            p.description,
            "An issue in alice/proj on Dash Forge, the git forge on Dash Platform."
        );
        let p = Page::site("https://w", "u".into(), "t".into());
        assert_eq!(
            (p.title.as_str(), p.image.as_str()),
            ("Dash Forge", "https://w/og.png")
        );
        assert!(page_html(&p).contains("<title>Dash Forge</title>"));
        let p = Page::repo("alice/proj", "", "i".into(), "u".into(), "t".into());
        assert!(p
            .description
            .starts_with("alice/proj: a repository on Dash Forge"));
    }

    #[test]
    fn excerpts_are_one_clipped_line() {
        assert_eq!(excerpt("a\n\n  b\tc", 100), "a b c");
        assert_eq!(excerpt("x <!-- unterminated", 100), "x");
        assert_eq!(excerpt("<!--a-->b<!--c-->d", 100), "b d");
        assert_eq!(excerpt(&"w ".repeat(400), 10).chars().count(), 10);
    }

    #[test]
    fn the_item_card_renders() {
        let c = ItemCard {
            repo: "alice / proj".into(),
            kind: ItemKind::Pull,
            number: 12,
            item: item(
                "Make the <parser> faster & smaller than it was before today",
                "Body",
                ItemState::Merged,
            ),
            site: "forge.dashhq.org".into(),
        };
        let svg = item_svg(&c);
        assert!(svg.contains("Make the &lt;parser&gt; faster &amp;"));
        assert_eq!(
            svg.matches("font-size=\"56\"").count(),
            2,
            "the title wraps onto two lines"
        );
        assert!(svg.contains("● Merged") && svg.contains("Pull request #12"));
        let png = render_png(&svg, fonts(None)).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    }

    #[test]
    fn share_paths_mirror_the_web_short_urls() {
        use ItemKind::{Issue, Pull};
        assert_eq!(parse_share(""), Some(Share::Repo));
        assert_eq!(parse_share("issues/7"), Some(Share::Item(Issue, 7)));
        assert_eq!(parse_share("issues/007"), Some(Share::Item(Issue, 7)));
        assert_eq!(parse_share("pull/3"), Some(Share::Item(Pull, 3)));
        assert_eq!(parse_share("pull/3/files"), Some(Share::Item(Pull, 3)));
        assert_eq!(
            parse_share("issues/7.png"),
            Some(Share::ItemImage(Issue, 7))
        );
        assert_eq!(parse_share("pull/3.png"), Some(Share::ItemImage(Pull, 3)));
        // Other views are the repository's card.
        for rest in [
            "issues",
            "issues/new",
            "issues/0",
            "issues/7/files",
            "pull/3/bogus",
            "pulls",
            "tree/feature%2Fx/src/a.rs",
            "blob/main/docs/x.png",
            "compare/main...feature",
            "releases/tag/v1.0.0",
            "commit/0123abcd",
        ] {
            assert_eq!(parse_share(rest), Some(Share::Repo), "{rest}");
        }
        // Not a path a short URL can have.
        for rest in [
            "issues/", "a//b", "../x", "tree/./x", "a%2", "a%zz", "a b", "a\"b", "a<b", "%",
        ] {
            assert_eq!(parse_share(rest), None, "{rest}");
        }
        assert_eq!(
            parse_share(&("a/".repeat(40) + "a")),
            None,
            "too many segments"
        );
        assert_eq!(parse_share(&"a".repeat(2000)), None, "too long");
    }

    #[test]
    fn owners_are_shortened() {
        assert_eq!(short_owner("alice"), "alice");
        assert_eq!(short_owner("G6D3ejKx1234567890abcdefXYZ9"), "G6D3ej…XYZ9");
    }
}
