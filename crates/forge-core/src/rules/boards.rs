//! Boards (`docs/design/boards.md`): the pure rules every client applies to a board's
//! documents, so `dg board` and the web show the same board. A port of forge-web's
//! `lib/rules/boards.ts`; the `board_*__*.json` vectors in `forge-contracts/vectors/` pin the
//! two together ([`tests::board_vectors`] here, `lib/rules/boards.conformance.test.ts` there).
//!
//! * **Spec** (§2.1–§2.3, §4, §8): the board definition a `board` document's `spec` holds,
//!   parsed strictly ([`parse_spec`]) and written canonically ([`serialize_spec`]); a card's
//!   field values ([`parse_field_values`], [`serialize_field_values`]).
//! * **Rank** (§2.6): base-62 fractional ranks ([`rank_between`], [`implicit_rank`],
//!   [`top_rank`], [`bottom_rank`], [`rerank`]).
//! * **Fold** (§2.4): where every item shows ([`fold_board`]), and the newest board revision
//!   per key ([`newest_boards`]).
//! * **Query** (§4.4): [`parse_board_query`], [`matches_board_query`].
//! * **Iterations** (§2.2): [`iteration_at`], [`iteration_range`].
//! * **Views** (§4.1–§4.5): [`group_rows`], [`sort_rows`], [`column_totals`],
//!   [`iteration_progress`].
//!
//! Everything is pure: no SDK, no clock (`now` is an input), no I/O. Strings compare by code
//! point (Rust's `str` order, the web's `compareStrings`).

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write as _;

use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Map, Value};

use super::search::{search_terms, tokens};

/// The vector case prefix: `board_rank`, `board_spec`, `board_fold`, `board_query`,
/// `board_iteration`, `board_view`.
pub const VECTOR_CASE_PREFIX: &str = "board_";

/// A `board.spec` holds at most this many UTF-8 bytes (the contract's `maxBytes`).
pub const SPEC_MAX_BYTES: usize = 4096;
/// A `card.f` holds at most this many UTF-8 bytes.
pub const FIELD_VALUES_MAX_BYTES: usize = 2048;
/// At most 20 status columns.
pub const MAX_COLUMNS: usize = 20;
/// At most 12 custom fields.
pub const MAX_FIELDS: usize = 12;
/// At most 30 options per single-select field.
pub const MAX_OPTIONS: usize = 30;
/// At most 5 sources.
pub const MAX_SOURCES: usize = 5;
/// At most 8 saved views.
pub const MAX_VIEWS: usize = 8;
/// A view lists at most this many table columns.
pub const MAX_VIEW_COLS: usize = 24;
/// Column, field, option and view names: 1–63 characters.
pub const NAME_MAX: usize = 63;
/// A board's description: at most this many characters.
pub const DESC_MAX: usize = 1024;
/// A source's or view's query: at most this many characters (the issue list's `Q_MAX`).
pub const QUERY_MAX: usize = 512;
/// A text field's value: 1–200 characters.
pub const TEXT_VALUE_MAX: usize = 200;
/// A column's WIP limit: 1–9999.
pub const WIP_MAX: i64 = 9999;
/// An iteration field's length: 1–90 days.
pub const ITER_DAYS_MAX: i64 = 90;
/// The highest iteration index a card may name.
pub const ITER_INDEX_MAX: i64 = 65535;
/// Auto-archive after at most this many days (0 = off).
pub const ARCH_MAX: i64 = 3650;
/// A number field's value: finite, |x| ≤ 1e15, and 0 or |x| ≥ 1e-6 (both clients print it alike).
pub const NUM_ABS_MAX: f64 = 1e15;
/// See [`NUM_ABS_MAX`].
pub const NUM_ABS_MIN: f64 = 1e-6;
/// An explicit rank is at most 63 characters (the `card.rank` schema).
pub const RANK_MAX: usize = 63;
/// Ranks are re-spread for at most this many items at once.
pub const RERANK_MAX: u64 = 1_000_000;

const DAY_MS: i64 = 86_400_000;

// ---------------------------------------------------------------------------------------------
// Shared value shapes
// ---------------------------------------------------------------------------------------------

/// A number or a string: a field value (an option id, a number, `YYYY-MM-DD`, an iteration
/// index, text), a query operand, a group key. A whole number serializes as a JSON integer, as
/// the web's `JSON.stringify` writes it.
#[derive(Debug, Clone, PartialEq)]
pub enum Scalar {
    /// A number.
    Num(f64),
    /// A string.
    Text(String),
}

impl Scalar {
    fn num(&self) -> Option<f64> {
        match self {
            Self::Num(x) => Some(*x),
            Self::Text(_) => None,
        }
    }

    fn text(&self) -> Option<&str> {
        match self {
            Self::Num(_) => None,
            Self::Text(t) => Some(t),
        }
    }

    /// As `String(v)` writes it.
    fn display(&self) -> String {
        match self {
            Self::Num(x) => js_number(*x),
            Self::Text(t) => t.clone(),
        }
    }
}

impl From<i64> for Scalar {
    #[allow(clippy::cast_precision_loss)] // ids, indices and counts: far below 2^53
    fn from(n: i64) -> Self {
        Self::Num(n as f64)
    }
}

impl Serialize for Scalar {
    #[allow(clippy::cast_possible_truncation, clippy::float_cmp)] // a whole number below 2^53
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Text(t) => s.serialize_str(t),
            Self::Num(x) if x.fract() == 0.0 && x.abs() < 9_007_199_254_740_992.0 => {
                s.serialize_i64(*x as i64)
            }
            Self::Num(x) => s.serialize_f64(*x),
        }
    }
}

/// A finite number as JavaScript's `String(x)` writes it, for |x| in [1e-6, 1e21) or 0 (the
/// numbers a board stores and sums): ryu's shortest round-trip digits (JavaScript's, ties to
/// even; Rust's own `{}` rounds an exact tie up), written without an exponent; `-0` as `0`.
#[allow(clippy::float_cmp, clippy::cast_possible_truncation)] // -0 == 0; a whole number below 2^53
fn js_number(x: f64) -> String {
    if x == 0.0 {
        return "0".into();
    }
    if x.fract() == 0.0 && x.abs() < 9_007_199_254_740_992.0 {
        return format!("{}", x as i64);
    }
    // serde_json writes f64 with ryu: `71292843364840.12`, `1.5e-6`, `1.152921504606847e+18`
    let ryu = serde_json::to_string(&x).unwrap_or_default();
    let (sign, body) = ryu
        .strip_prefix('-')
        .map_or(("", ryu.as_str()), |b| ("-", b));
    let (mantissa, exp) = body
        .split_once('e')
        .map_or((body, 0), |(m, e)| (m, e.parse::<i64>().unwrap_or(0)));
    let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let all = format!("{int}{frac}");
    let digits = all.trim_start_matches('0');
    // the decimal point sits `point` digits into `digits`
    let point = i64::try_from(int.len()).unwrap_or(0) + exp
        - i64::try_from(all.len() - digits.len()).unwrap_or(0);
    let digits = digits.trim_end_matches('0');
    let len = i64::try_from(digits.len()).unwrap_or(0);
    let zeros = |n: i64| "0".repeat(usize::try_from(n).unwrap_or(0));
    if point <= 0 {
        format!("{sign}0.{}{digits}", zeros(-point))
    } else if point >= len {
        format!("{sign}{digits}{}", zeros(point - len))
    } else {
        let at = usize::try_from(point).unwrap_or(0);
        format!("{sign}{}.{}", &digits[..at], &digits[at..])
    }
}

/// `s`'s length in characters (code points: the contract's `maxLength`).
fn char_len(s: &str) -> usize {
    s.chars().count()
}

/// The white space a name may not start or end with: JavaScript's `trim` set less the
/// controls (refused anyway).
fn is_space(c: char) -> bool {
    matches!(
        c as u32,
        0x20 | 0xa0 | 0x1680 | 0x2000
            ..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff
    )
}

/// C0, DEL and C1 control characters.
fn is_control(c: char) -> bool {
    let x = c as u32;
    x < 0x20 || (0x7f..=0x9f).contains(&x)
}

/// A column, field, option or view name: 1–63 characters, no control character or `"` (a
/// query quotes names with `"`), not starting or ending with white space.
fn name_ok(s: &str) -> bool {
    (1..=NAME_MAX).contains(&char_len(s))
        && !s.chars().any(|c| is_control(c) || c == '"')
        && !s.chars().next().is_some_and(is_space)
        && !s.chars().last().is_some_and(is_space)
}

/// A JSON number that is a whole number in `min..=max` (the web's `Number.isInteger` check).
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::float_cmp
)]
fn int_in(v: Option<&Value>, min: i64, max: i64) -> Option<i64> {
    let x = v?.as_f64()?;
    (x.fract() == 0.0 && x >= min as f64 && x <= max as f64).then_some(x as i64)
}

/// A JSON string of at most `max` characters.
fn text_in(v: &Value, max: usize) -> Option<String> {
    v.as_str()
        .filter(|s| char_len(s) <= max)
        .map(str::to_string)
}

fn is_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s.bytes().skip(1).all(|b| b.is_ascii_hexdigit())
}

/// An identity or document id: 42–44 base58 characters (the web's `isIdentityId`).
fn is_identifier(s: &str) -> bool {
    (42..=44).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() && !matches!(b, b'0' | b'O' | b'I' | b'l'))
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Hinnant's `days_from_civil`).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let yy = if m <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The date `days` after 1970-01-01, as `YYYY-MM-DD` (Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// A `YYYY-MM-DD` calendar date's day number (days since 1970-01-01), or `None`.
#[must_use]
pub fn date_days(s: &str) -> Option<i64> {
    let bytes = s.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || ![0, 1, 2, 3, 5, 6, 8, 9]
            .iter()
            .all(|&i| bytes[i].is_ascii_digit())
    {
        return None;
    }
    let (y, m, d) = (
        s[0..4].parse::<i64>().ok()?,
        s[5..7].parse::<i64>().ok()?,
        s[8..10].parse::<i64>().ok()?,
    );
    if y < 1 || !(1..=12).contains(&m) || d < 1 {
        return None;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let len = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    (d <= len[usize::try_from(m - 1).ok()?]).then(|| days_from_civil(y, m, d))
}

/// The UTC date of a millisecond time, as `YYYY-MM-DD`.
#[must_use]
pub fn date_of(ms: i64) -> String {
    civil_from_days(ms.div_euclid(DAY_MS))
}

fn is_zero<T: Default + PartialEq>(x: &T) -> bool {
    *x == T::default()
}

// ---------------------------------------------------------------------------------------------
// Spec (§2.1–§2.3, §4)
// ---------------------------------------------------------------------------------------------

/// A status column (§2.1): `id` 1–255 stable across renames; order is the array order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BoardColumn {
    /// 1–255.
    pub id: u8,
    /// The column's name.
    pub name: String,
    /// `#rrggbb`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// WIP limit (§4.5): shown and warned on, never blocking.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wip: Option<u16>,
}

/// The custom field types (§2.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldType {
    /// Single select: an option id.
    Sel,
    /// A finite number.
    Num,
    /// `YYYY-MM-DD`.
    Date,
    /// An iteration index.
    Iter,
    /// Text, 1–200 characters.
    Text,
}

/// A single-select option.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FieldOption {
    /// 1–255.
    pub id: u8,
    /// The option's name.
    pub name: String,
    /// `#rrggbb`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// A custom field (§2.2). `options` is present exactly for `sel`; `start` (`YYYY-MM-DD`) and
/// `days` (1–90) exactly for `iter`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BoardField {
    /// 1–255.
    pub id: u8,
    /// The field's name.
    pub name: String,
    /// The type.
    #[serde(rename = "type")]
    pub kind: FieldType,
    /// A `sel` field's options.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<FieldOption>>,
    /// An `iter` field's first day.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<String>,
    /// An `iter` field's length in days.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub days: Option<u8>,
}

/// A source's kind: issues, pull requests, or both.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum SourceKind {
    /// Issues.
    #[serde(rename = "i")]
    Issues,
    /// Pull requests.
    #[serde(rename = "p")]
    Pulls,
    /// Both.
    #[serde(rename = "a")]
    All,
}

/// An auto-include rule (§2.3): every item of repository `r` (absent: the home repository) of
/// kind `k` that query `q` matches is on the board ([`parse_source_query`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BoardSource {
    /// The repository id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r: Option<String>,
    /// The kind.
    pub k: SourceKind,
    /// The filter, empty for all.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub q: String,
}

/// A view's layout (§4.1–§4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ViewLayout {
    /// Columns of cards.
    Board,
    /// Rows.
    Table,
    /// A timeline.
    Roadmap,
}

/// A saved view (§4); its keys as the web's `BoardView` documents them (`status`, `assignee`,
/// `label`, `milestone`, `repo`, `f<id>`, …).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BoardView {
    /// 1–255.
    pub id: u8,
    /// The view's name.
    pub name: String,
    /// The layout.
    pub layout: ViewLayout,
    /// The filter.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub q: String,
    /// The grouping (board columns, table sections); absent is `status`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// Swimlanes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lane: Option<String>,
    /// The sort, `-` first for descending; absent is `rank`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort: Option<String>,
    /// The fields shown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cols: Option<Vec<String>>,
    /// The roadmap's dates: one `iter` field, or a start and an end `date` field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<Vec<u8>>,
}

/// A board definition, `v: 1` (§2). `def` / `done` are column ids, 0 for none; `arch` is
/// days, 0 = off. Serializes canonically: the declared key order, defaults omitted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BoardSpec {
    /// Always 1.
    pub v: u8,
    /// The description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desc: Option<String>,
    /// 1–20 columns.
    pub columns: Vec<BoardColumn>,
    /// The default column.
    #[serde(skip_serializing_if = "is_zero")]
    pub def: u8,
    /// The Done column.
    #[serde(skip_serializing_if = "is_zero")]
    pub done: u8,
    /// Auto-include rules.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<BoardSource>,
    /// Custom fields.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<BoardField>,
    /// Saved views.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub views: Vec<BoardView>,
    /// Auto-archive after this many days.
    #[serde(skip_serializing_if = "is_zero")]
    pub arch: u16,
}

impl BoardSpec {
    /// A field by id.
    #[must_use]
    pub fn field(&self, id: u8) -> Option<&BoardField> {
        self.fields.iter().find(|f| f.id == id)
    }

    fn column_index(&self, id: u8) -> Option<usize> {
        self.columns.iter().position(|c| c.id == id)
    }
}

/// Why a spec was refused (the web's `SpecError`): not JSON or not an object, not `v: 1`,
/// over 4096 bytes, or the part that is malformed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpecError {
    /// Not JSON, or not an object.
    Json,
    /// Not `v: 1`.
    Version,
    /// Over 4096 bytes.
    Size,
    /// The description.
    Desc,
    /// The column list.
    Columns,
    /// A column (malformed or repeated).
    Column,
    /// `def`.
    Def,
    /// `done`.
    Done,
    /// The source list.
    Sources,
    /// A source.
    Source,
    /// The field list.
    Fields,
    /// A field (malformed, repeated or reserved).
    Field,
    /// A field's options.
    Options,
    /// The view list.
    Views,
    /// A view.
    View,
    /// `arch`.
    Arch,
}

impl SpecError {
    /// The code both clients name it by.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Json => "json",
            Self::Version => "version",
            Self::Size => "size",
            Self::Desc => "desc",
            Self::Columns => "columns",
            Self::Column => "column",
            Self::Def => "def",
            Self::Done => "done",
            Self::Sources => "sources",
            Self::Source => "source",
            Self::Fields => "fields",
            Self::Field => "field",
            Self::Options => "options",
            Self::Views => "views",
            Self::View => "view",
            Self::Arch => "arch",
        }
    }
}

impl std::fmt::Display for SpecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::error::Error for SpecError {}

/// Names a field may not have, in any letter case: the query's own keys and the built-in
/// fields (§2.2, §4.4).
const RESERVED_FIELD_NAMES: &[&str] = &[
    "is",
    "state",
    "label",
    "labels",
    "assignee",
    "assignees",
    "author",
    "milestone",
    "no",
    "status",
    "repo",
    "repository",
    "title",
    "number",
    "created",
];
const GROUP_BUILTINS: &[&str] = &["status", "assignee", "label", "milestone", "repo"];
const SORT_BUILTINS: &[&str] = &[
    "rank",
    "title",
    "number",
    "created",
    "status",
    "repo",
    "author",
    "milestone",
];
const COL_BUILTINS: &[&str] = &[
    "title",
    "number",
    "repo",
    "state",
    "author",
    "assignees",
    "labels",
    "milestone",
    "created",
    "status",
];

/// The field id a `f<id>` key names (1–255, no leading zero).
#[must_use]
pub fn field_key_id(key: &str) -> Option<u8> {
    let digits = key.strip_prefix('f')?;
    if digits.is_empty()
        || digits.len() > 3
        || digits.starts_with('0')
        || !digits.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    digits.parse::<u8>().ok()
}

fn field_of_key<'a>(fields: &'a [BoardField], key: &str) -> Option<&'a BoardField> {
    let id = field_key_id(key)?;
    fields.iter().find(|f| f.id == id)
}

fn group_key_ok(fields: &[BoardField], key: &str, board_layout: bool) -> bool {
    if key == "status" {
        return true;
    }
    if GROUP_BUILTINS.contains(&key) {
        return !board_layout;
    }
    field_of_key(fields, key).is_some_and(|f| matches!(f.kind, FieldType::Sel | FieldType::Iter))
}

fn sort_key_ok(fields: &[BoardField], key: &str) -> bool {
    let k = key.strip_prefix('-').unwrap_or(key);
    SORT_BUILTINS.contains(&k) || field_of_key(fields, k).is_some()
}

fn col_key_ok(fields: &[BoardField], key: &str) -> bool {
    COL_BUILTINS.contains(&key) || field_of_key(fields, key).is_some()
}

/// Whether ids or names (in lower case) repeat.
fn repeats<'a>(entries: impl Iterator<Item = (u8, &'a str)> + Clone) -> bool {
    let n = entries.clone().count();
    let ids: HashSet<u8> = entries.clone().map(|(id, _)| id).collect();
    let names: HashSet<String> = entries.map(|(_, name)| name.to_lowercase()).collect();
    ids.len() != n || names.len() != n
}

fn color_of(v: Option<&Value>, err: SpecError) -> Result<Option<String>, SpecError> {
    match v {
        None => Ok(None),
        Some(v) => v
            .as_str()
            .filter(|s| is_color(s))
            .map(|s| Some(s.to_string()))
            .ok_or(err),
    }
}

/// An entry's `id` (1–255) and `name`.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // 1..=255
fn id_name(o: &Map<String, Value>, name_ok: impl Fn(&str) -> bool) -> Option<(u8, String)> {
    let id = int_in(o.get("id"), 1, 255)? as u8;
    let name = o.get("name")?.as_str().filter(|n| name_ok(n))?;
    Some((id, name.to_string()))
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // 1..=9999
fn parse_columns(v: Option<&Value>) -> Result<Vec<BoardColumn>, SpecError> {
    let list = v
        .and_then(Value::as_array)
        .filter(|l| (1..=MAX_COLUMNS).contains(&l.len()))
        .ok_or(SpecError::Columns)?;
    let mut out = Vec::new();
    for c in list {
        let o = c.as_object().ok_or(SpecError::Column)?;
        let (id, name) = id_name(o, name_ok).ok_or(SpecError::Column)?;
        let color = color_of(o.get("color"), SpecError::Column)?;
        let wip = match o.get("wip") {
            None => None,
            Some(w) => Some(int_in(Some(w), 1, WIP_MAX).ok_or(SpecError::Column)? as u16),
        };
        out.push(BoardColumn {
            id,
            name,
            color,
            wip,
        });
    }
    if repeats(out.iter().map(|c| (c.id, c.name.as_str()))) {
        return Err(SpecError::Column);
    }
    Ok(out)
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // 0..=255
fn parse_column_ref(
    v: Option<&Value>,
    columns: &[BoardColumn],
    err: SpecError,
) -> Result<u8, SpecError> {
    let Some(v) = v else { return Ok(0) };
    let id = int_in(Some(v), 0, 255).ok_or(err)? as u8;
    if id != 0 && !columns.iter().any(|c| c.id == id) {
        return Err(err);
    }
    Ok(id)
}

fn parse_sources(value: Option<&Value>) -> Result<Vec<BoardSource>, SpecError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let list = value
        .as_array()
        .filter(|l| l.len() <= MAX_SOURCES)
        .ok_or(SpecError::Sources)?;
    list.iter()
        .map(|entry| {
            let obj = entry.as_object().ok_or(SpecError::Source)?;
            let r = match obj.get("r") {
                None => None,
                Some(repo) => Some(
                    repo.as_str()
                        .filter(|id| is_identifier(id))
                        .ok_or(SpecError::Source)?
                        .to_string(),
                ),
            };
            let k = match obj.get("k").and_then(Value::as_str) {
                Some("i") => SourceKind::Issues,
                Some("p") => SourceKind::Pulls,
                Some("a") => SourceKind::All,
                _ => return Err(SpecError::Source),
            };
            let q = match obj.get("q") {
                None => String::new(),
                Some(text) => text_in(text, QUERY_MAX).ok_or(SpecError::Source)?,
            };
            Ok(BoardSource { r, k, q })
        })
        .collect()
}

fn parse_options(v: Option<&Value>) -> Result<Vec<FieldOption>, SpecError> {
    let list = v
        .and_then(Value::as_array)
        .filter(|l| l.len() <= MAX_OPTIONS)
        .ok_or(SpecError::Options)?;
    let mut out = Vec::new();
    for o in list {
        let o = o.as_object().ok_or(SpecError::Options)?;
        let (id, name) = id_name(o, name_ok).ok_or(SpecError::Options)?;
        let color = color_of(o.get("color"), SpecError::Options)?;
        out.push(FieldOption { id, name, color });
    }
    if repeats(out.iter().map(|o| (o.id, o.name.as_str()))) {
        return Err(SpecError::Options);
    }
    Ok(out)
}

fn field_name_ok(name: &str) -> bool {
    name_ok(name)
        && !name.contains(':')
        && !name.starts_with('-')
        && !RESERVED_FIELD_NAMES.contains(&name.to_lowercase().as_str())
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // 1..=90
fn parse_fields(v: Option<&Value>) -> Result<Vec<BoardField>, SpecError> {
    let Some(v) = v else { return Ok(Vec::new()) };
    let list = v
        .as_array()
        .filter(|l| l.len() <= MAX_FIELDS)
        .ok_or(SpecError::Fields)?;
    let mut out = Vec::new();
    for f in list {
        let o = f.as_object().ok_or(SpecError::Field)?;
        let (id, name) = id_name(o, field_name_ok).ok_or(SpecError::Field)?;
        let kind = match o.get("type").and_then(Value::as_str) {
            Some("sel") => FieldType::Sel,
            Some("num") => FieldType::Num,
            Some("date") => FieldType::Date,
            Some("iter") => FieldType::Iter,
            Some("text") => FieldType::Text,
            _ => return Err(SpecError::Field),
        };
        if o.contains_key("options") != (kind == FieldType::Sel) {
            return Err(SpecError::Field);
        }
        if (o.contains_key("start") || o.contains_key("days")) && kind != FieldType::Iter {
            return Err(SpecError::Field);
        }
        let mut field = BoardField {
            id,
            name,
            kind,
            options: None,
            start: None,
            days: None,
        };
        match kind {
            FieldType::Sel => field.options = Some(parse_options(o.get("options"))?),
            FieldType::Iter => {
                let start = o
                    .get("start")
                    .and_then(Value::as_str)
                    .filter(|s| date_days(s).is_some())
                    .ok_or(SpecError::Field)?;
                let days = int_in(o.get("days"), 1, ITER_DAYS_MAX).ok_or(SpecError::Field)?;
                field.start = Some(start.to_string());
                field.days = Some(days as u8);
            }
            _ => {}
        }
        out.push(field);
    }
    if repeats(out.iter().map(|f| (f.id, f.name.as_str()))) {
        return Err(SpecError::Field);
    }
    Ok(out)
}

/// An optional string member: `Ok(None)` absent, `Err` present but not a string.
fn opt_str(o: &Map<String, Value>, key: &str) -> Result<Option<String>, ()> {
    match o.get(key) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(()),
    }
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // 1..=255
fn parse_view(w: &Value, fields: &[BoardField]) -> Option<BoardView> {
    let o = w.as_object()?;
    let (id, name) = id_name(o, name_ok)?;
    let layout = match o.get("layout").and_then(Value::as_str)? {
        "board" => ViewLayout::Board,
        "table" => ViewLayout::Table,
        "roadmap" => ViewLayout::Roadmap,
        _ => return None,
    };
    let q = match o.get("q") {
        None => String::new(),
        Some(q) => text_in(q, QUERY_MAX)?,
    };
    let (group, lane, sort) = (
        opt_str(o, "group").ok()?,
        opt_str(o, "lane").ok()?,
        opt_str(o, "sort").ok()?,
    );
    if group
        .as_deref()
        .is_some_and(|g| !group_key_ok(fields, g, layout == ViewLayout::Board))
    {
        return None;
    }
    if let Some(l) = lane.as_deref() {
        if l == "status"
            || l == group.as_deref().unwrap_or("status")
            || !group_key_ok(fields, l, false)
        {
            return None;
        }
    }
    if sort.as_deref().is_some_and(|s| !sort_key_ok(fields, s)) {
        return None;
    }
    let cols = match o.get("cols") {
        None => None,
        Some(c) => {
            let list = c.as_array().filter(|l| l.len() <= MAX_VIEW_COLS)?;
            let keys: Vec<String> = list
                .iter()
                .map(|k| {
                    k.as_str()
                        .filter(|k| col_key_ok(fields, k))
                        .map(str::to_string)
                })
                .collect::<Option<_>>()?;
            if keys.iter().collect::<HashSet<_>>().len() != keys.len() {
                return None;
            }
            Some(keys)
        }
    };
    let date = match o.get("date") {
        None => None,
        Some(d) => {
            let ids: Vec<u8> = d
                .as_array()?
                .iter()
                .map(|x| int_in(Some(x), 1, 255).map(|x| x as u8))
                .collect::<Option<_>>()?;
            let types: Vec<Option<FieldType>> = ids
                .iter()
                .map(|id| fields.iter().find(|f| f.id == *id).map(|f| f.kind))
                .collect();
            let iter = types == [Some(FieldType::Iter)];
            let range = types == [Some(FieldType::Date), Some(FieldType::Date)] && ids[0] != ids[1];
            if !iter && !range {
                return None;
            }
            Some(ids)
        }
    };
    Some(BoardView {
        id,
        name,
        layout,
        q,
        group,
        lane,
        sort,
        cols,
        date,
    })
}

fn parse_views(v: Option<&Value>, fields: &[BoardField]) -> Result<Vec<BoardView>, SpecError> {
    let Some(v) = v else { return Ok(Vec::new()) };
    let list = v
        .as_array()
        .filter(|l| l.len() <= MAX_VIEWS)
        .ok_or(SpecError::Views)?;
    let out: Vec<BoardView> = list
        .iter()
        .map(|w| parse_view(w, fields).ok_or(SpecError::View))
        .collect::<Result<_, _>>()?;
    if repeats(out.iter().map(|w| (w.id, w.name.as_str()))) {
        return Err(SpecError::View);
    }
    Ok(out)
}

/// Read a board definition (`board.spec`, §2): JSON, `v: 1`, at most 4096 UTF-8 bytes, every
/// limit of §8, ids 1–255 and unique, names unique in any letter case, every reference (`def`,
/// `done`, a view's keys) to something the spec defines. Unknown keys are tolerated and
/// dropped by [`serialize_spec`]; a known key of the wrong type or shape refuses the spec.
/// Checked in the canonical key order, so both clients name the same first problem.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // arch 0..=3650
pub fn parse_spec(json: &str) -> Result<BoardSpec, SpecError> {
    if json.len() > SPEC_MAX_BYTES {
        return Err(SpecError::Size);
    }
    let raw: Value = serde_json::from_str(json).map_err(|_| SpecError::Json)?;
    let Value::Object(raw) = raw else {
        return Err(SpecError::Json);
    };
    if int_in(raw.get("v"), 1, 1).is_none() {
        return Err(SpecError::Version);
    }
    // an empty description is none (written as none)
    let desc = match raw.get("desc") {
        None => None,
        Some(d) => Some(text_in(d, DESC_MAX).ok_or(SpecError::Desc)?).filter(|d| !d.is_empty()),
    };
    let columns = parse_columns(raw.get("columns"))?;
    let def = parse_column_ref(raw.get("def"), &columns, SpecError::Def)?;
    let done = parse_column_ref(raw.get("done"), &columns, SpecError::Done)?;
    let sources = parse_sources(raw.get("sources"))?;
    let fields = parse_fields(raw.get("fields"))?;
    let views = parse_views(raw.get("views"), &fields)?;
    let arch = match raw.get("arch") {
        None => 0,
        Some(a) => int_in(Some(a), 0, ARCH_MAX).ok_or(SpecError::Arch)? as u16,
    };
    Ok(BoardSpec {
        v: 1,
        desc,
        columns,
        def,
        done,
        sources,
        fields,
        views,
        arch,
    })
}

/// Write a definition as canonical compact JSON (the declared key order, defaults omitted),
/// so equal specs are equal bytes in both clients. Refused when it would not read back
/// ([`parse_spec`]'s error) or is over 4096 bytes: what this returns always parses to an
/// equal spec.
pub fn serialize_spec(spec: &BoardSpec) -> Result<String, SpecError> {
    let json = serde_json::to_string(spec).map_err(|_| SpecError::Json)?;
    let back = parse_spec(&json)?;
    serde_json::to_string(&back).map_err(|_| SpecError::Json)
}

/// The Monday (UTC) of the week holding `ms`, as `YYYY-MM-DD`.
#[must_use]
pub fn monday_of(ms: i64) -> String {
    let days = ms.div_euclid(DAY_MS);
    // 1970-01-01 was a Thursday: (days + 3) mod 7 is days since Monday
    civil_from_days(days - (days + 3).rem_euclid(7))
}

/// The new-board template: Todo / In progress / Done (Done the done column, Todo the
/// default), the home repository's issues and pull requests, Priority (P0–P3), Estimate and a
/// two-week Iteration starting the Monday of the week of `now_ms`, a Board, a Table and a
/// Roadmap view, and auto-archive after 14 days.
#[must_use]
pub fn default_spec(home_repo_id: &str, now_ms: i64) -> BoardSpec {
    let column = |id, name: &str| BoardColumn {
        id,
        name: name.into(),
        color: None,
        wip: None,
    };
    let option = |id, name: &str, color: &str| FieldOption {
        id,
        name: name.into(),
        color: Some(color.into()),
    };
    let field = |id, name: &str, kind| BoardField {
        id,
        name: name.into(),
        kind,
        options: None,
        start: None,
        days: None,
    };
    let view = |id, name: &str, layout| BoardView {
        id,
        name: name.into(),
        layout,
        q: String::new(),
        group: None,
        lane: None,
        sort: None,
        cols: None,
        date: None,
    };
    BoardSpec {
        v: 1,
        desc: None,
        columns: vec![
            column(1, "Todo"),
            column(2, "In progress"),
            column(3, "Done"),
        ],
        def: 1,
        done: 3,
        sources: vec![BoardSource {
            r: Some(home_repo_id.to_string()),
            k: SourceKind::All,
            q: String::new(),
        }],
        fields: vec![
            BoardField {
                options: Some(vec![
                    option(1, "P0", "#d1242f"),
                    option(2, "P1", "#fb8f44"),
                    option(3, "P2", "#d4a72c"),
                    option(4, "P3", "#8c959f"),
                ]),
                ..field(1, "Priority", FieldType::Sel)
            },
            field(2, "Estimate", FieldType::Num),
            BoardField {
                start: Some(monday_of(now_ms)),
                days: Some(14),
                ..field(3, "Iteration", FieldType::Iter)
            },
        ],
        views: vec![
            view(1, "Board", ViewLayout::Board),
            BoardView {
                cols: Some(
                    ["title", "status", "assignees", "f1", "f2", "f3"]
                        .map(String::from)
                        .to_vec(),
                ),
                ..view(2, "Table", ViewLayout::Table)
            },
            BoardView {
                date: Some(vec![3]),
                ..view(3, "Roadmap", ViewLayout::Roadmap)
            },
        ],
        arch: 14,
    }
}

// ---------------------------------------------------------------------------------------------
// Card field values (§3.2 `f`)
// ---------------------------------------------------------------------------------------------

/// A card's field values by field id (ascending, as JSON keys).
pub type FieldValues = BTreeMap<u8, Scalar>;

/// `v` as a value of `field`, if it is a valid one (`-0` reads as 0).
#[allow(clippy::float_cmp)] // -0 == 0
fn field_value(field: &BoardField, v: &Value) -> Option<Scalar> {
    match field.kind {
        FieldType::Sel => {
            let id = int_in(Some(v), 1, 255)?;
            field
                .options
                .as_deref()
                .unwrap_or_default()
                .iter()
                .any(|o| i64::from(o.id) == id)
                .then(|| Scalar::from(id))
        }
        FieldType::Num => {
            let x = v.as_f64().filter(|x| x.is_finite())?;
            (x.abs() <= NUM_ABS_MAX && (x == 0.0 || x.abs() >= NUM_ABS_MIN))
                .then_some(Scalar::Num(if x == 0.0 { 0.0 } else { x }))
        }
        FieldType::Date => v
            .as_str()
            .filter(|s| date_days(s).is_some())
            .map(|s| Scalar::Text(s.to_string())),
        FieldType::Iter => int_in(Some(v), 0, ITER_INDEX_MAX).map(Scalar::from),
        FieldType::Text => v
            .as_str()
            .filter(|s| !s.is_empty() && char_len(s) <= TEXT_VALUE_MAX)
            .map(|s| Scalar::Text(s.to_string())),
    }
}

fn valid_values<'a>(
    entries: impl Iterator<Item = (&'a String, &'a Value)>,
    spec: &BoardSpec,
) -> FieldValues {
    let mut out = FieldValues::new();
    for (key, v) in entries {
        let canonical = !key.is_empty()
            && key.len() <= 3
            && !key.starts_with('0')
            && key.bytes().all(|b| b.is_ascii_digit());
        let Some(field) = canonical
            .then(|| key.parse::<u8>().ok())
            .flatten()
            .and_then(|id| spec.field(id))
        else {
            continue;
        };
        if let Some(value) = field_value(field, v) {
            out.insert(field.id, value);
        }
    }
    out
}

/// A card's field values (`card.f`, `{"<fieldId>": value}`), keeping only those `spec`
/// defines with a value of the field's type (a deleted field, a deleted option, a wrong type
/// are dropped). Not JSON or not an object reads as none.
#[must_use]
pub fn parse_field_values(json: Option<&str>, spec: &BoardSpec) -> FieldValues {
    let Some(json) = json.filter(|j| !j.is_empty()) else {
        return FieldValues::new();
    };
    match serde_json::from_str::<Value>(json) {
        Ok(Value::Object(o)) => valid_values(o.iter(), spec),
        _ => FieldValues::new(),
    }
}

/// Field values as canonical JSON (ids ascending, invalid entries dropped as
/// [`parse_field_values`] drops them, numbers as JavaScript writes them); `None` over 2048
/// bytes.
#[must_use]
pub fn serialize_field_values(values: &FieldValues, spec: &BoardSpec) -> Option<String> {
    let mut out = String::from("{");
    for (id, v) in values {
        let Some(field) = spec.field(*id) else {
            continue;
        };
        let raw = match v {
            Scalar::Num(x) => serde_json::Number::from_f64(*x).map(Value::Number),
            Scalar::Text(t) => Some(Value::String(t.clone())),
        };
        if raw.and_then(|r| field_value(field, &r)).is_none() {
            continue;
        }
        if out.len() > 1 {
            out.push(',');
        }
        let _ = write!(out, "\"{id}\":");
        match v {
            Scalar::Num(x) => out.push_str(&js_number(*x)),
            Scalar::Text(t) => out.push_str(&serde_json::to_string(t).unwrap_or_default()),
        }
    }
    out.push('}');
    (out.len() <= FIELD_VALUES_MAX_BYTES).then_some(out)
}

// ---------------------------------------------------------------------------------------------
// Rank (§2.6)
// ---------------------------------------------------------------------------------------------

/// The 62 rank digits, in ASCII (byte) order.
pub const RANK_DIGITS: &[u8; 62] =
    b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/// A rank digit's value 0–61.
fn digit_of(c: u8) -> Option<u32> {
    match c {
        b'0'..=b'9' => Some(u32::from(c - b'0')),
        b'A'..=b'Z' => Some(u32::from(c - b'A') + 10),
        b'a'..=b'z' => Some(u32::from(c - b'a') + 36),
        _ => None,
    }
}

fn digit(x: u32) -> char {
    char::from(RANK_DIGITS[x as usize])
}

/// Whether `r` is a well-formed explicit rank: 1–63 digits, not ending in `0` (the
/// `card.rank` pattern).
#[must_use]
pub fn is_explicit_rank(r: &str) -> bool {
    (1..=RANK_MAX).contains(&r.len())
        && r.bytes().all(|b| digit_of(b).is_some())
        && !r.ends_with('0')
}

/// Why no rank was made (the web's `RankError`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RankError {
    /// A bound is not 0–63 rank digits.
    Invalid,
    /// The lower bound is above the upper.
    Order,
    /// No rank of at most 63 digits fits (the bounds are equal, or `b` is `a` + `0…0`, or the
    /// gap is used up): re-rank the column (§2.6).
    Rerank,
}

impl RankError {
    /// The code both clients name it by.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Invalid => "invalid",
            Self::Order => "order",
            Self::Rerank => "re-rank",
        }
    }
}

impl std::fmt::Display for RankError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Rerank => "Re-rank this column",
            other => other.as_str(),
        })
    }
}

impl std::error::Error for RankError {}

/// A rank strictly between `a` and `b` in byte order (`""` is open: below everything / above
/// everything), ending in a non-zero digit, at most 63 digits: the web's `rankBetween`, whose
/// comment gives the construction and why it is strictly between.
pub fn rank_between(a: &str, b: &str) -> Result<String, RankError> {
    let ok = |r: &str| r.len() <= RANK_MAX && r.bytes().all(|c| digit_of(c).is_some());
    if !ok(a) || !ok(b) {
        return Err(RankError::Invalid);
    }
    if !b.is_empty() && a >= b {
        // two members dropping into one gap at once write one rank: nothing lies between them
        return Err(if a == b {
            RankError::Rerank
        } else {
            RankError::Order
        });
    }
    let (lo, hi) = (a.as_bytes(), b.as_bytes());
    let mut out = String::new();
    let mut lo_tight = true;
    let mut hi_tight = !hi.is_empty();
    for i in 0.. {
        if i >= RANK_MAX || (hi_tight && i >= hi.len()) {
            return Err(RankError::Rerank);
        }
        let in_lo = lo_tight && i < lo.len();
        let floor = if in_lo {
            digit_of(lo[i]).unwrap_or(0)
        } else {
            0
        };
        let hd = if hi_tight {
            digit_of(hi[i]).unwrap_or(0)
        } else {
            62
        };
        let ceil = if hi_tight && i + 1 < hi.len() {
            hd + 1
        } else {
            hd
        };
        if ceil >= floor + 2 {
            out.push(digit(floor.midpoint(ceil)));
            return Ok(out);
        }
        lo_tight = in_lo;
        hi_tight = hi_tight && floor == hd;
        out.push(digit(floor));
    }
    unreachable!("the loop returns by RANK_MAX")
}

/// `n` in `width` base-62 digits (clamped to 0 … 62^width − 1).
fn base62(n: i64, width: u32) -> String {
    let max = 62_i64.pow(width) - 1;
    let mut v = n.clamp(0, max);
    let mut out = vec![b'0'; width as usize];
    for slot in out.iter_mut().rev() {
        *slot = RANK_DIGITS[usize::try_from(v % 62).unwrap_or(0)];
        v /= 62;
    }
    String::from_utf8(out).unwrap_or_default()
}

/// The rank of an item with no card, or whose newest card has no rank: `V`, its
/// `$createdAt` in 8 base-62 digits, the first 3 bytes of its `$id` (big-endian, mod 62⁴) in 4.
#[must_use]
pub fn implicit_rank(created_at_ms: i64, item_id_bytes: &[u8]) -> String {
    let byte = |i: usize| i64::from(item_id_bytes.get(i).copied().unwrap_or(0));
    let head = (byte(0) << 16) | (byte(1) << 8) | byte(2);
    format!(
        "V{}{}",
        base62(created_at_ms, 8),
        base62(head % 62_i64.pow(4), 4)
    )
}

/// The bytes of a base58 id (the web's `base58Decode`); none when it is not base58.
fn base58_bytes(s: &str) -> Vec<u8> {
    const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    // little-endian magnitude
    let mut le: Vec<u8> = Vec::new();
    for c in s.bytes() {
        let Some(d) = ALPHABET.iter().position(|&a| a == c) else {
            return Vec::new();
        };
        let mut carry = u32::try_from(d).unwrap_or(0);
        for b in &mut le {
            carry += u32::from(*b) * 58;
            *b = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            le.push((carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    let zeros = s.bytes().take_while(|&c| c == b'1').count();
    let mut out = vec![0; zeros];
    out.extend(le.iter().rev());
    out
}

/// [`implicit_rank`] of an item by its base58 `$id`.
#[must_use]
pub fn implicit_rank_of(created_at_ms: i64, item_id: &str) -> String {
    implicit_rank(created_at_ms, &base58_bytes(item_id))
}

/// The rank that puts a card at the top of a column whose first rank is `first` (`None`:
/// empty), above the sourced pool.
pub fn top_rank(first: Option<&str>) -> Result<String, RankError> {
    rank_between("", first.filter(|f| *f <= "V").unwrap_or("V"))
}

/// The rank that puts a card at the bottom of a column whose last rank is `last` (`None`:
/// empty), below the sourced pool.
pub fn bottom_rank(last: Option<&str>) -> Result<String, RankError> {
    rank_between(last.filter(|l| *l >= "W").unwrap_or("W"), "")
}

/// `n` evenly spaced explicit ranks, ascending, for re-ranking a column (§2.6): rank k is
/// k/(n+1) of the way from `0` to `V`, in the fewest digits that leave 62 free ranks between
/// neighbours, trailing zeros dropped. `Invalid` past 1 000 000.
pub fn rerank(n: u64) -> Result<Vec<String>, RankError> {
    if n > RERANK_MAX {
        return Err(RankError::Invalid);
    }
    let n = i64::try_from(n).map_err(|_| RankError::Invalid)?;
    let mut width = 1;
    while 31 * 62_i64.pow(width - 1) < 62 * (n + 1) {
        width += 1;
    }
    let space = 31 * 62_i64.pow(width - 1);
    Ok((1..=n)
        .map(|k| {
            base62(k * space / (n + 1), width)
                .trim_end_matches('0')
                .to_string()
        })
        .collect())
}

// ---------------------------------------------------------------------------------------------
// Iterations (§2.2)
// ---------------------------------------------------------------------------------------------

/// One iteration of an `iter` field: index k, named "<field> k+1", `start` … `end` (the last
/// day, inclusive).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IterationRange {
    /// k.
    pub index: i64,
    /// "<field> k+1".
    pub name: String,
    /// The first day.
    pub start: String,
    /// The last day.
    pub end: String,
    /// `start`'s midnight UTC.
    pub start_ms: i64,
    /// The next iteration's (exclusive end).
    pub end_ms: i64,
}

/// An `iter` field's first day number and length.
fn iter_of(field: &BoardField) -> Option<(i64, i64)> {
    if field.kind != FieldType::Iter {
        return None;
    }
    let days = i64::from(field.days.filter(|d| *d > 0)?);
    Some((date_days(field.start.as_deref()?)?, days))
}

/// The index of `field`'s iteration holding `date_ms` (UTC days); `None` before its first or
/// past index 65535, or not an `iter` field.
#[must_use]
pub fn iteration_at(field: &BoardField, date_ms: i64) -> Option<i64> {
    let (start, days) = iter_of(field)?;
    let k = (date_ms.div_euclid(DAY_MS) - start).div_euclid(days);
    (0..=ITER_INDEX_MAX).contains(&k).then_some(k)
}

/// Iteration `k` of `field`; `None` when not an `iter` field or `k` out of range.
#[must_use]
pub fn iteration_range(field: &BoardField, k: i64) -> Option<IterationRange> {
    let (start, days) = iter_of(field)?;
    if !(0..=ITER_INDEX_MAX).contains(&k) {
        return None;
    }
    let first = start + k * days;
    let next = first + days;
    Some(IterationRange {
        index: k,
        name: format!("{} {}", field.name, k + 1),
        start: civil_from_days(first),
        end: civil_from_days(next - 1),
        start_ms: first * DAY_MS,
        end_ms: next * DAY_MS,
    })
}

// ---------------------------------------------------------------------------------------------
// Items, cards and placement (§2.4)
// ---------------------------------------------------------------------------------------------

/// An issue or a pull request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemKind {
    /// An issue.
    Issue,
    /// A pull request.
    Pr,
}

/// An item's state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemState {
    /// Open.
    Open,
    /// Closed (not merged).
    Closed,
    /// Merged.
    Merged,
}

/// What a board reads of an issue or PR (the web's `BoardItem`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardItem {
    /// The item's `$id`.
    pub id: String,
    /// Its number.
    pub number: u64,
    /// Its repository's id.
    pub repo_id: String,
    /// `owner/name`, as shown, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// Issue or PR.
    pub kind: ItemKind,
    /// Open, closed or merged.
    pub state: ItemState,
    /// Its `$createdAt`.
    pub created_at: i64,
    /// The `$createdAt` of its latest transition into closed or merged.
    pub closed_at: Option<i64>,
    /// The title.
    pub title: String,
    /// Label names.
    pub labels: Vec<String>,
    /// Assignee identity ids.
    pub assignees: Vec<String>,
    /// The milestone's title.
    pub milestone: Option<String>,
    /// The author's identity id.
    pub author: String,
}

/// Card `state` (§3.2): active.
pub const CARD_ACTIVE: i64 = 0;
/// Archived.
pub const CARD_ARCHIVED: i64 = 1;
/// Removed.
pub const CARD_REMOVED: i64 = 2;

/// A `card` document as read (a private repo's opened); `col` / `rank` / `f` `None` when
/// absent or unreadable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardDoc {
    /// `$id`.
    pub id: String,
    /// `$ownerId`.
    pub owner_id: String,
    /// `$updatedAt`.
    pub updated_at: i64,
    /// The item's `$id`.
    pub item: String,
    /// The column id.
    pub col: Option<i64>,
    /// The rank.
    pub rank: Option<String>,
    /// The field values' JSON.
    pub f: Option<String>,
    /// 0 active, 1 archived, 2 removed.
    pub state: i64,
}

/// Why an item is archived.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ArchivedBy {
    /// Its newest card says so.
    Card,
    /// Auto-archive (`arch`).
    Auto,
}

/// Where one item shows (§2.4). `col` 0 is "No status".
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Placement {
    /// The item's `$id`.
    pub id: String,
    /// On the board: a source matches it or it has a card, and that card is not removed.
    pub on: bool,
    /// A source matches it.
    pub sourced: bool,
    /// Its newest card removed it.
    pub removed: bool,
    /// The newest card's `$id`.
    pub card: Option<String>,
    /// The column.
    pub col: u8,
    /// The effective rank.
    pub rank: String,
    /// Why it is archived, if it is.
    pub archived: Option<ArchivedBy>,
    /// Its field values.
    pub fields: FieldValues,
}

/// A column's visible items (on the board, not archived), in rank order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ColumnItems {
    /// The column id (0: "No status").
    pub id: u8,
    /// Item ids.
    pub items: Vec<String>,
}

/// A board folded (the web's `BoardFold`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BoardFold {
    /// One per input item, in input order (repeated ids once).
    pub items: Vec<Placement>,
    /// "No status" (0) first while it holds an item, then every column in order.
    pub columns: Vec<ColumnItems>,
}

/// Whether `(a_at, a_id)` is newer than `(b_at, b_id)`.
fn newer(a_at: i64, a_id: &str, b_at: i64, b_id: &str) -> bool {
    (a_at, a_id) > (b_at, b_id)
}

/// Every item's newest card over every member's, by (`$updatedAt`, `$id`) (§2.4).
#[must_use]
pub fn newest_cards(cards: &[CardDoc]) -> HashMap<&str, &CardDoc> {
    let mut out: HashMap<&str, &CardDoc> = HashMap::new();
    for c in cards {
        match out.get(c.item.as_str()) {
            Some(prev) if !newer(c.updated_at, &c.id, prev.updated_at, &prev.id) => {}
            _ => {
                out.insert(&c.item, c);
            }
        }
    }
    out
}

/// A `board` document as read; `spec` `None` when absent or unreadable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardDoc {
    /// `$id`.
    pub id: String,
    /// `$ownerId`.
    pub owner_id: String,
    /// `$updatedAt`.
    pub updated_at: i64,
    /// The board's key.
    pub key: u32,
    /// 0 open, 1 closed, 2 deleted.
    pub state: i64,
    /// The name.
    pub name: Option<String>,
    /// The definition's JSON.
    pub spec: Option<String>,
}

/// Board `state` (§3.1): deleted.
pub const BOARD_DELETED: i64 = 2;

/// A repository's boards: per key the newest revision over every member's by
/// (`$updatedAt`, `$id`), ascending by key, less the deleted ones unless `with_deleted`.
#[must_use]
pub fn newest_boards(docs: &[BoardDoc], with_deleted: bool) -> Vec<&BoardDoc> {
    let mut by_key: BTreeMap<u32, &BoardDoc> = BTreeMap::new();
    for d in docs {
        match by_key.get(&d.key) {
            Some(prev) if !newer(d.updated_at, &d.id, prev.updated_at, &prev.id) => {}
            _ => {
                by_key.insert(d.key, d);
            }
        }
    }
    by_key
        .into_values()
        .filter(|d| with_deleted || d.state != BOARD_DELETED)
        .collect()
}

/// Whether `source` includes `item` (§2.3): its repository (absent: `home`) and kind, and the
/// qualifiers of its query (`query`, [`parse_source_query`] of `source.q`).
#[must_use]
pub fn source_matches(
    source: &BoardSource,
    query: &BoardQuery,
    item: &BoardItem,
    home: &str,
    spec: &BoardSpec,
    now: i64,
) -> bool {
    if source.r.as_deref().unwrap_or(home) != item.repo_id {
        return false;
    }
    match source.k {
        SourceKind::Issues if item.kind != ItemKind::Issue => return false,
        SourceKind::Pulls if item.kind != ItemKind::Pr => return false,
        _ => {}
    }
    query_holds(item, None, spec, query, &QueryContext { me: None, now })
}

/// Where every item shows (§2.4): the web's `foldBoard`, whose comment states the rules.
#[must_use]
pub fn fold_board(
    spec: &BoardSpec,
    home: &str,
    items: &[BoardItem],
    cards: &[CardDoc],
    now: i64,
) -> BoardFold {
    let newest = newest_cards(cards);
    let source_queries: Vec<(&BoardSource, BoardQuery)> = spec
        .sources
        .iter()
        .map(|s| (s, parse_source_query(&s.q, spec)))
        .collect();
    let done_index = (spec.done != 0)
        .then(|| spec.column_index(spec.done))
        .flatten();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in items {
        if !seen.insert(item.id.as_str()) {
            continue;
        }
        let card = newest.get(item.id.as_str()).copied();
        let sourced = source_queries
            .iter()
            .any(|(s, q)| source_matches(s, q, item, home, spec, now));
        let removed = card.is_some_and(|c| c.state == CARD_REMOVED);
        let card_col = card
            .and_then(|c| c.col)
            .and_then(|c| u8::try_from(c).ok())
            .filter(|c| spec.column_index(*c).is_some());
        let finished = item.state != ItemState::Open;
        let keeps = |d: usize| {
            card_col
                .and_then(|c| spec.column_index(c))
                .is_some_and(|i| i >= d)
        };
        let col = match done_index {
            Some(d) if finished && !keeps(d) => spec.done,
            _ => card_col.unwrap_or(spec.def),
        };
        let archived = if card.is_some_and(|c| c.state == CARD_ARCHIVED) {
            Some(ArchivedBy::Card)
        } else {
            match item.closed_at {
                Some(closed)
                    if spec.arch > 0
                        && finished
                        && card.is_none_or(|c| c.updated_at < closed)
                        && now >= closed + i64::from(spec.arch) * DAY_MS =>
                {
                    Some(ArchivedBy::Auto)
                }
                _ => None,
            }
        };
        out.push(Placement {
            id: item.id.clone(),
            on: (sourced || card.is_some()) && !removed,
            sourced,
            removed,
            card: card.map(|c| c.id.clone()),
            col,
            rank: card
                .and_then(|c| c.rank.clone())
                .filter(|r| is_explicit_rank(r))
                .unwrap_or_else(|| implicit_rank_of(item.created_at, &item.id)),
            archived,
            fields: card.map_or_else(FieldValues::new, |c| {
                parse_field_values(c.f.as_deref(), spec)
            }),
        });
    }
    let mut visible: Vec<&Placement> = out
        .iter()
        .filter(|p| p.on && p.archived.is_none())
        .collect();
    visible.sort_by(|a, b| by_rank(&a.rank, &a.id, &b.rank, &b.id));
    let in_col = |id: u8| -> Vec<String> {
        visible
            .iter()
            .filter(|p| p.col == id)
            .map(|p| p.id.clone())
            .collect()
    };
    let none = in_col(0);
    let mut columns = Vec::new();
    if !none.is_empty() {
        columns.push(ColumnItems { id: 0, items: none });
    }
    columns.extend(spec.columns.iter().map(|c| ColumnItems {
        id: c.id,
        items: in_col(c.id),
    }));
    BoardFold {
        items: out,
        columns,
    }
}

/// Order within a column (§2.6): (rank, item `$id`), both by code point.
#[must_use]
pub fn by_rank(a_rank: &str, a_id: &str, b_rank: &str, b_id: &str) -> Ordering {
    (a_rank, a_id).cmp(&(b_rank, b_id))
}

// ---------------------------------------------------------------------------------------------
// Query (§4.4)
// ---------------------------------------------------------------------------------------------

/// One qualifier (the web's `QueryPred`): every one ANDed, `not` for a leading `-`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QueryPred {
    /// `is`, `label`, `milestone`, `assignee`, `author`, `repo`, `status`, `no` or `field`.
    pub k: &'static str,
    /// A leading `-`.
    pub not: bool,
    /// The value.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub v: Option<Scalar>,
    /// A `field` predicate's field id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub f: Option<u8>,
    /// `eq`, `gt`, `ge`, `lt`, `le`, `range` or `has`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub op: Option<&'static str>,
    /// A range's upper end.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub v2: Option<Scalar>,
}

impl QueryPred {
    fn of(k: &'static str, not: bool, v: Scalar) -> Self {
        Self {
            k,
            not,
            v: Some(v),
            f: None,
            op: None,
            v2: None,
        }
    }

    fn v_text(&self) -> &str {
        self.v.as_ref().and_then(Scalar::text).unwrap_or("")
    }
}

/// A parsed board query.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BoardQuery {
    /// The qualifiers.
    pub preds: Vec<QueryPred>,
    /// The free text: matched against titles, `#12` / `12` against numbers.
    pub text: String,
    /// The qualifier tokens not applied, as typed.
    pub unresolved: Vec<String>,
}

const IS_VALUES: &[&str] = &[
    "open", "closed", "merged", "unmerged", "issue", "pr", "archived",
];
const STATE_VALUES: &[&str] = &["open", "closed", "merged", "unmerged"];
const QUERY_KEYS: &[&str] = &[
    "is",
    "state",
    "label",
    "milestone",
    "assignee",
    "author",
    "repo",
    "status",
    "no",
];
const LABEL_MAX: usize = 30;
const MILESTONE_MAX: usize = 63;
const ITER_RELATIVE: &[&str] = &["@current", "@next", "@previous"];

fn unquote(s: &str) -> String {
    s.replace('"', "")
}

/// A person value: an identity id, or `me` (`@me`, any case).
fn person_of(v: &str) -> Option<String> {
    let t = v.strip_prefix('@').unwrap_or(v);
    if t.to_lowercase() == "me" {
        return Some("me".into());
    }
    is_identifier(t).then(|| t.to_string())
}

/// A comparison value's op and operand(s), still text.
fn comparison(v: &str) -> (&'static str, &str, Option<&str>) {
    if let Some(at) = v.find("..") {
        return ("range", &v[..at], Some(&v[at + 2..]));
    }
    for (prefix, op) in [(">=", "ge"), ("<=", "le"), (">", "gt"), ("<", "lt")] {
        if let Some(rest) = v.strip_prefix(prefix) {
            return (op, rest, None);
        }
    }
    ("eq", v, None)
}

/// `-?\d{1,15}(\.\d{1,15})?`.
fn is_query_number(s: &str) -> bool {
    let body = s.strip_prefix('-').unwrap_or(s);
    let (int, frac) = match body.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (body, None),
    };
    let digits = |d: &str| (1..=15).contains(&d.len()) && d.bytes().all(|b| b.is_ascii_digit());
    digits(int) && frac.is_none_or(digits)
}

/// A typed comparison operand.
fn operand(field: &BoardField, s: &str) -> Option<Scalar> {
    match field.kind {
        FieldType::Num => is_query_number(s)
            .then(|| s.parse::<f64>().ok())
            .flatten()
            .map(Scalar::Num),
        FieldType::Date => {
            if s.to_lowercase() == "@today" {
                Some(Scalar::Text("@today".into()))
            } else {
                date_days(s).map(|_| Scalar::Text(s.to_string()))
            }
        }
        FieldType::Iter => {
            let low = s.to_lowercase();
            if ITER_RELATIVE.contains(&low.as_str()) {
                return Some(Scalar::Text(low));
            }
            // `3` or `"Iteration 3"`: iteration 3, index 2
            let prefix = format!("{} ", field.name.to_lowercase());
            let n = low.strip_prefix(&prefix).unwrap_or(&low);
            let ok = (1..=5).contains(&n.len())
                && !n.starts_with('0')
                && n.bytes().all(|b| b.is_ascii_digit());
            ok.then(|| n.parse::<i64>().ok())
                .flatten()
                .filter(|n| n - 1 <= ITER_INDEX_MAX)
                .map(|n| Scalar::from(n - 1))
        }
        _ => None,
    }
}

/// A custom-field qualifier's predicate.
fn field_pred(field: &BoardField, value: &str, not: bool) -> Option<QueryPred> {
    if value.is_empty() {
        return None;
    }
    let pred = |op: &'static str, v: Scalar, v2: Option<Scalar>| QueryPred {
        k: "field",
        not,
        v: Some(v),
        f: Some(field.id),
        op: Some(op),
        v2,
    };
    match field.kind {
        FieldType::Sel => {
            let low = value.to_lowercase();
            let opt = field
                .options
                .as_deref()
                .unwrap_or_default()
                .iter()
                .find(|o| o.name.to_lowercase() == low)?;
            Some(pred("eq", Scalar::from(i64::from(opt.id)), None))
        }
        FieldType::Text => (char_len(value) <= TEXT_VALUE_MAX)
            .then(|| pred("has", Scalar::Text(value.to_lowercase()), None)),
        _ => match comparison(value) {
            ("range", a, Some(b)) => {
                if a == "*" && b == "*" {
                    return None;
                }
                let lo = if a == "*" {
                    None
                } else {
                    Some(operand(field, a)?)
                };
                let hi = if b == "*" {
                    None
                } else {
                    Some(operand(field, b)?)
                };
                match (lo, hi) {
                    (None, Some(hi)) => Some(pred("le", hi, None)),
                    (Some(lo), None) => Some(pred("ge", lo, None)),
                    (Some(lo), Some(hi)) => Some(pred("range", lo, Some(hi))),
                    (None, None) => None,
                }
            }
            (op, a, _) => operand(field, a).map(|v| pred(op, v, None)),
        },
    }
}

/// Read a board query (§4.4): the web's `parseBoardQuery`, whose comment lists the grammar.
#[must_use]
pub fn parse_board_query(text: &str, spec: &BoardSpec) -> BoardQuery {
    parse_query(text, spec, false)
}

/// A source's query (§2.3): [`parse_board_query`] less what depends on the board or the
/// reader rather than the item (`status:`, `no:status`, custom fields, `is:archived`, `@me`),
/// which goes to `unresolved`.
#[must_use]
pub fn parse_source_query(text: &str, spec: &BoardSpec) -> BoardQuery {
    parse_query(text, spec, true)
}

/// Whether a predicate reads the board or the reader, not only the item.
fn board_only(p: &QueryPred) -> bool {
    match p.k {
        "status" | "field" => true,
        "no" => p.v_text() == "status" || field_key_id(p.v_text()).is_some(),
        "is" => p.v_text() == "archived",
        "assignee" | "author" => p.v_text() == "me",
        _ => false,
    }
}

fn parse_query(text: &str, spec: &BoardSpec, for_source: bool) -> BoardQuery {
    let mut preds = Vec::new();
    let mut free: Vec<String> = Vec::new();
    let mut unresolved = Vec::new();
    let field_by_name: HashMap<String, &BoardField> = spec
        .fields
        .iter()
        .map(|f| (f.name.to_lowercase(), f))
        .collect();
    for tok in tokens(text) {
        let at = tok.find(':').filter(|&at| at > 0);
        let raw_key = at.map_or("", |at| &tok[..at]);
        let not = raw_key.len() > 1 && raw_key.starts_with('-');
        let key = unquote(if not { &raw_key[1..] } else { raw_key }).to_lowercase();
        let raw_value = at.map_or("", |at| &tok[at + 1..]);
        let value = unquote(raw_value);
        if key.is_empty()
            || (value.is_empty()
                && !QUERY_KEYS.contains(&key.as_str())
                && !field_by_name.contains_key(&key))
            || raw_value.starts_with("//")
        {
            free.push(tok);
            continue;
        }
        match qualifier(&key, &value, not, spec, &field_by_name) {
            Some(pred) if !(for_source && board_only(&pred)) => preds.push(pred),
            _ => unresolved.push(tok),
        }
    }
    BoardQuery {
        preds,
        text: free.join(" "),
        unresolved,
    }
}

fn qualifier(
    key: &str,
    value: &str,
    not: bool,
    spec: &BoardSpec,
    field_by_name: &HashMap<String, &BoardField>,
) -> Option<QueryPred> {
    let low = value.to_lowercase();
    match key {
        "is" | "state" => {
            let ok = if key == "is" { IS_VALUES } else { STATE_VALUES };
            ok.contains(&low.as_str())
                .then(|| QueryPred::of("is", not, Scalar::Text(low)))
        }
        "label" => (!value.is_empty() && char_len(value) <= LABEL_MAX)
            .then(|| QueryPred::of("label", not, Scalar::Text(value.into()))),
        "milestone" => (!value.is_empty() && char_len(value) <= MILESTONE_MAX)
            .then(|| QueryPred::of("milestone", not, Scalar::Text(value.into()))),
        "assignee" | "author" => {
            let k = if key == "author" {
                "author"
            } else {
                "assignee"
            };
            person_of(value).map(|who| QueryPred::of(k, not, Scalar::Text(who)))
        }
        "repo" => {
            (!value.is_empty()).then(|| QueryPred::of("repo", not, Scalar::Text(value.into())))
        }
        "status" => spec
            .columns
            .iter()
            .find(|c| c.name.to_lowercase() == low)
            .map(|c| QueryPred::of("status", not, Scalar::from(i64::from(c.id)))),
        "no" => {
            if ["label", "assignee", "milestone", "status"].contains(&low.as_str()) {
                return Some(QueryPred::of("no", not, Scalar::Text(low)));
            }
            field_by_name
                .get(&low)
                .map(|f| QueryPred::of("no", not, Scalar::Text(format!("f{}", f.id))))
        }
        _ => field_pred(field_by_name.get(key)?, value, not),
    }
}

/// What a query reads besides the item: the viewer (`@me`) and the time (`@today`,
/// `@current`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryContext {
    /// The viewer's identity id.
    pub me: Option<String>,
    /// Now, in ms.
    pub now: i64,
}

/// An operand resolved: `@today` to today's date, the relative iterations to indices.
fn resolve_operand(field: &BoardField, v: &Scalar, ctx: &QueryContext) -> Option<Scalar> {
    match v.text() {
        Some("@today") => Some(Scalar::Text(date_of(ctx.now))),
        Some(rel) if ITER_RELATIVE.contains(&rel) => {
            // before the first iteration there is no current one, and the next is the first
            let cur = iteration_at(field, ctx.now);
            let start = field.start.as_deref().and_then(date_days).unwrap_or(0);
            let before = ctx.now < start * DAY_MS;
            let k = match rel {
                "@current" => cur,
                "@next" => cur.map(|c| c + 1).or(before.then_some(0)),
                _ => cur.filter(|c| *c > 0).map(|c| c - 1),
            };
            k.map(Scalar::from)
        }
        _ => Some(v.clone()),
    }
}

fn compare(x: &Scalar, y: &Scalar) -> Ordering {
    match (x, y) {
        (Scalar::Num(a), Scalar::Num(b)) => a.partial_cmp(b).unwrap_or(Ordering::Equal),
        _ => x.display().cmp(&y.display()),
    }
}

fn field_holds(
    p: &QueryPred,
    field: &BoardField,
    value: Option<&Scalar>,
    ctx: &QueryContext,
) -> bool {
    let Some(value) = value else { return false };
    let Some(pv) = p.v.as_ref() else { return false };
    if p.op == Some("has") {
        return value.display().to_lowercase().contains(&pv.display());
    }
    let Some(a) = resolve_operand(field, pv, ctx) else {
        return false;
    };
    let c = compare(value, &a);
    match p.op {
        Some("eq") => c == Ordering::Equal,
        Some("gt") => c == Ordering::Greater,
        Some("ge") => c != Ordering::Less,
        Some("lt") => c == Ordering::Less,
        Some("le") => c != Ordering::Greater,
        Some("range") => {
            p.v2.as_ref()
                .and_then(|b| resolve_operand(field, b, ctx))
                .is_some_and(|b| c != Ordering::Less && compare(value, &b) != Ordering::Greater)
        }
        _ => false,
    }
}

/// Whether the item's title and number hold every free-text term (the Issues tab's
/// `matches_text`, without a body).
fn text_matches(text: &str, item: &BoardItem) -> bool {
    let title = item.title.to_lowercase();
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    search_terms(text).iter().all(|t| {
        let holds = if let Some(n) = t.text.strip_prefix('#').filter(|n| digits(n)) {
            n.parse::<u64>().ok() == Some(item.number)
        } else {
            (digits(&t.text) && t.text.parse::<u64>().ok() == Some(item.number))
                || title.contains(&t.text)
        };
        holds != t.not
    })
}

fn pred_holds(
    p: &QueryPred,
    item: &BoardItem,
    placement: Option<&Placement>,
    spec: &BoardSpec,
    ctx: &QueryContext,
) -> bool {
    let eqi = |a: &str, b: &str| a.to_lowercase() == b.to_lowercase();
    let v = p.v_text();
    match p.k {
        "is" => match v {
            "open" => item.state == ItemState::Open,
            "closed" => item.state != ItemState::Open,
            "merged" => item.state == ItemState::Merged,
            "unmerged" => item.state != ItemState::Merged,
            "issue" => item.kind == ItemKind::Issue,
            "pr" => item.kind == ItemKind::Pr,
            _ => placement.is_some_and(|pl| pl.archived.is_some()),
        },
        "label" => item.labels.iter().any(|l| eqi(l, v)),
        "milestone" => item.milestone.as_deref().is_some_and(|m| eqi(m, v)),
        "assignee" | "author" => {
            let who = if v == "me" {
                ctx.me.as_deref()
            } else {
                Some(v)
            };
            who.is_some_and(|who| {
                if p.k == "author" {
                    item.author == who
                } else {
                    item.assignees.iter().any(|a| a == who)
                }
            })
        }
        "repo" => item.repo_id == v || item.repo.as_deref().is_some_and(|r| eqi(r, v)),
        "status" => placement.is_some_and(|pl| Some(Scalar::from(i64::from(pl.col))) == p.v),
        "no" => match v {
            "label" => item.labels.is_empty(),
            "assignee" => item.assignees.is_empty(),
            "milestone" => item.milestone.is_none(),
            "status" => placement.is_some_and(|pl| pl.col == 0),
            key => placement
                .is_some_and(|pl| field_key_id(key).is_none_or(|id| !pl.fields.contains_key(&id))),
        },
        "field" => {
            let field = p.f.and_then(|id| spec.field(id));
            match (field, placement) {
                (Some(field), Some(pl)) => field_holds(p, field, pl.fields.get(&field.id), ctx),
                _ => false,
            }
        }
        _ => false,
    }
}

/// Whether an item (with its placement; none for a source) holds every predicate, each
/// negated by `-`, and the free text.
fn query_holds(
    item: &BoardItem,
    placement: Option<&Placement>,
    spec: &BoardSpec,
    query: &BoardQuery,
    ctx: &QueryContext,
) -> bool {
    query
        .preds
        .iter()
        .all(|p| pred_holds(p, item, placement, spec, ctx) != p.not)
        && text_matches(&query.text, item)
}

/// Whether an item on the board passes `query` (§4.4): on the board, archived exactly when
/// the query has `is:archived`, holding every predicate and the free text. A value the item
/// lacks never matches its qualifier (so `-priority:P0` matches an item with no priority).
#[must_use]
pub fn matches_board_query(
    item: &BoardItem,
    placement: &Placement,
    spec: &BoardSpec,
    query: &BoardQuery,
    ctx: &QueryContext,
) -> bool {
    if !placement.on {
        return false;
    }
    let wants_archived = query
        .preds
        .iter()
        .any(|p| p.k == "is" && p.v_text() == "archived");
    if !wants_archived && placement.archived.is_some() {
        return false;
    }
    query_holds(item, Some(placement), spec, query, ctx)
}

// ---------------------------------------------------------------------------------------------
// Views: grouping, sorting, totals, progress (§4.1–§4.5)
// ---------------------------------------------------------------------------------------------

/// An item with its placement, as views take them.
#[derive(Debug, Clone, Copy)]
pub struct BoardRow<'a> {
    /// The item.
    pub item: &'a BoardItem,
    /// Where it shows.
    pub placement: &'a Placement,
}

/// A group: its key (a column id for `status`, 0 for "No status"; an option id; an iteration
/// index; an identity id; a label or milestone name; a repo id; `None` for "No <key>") and
/// its items.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RowGroup {
    /// The key.
    pub key: Option<Scalar>,
    /// Item ids.
    pub items: Vec<String>,
}

/// A map key for a [`Scalar`].
fn scalar_key(s: &Scalar) -> String {
    match s {
        Scalar::Num(x) => format!("n{}", js_number(*x)),
        Scalar::Text(t) => format!("s{t}"),
    }
}

/// `rows` grouped by `by` (a view's `group` or `lane` key): the web's `groupRows`, whose
/// comment gives the order.
#[must_use]
pub fn group_rows(rows: &[BoardRow<'_>], by: &str, spec: &BoardSpec, now: i64) -> Vec<RowGroup> {
    let field = field_of_key(&spec.fields, by);
    let keys_of = |r: &BoardRow<'_>| -> Vec<Option<Scalar>> {
        let dedup = |v: &[String]| -> Vec<Option<Scalar>> {
            let mut seen = HashSet::new();
            v.iter()
                .filter(|x| seen.insert(x.as_str()))
                .map(|x| Some(Scalar::Text(x.clone())))
                .collect()
        };
        match by {
            "status" => {
                vec![(r.placement.col != 0).then(|| Scalar::from(i64::from(r.placement.col)))]
            }
            "assignee" if !r.item.assignees.is_empty() => dedup(&r.item.assignees),
            "label" if !r.item.labels.is_empty() => dedup(&r.item.labels),
            "assignee" | "label" => vec![None],
            "milestone" => vec![r.item.milestone.clone().map(Scalar::Text)],
            "repo" => vec![Some(Scalar::Text(r.item.repo_id.clone()))],
            _ => vec![field.and_then(|f| r.placement.fields.get(&f.id).cloned())],
        }
    };
    let order: Vec<Scalar> = if by == "status" {
        spec.columns
            .iter()
            .map(|c| Scalar::from(i64::from(c.id)))
            .collect()
    } else if field.is_some_and(|f| f.kind == FieldType::Sel) {
        field
            .and_then(|f| f.options.as_deref())
            .unwrap_or_default()
            .iter()
            .map(|o| Scalar::from(i64::from(o.id)))
            .collect()
    } else if field.is_some_and(|f| f.kind == FieldType::Iter)
        || ["assignee", "label", "milestone", "repo"].contains(&by)
    {
        let mut present: Vec<Scalar> = Vec::new();
        let mut seen = HashSet::new();
        let mut add = |k: Scalar| {
            if seen.insert(scalar_key(&k)) {
                present.push(k);
            }
        };
        for r in rows {
            for k in keys_of(r).into_iter().flatten() {
                add(k);
            }
        }
        if let Some(f) = field {
            if let Some(cur) = iteration_at(f, now) {
                add(Scalar::from(cur));
            }
        }
        present.sort_by(compare);
        present
    } else {
        return vec![RowGroup {
            key: None,
            items: rows.iter().map(|r| r.item.id.clone()).collect(),
        }];
    };
    let index: HashMap<String, usize> = order
        .iter()
        .enumerate()
        .map(|(i, k)| (scalar_key(k), i))
        .collect();
    let mut empty = Vec::new();
    let mut groups: Vec<Vec<String>> = vec![Vec::new(); order.len()];
    for r in rows {
        for k in keys_of(r) {
            match k {
                None => empty.push(r.item.id.clone()),
                Some(k) => {
                    if let Some(&i) = index.get(&scalar_key(&k)) {
                        groups[i].push(r.item.id.clone());
                    }
                }
            }
        }
    }
    let mut out = Vec::new();
    if !empty.is_empty() {
        out.push(RowGroup {
            key: (by == "status").then(|| Scalar::from(0)),
            items: empty,
        });
    }
    out.extend(order.into_iter().zip(groups).map(|(k, items)| RowGroup {
        key: Some(k),
        items,
    }));
    out
}

/// A row's sort value under `key` (no `-`); `None` when it has none (sorted last).
fn sort_value(r: &BoardRow<'_>, key: &str, spec: &BoardSpec) -> Option<Scalar> {
    let index = |i: usize| Scalar::from(i64::try_from(i).unwrap_or(i64::MAX));
    match key {
        "title" => Some(Scalar::Text(r.item.title.to_lowercase())),
        #[allow(clippy::cast_precision_loss)] // issue numbers: far below 2^53
        "number" => Some(Scalar::Num(r.item.number as f64)),
        "created" => Some(Scalar::from(r.item.created_at)),
        "status" => spec.column_index(r.placement.col).map(index),
        "repo" => Some(Scalar::Text(
            r.item
                .repo
                .as_deref()
                .unwrap_or(&r.item.repo_id)
                .to_lowercase(),
        )),
        "author" => Some(Scalar::Text(r.item.author.clone())),
        "milestone" => r
            .item
            .milestone
            .as_ref()
            .map(|m| Scalar::Text(m.to_lowercase())),
        _ => {
            let field = field_of_key(&spec.fields, key)?;
            let v = r.placement.fields.get(&field.id)?;
            Some(match field.kind {
                FieldType::Sel => field
                    .options
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .position(|o| *v == Scalar::from(i64::from(o.id)))
                    .map_or(Scalar::from(-1), index),
                FieldType::Text => Scalar::Text(v.display().to_lowercase()),
                _ => v.clone(),
            })
        }
    }
}

/// `rows` in a view's `sort` (`None` or `rank`: the column order, §2.6): by the key, `-` for
/// descending; rows without a value last in both directions; ties by (rank, item id).
#[must_use]
pub fn sort_rows<'a>(
    rows: &[BoardRow<'a>],
    sort: Option<&str>,
    spec: &BoardSpec,
) -> Vec<BoardRow<'a>> {
    let desc = sort.is_some_and(|s| s.starts_with('-'));
    let key = sort.map_or("rank", |s| s.strip_prefix('-').unwrap_or(s));
    let tie = |a: &BoardRow<'_>, b: &BoardRow<'_>| {
        by_rank(
            &a.placement.rank,
            &a.placement.id,
            &b.placement.rank,
            &b.placement.id,
        )
    };
    let mut out = rows.to_vec();
    if key == "rank" {
        out.sort_by(|a, b| if desc { tie(b, a) } else { tie(a, b) });
        return out;
    }
    out.sort_by(
        |a, b| match (sort_value(a, key, spec), sort_value(b, key, spec)) {
            (None, None) => tie(a, b),
            (None, Some(_)) => Ordering::Greater,
            (Some(_), None) => Ordering::Less,
            (Some(x), Some(y)) => {
                let c = compare(&x, &y);
                let c = if desc { c.reverse() } else { c };
                c.then_with(|| tie(a, b))
            }
        },
    );
    out
}

/// The number field a view sums (§4.5): the first `num` field of its `cols`, or with no
/// `cols` the spec's first.
#[must_use]
pub fn sum_field_of(spec: &BoardSpec, view: Option<&BoardView>) -> Option<u8> {
    let keys: Vec<String> = view
        .and_then(|v| v.cols.clone())
        .unwrap_or_else(|| spec.fields.iter().map(|f| format!("f{}", f.id)).collect());
    keys.iter()
        .filter_map(|k| field_of_key(&spec.fields, k))
        .find(|f| f.kind == FieldType::Num)
        .map(|f| f.id)
}

/// A group's totals: its item count and the sum of a number field (`None` with none).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Totals {
    /// Items.
    pub count: usize,
    /// The sum.
    pub sum: Option<Scalar>,
}

/// `rows`' count and the sum of number field `sum_field`'s values (in `rows`' order).
#[must_use]
pub fn totals(rows: &[BoardRow<'_>], sum_field: Option<u8>) -> Totals {
    let sum = sum_field.map(|id| {
        let mut sum = 0.0;
        for r in rows {
            if let Some(Scalar::Num(x)) = r.placement.fields.get(&id) {
                sum += x;
            }
        }
        Scalar::Num(sum)
    });
    Totals {
        count: rows.len(),
        sum,
    }
}

/// A status column's totals (§4.5) and its WIP limit; `over` when the count passes it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ColumnTotals {
    /// The column id (0: "No status").
    pub id: u8,
    /// Items.
    pub count: usize,
    /// The sum.
    pub sum: Option<Scalar>,
    /// The WIP limit.
    pub wip: Option<u16>,
    /// Over the WIP limit.
    pub over: bool,
}

/// Every status column's totals for `rows` (as [`group_rows`] by `status` groups them).
#[must_use]
pub fn column_totals(
    rows: &[BoardRow<'_>],
    spec: &BoardSpec,
    sum_field: Option<u8>,
) -> Vec<ColumnTotals> {
    let by_id: HashMap<&str, &BoardRow<'_>> =
        rows.iter().map(|r| (r.item.id.as_str(), r)).collect();
    group_rows(rows, "status", spec, 0)
        .into_iter()
        .map(|g| {
            let in_group: Vec<BoardRow<'_>> = g
                .items
                .iter()
                .filter_map(|id| by_id.get(id.as_str()).map(|r| **r))
                .collect();
            let t = totals(&in_group, sum_field);
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // column ids
            let id = g.key.as_ref().and_then(Scalar::num).unwrap_or(0.0) as u8;
            let wip = spec.columns.iter().find(|c| c.id == id).and_then(|c| c.wip);
            ColumnTotals {
                id,
                count: t.count,
                sum: t.sum,
                wip,
                over: wip.is_some_and(|w| t.count > usize::from(w)),
            }
        })
        .collect()
}

/// An iteration's progress (§4.5): items and points, all and done.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IterationProgress {
    /// Items in the iteration.
    pub total: usize,
    /// Of them done.
    pub done: usize,
    /// Their points (`None` without a points field).
    pub points: Option<Scalar>,
    /// The done ones' points.
    pub done_points: Option<Scalar>,
}

/// Progress of iteration `k` of field `field_id` over `rows`: the rows whose value is `k`;
/// done is in the Done column, or closed or merged.
#[must_use]
pub fn iteration_progress(
    rows: &[BoardRow<'_>],
    spec: &BoardSpec,
    field_id: u8,
    k: i64,
    points_field: Option<u8>,
) -> IterationProgress {
    let want = Scalar::from(k);
    let in_iter: Vec<BoardRow<'_>> = rows
        .iter()
        .filter(|r| r.placement.fields.get(&field_id) == Some(&want))
        .copied()
        .collect();
    let done: Vec<BoardRow<'_>> = in_iter
        .iter()
        .filter(|r| {
            (spec.done != 0 && r.placement.col == spec.done) || r.item.state != ItemState::Open
        })
        .copied()
        .collect();
    let all = totals(&in_iter, points_field);
    let fin = totals(&done, points_field);
    IterationProgress {
        total: all.count,
        done: fin.count,
        points: all.sum,
        done_points: fin.sum,
    }
}

#[cfg(test)]
mod tests;
