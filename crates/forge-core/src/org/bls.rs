//! BLS12-381 in Platform's scheme (IETF basic: public keys in G1, signatures in G2, ciphersuite
//! `BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_NUL_`), and the polynomial arithmetic a threshold
//! group needs.

use blstrs_plus::elliptic_curve::bigint::U512;
use blstrs_plus::elliptic_curve::hash2curve::ExpandMsgXmd;
use blstrs_plus::elliptic_curve::ops::Reduce;
use blstrs_plus::ff::Field;
use blstrs_plus::group::{Curve, Group};
use blstrs_plus::{pairing, G1Affine, G1Projective, G2Affine, G2Projective, Scalar};

pub const DST: &[u8] = b"BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_NUL_";

/// `OS2IP(bytes) mod r` for up to 64 bytes.
pub fn scalar_from_be_wide(bytes: &[u8]) -> Scalar {
    let mut wide = [0u8; 64];
    wide[64 - bytes.len()..].copy_from_slice(bytes);
    Scalar::reduce(U512::from_be_slice(&wide))
}

/// A 32-byte hex scalar reduced mod r (`scalarFromHex`).
pub fn scalar_from_hex_mod(h: &str) -> Option<Scalar> {
    let bytes = hex::decode(h).ok()?;
    (bytes.len() <= 64).then(|| scalar_from_be_wide(&bytes))
}

/// A share as its box carries it: exactly 64 lower-case hex digits, below r.
pub fn parse_share(text: &str) -> Option<Scalar> {
    if text.len() != 64
        || !text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let bytes: [u8; 32] = hex::decode(text).ok()?.try_into().ok()?;
    Option::from(Scalar::from_be_bytes(&bytes))
}

pub fn g1(s: &Scalar) -> G1Projective {
    G1Projective::generator() * s
}

pub fn g1_hex(p: &G1Projective) -> String {
    hex::encode(p.to_affine().to_compressed())
}

pub fn g1_from_hex(h: &str) -> Option<G1Projective> {
    let bytes: [u8; 48] = hex::decode(h).ok()?.try_into().ok()?;
    Option::<G1Affine>::from(G1Affine::from_compressed(&bytes)).map(G1Projective::from)
}

pub fn g2_from_bytes(bytes: &[u8]) -> Option<G2Projective> {
    let bytes: [u8; 96] = bytes.try_into().ok()?;
    Option::<G2Affine>::from(G2Affine::from_compressed(&bytes)).map(G2Projective::from)
}

pub fn g2_bytes(p: &G2Projective) -> [u8; 96] {
    p.to_affine().to_compressed()
}

pub fn eval_poly(coefficients: &[Scalar], x: u64) -> Scalar {
    let x = Scalar::from(x);
    let mut acc = Scalar::ZERO;
    let mut xk = Scalar::ONE;
    for a in coefficients {
        acc += *a * xk;
        xk *= x;
    }
    acc
}

pub fn eval_commitments(commitments: &[G1Projective], x: u64) -> G1Projective {
    let x = Scalar::from(x);
    let mut acc = G1Projective::identity();
    let mut xk = Scalar::ONE;
    for c in commitments {
        acc += *c * xk;
        xk *= x;
    }
    acc
}

pub fn lagrange_at_zero(i: u64, indices: &[u64]) -> Scalar {
    let mut num = Scalar::ONE;
    let mut den = Scalar::ONE;
    for &j in indices {
        if j == i {
            continue;
        }
        num *= Scalar::from(j);
        den *= Scalar::from(j) - Scalar::from(i);
    }
    num * Option::<Scalar>::from(den.invert()).expect("distinct indices")
}

pub fn hash_to_g2(message: &[u8]) -> G2Projective {
    G2Projective::hash::<ExpandMsgXmd<sha2::Sha256>>(message, DST)
}

/// `share · H(message)`, compressed.
pub fn sign_share(share: &Scalar, message: &[u8]) -> [u8; 96] {
    g2_bytes(&(hash_to_g2(message) * share))
}

/// Whether `signature` (hex) is a valid signature of `message` under `public_key` (hex).
pub fn verify_hex(signature: &str, message: &[u8], public_key: &str) -> bool {
    match hex::decode(signature) {
        Ok(sig) => verify(&sig, message, public_key),
        Err(_) => false,
    }
}

pub fn verify(signature: &[u8], message: &[u8], public_key: &str) -> bool {
    let (Some(pk), Some(sig)) = (g1_from_hex(public_key), g2_from_bytes(signature)) else {
        return false;
    };
    if bool::from(pk.is_identity()) || bool::from(sig.is_identity()) {
        return false;
    }
    pairing(&G1Projective::generator().to_affine(), &sig.to_affine())
        == pairing(&pk.to_affine(), &hash_to_g2(message).to_affine())
}

/// `Σ λⱼ·σⱼ` over the given `(index, share signature)` pairs.
pub fn combine(shares: &[(u64, Vec<u8>)]) -> Option<[u8; 96]> {
    let indices: Vec<u64> = shares.iter().map(|(i, _)| *i).collect();
    let mut acc = G2Projective::identity();
    for (i, sig) in shares {
        acc += g2_from_bytes(sig)? * lagrange_at_zero(*i, &indices);
    }
    Some(g2_bytes(&acc))
}
