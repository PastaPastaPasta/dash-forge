//! Delivery to one subscriber: instant mail and push, or the daily digest, inside the quotas.
//!
//! Each notice reaches an identity once ([`Store::mark_sent`]). Instant notices past the
//! subscriber's daily cap go into the digest instead; the global daily budget is the ceiling on
//! everything. A mail the SMTP server refuses for good counts as a failure, and three in a row
//! pause the address (the subscriber sees it in Settings and can confirm it again). A push
//! subscription the push service calls gone (404/410) is deleted.

use std::fmt::Write as _;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use forge_relay::sinks::send::SendError;

use crate::crypto::Vault;
use crate::error::Result;
use crate::mail::{Mail, Mailer};
use crate::push::{PushMessage, PushOutcome, PushTarget, Pusher};
use crate::store::{Delivery, Store, Subscriber};

/// Why a notice reached someone (strongest first).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    /// A review was requested from them.
    ReviewRequested,
    /// They were assigned.
    Assigned,
    /// They were @mentioned.
    Mentioned,
    /// They opened or commented on the thread.
    Participating,
    /// A release of a repo they follow.
    Release,
    /// Activity on a repo they watch, own or belong to.
    Watching,
    /// Activity in a private repo they belong to (metadata only).
    PrivateActivity,
}

impl Reason {
    /// "You are receiving this because …".
    pub fn because(self) -> &'static str {
        match self {
            Self::ReviewRequested => "your review was requested",
            Self::Assigned => "you were assigned",
            Self::Mentioned => "you were mentioned",
            Self::Participating => "you took part in this conversation",
            Self::Release => "you follow this repository's releases",
            Self::Watching => "you watch this repository, or own or belong to it",
            Self::PrivateActivity => {
                "you asked to hear about activity in private repositories you belong to"
            }
        }
    }
}

/// A notice for one subscriber.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutNotice {
    /// A stable id (the same activity never notifies twice).
    pub id: String,
    /// The repo id.
    pub repo_id: String,
    /// The repo as people read it.
    pub repo: String,
    /// One line.
    pub title: String,
    /// An excerpt (empty for private repos).
    pub excerpt: String,
    /// The forge-web page.
    pub url: String,
    /// A tag grouping notices of one thread (push replaces the older one).
    pub tag: String,
    /// Why.
    pub reason: Reason,
}

/// Sends notices.
pub struct Dispatcher {
    /// The store.
    pub store: Store,
    /// The data key.
    pub vault: Arc<Vault>,
    /// Email, when configured.
    pub mailer: Option<Arc<dyn Mailer>>,
    /// Web Push, when configured.
    pub pusher: Option<Arc<dyn Pusher>>,
    /// This service's public URL.
    pub public_url: String,
    /// The forge-web origin.
    pub web_url: String,
    /// The operator name.
    pub operator: String,
    /// The operator's contact, for footers.
    pub contact: Option<String>,
    /// Sends per subscriber per day.
    pub per_user_daily: u64,
    /// Sends per day in total.
    pub daily_budget: u64,
}

/// Mail failures in a row that pause an address.
pub const PAUSE_AFTER_FAILURES: u32 = 3;

impl Dispatcher {
    /// The one-click unsubscribe URL for a subscriber.
    pub fn unsubscribe_url(&self, s: &Subscriber) -> String {
        format!(
            "{}/u/{}",
            self.public_url,
            self.vault.unsubscribe_token(&s.identity, s.unsub_epoch)
        )
    }

    fn footer(&self, s: &Subscriber, why: &str) -> String {
        let mut f = format!(
            "-- \nYou are receiving this because {why}.\n\
             Manage notifications: {}/settings/notifications/\n\
             Stop all email from this service: {}\n\
             Notifications are hints from {} (forge-notify): open Forge to see what is on chain.\n",
            self.web_url,
            self.unsubscribe_url(s),
            self.operator,
        );
        if let Some(c) = &self.contact {
            let _ = writeln!(f, "Contact: {c}");
        }
        f
    }

    /// Deliver `n` to `identity` now, or queue it for the digest.
    pub async fn deliver(&self, identity: &str, n: &OutNotice) -> Result<()> {
        let Some(s) = self.store.subscriber(identity)? else {
            return Ok(());
        };
        if s.prefs.muted_repos.contains(&n.repo_id) {
            return Ok(());
        }
        if !self.store.mark_sent(identity, &n.id)? {
            return Ok(());
        }
        let digest = s.prefs.delivery == Delivery::Daily
            || !self
                .store
                .take_quota(&format!("user:{identity}"), self.per_user_daily)?;
        if digest {
            if s.mail_ok() && self.mailer.is_some() {
                let item = serde_json::to_string(n)
                    .map_err(|e| crate::error::NotifyError::Internal(e.to_string()))?;
                self.store.push_digest(identity, &item)?;
            }
            return Ok(());
        }
        if s.mail_ok() {
            if let Some(m) = &self.mailer {
                if self.store.take_quota("global", self.daily_budget)? {
                    self.mail_one(m.as_ref(), &s, n).await?;
                } else {
                    tracing::warn!("the daily send budget is used up; mail skipped");
                }
            }
        }
        if s.prefs.push {
            self.push_all(&s, n).await?;
        }
        Ok(())
    }

    async fn mail_one(&self, m: &dyn Mailer, s: &Subscriber, n: &OutNotice) -> Result<()> {
        let Some(sealed) = &s.email_sealed else {
            return Ok(());
        };
        let to = self
            .vault
            .open_string(&email_context(&s.identity), sealed)?;
        let mut text = format!("{}\n", n.title);
        if !n.excerpt.is_empty() {
            text.push('\n');
            for line in n.excerpt.lines() {
                text.push_str("> ");
                text.push_str(line);
                text.push('\n');
            }
        }
        let _ = write!(text, "\nOpen it: {}\n\n", n.url);
        text.push_str(&self.footer(s, n.reason.because()));
        let mail = Mail {
            to: to.to_string(),
            subject: format!("[{}] {}", n.repo, n.title),
            text,
            unsubscribe: Some(self.unsubscribe_url(s)),
        };
        self.send_mail(m, s, &mail).await
    }

    /// Send a mail, counting a permanent failure against the address.
    pub async fn send_mail(&self, m: &dyn Mailer, s: &Subscriber, mail: &Mail) -> Result<()> {
        match m.send(mail).await {
            Ok(()) => self.store.email_ok(&s.identity),
            Err(SendError::Permanent(why)) => {
                let paused = self.store.email_failed(&s.identity, PAUSE_AFTER_FAILURES)?;
                tracing::warn!(error = %why, paused, "mail refused");
                Ok(())
            }
            Err(e) => {
                // A transient failure loses this notice (it is a hint, and the next ones
                // follow); it does not count against the address.
                tracing::warn!(error = %e, "mail failed");
                Ok(())
            }
        }
    }

    async fn push_all(&self, s: &Subscriber, n: &OutNotice) -> Result<()> {
        let Some(p) = &self.pusher else {
            return Ok(());
        };
        let message = PushMessage {
            title: n.repo.clone(),
            body: n.title.clone(),
            url: n.url.clone(),
            tag: n.tag.clone(),
        };
        for row in self.store.pushes(&s.identity)? {
            if !self.store.take_quota("global", self.daily_budget)? {
                tracing::warn!("the daily send budget is used up; push skipped");
                return Ok(());
            }
            let plain = self.vault.open(&push_context(&s.identity), &row.sealed)?;
            let Ok(target) = serde_json::from_slice::<PushTarget>(&plain) else {
                continue;
            };
            match p.push(&target, &message).await {
                PushOutcome::Sent => {}
                PushOutcome::Gone => {
                    tracing::info!("a push subscription is gone; removed");
                    self.store.drop_push(row.id)?;
                }
                PushOutcome::Failed(why) => tracing::warn!(error = %why, "push failed"),
            }
        }
        Ok(())
    }

    /// Send every waiting digest (once a day).
    pub async fn send_digests(&self) -> Result<usize> {
        let Some(m) = &self.mailer else {
            return Ok(0);
        };
        let mut sent = 0;
        for identity in self.store.digest_identities()? {
            let items: Vec<OutNotice> = self
                .store
                .take_digest(&identity)?
                .iter()
                .filter_map(|i| serde_json::from_str(i).ok())
                .collect();
            let Some(s) = self.store.subscriber(&identity)? else {
                continue;
            };
            if items.is_empty()
                || !s.mail_ok()
                || !self.store.take_quota("global", self.daily_budget)?
            {
                continue;
            }
            let Some(sealed) = &s.email_sealed else {
                continue;
            };
            let to = self.vault.open_string(&email_context(&identity), sealed)?;
            let mut text = format!("{} notifications since the last digest.\n", items.len());
            let mut repo = String::new();
            for n in &items {
                if n.repo != repo {
                    repo.clone_from(&n.repo);
                    let _ = write!(text, "\n{repo}\n");
                }
                let _ = write!(text, "  - {}\n    {}\n", n.title, n.url);
            }
            text.push('\n');
            text.push_str(&self.footer(&s, "you chose a daily digest"));
            let mail = Mail {
                to: to.to_string(),
                subject: format!("Dash Forge: {} notifications", items.len()),
                text,
                unsubscribe: Some(self.unsubscribe_url(&s)),
            };
            self.send_mail(m.as_ref(), &s, &mail).await?;
            sent += 1;
        }
        Ok(sent)
    }
}

/// The associated data an address is sealed under.
pub fn email_context(identity: &str) -> String {
    format!("email:{identity}")
}

/// The associated data a push subscription is sealed under.
pub fn push_context(identity: &str) -> String {
    format!("push:{identity}")
}
