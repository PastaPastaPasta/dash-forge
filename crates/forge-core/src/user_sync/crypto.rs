//! The forge-user encryption (`docs/design/identity-synced-state.md` §4). The normative
//! definitions are `tools/user-sync-vectors/gen.py` and its output,
//! `forge-contracts/fixtures/user-sync/vectors.json`, which the tests below reproduce.

use std::io::{Read as _, Write as _};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use secp256k1::{PublicKey, SecretKey};
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::app_connect::SecretBytes;
use crate::error::{Error, Result};

/// The size of each `d0`/`d1`/`d2` piece.
pub const PIECE: usize = 5000;
/// At most three pieces.
pub const MAX_PIECES: usize = 3;
/// The state format this client writes (`v`).
pub const STATE_V: u8 = 1;
/// A grant's `wrapped`: nonce, the 32-byte RSK, the tag.
pub const WRAPPED_LEN: usize = 12 + 32 + 16;

const DOMAIN: &[u8] = b"forge-user/v1";
/// The most a deflated JSON may inflate to (a state is at most 15,000 bytes of ciphertext).
const MAX_INFLATED: u64 = 4 << 20;

/// A 32-byte symmetric key, wiped on drop and never printed.
pub type Key32 = Zeroizing<[u8; 32]>;

fn lp(s: &str) -> Result<Vec<u8>> {
    let b = s.as_bytes();
    let n = u8::try_from(b.len())
        .map_err(|_| Error::InvalidInput("a forge-user label is over 255 bytes".into()))?;
    let mut out = Vec::with_capacity(b.len() + 1);
    out.push(n);
    out.extend_from_slice(b);
    Ok(out)
}

fn hkdf(ikm: &[u8], salt: &[u8], info: &[u8]) -> Key32 {
    let mut out = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(salt), ikm)
        .expand(info, out.as_mut())
        .expect("32 bytes is a valid HKDF-SHA256 length");
    out
}

/// `K = HKDF(E, identityId, "forge-user/v1/state/" ‖ network ‖ "/" ‖ slot)`.
pub fn state_key(e: &SecretBytes, identity: &[u8; 32], network: &str, slot: &str) -> Key32 {
    let info = [
        b"forge-user/v1/state/".as_slice(),
        network.as_bytes(),
        b"/",
        slot.as_bytes(),
    ]
    .concat();
    hkdf(e.expose(), identity, &info)
}

/// `"forge-user/v1" ‖ lp(network) ‖ identityId ‖ lp(slot) ‖ u8(v) ‖ u32(keyId)`.
pub fn state_aad(
    network: &str,
    identity: &[u8; 32],
    slot: &str,
    v: u8,
    key_id: u32,
) -> Result<Vec<u8>> {
    Ok([
        DOMAIN,
        &lp(network)?,
        identity,
        &lp(slot)?,
        &[v],
        &key_id.to_be_bytes(),
    ]
    .concat())
}

/// `RSK(repo, epoch) = HKDF(E_owner, repoId, "forge-user/v1/repo-storage/" ‖ network ‖ "/" ‖ u32(epoch))`.
pub fn repo_storage_key(e: &SecretBytes, repo: &[u8; 32], network: &str, epoch: u32) -> Key32 {
    let info = [
        b"forge-user/v1/repo-storage/".as_slice(),
        network.as_bytes(),
        b"/",
        &epoch.to_be_bytes(),
    ]
    .concat();
    hkdf(e.expose(), repo, &info)
}

/// `"forge-user/v1/share" ‖ lp(network) ‖ repoId ‖ u32(epoch) ‖ u32(keyId)`.
pub fn share_aad(network: &str, repo: &[u8; 32], epoch: u32, key_id: u32) -> Result<Vec<u8>> {
    Ok([
        b"forge-user/v1/share".as_slice(),
        &lp(network)?,
        repo,
        &epoch.to_be_bytes(),
        &key_id.to_be_bytes(),
    ]
    .concat())
}

/// The secp256k1 ECDH x coordinate of `secret · public`.
pub fn ecdh_x(secret: &SecretBytes, public: &[u8]) -> Result<Key32> {
    let sk = SecretKey::from_slice(secret.expose())
        .map_err(|_| Error::InvalidInput("not a secp256k1 private key".into()))?;
    let pk = PublicKey::from_slice(public)
        .map_err(|_| Error::InvalidInput("not a secp256k1 public key".into()))?;
    let point = Zeroizing::new(secp256k1::ecdh::shared_secret_point(&pk, &sk));
    let mut x = Zeroizing::new([0u8; 32]);
    x.copy_from_slice(&point[..32]);
    Ok(x)
}

/// The compressed public key of `secret`.
pub fn public_key(secret: &SecretBytes) -> Result<[u8; 33]> {
    crate::app_connect::public_key_of(secret.expose())
        .ok_or_else(|| Error::InvalidInput("not a secp256k1 private key".into()))
}

/// `W = HKDF(shared, repoId, "forge-user/v1/grant/" ‖ lp(network) ‖ memberId ‖ u32(epoch) ‖ u32(senderKeyId) ‖ u32(recipientKeyId))`.
pub fn grant_key(
    shared: &[u8; 32],
    repo: &[u8; 32],
    network: &str,
    member: &[u8; 32],
    epoch: u32,
    sender_key_id: u32,
    recipient_key_id: u32,
) -> Result<Key32> {
    let info = [
        b"forge-user/v1/grant/".as_slice(),
        &lp(network)?,
        member,
        &epoch.to_be_bytes(),
        &sender_key_id.to_be_bytes(),
        &recipient_key_id.to_be_bytes(),
    ]
    .concat();
    Ok(hkdf(shared, repo, &info))
}

/// AES-256-GCM seal (ciphertext with its 16-byte tag).
pub fn seal(key: &[u8; 32], nonce: &[u8; 12], plain: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    Aes256Gcm::new_from_slice(key)
        .expect("32-byte key")
        .encrypt(Nonce::from_slice(nonce), Payload { msg: plain, aad })
        .map_err(|_| Error::InvalidInput("forge-user encryption failed".into()))
}

/// AES-256-GCM open. Fails without saying more: a wrong key and a changed ciphertext look alike.
pub fn open(key: &[u8; 32], nonce: &[u8; 12], ct: &[u8], aad: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    Aes256Gcm::new_from_slice(key)
        .expect("32-byte key")
        .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad })
        .map(Zeroizing::new)
        .map_err(|_| Error::Integrity)
}

/// A fresh random 12-byte nonce.
pub fn fresh_nonce() -> Result<[u8; 12]> {
    let mut n = [0u8; 12];
    getrandom::getrandom(&mut n).map_err(|e| Error::Config(format!("no randomness: {e}")))?;
    Ok(n)
}

/// `deflate-raw` (zlib's `wbits = -15`).
pub fn deflate_raw(plain: &[u8]) -> Result<Vec<u8>> {
    let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
    enc.write_all(plain)
        .and_then(|()| enc.finish())
        .map_err(|e| Error::Io(format!("deflate: {e}")))
}

/// Inflate `deflate-raw` bytes, refusing more than a few MiB.
pub fn inflate_raw(compressed: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    let mut out = Zeroizing::new(Vec::new());
    flate2::read::DeflateDecoder::new(compressed)
        .take(MAX_INFLATED + 1)
        .read_to_end(&mut out)
        .map_err(|_| Error::Integrity)?;
    if out.len() as u64 > MAX_INFLATED {
        return Err(Error::Integrity);
    }
    Ok(out)
}

/// Split a ciphertext into `d0`, `d1`, `d2`.
pub fn split(ct: &[u8]) -> Result<Vec<Vec<u8>>> {
    if ct.len() > PIECE * MAX_PIECES {
        return Err(Error::InvalidInput(format!(
            "the encrypted settings are {} bytes; the most Platform holds is {}",
            ct.len(),
            PIECE * MAX_PIECES
        )));
    }
    Ok(ct.chunks(PIECE).map(<[u8]>::to_vec).collect())
}

/// Encrypt a JSON value as a state slot: `(ciphertext pieces)` under `nonce`.
pub fn seal_state(
    e: &SecretBytes,
    network: &str,
    identity: &[u8; 32],
    slot: &str,
    key_id: u32,
    nonce: &[u8; 12],
    json: &[u8],
) -> Result<Vec<Vec<u8>>> {
    let key = state_key(e, identity, network, slot);
    let aad = state_aad(network, identity, slot, STATE_V, key_id)?;
    split(&seal(&key, nonce, &deflate_raw(json)?, &aad)?)
}

/// Decrypt a state slot back to its JSON bytes.
#[allow(clippy::too_many_arguments)]
pub fn open_state(
    e: &SecretBytes,
    network: &str,
    identity: &[u8; 32],
    slot: &str,
    v: u8,
    key_id: u32,
    nonce: &[u8; 12],
    pieces: &[Vec<u8>],
) -> Result<Zeroizing<Vec<u8>>> {
    let key = state_key(e, identity, network, slot);
    let aad = state_aad(network, identity, slot, v, key_id)?;
    inflate_raw(&open(&key, nonce, &pieces.concat(), &aad)?)
}

/// Wrap `rsk` for a member: `nonce ‖ AES-GCM(W, RSK, AAD = ownerId)`.
#[allow(clippy::too_many_arguments)]
pub fn wrap_grant(
    e_owner: &SecretBytes,
    member_pub: &[u8],
    network: &str,
    owner: &[u8; 32],
    repo: &[u8; 32],
    member: &[u8; 32],
    epoch: u32,
    sender_key_id: u32,
    recipient_key_id: u32,
    rsk: &[u8; 32],
    nonce: &[u8; 12],
) -> Result<Vec<u8>> {
    let shared = ecdh_x(e_owner, member_pub)?;
    let w = grant_key(
        &shared,
        repo,
        network,
        member,
        epoch,
        sender_key_id,
        recipient_key_id,
    )?;
    let mut out = nonce.to_vec();
    out.extend(seal(&w, nonce, rsk, owner)?);
    Ok(out)
}

/// Unwrap a grant as the member, with the owner's public key `owner_pub` (its `senderKeyId`).
#[allow(clippy::too_many_arguments)]
pub fn unwrap_grant(
    e_member: &SecretBytes,
    owner_pub: &[u8],
    network: &str,
    owner: &[u8; 32],
    repo: &[u8; 32],
    member: &[u8; 32],
    epoch: u32,
    sender_key_id: u32,
    recipient_key_id: u32,
    wrapped: &[u8],
) -> Result<Key32> {
    if wrapped.len() < 12 + 16 {
        return Err(Error::Integrity);
    }
    let shared = ecdh_x(e_member, owner_pub)?;
    let w = grant_key(
        &shared,
        repo,
        network,
        member,
        epoch,
        sender_key_id,
        recipient_key_id,
    )?;
    let nonce: [u8; 12] = wrapped[..12].try_into().expect("12 bytes");
    let plain = open(&w, &nonce, &wrapped[12..], owner)?;
    let rsk: [u8; 32] = plain.as_slice().try_into().map_err(|_| Error::Integrity)?;
    Ok(Zeroizing::new(rsk))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const VECTORS: &str =
        include_str!("../../../../forge-contracts/fixtures/user-sync/vectors.json");

    fn hx(v: &Value) -> Vec<u8> {
        hex::decode(v.as_str().unwrap()).unwrap()
    }
    fn id(v: &Value) -> [u8; 32] {
        crate::app_connect::decode_id(v.as_str().unwrap()).unwrap()
    }
    fn secret(v: &Value) -> SecretBytes {
        SecretBytes::new(hx(v).try_into().unwrap())
    }
    fn n12(v: &Value) -> [u8; 12] {
        hx(v).try_into().unwrap()
    }
    fn canonical(v: &Value) -> Vec<u8> {
        serde_json::to_vec(v).unwrap()
    }

    #[test]
    #[allow(clippy::too_many_lines)] // one pass over every value in the vectors
    fn reproduces_every_vector() {
        let v: Value = serde_json::from_str(VECTORS).unwrap();
        let net = v["network"].as_str().unwrap();
        let owner = id(&v["ownerId"]);
        let member = id(&v["memberId"]);
        let repo = id(&v["repoId"]);
        let e_owner = secret(&v["ownerEncPrivHex"]);
        let e_member = secret(&v["memberEncPrivHex"]);
        let owner_kid = u32::try_from(v["ownerKeyId"].as_u64().unwrap()).unwrap();
        let member_kid = u32::try_from(v["memberKeyId"].as_u64().unwrap()).unwrap();
        assert_eq!(
            public_key(&e_owner).unwrap().to_vec(),
            hx(&v["ownerEncPubHex"])
        );
        assert_eq!(
            public_key(&e_member).unwrap().to_vec(),
            hx(&v["memberEncPubHex"])
        );

        let states = v["state"].as_array().unwrap();
        assert_eq!(states.len(), 3);
        for s in states {
            let slot = s["slot"].as_str().unwrap();
            let ver = u8::try_from(s["v"].as_u64().unwrap()).unwrap();
            let key = state_key(&e_owner, &owner, net, slot);
            assert_eq!(key.to_vec(), hx(&s["keyHex"]), "{slot} key");
            let aad = state_aad(net, &owner, slot, ver, owner_kid).unwrap();
            assert_eq!(aad, hx(&s["aadHex"]), "{slot} aad");
            let nonce = n12(&s["nonceHex"]);
            let ct = hx(&s["ciphertextHex"]);
            if let Some(comp) = s.get("compressedHex") {
                assert_eq!(
                    seal(&key, &nonce, &hx(comp), &aad).unwrap(),
                    ct,
                    "{slot} ct"
                );
            }
            let pieces = split(&ct).unwrap();
            assert_eq!(pieces[0], hx(&s["d0Hex"]), "{slot} d0");
            for (i, name) in ["d1Hex", "d2Hex"].iter().enumerate() {
                match s.get(*name).filter(|x| !x.is_null()) {
                    Some(d) => assert_eq!(pieces[i + 1], hx(d), "{slot} {name}"),
                    None => assert!(pieces.len() <= i + 1, "{slot} {name}"),
                }
            }
            if slot == "big" {
                assert!(ct.len() > PIECE && pieces.len() > 1);
            }
            let plain =
                open_state(&e_owner, net, &owner, slot, ver, owner_kid, &nonce, &pieces).unwrap();
            let back: Value = serde_json::from_slice(&plain).unwrap();
            assert_eq!(back, s["plaintextJson"], "{slot} plaintext");
            // Our own deflate round-trips (zlib's bytes need not match).
            let ours = seal_state(
                &e_owner,
                net,
                &owner,
                slot,
                owner_kid,
                &nonce,
                &canonical(&back),
            )
            .unwrap();
            let again =
                open_state(&e_owner, net, &owner, slot, ver, owner_kid, &nonce, &ours).unwrap();
            assert_eq!(serde_json::from_slice::<Value>(&again).unwrap(), back);
            // Another slot, key id or identity does not open it.
            assert!(open_state(
                &e_owner,
                net,
                &owner,
                slot,
                ver,
                owner_kid + 1,
                &nonce,
                &pieces
            )
            .is_err());
            assert!(
                open_state(&e_owner, net, &member, slot, ver, owner_kid, &nonce, &pieces).is_err()
            );
        }

        let sh = &v["share"];
        let epoch = u32::try_from(sh["epoch"].as_u64().unwrap()).unwrap();
        let rsk = repo_storage_key(&e_owner, &repo, net, epoch);
        assert_eq!(rsk.to_vec(), hx(&sh["rskHex"]));
        let aad = share_aad(net, &repo, epoch, owner_kid).unwrap();
        assert_eq!(aad, hx(&sh["aadHex"]));
        let plain = inflate_raw(
            &open(&rsk, &n12(&sh["nonceHex"]), &hx(&sh["ciphertextHex"]), &aad).unwrap(),
        )
        .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&plain).unwrap(),
            sh["plaintextJson"]
        );

        let g = &v["grant"];
        let shared_o = ecdh_x(&e_owner, &public_key(&e_member).unwrap()).unwrap();
        let shared_m = ecdh_x(&e_member, &public_key(&e_owner).unwrap()).unwrap();
        assert_eq!(*shared_o, *shared_m);
        assert_eq!(shared_o.to_vec(), hx(&g["sharedXHex"]));
        let w = grant_key(&shared_o, &repo, net, &member, epoch, owner_kid, member_kid).unwrap();
        assert_eq!(w.to_vec(), hx(&g["wrapKeyHex"]));
        assert_eq!(owner.to_vec(), hx(&g["aadHex"]));
        let wrapped_hex = hx(&g["wrappedHex"]);
        let nonce: [u8; 12] = wrapped_hex[..12].try_into().unwrap();
        let wrapped = wrap_grant(
            &e_owner,
            &public_key(&e_member).unwrap(),
            net,
            &owner,
            &repo,
            &member,
            epoch,
            owner_kid,
            member_kid,
            &rsk,
            &nonce,
        )
        .unwrap();
        assert_eq!(wrapped, wrapped_hex);
        assert_eq!(wrapped.len(), WRAPPED_LEN);
        let got = unwrap_grant(
            &e_member,
            &public_key(&e_owner).unwrap(),
            net,
            &owner,
            &repo,
            &member,
            epoch,
            owner_kid,
            member_kid,
            &wrapped,
        )
        .unwrap();
        assert_eq!(*got, *rsk);
        assert!(unwrap_grant(
            &e_member,
            &public_key(&e_owner).unwrap(),
            net,
            &member,
            &repo,
            &member,
            epoch,
            owner_kid,
            member_kid,
            &wrapped,
        )
        .is_err());
    }

    #[test]
    fn refuses_more_than_three_pieces() {
        assert!(split(&vec![0u8; PIECE * MAX_PIECES]).is_ok());
        assert!(split(&vec![0u8; PIECE * MAX_PIECES + 1]).is_err());
    }
}
