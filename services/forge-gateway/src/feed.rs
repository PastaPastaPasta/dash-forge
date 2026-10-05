//! Atom feeds (RFC 4287) of a repository's releases, commits and issues. Every entry links to
//! the web page that shows it with proofs.

use crate::badge::xml_escape;
use std::fmt::Write as _;

/// One feed entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// A stable id (a `tag:` or `urn:` IRI).
    pub id: String,
    /// The title.
    pub title: String,
    /// The web page.
    pub link: String,
    /// When it happened (ms since the Unix epoch).
    pub updated_ms: u64,
    /// Who did it.
    pub author: Option<String>,
    /// Plain-text content.
    pub content: Option<String>,
}

/// A feed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Feed {
    /// The feed's id.
    pub id: String,
    /// Its title.
    pub title: String,
    /// The feed's own URL.
    pub self_url: String,
    /// The web page it follows.
    pub link: String,
    /// Its entries, newest first.
    pub entries: Vec<Entry>,
}

/// `ms` as an RFC 3339 UTC timestamp.
pub fn rfc3339(ms: u64) -> String {
    let secs = ms / 1000;
    let days = i64::try_from(secs / 86_400).unwrap_or(0);
    let rem = secs % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

impl Feed {
    /// The Atom XML.
    pub fn render(&self) -> String {
        let updated = self.entries.iter().map(|e| e.updated_ms).max().unwrap_or(0);
        let mut out = String::from("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n");
        out.push_str("<feed xmlns=\"http://www.w3.org/2005/Atom\">\n");
        let _ = writeln!(out, "  <id>{}</id>", xml_escape(&self.id));
        let _ = writeln!(out, "  <title>{}</title>", xml_escape(&self.title));
        let _ = writeln!(out, "  <updated>{}</updated>", rfc3339(updated));
        let _ = writeln!(
            out,
            "  <link rel=\"self\" type=\"application/atom+xml\" href=\"{}\"/>",
            xml_escape(&self.self_url)
        );
        let _ = writeln!(
            out,
            "  <link rel=\"alternate\" type=\"text/html\" href=\"{}\"/>",
            xml_escape(&self.link)
        );
        out.push_str("  <generator>forge-gateway</generator>\n");
        for e in &self.entries {
            out.push_str("  <entry>\n");
            let _ = writeln!(out, "    <id>{}</id>", xml_escape(&e.id));
            let _ = writeln!(out, "    <title>{}</title>", xml_escape(&e.title));
            let _ = writeln!(
                out,
                "    <link rel=\"alternate\" type=\"text/html\" href=\"{}\"/>",
                xml_escape(&e.link)
            );
            let _ = writeln!(out, "    <updated>{}</updated>", rfc3339(e.updated_ms));
            let author = e.author.as_deref().unwrap_or("unknown");
            let _ = writeln!(
                out,
                "    <author><name>{}</name></author>",
                xml_escape(author)
            );
            if let Some(c) = &e.content {
                let _ = writeln!(
                    out,
                    "    <content type=\"text\">{}</content>",
                    xml_escape(c)
                );
            }
            out.push_str("  </entry>\n");
        }
        out.push_str("</feed>\n");
        out
    }
}

/// The separator `git log` is asked to put between records.
pub const LOG_FORMAT: &str = "--format=%H%x00%an%x00%ct%x00%s%x1e";

/// A commit as [`LOG_FORMAT`] prints it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogCommit {
    /// The commit id.
    pub oid: String,
    /// The author's name (never the e-mail).
    pub author: String,
    /// Commit time (s).
    pub time: u64,
    /// The subject line.
    pub subject: String,
}

/// Parse `git log` output in [`LOG_FORMAT`].
pub fn parse_log(out: &str) -> Vec<LogCommit> {
    out.split('\x1e')
        .filter_map(|rec| {
            let mut f = rec.trim_start_matches('\n').split('\0');
            let oid = f.next()?.to_string();
            if oid.len() < 40 || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            Some(LogCommit {
                oid,
                author: f.next()?.to_string(),
                time: f.next()?.trim().parse().ok()?,
                subject: f.next().unwrap_or_default().to_string(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_are_rfc3339() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(951_782_400_000), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339(1_791_072_000_123), "2026-10-04T00:00:00Z");
    }

    #[test]
    fn feeds_escape_their_text() {
        let f = Feed {
            id: "tag:x,2026:a".into(),
            title: "a <b> & c".into(),
            self_url: "https://g/feed?a=1&b=2".into(),
            link: "https://w/a".into(),
            entries: vec![Entry {
                id: "urn:sha1:00".into(),
                title: "</title><script>".into(),
                link: "https://w/a/commit/00".into(),
                updated_ms: 1000,
                author: Some("Ann".into()),
                content: Some("x\u{0}y\nz".into()),
            }],
        };
        let xml = f.render();
        assert!(xml.contains("<title>a &lt;b&gt; &amp; c</title>"));
        assert!(xml.contains("href=\"https://g/feed?a=1&amp;b=2\""));
        assert!(xml.contains("&lt;/title&gt;&lt;script&gt;"));
        assert!(
            xml.contains("<content type=\"text\">xy\nz</content>"),
            "forbidden control characters dropped, line breaks kept"
        );
        assert!(xml.contains("<updated>1970-01-01T00:00:01Z</updated>"));
    }

    #[test]
    fn git_log_parses() {
        let a = "a".repeat(40);
        let out = format!(
            "{a}\0Ann\x001700000000\0first line\x1e\n{}\0Bob\x001700000001\0\x1e\n",
            "b".repeat(40)
        );
        let log = parse_log(&out);
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].author, "Ann");
        assert_eq!(log[0].time, 1_700_000_000);
        assert_eq!(log[1].subject, "");
    }
}
