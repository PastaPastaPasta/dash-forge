//! The C-1 collaboration features (platform-parity-spec §1.2, §1.6, §6): watching a repo,
//! topics, milestones, and pinning / locking an issue or PR. A second `impl` of
//! [`super::v2::Collab`], so each stays next to its reads and folds.
//!
//! * `watch` (forge-community, indexOnly): the signer's watched repos, on every device.
//! * `topic` (forge-core, owner-granted, public repos only, at most 20): a repo's tags,
//!   countable per name.
//! * `milestone` (forge-community, maintainer- or writer-gated): newest definition per title;
//!   an issue or PR joins one by a member event (kind 17, the title as its value).
//! * pin / unpin: member events, kinds 19–20 ([`crate::rules::v2::fold_thread_meta_v2`]).
//! * lock / unlock: `transition`s (kinds 3/4 on an issue, 18/19 on a PR, `delta` ±16).
//!   The event kinds 21–22 are retired (`noState`).

use std::collections::BTreeMap;

use super::v2::{Collab, Target, DOC_MILESTONE, DOC_WATCH};
use crate::error::{Error, Result};
use crate::platform::{FieldValue, QueryOrder};
use crate::rules::v2::Role;
use crate::rules::v2::StateAction;
use crate::rules::v2::{fold_milestones_v2, MilestoneDoc, MilestoneItem};
use crate::rules::EventKind;
use crate::scope::RepoRef;

/// forge-core: a repo's topic (owner-granted).
pub const DOC_TOPIC: &str = "topic";

/// A milestone of a repo with its progress (the fold's [`crate::rules::v2::Milestone`]).
pub use crate::rules::v2::Milestone;

impl Collab<'_> {
    // --- watch -----------------------------------------------------------------------

    /// Watch `repo`. `false` when already watching (nothing written).
    pub async fn watch(&self, repo: &RepoRef) -> Result<bool> {
        let community = self.community_contract(repo).await?;
        self.create_own_index_only(&community, repo, DOC_WATCH, BTreeMap::new())
            .await
    }

    /// Stop watching `repo` (the values-carrying indexOnly delete). `false` when not watching.
    pub async fn unwatch(&self, repo: &RepoRef) -> Result<bool> {
        let community = self.community_contract(repo).await?;
        self.delete_own_index_only(&community, repo, DOC_WATCH)
            .await
    }

    /// How many identities watch `repo` (the countable `byRepo` index).
    pub async fn watcher_count(&self, repo: &RepoRef) -> Result<u64> {
        let community = self.community_contract(repo).await?;
        self.client()
            .count_documents(&community, DOC_WATCH, &[Self::repo_filter(repo)?])
            .await
    }

    // --- topics ----------------------------------------------------------------------
    //
    // Two records, both the owner's: `repo.topics` (what repo pages show, and what every client
    // edits) is authoritative; the `topic` documents (what Explore counts per topic) follow it.

    /// `repo`'s topics: the `repo` document's `topics`, as stored.
    pub async fn topics(&self, repo: &RepoRef) -> Result<Vec<String>> {
        let core = self.core_contract(repo).await?;
        let doc = self
            .client()
            .fetch_document(&core, "repo", repo.id())
            .await?
            .ok_or(Error::NotFound)?;
        Ok(doc
            .fields
            .get("topics")
            .and_then(FieldValue::as_text_list)
            .unwrap_or_default())
    }

    /// Set `repo`'s topics to `names` (its owner only): replace `repo.topics`, then bring the
    /// `topic` documents in line ([`Self::reconcile_topic_docs`]). Refused before signing when
    /// the list breaks the schema (at most [`crate::repo::MAX_TOPICS`], unique, the pattern).
    /// `false` when nothing changed.
    pub async fn set_topics(&self, repo: &RepoRef, names: &[String]) -> Result<bool> {
        self.require_owner(repo, "change the repository's topics")?;
        crate::repo::RepoEdit {
            description: None,
            topics: Some(names.to_vec()),
        }
        .validate()?;
        let core = self.core_contract(repo).await?;
        let changes = BTreeMap::from([(
            "topics".to_string(),
            (!names.is_empty()).then(|| FieldValue::text_list(names.to_vec())),
        )]);
        let replaced = self
            .engine()?
            .replace_document(&core, "repo", repo.id(), &changes)
            .await?;
        let reconciled = self.reconcile_topic_docs(repo, names).await?;
        Ok(replaced || reconciled)
    }

    /// Create the `topic` documents `names` lacks and delete the ones it no longer holds (its
    /// owner only; idempotent). What `dg repo edit --topics` and the web's Settings save run
    /// after replacing `repo.topics`, so Explore's per-topic counts follow the repo page.
    /// Deletes come first, so a swap never passes the 20-document cap (`atMost20`). A private
    /// repository has none (`topic.vis` is `"public"` only, proved against the repo): its
    /// topics live in `repo.topics` alone. `false` when they already matched.
    pub async fn reconcile_topic_docs(&self, repo: &RepoRef, names: &[String]) -> Result<bool> {
        self.require_owner(repo, "change the repository's topics")?;
        if repo.visibility == crate::rules::v2::Visibility::Private {
            return Ok(false);
        }
        if let Some(bad) = names.iter().find(|n| !crate::repo::is_topic_name(n)) {
            return Err(Error::Config(format!(
                "topic {bad:?}: use 1-30 of a-z and 0-9, words joined by single '-'"
            )));
        }
        let core = self.core_contract(repo).await?;
        let held: BTreeMap<String, String> = self
            .client()
            .query_all_documents(
                &core,
                DOC_TOPIC,
                &[Self::repo_filter(repo)?],
                &[QueryOrder::asc("repoId"), QueryOrder::asc("name")],
            )
            .await?
            .into_iter()
            .filter_map(|d| d.field_str("name").map(|n| (n, d.id)))
            .collect();
        let mut changed = false;
        let engine = self.engine()?;
        for (name, id) in &held {
            if !names.contains(name) {
                engine.delete_document(&core, DOC_TOPIC, id).await?;
                changed = true;
            }
        }
        for name in names.iter().filter(|n| !held.contains_key(*n)) {
            // `vis: "public"` is stamped by the write
            let props = BTreeMap::from([("name".to_string(), FieldValue::text(name))]);
            match self.write(repo, &core, DOC_TOPIC, props).await {
                Ok(_) => changed = true,
                // Tagged in between (another device): the (repoId, name) index is unique.
                Err(Error::DuplicateUniqueIndex(_)) => {}
                Err(e) => return Err(e),
            }
        }
        Ok(changed)
    }

    /// Refuse before signing unless the signer owns `repo` (the owner-granted types).
    fn require_owner(&self, repo: &RepoRef, action: &str) -> Result<()> {
        if self.signer_id()? == repo.owner_id() {
            return Ok(());
        }
        Err(Error::NotPermitted {
            action: action.to_string(),
            reason: format!("only the owner of {} can change its topics", repo.display()),
            needs: "the repository's owner".into(),
        })
    }

    // --- milestones --------------------------------------------------------------------

    /// Define (or redefine: the newest per title wins) milestone `title` of `repo`.
    pub async fn define_milestone(
        &self,
        repo: &RepoRef,
        title: &str,
        description: &str,
        due_on: Option<u64>,
        closed: bool,
    ) -> Result<String> {
        let title = title.trim();
        if title.is_empty() {
            return Err(Error::Config("a milestone needs a title".into()));
        }
        super::check_text("milestone title", title, 63, 252)?;
        super::check_text("milestone description", description, 1000, 2000)?;
        if repo.visibility == crate::rules::v2::Visibility::Private {
            return Err(Error::Config(
                "milestones in a private repository are sealed; this build does not seal them yet (use the web app)".into(),
            ));
        }
        let mut p = BTreeMap::from([("title".to_string(), FieldValue::text(title))]);
        if !description.is_empty() {
            p.insert("description".to_string(), FieldValue::text(description));
        }
        if let Some(due) = due_on {
            p.insert("dueOn".to_string(), FieldValue::integer(due));
        }
        p.insert("closed".to_string(), FieldValue::boolean(closed));
        self.require_role(repo, Role::Writer, &format!("define milestone {title}"))
            .await?;
        let community = self.community_contract(repo).await?;
        self.write(repo, &community, DOC_MILESTONE, p).await
    }

    /// `repo`'s milestones with their open / closed counts. `items`: each issue or PR's open
    /// state and milestone (the caller folds them; a list page already has them).
    pub async fn milestones(
        &self,
        repo: &RepoRef,
        items: &[MilestoneItem],
    ) -> Result<Vec<Milestone>> {
        let community = self.community_contract(repo).await?;
        let docs = self
            .client()
            .query_all_documents(
                &community,
                DOC_MILESTONE,
                &[Self::repo_filter(repo)?],
                &[
                    QueryOrder::asc("repoId"),
                    QueryOrder::asc("title"),
                    QueryOrder::asc("$createdAt"),
                ],
            )
            .await?;
        let docs: Vec<MilestoneDoc> = docs
            .iter()
            .map(|d| MilestoneDoc {
                id: d.id.clone(),
                title: d.field_str("title").unwrap_or_default(),
                description: d.field_str("description"),
                due_on: d.field_u64("dueOn"),
                closed: d.field_bool("closed"),
                created_at: d.created_at.unwrap_or(0),
            })
            .collect();
        Ok(fold_milestones_v2(&docs, items))
    }

    /// Put `target` in milestone `title` (`None`: take it out). Members only.
    pub async fn set_milestone(
        &self,
        repo: &RepoRef,
        target: &Target,
        title: Option<&str>,
    ) -> Result<String> {
        let kind = if title.is_some() {
            EventKind::MilestoneSet
        } else {
            EventKind::MilestoneClear
        };
        self.post_event(repo, target, kind, title, None).await
    }

    // --- pin / lock --------------------------------------------------------------------

    /// Pin or unpin `target` on the repo's lists. Members only.
    pub async fn set_pinned(
        &self,
        repo: &RepoRef,
        target: &Target,
        pinned: bool,
    ) -> Result<String> {
        let kind = if pinned {
            EventKind::Pin
        } else {
            EventKind::Unpin
        };
        self.post_event(repo, target, kind, None, None).await
    }

    /// Lock or unlock `target`'s conversation: a `transition` (kinds 3/4 on an issue, 18/19 on
    /// a PR, `delta` ±16). Members only (`g_memberLock`). On a locked conversation consensus
    /// admits a new comment or review only with `asMember` (`lockGate`), so only members post.
    /// Returns the transition's id.
    pub async fn set_locked(
        &self,
        repo: &RepoRef,
        target: &Target,
        locked: bool,
    ) -> Result<String> {
        let action = if locked {
            StateAction::Lock
        } else {
            StateAction::Unlock
        };
        Ok(self
            .set_state(repo, target, action, None)
            .await?
            .transition_id)
    }
}
