//! Link previews: a 1200×630 PNG card per repository (`/og/<owner>/<name>.png`) and a small HTML
//! page carrying `og:` and `twitter:` tags that sends people on to the web app
//! (`/og/<owner>/<name>`). Crawlers read the tags; a person is redirected at once.

use std::fmt::Write as _;
use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use resvg::{tiny_skia, usvg};

use crate::badge::{clip, xml_escape};

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

/// What the preview page names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page {
    /// `owner/name`.
    pub title: String,
    /// The description.
    pub description: String,
    /// The card's URL.
    pub image: String,
    /// The web app page people are sent to.
    pub target: String,
}

/// The HTML preview page: tags for crawlers, an immediate redirect for people.
pub fn page_html(p: &Page) -> String {
    let title = xml_escape(&clip(&p.title, 120));
    let desc = xml_escape(&clip(
        if p.description.is_empty() {
            "A repository on Dash Forge, the git forge on Dash Platform."
        } else {
            &p.description
        },
        300,
    ));
    let image = xml_escape(&p.image);
    let target = xml_escape(&p.target);
    format!(
        r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>{title} · Dash Forge</title>
<meta name="description" content="{desc}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Dash Forge">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{target}">
<meta property="og:image" content="{image}">
<meta property="og:image:width" content="{WIDTH}">
<meta property="og:image:height" content="{HEIGHT}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="{image}">
<link rel="canonical" href="{target}">
<meta http-equiv="refresh" content="0; url={target}">
</head><body><p><a href="{target}">{title} on Dash Forge</a></p></body></html>
"#
    )
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
            target: "https://w/a/b".into(),
        });
        assert!(!html.contains("<script>"));
        assert!(html.contains("og:image\" content=\"https://g/og/a/b.png\""));
        assert!(html.contains("url=https://w/a/b"));
    }

    #[test]
    fn owners_are_shortened() {
        assert_eq!(short_owner("alice"), "alice");
        assert_eq!(short_owner("G6D3ejKx1234567890abcdefXYZ9"), "G6D3ej…XYZ9");
    }
}
