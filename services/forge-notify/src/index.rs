//! The background work besides the relay's repo polling:
//!
//! * [`Indexer::refresh_all`] (every `FORGE_NOTIFY_INDEX_SECS`, and for one subscriber right
//!   after they sign up): each active subscriber's followed repositories (watched, owned,
//!   member), capped per subscriber and in total; their DPNS label for mentions; and the watch
//!   feed the embedded relay polls (followed public repos and the repos of threads they take
//!   part in).
//! * [`Indexer::poll_addressed`] (every `FORGE_NOTIFY_ADDRESSED_SECS`): review requests and
//!   assignments addressed to each subscriber, in any repository, past a stored cursor. In a
//!   private repository the notice names the repository and the thread number only.
//! * [`Indexer::poll_private`] (every 5 minutes): for subscribers who asked, "new activity in a
//!   private repository you belong to", from public metadata (a document's type, repo and
//!   time); never a title or text, and never for their own writes.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use tokio::sync::watch;

use crate::chain::{Chain, RepoInfo, KIND_ASSIGN, KIND_REVIEW_REQUEST};
use crate::config::Limits;
use crate::dispatch::{Dispatcher, OutNotice, Reason};
use crate::error::Result;
use crate::route::MentionIndex;
use crate::store::{now_ms, Follow, FollowReason, Store, Subscriber};

/// How long a repository's name and visibility are cached.
const REPO_TTL: Duration = Duration::from_secs(3600);

/// Builds the follow index and runs the pollers.
pub struct Indexer {
    /// The store.
    pub store: Store,
    /// Platform reads.
    pub chain: Arc<dyn Chain>,
    /// Delivery.
    pub dispatcher: Arc<Dispatcher>,
    /// The relay's watch feed.
    pub feed: watch::Sender<BTreeSet<String>>,
    /// Mentions.
    pub mentions: Arc<RwLock<MentionIndex>>,
    /// Caps.
    pub limits: Limits,
    /// The forge-web origin, for links.
    pub web_url: String,
    repos: Mutex<HashMap<String, (Option<RepoInfo>, Instant)>>,
}

fn repo_url(web: &str, r: &RepoInfo) -> String {
    format!("{web}/repo/?owner={}&name={}", r.owner, r.name)
}

fn short(id: &str) -> String {
    forge_relay::sinks::render::short_id(id)
}

impl Indexer {
    /// An indexer.
    pub fn new(
        store: Store,
        chain: Arc<dyn Chain>,
        dispatcher: Arc<Dispatcher>,
        feed: watch::Sender<BTreeSet<String>>,
        mentions: Arc<RwLock<MentionIndex>>,
        limits: Limits,
        web_url: String,
    ) -> Self {
        Self {
            store,
            chain,
            dispatcher,
            feed,
            mentions,
            limits,
            web_url,
            repos: Mutex::new(HashMap::new()),
        }
    }

    /// A repository's name and visibility (cached).
    pub async fn repo(&self, id: &str) -> Result<Option<RepoInfo>> {
        if let Some((r, at)) = self
            .repos
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(id)
        {
            if at.elapsed() < REPO_TTL {
                return Ok(r.clone());
            }
        }
        let r = self.chain.repo(id).await?;
        let mut cache = self
            .repos
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if cache.len() > 20_000 {
            cache.clear();
        }
        cache.insert(id.to_string(), (r.clone(), Instant::now()));
        Ok(r)
    }

    fn display(r: &RepoInfo) -> String {
        format!("{}/{}", short(&r.owner), r.name)
    }

    /// Rebuild one subscriber's follows and label.
    pub async fn refresh_one(&self, s: &Subscriber) -> Result<()> {
        let mut follows: Vec<Follow> = Vec::new();
        let mut seen = BTreeSet::new();
        let member = self.chain.member_repos(&s.identity).await?;
        let watched = self.chain.watched(&s.identity).await?;
        let wanted = member
            .into_iter()
            .map(|r| (r, FollowReason::Member))
            .chain(watched.into_iter().map(|r| (r, FollowReason::Watch)));
        for (repo_id, reason) in wanted {
            if follows.len() >= self.limits.max_repos_per_user {
                tracing::info!(
                    cap = self.limits.max_repos_per_user,
                    "a subscriber follows more repositories than the cap; the rest are skipped"
                );
                break;
            }
            if !seen.insert(repo_id.clone()) {
                continue;
            }
            let Some(info) = self.repo(&repo_id).await? else {
                continue;
            };
            follows.push(Follow {
                repo_id,
                reason,
                private: info.private,
            });
        }
        self.store.set_follows(&s.identity, &follows)?;
        let label = self.chain.dpns_label(&s.identity).await.unwrap_or(None);
        if label != s.name {
            self.store.set_name(&s.identity, label.as_deref())?;
        }
        Ok(())
    }

    /// Rebuild every active subscriber's follows, then the mention index and the watch feed.
    pub async fn refresh_all(&self) -> Result<()> {
        let subs = self.store.active_subscribers()?;
        for s in &subs {
            if let Err(e) = self.refresh_one(s).await {
                tracing::warn!(error = %e, "refreshing a subscriber's repositories failed; keeping the last set");
            }
        }
        self.rebuild_feed()
    }

    /// The mention index and the relay's watch feed, from the store.
    pub fn rebuild_feed(&self) -> Result<()> {
        let subs = self.store.active_subscribers()?;
        *self
            .mentions
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = MentionIndex::build(
            subs.iter()
                .map(|s| (s.identity.as_str(), s.name.as_deref())),
        );
        let mut repos = self.store.followed_public_repos(self.limits.max_repos)?;
        for s in &subs {
            for r in self.store.participating_repos(&s.identity)? {
                if repos.len() >= self.limits.max_repos {
                    break;
                }
                repos.insert(r);
            }
        }
        let n = repos.len();
        self.feed.send_if_modified(|cur| {
            if *cur == repos {
                false
            } else {
                *cur = repos;
                true
            }
        });
        tracing::info!(subscribers = subs.len(), repos = n, "follow index rebuilt");
        Ok(())
    }

    /// Poll review requests and assignments for every active subscriber.
    pub async fn poll_addressed(&self) -> Result<()> {
        for s in self.store.active_subscribers()? {
            if !(s.prefs.review_requested || s.prefs.assigned) {
                continue;
            }
            if let Err(e) = self.poll_addressed_one(&s).await {
                tracing::warn!(error = %e, "reading addressed events failed; retrying next cycle");
            }
        }
        Ok(())
    }

    async fn poll_addressed_one(&self, s: &Subscriber) -> Result<()> {
        let key = format!("addr:{}", s.identity);
        // The first poll starts now: no backlog of old requests for a new subscriber.
        let Some(since) = self.store.cursor(&key)? else {
            self.store.set_cursor(&key, now_ms())?;
            return Ok(());
        };
        let found = self.chain.addressed(&s.identity, since).await?;
        let mut cursor = since;
        for a in found {
            cursor = cursor.max(a.created_at);
            let reason = match a.kind {
                KIND_ASSIGN => Reason::Assigned,
                KIND_REVIEW_REQUEST => Reason::ReviewRequested,
                _ => continue,
            };
            if a.author == s.identity {
                continue;
            }
            let (Some(repo), Some(target)) = (
                self.repo(&a.repo_id).await?,
                self.chain.target(&a.target_id).await?,
            ) else {
                continue;
            };
            let what = if target.is_pr {
                "pull request"
            } else {
                "issue"
            };
            let verb = if reason == Reason::Assigned {
                format!("assigned you to {what} #{}", target.number)
            } else {
                format!("requested your review on {what} #{}", target.number)
            };
            let who = short(&a.author);
            let title = match (&target.title, repo.private) {
                (Some(t), false) => format!(
                    "{who} {verb}: {}",
                    forge_relay::sinks::render::clean_line(t, 150)
                ),
                _ => format!("{who} {verb}"),
            };
            let kind = if target.is_pr { "pull" } else { "issue" };
            let n = OutNotice {
                id: format!("addressed:{}", a.doc_id),
                repo_id: repo.id.clone(),
                repo: Self::display(&repo),
                title,
                excerpt: String::new(),
                url: format!(
                    "{}/repo/{kind}/?owner={}&name={}&number={}",
                    self.web_url, repo.owner, repo.name, target.number
                ),
                tag: format!(
                    "{}:{}:{}",
                    repo.id,
                    if target.is_pr { "pr" } else { "issue" },
                    target.number
                ),
                reason,
            };
            if crate::route::wants(s, reason, None) {
                self.dispatcher.deliver(&s.identity, &n).await?;
            }
        }
        self.store.set_cursor(&key, cursor)?;
        Ok(())
    }

    /// Poll the private repositories followed by subscribers who asked for activity notices.
    pub async fn poll_private(&self) -> Result<()> {
        let repos: BTreeMap<String, Vec<String>> = self.store.followed_private_repos()?;
        for (repo_id, followers) in repos {
            let mut wanting = Vec::new();
            for who in followers {
                if let Some(s) = self.store.subscriber(&who)? {
                    if s.prefs.private_activity {
                        wanting.push(s);
                    }
                }
            }
            if wanting.is_empty() {
                continue;
            }
            let key = format!("priv:{repo_id}");
            let Some((latest, writer)) = self.chain.latest_activity(&repo_id).await? else {
                continue;
            };
            let prev = self.store.cursor(&key)?;
            self.store.set_cursor(&key, latest)?;
            let Some(prev) = prev else {
                continue;
            };
            if latest <= prev {
                continue;
            }
            let Some(repo) = self.repo(&repo_id).await? else {
                continue;
            };
            let n = OutNotice {
                id: format!("private:{repo_id}:{latest}"),
                repo_id: repo_id.clone(),
                repo: Self::display(&repo),
                title: "New activity in a private repository you belong to. Open Forge to read it."
                    .into(),
                excerpt: String::new(),
                url: repo_url(&self.web_url, &repo),
                tag: format!("{repo_id}:private"),
                reason: Reason::PrivateActivity,
            };
            for s in wanting {
                if s.identity != writer {
                    self.dispatcher.deliver(&s.identity, &n).await?;
                }
            }
        }
        Ok(())
    }
}
