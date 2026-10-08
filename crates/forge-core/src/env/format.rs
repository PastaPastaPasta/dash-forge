//! The snapshot artifact: canonical JSON padded to 512-byte buckets ([`super`] module docs), and
//! the `.env` text `dg env import` reads and `dg env export` writes.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use zeroize::{Zeroize, Zeroizing};

use super::{valid_env_name, valid_var_name, Audience, Group, MAX_RECIPIENTS, MAX_RECIPIENTS_V1};

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
    /// The artifact version: 2 for everything written from revision 4 on; 1 (phase 1) is read
    /// only.
    pub version: u8,
    /// The environment's name ([`valid_env_name`]).
    pub env: String,
    /// Who can read it. A version-1 snapshot reads as the group of its word, with nobody added.
    pub audience: Audience,
    /// The environment's random id, fixed at its first save (version 2; `None` for version 1).
    pub id: Option<[u8; 16]>,
    /// When the writer made it (ms since the epoch; informational: block height orders).
    pub generated_at: u64,
    /// Set on a snapshot a maintainer saved again for a removed maintainer, with the values they
    /// last saved: that maintainer (base58). History says "saved again for …".
    pub saved_for: Option<String>,
    /// The recipients in slot order (base58 identity ids, the writer first), "as listed by the
    /// writer"; empty for an old-format Members snapshot.
    pub to: Vec<String>,
    /// The ENCRYPTION key id each recipient's slot was sealed to, in `to` order (version 2).
    pub to_keys: Vec<u32>,
    /// Names whose values held in old-format snapshots were changed at their source (version 2;
    /// sorted).
    pub marked_changed: Vec<String>,
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

/// Append `items` as a JSON array of strings.
fn push_strs(out: &mut String, items: &[String]) {
    out.push('[');
    for (i, t) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        push_str(out, t);
    }
    out.push(']');
}

/// Whether `ids` are canonical identity ids, none twice.
fn distinct_ids(ids: &[String]) -> bool {
    ids.iter()
        .enumerate()
        .all(|(i, t)| canonical_id(t) && !ids[..i].contains(t))
}

impl Snapshot {
    /// A version-2 snapshot of `env` for `audience` with `vars`, its recipients still to be
    /// filled in by the writer.
    #[must_use]
    pub fn new(env: &str, id: [u8; 16], audience: Audience, vars: BTreeMap<String, Var>) -> Self {
        Self {
            version: 2,
            env: env.to_owned(),
            audience,
            id: Some(id),
            generated_at: 0,
            saved_for: None,
            to: Vec::new(),
            to_keys: Vec::new(),
            marked_changed: Vec::new(),
            vars,
        }
    }

    /// Whether this is an old-format Members snapshot: version 1, under the members key (a DFPK
    /// 0x01 file), readable by everyone who joins later.
    #[must_use]
    pub fn members_key(&self) -> bool {
        self.version == 1 && self.audience.group == Some(Group::Members)
    }

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
        if let Some(f) = self.saved_for.as_deref().filter(|f| !canonical_id(f)) {
            return bad(format!("{f:?} is not an identity id"));
        }
        if let Some(n) = self.vars.keys().find(|n| !valid_var_name(n)) {
            return bad(format!(
                "{n:?} is not a variable name (letters, digits and `_`, not starting with a digit)"
            ));
        }
        match self.version {
            1 => self.check_v1(),
            2 => self.check_v2(),
            v => bad(format!("version {v} is not a snapshot version")),
        }
    }

    fn check_v1(&self) -> Result<(), FormatError> {
        let bad = |why: String| Err(FormatError::Invalid(why));
        if self.id.is_some()
            || !self.to_keys.is_empty()
            || !self.marked_changed.is_empty()
            || !self.audience.also.is_empty()
        {
            return bad("a version-1 snapshot has no id, keys, marks or added people".into());
        }
        match self.audience.group {
            Some(Group::Members) if self.to.is_empty() => Ok(()),
            Some(Group::Members) => {
                bad("an old-format Members snapshot lists no recipients".into())
            }
            Some(Group::Maintainers) => {
                if self.to.is_empty()
                    || self.to.len() > MAX_RECIPIENTS_V1
                    || !distinct_ids(&self.to)
                {
                    return bad(format!(
                        "a version-1 Maintainers snapshot goes to 1 to {MAX_RECIPIENTS_V1} different people"
                    ));
                }
                Ok(())
            }
            _ => bad("a version-1 snapshot is for Members or Maintainers".into()),
        }
    }

    fn check_v2(&self) -> Result<(), FormatError> {
        let bad = |why: String| Err(FormatError::Invalid(why));
        if self.id.is_none() {
            return bad("a snapshot needs the environment's id".into());
        }
        let also = &self.audience.also;
        if also.len() > MAX_RECIPIENTS
            || !also.iter().all(|t| canonical_id(t))
            || also.windows(2).any(|w| w[0] >= w[1])
        {
            return bad("the people added are not identity ids in order, each once".into());
        }
        if self.audience.group.is_none() && also.is_empty() {
            return bad("a Specific-people environment names someone".into());
        }
        if self.to.is_empty() || self.to.len() > MAX_RECIPIENTS || !distinct_ids(&self.to) {
            return bad(format!(
                "an environment goes to 1 to {MAX_RECIPIENTS} different people, not {}",
                self.to.len()
            ));
        }
        if self.to_keys.len() != self.to.len() {
            return bad("one key per recipient".into());
        }
        if !self.marked_changed.iter().all(|n| valid_var_name(n))
            || self.marked_changed.windows(2).any(|w| w[0] >= w[1])
        {
            return bad(
                "the names marked changed are not variable names in order, each once".into(),
            );
        }
        Ok(())
    }

    /// The canonical JSON (no padding).
    fn canonical(&self) -> Zeroizing<String> {
        let mut out = Zeroizing::new(String::with_capacity(256));
        out.push_str("{\"audience\":");
        if self.version == 1 {
            let word = match self.audience.group {
                Some(Group::Maintainers) => "maintainers",
                _ => "members",
            };
            push_str(&mut out, word);
        } else {
            out.push_str("{\"also\":");
            push_strs(&mut out, &self.audience.also);
            out.push_str(",\"group\":");
            match self.audience.group {
                Some(g) => push_str(&mut out, g.as_str()),
                None => out.push_str("null"),
            }
            out.push('}');
        }
        out.push_str(",\"env\":");
        push_str(&mut out, &self.env);
        let _ = write!(out, ",\"generatedAt\":{}", self.generated_at);
        if let Some(id) = &self.id {
            let _ = write!(out, ",\"id\":\"{}\"", hex::encode(id));
        }
        if !self.marked_changed.is_empty() {
            out.push_str(",\"markedChanged\":");
            push_strs(&mut out, &self.marked_changed);
        }
        if let Some(f) = &self.saved_for {
            out.push_str(",\"savedFor\":");
            push_str(&mut out, f);
        }
        if self.version == 2 || self.audience.group == Some(Group::Maintainers) {
            out.push_str(",\"to\":");
            push_strs(&mut out, &self.to);
        }
        if self.version == 2 {
            out.push_str(",\"toKeys\":[");
            for (i, k) in self.to_keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                let _ = write!(out, "{k}");
            }
            out.push(']');
        }
        let _ = write!(out, ",\"v\":{},\"vars\":{{", self.version);
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

    /// Read an artifact plaintext: a bucket length, spaces as padding, a valid version-1 or
    /// version-2 object, and exactly the bytes [`Self::encode`] makes of it. `None` is malformed.
    #[must_use]
    pub fn decode(pt: &[u8]) -> Option<Self> {
        if pt.is_empty() || pt.len() > MAX_SNAPSHOT || !pt.len().is_multiple_of(BUCKET) {
            return None;
        }
        let end = pt.iter().rposition(|b| *b != b' ')? + 1;
        // the parsed tree holds the values too; it lives only for this call
        let value: serde_json::Value = serde_json::from_slice(&pt[..end]).ok()?;
        let snap = Self::from_value(&value)?;
        let again = snap.encode().ok()?;
        (again.as_slice() == pt).then_some(snap)
    }

    #[allow(clippy::too_many_lines)] // one field after another, as the module docs list them
    fn from_value(v: &serde_json::Value) -> Option<Self> {
        const V1: [&str; 7] = [
            "audience",
            "env",
            "generatedAt",
            "savedFor",
            "to",
            "v",
            "vars",
        ];
        const V2: [&str; 3] = ["id", "markedChanged", "toKeys"];
        let obj = v.as_object()?;
        let version = u8::try_from(obj.get("v")?.as_u64()?).ok()?;
        let known = |k: &str| V1.contains(&k) || (version == 2 && V2.contains(&k));
        if obj.keys().any(|k| !known(k)) {
            return None;
        }
        let strings = |x: &serde_json::Value| -> Option<Vec<String>> {
            x.as_array()?
                .iter()
                .map(|t| t.as_str().map(str::to_owned))
                .collect()
        };
        let (audience, id, to_keys, marked_changed) = match version {
            1 => {
                let group = match obj.get("audience")?.as_str()? {
                    "members" => Group::Members,
                    "maintainers" => Group::Maintainers,
                    _ => return None,
                };
                (Audience::group(group), None, Vec::new(), Vec::new())
            }
            2 => {
                let a = obj.get("audience")?.as_object()?;
                if a.len() != 2 {
                    return None;
                }
                let group = match a.get("group")? {
                    serde_json::Value::Null => None,
                    g => Some(Group::parse(g.as_str()?)?),
                };
                let also = strings(a.get("also")?)?;
                let id_hex = obj.get("id")?.as_str()?;
                if id_hex.len() != 32 || id_hex.bytes().any(|c| c.is_ascii_uppercase()) {
                    return None;
                }
                let id: [u8; 16] = hex::decode(id_hex).ok()?.try_into().ok()?;
                let to_keys = obj
                    .get("toKeys")?
                    .as_array()?
                    .iter()
                    .map(|k| u32::try_from(k.as_u64()?).ok())
                    .collect::<Option<Vec<u32>>>()?;
                let marked = match obj.get("markedChanged") {
                    Some(m) => {
                        let m = strings(m)?;
                        if m.is_empty() {
                            return None;
                        }
                        m
                    }
                    None => Vec::new(),
                };
                (Audience { group, also }, Some(id), to_keys, marked)
            }
            _ => return None,
        };
        let to = match obj.get("to") {
            Some(t) => strings(t)?,
            None => Vec::new(),
        };
        let mut vars = BTreeMap::new();
        for (name, entry) in obj.get("vars")?.as_object()? {
            let e = entry.as_object()?;
            if e.keys()
                .any(|k| !["note", "type", "value"].contains(&k.as_str()))
            {
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
        let saved_for = match obj.get("savedFor") {
            Some(f) => Some(f.as_str()?.to_owned()),
            None => None,
        };
        let snap = Self {
            version,
            env: obj.get("env")?.as_str()?.to_owned(),
            audience,
            id,
            generated_at: obj.get("generatedAt")?.as_u64()?,
            saved_for,
            to,
            to_keys,
            marked_changed,
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
/// is) or in double quotes (`\n`, `\r`, `\t`, `\"`, `\\`, `\$` and `` \` `` escapes; may span
/// lines).
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
                            Some(c @ ('"' | '\\' | '$' | '`')) => value.push(c),
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
                lines[i].clone_into(&mut chunk);
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

/// `vars` as `.env` text, one `NAME=value` line each in name order, safe to `source` in a shell
/// (nothing in a value is expanded or run) and read back exactly by [`parse_dotenv`]: a value of
/// only `A-Z a-z 0-9 _ . / : @ % + , -` bare; one with no `'`, newline or carriage return in
/// single quotes (taken literally by both); any other in double quotes with `\`, `"`, `$` and
/// `` ` `` escaped and newlines, carriage returns and tabs as `\n`, `\r`, `\t` (a shell then reads
/// those three as the two characters, never as a command).
#[must_use]
pub fn render_dotenv(vars: &BTreeMap<String, Var>) -> Zeroizing<String> {
    let mut out = Zeroizing::new(String::new());
    for (name, v) in vars {
        out.push_str(name);
        out.push('=');
        let bare = v.value.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, '_' | '.' | '/' | ':' | '@' | '%' | '+' | ',' | '-')
        });
        if bare {
            out.push_str(&v.value);
        } else if !v.value.contains(['\'', '\n', '\r']) {
            out.push('\'');
            out.push_str(&v.value);
            out.push('\'');
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
                    '`' => out.push_str("\\`"),
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

    fn id(b: u8) -> String {
        crate::platform::encode_identifier([b; 32])
    }

    fn snap(vars: &[(&str, &str)]) -> Snapshot {
        let mut s = Snapshot::new(
            "dev",
            [7; 16],
            Audience::group(Group::Members),
            vars.iter()
                .map(|(k, v)| ((*k).to_owned(), var(v)))
                .collect(),
        );
        s.generated_at = 1;
        s.to = vec![id(1)];
        s.to_keys = vec![2];
        s
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
        let s = String::from_utf8(pt.to_vec())
            .unwrap()
            .replacen(',', ", ", 1);
        assert!(Snapshot::decode(&s.as_bytes()[..512]).is_none());
    }

    #[test]
    fn old_members_lists_nobody_and_old_maintainers_somebody() {
        let mut s = snap(&[]);
        s.version = 1;
        s.id = None;
        s.to_keys.clear();
        assert!(s.check().is_err(), "an old Members snapshot lists nobody");
        s.audience = Audience::group(Group::Maintainers);
        assert!(s.check().is_ok());
        s.to.push(s.to[0].clone());
        assert!(s.check().is_err(), "listed twice");
        s.to = vec![];
        assert!(s.check().is_err());
        s.audience = Audience::group(Group::Writers);
        s.to = vec![id(1)];
        assert!(s.check().is_err(), "no Writers group in version 1");
    }

    #[test]
    fn a_letter_lists_its_people_once_with_a_key_each() {
        let mut s = snap(&[]);
        assert!(s.check().is_ok());
        s.to_keys.push(3);
        assert!(s.check().is_err(), "a key per recipient");
        s.to_keys.pop();
        s.audience = Audience::new(None, []);
        assert!(s.check().is_err(), "Specific people names someone");
        s.audience = Audience::new(None, [id(3), id(2)]);
        let mut sorted = vec![id(2), id(3)];
        sorted.sort();
        assert_eq!(s.audience.also, sorted);
        assert!(s.check().is_ok());
        s.audience.also.reverse();
        assert!(s.check().is_err(), "added people in order");
        s.audience.also.reverse();
        s.to = (0..=64).map(|b| id(b + 1)).collect();
        s.to_keys = vec![1; 65];
        assert!(s.check().is_err(), "at most 64");
        s.to.pop();
        s.to_keys.pop();
        assert!(s.check().is_ok());
        s.marked_changed = vec!["B".into(), "A".into()];
        assert!(s.check().is_err(), "marks in order");
        s.marked_changed.sort();
        let pt = s.encode().unwrap();
        assert_eq!(Snapshot::decode(&pt).unwrap(), s);
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
        let vars: BTreeMap<String, Var> = got.iter().map(|(k, v)| (k.clone(), var(v))).collect();
        let back = parse_dotenv(&render_dotenv(&vars)).unwrap();
        assert_eq!(back.len(), vars.len());
        for (k, v) in &vars {
            assert_eq!(back[k].as_str(), v.value);
        }
    }

    #[test]
    fn dotenv_output_runs_nothing_in_a_shell() {
        let mut vars = BTreeMap::new();
        for (k, v) in [
            ("SUB", "$(touch PWNED)"),
            ("TICK", "`touch PWNED`"),
            ("MIX", "it's $(touch PWNED) `x`\nnext"),
            ("PLAIN", "a-b"),
        ] {
            vars.insert(k.to_owned(), var(v));
        }
        let text = render_dotenv(&vars);
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("env");
        std::fs::write(&file, text.as_bytes()).unwrap();
        let out = std::process::Command::new("sh")
            .current_dir(dir.path())
            .arg("-c")
            .arg(". ./env; printf '%s|%s|%s' \"$SUB\" \"$TICK\" \"$PLAIN\"")
            .output()
            .unwrap();
        assert!(!dir.path().join("PWNED").exists(), "a value ran a command");
        assert_eq!(
            String::from_utf8(out.stdout).unwrap(),
            "$(touch PWNED)|`touch PWNED`|a-b"
        );
        let back = parse_dotenv(&text).unwrap();
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
