//! Small encodings the rules need, written out so a port can follow them line by line.

use sha2::{Digest, Sha256};

/// The 1-based line of byte `offset` in `text` (`\n` ends a line).
pub(crate) fn line_of(text: &str, offset: usize) -> u32 {
    let newlines = text[..offset.min(text.len())].matches('\n').count();
    u32::try_from(newlines + 1).unwrap_or(u32::MAX)
}

/// CRC-32 (IEEE 802.3, reflected, polynomial 0xEDB88320), as zlib's `crc32`.
pub(crate) fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= u32::from(b);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// `n` in the base of `alphabet`, most significant digit first, left-padded with the
/// alphabet's zero digit to at least `width` digits.
pub(crate) fn encode_base(mut n: u64, alphabet: &[u8], width: usize) -> String {
    let base = alphabet.len() as u64;
    let mut digits = Vec::new();
    while n > 0 {
        digits.push(alphabet[usize::try_from(n % base).unwrap_or(0)]);
        n /= base;
    }
    while digits.len() < width {
        digits.push(alphabet[0]);
    }
    digits.reverse();
    String::from_utf8(digits).unwrap_or_default()
}

/// The base58 (Bitcoin alphabet) digits.
pub(crate) const BASE58: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// Decode a base58 string (Bitcoin alphabet; each leading `1` is a zero byte). `None` on a
/// character outside the alphabet.
pub(crate) fn base58_decode(s: &str) -> Option<Vec<u8>> {
    // Little-endian base-256 accumulator.
    let mut acc: Vec<u8> = Vec::new();
    for c in s.bytes() {
        let mut carry = u32::try_from(BASE58.iter().position(|&x| x == c)?).ok()?;
        for b in &mut acc {
            carry += u32::from(*b) * 58;
            *b = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            acc.push((carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    let zeros = s.bytes().take_while(|&c| c == b'1').count();
    let mut out = vec![0u8; zeros];
    out.extend(acc.iter().rev());
    Some(out)
}

/// SHA-256 of `data`.
pub(crate) fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

/// Shannon entropy of `s` in bits per character: `-Σ p·log2(p)` over the frequency `p` of each
/// distinct character.
pub(crate) fn shannon_entropy(s: &str) -> f64 {
    let chars: Vec<char> = s.chars().collect();
    if chars.is_empty() {
        return 0.0;
    }
    let mut counts = std::collections::BTreeMap::new();
    for c in &chars {
        *counts.entry(*c).or_insert(0usize) += 1;
    }
    #[allow(clippy::cast_precision_loss)] // lengths far below 2^52
    let n = chars.len() as f64;
    counts
        .values()
        .map(|&k| {
            #[allow(clippy::cast_precision_loss)]
            let p = k as f64 / n;
            -p * p.log2()
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32_matches_the_standard_check_value() {
        // The CRC-32 catalogue's check value for "123456789".
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn base58_round_trips_leading_zeros() {
        assert_eq!(base58_decode("1").unwrap(), vec![0]);
        assert_eq!(base58_decode("11").unwrap(), vec![0, 0]);
        assert_eq!(base58_decode("2").unwrap(), vec![1]);
        assert_eq!(base58_decode("21").unwrap(), vec![58]);
        assert!(base58_decode("0").is_none());
    }

    #[test]
    fn encode_base_pads_to_width() {
        assert_eq!(encode_base(0, b"0123456789", 3), "000");
        assert_eq!(encode_base(255, b"0123456789abcdef", 1), "ff");
    }

    #[test]
    fn entropy_of_uniform_strings() {
        assert!((shannon_entropy("aaaa") - 0.0).abs() < 1e-12);
        assert!((shannon_entropy("abcd") - 2.0).abs() < 1e-12);
    }

    #[test]
    fn lines_count_from_one() {
        assert_eq!(line_of("a\nb\nc", 0), 1);
        assert_eq!(line_of("a\nb\nc", 2), 2);
        assert_eq!(line_of("a\nb\nc", 4), 3);
    }
}
