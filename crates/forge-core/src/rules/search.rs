//! The issue and PR search grammar: GitHub's qualifiers (`is:closed label:bug -label:wontfix
//! author:@me no:assignee milestone:"v1.0" in:title comments:>2 sort:created-asc`, and for pull
//! requests `is:merged draft:true review-requested:@me`) lifted out of search text into a
//! structured query, and the text and mention matchers the lists filter rows with.
//!
//! A port of forge-web's `lib/view/issue-query.ts` (`parseSearchText`, `unresolvedQualifiers`,
//! `searchTerms`), `lib/view/pull-query.ts` (`parsePullSearch`, `unresolvedPullQualifiers`) and
//! `lib/repo/issue-index.ts` (`matchesText`, `mentions`), so `dg search` reads a query exactly
//! as the web's search box does. The `search_*` conformance vectors in `forge-contracts/vectors/`
//! pin the two ports together.
//!
//! A qualifier whose value cannot be used (or a GitHub qualifier the lists do not apply) is
//! reported in `unresolved`, never searched for as text (QW-020); an unknown key stays text.

use serde::{Deserialize, Serialize};

/// A label is 1-30 characters (the `label.name` schema).
const LABEL_MAX: usize = 30;
/// A milestone title is 1-63 characters (the `milestone.title` schema).
const MILESTONE_MAX: usize = 63;

/// The qualifiers the issue grammar applies.
const APPLIED_KEYS: &[&str] = &[
    "is",
    "state",
    "label",
    "-label",
    "author",
    "assignee",
    "no",
    "mentions",
    "sort",
    "milestone",
    "in",
    "comments",
    "reason",
];

/// GitHub's issue and PR qualifiers the lists do not apply: reported, never kept as text.
const OTHER_GITHUB_KEYS: &[&str] = &[
    "archived",
    "base",
    "closed",
    "commenter",
    "created",
    "draft",
    "head",
    "interactions",
    "involves",
    "language",
    "linked",
    "merged",
    "org",
    "project",
    "reactions",
    "repo",
    "review",
    "review-requested",
    "reviewed-by",
    "status",
    "team",
    "team-review-requested",
    "type",
    "updated",
    "user",
    "user-review-requested",
];

/// An issue search, as the web's `IssueListQuery` (its JSON shape). `author` and `assignee`
/// hold an identity id or `me` (`assignee` also `none`); `state` is `open`, `closed` or `all`;
/// `sort` `newest`, `oldest` or `comments`; `scope` `any`, `title` or `body`; `reason`
/// `completed`, `not_planned` or `duplicate`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueQuery {
    /// The state filter.
    pub state: String,
    /// Labels every row must carry.
    pub labels: Vec<String>,
    /// The author: an identity id or `me`.
    pub author: Option<String>,
    /// The assignee: an identity id, `me` or `none`.
    pub assignee: Option<String>,
    /// `mentions:@me`.
    pub mentions: bool,
    /// The sort.
    pub sort: String,
    /// The free text left after the qualifiers.
    pub q: String,
    /// The page (always 1 from a search).
    pub page: u32,
    /// `-label:x`.
    pub not_labels: Vec<String>,
    /// `no:label`.
    pub no_label: bool,
    /// `milestone:x`.
    pub milestone: Option<String>,
    /// `no:milestone`.
    pub no_milestone: bool,
    /// `author:login` for a name that is no identity: a mirrored item's source login.
    pub author_login: Option<String>,
    /// `in:title` / `in:body`.
    pub scope: String,
    /// `comments:>2`, as typed.
    pub comments: Option<String>,
    /// `reason:…`.
    pub reason: Option<String>,
}

impl Default for IssueQuery {
    fn default() -> Self {
        Self {
            state: "open".into(),
            labels: Vec::new(),
            author: None,
            assignee: None,
            mentions: false,
            sort: "newest".into(),
            q: String::new(),
            page: 1,
            not_labels: Vec::new(),
            no_label: false,
            milestone: None,
            no_milestone: false,
            author_login: None,
            scope: "any".into(),
            comments: None,
            reason: None,
        }
    }
}

/// A pull request search, as the web's `PullListQuery`: the issue query without `mentions`,
/// `state` one of `open`, `merged`, `closed` (without merging), `unmerged` or `all`, plus
/// `draft` and `reviewRequested`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullQuery {
    /// The state filter.
    pub state: String,
    /// Labels every row must carry.
    pub labels: Vec<String>,
    /// The author: an identity id or `me`.
    pub author: Option<String>,
    /// The assignee: an identity id, `me` or `none`.
    pub assignee: Option<String>,
    /// The sort.
    pub sort: String,
    /// The free text left after the qualifiers.
    pub q: String,
    /// The page (always 1 from a search).
    pub page: u32,
    /// `-label:x`.
    pub not_labels: Vec<String>,
    /// `no:label`.
    pub no_label: bool,
    /// `milestone:x`.
    pub milestone: Option<String>,
    /// `no:milestone`.
    pub no_milestone: bool,
    /// `author:login`.
    pub author_login: Option<String>,
    /// `in:title` / `in:body`.
    pub scope: String,
    /// `comments:>2`, as typed.
    pub comments: Option<String>,
    /// `reason:…` (an issue filter: never set from a PR search).
    pub reason: Option<String>,
    /// `draft:true` / `is:draft` (only drafts), `draft:false` (none).
    pub draft: Option<bool>,
    /// `review-requested:`: an identity id or `me`.
    pub review_requested: Option<String>,
}

/// A parsed search and the qualifiers it could not apply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Parsed<Q> {
    /// The query.
    pub query: Q,
    /// The qualifier tokens not applied, as typed.
    pub unresolved: Vec<String>,
}

/// Split `text` into tokens, keeping `"quoted phrases"` (and `label:"two words"`) whole: the
/// web's `/(\S*?"[^"]*"\S*|\S+)/g`.
#[must_use]
pub fn tokens(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_whitespace() {
            i += 1;
            continue;
        }
        let run_end = (i..chars.len())
            .find(|&j| chars[j].is_whitespace())
            .unwrap_or(chars.len());
        let quoted = (i..run_end).find(|&j| chars[j] == '"').and_then(|open| {
            (open + 1..chars.len())
                .find(|&k| chars[k] == '"')
                .map(|close| {
                    (close + 1..chars.len())
                        .find(|&j| chars[j].is_whitespace())
                        .unwrap_or(chars.len())
                })
        });
        let end = quoted.unwrap_or(run_end);
        out.push(chars[i..end].iter().collect());
        i = end;
    }
    out
}

fn unquote(s: &str) -> String {
    s.replace('"', "")
}

/// A token's qualifier key, lowercased with a leading `-` kept (`""` for a token that is none).
fn key_of(tok: &str) -> String {
    match tok.find(':') {
        Some(at) if at > 0 => tok[..at].to_lowercase(),
        _ => String::new(),
    }
}

/// A token's value after its first `:` (`""` for a token that is no qualifier).
fn raw_value(tok: &str) -> &str {
    match tok.find(':') {
        Some(at) if at > 0 => &tok[at + 1..],
        _ => "",
    }
}

/// The web's `isIdentityId`: 42-44 base58 characters.
fn is_identity_shape(s: &str) -> bool {
    (42..=44).contains(&s.chars().count())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() && !matches!(c, '0' | 'O' | 'I' | 'l'))
}

/// `v` trimmed as a keyword of `extra` (any case) or an identity id; `None` otherwise.
fn identity_param(v: &str, extra: &[&str]) -> Option<String> {
    let t = v.trim();
    let low = t.to_lowercase();
    if extra.contains(&low.as_str()) {
        return Some(low);
    }
    is_identity_shape(t).then(|| t.to_string())
}

/// A person value (`@me`, `me`, an identity id), a leading `@` stripped.
fn who(v: &str, extra: &[&str]) -> Option<String> {
    let mut keys = vec!["me"];
    keys.extend_from_slice(extra);
    identity_param(v.strip_prefix('@').unwrap_or(v), &keys)
}

/// A source forge's login (GitHub's shape: letters, digits and inner hyphens, at most 39).
fn is_login(s: &str) -> bool {
    let mut cs = s.chars();
    cs.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && s.chars().count() <= 39
        && cs.all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// A `reason:` value in GitHub's spellings or the stored one.
#[must_use]
pub fn close_reason_value(v: &str) -> Option<&'static str> {
    let low = v.trim().to_lowercase();
    let mut norm = String::new();
    let mut gap = false;
    for c in low.chars() {
        if c.is_whitespace() || c == '_' || c == '-' {
            gap = true;
        } else {
            if gap {
                norm.push(' ');
            }
            gap = false;
            norm.push(c);
        }
    }
    if gap {
        norm.push(' ');
    }
    match norm.as_str() {
        "completed" => Some("completed"),
        "not planned" => Some("not_planned"),
        "duplicate" => Some("duplicate"),
        _ => None,
    }
}

/// An inclusive count range (`max` `u64::MAX` for none).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CountRange {
    /// Lowest.
    pub min: u64,
    /// Highest.
    pub max: u64,
}

/// The range a `comments:` value names (`5`, `>2`, `>=2`, `<5`, `<=5`, `1..3`, `2..*`, `*..3`).
#[must_use]
pub fn comment_range(v: &str) -> Option<CountRange> {
    let digits = |s: &str| !s.is_empty() && s.len() <= 9 && s.bytes().all(|b| b.is_ascii_digit());
    let (op, rest) = ["<=", ">=", "<", ">"]
        .iter()
        .find_map(|op| v.strip_prefix(op).map(|r| (*op, r)))
        .unwrap_or(("", v));
    if digits(rest) {
        let k: u64 = rest.parse().ok()?;
        return match op {
            ">" => Some(CountRange {
                min: k + 1,
                max: u64::MAX,
            }),
            ">=" => Some(CountRange {
                min: k,
                max: u64::MAX,
            }),
            "<" => (k > 0).then(|| CountRange { min: 0, max: k - 1 }),
            "<=" => Some(CountRange { min: 0, max: k }),
            _ => Some(CountRange { min: k, max: k }),
        };
    }
    if !op.is_empty() {
        return None;
    }
    let (a, b) = v.split_once("..")?;
    let side = |s: &str| s == "*" || digits(s);
    if !side(a) || !side(b) {
        return None;
    }
    if a == "*" && b == "*" {
        return None;
    }
    let min = if a == "*" { 0 } else { a.parse().ok()? };
    let max = if b == "*" { u64::MAX } else { b.parse().ok()? };
    (min <= max).then_some(CountRange { min, max })
}

fn is_qualifier_key(key: &str) -> bool {
    let known = |k: &str| APPLIED_KEYS.contains(&k) || OTHER_GITHUB_KEYS.contains(&k);
    known(key) || key.strip_prefix('-').is_some_and(known)
}

fn label_ok(v: &str) -> bool {
    !v.is_empty() && v.chars().count() <= LABEL_MAX
}

/// The states an issue state qualifier admits.
fn issue_state_set(v: &str) -> Option<&'static [&'static str]> {
    match v {
        "open" => Some(&["open"]),
        "closed" => Some(&["closed"]),
        "all" => Some(&["open", "closed"]),
        _ => None,
    }
}

/// Lift the issue qualifiers in `text` into `base` (the web's `parseSearchText` and
/// `unresolvedQualifiers`).
#[must_use]
#[allow(clippy::too_many_lines)] // one arm per qualifier, as the port's source
pub fn parse_issue_search(text: &str, base: &IssueQuery) -> Parsed<IssueQuery> {
    let mut q = base.clone();
    let mut admitted: Option<Vec<&str>> = None;
    let mut free = Vec::new();
    let mut unresolved = Vec::new();
    for tok in tokens(text) {
        let key = key_of(&tok);
        let value = unquote(raw_value(&tok));
        let used = match key.as_str() {
            "is" | "state" => {
                if let Some(set) = issue_state_set(&value) {
                    let next: Vec<&str> = match &admitted {
                        None => set.to_vec(),
                        Some(a) => a.iter().copied().filter(|s| set.contains(s)).collect(),
                    };
                    if next.is_empty() {
                        false
                    } else {
                        q.state = if next.len() == 2 { "all" } else { next[0] }.into();
                        admitted = Some(next);
                        true
                    }
                } else {
                    value == "issue"
                }
            }
            "label" => {
                if label_ok(&value) && !q.labels.contains(&value) {
                    q.labels.push(value.clone());
                }
                label_ok(&value)
            }
            "-label" => {
                if label_ok(&value) && !q.not_labels.contains(&value) {
                    q.not_labels.push(value.clone());
                }
                label_ok(&value)
            }
            "author" => {
                let login = value.strip_prefix('@').unwrap_or(&value);
                if let Some(id) = who(&value, &[]) {
                    q.author = Some(id);
                    q.author_login = None;
                    true
                } else if is_login(login) {
                    q.author_login = Some(login.to_string());
                    q.author = None;
                    true
                } else {
                    false
                }
            }
            "assignee" => who(&value, &[]).map(|id| q.assignee = Some(id)).is_some(),
            "no" => match value.as_str() {
                "assignee" => {
                    q.assignee = Some("none".into());
                    true
                }
                "label" => {
                    q.no_label = true;
                    true
                }
                "milestone" => {
                    q.no_milestone = true;
                    true
                }
                _ => false,
            },
            "milestone" => {
                let ok = !value.is_empty() && value.chars().count() <= MILESTONE_MAX;
                if ok {
                    q.milestone = Some(value.clone());
                }
                ok
            }
            "mentions" => {
                let ok = value == "@me" || value == "me";
                q.mentions |= ok;
                ok
            }
            "in" => {
                let low = value.to_lowercase();
                let parts: std::collections::BTreeSet<&str> = low.split(',').collect();
                if parts.iter().any(|p| *p != "title" && *p != "body") {
                    false
                } else {
                    q.scope = if parts.len() == 2 {
                        "any"
                    } else if parts.contains("title") {
                        "title"
                    } else {
                        "body"
                    }
                    .into();
                    true
                }
            }
            "comments" => {
                let ok = comment_range(&value).is_some();
                if ok {
                    q.comments = Some(value.clone());
                }
                ok
            }
            "reason" => close_reason_value(&value)
                .map(|r| q.reason = Some(r.into()))
                .is_some(),
            "sort" => {
                let sort = match value.as_str() {
                    "created-desc" => Some("newest"),
                    "created-asc" => Some("oldest"),
                    "comments-desc" | "comments" => Some("comments"),
                    _ => None,
                };
                sort.map(|s| q.sort = s.into()).is_some()
            }
            _ => false,
        };
        if used {
            continue;
        }
        // A GitHub key with nothing after its colon is prose (`status: broken`); an applied
        // key's empty value is reported, except `reason:` (it was prose before it was a filter).
        if is_qualifier_key(&key)
            && (!value.is_empty() || (APPLIED_KEYS.contains(&key.as_str()) && key != "reason"))
        {
            unresolved.push(tok);
        } else {
            free.push(tok);
        }
    }
    q.q = free.join(" ");
    q.page = 1;
    Parsed {
        query: q,
        unresolved,
    }
}

/// The PR states each state qualifier admits, with GitHub's meanings so that several intersect.
fn pr_state_set(v: &str) -> Option<&'static [&'static str]> {
    match v {
        "open" => Some(&["open"]),
        "merged" => Some(&["merged"]),
        "closed" => Some(&["merged", "closed"]),
        "unmerged" => Some(&["open", "closed"]),
        "all" => Some(&["open", "merged", "closed"]),
        _ => None,
    }
}

/// The list state for the PRs a run of state qualifiers admits.
fn state_of_set(set: &[&str]) -> &'static str {
    let has = |s| set.contains(&s);
    if set.len() == 3 {
        "all"
    } else if has("open") {
        if has("closed") {
            "unmerged"
        } else {
            "open"
        }
    } else if has("closed") {
        "closed"
    } else {
        "merged"
    }
}

/// Lift the PR qualifiers in `text` into `base` (the web's `parsePullSearch` and
/// `unresolvedPullQualifiers`): the PR states, `is:draft`, `draft:`, `review-requested:`, then
/// the issue grammar for the rest. `mentions:` and `reason:` are issue filters, reported.
#[must_use]
pub fn parse_pull_search(text: &str, base: &PullQuery) -> Parsed<PullQuery> {
    let mut admitted: Option<Vec<&str>> = None;
    let mut draft = None;
    let mut review_requested = None;
    let mut pull_unresolved = Vec::new();
    let mut rest = Vec::new();
    for tok in tokens(text) {
        let key = key_of(&tok);
        let value = unquote(raw_value(&tok));
        if key == "is" || key == "state" {
            if value == "draft" {
                draft = Some(true);
            } else if value.to_lowercase() == "issue" {
                pull_unresolved.push(tok);
            } else if let Some(wanted) = pr_state_set(&value) {
                let next: Vec<&str> = match &admitted {
                    None => wanted.to_vec(),
                    Some(a) => a.iter().copied().filter(|s| wanted.contains(s)).collect(),
                };
                if next.is_empty() {
                    pull_unresolved.push(tok);
                } else {
                    admitted = Some(next);
                }
            } else if value != "pr" {
                rest.push(tok);
            }
        } else if key == "mentions" || (key == "reason" && !value.is_empty()) {
            pull_unresolved.push(tok);
        } else if key == "draft" {
            match value.to_lowercase().as_str() {
                "true" => draft = Some(true),
                "false" => draft = Some(false),
                _ => pull_unresolved.push(tok),
            }
        } else if key == "review-requested" {
            match who(&value, &[]) {
                Some(w) => review_requested = Some(w),
                None => pull_unresolved.push(tok),
            }
        } else {
            rest.push(tok);
        }
    }
    let issue_base = IssueQuery {
        state: "open".into(),
        labels: base.labels.clone(),
        author: base.author.clone(),
        assignee: base.assignee.clone(),
        mentions: false,
        sort: base.sort.clone(),
        q: base.q.clone(),
        page: base.page,
        not_labels: base.not_labels.clone(),
        no_label: base.no_label,
        milestone: base.milestone.clone(),
        no_milestone: base.no_milestone,
        author_login: base.author_login.clone(),
        scope: base.scope.clone(),
        comments: base.comments.clone(),
        reason: base.reason.clone(),
    };
    let Parsed {
        query: i,
        unresolved: mut issue_unresolved,
    } = parse_issue_search(&rest.join(" "), &issue_base);
    issue_unresolved.extend(pull_unresolved);
    Parsed {
        query: PullQuery {
            state: admitted
                .as_deref()
                .map_or_else(|| base.state.clone(), |s| state_of_set(s).to_string()),
            labels: i.labels,
            author: i.author,
            assignee: i.assignee,
            sort: i.sort,
            q: i.q,
            page: i.page,
            not_labels: i.not_labels,
            no_label: i.no_label,
            milestone: i.milestone,
            no_milestone: i.no_milestone,
            author_login: i.author_login,
            scope: i.scope,
            comments: i.comments,
            reason: i.reason,
            draft: draft.or(base.draft),
            review_requested: review_requested.or_else(|| base.review_requested.clone()),
        },
        unresolved: issue_unresolved,
    }
}

impl Default for PullQuery {
    fn default() -> Self {
        let i = IssueQuery::default();
        Self {
            state: i.state,
            labels: i.labels,
            author: i.author,
            assignee: i.assignee,
            sort: i.sort,
            q: i.q,
            page: i.page,
            not_labels: i.not_labels,
            no_label: i.no_label,
            milestone: i.milestone,
            no_milestone: i.no_milestone,
            author_login: i.author_login,
            scope: i.scope,
            comments: i.comments,
            reason: i.reason,
            draft: None,
            review_requested: None,
        }
    }
}

/// One free-text search term: a word or a phrase, and whether a row must not hold it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchTerm {
    /// The term, lowercased.
    pub text: String,
    /// `-word` / `-"a phrase"`.
    pub not: bool,
}

/// The free text's terms (the web's `searchTerms`): a `"quoted phrase"` is one term, any other
/// word one term, lowercased; a leading `-` outside quotes negates it.
#[must_use]
pub fn search_terms(text: &str) -> Vec<SearchTerm> {
    let chars: Vec<char> = text.to_lowercase().chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_whitespace() {
            i += 1;
            continue;
        }
        let quote_at = if chars[i] == '"' {
            Some(i)
        } else if chars[i] == '-' && chars.get(i + 1) == Some(&'"') {
            Some(i + 1)
        } else {
            None
        };
        if let Some(open) = quote_at {
            if let Some(close) = (open + 1..chars.len()).find(|&k| chars[k] == '"') {
                let phrase: String = chars[open + 1..close].iter().collect();
                let phrase = phrase.trim();
                if !phrase.is_empty() {
                    out.push(SearchTerm {
                        text: phrase.to_string(),
                        not: open != i,
                    });
                }
                i = close + 1;
                continue;
            }
        }
        let end = (i..chars.len())
            .find(|&j| chars[j].is_whitespace())
            .unwrap_or(chars.len());
        let word: String = chars[i..end].iter().filter(|c| **c != '"').collect();
        let word = word.trim();
        i = end;
        if word.is_empty() {
            continue;
        }
        let not = word.chars().count() > 1 && word.starts_with('-');
        out.push(SearchTerm {
            text: if not {
                word[1..].to_string()
            } else {
                word.to_string()
            },
            not,
        });
    }
    out
}

/// A mirrored body without its provenance quote (the web's `searchableBody`): a body that starts
/// `> Mirrored from <host> by @<login> (…)` loses that line and the quoted lines after it.
#[must_use]
pub fn searchable_body(body: &str) -> &str {
    if mirrored_login(body).is_none() {
        return body;
    }
    let mut rest = body;
    let mut first = true;
    loop {
        if !first && !rest.starts_with('>') {
            return rest;
        }
        first = false;
        match rest.find('\n') {
            Some(nl) => rest = &rest[nl + 1..],
            None => return "",
        }
    }
}

/// The source login a mirrored body's provenance line names (`> Mirrored from github.com by
/// @alice (issue, …)`), when it has one.
#[must_use]
pub fn mirrored_login(body: &str) -> Option<&str> {
    let first = body.split('\n').next()?;
    let rest = first.strip_prefix("> Mirrored from ")?;
    let (host, rest) = rest.split_once(' ')?;
    if host.is_empty() || host.contains(char::is_whitespace) {
        return None;
    }
    let rest = rest.strip_prefix("by @")?;
    let (login, rest) = rest.split_once(' ')?;
    (!login.is_empty() && rest.starts_with('(') && rest[1..].contains(')')).then_some(login)
}

/// Whether a row holds every term of `text`, in its title or body (`scope` `any`, `title` or
/// `body`): the web's `matchesText`. `#12` matches the number only; a bare `12` the number or
/// the text; `-word` excludes.
#[must_use]
pub fn matches_text(text: &str, title: &str, number: u64, body: &str, scope: &str) -> bool {
    let terms = search_terms(text);
    if terms.is_empty() {
        return true;
    }
    let mut fields = Vec::new();
    if scope != "body" {
        fields.push(title.to_lowercase());
    }
    if scope != "title" && !body.is_empty() {
        fields.push(searchable_body(body).to_lowercase());
    }
    let holds = |w: &str| {
        let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
        if let Some(n) = w.strip_prefix('#').filter(|n| digits(n)) {
            return n.parse::<u64>().ok() == Some(number);
        }
        if digits(w) && w.parse::<u64>().ok() == Some(number) {
            return true;
        }
        fields.iter().any(|f| f.contains(w))
    };
    terms.iter().all(|t| holds(&t.text) != t.not)
}

/// Whether `body` mentions the identity: its id, or `@label` (its DPNS label, word-bounded,
/// case-insensitive): the web's `mentions`.
#[must_use]
pub fn mentions(body: &str, id: &str, name: Option<&str>) -> bool {
    if body.is_empty() {
        return false;
    }
    if body.contains(id) {
        return true;
    }
    let label = name.and_then(|n| n.split('.').next()).unwrap_or("");
    if label.is_empty() {
        return false;
    }
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let needle = format!("@{}", label.to_ascii_lowercase());
    let hay = body.to_ascii_lowercase();
    let mut from = 0;
    while let Some(at) = hay[from..].find(&needle).map(|a| a + from) {
        let before = hay[..at].chars().next_back();
        let after = hay[at + needle.len()..].chars().next();
        if before.is_none_or(|c| !word(c) && c != '@') && after.is_none_or(|c| !word(c) && c != '-')
        {
            return true;
        }
        from = at + 1;
    }
    false
}
