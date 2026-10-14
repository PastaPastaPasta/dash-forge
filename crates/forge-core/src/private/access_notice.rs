//! Access notices (kind 11, mixed-visibility DESIGN §4.9 "Access notices", D33;
//! `docs/security/private-repos.md` §22.1): what a maintainer lets a bot do in one repository,
//! who may ask it, which AI service processes what it is given and until when.
//!
//! A notice is a typed JSON object in the key letters' canonical form ([`TypedLetter`]: keys
//! sorted, no whitespace, integers only, padded with spaces to a multiple of 512 bytes):
//!
//! ```text
//! {"askers":"writers"|"maintainers","bot":hex32,"may":["ciMembersBranches","post",…],
//!  "note":TEXT,"processor":TEXT|null,"revokes":[packHash,…],"threads":"all"|[n,…],
//!  "type":"accessNotice","until":ms|null,"v":1}
//! ```
//!
//! In a public repository the bytes are stored as they are (anyone reads them). In a private
//! repository they are stored twice: sealed under the members key (DFPK 0x01) for members, and
//! as a DFPK 0x02 letter to the bot and the writer (the bot never holds the members key). Both
//! are kind-11 manifests; the artifact's first bytes say which form it is.
//!
//! Which notice counts ([`current`]): per bot, the newest whose manifest's `$ownerId` is a
//! **current** maintainer (the owner included). A notice past its `until` allows nothing. Fields
//! a later version adds (phase 4E's `push` and `pushPolicy`) are kept and ignored; abilities this
//! client does not know are kept in `may` and grant nothing here.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use serde_json::{Map, Value};
use zeroize::Zeroizing;

use super::key_letter::{LetterError, TypedLetter, MAX_INT};

/// `"type": "accessNotice"`.
pub const TYPE_ACCESS_NOTICE: &str = "accessNotice";
/// The case of the `access_notice__*` conformance vectors (the rules harnesses skip it).
pub const VECTOR_CASE: &str = "access_notice";

/// `may`: post comments and reviews (the default; consensus decides who may post anyway).
pub const MAY_POST: &str = "post";
/// `may`: post members-only replies on threads it is asked about (needs a post key, phase 4A).
pub const MAY_POST_MEMBERS_ONLY: &str = "postMembersOnly";
/// `may`: read pull requests and issues it is asked about (a `read` key letter per request).
pub const MAY_READ_ON_REQUEST: &str = "readOnRequest";
/// `may`: run checks on members-only branches (a `branch` key letter on every members push).
pub const MAY_CI_MEMBERS_BRANCHES: &str = "ciMembersBranches";
/// `may`: push under its push grants (phase 4E, D42). A newer notice without it suspends the
/// bot's pushes: the runner stops and readers mark later pushes (any maintainer may write one).
pub const MAY_PUSH: &str = "push";
/// The notice field listing the push grants it shows ([`PushEntry`]).
pub const PUSH_FIELD: &str = "push";
/// The notice field holding the runner's push rules ([`PushPolicy`]).
pub const PUSH_POLICY_FIELD: &str = "pushPolicy";
/// The most push grants a notice lists.
pub const PUSH_MAX: usize = 32;

/// The longest `processor` name, in characters.
pub const PROCESSOR_MAX: usize = 100;
/// The longest `note`, in characters.
pub const NOTE_MAX: usize = 500;
/// The most threads a notice lists.
pub const THREADS_MAX: usize = 100;
/// The most earlier notices a notice names in `revokes`.
pub const REVOKES_MAX: usize = 64;
/// The longest ability name a reader keeps.
const ABILITY_MAX: usize = 40;

/// Who may ask the bot to work on something.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Askers {
    /// Members with Write access, maintainers and the owner.
    Writers,
    /// Maintainers and the owner.
    Maintainers,
}

impl Askers {
    /// The stored spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Writers => "writers",
            Self::Maintainers => "maintainers",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "writers" => Some(Self::Writers),
            "maintainers" => Some(Self::Maintainers),
            _ => None,
        }
    }
}

/// Which threads the bot may be asked about.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Threads {
    /// Every issue and pull request.
    All,
    /// These issue and pull request numbers (sorted, each once, at least one).
    Listed(Vec<u32>),
}

impl Threads {
    /// Whether thread `number` is covered.
    #[must_use]
    pub fn covers(&self, number: u32) -> bool {
        match self {
            Self::All => true,
            Self::Listed(ns) => ns.binary_search(&number).is_ok(),
        }
    }
}

/// An access notice (version 1): see the module documentation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessNotice {
    /// The bot's identity id.
    pub bot: [u8; 32],
    /// What it may do (sorted, each once; unknown abilities are kept and grant nothing).
    pub may: Vec<String>,
    /// Who may ask it.
    pub askers: Askers,
    /// Which threads.
    pub threads: Threads,
    /// The AI service that processes what the bot is given, if any.
    pub processor: Option<String>,
    /// When the access ends (ms), if it does.
    pub until: Option<u64>,
    /// The `packHash`es of earlier notices for this bot this one replaces (a record only:
    /// the newest notice counts whatever it names).
    pub revokes: Vec<[u8; 32]>,
    /// A maintainer's note (may be empty).
    pub note: String,
    /// Fields a later version of the notice adds: kept so the bytes re-encode, never read here.
    pub extra: Map<String, Value>,
}

/// One push grant as a notice lists it: `{"grant": id, "match": "prefix", "ref": prefix}` for a
/// public prefix, `{"branch": scope, "grant": id, "members": true}` for one members-only branch
/// (its name hash under the branch key, which the grant document already shows). The grants are
/// the truth; the list says which of them the notice's writer meant.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushEntry {
    /// The grant's document id.
    #[serde(serialize_with = "hex32")]
    pub grant: [u8; 32],
    /// What it covers.
    pub target: PushScope,
}

/// What a [`PushEntry`] covers.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PushScope {
    /// Public refs starting with this prefix (`refs/heads/bot/ci-bot/`).
    Prefix(String),
    /// One members-only branch, by its name hash under the branch key.
    #[serde(serialize_with = "hex32")]
    Members([u8; 32]),
}

fn hex32<S: serde::Serializer>(v: &[u8; 32], s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&hex::encode(v))
}

impl PushEntry {
    fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("grant".into(), Value::String(hex::encode(self.grant)));
        match &self.target {
            PushScope::Prefix(p) => {
                m.insert("match".into(), Value::String("prefix".into()));
                m.insert("ref".into(), Value::String(p.clone()));
            }
            PushScope::Members(h) => {
                m.insert("branch".into(), Value::String(hex::encode(h)));
                m.insert("members".into(), Value::Bool(true));
            }
        }
        Value::Object(m)
    }

    fn from_value(v: &Value) -> Option<Self> {
        let m = v.as_object()?;
        let grant = hex_exact32(m.get("grant")?)?;
        let target = match (m.get("match"), m.get("ref"), m.get("branch"), m.get("members")) {
            (Some(Value::String(k)), Some(Value::String(p)), None, None)
                if k == "prefix" && m.len() == 3 =>
            {
                crate::rules::push_grant::prefix_of(p)
                    .ok()
                    .filter(|full| full == p)?;
                PushScope::Prefix(p.clone())
            }
            (None, None, Some(b), Some(Value::Bool(true))) if m.len() == 3 => {
                PushScope::Members(hex_exact32(b)?)
            }
            _ => return None,
        };
        Some(Self { grant, target })
    }
}

/// The runner's push rules a notice states (`pushPolicy`): conventions, not consensus (DESIGN
/// §4.9 "Not consensus").
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushPolicy {
    /// The bot only fast-forwards a branch (the default).
    pub fast_forward_only: bool,
    /// The bot deletes only branches it pushed itself (the default).
    pub delete_own_only: bool,
    /// The bot never pushes to a branch that exists: it pushes a new branch and opens a pull
    /// request from it.
    pub open_pr_not_push: bool,
}

impl Default for PushPolicy {
    fn default() -> Self {
        Self {
            fast_forward_only: true,
            delete_own_only: true,
            open_pr_not_push: false,
        }
    }
}

impl PushPolicy {
    fn to_value(self) -> Value {
        let mut m = Map::new();
        m.insert("deleteOwnOnly".into(), Value::Bool(self.delete_own_only));
        m.insert("fastForwardOnly".into(), Value::Bool(self.fast_forward_only));
        m.insert("openPrNotPush".into(), Value::Bool(self.open_pr_not_push));
        Value::Object(m)
    }

    fn from_value(v: &Value) -> Option<Self> {
        let m = v.as_object()?;
        let flag = |k: &str| m.get(k)?.as_bool();
        (m.len() == 3).then_some(())?;
        Some(Self {
            fast_forward_only: flag("fastForwardOnly")?,
            delete_own_only: flag("deleteOwnOnly")?,
            open_pr_not_push: flag("openPrNotPush")?,
        })
    }
}

/// The fields this version reads, sorted.
const FIELDS: [&str; 8] = [
    "askers",
    "bot",
    "may",
    "note",
    "processor",
    "revokes",
    "threads",
    "until",
];

fn text_ok(s: &str, max: usize, allow_newline: bool) -> bool {
    s.chars().count() <= max
        && !s
            .chars()
            .any(|c| c.is_control() && !(allow_newline && c == '\n'))
}

impl AccessNotice {
    /// A notice for `bot` allowing nothing, asked by writers, on every thread.
    #[must_use]
    pub fn empty(bot: [u8; 32]) -> Self {
        Self {
            bot,
            may: Vec::new(),
            askers: Askers::Writers,
            threads: Threads::All,
            processor: None,
            until: None,
            revokes: Vec::new(),
            note: String::new(),
            extra: Map::new(),
        }
    }

    /// Whether it lists ability `name`.
    #[must_use]
    pub fn may(&self, name: &str) -> bool {
        self.may.iter().any(|m| m == name)
    }

    /// The push grants it lists (`push`), sorted by grant: empty when it lists none, `None` when
    /// the field is malformed (then it shows no grant and its push ability is suspect: readers
    /// treat it as allowing no push).
    #[must_use]
    pub fn push_entries(&self) -> Option<Vec<PushEntry>> {
        let Some(v) = self.extra.get(PUSH_FIELD) else {
            return Some(Vec::new());
        };
        let items = v.as_array()?;
        let out = items
            .iter()
            .map(PushEntry::from_value)
            .collect::<Option<Vec<_>>>()?;
        (out.len() <= PUSH_MAX && out.windows(2).all(|w| w[0].grant < w[1].grant)).then_some(out)
    }

    /// Its push rules: the stated ones, else the defaults (fast-forward only, delete own only).
    #[must_use]
    pub fn push_policy(&self) -> PushPolicy {
        self.extra
            .get(PUSH_POLICY_FIELD)
            .and_then(PushPolicy::from_value)
            .unwrap_or_default()
    }

    /// Whether it lets the bot push now: `push` among its abilities and a well-formed list.
    #[must_use]
    pub fn allows_push(&self) -> bool {
        self.may(MAY_PUSH) && self.push_entries().is_some()
    }

    /// Set its push ability, list and rules: with entries, `push` joins `may` and both fields
    /// are written; with none, `push` leaves `may` and both fields are removed (a suspension).
    pub fn set_push(&mut self, mut entries: Vec<PushEntry>, policy: PushPolicy) {
        entries.sort_by(|a, b| a.grant.cmp(&b.grant));
        entries.dedup_by(|a, b| a.grant == b.grant);
        self.may.retain(|m| m != MAY_PUSH);
        if entries.is_empty() {
            self.extra.remove(PUSH_FIELD);
            self.extra.remove(PUSH_POLICY_FIELD);
            return;
        }
        self.may.push(MAY_PUSH.to_owned());
        self.may.sort();
        self.extra.insert(
            PUSH_FIELD.into(),
            Value::Array(entries.iter().map(PushEntry::to_value).collect()),
        );
        self.extra
            .insert(PUSH_POLICY_FIELD.into(), policy.to_value());
    }

    /// Whether it still allows anything at `now` (ms): before its `until`.
    #[must_use]
    pub fn live_at(&self, now: u64) -> bool {
        self.until.is_none_or(|u| now < u)
    }

    /// The typed letter, or `None` for what a writer never makes (unsorted or repeated `may`,
    /// threads or revokes, an empty processor, text past its bounds or with control characters,
    /// a thread 0, a field of this version among `extra`).
    #[must_use]
    pub fn to_typed(&self) -> Option<TypedLetter> {
        if !self.well_formed() || FIELDS.iter().any(|k| self.extra.contains_key(*k)) {
            return None;
        }
        let mut t = TypedLetter::new(TYPE_ACCESS_NOTICE, 1);
        t.fields.clone_from(&self.extra);
        let f = &mut t.fields;
        f.insert("askers".into(), Value::String(self.askers.as_str().into()));
        f.insert("bot".into(), Value::String(hex::encode(self.bot)));
        f.insert(
            "may".into(),
            Value::Array(self.may.iter().cloned().map(Value::String).collect()),
        );
        f.insert("note".into(), Value::String(self.note.clone()));
        f.insert(
            "processor".into(),
            self.processor.clone().map_or(Value::Null, Value::String),
        );
        f.insert(
            "revokes".into(),
            Value::Array(
                self.revokes
                    .iter()
                    .map(|h| Value::String(hex::encode(h)))
                    .collect(),
            ),
        );
        f.insert(
            "threads".into(),
            match &self.threads {
                Threads::All => Value::String("all".into()),
                Threads::Listed(ns) => Value::Array(ns.iter().map(|n| Value::from(*n)).collect()),
            },
        );
        f.insert("until".into(), self.until.map_or(Value::Null, Value::from));
        Some(t)
    }

    /// The padded plaintext a public repository stores.
    pub fn encode(&self) -> Result<Zeroizing<Vec<u8>>, LetterError> {
        self.to_typed()
            .ok_or(LetterError::Invalid("not a well-formed access notice"))?
            .encode()
    }

    /// A notice of version 1 read from `t`, or `None`: another type or version, a field of
    /// this version missing or of the wrong shape, or anything [`Self::to_typed`] refuses.
    #[must_use]
    pub fn from_typed(t: &TypedLetter) -> Option<Self> {
        if t.kind != TYPE_ACCESS_NOTICE || t.v != 1 {
            return None;
        }
        let f = &t.fields;
        if !FIELDS.iter().all(|k| f.contains_key(*k)) {
            return None;
        }
        let str_of = |k: &str| f.get(k)?.as_str();
        let opt_str = |k: &str| match f.get(k)? {
            Value::Null => Some(None),
            Value::String(s) => Some(Some(s.clone())),
            _ => None,
        };
        let bot = hex_exact32(f.get("bot")?)?;
        let may = f
            .get("may")?
            .as_array()?
            .iter()
            .map(|v| v.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()?;
        let threads = match f.get("threads")? {
            Value::String(s) if s == "all" => Threads::All,
            Value::Array(items) => Threads::Listed(
                items
                    .iter()
                    .map(|n| n.as_u64().and_then(|n| u32::try_from(n).ok()))
                    .collect::<Option<Vec<_>>>()?,
            ),
            _ => return None,
        };
        let revokes = f
            .get("revokes")?
            .as_array()?
            .iter()
            .map(hex_exact32)
            .collect::<Option<Vec<_>>>()?;
        let until = match f.get("until")? {
            Value::Null => None,
            v => Some(v.as_u64()?),
        };
        let extra: Map<String, Value> = f
            .iter()
            .filter(|(k, _)| !FIELDS.contains(&k.as_str()))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let notice = Self {
            bot,
            may,
            askers: Askers::parse(str_of("askers")?)?,
            threads,
            processor: opt_str("processor")?,
            until,
            revokes,
            note: str_of("note")?.to_owned(),
            extra,
        };
        notice.well_formed().then_some(notice)
    }

    /// Read a public repository's notice bytes (the exact canonical form only).
    #[must_use]
    pub fn decode(plain: &[u8]) -> Option<Self> {
        Self::from_typed(&TypedLetter::decode(plain)?)
    }

    fn well_formed(&self) -> bool {
        let may = self.may.iter().all(|m| {
            !m.is_empty()
                && m.chars().count() <= ABILITY_MAX
                && m.chars().all(|c| c.is_ascii_alphanumeric())
        }) && self.may.windows(2).all(|w| w[0] < w[1]);
        let threads = match &self.threads {
            Threads::All => true,
            Threads::Listed(ns) => {
                !ns.is_empty()
                    && ns.len() <= THREADS_MAX
                    && ns[0] >= 1
                    && ns.windows(2).all(|w| w[0] < w[1])
            }
        };
        let processor = self
            .processor
            .as_deref()
            .is_none_or(|p| !p.trim().is_empty() && text_ok(p, PROCESSOR_MAX, false));
        let revokes =
            self.revokes.len() <= REVOKES_MAX && self.revokes.windows(2).all(|w| w[0] < w[1]);
        may && threads
            && processor
            && revokes
            && text_ok(&self.note, NOTE_MAX, true)
            && self.until.is_none_or(|u| u <= MAX_INT)
    }
}

/// `ms` as the access copy writes a date: `30 Nov 2026` (UTC).
#[must_use]
pub fn date_words(ms: u64) -> String {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let utc = crate::env::service::utc(ms);
    let date = utc.split(' ').next().unwrap_or_default();
    let mut parts = date.split('-');
    let (y, m, d) = (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
    );
    let month = m
        .parse::<usize>()
        .ok()
        .and_then(|m| MONTHS.get(m.wrapping_sub(1)))
        .copied()
        .unwrap_or("");
    format!("{} {month} {y}", d.trim_start_matches('0'))
}

/// `a`, `a and b`, `a, b and c`.
fn list_words(items: &[&str]) -> String {
    match items.split_last() {
        Some((last, [])) => (*last).to_owned(),
        Some((last, rest)) => format!("{} and {last}", rest.join(", ")),
        None => String::new(),
    }
}

/// The line everyone reads about a bot's access (DESIGN §10 "Public line"), for `bot` as the
/// copy names it (`@ci-bot`), at `now` (ms): `@ci-bot can post here and read pull requests and
/// issues it's asked about. Asked by writers and maintainers. Processed by <service>. Until
/// 30 Nov 2026.` A notice that allows nothing, or has ended, says so.
#[must_use]
pub fn public_line(n: &AccessNotice, bot: &str, now: u64) -> String {
    if let Some(until) = n.until.filter(|_| !n.live_at(now)) {
        return format!("{bot}'s access ended on {}.", date_words(until));
    }
    let mut can: Vec<&str> = Vec::new();
    if n.may(MAY_POST) {
        can.push("post here");
    }
    if n.may(MAY_POST_MEMBERS_ONLY) {
        can.push("post members-only replies on threads it's asked about");
    }
    if n.may(MAY_READ_ON_REQUEST) {
        can.push("read pull requests and issues it's asked about");
    }
    if n.may(MAY_CI_MEMBERS_BRANCHES) {
        can.push("run checks on members-only branches");
    }
    if can.is_empty() {
        return format!("{bot} has no access here.");
    }
    let mut out = format!("{bot} can {}.", list_words(&can));
    out.push_str(match n.askers {
        Askers::Writers => " Asked by writers and maintainers.",
        Askers::Maintainers => " Asked by maintainers.",
    });
    if let Threads::Listed(ns) = &n.threads {
        let ns: Vec<String> = ns.iter().map(|n| format!("#{n}")).collect();
        let ns: Vec<&str> = ns.iter().map(String::as_str).collect();
        let _ = write!(out, " Only on {}.", list_words(&ns));
    }
    if let Some(p) = &n.processor {
        let _ = write!(out, " Processed by {p}.");
    }
    if let Some(u) = n.until {
        let _ = write!(out, " Until {}.", date_words(u));
    }
    out
}

/// The line everyone reads about a bot's push access (DESIGN §10 "Public line addition"), for
/// each prefix it may push to with when that ends: `Can push to bot/ci-bot/ until 7 Nov 2026.`;
/// members-only branches are counted, never named: `Can push to 1 members-only branch.` `None`
/// when it may push nowhere.
#[must_use]
pub fn push_line(prefixes: &[(&str, u64)], members_branches: usize) -> Option<String> {
    let mut parts: Vec<String> = prefixes
        .iter()
        .map(|(p, until)| {
            format!(
                "{} until {}",
                crate::rules::push_grant::short_prefix(p),
                date_words(*until)
            )
        })
        .collect();
    match members_branches {
        0 => {}
        1 => parts.push("1 members-only branch".into()),
        n => parts.push(format!("{n} members-only branches")),
    }
    let parts: Vec<&str> = parts.iter().map(String::as_str).collect();
    (!parts.is_empty()).then(|| format!("Can push to {}.", list_words(&parts)))
}

fn hex_exact32(v: &Value) -> Option<[u8; 32]> {
    let s = v.as_str()?;
    if s.len() != 64 || s.bytes().any(|c| c.is_ascii_uppercase()) {
        return None;
    }
    hex::decode(s).ok()?.try_into().ok()
}

/// One notice as a repository holds it: its manifest and what it says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoticeEntry {
    /// The kind-11 manifest's document id.
    pub id: String,
    /// Its `$ownerId`: the maintainer who wrote it.
    pub writer: String,
    /// Its `$createdAt` (ms).
    pub created_at: u64,
    /// Its `packHash`.
    pub pack_hash: [u8; 32],
    /// The notice.
    pub notice: AccessNotice,
}

/// The notice that counts for each bot (by its id, hex): the newest (by `$createdAt`, then
/// manifest id) among those whose writer `is_maintainer` says is a current maintainer or the
/// owner. Notices from anyone else are left out.
#[must_use]
pub fn current(
    entries: &[NoticeEntry],
    is_maintainer: impl Fn(&str) -> bool,
) -> BTreeMap<[u8; 32], &NoticeEntry> {
    let mut out: BTreeMap<[u8; 32], &NoticeEntry> = BTreeMap::new();
    for e in entries.iter().filter(|e| is_maintainer(&e.writer)) {
        let newer = out
            .get(&e.notice.bot)
            .is_none_or(|old| (e.created_at, &e.id) > (old.created_at, &old.id));
        if newer {
            out.insert(e.notice.bot, e);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notice() -> AccessNotice {
        AccessNotice {
            bot: [4; 32],
            may: vec![MAY_POST.into(), MAY_READ_ON_REQUEST.into()],
            askers: Askers::Writers,
            threads: Threads::Listed(vec![42, 57]),
            processor: Some("Example AI".into()),
            until: Some(1_767_225_600_000),
            revokes: vec![[1; 32]],
            note: "for CI\nand reviews".into(),
            extra: Map::new(),
        }
    }

    #[test]
    fn a_notice_round_trips_through_the_canonical_bytes() {
        let pt = notice().encode().unwrap();
        let s = String::from_utf8(pt.to_vec()).unwrap();
        assert!(s.starts_with("{\"askers\":\"writers\",\"bot\":\""), "{s}");
        assert!(s
            .trim_end()
            .ends_with("\"type\":\"accessNotice\",\"until\":1767225600000,\"v\":1}"));
        assert_eq!(AccessNotice::decode(&pt).unwrap(), notice());
    }

    #[test]
    fn a_later_field_is_kept_and_unknown_abilities_grant_nothing() {
        let mut n = notice();
        n.may = vec!["post".into(), "push".into()];
        n.extra.insert("push".into(), Value::Array(vec![]));
        let back = AccessNotice::decode(&n.encode().unwrap()).unwrap();
        assert_eq!(back, n);
        assert!(back.may("push") && !back.may(MAY_READ_ON_REQUEST));
    }

    #[test]
    fn a_notice_refuses_what_a_writer_never_makes() {
        let mut n = notice();
        n.may.reverse();
        assert!(n.to_typed().is_none());
        let mut n = notice();
        n.threads = Threads::Listed(vec![]);
        assert!(n.to_typed().is_none());
        let mut n = notice();
        n.threads = Threads::Listed(vec![0, 1]);
        assert!(n.to_typed().is_none());
        let mut n = notice();
        n.processor = Some(" ".into());
        assert!(n.to_typed().is_none());
        let mut n = notice();
        n.note = "a\u{7}b".into();
        assert!(n.to_typed().is_none());
        let mut n = notice();
        n.extra.insert("bot".into(), Value::Null);
        assert!(n.to_typed().is_none());
    }

    #[test]
    fn a_push_list_round_trips_and_suspending_removes_it() {
        let mut n = notice();
        n.set_push(
            vec![
                PushEntry {
                    grant: [9; 32],
                    target: PushScope::Members([3; 32]),
                },
                PushEntry {
                    grant: [2; 32],
                    target: PushScope::Prefix("refs/heads/bot/ci-bot/".into()),
                },
            ],
            PushPolicy::default(),
        );
        assert!(n.may(MAY_PUSH) && n.allows_push());
        let back = AccessNotice::decode(&n.encode().unwrap()).unwrap();
        let entries = back.push_entries().unwrap();
        assert_eq!(entries[0].grant, [2; 32]);
        assert_eq!(entries[1].target, PushScope::Members([3; 32]));
        assert_eq!(back.push_policy(), PushPolicy::default());
        let s = String::from_utf8(n.encode().unwrap().to_vec()).unwrap();
        assert!(s.contains("\"pushPolicy\":{\"deleteOwnOnly\":true,\"fastForwardOnly\":true,\"openPrNotPush\":false}"), "{s}");
        n.set_push(Vec::new(), PushPolicy::default());
        assert!(!n.may(MAY_PUSH) && !n.extra.contains_key(PUSH_FIELD));
        // a malformed list allows no push
        let mut bad = notice();
        bad.may.push(MAY_PUSH.into());
        bad.may.sort();
        bad.extra.insert(PUSH_FIELD.into(), Value::String("x".into()));
        assert!(!bad.allows_push());
        assert_eq!(
            push_line(&[("refs/heads/bot/ci-bot/", 1_794_009_600_000)], 1).unwrap(),
            "Can push to bot/ci-bot/ until 7 Nov 2026 and 1 members-only branch."
        );
    }

    #[test]
    fn the_newest_notice_from_a_current_maintainer_counts() {
        let e = |id: &str, writer: &str, at: u64, may: &[&str]| NoticeEntry {
            id: id.into(),
            writer: writer.into(),
            created_at: at,
            pack_hash: [0; 32],
            notice: AccessNotice {
                may: may.iter().map(|s| (*s).to_owned()).collect(),
                ..notice()
            },
        };
        let entries = vec![
            e("a", "m1", 1, &["post"]),
            e("b", "m2", 2, &["post", "readOnRequest"]),
            e("c", "gone", 3, &[]),
        ];
        let cur = current(&entries, |w| w != "gone");
        assert_eq!(cur[&[4; 32]].id, "b");
        let cur = current(&entries, |w| w == "m1");
        assert_eq!(cur[&[4; 32]].id, "a");
        assert!(notice().live_at(1) && !notice().live_at(1_767_225_600_000));
    }

    #[test]
    fn the_public_line_reads_as_the_design_says() {
        let n = AccessNotice {
            threads: Threads::All,
            ..notice()
        };
        assert_eq!(
            public_line(&n, "@ci-bot", 0),
            "@ci-bot can post here and read pull requests and issues it's asked about. Asked by \
             writers and maintainers. Processed by Example AI. Until 1 Jan 2026."
        );
        assert_eq!(
            public_line(&n, "@ci-bot", 1_767_225_600_000),
            "@ci-bot's access ended on 1 Jan 2026."
        );
        let listed = AccessNotice {
            may: vec![MAY_CI_MEMBERS_BRANCHES.into()],
            askers: Askers::Maintainers,
            processor: None,
            until: None,
            ..notice()
        };
        assert_eq!(
            public_line(&listed, "@b", 0),
            "@b can run checks on members-only branches. Asked by maintainers. Only on #42 and #57."
        );
        assert_eq!(
            public_line(&AccessNotice::empty([0; 32]), "@b", 0),
            "@b has no access here."
        );
    }
}
