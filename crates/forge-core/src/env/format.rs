//! The snapshot artifact: canonical JSON padded to 512-byte buckets ([`super`] module docs), and
//! the `.env` text `dg env import` reads and `dg env export` writes.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use zeroize::{Zeroize, Zeroizing};

use super::{valid_env_name, valid_var_name, Audience, MAX_RECIPIENTS};

/// Snapshots are padded to a multiple of this many bytes.
pub const BUCKET: usize = 512;
/// The largest snapshot (24 buckets): it, its DFPK header and tag always fit one Platform chunk.
pub const MAX_SNAPSHOT: usize = 12_288;
/// `generatedAt` stays a safe integer in every stack (JavaScript's `Number`).
const MAX_SAFE_INT: u64 = (1 << 53) - 1;

/// How an entry is meant: a secret, or a plain setting. Every value is encrypted either way; the
/// type tells clients what to mask by default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VarType {
    /// A secret (`dg env set --secret`).
    Secret,
    /// A plain setting.
    Variable,
}

impl VarType {
    /// The artifact's spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Secret => "secret",
            Self::Variable => "variable",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "secret" => Some(Self::Secret),
            "variable" => Some(Self::Variable),
            _ => None,
        }
    }
}

/// One entry. The value is erased from memory on drop.
#[derive(Clone, PartialEq, Eq)]
pub struct Var {
    /// The value.
    pub value: String,
    /// Secret or plain setting.
    pub kind: VarType,
    /// A note for people (empty when none).
    pub note: String,
}

impl Drop for Var {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

impl std::fmt::Debug for Var {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Var")
            .field("value", &"<redacted>")
            .field("kind", &self.kind)
            .field("note", &self.note)
            .finish()
    }
}

/// One environment as one snapshot holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    /// The environment's name ([`valid_env_name`]).
    pub env: String,
    /// Who can read it.
    pub audience: Audience,
    /// When the writer made it (ms since the epoch; informational, `$createdAt` orders).
    pub generated_at: u64,
    /// The recipients of a Maintainers snapshot in slot order (base58 identity ids, the writer
    /// first), "as listed by the writer"; empty for Members.
    pub to: Vec<String>,
    /// The entries by name.
    pub vars: BTreeMap<String, Var>,
}

/// Why a snapshot cannot be written.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FormatError {
    /// Over [`MAX_SNAPSHOT`] bytes once encoded.
    #[error("the environment is {0} bytes once encoded; at most {MAX_SNAPSHOT} fit one snapshot")]
    TooLarge(usize),
    /// A field breaks a rule a reader would refuse.
    #[error("{0}")]
    Invalid(String),
}

/// Append `s` as a JSON string with exactly the canonical escapes.
fn push_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
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

impl Snapshot {
    /// Check what a reader checks: names, audience and recipients, and the time range.
    pub fn check(&self) -> Result<(), FormatError> {
        let bad = |why: String| Err(FormatError::Invalid(why));
        if !valid_env_name(&self.env) {
            return bad(format!(
                "{:?} is not an environment name (1-64 letters, digits, `.`, `_` or `-`, starting with a letter or digit)",
                self.env
            ));
        }
        if self.generated_at > MAX_SAFE_INT {
            return bad("generatedAt is out of range".into());
        }
        if let Some(n) = self.vars.keys().find(|n| !valid_var_name(n)) {
            return bad(format!(
                "{n:?} is not a variable name (letters, digits and `_`, not starting with a digit)"
            ));
        }
        match self.audience {
            Audience::Members if !self.to.is_empty() => {
                bad("a Members snapshot lists no recipients".into())
            }
            Audience::Maintainers => {
                if self.to.is_empty() || self.to.len() > MAX_RECIPIENTS {
                    return bad(format!(
                        "a Maintainers snapshot goes to 1 to {MAX_RECIPIENTS} people, not {}",
                        self.to.len()
                    ));
                }
                for (i, t) in self.to.iter().enumerate() {
                    if !canonical_id(t) || self.to[..i].contains(t) {
                        return bad(format!("{t:?} is not a recipient identity id, or is listed twice"));
                    }
                }
                Ok(())
            }
            Audience::Members => Ok(()),
        }
    }

    /// The canonical JSON (no padding).
    fn canonical(&self) -> Zeroizing<String> {
        let mut out = Zeroizing::new(String::with_capacity(256));
        out.push_str("{\"audience\":");
        push_str(&mut out, self.audience.as_str());
        out.push_str(",\"env\":");
        push_str(&mut out, &self.env);
        let _ = write!(out, ",\"generatedAt\":{}", self.generated_at);
        if self.audience == Audience::Maintainers {
            out.push_str(",\"to\":[");
            for (i, t) in self.to.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                push_str(&mut out, t);
            }
            out.push(']');
        }
        out.push_str(",\"v\":1,\"vars\":{");
        for (i, (name, v)) in self.vars.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            push_str(&mut out, name);
            out.push_str(":{");
            if !v.note.is_empty() {
                out.push_str("\"note\":");
                push_str(&mut out, &v.note);
                out.push(',');
            }
            out.push_str("\"type\":");
            push_str(&mut out, v.kind.as_str());
            out.push_str(",\"value\":");
            push_str(&mut out, &v.value);
            out.push('}');
        }
        out.push_str("}}");
        out
    }

    /// The artifact plaintext: the canonical JSON padded with spaces to a multiple of
    /// [`BUCKET`], after [`Self::check`].
    pub fn encode(&self) -> Result<Zeroizing<Vec<u8>>, FormatError> {
        self.check()?;
        let raw = self.canonical();
        let size = raw.len().div_ceil(BUCKET).max(1) * BUCKET;
        if size > MAX_SNAPSHOT {
            return Err(FormatError::TooLarge(raw.len()));
        }
        let mut out = Zeroizing::new(Vec::with_capacity(size));
        out.extend_from_slice(raw.as_bytes());
        out.resize(size, b' ');
        Ok(out)
    }

    /// Read an artifact plaintext: a bucket length, spaces as padding, a valid version-1 object,
    /// and exactly the bytes [`Self::encode`] makes of it. `None` is malformed.
    #[must_use]
    pub fn decode(pt: &[u8]) -> Option<Self> {
        if pt.is_empty() || pt.len() > MAX_SNAPSHOT || pt.len() % BUCKET != 0 {
            return None;
        }
        let end = pt.iter().rposition(|b| *b != b' ')? + 1;
        // the parsed tree holds the values too; it lives only for this call
        let value: serde_json::Value = serde_json::from_slice(&pt[..end]).ok()?;
        let snap = Self::from_value(&value)?;
        let again = snap.encode().ok()?;
        (again.as_slice() == pt).then_some(snap)
    }

    fn from_value(v: &serde_json::Value) -> Option<Self> {
        let obj = v.as_object()?;
        const KEYS: [&str; 6] = ["audience", "env", "generatedAt", "to", "v", "vars"];
        if obj.keys().any(|k| !KEYS.contains(&k.as_str())) || obj.get("v")?.as_u64()? != 1 {
            return None;
        }
        let audience = Audience::parse(obj.get("audience")?.as_str()?)?;
        let to = match (audience, obj.get("to")) {
            (Audience::Maintainers, Some(t)) => t
                .as_array()?
                .iter()
                .map(|x| x.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()?,
            (Audience::Members, None) => Vec::new(),
            _ => return None,
        };
        let mut vars = BTreeMap::new();
        for (name, entry) in obj.get("vars")?.as_object()? {
            let e = entry.as_object()?;
            if e.keys().any(|k| !["note", "type", "value"].contains(&k.as_str())) {
                return None;
            }
            let note = match e.get("note") {
                Some(n) => n.as_str()?.to_owned(),
                None => String::new(),
            };
            vars.insert(
                name.clone(),
                Var {
                    value: e.get("value")?.as_str()?.to_owned(),
                    kind: VarType::parse(e.get("type")?.as_str()?)?,
                    note,
                },
            );
        }
        let snap = Self {
            env: obj.get("env")?.as_str()?.to_owned(),
            audience,
            generated_at: obj.get("generatedAt")?.as_u64()?,
            to,
            vars,
        };
        snap.check().ok()?;
        Some(snap)
    }
}

/// Whether `id` is a base58 identity id in its one canonical spelling.
fn canonical_id(id: &str) -> bool {
    crate::platform::decode_identifier(id)
        .is_ok_and(|b| crate::platform::encode_identifier(b) == id)
}

/// How one entry changed between two snapshots (names only; values never leave the snapshot).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Change {
    /// The entry is new.
    Added,
    /// Its value, type or note changed.
    Changed,
    /// The entry is gone.
    Removed,
}

/// The entries that differ from `before` to `after`, by name.
#[must_use]
pub fn diff(before: Option<&Snapshot>, after: &Snapshot) -> Vec<(String, Change)> {
    let empty = BTreeMap::new();
    let old = before.map_or(&empty, |b| &b.vars);
    let mut out: Vec<(String, Change)> = Vec::new();
    for (name, v) in &after.vars {
        match old.get(name) {
            None => out.push((name.clone(), Change::Added)),
            Some(o) if o != v => out.push((name.clone(), Change::Changed)),
            Some(_) => {}
        }
    }
    for name in old.keys().filter(|n| !after.vars.contains_key(*n)) {
        out.push((name.clone(), Change::Removed));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

// --- .env text -------------------------------------------------------------------------------

/// A `.env` line `dg env import` could not read.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("line {line}: {why}")]
pub struct DotenvError {
    /// The 1-based line.
    pub line: usize,
    /// What is wrong (never the value).
    pub why: String,
}

/// Parse `.env` text: `NAME=value` lines, an optional `export ` prefix, `#` comments and blank
/// lines; a value bare (trimmed, an unquoted ` #` starts a comment), in single quotes (taken as
/// is) or in double quotes (`\n`, `\r`, `\t`, `\"`, `\\` and `\$` escapes; may span lines).
/// A name given twice keeps the last value. Values are returned in a zeroized map.
pub fn parse_dotenv(text: &str) -> Result<BTreeMap<String, Zeroizing<String>>, DotenvError> {
    let mut out = BTreeMap::new();
    let lines: Vec<&str> = text.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let n = i + 1;
        let line = lines[i].trim_start();
        i += 1;
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").map_or(line, str::trim_start);
        let err = |why: &str| DotenvError {
            line: n,
            why: why.to_owned(),
        };
        let (name, rest) = line
            .split_once('=')
            .ok_or_else(|| err("expected NAME=value"))?;
        let name = name.trim_end();
        if !valid_var_name(name) {
            return Err(err(
                "not a variable name (letters, digits and `_`, not starting with a digit)",
            ));
        }
        let rest = rest.trim_start();
        let value = if let Some(body) = rest.strip_prefix('\'') {
            let end = body
                .find('\'')
                .ok_or_else(|| err("a single-quoted value is not closed on its line"))?;
            Zeroizing::new(body[..end].to_owned())
        } else if let Some(body) = rest.strip_prefix('"') {
            let mut value = Zeroizing::new(String::new());
            let mut chunk = body.to_owned();
            loop {
                let mut chars = chunk.chars();
                let mut closed = false;
                while let Some(c) = chars.next() {
                    match c {
                        '"' => {
                            closed = true;
                            break;
                        }
                        '\\' => match chars.next() {
                            Some('n') => value.push('\n'),
                            Some('r') => value.push('\r'),
                            Some('t') => value.push('\t'),
                            Some(c @ ('"' | '\\' | '$')) => value.push(c),
                            Some(c) => {
                                value.push('\\');
                                value.push(c);
                            }
                            None => value.push('\\'),
                        },
                        c => value.push(c),
                    }
                }
                if closed {
                    break;
                }
                chunk.zeroize();
                if i >= lines.len() {
                    return Err(err("a double-quoted value is not closed"));
                }
                value.push('\n');
                chunk = lines[i].to_owned();
                i += 1;
            }
            chunk.zeroize();
            value
        } else {
            let bare = rest.find(" #").map_or(rest, |at| &rest[..at]);
            Zeroizing::new(bare.trim_end().to_owned())
        };
        out.insert(name.to_owned(), value);
    }
    Ok(out)
}

/// `vars` as `.env` text, one `NAME=value` line each in name order: a value of only
/// `A-Z a-z 0-9 _ . / : @ % + , -` bare, any other in double quotes with `\n`, `\r`, `\t`,
/// `\"`, `\\` and `\$` escaped, so [`parse_dotenv`] reads back exactly what was written.
#[must_use]
pub fn render_dotenv(vars: &BTreeMap<String, Var>) -> Zeroizing<String> {
    let mut out = Zeroizing::new(String::new());
    for (name, v) in vars {
        out.push_str(name);
        out.push('=');
        let bare = v.value.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | ':' | '@' | '%' | '+' | ',' | '-')
        });
        if bare {
            out.push_str(&v.value);
        } else {
            out.push('"');
            for c in v.value.chars() {
                match c {
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    '"' => out.push_str("\\\""),
                    '\\' => out.push_str("\\\\"),
                    '$' => out.push_str("\\$"),
                    c => out.push(c),
                }
            }
            out.push('"');
        }
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn var(value: &str) -> Var {
        Var {
            value: value.into(),
            kind: VarType::Secret,
            note: String::new(),
        }
    }

    fn snap(vars: &[(&str, &str)]) -> Snapshot {
        Snapshot {
            env: "dev".into(),
            audience: Audience::Members,
            generated_at: 1,
            to: Vec::new(),
            vars: vars.iter().map(|(k, v)| ((*k).to_owned(), var(v))).collect(),
        }
    }

    #[test]
    fn encode_pads_to_buckets_and_decodes_back() {
        let s = snap(&[("A", "1"), ("B", "two words \"quoted\"\n")]);
        let pt = s.encode().unwrap();
        assert_eq!(pt.len(), 512);
        assert!(pt.ends_with(b" "));
        assert_eq!(Snapshot::decode(&pt).unwrap(), s);
        let big = snap(&[("A", &"x".repeat(600))]);
        assert_eq!(big.encode().unwrap().len(), 1024);
        let huge = snap(&[("A", &"x".repeat(MAX_SNAPSHOT))]);
        assert!(matches!(huge.encode(), Err(FormatError::TooLarge(_))));
    }

    #[test]
    fn decode_refuses_what_the_writer_never_makes() {
        let pt = snap(&[("A", "1")]).encode().unwrap();
        assert!(Snapshot::decode(&pt[..511]).is_none());
        let mut tab = pt.to_vec();
        *tab.last_mut().unwrap() = b'\t';
        assert!(Snapshot::decode(&tab).is_none());
        let s = String::from_utf8(pt.to_vec()).unwrap().replacen(',', ", ", 1);
        assert!(Snapshot::decode(&s.as_bytes()[..512]).is_none());
    }

    #[test]
    fn members_lists_nobody_and_maintainers_somebody() {
        let mut s = snap(&[]);
        s.to = vec![crate::platform::encode_identifier([1; 32])];
        assert!(s.check().is_err());
        s.audience = Audience::Maintainers;
        assert!(s.check().is_ok());
        s.to.push(s.to[0].clone());
        assert!(s.check().is_err(), "listed twice");
        s.to = vec![];
        assert!(s.check().is_err());
    }

    #[test]
    fn diff_names_only() {
        let a = snap(&[("A", "1"), ("B", "2")]);
        let b = snap(&[("B", "3"), ("C", "4")]);
        assert_eq!(
            diff(Some(&a), &b),
            vec![
                ("A".into(), Change::Removed),
                ("B".into(), Change::Changed),
                ("C".into(), Change::Added)
            ]
        );
        assert_eq!(diff(None, &a).len(), 2);
    }

    #[test]
    fn dotenv_round_trips() {
        let text = "# comment\nexport A=plain\nB = 'single $x'\nC=\"line1\\nline2 \\\"q\\\" \\$HOME\"\nD=bare # trailing comment\nE=\"multi\nline\"\n\nF=\n";
        let got = parse_dotenv(text).unwrap();
        let g = |k: &str| got[k].as_str().to_owned();
        assert_eq!(g("A"), "plain");
        assert_eq!(g("B"), "single $x");
        assert_eq!(g("C"), "line1\nline2 \"q\" $HOME");
        assert_eq!(g("D"), "bare");
        assert_eq!(g("E"), "multi\nline");
        assert_eq!(g("F"), "");
        let vars: BTreeMap<String, Var> = got
            .iter()
            .map(|(k, v)| (k.clone(), var(v)))
            .collect();
        let back = parse_dotenv(&render_dotenv(&vars)).unwrap();
        assert_eq!(back.len(), vars.len());
        for (k, v) in &vars {
            assert_eq!(back[k].as_str(), v.value);
        }
    }

    #[test]
    fn dotenv_errors_name_the_line_not_the_value() {
        let e = parse_dotenv("A=1\nnot a line\n").unwrap_err();
        assert_eq!(e.line, 2);
        let e = parse_dotenv("1A=secret-value\n").unwrap_err();
        assert!(!e.to_string().contains("secret-value"));
        assert!(parse_dotenv("A=\"open\n").is_err());
    }
}
