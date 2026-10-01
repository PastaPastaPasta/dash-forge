//! A mirrored review comment's diff hunk (RC2 rider QW2-010, `comment.diffHunk`): the tail of
//! the source's hunk that ends at the commented line, re-headed so both sides stay numbered.
//!
//! GitHub's `diff_hunk` runs from the top of its hunk down to the commented line: a mean of
//! 6.3 kB on dashpay/dips, at most 76 kB, and 401 of 939 over the contract's 5,120-byte field
//! cap. The contract keeps at most 1,024 bytes (`build.py` `review_hunk`), and a comment pays
//! about 27 k credits per stored byte, so [`trim`] keeps what a reader needs to see the line in
//! place: the commented range (at most [`MAX_LINES`] lines) or the last [`CONTEXT`] lines, each
//! cut at [`LINE_CAP`] characters, trimmed from the top to fit [`BUDGET`] bytes. On dips that is
//! a mean of 292 bytes.
//!
//! The header is recomputed (`@@ -o,a +n,b @@`) for the lines kept, so a reader numbers them
//! as in the source.

/// Lines of context kept above a single-line comment.
pub const CONTEXT: usize = 4;
/// The most lines kept (a longer commented range keeps its last lines).
pub const MAX_LINES: usize = 12;
/// Characters kept of each line (a longer one ends in `…`).
pub const LINE_CAP: usize = 160;
/// The importer's byte budget for a hunk (the contract allows 1,024: an importer setting).
pub const BUDGET: usize = 640;
/// The contract's `comment.diffHunk` cap (`maxBytes`).
pub const CONTRACT_MAX: usize = 1024;

/// One parsed hunk header: the first old and new line numbers.
fn header(line: &str) -> Option<(u64, u64)> {
    let rest = line.strip_prefix("@@ -")?;
    let (old, rest) = rest.split_once(" +")?;
    let (new, _) = rest.split_once(" @@")?;
    let start = |s: &str| s.split(',').next()?.parse::<u64>().ok();
    Some((start(old)?, start(new)?))
}

/// Whether a hunk body line counts on the old side (`-` or context) and the new side (`+` or
/// context). A `\ No newline at end of file` marker counts on neither.
fn sides(line: &str) -> (bool, bool) {
    match line.as_bytes().first() {
        Some(b'-') => (true, false),
        Some(b'+') => (false, true),
        Some(b'\\') => (false, false),
        _ => (true, true),
    }
}

/// `line` cut at [`LINE_CAP`] characters (its `+`/`-`/` ` marker included).
fn cap(line: &str) -> String {
    match line.char_indices().nth(LINE_CAP) {
        Some((at, _)) => format!("{}…", &line[..at]),
        None => line.to_string(),
    }
}

/// The stored hunk of a review comment on `line` (and from `start_line`, a range) of the `right`
/// (new) or left (old) side, from the source's `hunk`: its tail ending at that line, at most
/// [`BUDGET`] bytes. `None` when the hunk does not parse or does not reach the line (a source
/// quirk): no hunk is stored then.
#[must_use]
pub fn trim(hunk: &str, right: bool, line: u64, start_line: Option<u64>) -> Option<String> {
    let mut lines = hunk.split('\n');
    let (mut old, mut new) = header(lines.next()?)?;
    let mut body: Vec<&str> = lines.collect();
    if body.last() == Some(&"") {
        body.pop();
    }
    // The (old, new) number each body line starts at, and the last line that is `line` on the
    // commented side.
    let mut at = Vec::with_capacity(body.len());
    let mut end = None;
    for (i, l) in body.iter().enumerate() {
        at.push((old, new));
        let (on_old, on_new) = sides(l);
        if (right && on_new && new == line) || (!right && on_old && old == line) {
            end = Some(i);
        }
        old += u64::from(on_old);
        new += u64::from(on_new);
    }
    let end = end?;
    let range = start_line
        .filter(|&s| s <= line)
        .map_or(1, |s| usize::try_from(line - s + 1).unwrap_or(MAX_LINES));
    let mut keep = range.clamp(CONTEXT, MAX_LINES).min(end + 1);
    loop {
        let from = end + 1 - keep;
        let tail = &body[from..=end];
        let (o, n) = at[from];
        let olds = tail.iter().filter(|l| sides(l).0).count();
        let news = tail.iter().filter(|l| sides(l).1).count();
        let mut out = format!("@@ -{o},{olds} +{n},{news} @@");
        for l in tail {
            out.push('\n');
            out.push_str(&cap(l));
        }
        if out.len() <= BUDGET || (keep == 1 && out.len() <= CONTRACT_MAX) {
            return Some(out);
        }
        if keep == 1 {
            return None;
        }
        keep -= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HUNK: &str = "@@ -10,6 +10,7 @@ fn main() {\n a\n b\n-c\n+C\n+D\n d\n e";

    #[test]
    fn the_tail_ends_at_the_commented_line_and_is_renumbered() {
        // new line 13 is "+D": the last 4 lines up to it, numbered on both sides
        assert_eq!(
            trim(HUNK, true, 13, None).as_deref(),
            Some("@@ -11,2 +11,3 @@\n b\n-c\n+C\n+D")
        );
        // old line 12 is "-c"
        assert_eq!(
            trim(HUNK, false, 12, None).as_deref(),
            Some("@@ -10,3 +10,2 @@\n a\n b\n-c")
        );
        // a range of 6 lines ending at the last one keeps those 6
        assert_eq!(
            trim(HUNK, true, 15, Some(10)).as_deref(),
            Some("@@ -11,4 +11,5 @@\n b\n-c\n+C\n+D\n d\n e")
        );
    }

    /// dashpay/dips#122 (discussion_r1098704777): a two-line comment on new lines 5–6 of a
    /// short hunk keeps it whole; dips#2 (discussion_r126164094) keeps the 4 lines up to new
    /// line 34 of a 1,590-byte hunk, with its 228-character line cut.
    #[test]
    fn golden_trims_of_dips_review_comments() {
        let h = "@@ -3,3 +3,4 @@\n | Masternode Type | Description |\n | --- | --- |\n | 0 | Default |\n+| 1 | 4k collateral HPMN |";
        assert_eq!(trim(h, true, 6, Some(5)).as_deref(), Some(h));
        let long = format!("+Peer to peer {}", "x".repeat(214));
        let h = format!(
            "@@ -0,0 +1,34 @@{}\n+\n+## Motivation\n+\n{long}",
            "\n+a".repeat(30)
        );
        let t = trim(&h, true, 34, None).unwrap();
        assert!(t.starts_with("@@ -0,0 +31,4 @@\n+\n+## Motivation\n+\n+Peer to peer "));
        assert_eq!(t.lines().last().unwrap().chars().count(), LINE_CAP + 1);
    }

    #[test]
    fn a_line_outside_the_hunk_or_a_bad_header_stores_nothing() {
        assert_eq!(trim(HUNK, true, 40, None), None);
        assert_eq!(
            trim(HUNK, false, 15, None),
            None,
            "old line 15 is past the hunk"
        );
        assert_eq!(trim("not a hunk\n+a", true, 1, None), None);
        assert_eq!(trim("", true, 1, None), None);
    }

    #[test]
    fn a_no_newline_marker_counts_on_neither_side() {
        let h = "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file";
        assert_eq!(
            trim(h, true, 2, None).as_deref(),
            Some("@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B")
        );
    }

    #[test]
    fn long_lines_are_cut_and_the_whole_fits_the_budget() {
        let wide = format!("+{}", "é".repeat(400));
        let h = format!("@@ -1,0 +1,6 @@{}", format!("\n{wide}").repeat(6));
        let t = trim(&h, true, 6, None).unwrap();
        assert!(t.len() <= BUDGET, "{} bytes", t.len());
        assert!(t.lines().skip(1).all(|l| l.chars().count() <= LINE_CAP + 1));
        assert!(t.ends_with('…'));
        // a commented range keeps at most MAX_LINES lines
        let many = (1..=30)
            .map(|i| format!("\n+l{i}"))
            .collect::<Vec<_>>()
            .concat();
        let h = format!("@@ -1,0 +1,30 @@{many}");
        let t = trim(&h, true, 30, Some(1)).unwrap();
        assert_eq!(t.lines().count(), MAX_LINES + 1);
        assert!(t.starts_with("@@ -1,0 +19,12 @@"));
    }
}
