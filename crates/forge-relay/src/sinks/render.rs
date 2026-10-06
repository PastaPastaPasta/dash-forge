//! A [`WebhookEvent`] as a short human notice: one line saying who did what, an excerpt, and
//! the forge-web link. Pure and offline: the sinks ([`super::send`]) and forge-notify format it
//! for each channel.
//!
//! Everything here comes from public chain data (the relay serves public repositories only),
//! but titles and bodies are written by strangers, so a notice is plain text with control
//! characters removed and lengths capped. Each channel escapes it for its own markup.
//!
//! Members-only content ([`crate::ingest::MEMBERS_ONLY_KEY`]) has no text in the event; a
//! notice says what happened instead ("alice posted a members-only comment on issue #12",
//! "alice opened members-only issue #3") and never quotes the empty text.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::ingest::MEMBERS_ONLY_KEY;
use crate::payload::WebhookEvent;

/// The longest title line, in characters.
pub const MAX_TITLE_CHARS: usize = 200;

/// The longest excerpt, in characters.
pub const MAX_EXCERPT_CHARS: usize = 500;

/// One event, ready to show to a person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    /// The repository id (base58).
    pub repo_id: String,
    /// The repository as people read it: `<owner name or short id>/<name>`.
    pub repo: String,
    /// The GitHub event name (`push`, `issues`, ...).
    pub event: &'static str,
    /// The GitHub action (`opened`, `closed`, ...; empty for a push).
    pub action: String,
    /// Who did it (identity id; empty when unknown).
    pub actor: String,
    /// One line: "alice opened pull request #12: Fix the parser".
    pub title: String,
    /// A comment, review or description excerpt (may be empty).
    pub excerpt: String,
    /// The forge-web page to open.
    pub url: String,
    /// The issue or PR it is about: `(is_pr, number)`.
    pub thread: Option<(bool, u64)>,
    /// A stable id for the event (the same on every relay): event name and source document.
    pub id: String,
}

/// A display name for an identity: its DPNS label when `names` has one (`alice.dash` shows as
/// `alice`), else the id shortened to its first 7 and last 5 characters ([`short_id`]).
pub fn display_name(id: &str, names: &BTreeMap<String, String>) -> String {
    if id.is_empty() {
        return "someone".to_string();
    }
    match names.get(id) {
        Some(n) => clean_line(n.strip_suffix(".dash").unwrap_or(n), 64),
        None => short_id(id),
    }
}

/// An id shortened to its first 7 and last 5 characters (`Fi8bQ2x…9XwYz`), as the web app and
/// `dg` show it. Never the prefix alone: an identity id is a hash of the asset lock that funded
/// it, so an attacker can grind one whose first characters match a maintainer's; matching both
/// ends too costs far more. Ids of 13 characters or fewer come back unchanged.
pub fn short_id(id: &str) -> String {
    let chars: Vec<char> = id.chars().collect();
    if chars.len() <= 13 {
        return id.to_string();
    }
    let head: String = chars[..7].iter().collect();
    let tail: String = chars[chars.len() - 5..].iter().collect();
    format!("{head}…{tail}")
}

/// One line: invisible format characters are dropped, control characters (newlines included)
/// become spaces, runs of spaces collapse, and the result is cut to `max` characters with an
/// ellipsis.
pub fn clean_line(s: &str, max: usize) -> String {
    let mut out = String::with_capacity(s.len().min(max * 4));
    let mut space = false;
    for c in s.chars() {
        if is_bidi_control(c) {
            continue;
        }
        let c = if c.is_control() { ' ' } else { c };
        if c.is_whitespace() {
            if !space && !out.is_empty() {
                out.push(' ');
            }
            space = true;
        } else {
            out.push(c);
            space = false;
        }
    }
    truncate(out.trim_end(), max)
}

/// A multi-line excerpt: control characters other than newlines removed, at most three blank
/// lines in a row kept as one, cut to `max` characters.
pub fn clean_text(s: &str, max: usize) -> String {
    let mut out = String::with_capacity(s.len().min(max * 4));
    let mut newlines = 0;
    for c in s.trim().chars() {
        let c = if is_line_separator(c) { '\n' } else { c };
        if c == '\n' {
            newlines += 1;
            if newlines <= 2 {
                out.push('\n');
            }
            continue;
        }
        if c.is_control() || is_bidi_control(c) {
            continue;
        }
        newlines = 0;
        out.push(c);
    }
    truncate(out.trim_end(), max)
}

/// Bidirectional marks, overrides and isolates (Trojan Source), and invisible format
/// characters (zero-width spaces and joiners, the BOM): a title must read the way it shows.
fn is_bidi_control(c: char) -> bool {
    matches!(
        c,
        '\u{202A}'..='\u{202E}'
            | '\u{2066}'..='\u{2069}'
            | '\u{200B}'..='\u{200F}'
            | '\u{061C}'
            | '\u{2060}'
            | '\u{FEFF}'
    )
}

/// Unicode line and paragraph separators: a newline for an excerpt, a space for a title.
fn is_line_separator(c: char) -> bool {
    matches!(c, '\u{2028}' | '\u{2029}' | '\u{0085}')
}

/// `s` cut to `max` characters, with an ellipsis when it was cut.
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn str_at<'a>(v: &'a Value, path: &[&str]) -> &'a str {
    path.iter()
        .try_fold(v, |v, k| v.get(k))
        .and_then(Value::as_str)
        .unwrap_or("")
}

/// Whether `v` (the payload, or its `issue` / `pull_request`) is marked members-only.
fn members_only(v: &Value) -> bool {
    v.get(MEMBERS_ONLY_KEY).and_then(Value::as_bool) == Some(true)
}

/// "issue #12: Title", or "members-only issue #12" for a members-only thread (it has no title).
fn thread_ref(obj: &Value, what: &str, number: u64) -> String {
    if members_only(obj) {
        format!("members-only {what} #{number}")
    } else {
        let title = clean_line(str_at(obj, &["title"]), MAX_TITLE_CHARS);
        format!("{what} #{number}: {title}")
    }
}

fn u64_at(v: &Value, path: &[&str]) -> u64 {
    path.iter()
        .try_fold(v, |v, k| v.get(k))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

/// The first 7 hex digits of an oid.
fn short_oid(oid: &str) -> &str {
    oid.get(..7).unwrap_or(oid)
}

/// The identity ids a notice of `event` names (the actor, the repo owner, an assignee or
/// requested reviewer): what a caller resolves to DPNS names before [`render`].
pub fn named_ids(event: &WebhookEvent) -> Vec<String> {
    let p = &event.payload;
    [
        str_at(p, &["sender", "login"]),
        str_at(p, &["repository", "owner", "login"]),
        str_at(p, &["assignee", "login"]),
        str_at(p, &["requested_reviewer", "login"]),
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .map(ToString::to_string)
    .collect()
}

/// `event` as a [`Notice`]. `names` maps identity ids to DPNS names ([`named_ids`]); ids
/// without one show shortened. `None` for an event this does not know how to say.
pub fn render(event: &WebhookEvent, names: &BTreeMap<String, String>) -> Option<Notice> {
    let p = &event.payload;
    let name = |id: &str| display_name(id, names);
    let actor_id = str_at(p, &["sender", "login"]).to_string();
    let actor = name(&actor_id);
    let action = event.action.unwrap_or("");
    let repo = format!(
        "{}/{}",
        name(str_at(p, &["repository", "owner", "login"])),
        clean_line(str_at(p, &["repository", "name"]), 100)
    );
    let mut thread = None;
    let mut excerpt = String::new();
    let (title, url) = match event.event {
        "push" => push_title(p, &actor),
        "issues" | "pull_request" => {
            let is_pr = event.event == "pull_request";
            let obj = if is_pr { "pull_request" } else { "issue" };
            let number = u64_at(p, &[obj, "number"]);
            thread = Some((is_pr, number));
            let verb = thread_verb(p, action, is_pr, &name)?;
            let what = if is_pr { "pull request" } else { "issue" };
            if action == "opened" && !members_only(&p[obj]) {
                excerpt = clean_text(str_at(p, &[obj, "body"]), MAX_EXCERPT_CHARS);
            }
            (
                format!("{actor} {verb} {}", thread_ref(&p[obj], what, number)),
                str_at(p, &[obj, "html_url"]).to_string(),
            )
        }
        "issue_comment" => {
            let is_pr = p["issue"].get("pull_request").is_some();
            let number = u64_at(p, &["issue", "number"]);
            thread = Some((is_pr, number));
            let what = if is_pr { "pull request" } else { "issue" };
            let verb = if members_only(p) {
                "posted a members-only comment on"
            } else {
                excerpt = clean_text(str_at(p, &["comment", "body"]), MAX_EXCERPT_CHARS);
                "commented on"
            };
            (
                format!("{actor} {verb} {}", thread_ref(&p["issue"], what, number)),
                str_at(p, &["comment", "html_url"]).to_string(),
            )
        }
        "pull_request_review" => {
            let number = u64_at(p, &["pull_request", "number"]);
            thread = Some((true, number));
            let state = str_at(p, &["review", "state"]);
            let pr = thread_ref(&p["pull_request"], "pull request", number);
            let line = if members_only(p) {
                // The verdict is public; the review's text is not. The PR's title goes last.
                let (head, title) = pr.split_once(": ").unwrap_or((&pr, ""));
                let title = if title.is_empty() {
                    String::new()
                } else {
                    format!(": {title}")
                };
                match state {
                    "approved" => {
                        format!("{actor} approved {head} in a members-only review{title}")
                    }
                    "changes_requested" => format!(
                        "{actor} requested changes on {head} in a members-only review{title}"
                    ),
                    _ => format!("{actor} posted a members-only review on {head}{title}"),
                }
            } else {
                excerpt = clean_text(str_at(p, &["review", "body"]), MAX_EXCERPT_CHARS);
                let verb = match state {
                    "approved" => "approved",
                    "changes_requested" => "requested changes on",
                    _ => "reviewed",
                };
                format!("{actor} {verb} {pr}")
            };
            (line, str_at(p, &["review", "html_url"]).to_string())
        }
        "release" => {
            let (title, url, body) = release_title(p, action, &actor);
            excerpt = body;
            (title, url)
        }
        "check_run" => check_title(p, action),
        _ => return None,
    };
    Some(Notice {
        repo_id: str_at(p, &["repository", "node_id"]).to_string(),
        repo,
        event: event.event,
        action: action.to_string(),
        actor: actor_id,
        title: clean_line(&title, MAX_TITLE_CHARS),
        excerpt,
        url,
        thread,
        id: format!("{}:{}", event.event, event.source_doc_id),
    })
}

/// A release's line, link and excerpt.
fn release_title(p: &Value, action: &str, actor: &str) -> (String, String, String) {
    let tag = clean_line(str_at(p, &["release", "tag_name"]), 100);
    let release_name = clean_line(str_at(p, &["release", "name"]), 100);
    let verb = match action {
        "published" => "published release",
        "unpublished" => "yanked release",
        _ => "edited release",
    };
    let excerpt = if action == "published" {
        clean_text(str_at(p, &["release", "body"]), MAX_EXCERPT_CHARS)
    } else {
        String::new()
    };
    let suffix = if release_name.is_empty() || release_name == tag {
        String::new()
    } else {
        format!(": {release_name}")
    };
    (
        format!("{actor} {verb} {tag}{suffix}"),
        str_at(p, &["release", "html_url"]).to_string(),
        excerpt,
    )
}

/// A check run's line and link.
fn check_title(p: &Value, action: &str) -> (String, String) {
    let check = clean_line(str_at(p, &["check_run", "name"]), 100);
    let sha = short_oid(str_at(p, &["check_run", "head_sha"]));
    let outcome = if action == "completed" {
        match clean_line(str_at(p, &["check_run", "conclusion"]), 40) {
            c if c.is_empty() => "completed".to_string(),
            c => c,
        }
    } else {
        "started".to_string()
    };
    (
        format!("Check {check} {outcome} on {sha}"),
        str_at(p, &["check_run", "html_url"]).to_string(),
    )
}

/// A push's line and link.
fn push_title(p: &Value, actor: &str) -> (String, String) {
    let full = str_at(p, &["ref"]);
    let (kind, short) = if let Some(b) = full.strip_prefix("refs/heads/") {
        ("branch", b)
    } else if let Some(t) = full.strip_prefix("refs/tags/") {
        ("tag", t)
    } else {
        ("ref", full)
    };
    let short = clean_line(short, 100);
    let after = short_oid(str_at(p, &["after"]));
    let flag = |k: &str| p.get(k).and_then(Value::as_bool).unwrap_or(false);
    let title = if flag("deleted") {
        format!("{actor} deleted {kind} {short}")
    } else if flag("created") {
        format!("{actor} created {kind} {short} at {after}")
    } else if flag("forced") {
        format!("{actor} force-pushed {short} to {after}")
    } else {
        format!("{actor} pushed {after} to {short}")
    };
    (title, str_at(p, &["compare"]).to_string())
}

/// The verb of an `issues` / `pull_request` action, naming a label, assignee or reviewer.
fn thread_verb(
    p: &Value,
    action: &str,
    is_pr: bool,
    name: &dyn Fn(&str) -> String,
) -> Option<String> {
    let label = || clean_line(str_at(p, &["label", "name"]), 60);
    let merged = is_pr && p["pull_request"]["merged"].as_bool().unwrap_or(false);
    // A members-only label event carries no name.
    let sealed = members_only(p);
    Some(match action {
        "opened" => "opened".into(),
        "labeled" if sealed => "added a members-only label to".into(),
        "unlabeled" if sealed => "removed a members-only label from".into(),
        "closed" if merged => "merged".into(),
        "closed" => "closed".into(),
        "reopened" => "reopened".into(),
        "labeled" => format!("added label \"{}\" to", label()),
        "unlabeled" => format!("removed label \"{}\" from", label()),
        "assigned" => format!("assigned {} to", name(str_at(p, &["assignee", "login"]))),
        "unassigned" => format!(
            "unassigned {} from",
            name(str_at(p, &["assignee", "login"]))
        ),
        "locked" => "locked".into(),
        "unlocked" => "unlocked".into(),
        "converted_to_draft" => "marked as draft".into(),
        "ready_for_review" => "marked ready for review".into(),
        "synchronize" => "pushed new commits to".into(),
        "edited" => "changed the base branch of".into(),
        "review_requested" => format!(
            "requested a review from {} on",
            name(str_at(p, &["requested_reviewer", "login"]))
        ),
        "review_request_removed" => format!(
            "removed the review request for {} on",
            name(str_at(p, &["requested_reviewer", "login"]))
        ),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::payload::{
        issue_comment_event, pull_request_event, push_event, release_event, IssueObj,
        PullRequestObj, ReleaseObj, RepositoryMeta,
    };

    fn meta() -> RepositoryMeta {
        RepositoryMeta {
            repo_id: "REPOID".into(),
            owner_id: "OWNER1234567".into(),
            name: "project".into(),
            default_branch: "main".into(),
            web_base_url: "https://forge.example".into(),
        }
    }

    fn names() -> BTreeMap<String, String> {
        BTreeMap::from([("ALICEID".to_string(), "alice.dash".to_string())])
    }

    fn pr(title: &str, merged: bool) -> PullRequestObj {
        PullRequestObj {
            number: 12,
            document_id: "PRDOC".into(),
            author: "ALICEID".into(),
            title: title.into(),
            body: "Body\n\n\n\nmore".into(),
            base_ref: "refs/heads/main".into(),
            head_oid: "ab".repeat(20),
            open: !merged,
            merged,
            draft: false,
        }
    }

    #[test]
    fn a_pull_request_reads_as_a_sentence() {
        let e = pull_request_event(&meta(), "PRDOC", "opened", &pr("Fix the parser", false));
        let n = render(&e, &names()).unwrap();
        assert_eq!(n.title, "alice opened pull request #12: Fix the parser");
        // An unnamed owner: 13 characters or fewer show whole, longer ones as 7…5.
        assert_eq!(n.repo, "OWNER1234567/project");
        assert_eq!(
            short_id("Fi8bQ2xkPqR7sT9uVwXyZ1a2b3c4d5e6f7g8h9i0jKL"),
            "Fi8bQ2x…i0jKL"
        );
        assert_eq!(n.excerpt, "Body\n\nmore", "blank lines collapse");
        assert_eq!(n.thread, Some((true, 12)));
        assert!(n.url.starts_with("https://forge.example/repo/pull/?"));
        assert_eq!(n.id, "pull_request:PRDOC");
        let e = pull_request_event(&meta(), "T1", "closed", &pr("Fix", true));
        assert!(render(&e, &names())
            .unwrap()
            .title
            .starts_with("alice merged pull request"));
    }

    /// Members-only content (DESIGN D14): the notice says what happened, never quotes the empty
    /// text, and names a members-only thread by number only.
    #[test]
    fn members_only_activity_is_worded_without_text() {
        let mark = |mut e: WebhookEvent, top: bool, obj: &str| {
            if top {
                e.payload[MEMBERS_ONLY_KEY] = Value::Bool(true);
            }
            if !obj.is_empty() {
                e.payload[obj][MEMBERS_ONLY_KEY] = Value::Bool(true);
            }
            e
        };
        let issue = |title: &str| IssueObj {
            number: 12,
            document_id: "I12".into(),
            author: "OWNER1234567".into(),
            title: title.into(),
            body: String::new(),
            open: true,
            is_pr: false,
        };
        // A member's members-only comment on a public issue.
        let e = issue_comment_event(&meta(), "C", &issue("Crash on start"), "C", "ALICEID", "");
        let n = render(&mark(e, true, ""), &names()).unwrap();
        assert_eq!(
            n.title,
            "alice posted a members-only comment on issue #12: Crash on start"
        );
        assert_eq!(n.excerpt, "");
        // On a members-only issue: no title at all.
        let e = issue_comment_event(&meta(), "C", &issue(""), "C", "ALICEID", "");
        let n = render(&mark(e, true, "issue"), &names()).unwrap();
        assert_eq!(
            n.title,
            "alice posted a members-only comment on members-only issue #12"
        );
        // A public comment on a members-only issue keeps its public text.
        let e = issue_comment_event(&meta(), "C", &issue(""), "C", "ALICEID", "hello");
        let n = render(&mark(e, false, "issue"), &names()).unwrap();
        assert_eq!(n.title, "alice commented on members-only issue #12");
        assert_eq!(n.excerpt, "hello");
        // A members-only PR opened, then closed.
        let mut sealed = pr("", false);
        sealed.body = String::new();
        let e = pull_request_event(&meta(), "P", "opened", &sealed);
        let n = render(&mark(e, true, "pull_request"), &names()).unwrap();
        assert_eq!(n.title, "alice opened members-only pull request #12");
        assert_eq!(n.excerpt, "");
        let e = pull_request_event(&meta(), "T", "closed", &sealed);
        let n = render(&mark(e, false, "pull_request"), &names()).unwrap();
        assert_eq!(n.title, "alice closed members-only pull request #12");
        // A members-only review keeps its verdict.
        let e = crate::payload::pull_request_review_event(
            &meta(),
            "R",
            &pr("Fix the parser", false),
            "ALICEID",
            1,
            "",
            "",
        );
        let n = render(&mark(e, true, ""), &names()).unwrap();
        assert_eq!(
            n.title,
            "alice approved pull request #12 in a members-only review: Fix the parser"
        );
        // A members-only label value.
        let mut e = pull_request_event(&meta(), "L", "labeled", &pr("Fix", false));
        e.payload["label"] = serde_json::json!({ "name": "" });
        let n = render(&mark(e, true, ""), &names()).unwrap();
        assert_eq!(
            n.title,
            "alice added a members-only label to pull request #12: Fix"
        );
    }

    #[test]
    fn hostile_titles_stay_on_one_line() {
        let e = pull_request_event(
            &meta(),
            "P",
            "opened",
            &pr("a\r\nBcc: x@y\u{202E}gnp.exe\u{0007}", false),
        );
        let n = render(&e, &names()).unwrap();
        assert!(
            !n.title.contains(['\r', '\n', '\u{202E}', '\u{0007}']),
            "{}",
            n.title
        );
        let e = pull_request_event(
            &meta(),
            "P",
            "opened",
            &pr("pay\u{200B}pal\u{061C}\u{FEFF} x\u{2028}y", false),
        );
        let n = render(&e, &names()).unwrap();
        assert!(n.title.ends_with("paypal x y"), "{}", n.title);
        assert_eq!(clean_text("a\u{2028}> b", 50), "a\n> b");
        let long = "x".repeat(1000);
        let e = pull_request_event(&meta(), "P", "opened", &pr(&long, false));
        let n = render(&e, &names()).unwrap();
        assert_eq!(n.title.chars().count(), MAX_TITLE_CHARS);
        assert!(n.title.ends_with('…'));
    }

    #[test]
    fn pushes_comments_and_releases() {
        let e = push_event(
            &meta(),
            "R1",
            "refs/heads/main",
            &"11".repeat(20),
            &"22".repeat(20),
            false,
            "ALICEID",
        );
        assert_eq!(
            render(&e, &names()).unwrap().title,
            "alice pushed 2222222 to main"
        );
        let e = push_event(
            &meta(),
            "R2",
            "refs/heads/x",
            &"11".repeat(20),
            "",
            false,
            "BOBID12345",
        );
        assert_eq!(
            render(&e, &names()).unwrap().title,
            "BOBID12345 deleted branch x"
        );
        let e = push_event(
            &meta(),
            "R3",
            "refs/tags/v1",
            "",
            &"33".repeat(20),
            false,
            "ALICEID",
        );
        assert_eq!(
            render(&e, &names()).unwrap().title,
            "alice created tag v1 at 3333333"
        );

        let issue = IssueObj {
            number: 4,
            document_id: "I".into(),
            author: "X".into(),
            title: "Crash".into(),
            body: String::new(),
            open: true,
            is_pr: false,
        };
        let e = issue_comment_event(&meta(), "C1", &issue, "C1", "ALICEID", "me too @bob");
        let n = render(&e, &names()).unwrap();
        assert_eq!(n.title, "alice commented on issue #4: Crash");
        assert_eq!(n.excerpt, "me too @bob");
        assert_eq!(n.thread, Some((false, 4)));

        let rel = ReleaseObj {
            document_id: "REL".into(),
            tag_name: "v1.2.0".into(),
            name: "Twelve".into(),
            body: "notes".into(),
            yanked: false,
            author: "ALICEID".into(),
            assets: serde_json::json!([]),
        };
        let e = release_event(&meta(), "REL", "published", &rel);
        let n = render(&e, &names()).unwrap();
        assert_eq!(n.title, "alice published release v1.2.0: Twelve");
        assert_eq!(n.excerpt, "notes");
    }

    #[test]
    fn named_ids_lists_who_a_notice_names() {
        let mut e = pull_request_event(&meta(), "P", "review_requested", &pr("T", false));
        e.payload["requested_reviewer"] = meta().user_json("BOBID12345");
        let ids = named_ids(&e);
        assert!(ids.contains(&"ALICEID".to_string()) && ids.contains(&"BOBID12345".to_string()));
        let n = render(&e, &names()).unwrap();
        assert_eq!(
            n.title,
            "alice requested a review from BOBID12345 on pull request #12: T"
        );
    }
}
