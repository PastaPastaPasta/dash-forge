//! The TLV plaintext of an encrypted document field (`docs/security/private-repos.md` §4.3):
//! records `tag(u8) ‖ len(u16) ‖ value`, strictly ascending, parsed with the exact strictness
//! rules of the table so both implementations accept and refuse the same bytes.

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::keys::EpochKey;
use super::DocKind;

const TITLE: u8 = 1;
const BODY: u8 = 2;
const REF_NAME: u8 = 3;
const BASE_REF_NAME: u8 = 4;
const SOURCE_REF_NAME: u8 = 5;
const DEFAULT_BRANCH: u8 = 6;
const PROTECTED_PATTERN: u8 = 7;
const PREV_EPOCH: u8 = 8;
const PREV_EPOCH_KEY: u8 = 9;
const PATH: u8 = 10;
const BURNED: u8 = 11;
const SKIP_EPOCH_KEY: u8 = 12;
const IMPORTED_AUTHOR: u8 = 13;
const IMPORTED_URL: u8 = 14;
const EVENT_VALUE: u8 = 15;
/// Tag 25 (`enc` v0x04 only, repeatable): a specific-people letter's recipient identity ids, 32
/// bytes each, in slot order. In every other envelope it stays reserved, so malformed.
pub const RECIPIENT: u8 = 25;
/// Tags 16..=63 are reserved (malformed); 64..=255 are extensions (skipped).
const FIRST_EXTENSION: u8 = 64;
/// Tag 64, the first extension tag: the padding record of a members or specific-people document
/// (§4.3). Readers skip it like any extension record.
pub const PAD: u8 = FIRST_EXTENSION;
/// Members and specific-people documents pad their TLV to a multiple of this many bytes (D28).
pub const PAD_BUCKET: usize = 64;
const MAX_PATTERNS: usize = 8;

/// The content fields carried in `enc`, decoded. An absent field is `None` (a zero-length
/// record for a field with `minLength 1` counts as absent, §4.3).
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fields {
    /// Tag 1: issue and patch `title`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Tag 2: `body` (issue, patch, comment, review).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// Tag 3: a ref update's `refName`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_name: Option<String>,
    /// Tag 4: a patch's `baseRefName`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_ref_name: Option<String>,
    /// Tag 5: a patch's `sourceRefName`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_ref_name: Option<String>,
    /// Tag 6: a config's `defaultBranch`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_branch: Option<String>,
    /// Tag 7 (repeatable, order kept): a config's `protectedPatterns`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub protected_patterns: Vec<String>,
    /// Tag 8: an anchor's `prevEpoch`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prev_epoch: Option<u32>,
    /// Tag 9: an anchor's `prevEpochKey`, the previous epoch's key. Never in a burned config
    /// (§5.3): the burned epoch's key may sit with someone who never held the one below.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "super::keys::opt_key_serde"
    )]
    pub prev_epoch_key: Option<EpochKey>,
    /// Tag 10: an inline comment's `path`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Tag 11 (config, `e ≥ 1`, the single byte `0x01`): the epoch is burned (§5.3): its key
    /// may have reached someone it must not, so nothing is written under it; it only links the
    /// chain.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub burned: bool,
    /// Tag 12 (config, `e ≥ 1`, not burned): `skipEpochKey`, the key of the nearest epoch below a
    /// burned run that is not burned, so the chain steps over the run (§5.3).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "super::keys::opt_key_serde"
    )]
    pub skip_epoch_key: Option<EpochKey>,
    /// Tag 13 (issue, patch, comment, review): an imported document's original author handle
    /// (`imported.author`), sealed in a private repo (§7).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported_author: Option<String>,
    /// Tag 14 (issue, patch, comment, review): an imported document's source URL
    /// (`imported.url`), sealed in a private repo (§7).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported_url: Option<String>,
    /// Tag 15 (event): an event's `value` (label or milestone name, dismiss reason, assignee,
    /// retarget base), sealed in a private repo (§7).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_value: Option<String>,
}

/// Decrypted content is private: `Debug` shows only which fields are present and their byte
/// lengths, never the text.
impl std::fmt::Debug for Fields {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let len = |v: &Option<String>| v.as_ref().map(String::len);
        f.debug_struct("Fields")
            .field("title_len", &len(&self.title))
            .field("body_len", &len(&self.body))
            .field("ref_name_len", &len(&self.ref_name))
            .field("base_ref_name_len", &len(&self.base_ref_name))
            .field("source_ref_name_len", &len(&self.source_ref_name))
            .field("default_branch_len", &len(&self.default_branch))
            .field("protected_patterns", &self.protected_patterns.len())
            .field("prev_epoch", &self.prev_epoch)
            .field("prev_epoch_key", &self.prev_epoch_key)
            .field("path_len", &len(&self.path))
            .field("burned", &self.burned)
            .field("skip_epoch_key", &self.skip_epoch_key)
            .field("imported_author_len", &len(&self.imported_author))
            .field("imported_url_len", &len(&self.imported_url))
            .field("event_value_len", &len(&self.event_value))
            .finish()
    }
}

/// How a field's value is checked (§4.3 caps, from the public schema).
#[derive(Clone, Copy)]
enum Cap {
    /// UTF-8: at least `min` bytes to count as present, at most `chars` code points and `bytes`
    /// bytes.
    Text {
        min: usize,
        chars: usize,
        bytes: usize,
    },
    /// Exactly `n` raw bytes.
    Fixed(usize),
}

fn cap(tag: u8) -> Cap {
    match tag {
        TITLE => Cap::Text {
            min: 1,
            chars: 256,
            bytes: 1024,
        },
        BODY => Cap::Text {
            min: 0,
            chars: 5120,
            bytes: 5120,
        },
        REF_NAME | BASE_REF_NAME | SOURCE_REF_NAME | DEFAULT_BRANCH => Cap::Text {
            min: 1,
            chars: 255,
            bytes: 255,
        },
        PROTECTED_PATTERN => Cap::Text {
            min: 1,
            chars: 100,
            bytes: 400,
        },
        PREV_EPOCH => Cap::Fixed(4),
        PREV_EPOCH_KEY | SKIP_EPOCH_KEY => Cap::Fixed(32),
        BURNED => Cap::Fixed(1),
        PATH => Cap::Text {
            min: 0,
            chars: 500,
            bytes: 1000,
        },
        // an importer's author handle and an event value share the schema's 120 / 480 cap
        IMPORTED_AUTHOR | EVENT_VALUE => Cap::Text {
            min: 1,
            chars: 120,
            bytes: 480,
        },
        IMPORTED_URL => Cap::Text {
            min: 1,
            chars: 300,
            bytes: 300,
        },
        _ => unreachable!("cap of a tag no kind lists"),
    }
}

/// The tags a kind may carry. `anchor_with_prev` is whether a config is for an epoch `e ≥ 1`
/// (only such a config carries tags 8, 9, 11 and 12).
fn allowed(kind: DocKind, tag: u8, anchor_with_prev: bool) -> bool {
    let imported = matches!(tag, IMPORTED_AUTHOR | IMPORTED_URL);
    match kind {
        DocKind::Issue => matches!(tag, TITLE | BODY) || imported,
        DocKind::Patch => matches!(tag, TITLE | BODY | BASE_REF_NAME | SOURCE_REF_NAME) || imported,
        DocKind::Comment => matches!(tag, BODY | PATH) || imported,
        DocKind::Review => tag == BODY || imported,
        DocKind::RefUpdate | DocKind::ProtectedRefUpdate => tag == REF_NAME,
        DocKind::Event => tag == EVENT_VALUE,
        // a release's TLV is `private::release`'s (§16.2): none of these tags
        DocKind::Release => false,
        DocKind::Config => {
            matches!(tag, DEFAULT_BRANCH | PROTECTED_PATTERN)
                || (anchor_with_prev
                    && matches!(tag, PREV_EPOCH | PREV_EPOCH_KEY | BURNED | SKIP_EPOCH_KEY))
        }
    }
}

/// Parse `pt` as the TLV plaintext of a `kind` document. `anchor_with_prev` is true for a
/// config of an epoch `e ≥ 1` and false otherwise (where tags 8, 9, 11 and 12 are refused). Such
/// a config carries tag 8; a burned one (tag 11) carries neither 9 nor 12, any other carries 9
/// and may carry 12. `None` is `Malformed`. Tag 25 is refused: it belongs to `enc` v0x04 only
/// ([`parse_letter`]).
#[must_use]
pub fn parse(pt: &[u8], kind: DocKind, anchor_with_prev: bool) -> Option<Fields> {
    parse_inner(pt, kind, anchor_with_prev, None)
}

/// Parse the TLV of a specific-people letter (`enc` v0x04): the content records of `kind`, then
/// one tag-25 record per recipient (32 bytes each, consecutive, in slot order), then extension
/// records. Returns the fields and the recipient ids. `None` is `Malformed`.
#[must_use]
pub fn parse_letter(pt: &[u8], kind: DocKind) -> Option<(Fields, Vec<[u8; 32]>)> {
    let mut recipients = Vec::new();
    let fields = parse_inner(pt, kind, false, Some(&mut recipients))?;
    Some((fields, recipients))
}

fn parse_inner(
    pt: &[u8],
    kind: DocKind,
    anchor_with_prev: bool,
    mut recipients: Option<&mut Vec<[u8; 32]>>,
) -> Option<Fields> {
    let mut f = Fields::default();
    let mut last: Option<u8> = None;
    let mut patterns = 0usize;
    let mut rest = pt;
    while !rest.is_empty() {
        // fewer than 3 bytes after the last complete record, or a length past the end
        let (&tag, tail) = rest.split_first()?;
        let len_bytes: [u8; 2] = tail.get(..2)?.try_into().ok()?;
        let len = usize::from(u16::from_be_bytes(len_bytes));
        let value = tail.get(2..2 + len)?;
        rest = &tail[2 + len..];

        // strictly ascending, except consecutive tag-7 records (and tag-25 records in a letter)
        if let Some(prev) = last {
            if tag < prev || (tag == prev && tag != PROTECTED_PATTERN && tag != RECIPIENT) {
                return None;
            }
        }
        last = Some(tag);

        if tag >= FIRST_EXTENSION {
            continue; // forward compatibility: skipped, never interpreted
        }
        if tag == RECIPIENT {
            // only a letter's TLV may carry recipients; everywhere else 25 is reserved
            let ids = recipients.as_deref_mut()?;
            if !letter_kind(kind) {
                return None;
            }
            ids.push(value.try_into().ok()?);
            continue;
        }
        if !allowed(kind, tag, anchor_with_prev) {
            return None; // reserved 16..=63, tag 0, or not a field of this kind
        }
        if tag == PROTECTED_PATTERN {
            patterns += 1;
            if patterns > MAX_PATTERNS {
                return None;
            }
        }
        match cap(tag) {
            Cap::Fixed(n) => {
                if value.len() != n {
                    return None;
                }
                match tag {
                    PREV_EPOCH => f.prev_epoch = Some(u32::from_be_bytes(value.try_into().ok()?)),
                    PREV_EPOCH_KEY => f.prev_epoch_key = EpochKey::from_slice(value),
                    SKIP_EPOCH_KEY => f.skip_epoch_key = EpochKey::from_slice(value),
                    // the flag has one value; any other byte is malformed
                    BURNED if value == [0x01] => f.burned = true,
                    _ => return None,
                }
            }
            Cap::Text { min, chars, bytes } => {
                let s = std::str::from_utf8(value).ok()?;
                if s.len() > bytes || s.chars().count() > chars {
                    return None;
                }
                if s.len() < min {
                    continue; // a zero-length record for a minLength-1 field counts as absent
                }
                let s = s.to_owned();
                match tag {
                    TITLE => f.title = Some(s),
                    BODY => f.body = Some(s),
                    REF_NAME => f.ref_name = Some(s),
                    BASE_REF_NAME => f.base_ref_name = Some(s),
                    SOURCE_REF_NAME => f.source_ref_name = Some(s),
                    DEFAULT_BRANCH => f.default_branch = Some(s),
                    PROTECTED_PATTERN => f.protected_patterns.push(s),
                    PATH => f.path = Some(s),
                    IMPORTED_AUTHOR => f.imported_author = Some(s),
                    IMPORTED_URL => f.imported_url = Some(s),
                    EVENT_VALUE => f.event_value = Some(s),
                    _ => unreachable!(),
                }
            }
        }
    }
    let required = match kind {
        DocKind::Issue | DocKind::Patch => f.title.is_some(),
        DocKind::Comment => f.body.as_deref().is_some_and(|b| !b.is_empty()),
        DocKind::RefUpdate | DocKind::ProtectedRefUpdate => f.ref_name.is_some(),
        DocKind::Config => {
            !anchor_with_prev
                || (f.prev_epoch.is_some()
                    && if f.burned {
                        f.prev_epoch_key.is_none() && f.skip_epoch_key.is_none()
                    } else {
                        f.prev_epoch_key.is_some()
                    })
        }
        DocKind::Review => true,
        DocKind::Event => f.event_value.is_some(),
        DocKind::Release => false,
    };
    required.then_some(f)
}

/// The kinds a specific-people letter (`enc` v0x04) may carry: the discussion types and an
/// event (whose value follows its target's audience).
#[must_use]
pub fn letter_kind(kind: DocKind) -> bool {
    matches!(
        kind,
        DocKind::Issue | DocKind::Patch | DocKind::Comment | DocKind::Review | DocKind::Event
    )
}

/// One record `tag ‖ u16(len) ‖ value`. A value longer than u16 cannot be represented;
/// truncating the length would corrupt the framing, so it is written as-is and refused by the
/// parse every writer runs on its own output.
fn push_record(out: &mut Vec<u8>, tag: u8, v: &[u8]) {
    let len = u16::try_from(v.len()).unwrap_or(u16::MAX);
    out.push(tag);
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(v);
}

/// The padding record (§4.3, D28) a TLV of `n` bytes gets so that it ends on a multiple of
/// [`PAD_BUCKET`]: one tag-64 record of zero bytes. It never takes the TLV past `max` (the room
/// the envelope leaves), and is empty when not even its 3-byte header fits. Like a sealed
/// release's (§16.2), it is always written when it fits, so an exact multiple gains a whole
/// bucket.
#[must_use]
pub fn pad_record(n: usize, max: usize) -> Vec<u8> {
    if n + 3 > max {
        return Vec::new();
    }
    let fill = ((PAD_BUCKET - (n + 3) % PAD_BUCKET) % PAD_BUCKET).min(max - 3 - n);
    let mut out = Vec::with_capacity(3 + fill);
    push_record(&mut out, PAD, &vec![0; fill]);
    out
}

/// Append one tag-25 record per recipient id, in slot order: the TLV tail of a letter before its
/// padding.
pub fn push_recipients(out: &mut Vec<u8>, recipients: &[[u8; 32]]) {
    for r in recipients {
        push_record(out, RECIPIENT, r);
    }
}

/// Encode `fields` in ascending tag order. The result is not validated; the sealer parses it
/// back with [`parse`] so a writer can never emit bytes a reader refuses.
#[must_use]
pub fn encode(f: &Fields) -> Zeroizing<Vec<u8>> {
    let mut out = Zeroizing::new(Vec::new());
    let mut rec = |tag: u8, v: &[u8]| push_record(&mut out, tag, v);
    let text = [
        (TITLE, &f.title),
        (BODY, &f.body),
        (REF_NAME, &f.ref_name),
        (BASE_REF_NAME, &f.base_ref_name),
        (SOURCE_REF_NAME, &f.source_ref_name),
        (DEFAULT_BRANCH, &f.default_branch),
    ];
    for (tag, v) in text {
        if let Some(v) = v {
            rec(tag, v.as_bytes());
        }
    }
    for p in &f.protected_patterns {
        rec(PROTECTED_PATTERN, p.as_bytes());
    }
    if let Some(e) = f.prev_epoch {
        rec(PREV_EPOCH, &e.to_be_bytes());
    }
    if let Some(k) = &f.prev_epoch_key {
        rec(PREV_EPOCH_KEY, k.expose());
    }
    if let Some(p) = &f.path {
        rec(PATH, p.as_bytes());
    }
    if f.burned {
        rec(BURNED, &[0x01]);
    }
    if let Some(k) = &f.skip_epoch_key {
        rec(SKIP_EPOCH_KEY, k.expose());
    }
    if let Some(a) = &f.imported_author {
        rec(IMPORTED_AUTHOR, a.as_bytes());
    }
    if let Some(u) = &f.imported_url {
        rec(IMPORTED_URL, u.as_bytes());
    }
    if let Some(v) = &f.event_value {
        rec(EVENT_VALUE, v.as_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_hides_body_and_key() {
        let f = Fields {
            title: Some("secret title".into()),
            body: Some("secret text".into()),
            ref_name: Some("refs/heads/secret".into()),
            protected_patterns: vec!["refs/heads/secret".into()],
            path: Some("src/secret.rs".into()),
            prev_epoch_key: Some(EpochKey::from_bytes([7; 32])),
            ..Fields::default()
        };
        let shown = format!("{f:?}");
        assert!(!shown.contains("secret"), "{shown}");
        assert!(!shown.contains("0707"), "{shown}");
    }

    #[test]
    fn a_value_longer_than_u16_is_refused_not_truncated() {
        let f = Fields {
            title: Some("t".into()),
            body: Some("b".repeat(70_000)),
            ..Fields::default()
        };
        assert!(parse(&encode(&f), DocKind::Issue, false).is_none());
    }
}
