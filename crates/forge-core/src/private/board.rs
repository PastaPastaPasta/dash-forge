//! Sealed boards and cards of a private repository (`docs/security/private-repos.md` §4.6,
//! `docs/design/boards.md` §3.3): a `board`'s `name` and `spec`, and a `card`'s `col`, `rank`
//! and `f`, sealed together into `enc` v0x01 under the repository's current epoch with the §4.4
//! framing (`docType` `board` bound to `u32(key)`, `card` bound to `u32(board) ‖ item`), so a
//! sealed payload cannot be moved to another board or item.
//!
//! The `sealed_board__*` vectors (`tools/private-repos-vectors/boards.py`) hold this module byte
//! for byte against forge-web's `lib/private/board.ts` (this module's `conformance` tests).

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use serde::{Deserialize, Serialize};

use super::doc::{build_ad, OpenContext, Unreadable, MIN_V1, V1};
use super::keys::EpochKeys;
use super::tlv::{pad_record_in, push_record};
use super::PrivateError;
use crate::rules::boards::{is_board_name, is_explicit_rank, SPEC_MAX_BYTES};

/// The vector case these documents' vectors carry.
pub const VECTOR_CASE: &str = "sealed_board";

/// forge-meta `board.enc` `maxItems`.
pub const BOARD_MAX_ENC: usize = 5120;
/// forge-meta `card.enc` `maxItems`.
pub const CARD_MAX_ENC: usize = 2560;
/// The largest TLV a board seals: its `enc` cap less the v0x01 framing (29 bytes).
pub const BOARD_MAX_PLAINTEXT: usize = BOARD_MAX_ENC - MIN_V1;
/// The largest TLV a card seals.
pub const CARD_MAX_PLAINTEXT: usize = CARD_MAX_ENC - MIN_V1;

const TAG_NAME: u8 = 32;
const TAG_SPEC: u8 = 33;
const TAG_COL: u8 = 34;
const TAG_RANK: u8 = 35;
const TAG_FIELDS: u8 = 36;
const TAG_PADDING: u8 = 64;
/// A sealed TLV is padded to a multiple of this many bytes (a release's bucket, §16.2).
const PAD_BUCKET: usize = 32;
/// `card.f`'s cap (the plaintext schema's).
const FIELDS_MAX_BYTES: usize = 2048;

/// The plaintext identity a sealed board or card is bound to (§4.4 `bind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bind {
    /// A board: its key (1 … 2³²−1).
    Board {
        /// `board.key`.
        key: u32,
    },
    /// A card: its board's key and its item's `$id`.
    Card {
        /// `card.board`.
        board: u32,
        /// `card.item` (32 bytes).
        item: [u8; 32],
    },
}

impl Bind {
    /// The `docType` of the AD.
    #[must_use]
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::Board { .. } => "board",
            Self::Card { .. } => "card",
        }
    }

    /// The plaintext content fields of the type, which a sealed document may not carry
    /// (`noPlain`): a board's `name` and `spec`, a card's `col`, `rank` and `f`.
    #[must_use]
    pub fn plaintext_fields(&self) -> &'static [&'static str] {
        match self {
            Self::Board { .. } => &["name", "spec"],
            Self::Card { .. } => &["col", "rank", "f"],
        }
    }

    /// `u32(key)` or `u32(board) ‖ item`; `None` for a key of 0 (no board has it).
    fn bytes(&self) -> Option<Vec<u8>> {
        match self {
            Self::Board { key } => (*key != 0).then(|| key.to_be_bytes().to_vec()),
            Self::Card { board, item } => (*board != 0).then(|| {
                let mut b = board.to_be_bytes().to_vec();
                b.extend_from_slice(item);
                b
            }),
        }
    }
}

/// A board's sealed fields: its name and its definition (the spec JSON, judged by the board
/// rules, not here).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BoardFields {
    /// TLV 32.
    pub name: String,
    /// TLV 33.
    pub spec: String,
}

/// A card's sealed fields, each absent when the card has none.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CardFields {
    /// TLV 34: the column id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub col: Option<u8>,
    /// TLV 35: the rank.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rank: Option<String>,
    /// TLV 36: the field values' JSON (`card.f`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub f: Option<String>,
}

/// What a board or a card seals.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Content {
    /// A board's.
    Board(BoardFields),
    /// A card's.
    Card(CardFields),
}

/// Whether `f` may be sealed as a board (a reader accepts it).
fn board_ok(f: &BoardFields) -> bool {
    is_board_name(&f.name) && (1..=SPEC_MAX_BYTES).contains(&f.spec.len())
}

/// Whether `f` may be sealed as a card.
fn card_ok(f: &CardFields) -> bool {
    f.rank.as_deref().is_none_or(is_explicit_rank)
        && f.f
            .as_deref()
            .is_none_or(|j| (1..=FIELDS_MAX_BYTES).contains(&j.len()))
}

/// The TLV records of `c`, ascending, without padding (§4.6); an empty card is no records.
fn encode(c: &Content) -> Vec<u8> {
    let mut out = Vec::new();
    match c {
        Content::Board(f) => {
            push_record(&mut out, TAG_NAME, f.name.as_bytes());
            push_record(&mut out, TAG_SPEC, f.spec.as_bytes());
        }
        Content::Card(f) => {
            if let Some(col) = f.col {
                push_record(&mut out, TAG_COL, &[col]);
            }
            if let Some(r) = &f.rank {
                push_record(&mut out, TAG_RANK, r.as_bytes());
            }
            if let Some(j) = &f.f {
                push_record(&mut out, TAG_FIELDS, j.as_bytes());
            }
        }
    }
    out
}

/// Parse a board's (`bind` a board) or a card's TLV (§4.6): records strictly ascending, none
/// repeated; tags 1–63 other than the kind's own are malformed, 64–255 skipped (64 pads); every
/// value valid and within its cap; a zero-length text record counts as absent; a board needs
/// its name and spec. `None` is `Malformed`.
#[must_use]
pub fn parse(bind: &Bind, pt: &[u8]) -> Option<Content> {
    let board = matches!(bind, Bind::Board { .. });
    let (mut name, mut spec, mut card) = (None, None, CardFields::default());
    let mut last = 0u8;
    let mut rest = pt;
    while !rest.is_empty() {
        let (&tag, tail) = rest.split_first()?;
        let len = usize::from(u16::from_be_bytes(tail.get(..2)?.try_into().ok()?));
        let v = tail.get(2..2 + len)?;
        rest = &tail[2 + len..];
        if tag <= last {
            return None;
        }
        last = tag;
        if tag >= TAG_PADDING {
            continue;
        }
        let text = || -> Option<Option<String>> {
            let s = std::str::from_utf8(v).ok()?;
            Some((!s.is_empty()).then(|| s.to_string()))
        };
        match (board, tag) {
            (true, TAG_NAME) => name = text()?,
            (true, TAG_SPEC) => spec = text()?,
            (false, TAG_COL) => {
                let [c] = v else { return None };
                card.col = Some(*c);
            }
            (false, TAG_RANK) => card.rank = text()?,
            (false, TAG_FIELDS) => card.f = text()?,
            _ => return None,
        }
    }
    if board {
        let f = BoardFields {
            name: name?,
            spec: spec?,
        };
        return board_ok(&f).then_some(Content::Board(f));
    }
    card_ok(&card).then_some(Content::Card(card))
}

/// The §4.4 AD of a board or card under `keys` (the epoch it is sealed under) for `owner`.
/// `Malformed` for a key of 0.
pub fn ad(keys: &EpochKeys, owner: &[u8; 32], bind: &Bind) -> Result<Vec<u8>, PrivateError> {
    let b = bind.bytes().ok_or(PrivateError::Malformed)?;
    Ok(build_ad(
        keys.repo_id(),
        owner,
        keys.epoch(),
        V1,
        bind.type_name(),
        &b,
    ))
}

/// The padded TLV a writer seals for `c` as `bind`, or `Malformed` where a reader would refuse
/// it (or the content is not the bind's kind).
pub fn writer_tlv(bind: &Bind, c: &Content) -> Result<Vec<u8>, PrivateError> {
    let (ok, cap) = match (bind, c) {
        (Bind::Board { .. }, Content::Board(f)) => (board_ok(f), BOARD_MAX_PLAINTEXT),
        (Bind::Card { .. }, Content::Card(f)) => (card_ok(f), CARD_MAX_PLAINTEXT),
        _ => (false, 0),
    };
    if !ok {
        return Err(PrivateError::Malformed);
    }
    let mut pt = encode(c);
    // never above the cap: every field is bounded well below it (§4.6)
    if pt.len() > cap {
        return Err(PrivateError::TooLarge(bind.type_name(), cap));
    }
    pt.extend(pad_record_in(pt.len(), cap, PAD_BUCKET));
    // a writer never emits what a reader refuses
    if parse(bind, &pt).as_ref() != Some(c) {
        return Err(PrivateError::Malformed);
    }
    Ok(pt)
}

/// A sealed board or card and the intermediate values the vectors pin.
pub struct Sealed {
    /// The associated data (§4.4).
    pub ad: Vec<u8>,
    /// The padded TLV plaintext (zeroized on drop).
    pub tlv: zeroize::Zeroizing<Vec<u8>>,
    /// `enc`.
    pub enc: Vec<u8>,
}

/// Seal `c` as `owner`'s `bind` document under `keys` (the repository's current write epoch)
/// with a hedged random nonce (§3.6): the `enc` of `{repoId, key | (board, item), state,
/// epoch: keys.epoch(), enc, r}`, with no plaintext name, spec, col, rank or f.
pub fn seal(
    keys: &EpochKeys,
    owner: &[u8; 32],
    bind: &Bind,
    c: &Content,
) -> Result<Vec<u8>, PrivateError> {
    let rnd = super::keys::rnd32()?;
    Ok(seal_inner(keys, owner, bind, c, |ad, tlv| {
        keys.hedged_nonce(&rnd, ad, tlv)
    })?
    .enc)
}

/// [`seal`] with a fixed nonce: the conformance vectors only.
#[cfg(any(test, feature = "vectors"))]
pub fn seal_with_nonce(
    keys: &EpochKeys,
    owner: &[u8; 32],
    bind: &Bind,
    c: &Content,
    nonce: [u8; 12],
) -> Result<Sealed, PrivateError> {
    seal_inner(keys, owner, bind, c, |_, _| nonce)
}

fn seal_inner(
    keys: &EpochKeys,
    owner: &[u8; 32],
    bind: &Bind,
    c: &Content,
    nonce: impl FnOnce(&[u8], &[u8]) -> [u8; 12],
) -> Result<Sealed, PrivateError> {
    let tlv = zeroize::Zeroizing::new(writer_tlv(bind, c)?);
    let ad = ad(keys, owner, bind)?;
    let nonce = nonce(&ad, &tlv);
    let ct = Aes256Gcm::new(keys.doc_key().into())
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &tlv,
                aad: &ad,
            },
        )
        .map_err(|_| PrivateError::Malformed)?;
    let mut enc = vec![V1];
    enc.extend_from_slice(&nonce);
    enc.extend_from_slice(&ct);
    Ok(Sealed { ad, tlv, enc })
}

/// A stored board or card, as [`open`] reads it.
#[derive(Debug, Clone)]
pub struct StoredBoardDoc {
    /// Its immutable keys.
    pub bind: Bind,
    /// `$ownerId`.
    pub owner_id: [u8; 32],
    /// `epoch`, when a u32.
    pub epoch: Option<u32>,
    /// `enc`.
    pub enc: Option<Vec<u8>>,
    /// Whether it also carries a plaintext content field (a board's `name` / `spec`; a card's
    /// `col` / `rank` / `f`): malformed.
    pub plaintext: bool,
}

/// The result of [`open`], as `doc::Opened` is for the collab types.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Opened {
    /// The decoded fields.
    Readable(Content),
    /// Well-framed but not readable by this reader.
    Unreadable(Unreadable),
    /// A document no honest writer produces; skipped.
    Malformed,
}

/// Open a sealed board or card (§4.6, in order): the key-independent checks (an `enc`, a u32
/// `epoch`, no plaintext content, at least 29 bytes), the framing (a version other than 0x01, a
/// later client's members-only board, is `UnknownVersion`, never malformed), the epoch and key,
/// AES-GCM, the TLV, then the burned clause of the late-content rule. Both types are
/// member-gated at consensus on every replace (boards.md §3), so the height part of §8.2 does
/// not apply, as for a member `event`.
#[must_use]
pub fn open(ctx: &OpenContext, d: &StoredBoardDoc) -> Opened {
    let (Some(enc), Some(epoch)) = (d.enc.as_deref(), d.epoch) else {
        return Opened::Malformed;
    };
    if d.plaintext || enc.len() < MIN_V1 {
        return Opened::Malformed;
    }
    if enc[0] != V1 {
        return Opened::Unreadable(Unreadable::UnknownVersion);
    }
    if !ctx.anchors.contains_key(&epoch) {
        return Opened::Unreadable(Unreadable::NoEpoch);
    }
    let Some(keys) = ctx.keys.get(&epoch) else {
        return Opened::Unreadable(Unreadable::NoKey);
    };
    let Ok(ad) = ad(keys, &d.owner_id, &d.bind) else {
        return Opened::Malformed;
    };
    let (nonce, ct) = enc[1..].split_at(12);
    let Ok(pt) = Aes256Gcm::new(keys.doc_key().into())
        .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad: &ad })
    else {
        return Opened::Unreadable(Unreadable::BadTag);
    };
    let pt = zeroize::Zeroizing::new(pt);
    let Some(c) = parse(&d.bind, &pt) else {
        return Opened::Malformed;
    };
    if ctx.burned.contains(&epoch) && !ctx.members.contains(&d.owner_id) {
        return Opened::Unreadable(Unreadable::Late);
    }
    Opened::Readable(c)
}

#[cfg(test)]
mod conformance;
