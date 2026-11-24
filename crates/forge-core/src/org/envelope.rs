//! `dti/1` envelopes: `{ v: 1, room, type, from, at, body, sig }`, Ed25519-signed over
//! `"dti/1|envelope|" ‖ canonical({v, room, type, from, at, body})`, identified by the SHA-256
//! of the whole envelope's canonical form.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::ChaCha20Poly1305;
use ed25519_dalek::{Signature, Signer as _, Verifier as _, VerifyingKey};
use hkdf::Hkdf;
use serde_json::{json, Map, Value};
use sha2::Sha256;
use x25519_dalek::PublicKey as XPublic;
use zeroize::Zeroizing;

use super::canon::{canonical, digest, int_of, js_len};
use super::derive::{length_prefixed, MemberKeys, Part};
use super::OrgError;

pub const PROTOCOL: &str = "dti/1";
const MAX_BODY: usize = 256 * 1024;

fn signing_bytes(unsigned: &Value) -> Result<Vec<u8>, OrgError> {
    Ok(format!("{PROTOCOL}|envelope|{}", canonical(unsigned)?).into_bytes())
}

/// Seal `body` as a `kind` message from `keys` in `room`, stamped `at` (ISO-8601 UTC).
pub fn seal(
    keys: &MemberKeys,
    room: &str,
    kind: &str,
    body: Value,
    at: &str,
) -> Result<Value, OrgError> {
    let mut unsigned = json!({
        "v": 1,
        "room": room,
        "type": kind,
        "from": keys.auth_pub,
        "at": at,
    });
    unsigned["body"] = body;
    let sig = keys.auth().sign(&signing_bytes(&unsigned)?);
    unsigned["sig"] = Value::String(hex::encode(sig.to_bytes()));
    Ok(unsigned)
}

/// The envelope's id: SHA-256 of its canonical form, hex.
pub fn id(envelope: &Value) -> Result<String, OrgError> {
    Ok(digest(envelope)?)
}

/// Lower-case hex of exactly `bytes` bytes (any even length when `None`).
pub fn is_hex(s: &str, bytes: Option<usize>) -> bool {
    s.len().is_multiple_of(2)
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && bytes.is_none_or(|n| s.len() == n * 2)
}

pub fn is_hex_value(v: &Value, bytes: Option<usize>) -> bool {
    v.as_str().is_some_and(|s| is_hex(s, bytes))
}

/// `YYYY-MM-DDTHH:MM:SS(.f{1,6})?Z`.
pub fn valid_at(at: &str) -> bool {
    let b = at.as_bytes();
    let digits =
        |r: std::ops::Range<usize>| b.get(r).is_some_and(|s| s.iter().all(u8::is_ascii_digit));
    if b.len() < 20 || !digits(0..4) || !digits(5..7) || !digits(8..10) || !digits(11..13) {
        return false;
    }
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return false;
    }
    if !digits(14..16) || !digits(17..19) || b[b.len() - 1] != b'Z' {
        return false;
    }
    match b.len() - 20 {
        0 => true,
        n => b[19] == b'.' && (2..=7).contains(&n) && digits(20..b.len() - 1),
    }
}

/// Whether `envelope` is a well-formed `dti/1` envelope with a valid signature.
pub fn verify(envelope: &Value) -> bool {
    let Some(obj) = envelope.as_object() else {
        return false;
    };
    let mut unsigned: Map<String, Value> = obj.clone();
    let sig = unsigned.remove("sig");
    if int_of(unsigned.get("v").unwrap_or(&Value::Null)) != Some(1) {
        return false;
    }
    if !unsigned.get("type").is_some_and(Value::is_string)
        || !unsigned.get("room").is_some_and(Value::is_string)
    {
        return false;
    }
    if !unsigned
        .get("at")
        .and_then(Value::as_str)
        .is_some_and(valid_at)
    {
        return false;
    }
    let (Some(from), Some(sig)) = (
        unsigned.get("from").and_then(Value::as_str),
        sig.as_ref().and_then(Value::as_str),
    ) else {
        return false;
    };
    if !is_hex(from, Some(32)) || !is_hex(sig, Some(64)) {
        return false;
    }
    let Some(body) = unsigned.get("body") else {
        return false;
    };
    match canonical(body) {
        Ok(c) if js_len(&c) <= MAX_BODY => {}
        _ => return false,
    }
    let from: [u8; 32] = hex::decode(from)
        .ok()
        .and_then(|b| b.try_into().ok())
        .unwrap_or([0; 32]);
    let sig: [u8; 64] = hex::decode(sig)
        .ok()
        .and_then(|b| b.try_into().ok())
        .unwrap_or([0; 64]);
    let Ok(key) = VerifyingKey::from_bytes(&from) else {
        return false;
    };
    let Ok(message) = signing_bytes(&Value::Object(unsigned)) else {
        return false;
    };
    key.verify(&message, &Signature::from_bytes(&sig)).is_ok()
}

/// The box context of a DKG share sent from member `from` to member `to`.
pub fn box_context<'a>(
    cid: &'a str,
    slot: &'a str,
    from: u32,
    to: u32,
    from_transport: &'a str,
    to_transport: &'a str,
) -> [Part<'a>; 7] {
    [
        Part::Text("dkg-share"),
        Part::Text(cid),
        Part::Text(slot),
        Part::Num(from),
        Part::Num(to),
        Part::Text(from_transport),
        Part::Text(to_transport),
    ]
}

/// Decrypt a share box addressed to `keys` from the member with transport key `their_pub`.
pub fn open_box(
    keys: &MemberKeys,
    their_pub: &str,
    context: &[Part<'_>],
    ciphertext_hex: &str,
) -> Option<Zeroizing<String>> {
    let their: [u8; 32] = hex::decode(their_pub).ok()?.try_into().ok()?;
    let shared = keys.transport().diffie_hellman(&XPublic::from(their));
    if shared.as_bytes().iter().all(|b| *b == 0) {
        return None;
    }
    let mut okm = Zeroizing::new([0u8; 44]);
    Hkdf::<Sha256>::new(
        Some(format!("{PROTOCOL}/box").as_bytes()),
        shared.as_bytes(),
    )
    .expand(&length_prefixed(context), okm.as_mut())
    .ok()?;
    let mut aad_parts = vec![Part::Text("aad")];
    aad_parts.extend_from_slice(context);
    let cipher = ChaCha20Poly1305::new_from_slice(&okm[..32]).ok()?;
    let plain = cipher
        .decrypt(
            okm[32..44].into(),
            Payload {
                msg: &hex::decode(ciphertext_hex).ok()?,
                aad: &length_prefixed(&aad_parts),
            },
        )
        .ok()?;
    String::from_utf8(plain).ok().map(Zeroizing::new)
}

/// The current time as `dti` stamps it (`Date.prototype.toISOString`).
pub fn now_iso() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    iso_from_ms(ms)
}

fn iso_from_ms(ms: u128) -> String {
    let secs = i64::try_from(ms / 1000).unwrap_or(0);
    let millis = ms % 1000;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        rem / 60 % 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_time_as_javascript_does() {
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(1_795_548_631_505), "2026-11-24T19:30:31.505Z");
        assert!(valid_at(&now_iso()));
    }

    #[test]
    fn checks_timestamps() {
        assert!(valid_at("2026-11-24T19:30:31Z"));
        assert!(valid_at("2026-11-24T19:30:31.123456Z"));
        assert!(!valid_at("2026-11-24T19:30:31.1234567Z"));
        assert!(!valid_at("2026-11-24T19:30:31.Z"));
        assert!(!valid_at("2026-11-24 19:30:31Z"));
    }
}
