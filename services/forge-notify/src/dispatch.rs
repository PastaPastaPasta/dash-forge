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
        // A daily digest, and the notices past the daily cap, need a working address. Without
        // one (a push-only subscriber) they go as pushes now, within the daily budget, rather
        // than into a digest that is never sent.
        let digest = s.mail_ok()
            && self.mailer.is_some()
            && (s.prefs.delivery == Delivery::Daily
                || !self
                    .store
                    .take_quota(&format!("user:{identity}"), self.per_user_daily)?);
        if digest {
            let item = serde_json::to_string(n)
                .map_err(|e| crate::error::NotifyError::Internal(e.to_string()))?;
            self.store.push_digest(identity, &item)?;
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
        self.send_mail(m, s, &mail).await.map(drop)
    }

    /// Send a mail, counting a permanent failure against the address. Whether it was sent.
    pub async fn send_mail(&self, m: &dyn Mailer, s: &Subscriber, mail: &Mail) -> Result<bool> {
        match m.send(mail).await {
            Ok(()) => self.store.email_ok(&s.identity).map(|()| true),
            Err(SendError::Permanent(why)) => {
                let paused = self.store.email_failed(&s.identity, PAUSE_AFTER_FAILURES)?;
                tracing::warn!(error = %why, paused, "mail refused");
                Ok(false)
            }
            Err(e) => {
                // A transient failure loses an instant notice (it is a hint, and the next ones
                // follow); it does not count against the address.
                tracing::warn!(error = %e, "mail failed");
                Ok(false)
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
            let (raw, upto) = self.store.digest(&identity)?;
            let items: Vec<OutNotice> = raw
                .iter()
                .filter_map(|i| serde_json::from_str(i).ok())
                .collect();
            let Some(s) = self.store.subscriber(&identity)? else {
                self.store.drop_digest(&identity, upto)?;
                continue;
            };
            if items.is_empty() {
                self.store.drop_digest(&identity, upto)?;
                continue;
            }
            // A digest that cannot go now (mail paused or off, the day's budget spent, a failed
            // send) keeps its items for the next one; the daily purge drops them after 7 days.
            let Some(sealed) = s.email_sealed.as_ref().filter(|_| s.mail_ok()) else {
                continue;
            };
            if !self.store.take_quota("global", self.daily_budget)? {
                tracing::warn!("the daily send budget is used up; digest kept for tomorrow");
                continue;
            }
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
            if self.send_mail(m.as_ref(), &s, &mail).await? {
                self.store.drop_digest(&identity, upto)?;
                sent += 1;
            }
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

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;
    use crate::mail::{CaptureMailer, SendFuture};
    use crate::push::CapturePusher;
    use crate::store::{Pending, Prefs};

    const ID: &str = "FrNpRnZQPP5gLFAjD7Foz4tZaML5DJ88CqaCvAkYNYjU";

    /// Fails (temporarily) while `down` is set, else captures.
    #[derive(Default)]
    struct FlakyMailer {
        down: AtomicBool,
        inner: CaptureMailer,
    }

    impl Mailer for FlakyMailer {
        fn send<'a>(&'a self, mail: &'a Mail) -> SendFuture<'a> {
            if self.down.load(Ordering::SeqCst) {
                return Box::pin(async {
                    Err(SendError::Retry {
                        after: None,
                        why: "down".into(),
                    })
                });
            }
            self.inner.send(mail)
        }
    }

    fn dispatcher(mailer: Option<Arc<dyn Mailer>>, pusher: Arc<CapturePusher>) -> Dispatcher {
        Dispatcher {
            store: Store::memory().unwrap(),
            vault: Arc::new(Vault::new(&[3; 32])),
            mailer,
            pusher: Some(pusher),
            public_url: "https://notify.test".into(),
            web_url: "https://forge.test".into(),
            operator: "notify.test".into(),
            contact: None,
            per_user_daily: 1,
            daily_budget: 100,
        }
    }

    fn subscribe(d: &Dispatcher, email: Option<&str>, delivery: Delivery) {
        d.store.ensure_subscriber(ID).unwrap();
        d.store
            .set_prefs(
                ID,
                &Prefs {
                    delivery,
                    ..Prefs::default()
                },
            )
            .unwrap();
        if let Some(email) = email {
            d.store
                .add_pending(
                    "tok",
                    &Pending {
                        identity: ID.into(),
                        email_sealed: d.vault.seal(&email_context(ID), email.as_bytes()).unwrap(),
                        email_idx: d.vault.email_index(email),
                        expires_at: crate::store::now_ms() + 60_000,
                    },
                )
                .unwrap();
            d.store.confirm_pending("tok").unwrap().unwrap();
        }
        let target = PushTarget {
            endpoint: "https://fcm.googleapis.com/x".into(),
            p256dh: String::new(),
            auth: String::new(),
        };
        let plain = serde_json::to_vec(&target).unwrap();
        d.store
            .add_push(
                ID,
                "h",
                &d.vault.seal(&push_context(ID), &plain).unwrap(),
                None,
            )
            .unwrap();
    }

    fn notice(id: &str) -> OutNotice {
        OutNotice {
            id: id.into(),
            repo_id: "R".into(),
            repo: "alice/x".into(),
            title: format!("notice {id}"),
            excerpt: String::new(),
            url: "https://forge.test/x".into(),
            tag: "t".into(),
            reason: Reason::Watching,
        }
    }

    #[tokio::test]
    async fn a_digest_that_fails_to_go_keeps_its_items() {
        let mailer = Arc::new(FlakyMailer::default());
        let d = dispatcher(
            Some(Arc::clone(&mailer) as Arc<dyn Mailer>),
            Arc::default(),
        );
        subscribe(&d, Some("a@example.org"), Delivery::Daily);
        d.deliver(ID, &notice("1")).await.unwrap();
        d.deliver(ID, &notice("2")).await.unwrap();

        mailer.down.store(true, Ordering::SeqCst);
        assert_eq!(d.send_digests().await.unwrap(), 0);
        assert_eq!(d.store.digest(ID).unwrap().0.len(), 2);

        mailer.down.store(false, Ordering::SeqCst);
        assert_eq!(d.send_digests().await.unwrap(), 1);
        assert!(d.store.digest(ID).unwrap().0.is_empty());
        let sent = mailer.inner.sent.lock().unwrap();
        assert!(sent[0].text.contains("notice 1") && sent[0].text.contains("notice 2"));
    }

    #[tokio::test]
    async fn a_push_only_subscriber_gets_daily_and_over_cap_notices_as_pushes() {
        let pusher = Arc::new(CapturePusher::default());
        let mailer: Arc<dyn Mailer> = Arc::new(CaptureMailer::default());
        let d = dispatcher(Some(mailer), Arc::clone(&pusher));
        subscribe(&d, None, Delivery::Daily);
        d.deliver(ID, &notice("1")).await.unwrap();
        d.deliver(ID, &notice("2")).await.unwrap(); // past the cap of 1
        assert_eq!(pusher.sent.lock().unwrap().len(), 2);
        assert!(d.store.digest(ID).unwrap().0.is_empty());
    }
}
