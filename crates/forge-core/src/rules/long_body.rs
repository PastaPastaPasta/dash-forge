//! Long bodies (`docs/contracts/forge-v2.md` §6.3): a body, comment or set of release notes
//! longer than its field holds is stored as a content-addressed artifact (a `packManifest` of
//! kind 6, [`crate::pack::KIND_LONG_BODY`]), and the field keeps a prefix of the text and a
//! last line naming the artifact:
//!
//! ```text
//! <the first few KB of the text>
//!
//! <!-- forge:body sha256=<64 lowercase hex> bytes=<the full text's UTF-8 length> -->
//! ```
//!
//! This module is the pure half, shared with forge-web (`lib/rules/long-body.ts`) through the
//! `long_body__*` conformance vectors: how a stored field is read ([`parse`]), how the full
//! text is checked once fetched ([`open_text`], [`open_public`]), and how a writer cuts the
//! prefix ([`fit_prefix`], [`stored_text`]). Fetching and storing the artifact is the
//! collab layer's ([`crate::collab::v2::Collab::read_long_body`]).
//!
//! No contract change: `packManifest.kind` is an open integer (0..=255), and the trailer is
//! ordinary text (an HTML comment, which GitHub-flavoured renderers, forge-web's included,
//! do not show).

use sha2::{Digest, Sha256};

/// The longest full text a trailer may name, in UTF-8 bytes (256 KiB). GitHub caps an issue
/// or comment at 65,536 characters and release notes at 125,000, so this holds either in any
/// script. A trailer naming more is [`LongBody::Unsupported`] and never fetched.
pub const MAX_BYTES: u64 = 262_144;
/// [`MAX_BYTES`] as a length.
pub const MAX_LEN: usize = 262_144;

/// What the trailer line starts with (the trailing space included).
pub const OPEN: &str = "<!-- forge:body ";
/// What the trailer line ends with.
const CLOSE: &str = " -->";
/// Between the prefix and the trailer.
pub const SEPARATOR: &str = "\n\n";

/// The whitespace the prefix cut trims: ASCII only, so every client trims alike.
const TRIM: [char; 4] = [' ', '\t', '\n', '\r'];

/// What a stored field says about its text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LongBody<'a> {
    /// No trailer: the field is the whole text.
    Plain,
    /// The text continues in a kind-6 artifact: `prefix` is what the field holds before the
    /// trailer, `sha256` the artifact's `packHash` (of the stored bytes: sealed, in a private
    /// repository) and `bytes` the full text's UTF-8 length.
    Continued {
        /// The text before the trailer, trailing newlines removed.
        prefix: &'a str,
        /// The artifact's `packHash`.
        sha256: [u8; 32],
        /// The full text's length in UTF-8 bytes (1..=[`MAX_BYTES`]).
        bytes: u64,
    },
    /// The last line starts like a trailer but is not one this version reads (an attribute it
    /// does not know, a malformed or out-of-range value): readers show `prefix` and say the
    /// rest cannot be read, and fetch nothing.
    Unsupported {
        /// The text before the trailer line, trailing newlines removed.
        prefix: &'a str,
    },
}

/// Read a stored field: its last line (after the last `\n`, or the whole field) is a trailer
/// when it starts with [`OPEN`]. It is then exactly `<!-- forge:body ` + space-separated
/// `key=value` attributes + ` -->`, each of `sha256` (64 lowercase hex digits) and `bytes`
/// (a decimal 1..=[`MAX_BYTES`] without leading zeros) once, and nothing else; anything else
/// starting with [`OPEN`] is [`LongBody::Unsupported`].
#[must_use]
pub fn parse(stored: &str) -> LongBody<'_> {
    let (head, line) = match stored.rfind('\n') {
        Some(i) => (&stored[..i], &stored[i + 1..]),
        None => ("", stored),
    };
    if !line.starts_with(OPEN) {
        return LongBody::Plain;
    }
    let prefix = head.trim_end_matches('\n');
    match attributes(line) {
        Some((sha256, bytes)) => LongBody::Continued {
            prefix,
            sha256,
            bytes,
        },
        None => LongBody::Unsupported { prefix },
    }
}

fn attributes(line: &str) -> Option<([u8; 32], u64)> {
    let inner = line.strip_prefix(OPEN)?.strip_suffix(CLOSE)?;
    let (mut sha, mut bytes) = (None, None);
    for token in inner.split(' ') {
        let (key, value) = token.split_once('=')?;
        match key {
            "sha256" if sha.is_none() => sha = Some(hex64(value)?),
            "bytes" if bytes.is_none() => bytes = Some(length(value)?),
            _ => return None,
        }
    }
    Some((sha?, bytes?))
}

fn hex64(v: &str) -> Option<[u8; 32]> {
    if v.len() != 64 || !v.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    let mut out = [0u8; 32];
    hex::decode_to_slice(v, &mut out).ok()?;
    Some(out)
}

fn length(v: &str) -> Option<u64> {
    if v.is_empty() || v.len() > 7 || v.starts_with('0') || !v.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    v.parse().ok().filter(|n| (1..=MAX_BYTES).contains(n))
}

/// The trailer line for an artifact of `packHash` `sha256` holding `bytes` of text.
#[must_use]
pub fn trailer(sha256: &[u8; 32], bytes: u64) -> String {
    format!("{OPEN}sha256={} bytes={bytes}{CLOSE}", hex::encode(sha256))
}

/// Whether `full` must be stored as an artifact to fit `room` bytes of field: it is longer,
/// or its own last line would read as a trailer (stored as it is, readers would take it for
/// one; in an artifact it is shown as written, since an artifact's text is never parsed).
#[must_use]
pub fn needs_artifact(full: &str, room: usize) -> bool {
    full.len() > room || parse(full) != LongBody::Plain
}

/// The field that stores `full` in the artifact `sha256`: [`fit_prefix`] of `full` within what
/// `room` leaves after the separator and the trailer, then [`SEPARATOR`] and the trailer (the
/// trailer alone when no prefix fits). `None` when `room` cannot hold the trailer, or `full` is
/// over [`MAX_BYTES`] or empty.
#[must_use]
pub fn stored_text(full: &str, room: usize, sha256: &[u8; 32]) -> Option<String> {
    let bytes = full.len() as u64;
    if bytes == 0 || bytes > MAX_BYTES {
        return None;
    }
    with_trailer(full, trailer(sha256, bytes), room)
}

/// A stored long body's field (`stored`, a [`LongBody::Continued`] one) within `room` bytes,
/// naming the same artifact: its prefix cut again by [`fit_prefix`] (the trailer alone when
/// none fits). What an edit of a private document's other text (a longer title) writes when
/// that text leaves the field less room than it took. `stored` itself when it fits or is not
/// continued; `None` when `room` cannot hold the trailer.
#[must_use]
pub fn refit(stored: &str, room: usize) -> Option<String> {
    let LongBody::Continued {
        prefix,
        sha256,
        bytes,
    } = parse(stored)
    else {
        return Some(stored.to_string());
    };
    if stored.len() <= room {
        return Some(stored.to_string());
    }
    with_trailer(prefix, trailer(&sha256, bytes), room)
}

/// [`fit_prefix`] of `text` within what `room` leaves after [`SEPARATOR`] and `line`, then the
/// separator and `line` (`line` alone when no prefix fits); `None` when `room` cannot hold `line`.
fn with_trailer(text: &str, line: String, room: usize) -> Option<String> {
    let budget = room.checked_sub(line.len())?;
    let prefix = budget
        .checked_sub(SEPARATOR.len())
        .map_or_else(String::new, |max| fit_prefix(text, max));
    Some(if prefix.is_empty() {
        line
    } else {
        format!("{prefix}{SEPARATOR}{line}")
    })
}

/// [`stored_text`] in a public repository, where the artifact is the text's own bytes: its
/// `packHash` is the text's SHA-256, so the field is known before anything is stored.
#[must_use]
pub fn public_stored_text(full: &str, room: usize) -> Option<String> {
    let hash: [u8; 32] = Sha256::digest(full.as_bytes()).into();
    stored_text(full, room, &hash)
}

/// What a resumable create keys its journal by for the field `stored`: the field itself, or
/// for a long body its prefix and length. The artifact's hash is left out: a private
/// repository's is of bytes sealed afresh by every attempt, and a re-run must still find the
/// create it interrupted rather than open a second issue or PR.
#[must_use]
pub fn journal_key(stored: &str) -> std::borrow::Cow<'_, str> {
    match parse(stored) {
        LongBody::Continued { prefix, bytes, .. } => {
            std::borrow::Cow::Owned(format!("{prefix}\0{OPEN}bytes={bytes}"))
        }
        _ => std::borrow::Cow::Borrowed(stored),
    }
}

/// Whether the field `stored` states `full` as a writer with `room` bytes would store it:
/// `full` itself, or a trailer naming an artifact of `full`'s length after the very prefix
/// [`stored_text`] cuts from it. The artifact's hash is not compared: a private repository's
/// is of bytes sealed afresh by every writer, so an importer re-running over an item it
/// already wrote must not take it for a change.
#[must_use]
pub fn states(stored: &str, full: &str, room: usize) -> bool {
    if !needs_artifact(full, room) {
        return stored == full;
    }
    // the field this writer would store, with any hash: its prefix depends on the length only
    let (
        LongBody::Continued {
            prefix: held,
            bytes,
            ..
        },
        Some(mine),
    ) = (parse(stored), stored_text(full, room, &[0; 32]))
    else {
        return false;
    };
    let LongBody::Continued { prefix: want, .. } = parse(&mine) else {
        return false;
    };
    bytes == full.len() as u64 && held == want
}

/// Why a fetched full text is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenError {
    /// The field has no readable trailer ([`LongBody::Continued`]).
    NotContinued,
    /// The stored bytes do not hash to the trailer's `sha256`.
    Hash,
    /// The text is not the trailer's `bytes` long.
    Size,
    /// The text is not UTF-8.
    Utf8,
}

impl OpenError {
    /// The vectors' name for it.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotContinued => "notContinued",
            Self::Hash => "hash",
            Self::Size => "size",
            Self::Utf8 => "utf8",
        }
    }
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::NotContinued => "the field does not continue in an artifact",
            Self::Hash => "the stored text does not match its hash",
            Self::Size => "the stored text is not the length its trailer says",
            Self::Utf8 => "the stored text is not UTF-8",
        })
    }
}

/// The full text from an artifact's plaintext (a public artifact's stored bytes, a private
/// one's opened bytes): exactly `bytes` long and UTF-8.
pub fn open_text(bytes: u64, plain: &[u8]) -> Result<String, OpenError> {
    if plain.len() as u64 != bytes {
        return Err(OpenError::Size);
    }
    String::from_utf8(plain.to_vec()).map_err(|_| OpenError::Utf8)
}

/// The full text a public field continues in, from the artifact's stored bytes `blob`: they
/// hash to the trailer's `sha256` (the `packHash` every copy is checked against), and
/// [`open_text`].
pub fn open_public(stored: &str, blob: &[u8]) -> Result<String, OpenError> {
    let LongBody::Continued { sha256, bytes, .. } = parse(stored) else {
        return Err(OpenError::NotContinued);
    };
    if Sha256::digest(blob).as_slice() != sha256.as_slice() {
        return Err(OpenError::Hash);
    }
    open_text(bytes, blob)
}

/// `text` within `max` UTF-8 bytes: unchanged when it fits, else cut at a character boundary,
/// then back to the last paragraph break, else line break, else space, that falls in the cut's
/// second half (a single overlong word is cut where it is), ASCII whitespace trimmed from the
/// end, and a code fence or inline code span left open closed again (so the rest of a
/// rendering does not turn into code). Each round shortens the cut by what the closer
/// overflows, so the result is always within `max`.
#[must_use]
pub fn fit_prefix(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut room = max;
    loop {
        let closed = close_code(boundary_cut(clip_bytes(text, room)));
        if closed.len() <= max || room == 0 {
            return closed;
        }
        room = room.saturating_sub(closed.len() - max);
    }
}

/// The longest prefix of `s` within `max` bytes that ends on a character boundary.
fn clip_bytes(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// `s` shortened to its last paragraph break, else line break, else space, when one falls in
/// its second half (a single overlong word is cut where it is).
fn boundary_cut(s: &str) -> &str {
    let half = s.len() / 2;
    ["\n\n", "\n", " "]
        .iter()
        .find_map(|sep| s.rfind(sep).filter(|&i| i >= half))
        .map_or(s, |i| s[..i].trim_end_matches(TRIM))
}

/// `s` with a code fence or inline code span left open at its end closed again.
fn close_code(s: &str) -> String {
    // The fence a block opened with (``` or ~~~, any length ≥ 3): it closes only on the same
    // character, at least as long. Outside blocks, an inline span opened by a run of N
    // unescaped backticks closes on the next run of exactly N.
    let mut fence: Option<(char, usize)> = None;
    let mut span: Option<usize> = None;
    // Lines split on `\n`, each losing one trailing `\r` (spelled out: `str::lines` has
    // changed how it treats a final bare `\r`, and the TypeScript port must match).
    for line in s.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let t = line.trim_start_matches([' ', '\t']);
        let run = |c: char| t.chars().take_while(|&x| x == c).count();
        if let Some((c, n)) = fence {
            if run(c) >= n && t.trim_end_matches([' ', '\t']).chars().all(|x| x == c) {
                fence = None;
            }
            continue;
        }
        if span.is_none() {
            if let Some(c) = ['`', '~'].into_iter().find(|&c| run(c) >= 3) {
                fence = Some((c, run(c)));
                continue;
            }
        }
        span = backtick_spans(line, span);
    }
    match (fence, span) {
        (Some((c, n)), _) => format!("{s}\n{}", c.to_string().repeat(n)),
        (None, Some(n)) => format!("{s}{}", "`".repeat(n)),
        (None, None) => s.to_string(),
    }
}

/// The inline code span still open after `line` (its opening run's length), given the one open
/// before it; a backslash-escaped backtick outside a span is text.
fn backtick_spans(line: &str, mut open: Option<usize>) -> Option<usize> {
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if open.is_none() && b[i] == b'\\' {
            i += 2;
            continue;
        }
        if b[i] == b'`' {
            let start = i;
            while i < b.len() && b[i] == b'`' {
                i += 1;
            }
            let n = i - start;
            open = match open {
                None => Some(n),
                Some(m) if m == n => None,
                other => other,
            };
            continue;
        }
        i += 1;
    }
    open
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: [u8; 32] = [0xab; 32];

    #[test]
    fn plain_text_is_plain() {
        assert_eq!(parse(""), LongBody::Plain);
        assert_eq!(parse("hello\nworld"), LongBody::Plain);
        assert_eq!(parse("<!-- a comment -->"), LongBody::Plain);
        // only the last line counts
        assert_eq!(parse(&format!("{}\nmore", trailer(&H, 9))), LongBody::Plain);
    }

    #[test]
    fn a_trailer_round_trips() {
        let full = "word ".repeat(2000);
        let stored = stored_text(&full, 5120, &H).unwrap();
        assert!(stored.len() <= 5120, "{}", stored.len());
        let LongBody::Continued {
            prefix,
            sha256,
            bytes,
        } = parse(&stored)
        else {
            panic!("not continued: {stored}");
        };
        assert_eq!(sha256, H);
        assert_eq!(bytes, full.len() as u64);
        assert!(full.starts_with(prefix));
        assert_eq!(stored, format!("{prefix}{SEPARATOR}{}", trailer(&H, bytes)));
    }

    /// A field cut again for less room keeps naming the same artifact; one that fits, or a
    /// plain field, is kept as it is.
    #[test]
    fn a_field_refits_into_less_room() {
        let full = "word ".repeat(2000);
        let stored = stored_text(&full, 5085, &H).unwrap();
        assert_eq!(refit(&stored, 5085).as_deref(), Some(stored.as_str()));
        let cut = refit(&stored, 4000).unwrap();
        assert!(cut.len() <= 4000, "{}", cut.len());
        let LongBody::Continued {
            prefix,
            sha256,
            bytes,
        } = parse(&cut)
        else {
            panic!("not continued: {cut}");
        };
        assert_eq!((sha256, bytes), (H, full.len() as u64));
        assert!(full.starts_with(prefix));
        assert_eq!(refit(&stored, 40), None);
        let line = trailer(&H, full.len() as u64);
        assert_eq!(refit(&stored, line.len()).as_deref(), Some(line.as_str()));
        assert_eq!(refit("short", 2).as_deref(), Some("short"));
    }

    #[test]
    fn malformed_trailers_are_unsupported() {
        let h = hex::encode(H);
        for line in [
            format!("<!-- forge:body sha256={h} -->"),
            format!("<!-- forge:body sha256={h} bytes=0 -->"),
            format!("<!-- forge:body sha256={h} bytes=012 -->"),
            format!("<!-- forge:body sha256={h} bytes=262145 -->"),
            format!("<!-- forge:body sha256={} bytes=9 -->", h.to_uppercase()),
            format!("<!-- forge:body sha256={h} bytes=9 repo=x -->"),
            format!("<!-- forge:body sha256={h}  bytes=9 -->"),
            format!("<!-- forge:body sha256={h} bytes=9 bytes=9 -->"),
            format!("<!-- forge:body sha256={h} bytes=9 --> "),
            "<!-- forge:body -->".to_string(),
        ] {
            assert_eq!(
                parse(&format!("before\n\n{line}")),
                LongBody::Unsupported { prefix: "before" },
                "{line}"
            );
        }
        // attributes in either order
        assert!(matches!(
            parse(&format!("<!-- forge:body bytes=9 sha256={h} -->")),
            LongBody::Continued { bytes: 9, .. }
        ));
    }

    #[test]
    fn a_text_ending_in_a_trailer_needs_an_artifact() {
        assert!(!needs_artifact("short", 5120));
        assert!(needs_artifact(&"x".repeat(5121), 5120));
        assert!(needs_artifact(&format!("a\n{}", trailer(&H, 3)), 5120));
    }

    #[test]
    fn open_checks_hash_size_and_utf8() {
        let full = "é".repeat(4000);
        let hash: [u8; 32] = Sha256::digest(full.as_bytes()).into();
        let stored = stored_text(&full, 5120, &hash).unwrap();
        assert_eq!(open_public(&stored, full.as_bytes()).unwrap(), full);
        assert_eq!(open_public(&stored, b"x"), Err(OpenError::Hash));
        assert_eq!(open_public("plain", b"x"), Err(OpenError::NotContinued));
        assert_eq!(open_text(3, b"ab"), Err(OpenError::Size));
        assert_eq!(open_text(1, &[0xff]), Err(OpenError::Utf8));
    }

    /// An importer re-running over a sealed item, and a create resumed after a fresh seal, see
    /// the same text whatever the artifact's hash.
    #[test]
    fn states_and_journal_keys_ignore_the_hash() {
        let full = "line\n".repeat(2000);
        let a = stored_text(&full, 5120, &[1; 32]).unwrap();
        let b = stored_text(&full, 5120, &[2; 32]).unwrap();
        assert_ne!(a, b);
        assert!(states(&a, &full, 5120) && states(&b, &full, 5120));
        assert_eq!(journal_key(&a), journal_key(&b));
        // another text of the same length, or another length, is a change
        let other = "word\n".repeat(2000);
        assert!(!states(&a, &other, 5120));
        assert!(!states(&a, &full[..9000], 5120));
        // a text that fits states itself, and keys itself
        assert!(states("short", "short", 5120) && !states("short", "shorter", 5120));
        assert_eq!(journal_key("short"), "short");
    }

    #[test]
    fn no_room_for_the_trailer() {
        assert_eq!(stored_text("abc", 50, &H), None);
        assert_eq!(stored_text("", 5120, &H), None);
        // room for the trailer only: no prefix
        let only = trailer(&H, 3);
        assert_eq!(stored_text("abc", only.len() + 1, &H), Some(only));
    }

    #[test]
    fn fit_prefix_cuts_at_boundaries_and_closes_code() {
        assert_eq!(fit_prefix("short", 100), "short");
        let paras = format!("{}\n\n{}", "a".repeat(60), "b".repeat(60));
        assert_eq!(fit_prefix(&paras, 100), "a".repeat(60));
        let fenced = format!("intro\n\n```rust\n{}", "let x = 1;\n".repeat(20));
        let out = fit_prefix(&fenced, 120);
        assert!(out.ends_with("\n```"), "{out}");
        assert!(out.len() <= 120);
        let span = format!("{} `code {}", "w ".repeat(30), "c".repeat(100));
        let out = fit_prefix(&span, 80);
        assert!(out.ends_with('`') && out.len() <= 80, "{out}");
        // never mid-character
        assert_eq!(fit_prefix("éé", 3), "é");
    }

    /// Fences of `~~~` and of four or more backticks, double-backtick spans and escaped
    /// backticks are all closed (or left alone) correctly.
    #[test]
    fn every_kind_of_open_code_is_closed() {
        assert_eq!(close_code("a\n~~~ sh\nls"), "a\n~~~ sh\nls\n~~~");
        assert_eq!(close_code("````md\n```\ninner"), "````md\n```\ninner\n````");
        assert_eq!(close_code("x ``a ` b"), "x ``a ` b``");
        assert_eq!(close_code(r"a \` literal"), r"a \` literal");
        assert_eq!(
            close_code("```\ncode\n```\nafter `x"),
            "```\ncode\n```\nafter `x`"
        );
        assert_eq!(close_code("done `x` and ``y``"), "done `x` and ``y``");
    }
}
