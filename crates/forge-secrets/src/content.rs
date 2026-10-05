//! The content rules: what a file's text holds. See the crate docs for each rule.

use crate::util::{base58_decode, crc32, encode_base, sha256, shannon_entropy, BASE58};
use crate::{
    Rule, ASSIGNMENT_MAX_LEN, ASSIGNMENT_MIN_ENTROPY, ASSIGNMENT_MIN_LEN, AWS_ID_PREFIXES,
    GITHUB_FINE_GRAINED_PREFIX, GITHUB_PREFIXES, GITLAB_PREFIXES, PEM_MAX_MARKERS, PEM_MIN_BODY,
    PLACEHOLDER_WORDS, SECRET_NAME_WORDS, WIF_VERSIONS,
};

/// One content match: the rule, the byte offset where it starts, and the fingerprint material.
pub(crate) struct Match {
    pub rule: Rule,
    pub offset: usize,
    pub material: String,
    /// Another offset the match covers (an AWS pair's secret), so no `secret_assignment` is
    /// reported on its line either.
    pub also: Option<usize>,
}

impl Match {
    fn new(rule: Rule, offset: usize, material: String) -> Self {
        Self {
            rule,
            offset,
            material,
            also: None,
        }
    }
}

/// Every content match in `text`, in no particular order (the caller sorts).
pub(crate) fn scan_text(text: &str) -> Vec<Match> {
    let mut out = Vec::new();
    private_keys(text, &mut out);
    aws_pairs(text, &mut out);
    github_tokens(text, &mut out);
    gitlab_tokens(text, &mut out);
    wifs(text, &mut out);
    assignments(text, &mut out);
    out
}

/// Whether one line of `text` sets a variable to a non-empty value: `NAME=value`,
/// `export NAME=value` or `NAME: value` (a leading UTF-8 BOM ignored), where `NAME` starts with a letter or `_` and holds letters, digits,
/// `_`, `.` or `-`, and the value is not empty, `""` or `''`.
pub(crate) fn sets_a_value(text: &str) -> bool {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    text.lines().any(|line| {
        let l = strip_export(line);
        let Some(at) = l.find(['=', ':']) else {
            return false;
        };
        let (name, value) = (&l[..at], &l[at + 1..]);
        let name = name.trim_end();
        let ok_name = name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && name.chars().all(is_name_char);
        let value = value.trim();
        ok_name && !value.is_empty() && value != "\"\"" && value != "''"
    })
}

// --- private keys -------------------------------------------------------------------------

const BEGIN: &str = "-----BEGIN ";
const DASHES: &str = "-----";

fn is_private_key_label(label: &str) -> bool {
    label.len() <= 40
        && (label.ends_with("PRIVATE KEY") || label == "PGP PRIVATE KEY BLOCK")
        && label
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b' ')
}

/// The base64 body of a PEM block, when it is long enough to be a key: `\n`/`\r` escapes are
/// line breaks; each line is trimmed of spaces, quotes and commas; header lines (with `:`) and
/// empty lines are skipped; any other character outside base64 means it is not a key.
fn pem_body(body: &str) -> Option<String> {
    let body = body.replace("\\n", "\n").replace("\\r", "\n");
    let mut b64 = String::new();
    for line in body.lines() {
        let l = line.trim_matches(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ','));
        if l.is_empty() || l.contains(':') {
            continue;
        }
        if !l
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'='))
        {
            return None;
        }
        b64.push_str(l);
    }
    (b64.len() >= PEM_MIN_BODY).then_some(b64)
}

fn private_keys(text: &str, out: &mut Vec<Match>) {
    // A label whose END marker is missing after some point is missing after every later one:
    // remembered, so unmatched BEGIN markers cost one search each, not one per pair.
    let mut unmatched: Vec<&str> = Vec::new();
    let mut from = 0;
    let mut markers = 0;
    while let Some(i) = text[from..].find(BEGIN) {
        markers += 1;
        if markers > PEM_MAX_MARKERS {
            break;
        }
        let start = from + i;
        let label_start = start + BEGIN.len();
        let Some(label_len) = text[label_start..].find(DASHES) else {
            break;
        };
        let label = &text[label_start..label_start + label_len];
        from = label_start + label_len + DASHES.len();
        if !is_private_key_label(label) || unmatched.contains(&label) {
            continue;
        }
        let end = format!("-----END {label}-----");
        let Some(body_len) = text[from..].find(&end) else {
            unmatched.push(label);
            continue;
        };
        // Only a real key consumes its span: a body that is not one (a stray BEGIN whose END
        // belongs to a later block) must not hide the BEGIN of that later block.
        if let Some(material) = pem_body(&text[from..from + body_len]) {
            out.push(Match::new(Rule::PrivateKey, start, material));
            from += body_len + end.len();
        }
    }
}

// --- words --------------------------------------------------------------------------------

/// Every maximal run of bytes satisfying `in_word`, with its start offset.
fn words(text: &str, in_word: impl Fn(u8) -> bool) -> Vec<(usize, &str)> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if !in_word(b[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && in_word(b[i]) {
            i += 1;
        }
        // Runs of ASCII bytes only, so these are char boundaries.
        out.push((start, &text[start..i]));
    }
    out
}

// --- AWS ----------------------------------------------------------------------------------

fn is_aws_id_char(b: u8) -> bool {
    b.is_ascii_uppercase() || (b'2'..=b'7').contains(&b)
}

fn is_aws_id(w: &str) -> bool {
    if w.len() != 20 || w.contains("EXAMPLE") {
        return false;
    }
    AWS_ID_PREFIXES.iter().any(|p| {
        w.starts_with(p)
            && w.as_bytes()[p.len()..]
                .iter()
                .all(|&b| is_aws_id_char(b) || (*p == "A3T" && b.is_ascii_digit()))
    })
}

fn is_aws_secret(w: &str) -> bool {
    let b = w.as_bytes();
    b.len() == 40
        && !w.contains("EXAMPLE")
        && b.iter().any(u8::is_ascii_uppercase)
        && b.iter().any(u8::is_ascii_lowercase)
        && b.iter()
            .any(|c| c.is_ascii_digit() || matches!(c, b'/' | b'+'))
        && !b.iter().all(u8::is_ascii_hexdigit)
}

fn aws_pairs(text: &str, out: &mut Vec<Match>) {
    let ids: Vec<(usize, &str)> = words(text, |b| b.is_ascii_alphanumeric())
        .into_iter()
        .filter(|(_, w)| is_aws_id(w))
        .collect();
    if ids.is_empty() {
        return;
    }
    let Some((secret_at, secret)) = words(text, |b| {
        b.is_ascii_alphanumeric() || matches!(b, b'/' | b'+')
    })
    .into_iter()
    .find(|(_, w)| is_aws_secret(w)) else {
        return;
    };
    for (offset, id) in ids {
        out.push(Match {
            rule: Rule::AwsKeyPair,
            offset,
            material: format!("{id}:{secret}"),
            also: Some(secret_at),
        });
    }
}

// --- GitHub -------------------------------------------------------------------------------

/// Base62 digits in the order `0-9A-Za-z`.
const BASE62_UPPER_FIRST: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/// Base62 digits in the order `0-9a-zA-Z`.
const BASE62_LOWER_FIRST: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/// Whether a GitHub token (`ghp_` and 36 alphanumerics) carries a valid checksum.
///
/// Format source: GitHub, "Behind GitHub's new authentication token formats" (2021-04-05,
/// <https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/>):
/// a three-letter prefix and `_`, 30 random base62 characters, then "a 32 bit checksum in the
/// last 6 digits", "a CRC32 algorithm", encoded "with a Base62 implementation, using leading
/// zeros for padding". The post does not say which characters the CRC covers or the order of
/// the base62 alphabet, so all four readings are accepted (CRC of the 30 random characters, or
/// of the prefix and them; `0-9A-Za-z` or `0-9a-zA-Z`). A random 36-character body passes one of
/// them by chance about once in 14 billion.
pub fn github_checksum_ok(token: &str) -> bool {
    let Some(prefix) = GITHUB_PREFIXES.iter().find(|p| token.starts_with(**p)) else {
        return false;
    };
    let body = &token[prefix.len()..];
    if body.len() != 36 || !body.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return false;
    }
    let (random, check) = body.split_at(30);
    let covered = [random.to_string(), format!("{prefix}{random}")];
    covered.iter().any(|c| {
        let crc = u64::from(crc32(c.as_bytes()));
        [BASE62_UPPER_FIRST, BASE62_LOWER_FIRST]
            .iter()
            .any(|alphabet| encode_base(crc, alphabet, 6) == check)
    })
}

/// Whether byte `i` of `text` starts a token: at the start, or after a byte that cannot be part
/// of one.
fn at_token_start(text: &str, i: usize) -> bool {
    i == 0 || {
        let b = text.as_bytes()[i - 1];
        !(b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    }
}

/// Every occurrence of `prefix` in `text` at a token start, with the run of bytes satisfying
/// `in_token` that begins there.
fn prefixed<'t>(
    text: &'t str,
    prefix: &str,
    in_token: impl Fn(u8) -> bool,
) -> Vec<(usize, &'t str)> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(i) = text[from..].find(prefix) {
        let start = from + i;
        from = start + prefix.len();
        if !at_token_start(text, start) {
            continue;
        }
        let b = text.as_bytes();
        let mut end = start + prefix.len();
        while end < b.len() && in_token(b[end]) {
            end += 1;
        }
        out.push((start, &text[start..end]));
    }
    out
}

fn github_tokens(text: &str, out: &mut Vec<Match>) {
    for prefix in GITHUB_PREFIXES {
        for (offset, token) in prefixed(text, prefix, |b| b.is_ascii_alphanumeric()) {
            if token.len() != prefix.len() + 36 {
                continue;
            }
            let rule = if github_checksum_ok(token) {
                Rule::GithubToken
            } else {
                Rule::UnverifiedToken
            };
            out.push(Match::new(rule, offset, token.to_string()));
        }
    }
    let p = GITHUB_FINE_GRAINED_PREFIX;
    for (offset, token) in prefixed(text, p, |b| b.is_ascii_alphanumeric() || b == b'_') {
        let rest = &token[p.len()..];
        let shaped = rest.len() == 82
            && rest.as_bytes()[22] == b'_'
            && rest
                .bytes()
                .enumerate()
                .all(|(i, b)| i == 22 || b.is_ascii_alphanumeric());
        if shaped {
            out.push(Match::new(Rule::UnverifiedToken, offset, token.to_string()));
        }
    }
}

// --- GitLab -------------------------------------------------------------------------------

const BASE36: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";

fn is_base64url(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-')
}

fn is_base36(s: &str) -> bool {
    s.bytes()
        .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase())
}

/// Whether a GitLab routable token's length field and CRC agree.
///
/// Format source: GitLab, "Cells: Routable Tokens" design document
/// (<https://handbook.gitlab.com/handbook/engineering/architecture/design-documents/cells/routable_tokens/>):
/// `<prefix><base64-payload>.<token-version>.<base64-payload-length><crc32>`, each number in
/// base36 left-padded with `0`: the version and the length in 2 characters, the CRC32 in 7.
/// The document says the CRC covers `<prefix><base64-payload>.<base64-payload-length>`; GitLab's
/// generator also covers the version (`<prefix><payload>.<version>.<length>`). Both are
/// accepted, and so is the earlier form without a version segment
/// (`<prefix><payload>.<length><crc32>`).
pub fn gitlab_checksum_ok(token: &str) -> bool {
    routable(token) == Some(true)
}

/// `None` when `token` is not shaped like a routable token; else whether its length and CRC
/// agree.
fn routable(token: &str) -> Option<bool> {
    let prefix = GITLAB_PREFIXES.iter().find(|p| token.starts_with(**p))?;
    let rest = &token[prefix.len()..];
    let (payload, tail) = rest.split_once('.')?;
    if !(27..=300).contains(&payload.len()) || !payload.bytes().all(is_base64url) {
        return None;
    }
    let (version, len_crc) = match tail.split_once('.') {
        Some((v, lc)) if v.len() == 2 => (Some(v), lc),
        Some(_) => return None,
        None => (None, tail),
    };
    if len_crc.len() != 9 || !is_base36(len_crc) || version.is_some_and(|v| !is_base36(v)) {
        return None;
    }
    let (len, crc) = len_crc.split_at(2);
    if encode_base(payload.len() as u64, BASE36, 2) != len {
        return Some(false);
    }
    let mut covered = vec![format!("{prefix}{payload}.{len}")];
    if let Some(v) = version {
        covered.push(format!("{prefix}{payload}.{v}.{len}"));
    }
    Some(
        covered
            .iter()
            .any(|c| encode_base(u64::from(crc32(c.as_bytes())), BASE36, 7) == crc),
    )
}

fn gitlab_tokens(text: &str, out: &mut Vec<Match>) {
    for prefix in GITLAB_PREFIXES {
        for (offset, run) in prefixed(text, prefix, |b| is_base64url(b) || b == b'.') {
            let token = run.trim_end_matches('.');
            let rule = match routable(token) {
                Some(true) => Rule::GitlabToken,
                Some(false) => Rule::UnverifiedToken,
                // The legacy personal access token: `glpat-` and 20 characters, no checksum.
                None if *prefix == "glpat-"
                    && token.len() == prefix.len() + 20
                    && token[prefix.len()..].bytes().all(is_base64url) =>
                {
                    Rule::UnverifiedToken
                }
                None => continue,
            };
            out.push(Match::new(rule, offset, token.to_string()));
        }
    }
}

// --- WIF ----------------------------------------------------------------------------------

/// Whether `w` is a WIF private key: base58 that decodes to a [`WIF_VERSIONS`] byte, 32 key
/// bytes, an optional `0x01` (compressed), and the first 4 bytes of SHA-256(SHA-256(the rest)).
fn is_wif(w: &str) -> bool {
    if !(51..=52).contains(&w.len()) || !w.bytes().all(|b| BASE58.contains(&b)) {
        return false;
    }
    let Some(raw) = base58_decode(w) else {
        return false;
    };
    let shaped = match raw.len() {
        37 => true,
        38 => raw[33] == 0x01,
        _ => false,
    };
    if !shaped || !WIF_VERSIONS.contains(&raw[0]) {
        return false;
    }
    let (payload, check) = raw.split_at(raw.len() - 4);
    sha256(&sha256(payload))[..4] == *check
}

fn wifs(text: &str, out: &mut Vec<Match>) {
    for (offset, w) in words(text, |b| b.is_ascii_alphanumeric()) {
        if is_wif(w) {
            out.push(Match::new(Rule::Wif, offset, w.to_string()));
        }
    }
}

// --- assignments --------------------------------------------------------------------------

/// `line` without leading whitespace and an `export ` prefix.
fn strip_export(line: &str) -> &str {
    let l = line.trim_start();
    l.strip_prefix("export ").map_or(l, str::trim_start)
}

fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')
}

fn is_value_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '_' | '-' | '.' | '~')
}

/// `(name, value)` when `line` is one assignment: optional `export `, a name (optionally
/// quoted), `=`, `:`, `:=` or `=>`, then a value (optionally quoted) that ends the line or is
/// followed by a space, `,`, `;` or its closing quote.
fn assignment(line: &str) -> Option<(&str, &str)> {
    let l = strip_export(line);
    let first = l.chars().next()?;
    let (l, name) = if matches!(first, '"' | '\'') {
        let close = l[1..].find(first)? + 1;
        (&l[close + 1..], &l[1..close])
    } else {
        let end = l.find(|c: char| !is_name_char(c)).unwrap_or(l.len());
        (&l[end..], &l[..end])
    };
    if name.is_empty() || !name.chars().all(is_name_char) {
        return None;
    }
    let l = l.trim_start();
    let l = ["=>", ":=", "=", ":"]
        .iter()
        .find_map(|sep| l.strip_prefix(sep))?
        .trim_start();
    let (l, quote) = match l.chars().next() {
        Some(q @ ('"' | '\'')) => (&l[1..], Some(q)),
        _ => (l, None),
    };
    let end = l.find(|c: char| !is_value_char(c)).unwrap_or(l.len());
    let (value, after) = l.split_at(end);
    let ends_well = match quote {
        Some(q) => after.starts_with(q),
        None => {
            after.is_empty()
                || after.starts_with(|c: char| c.is_whitespace() || matches!(c, ',' | ';'))
        }
    };
    ends_well.then_some((name, value))
}

fn is_secret_value(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    (ASSIGNMENT_MIN_LEN..=ASSIGNMENT_MAX_LEN).contains(&value.len())
        && !PLACEHOLDER_WORDS.iter().any(|w| lower.contains(w))
        && shannon_entropy(value) >= ASSIGNMENT_MIN_ENTROPY
}

fn assignments(text: &str, out: &mut Vec<Match>) {
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        if let Some((name, value)) = assignment(line.trim_end_matches(['\n', '\r'])) {
            let lower = name.to_ascii_lowercase();
            if SECRET_NAME_WORDS.iter().any(|w| lower.contains(w)) && is_secret_value(value) {
                out.push(Match::new(
                    Rule::SecretAssignment,
                    offset,
                    format!("{name}={value}"),
                ));
            }
        }
        offset += line.len();
    }
}
