//! The mainnet fields clients write and read (mixed-visibility DESIGN §4.11, §8.3 items 1, 4, 6,
//! 9 and 10; phase M-B part 2): `aud` and `mRole` on issues, PRs, comments and reviews, `tAud` on
//! events and author events, and the `r` of a maintainer-only pack manifest.
//!
//! Every field is written only where the loaded contract declares it (feature detection,
//! [`Shape`]): sakura's three-contract set declares none, so a client writes the same documents
//! there as before. The vectors (`forge-contracts/vectors/aud__*.json`, from
//! `tools/private-repos-vectors/aud.py`) judge both shapes; the web's twin is `lib/rules/aud.ts`.

use serde::{Deserialize, Serialize};

use super::v2::Role;

/// What the loaded contracts declare of the mainnet fields (the vectors' `input.shape`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(clippy::struct_excessive_bools)] // one flag per declared contract feature
pub struct Shape {
    /// The content type declares `aud` (L1, `mainnet_aud`).
    #[serde(default)]
    pub aud: bool,
    /// The content type declares `mRole` (L2, `mainnet_member_role`).
    #[serde(default)]
    pub m_role: bool,
    /// `event` / `authorEvent` declares `tAud` (M4, M3).
    #[serde(default)]
    pub t_aud: bool,
    /// `authorEvent` declares `enc` (M3, `mainnet_author_event_enc`).
    #[serde(default)]
    pub author_enc: bool,
    /// `packManifest.r` admits 0 (C3, `mainnet_maint_kinds`).
    #[serde(default)]
    pub maint_kinds: bool,
}

/// The `aud` of members-only content (`enc` v0x01, v0x03, v0x05).
pub const AUD_MEMBERS: u64 = 1;
/// The `aud` of a letter (`enc` v0x04).
pub const AUD_LETTER: u64 = 2;

/// The pack-manifest kinds only a maintainer writes on mainnet (C3): a make-public bundle (7),
/// an environment snapshot (8), the reserved kind 9 and an access notice (11).
pub const MAINTAINER_KINDS: [u64; 4] = [7, 8, 9, 11];

/// The `aud` an `enc` of `version` states, or `None` for a version no content document carries
/// (a config's 0x02, a narrower branch's 0x06, anything unknown).
#[must_use]
pub fn aud_of_version(version: u8) -> Option<u64> {
    match version {
        0x01 | 0x03 | 0x05 => Some(AUD_MEMBERS),
        0x04 => Some(AUD_LETTER),
        _ => None,
    }
}

/// The `aud` and `mRole` a content write carries (the vectors' `content` op). `None` = absent:
/// left out of a create, removed by a replace.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentFields {
    /// `aud`.
    pub aud: Option<u64>,
    /// `mRole`.
    pub m_role: Option<u64>,
}

/// Why a content write's fields cannot be stated: its `enc` is of a version no content document
/// carries. Refused before signing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContentRefusal {
    /// The `enc` version is not 0x01, 0x03, 0x04 or 0x05.
    UnknownEnc,
}

/// The `aud` and `mRole` an issue, PR, comment or review carries, from the document as it will
/// be stored (a replace's changes applied): `enc_version` its `enc`'s first byte, `as_member`
/// whether it carries `asMember`, and `role` the signer's current role. `aud` follows the
/// version byte and is absent exactly when `enc` is (DESIGN §4.11: the author's replace may only
/// drop it); `mRole` restates the signer's `writer` row role whenever the document carries
/// `asMember` (the reference is re-checked with `where {"role": "mRole"}` on every replace), and
/// a maintainer, whose operand checks no role, leaves it out.
///
/// # Errors
/// [`ContentRefusal::UnknownEnc`] for an `enc` of another version.
pub fn content_fields(
    shape: Shape,
    enc_version: Option<u8>,
    as_member: bool,
    role: Option<Role>,
) -> Result<ContentFields, ContentRefusal> {
    let aud = enc_version
        .map(|v| aud_of_version(v).ok_or(ContentRefusal::UnknownEnc))
        .transpose()?;
    Ok(ContentFields {
        aud: aud.filter(|_| shape.aud),
        m_role: role
            .filter(|_| shape.m_role && as_member)
            .and_then(Role::writer_role_code),
    })
}

/// Whether a stored document's `aud` agrees with its `enc` (the vectors' `read` op). A document
/// without `aud` is judged by `enc` alone (sakura's, or written before the registration); `aud`
/// without `enc`, outside 1..2, or naming the other class than `enc`'s version is malformed, and
/// readers show the document as a placeholder, never as text.
#[must_use]
pub fn aud_agrees(aud: Option<u64>, enc_version: Option<u8>) -> bool {
    match (aud, enc_version) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(a), Some(v)) => aud_of_version(v) == Some(a),
    }
}

/// An `event`'s or `authorEvent`'s target, as [`event_fields`] reads it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventTarget {
    /// The target's stored `aud`.
    #[serde(default)]
    pub aud: Option<u64>,
    /// Its `enc`'s version byte, when sealed.
    #[serde(default, with = "enc_hex")]
    pub enc: Option<u8>,
    /// A maintainer's bundle made its current revision public.
    #[serde(default)]
    pub bundled: bool,
}

impl EventTarget {
    /// The target is a letter (a message to specific people): `aud` 2, or an `enc` of v0x04.
    #[must_use]
    pub fn is_letter(self) -> bool {
        self.aud == Some(AUD_LETTER) || self.enc == Some(0x04)
    }
}

/// What happens to an event's `value`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EventValue {
    /// The event carries no value.
    None,
    /// Plaintext: the target is public.
    Plain,
    /// Sealed under the members key, as its target is.
    Sealed,
    /// Refused before signing: the target is a letter (an event names no recipients), or an
    /// author event's value on a members-only target where `authorEvent` has no `enc`.
    Refused,
}

/// The `tAud` and the value's treatment of an event (the vectors' `event` op).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventFields {
    /// `tAud`: the target's stored `aud` where the contract declares it.
    pub t_aud: Option<u64>,
    /// The value.
    pub value: EventValue,
}

/// The `tAud` an event (`author` for an `authorEvent`) on `target` carries, and what happens to
/// its value (`has_value`). `tAud` is the target's stored `aud` (both `targetId` operands `where
/// {"aud": "tAud"}`: an absent `aud` and an absent `tAud` agree); a value is plaintext on a
/// public target, sealed on a members-only one (on mainnet also after a maintainer's bundle,
/// whose target keeps `aud = 1`, so `tAudSealed` refuses a plaintext value), and refused on a
/// letter; an author event seals only where `authorEvent` declares `enc`.
#[must_use]
pub fn event_fields(
    shape: Shape,
    author: bool,
    target: EventTarget,
    has_value: bool,
) -> EventFields {
    let t_aud = target.aud.filter(|_| shape.t_aud);
    let sealed_target = target.enc.is_some() || target.aud.is_some();
    let value = if !has_value {
        EventValue::None
    } else if !sealed_target || (target.bundled && t_aud.is_none()) {
        EventValue::Plain
    } else if target.is_letter() || (author && !shape.author_enc) {
        EventValue::Refused
    } else {
        EventValue::Sealed
    };
    EventFields { t_aud, value }
}

/// The `r` a pack manifest of `kind` claims (the vectors' `manifestR` op): 0 for a maintainer-only
/// kind where the contract admits it (only the maintainer operand passes `r = 0`), else `claimed`.
#[must_use]
pub fn manifest_r(shape: Shape, kind: u64, claimed: u64) -> u64 {
    if shape.maint_kinds && MAINTAINER_KINDS.contains(&kind) {
        0
    } else {
        claimed
    }
}

/// `enc` in a vector: hex, of which only the version byte matters here.
mod enc_hex {
    use serde::{Deserialize, Deserializer, Serializer};

    #[allow(clippy::ref_option, clippy::trivially_copy_pass_by_ref)] // serde's `with` signature
    pub fn serialize<S: Serializer>(v: &Option<u8>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(b) => s.serialize_str(&format!("{b:02x}")),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u8>, D::Error> {
        let s: Option<String> = Option::deserialize(d)?;
        s.filter(|s| !s.is_empty())
            .map(|s| u8::from_str_radix(&s[..2.min(s.len())], 16).map_err(serde::de::Error::custom))
            .transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAINNET: Shape = Shape {
        aud: true,
        m_role: true,
        t_aud: true,
        author_enc: true,
        maint_kinds: true,
    };

    #[test]
    fn sakura_writes_none_of_the_fields() {
        let got = content_fields(Shape::default(), Some(0x03), true, Some(Role::Writer));
        assert_eq!(got, Ok(ContentFields::default()));
        assert_eq!(manifest_r(Shape::default(), 8, 1), 1);
    }

    #[test]
    fn mainnet_states_the_class_and_the_role() {
        let got = content_fields(MAINNET, Some(0x04), true, Some(Role::Triage)).unwrap();
        assert_eq!((got.aud, got.m_role), (Some(2), Some(2)));
        let maint = content_fields(MAINNET, Some(0x03), true, Some(Role::Maintainer)).unwrap();
        assert_eq!((maint.aud, maint.m_role), (Some(1), None));
        assert_eq!(
            content_fields(MAINNET, Some(0x02), true, None),
            Err(ContentRefusal::UnknownEnc)
        );
    }
}
