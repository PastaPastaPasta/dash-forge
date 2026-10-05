//! From the relay's events to the subscribers who want them.
//!
//! forge-relay polls the followed public repositories and hands every event to
//! [`NotifySink`]; the [`Router`] renders it once ([`forge_relay::sinks::render`]) and finds:
//!
//! * **watchers**: subscribers following the repo (a `watch` document, or owner and members
//!   with "my repositories" on): new issues and PRs, comments, reviews, closes, reopens and
//!   merges ([`is_activity`]); releases to everyone following with "releases" on;
//! * **participants**: whoever opened the thread, or commented on or reviewed it, as seen here;
//! * **mentions**: `@label` (a DPNS name, word-bounded, case-insensitive) or the raw identity id
//!   in a description, comment or review, the same rule as forge-web's `mentions()`.
//!
//! Assignments and review requests come from the addressed poller ([`crate::index`]), which
//! reads them in every repository. Nobody is told about their own action.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::mpsc;

use forge_relay::payload::WebhookEvent;
use forge_relay::sinks::render::{self, Notice};
use forge_relay::sinks::{EventSink, NameCache};

use crate::dispatch::{Dispatcher, OutNotice, Reason};
use crate::error::Result;
use crate::store::{FollowReason, Store, Subscriber};

/// Events waiting for the router; more are dropped with a warning.
pub const ROUTER_QUEUE: usize = 1024;

/// Hands the relay's events to the router without blocking the poller.
pub struct NotifySink {
    tx: mpsc::Sender<(String, WebhookEvent)>,
    warned: std::sync::Mutex<Option<Instant>>,
}

impl NotifySink {
    /// A sink and the receiver [`Router::run`] reads.
    pub fn new() -> (Self, mpsc::Receiver<(String, WebhookEvent)>) {
        let (tx, rx) = mpsc::channel(ROUTER_QUEUE);
        (
            Self {
                tx,
                warned: std::sync::Mutex::new(None),
            },
            rx,
        )
    }
}

impl EventSink for NotifySink {
    fn accept(&self, repo_id: &str, event: &WebhookEvent) {
        if self
            .tx
            .try_send((repo_id.to_string(), event.clone()))
            .is_err()
        {
            let mut w = self
                .warned
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if w.is_none_or(|t| t.elapsed() > Duration::from_secs(60)) {
                *w = Some(Instant::now());
                tracing::warn!("the router is behind; dropping events");
            }
        }
    }
}

/// Subscribers by DPNS label and by id, for mentions.
#[derive(Debug, Default, Clone)]
pub struct MentionIndex {
    by_label: HashMap<String, Vec<String>>,
    ids: HashSet<String>,
}

impl MentionIndex {
    /// The index of `subs` (identity, label).
    pub fn build<'a>(subs: impl IntoIterator<Item = (&'a str, Option<&'a str>)>) -> Self {
        let mut idx = Self::default();
        for (id, label) in subs {
            idx.ids.insert(id.to_string());
            if let Some(l) = label.filter(|l| !l.is_empty()) {
                idx.by_label
                    .entry(l.to_lowercase())
                    .or_default()
                    .push(id.to_string());
            }
        }
        idx
    }

    /// The subscribers `text` mentions.
    pub fn mentioned(&self, text: &str) -> HashSet<String> {
        let mut out = HashSet::new();
        let chars: Vec<char> = text.chars().collect();
        let word = |c: char| c.is_alphanumeric() || c == '_' || c == '-';
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if c == '@'
                && (i == 0
                    || !(chars[i - 1].is_alphanumeric()
                        || chars[i - 1] == '_'
                        || chars[i - 1] == '@'))
            {
                let start = i + 1;
                let mut end = start;
                while end < chars.len() && word(chars[end]) {
                    end += 1;
                }
                let label: String = chars[start..end].iter().collect::<String>().to_lowercase();
                if let Some(ids) = self.by_label.get(&label) {
                    out.extend(ids.iter().cloned());
                }
                i = end.max(i + 1);
                continue;
            }
            i += 1;
        }
        // A raw identity id anywhere in the text (base58 runs).
        for token in text.split(|c: char| !c.is_ascii_alphanumeric()) {
            if (40..=46).contains(&token.len()) && self.ids.contains(token) {
                out.insert(token.to_string());
            }
        }
        out
    }
}

/// Whether an event is worth a watcher's or participant's attention (not labels, pushes,
/// check runs or head updates).
pub fn is_activity(event: &str, action: &str) -> bool {
    match event {
        "issues" => matches!(action, "opened" | "closed" | "reopened"),
        "pull_request" => matches!(
            action,
            "opened" | "closed" | "reopened" | "ready_for_review"
        ),
        "issue_comment" => action == "created",
        "pull_request_review" => action == "submitted",
        _ => false,
    }
}

fn str_at<'a>(v: &'a Value, path: &[&str]) -> &'a str {
    let mut cur = v;
    for p in path {
        cur = &cur[*p];
    }
    cur.as_str().unwrap_or("")
}

/// The full text an event carries (description, comment or review body), for mentions.
fn body_of(event: &WebhookEvent) -> &str {
    let p = &event.payload;
    match (event.event, event.action.unwrap_or("")) {
        ("issues", "opened") => str_at(p, &["issue", "body"]),
        ("pull_request", "opened") => str_at(p, &["pull_request", "body"]),
        ("issue_comment", _) => str_at(p, &["comment", "body"]),
        ("pull_request_review", _) => str_at(p, &["review", "body"]),
        _ => "",
    }
}

/// Who opened the thread an event is about.
fn thread_author(event: &WebhookEvent) -> &str {
    let p = &event.payload;
    let a = str_at(p, &["issue", "user", "login"]);
    if a.is_empty() {
        str_at(p, &["pull_request", "user", "login"])
    } else {
        a
    }
}

/// The thread key (`issue:3`, `pr:7`).
pub fn thread_key(n: &Notice) -> Option<String> {
    n.thread
        .map(|(pr, num)| format!("{}:{num}", if pr { "pr" } else { "issue" }))
}

/// Whether `s`'s preferences let a notice of `reason` through, given how they follow the repo.
pub fn wants(s: &Subscriber, reason: Reason, follow: Option<FollowReason>) -> bool {
    let p = &s.prefs;
    match reason {
        Reason::ReviewRequested => p.review_requested,
        Reason::Assigned => p.assigned,
        Reason::Mentioned => p.mentioned,
        Reason::Participating => p.participating,
        Reason::Release => p.releases && (follow != Some(FollowReason::Member) || p.own_repos),
        Reason::Watching => p.watching && (follow != Some(FollowReason::Member) || p.own_repos),
        Reason::PrivateActivity => p.private_activity,
    }
}

/// Routes events to subscribers.
pub struct Router {
    /// The store.
    pub store: Store,
    /// Delivery.
    pub dispatcher: Arc<Dispatcher>,
    /// DPNS names for display (the relay's cache).
    pub names: Option<Arc<NameCache>>,
    /// Mentions.
    pub mentions: Arc<RwLock<MentionIndex>>,
}

impl Router {
    /// Route events until the sink is dropped.
    pub async fn run(self, mut rx: mpsc::Receiver<(String, WebhookEvent)>) {
        while let Some((repo_id, event)) = rx.recv().await {
            if let Err(e) = self.route(&repo_id, &event).await {
                tracing::warn!(repo = %repo_id, event = event.event, error = %e, "routing failed");
            }
        }
    }

    /// Route one event.
    pub async fn route(&self, repo_id: &str, event: &WebhookEvent) -> Result<()> {
        let names = match &self.names {
            Some(n) => n.names(&render::named_ids(event)).await,
            None => BTreeMap::new(),
        };
        let Some(notice) = render::render(event, &names) else {
            return Ok(());
        };
        let action = notice.action.as_str();
        let thread = thread_key(&notice);
        if let Some(t) = &thread {
            for who in [notice.actor.as_str(), thread_author(event)] {
                if !who.is_empty() && is_activity(notice.event, action) {
                    self.store.add_participant(repo_id, t, who)?;
                }
            }
        }

        let mut to: BTreeMap<String, (Reason, Option<FollowReason>)> = BTreeMap::new();
        let mut add = |who: String, reason: Reason, follow: Option<FollowReason>| {
            let e = to.entry(who).or_insert((reason, follow));
            if reason < e.0 {
                *e = (reason, follow.or(e.1));
            }
        };
        let release = notice.event == "release" && action == "published";
        for (who, follow) in self.store.followers(repo_id)? {
            if release {
                add(who, Reason::Release, Some(follow));
            } else if is_activity(notice.event, action) {
                add(who, Reason::Watching, Some(follow));
            }
        }
        if let Some(t) = &thread {
            if is_activity(notice.event, action) {
                for who in self.store.participants(repo_id, t)? {
                    add(who, Reason::Participating, None);
                }
            }
        }
        let body = body_of(event);
        if !body.is_empty() {
            let mentioned = self
                .mentions
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .mentioned(body);
            for who in mentioned {
                add(who, Reason::Mentioned, None);
            }
        }

        for (who, (reason, follow)) in to {
            if who == notice.actor {
                continue;
            }
            let Some(s) = self.store.subscriber(&who)? else {
                continue;
            };
            if !wants(&s, reason, follow) {
                continue;
            }
            let out = OutNotice {
                id: notice.id.clone(),
                repo_id: repo_id.to_string(),
                repo: notice.repo.clone(),
                title: notice.title.clone(),
                excerpt: notice.excerpt.clone(),
                url: notice.url.clone(),
                tag: format!("{repo_id}:{}", thread.as_deref().unwrap_or(notice.event)),
                reason,
            };
            self.dispatcher.deliver(&who, &out).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mentions_follow_the_web_rule() {
        let idx = MentionIndex::build([
            (
                "FrNpRnZQPP5gLFAjD7Foz4tZaML5DJ88CqaCvAkYNYjU",
                Some("alice"),
            ),
            (
                "8vF9No9XcZvENMA6NiNQ9KeeYi7sQBGLhWYUd2FVYuaz",
                Some("bob-7"),
            ),
        ]);
        let m = |t: &str| {
            let mut v: Vec<String> = idx.mentioned(t).into_iter().collect();
            v.sort();
            v
        };
        assert_eq!(
            m("hi @Alice, see this"),
            vec!["FrNpRnZQPP5gLFAjD7Foz4tZaML5DJ88CqaCvAkYNYjU"]
        );
        assert_eq!(
            m("@bob-7"),
            vec!["8vF9No9XcZvENMA6NiNQ9KeeYi7sQBGLhWYUd2FVYuaz"]
        );
        assert!(
            m("mail alice@alice.org").is_empty(),
            "an address is not a mention"
        );
        assert!(m("@alicex and @@alice and @bob-77").is_empty());
        assert_eq!(
            m("cc 8vF9No9XcZvENMA6NiNQ9KeeYi7sQBGLhWYUd2FVYuaz."),
            vec!["8vF9No9XcZvENMA6NiNQ9KeeYi7sQBGLhWYUd2FVYuaz"]
        );
    }

    #[test]
    fn activity_leaves_out_the_noise() {
        assert!(is_activity("issues", "opened"));
        assert!(is_activity("pull_request", "closed"));
        assert!(!is_activity("issues", "labeled"));
        assert!(!is_activity("push", ""));
        assert!(!is_activity("pull_request", "synchronize"));
    }
}
