//! `dti/1` canonical JSON: sorted keys (by UTF-16 code units, as JavaScript sorts them), no
//! whitespace, strings escaped as `JSON.stringify` escapes them, safe integers only.

use std::fmt::Write as _;

use serde_json::Value;
use sha2::{Digest, Sha256};

const MAX_SAFE: u64 = 9_007_199_254_740_991;

/// A value canonical JSON cannot carry: a fraction, or an integer beyond 2^53 − 1.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("non-integer number in canonical JSON: {0}")]
pub struct NotCanonical(pub String);

pub fn canonical(value: &Value) -> Result<String, NotCanonical> {
    let mut out = String::new();
    write_value(&mut out, value)?;
    Ok(out)
}

/// SHA-256 of the canonical form, as lower-case hex.
pub fn digest(value: &Value) -> Result<String, NotCanonical> {
    Ok(sha256_hex(canonical(value)?.as_bytes()))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// The integer a JSON number holds, if it is a safe integer (`1.0` counts, as in JavaScript).
pub fn safe_int(n: &serde_json::Number) -> Option<i64> {
    if let Some(i) = n.as_i64() {
        return (i.unsigned_abs() <= MAX_SAFE).then_some(i);
    }
    if n.is_u64() {
        return None;
    }
    let f = n.as_f64()?;
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_precision_loss,
        clippy::float_cmp
    )]
    (f.is_finite() && f.fract() == 0.0 && f.abs() <= MAX_SAFE as f64).then_some(f as i64)
}

/// The integer `value` is, when it is a JSON number holding a safe integer.
pub fn int_of(value: &Value) -> Option<i64> {
    match value {
        Value::Number(n) => safe_int(n),
        _ => None,
    }
}

/// Length in UTF-16 code units (JavaScript's `String.length`).
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn write_value(out: &mut String, value: &Value) -> Result<(), NotCanonical> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            let i = safe_int(n).ok_or_else(|| NotCanonical(n.to_string()))?;
            let _ = write!(out, "{i}");
        }
        Value::String(s) => write_string(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, item)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(out, k);
                out.push(':');
                write_value(out, &map[k])?;
            }
            out.push('}');
        }
    }
    Ok(())
}

fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_fractions_and_unsafe_integers() {
        assert!(canonical(&json!(1.5)).is_err());
        assert!(canonical(&json!(9_007_199_254_740_992_u64)).is_err());
        assert_eq!(canonical(&json!(-0.0)).unwrap(), "0");
        assert_eq!(canonical(&json!(3.0)).unwrap(), "3");
    }

    #[test]
    fn sorts_keys_by_utf16_code_units() {
        let v = json!({"\u{ff61}": 1, "\u{1f600}": 2, "a": 3});
        assert_eq!(
            canonical(&v).unwrap(),
            "{\"a\":3,\"\u{1f600}\":2,\"\u{ff61}\":1}"
        );
    }
}
