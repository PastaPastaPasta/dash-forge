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
/// Tags 11..=63 are reserved (malformed); 64..=255 are extensions (skipped).
const FIRST_EXTENSION: u8 = 64;
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
    /// Tag 9: an anchor's `prevEpochKey`, the previous epoch's key.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "prev_key_hex"
    )]
    pub prev_epoch_key: Option<EpochKey>,
    /// Tag 10: an inline comment's `path`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl std::fmt::Debug for Fields {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Fields")
            .field("title", &self.title)
            .field("body", &self.body.as_ref().map(String::len))
            .field("ref_name", &self.ref_name)
            .field("base_ref_name", &self.base_ref_name)
            .field("source_ref_name", &self.source_ref_name)
            .field("default_branch", &self.default_branch)
            .field("protected_patterns", &self.protected_patterns)
            .field("prev_epoch", &self.prev_epoch)
            .field("prev_epoch_key", &self.prev_epoch_key)
            .field("path", &self.path)
            .finish()
    }
}

/// `prevEpochKey` as hex in JSON (the vectors' form).
mod prev_key_hex {
    use super::EpochKey;
    use serde::{Deserialize, Deserializer, Serializer};

    #[allow(clippy::ref_option)]
    pub fn serialize<S: Serializer>(k: &Option<EpochKey>, s: S) -> Result<S::Ok, S::Error> {
        match k {
            Some(k) => s.serialize_str(&hex::encode(k.expose())),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<EpochKey>, D::Error> {
        let s = zeroize::Zeroizing::new(String::deserialize(d)?);
        let bytes =
            zeroize::Zeroizing::new(hex::decode(s.as_str()).map_err(serde::de::Error::custom)?);
        EpochKey::from_slice(&bytes)
            .map(Some)
            .ok_or_else(|| serde::de::Error::custom("prevEpochKey is not 32 bytes"))
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
        PREV_EPOCH_KEY => Cap::Fixed(32),
        PATH => Cap::Text {
            min: 0,
            chars: 500,
            bytes: 1000,
        },
        _ => unreachable!("cap of a tag no kind lists"),
    }
}

/// The tags a kind may carry. `anchor` is whether a config is its epoch's anchor with `e ≥ 1`
/// (only such a config carries tags 8 and 9).
fn allowed(kind: DocKind, tag: u8, anchor_with_prev: bool) -> bool {
    match kind {
        DocKind::Issue => matches!(tag, TITLE | BODY),
        DocKind::Patch => matches!(tag, TITLE | BODY | BASE_REF_NAME | SOURCE_REF_NAME),
        DocKind::Comment => matches!(tag, BODY | PATH),
        DocKind::Review => tag == BODY,
        DocKind::RefUpdate | DocKind::ProtectedRefUpdate => tag == REF_NAME,
        DocKind::Config => {
            matches!(tag, DEFAULT_BRANCH | PROTECTED_PATTERN)
                || (anchor_with_prev && matches!(tag, PREV_EPOCH | PREV_EPOCH_KEY))
        }
    }
}

/// Parse `pt` as the TLV plaintext of a `kind` document. `anchor_with_prev` is true for the
/// anchor of an epoch `e ≥ 1` (which must carry tags 8 and 9) and false otherwise (where they
/// are refused). `None` is `Malformed`.
#[must_use]
pub fn parse(pt: &[u8], kind: DocKind, anchor_with_prev: bool) -> Option<Fields> {
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

        // strictly ascending, except consecutive tag-7 records
        if let Some(prev) = last {
            if tag < prev || (tag == prev && tag != PROTECTED_PATTERN) {
                return None;
            }
        }
        last = Some(tag);

        if tag >= FIRST_EXTENSION {
            continue; // forward compatibility: skipped, never interpreted
        }
        if !allowed(kind, tag, anchor_with_prev) {
            return None; // reserved 11..=63, tag 0, or not a field of this kind
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
                if tag == PREV_EPOCH {
                    f.prev_epoch = Some(u32::from_be_bytes(value.try_into().ok()?));
                } else {
                    f.prev_epoch_key = EpochKey::from_slice(value);
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
            !anchor_with_prev || (f.prev_epoch.is_some() && f.prev_epoch_key.is_some())
        }
        DocKind::Review => true,
    };
    required.then_some(f)
}

/// Encode `fields` in ascending tag order. The result is not validated; the sealer parses it
/// back with [`parse`] so a writer can never emit bytes a reader refuses.
#[must_use]
pub fn encode(f: &Fields) -> Zeroizing<Vec<u8>> {
    let mut out = Zeroizing::new(Vec::new());
    let mut rec = |tag: u8, v: &[u8]| {
        // a value longer than u16 cannot be represented; truncating the length would corrupt
        // the framing, so it is written as-is and refused by the parse that follows
        let len = u16::try_from(v.len()).unwrap_or(u16::MAX);
        out.push(tag);
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(v);
    };
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
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_hides_body_and_key() {
        let f = Fields {
            body: Some("secret text".into()),
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
