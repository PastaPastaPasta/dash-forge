//! README badges: a flat SVG, and shields.io's `endpoint` JSON
//! (<https://shields.io/badges/endpoint-badge>) for people who style badges through shields.
//! Display only: each badge's link (the README's) goes to the web page that proves it.

use serde_json::json;

use crate::upstream::Check;

/// The badges a repository has.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Its star count.
    Stars,
    /// The CI status of a branch's tip.
    Ci,
    /// The latest release's tag.
    Release,
    /// Open issues.
    Issues,
}

impl Kind {
    /// `stars`, `ci`, `release`, `issues`.
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "stars" => Self::Stars,
            "ci" | "checks" => Self::Ci,
            "release" => Self::Release,
            "issues" => Self::Issues,
            _ => return None,
        })
    }
}

/// A badge's content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Badge {
    /// The left side.
    pub label: String,
    /// The right side.
    pub message: String,
    /// A shields colour name (`brightgreen`, `red`, …).
    pub color: &'static str,
}

impl Badge {
    /// A badge.
    pub fn new(label: impl Into<String>, message: impl Into<String>, color: &'static str) -> Self {
        Self {
            label: label.into(),
            message: message.into(),
            color,
        }
    }

    /// The badge shown when Platform cannot be read and nothing is cached.
    pub fn unavailable(label: &str) -> Self {
        Self::new(label, "unavailable", "lightgrey")
    }
}

/// The CI badge of a commit's checks: the newest **trusted** run per name decides (a run by a
/// current maintainer, writer or runner), as the web's Checks tab reads it.
pub fn ci(checks: &[Check]) -> Badge {
    let trusted: Vec<&Check> = checks.iter().filter(|c| c.trusted).collect();
    if trusted.is_empty() {
        return Badge::new("checks", "none", "lightgrey");
    }
    let failed = trusted.iter().any(|c| {
        c.status == "completed"
            && !matches!(c.conclusion.as_str(), "success" | "neutral" | "skipped")
    });
    if failed {
        return Badge::new("checks", "failing", "red");
    }
    if trusted.iter().any(|c| c.status != "completed") {
        return Badge::new("checks", "pending", "yellow");
    }
    Badge::new("checks", "passing", "brightgreen")
}

fn hex(color: &str) -> &'static str {
    match color {
        "brightgreen" => "#4c1",
        "green" => "#97ca00",
        "yellow" => "#dfb317",
        "orange" => "#fe7d37",
        "red" => "#e05d44",
        "blue" => "#007ec6",
        _ => "#9f9f9f",
    }
}

/// Approximate Verdana 11px advance widths: close enough to size a badge.
fn text_width(s: &str) -> f64 {
    s.chars()
        .map(|c| match c {
            'i' | 'j' | 'l' | '|' | '!' | '.' | ',' | ':' | ';' | '\'' => 3.1,
            'f' | 'I' | 't' | 'r' | '(' | ')' | '[' | ']' | '{' | '}' | '/' | '-' => 4.6,
            ' ' => 3.9,
            'm' => 10.7,
            'w' => 9.0,
            'M' | 'W' => 11.0,
            '0'..='9' => 7.0,
            'A'..='Z' => 7.6,
            'a'..='z' => 6.6,
            _ => 7.5,
        })
        .sum()
}

/// `s` safe inside XML text and attributes.
pub fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// At most `max` characters, with an ellipsis when cut.
pub fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(max.saturating_sub(1)).collect();
        t.push('…');
        t
    }
}

/// The flat SVG.
pub fn svg(b: &Badge) -> String {
    let label = xml_escape(&clip(&b.label, 40));
    let message = xml_escape(&clip(&b.message, 40));
    let lw = (text_width(&clip(&b.label, 40)) + 10.0).round();
    let mw = (text_width(&clip(&b.message, 40)) + 10.0).round();
    let w = lw + mw;
    let color = hex(b.color);
    let (lx, mx) = (lw / 2.0, lw + mw / 2.0);
    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="20" role="img" aria-label="{label}: {message}"><title>{label}: {message}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="{w}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="{lw}" height="20" fill="#555"/><rect x="{lw}" width="{mw}" height="20" fill="{color}"/><rect width="{w}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="{lx}" y="15" fill="#010101" fill-opacity=".3">{label}</text><text x="{lx}" y="14">{label}</text><text x="{mx}" y="15" fill="#010101" fill-opacity=".3">{message}</text><text x="{mx}" y="14">{message}</text></g></svg>"##
    )
}

/// shields' endpoint JSON.
pub fn endpoint_json(b: &Badge, cache_seconds: u64) -> String {
    json!({
        "schemaVersion": 1,
        "label": clip(&b.label, 40),
        "message": clip(&b.message, 40),
        "color": b.color,
        "cacheSeconds": cache_seconds.max(300),
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(status: &str, conclusion: &str, trusted: bool) -> Check {
        Check {
            name: "build".into(),
            status: status.into(),
            conclusion: conclusion.into(),
            trusted,
        }
    }

    #[test]
    fn ci_reads_only_trusted_runs() {
        assert_eq!(ci(&[]).message, "none");
        assert_eq!(ci(&[check("completed", "failure", false)]).message, "none");
        assert_eq!(
            ci(&[check("completed", "success", true)]).message,
            "passing"
        );
        assert_eq!(
            ci(&[
                check("completed", "success", true),
                check("in_progress", "", true)
            ])
            .message,
            "pending"
        );
        assert_eq!(
            ci(&[
                check("completed", "skipped", true),
                check("completed", "timed_out", true)
            ])
            .color,
            "red"
        );
    }

    #[test]
    fn svg_escapes_and_sizes() {
        let b = Badge::new("release", "<v1&\"x\">", "blue");
        let s = svg(&b);
        assert!(s.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\""));
        assert!(s.contains("&lt;v1&amp;&quot;x&quot;&gt;"));
        assert!(!s.contains("<v1"));
        assert!(s.contains("#007ec6"));
    }

    #[test]
    fn endpoint_json_has_shields_fields() {
        let v: serde_json::Value =
            serde_json::from_str(&endpoint_json(&Badge::new("stars", "3", "blue"), 60)).unwrap();
        assert_eq!(v["schemaVersion"], 1);
        assert_eq!(v["message"], "3");
        assert_eq!(v["cacheSeconds"], 300, "shields' minimum");
    }

    #[test]
    fn clip_cuts_with_an_ellipsis() {
        assert_eq!(clip("abc", 3), "abc");
        assert_eq!(clip("abcdef", 4), "abc…");
    }
}
