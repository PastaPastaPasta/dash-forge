//! A bot's members-only posts (`enc` v0x05; mixed-visibility DESIGN §4.9 "Envelope v0x05",
//! `docs/security/private-repos.md` §23) and the `postKey` key letter that carries a bot's post
//! key.
//!
//! A bot (a role-4 `writer` row, mainnet only) never holds the members key (L4). A maintainer
//! gives it a **post key** per epoch instead, derived from the epoch key and the bot's identity:
//!
//! ```text
//! W_{e,b}  = HKDF-Expand(PRK_e, "dash-forge/v2/bot-post" ‖ 0x00 ‖ u32(e) ‖ botId(32), 32)
//! PRK_b    = HKDF-Extract(salt = repoId, IKM = W_{e,b})
//! K_obj    = HKDF-Expand(PRK_b, "dash-forge/v2/obj" ‖ 0x00 ‖ u32(e) ‖ nonce ‖ SHA-256(AD), 32)
//! enc      = 0x05 ‖ nonce(12) ‖ COMMIT_obj(32) ‖ AES-256-GCM(K_doc,obj, nonce, TLV, AD') ‖ tag(16)
//! ```
//!
//! `PRK_obj`, `K_doc,obj`, `COMMIT_obj`, `AD' = AD(enc[0] = 0x05) ‖ COMMIT_obj`, the TLV and its
//! padding are exactly v0x03's. Members derive `W_{e,b}` from `PRK_e` and the document's
//! `$ownerId`; a reader opens a v0x05 document only when that `$ownerId` holds a Bot row of the
//! repository now ([`super::doc::OpenContext::bots`]). The AD binds the owner, so a post key
//! opens, and mints, only its own bot's documents; a bot can never derive `PRK_e`. Each post's
//! `K_obj` is per object, so a maintainer can make one public with a bundle.
//!
//! The writer's nonce is hedged as §3.6's, under the bot's own hedge key
//! `K_hedge,b = HKDF-Expand(PRK_b, "dash-forge/v2/hedge" ‖ 0x00 ‖ u32(e), 32)` (the bot holds no
//! `K_hedge,e`): `nonce = HMAC(K_hedge,b, 0x02 ‖ rnd(32) ‖ AD ‖ SHA-256(TLV))[0..12]`. Readers
//! never check how a nonce was made.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use super::doc::{self, DocHeader, Opened, Unreadable, MIN_V3, NONCE_LEN};
use super::key_letter::TypedLetter;
use super::keys::{ct_eq, rnd32, sha256, EpochKeys, ObjKeys};
use super::tlv::{self, Fields};
use super::{DocKind, PrivateError};
use crate::rules::v2::Visibility;

/// `enc` version of a bot's members-only post.
pub const V5: u8 = 0x05;
/// `"type": "postKey"`: a bot's post key for one epoch.
pub const TYPE_POST_KEY: &str = "postKey";
/// The case of the `bot_post__*` conformance vectors (the rules harnesses skip it).
pub const VECTOR_CASE: &str = "bot_post";

/// The kinds a bot posts members-only: issues, comments and reviews. A pull request names its
/// branches by keys of the epoch (a bot holds none), an event or a ref update is never a bot's
/// members-only write.
#[must_use]
pub fn posts_kind(kind: DocKind) -> bool {
    matches!(kind, DocKind::Issue | DocKind::Comment | DocKind::Review)
}

/// The post key `W_{e,b}` of one bot for one epoch of one repository, with the keys it derives.
/// Zeroized on drop; `Debug` shows the epoch only.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct PostKey {
    #[zeroize(skip)]
    repo_id: [u8; 32],
    #[zeroize(skip)]
    epoch: u32,
    #[zeroize(skip)]
    bot: [u8; 32],
    w: [u8; 32],
    prk: [u8; 32],
    hedge: [u8; 32],
}

impl std::fmt::Debug for PostKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PostKey")
            .field("epoch", &self.epoch)
            .finish_non_exhaustive()
    }
}

impl PostKey {
    /// The keys of `w`, the post key of `bot` for `epoch` of the repository `repo_id` (what a
    /// `postKey` letter carries).
    #[must_use]
    pub fn new(repo_id: &[u8; 32], epoch: u32, bot: &[u8; 32], w: &[u8; 32]) -> Self {
        let (prk, _) = Hkdf::<Sha256>::extract(Some(repo_id), w);
        let mut k = Self {
            repo_id: *repo_id,
            epoch,
            bot: *bot,
            w: *w,
            prk: prk.into(),
            hedge: [0; 32],
        };
        k.hedge = *k.expand("hedge", &[]);
        k
    }

    /// The post key of `bot` under the epoch keys `keys`: what members derive to open the bot's
    /// posts, and what a maintainer sends the bot.
    #[must_use]
    pub fn derive(keys: &EpochKeys, bot: &[u8; 32]) -> Self {
        Self::new(keys.repo_id(), keys.epoch(), bot, &keys.bot_post_key(bot))
    }

    /// `W_{e,b}` itself: what a `postKey` letter carries.
    #[must_use]
    pub fn key(&self) -> &[u8; 32] {
        &self.w
    }

    /// The epoch.
    #[must_use]
    pub fn epoch(&self) -> u32 {
        self.epoch
    }

    /// The bot whose posts it opens.
    #[must_use]
    pub fn bot(&self) -> &[u8; 32] {
        &self.bot
    }

    fn expand(&self, label: &str, extra: &[u8]) -> Zeroizing<[u8; 32]> {
        let hk = Hkdf::<Sha256>::from_prk(&self.prk).expect("a 32-byte PRK is a valid HKDF PRK");
        let mut info = Vec::with_capacity(14 + label.len() + 5 + extra.len());
        info.extend_from_slice(b"dash-forge/v2/");
        info.extend_from_slice(label.as_bytes());
        info.push(0);
        info.extend_from_slice(&self.epoch.to_be_bytes());
        info.extend_from_slice(extra);
        let mut okm = Zeroizing::new([0u8; 32]);
        hk.expand(&info, okm.as_mut())
            .expect("32 bytes is a valid HKDF-SHA256 output length");
        okm
    }

    /// `K_obj = HKDF-Expand(PRK_b, "dash-forge/v2/obj" ‖ 0x00 ‖ u32(e) ‖ nonce ‖ SHA-256(AD), 32)`.
    fn obj_key(&self, nonce: &[u8; NONCE_LEN], ad: &[u8]) -> Zeroizing<[u8; 32]> {
        let mut extra = [0u8; NONCE_LEN + 32];
        extra[..NONCE_LEN].copy_from_slice(nonce);
        extra[NONCE_LEN..].copy_from_slice(&sha256(ad));
        self.expand("obj", &extra)
    }

    fn hedged_nonce(&self, rnd: &[u8; 32], ad: &[u8], pt: &[u8]) -> [u8; NONCE_LEN] {
        let mut mac =
            <Hmac<Sha256> as Mac>::new_from_slice(&self.hedge).expect("HMAC takes any key length");
        for p in [&[0x02][..], rnd, ad, &sha256(pt)] {
            mac.update(p);
        }
        let mut n = [0u8; NONCE_LEN];
        n.copy_from_slice(&mac.finalize().into_bytes()[..NONCE_LEN]);
        n
    }

    /// Whether this key is the one `header` is sealed under: its bot and its epoch.
    fn fits(&self, header: &DocHeader) -> bool {
        header.owner_id == self.bot && header.epoch == self.epoch
    }
}

/// Seal `fields` as the bot's members-only post `header` (`enc` v0x05) under its post key
/// `post`, with a hedged random nonce. Refused (`Malformed`) when `header` is not the bot's own
/// document under the key's epoch, or not an issue, comment or review; `TooLarge` past v0x03's
/// room.
pub fn seal(post: &PostKey, header: &DocHeader, fields: &Fields) -> Result<Vec<u8>, PrivateError> {
    let rnd = rnd32()?;
    seal_inner(post, header, fields, |ad, pt| {
        post.hedged_nonce(&rnd, ad, pt)
    })
}

/// [`seal`] with a caller-chosen nonce: the conformance vectors only.
#[cfg(any(test, feature = "vectors"))]
pub fn seal_with_nonce(
    post: &PostKey,
    header: &DocHeader,
    fields: &Fields,
    nonce: [u8; NONCE_LEN],
) -> Result<Vec<u8>, PrivateError> {
    seal_inner(post, header, fields, |_, _| nonce)
}

/// The TLV parse a bot's post of `header` gets: a public repository's members-only form (whose
/// reserved tags stay reserved), else a private repository's.
fn parse(header: &DocHeader, pt: &[u8]) -> Option<Fields> {
    if header.vis == Visibility::Public {
        tlv::parse_members(pt, header.kind)
    } else {
        tlv::parse(pt, header.kind, false)
    }
}

fn seal_inner(
    post: &PostKey,
    header: &DocHeader,
    fields: &Fields,
    nonce: impl FnOnce(&[u8], &[u8]) -> [u8; NONCE_LEN],
) -> Result<Vec<u8>, PrivateError> {
    if !post.fits(header) || !posts_kind(header.kind) {
        return Err(PrivateError::Malformed);
    }
    let records = tlv::encode(fields);
    // a writer never emits what a reader refuses
    parse(header, &records).ok_or(PrivateError::Malformed)?;
    let max = header.kind.max_enc() - MIN_V3;
    if records.len() > max {
        return Err(PrivateError::TooLarge(header.kind.type_name(), max));
    }
    let pt = doc::padded(header.kind, &records, max);
    let ad = header
        .ad_in(&post.repo_id, V5)
        .ok_or(PrivateError::Malformed)?;
    let n = nonce(&ad, &pt);
    let obj = ObjKeys::derive(&post.repo_id, &post.obj_key(&n, &ad));
    let mut ad2 = ad;
    ad2.extend_from_slice(obj.commit());
    let ct = Aes256Gcm::new(obj.doc_key().into())
        .encrypt(
            Nonce::from_slice(&n),
            Payload {
                msg: &pt,
                aad: &ad2,
            },
        )
        .map_err(|_| PrivateError::Malformed)?;
    let mut enc = Vec::with_capacity(MIN_V3 + pt.len());
    enc.push(V5);
    enc.extend_from_slice(&n);
    enc.extend_from_slice(obj.commit());
    enc.extend_from_slice(&ct);
    Ok(enc)
}

/// Step 1 of §8.1 for v0x05: the version byte, at least v0x03's 61 bytes, and a kind bots post.
#[must_use]
pub fn well_framed(header: &DocHeader, enc: &[u8]) -> bool {
    enc.first() == Some(&V5) && enc.len() >= MIN_V3 && posts_kind(header.kind)
}

/// `K_obj` and the parts of a well-framed v0x05 `enc` of `header` under `post`, checked against
/// the commitment it carries (`None`: another key made it).
fn checked_obj_key(
    post: &PostKey,
    header: &DocHeader,
    enc: &[u8],
) -> Result<(Zeroizing<[u8; 32]>, Vec<u8>), Unreadable> {
    let ad = header
        .ad_in(&post.repo_id, V5)
        .ok_or(Unreadable::CommitMismatch)?;
    let nonce: [u8; NONCE_LEN] = enc[1..=NONCE_LEN].try_into().expect("framed");
    let k_obj = post.obj_key(&nonce, &ad);
    let commit = &enc[1 + NONCE_LEN..1 + NONCE_LEN + 32];
    if ct_eq(ObjKeys::derive(&post.repo_id, &k_obj).commit(), commit) {
        Ok((k_obj, ad))
    } else {
        Err(Unreadable::CommitMismatch)
    }
}

/// Open the bot's post `header` with its post key `post` (the bot reading its own posts, or a
/// member with [`PostKey::derive`]): the framing, the key's bot and epoch (another bot's or
/// epoch's post is `Unreadable(NoKey)`), `COMMIT_obj` compared before GCM runs
/// (`CommitMismatch`), GCM (`BadTag`), then the TLV. Who may post v0x05 at all (a Bot row of
/// the repository) is the reading layer's check ([`super::doc::open_content`]).
#[must_use]
pub fn open(post: &PostKey, header: &DocHeader, enc: &[u8]) -> Opened {
    if !well_framed(header, enc) {
        return Opened::Malformed;
    }
    if !post.fits(header) {
        return Opened::Unreadable(Unreadable::NoKey);
    }
    let (k_obj, ad) = match checked_obj_key(post, header, enc) {
        Ok(k) => k,
        Err(u) => return Opened::Unreadable(u),
    };
    let nonce = &enc[1..=NONCE_LEN];
    let (commit, ct) = enc[1 + NONCE_LEN..].split_at(32);
    let obj = ObjKeys::derive(&post.repo_id, &k_obj);
    let mut ad2 = ad;
    ad2.extend_from_slice(commit);
    let Ok(pt) = Aes256Gcm::new(obj.doc_key().into())
        .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad: &ad2 })
    else {
        return Opened::Unreadable(Unreadable::BadTag);
    };
    let pt = Zeroizing::new(pt);
    match parse(header, &pt) {
        Some(fields) => Opened::Readable(Box::new(fields)),
        None => Opened::Malformed,
    }
}

/// `K_obj` of the bot's post `header` under `post`, checked against its commitment: what a
/// maintainer's bundle or a read letter shares. `None` when it is not a well-framed v0x05
/// document of `post`'s bot and epoch, or the key does not commit.
#[must_use]
pub fn obj_key(post: &PostKey, header: &DocHeader, enc: &[u8]) -> Option<Zeroizing<[u8; 32]>> {
    if !well_framed(header, enc) || !post.fits(header) {
        return None;
    }
    checked_obj_key(post, header, enc).ok().map(|(k, _)| k)
}

/// A `postKey` letter (`private-repos.md` §23.2): a bot's post key for one epoch, from a
/// maintainer.
///
/// ```text
/// {"epoch":7,"key":"<64 hex>","type":"postKey","v":1}
/// ```
#[derive(Clone, PartialEq, Eq)]
pub struct PostKeyLetter {
    /// The epoch the key is for.
    pub epoch: u32,
    /// `W_{e,b}`.
    pub key: Zeroizing<[u8; 32]>,
}

/// It carries a key: `Debug` shows the epoch only.
impl std::fmt::Debug for PostKeyLetter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PostKeyLetter")
            .field("epoch", &self.epoch)
            .finish_non_exhaustive()
    }
}

impl PostKeyLetter {
    /// The letter of `post`.
    #[must_use]
    pub fn of(post: &PostKey) -> Self {
        Self {
            epoch: post.epoch,
            key: Zeroizing::new(post.w),
        }
    }

    /// The typed letter.
    #[must_use]
    pub fn to_typed(&self) -> TypedLetter {
        let mut t = TypedLetter::new(TYPE_POST_KEY, 1);
        t.fields
            .insert("epoch".into(), Value::from(u64::from(self.epoch)));
        t.fields
            .insert("key".into(), Value::String(hex::encode(*self.key)));
        t
    }

    /// A `postKey` letter of version 1, or `None`: another type or version, a missing or
    /// unknown field, an epoch past `u32`, a key that is not 64 lowercase hex characters.
    #[must_use]
    pub fn from_typed(t: &TypedLetter) -> Option<Self> {
        if t.kind != TYPE_POST_KEY || t.v != 1 || t.fields.len() != 2 {
            return None;
        }
        Some(Self {
            epoch: u32::try_from(t.fields.get("epoch")?.as_u64()?).ok()?,
            key: Zeroizing::new(super::key_letter::hex32(t.fields.get("key")?)?),
        })
    }

    /// The post key it carries for `bot` in the repository `repo_id`.
    #[must_use]
    pub fn post_key(&self, repo_id: &[u8; 32], bot: &[u8; 32]) -> PostKey {
        PostKey::new(repo_id, self.epoch, bot, &self.key)
    }
}

#[cfg(test)]
mod conformance;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::private::EpochKey;

    const REPO: [u8; 32] = [0x11; 32];
    const BOT: [u8; 32] = [0xb0; 32];

    fn keys() -> EpochKeys {
        EpochKeys::derive(&REPO, 3, &EpochKey::from_bytes([0x42; 32]))
    }

    fn header(owner: [u8; 32]) -> DocHeader {
        let mut h = DocHeader::new(DocKind::Comment, owner, 3);
        h.vis = Visibility::Public;
        h.target_id = Some([0x33; 32]);
        h
    }

    fn body(text: &str) -> Fields {
        Fields {
            body: Some(text.into()),
            ..Fields::default()
        }
    }

    #[test]
    fn the_bot_and_members_open_the_same_post() {
        let members = PostKey::derive(&keys(), &BOT);
        let letter = PostKeyLetter::from_typed(&PostKeyLetter::of(&members).to_typed()).unwrap();
        let bot = letter.post_key(&REPO, &BOT);
        let enc = seal(&bot, &header(BOT), &body("the build is green")).unwrap();
        assert_eq!(enc[0], V5);
        for k in [&bot, &members] {
            assert_eq!(
                open(k, &header(BOT), &enc),
                Opened::Readable(Box::new(body("the build is green")))
            );
        }
        assert!(obj_key(&members, &header(BOT), &enc).is_some());
    }

    #[test]
    fn a_post_key_seals_only_its_own_bot_and_epoch() {
        let post = PostKey::derive(&keys(), &BOT);
        let other = [0xb1; 32];
        assert_eq!(
            seal(&post, &header(other), &body("x")),
            Err(PrivateError::Malformed)
        );
        let mut later = header(BOT);
        later.epoch = 4;
        assert_eq!(
            seal(&post, &later, &body("x")),
            Err(PrivateError::Malformed)
        );
        let mut pr = header(BOT);
        pr.kind = DocKind::Patch;
        assert_eq!(seal(&post, &pr, &body("x")), Err(PrivateError::Malformed));
        let enc = seal(&post, &header(BOT), &body("x")).unwrap();
        let theirs = PostKey::derive(&keys(), &other);
        assert_eq!(
            open(&theirs, &header(BOT), &enc),
            Opened::Unreadable(Unreadable::NoKey)
        );
    }

    #[test]
    fn a_bundle_publishes_one_bot_post() {
        use crate::private::bundle::{read_revision, BundleRead, DocEntry};
        let post = PostKey::derive(&keys(), &BOT);
        let enc = seal(&post, &header(BOT), &body("made public")).unwrap();
        let k = crate::private::doc::members_obj_key(&keys(), &header(BOT), &enc).unwrap();
        let entry = DocEntry {
            by: [0x22; 32],
            revision: 1,
            key: crate::private::EpochKey::from_bytes(*k),
        };
        let (read, mismatches) = read_revision(&REPO, &header(BOT), 1, &enc, &[entry]);
        assert!(mismatches.is_empty());
        assert!(
            matches!(read, BundleRead::Public { fields, .. } if *fields == body("made public"))
        );
    }

    #[test]
    fn debug_never_shows_the_key() {
        let post = PostKey::derive(&keys(), &BOT);
        let shown = format!("{post:?} {:?}", PostKeyLetter::of(&post));
        assert!(!shown.contains(&hex::encode(post.key())[..8]), "{shown}");
    }
}
