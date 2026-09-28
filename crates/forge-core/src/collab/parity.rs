//! The C-1 collaboration features (platform-parity-spec §1.2, §1.6, §6): watching a repo,
//! topics, milestones, and pinning / locking an issue or PR. A second `impl` of
//! [`super::v2::Collab`], so each stays next to its reads and folds.
//!
//! * `watch` (forge-collab, indexOnly): the signer's watched repos, on every device.
//! * `topic` (forge-core, maintainer-gated): a repo's tags, countable per name.
//! * `milestone` (forge-collab, maintainer- or writer-gated): newest definition per title;
//!   an issue or PR joins one by a member event (kind 17, the title as its value).
//! * pin / unpin / lock / unlock: member events, kinds 19–22 ([`fold_thread_meta_v2`]).

use std::collections::BTreeMap;

use super::v2::{Collab, Target, DOC_EVENT, DOC_MILESTONE, DOC_WATCH};
use crate::error::{Error, Result};
use crate::platform::{FieldValue, QueryFilter, QueryOrder};
use crate::rules::v2::Role;
use crate::rules::v2::{
    fold_milestones_v2, fold_thread_meta_v2, MilestoneDoc, MilestoneItem, ThreadMeta,
};
use crate::rules::EventKind;
use crate::scope::RepoRef;

/// forge-core: a repo's topic (maintainer-gated).
pub const DOC_TOPIC: &str = "topic";

/// A topic name: what the contract's pattern admits (`^[a-z0-9][a-z0-9-]{0,29}$`).
#[must_use]
pub fn is_valid_topic(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty()
        && b.len() <= 30
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// A milestone of a repo with its progress (the fold's [`crate::rules::v2::Milestone`]).
pub use crate::rules::v2::Milestone;

impl Collab<'_> {
    // --- watch -----------------------------------------------------------------------

    /// Whether the signer watches `repo`.
    pub async fn is_watching(&self, repo: &RepoRef) -> Result<bool> {
        let collab = self.collab_contract(repo).await?;
        Ok(self
            .own_index_only(&collab, repo, DOC_WATCH)
            .await?
            .is_some())
    }

    /// Watch `repo`. `false` when already watching (nothing written).
    pub async fn watch(&self, repo: &RepoRef) -> Result<bool> {
        let collab = self.collab_contract(repo).await?;
        self.create_own_index_only(&collab, repo, DOC_WATCH).await
    }

    /// Stop watching `repo` (the values-carrying indexOnly delete). `false` when not watching.
    pub async fn unwatch(&self, repo: &RepoRef) -> Result<bool> {
        let collab = self.collab_contract(repo).await?;
        self.delete_own_index_only(&collab, repo, DOC_WATCH).await
    }

    /// How many identities watch `repo` (the countable `byRepo` index).
    pub async fn watcher_count(&self, repo: &RepoRef) -> Result<u64> {
        let collab = self.collab_contract(repo).await?;
        self.client()
            .count_documents(&collab, DOC_WATCH, &[Self::repo_filter(repo)?])
            .await
    }

    // --- topics ----------------------------------------------------------------------

    /// `repo`'s topics (every maintainer's tags; unique per name), sorted.
    pub async fn topics(&self, repo: &RepoRef) -> Result<Vec<String>> {
        let core = self.core_contract(repo).await?;
        let docs = self
            .client()
            .query_all_documents(
                &core,
                DOC_TOPIC,
                &[Self::repo_filter(repo)?],
                &[QueryOrder::asc("repoId"), QueryOrder::asc("name")],
            )
            .await?;
        let mut names: Vec<String> = docs
            .iter()
            .filter_map(|d| d.field_str("name"))
            .filter(|n| is_valid_topic(n))
            .collect();
        names.sort();
        names.dedup();
        Ok(names)
    }

    /// Tag `repo` with `name` (maintainers). `false` when it already carries the topic.
    pub async fn add_topic(&self, repo: &RepoRef, name: &str) -> Result<bool> {
        if !is_valid_topic(name) {
            return Err(Error::Config(format!(
                "topic {name:?} must be 1-30 lowercase letters, digits and dashes, starting with a letter or digit"
            )));
        }
        if self.topics(repo).await?.iter().any(|t| t == name) {
            return Ok(false);
        }
        self.require_role(
            repo,
            Role::Maintainer,
            &format!("tag the repository {name}"),
        )
        .await?;
        let core = self.core_contract(repo).await?;
        let props = BTreeMap::from([("name".to_string(), FieldValue::text(name))]);
        match self.write(repo, &core, DOC_TOPIC, props).await {
            Ok(_) => Ok(true),
            // Another maintainer tagged it in between: the (repoId, name) index is unique.
            Err(Error::DuplicateUniqueIndex(_)) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Remove topic `name` from `repo`: deletes the signer's tag. A tag another maintainer
    /// wrote can only be deleted by them (Platform rule); the error says so.
    pub async fn remove_topic(&self, repo: &RepoRef, name: &str) -> Result<bool> {
        let me = self.signer_id()?;
        let core = self.core_contract(repo).await?;
        let docs = self
            .client()
            .query_documents(
                &core,
                DOC_TOPIC,
                &[
                    Self::repo_filter(repo)?,
                    QueryFilter::eq("name", FieldValue::text(name)),
                ],
                &[],
                1,
                None,
            )
            .await?;
        let Some(doc) = docs.into_iter().next() else {
            return Ok(false);
        };
        if doc.owner_id != me {
            return Err(Error::NotPermitted {
                action: format!("remove topic {name}"),
                reason: format!(
                    "maintainer {} tagged it, and only they can delete their tag",
                    doc.owner_id
                ),
                needs: "the tag's author".into(),
            });
        }
        self.engine()?
            .delete_document(&core, DOC_TOPIC, &doc.id)
            .await?;
        Ok(true)
    }

    /// How many repos carry topic `name` (`topic.byName`, countable over the name prefix).
    pub async fn topic_repo_count(&self, repo_for_contracts: &RepoRef, name: &str) -> Result<u64> {
        let core = self.core_contract(repo_for_contracts).await?;
        self.client()
            .count_documents(
                &core,
                DOC_TOPIC,
                &[QueryFilter::eq("name", FieldValue::text(name))],
            )
            .await
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
        super::check_len("milestone title", title, 63)?;
        super::check_len("milestone description", description, 1000)?;
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
        let collab = self.collab_contract(repo).await?;
        self.write(repo, &collab, DOC_MILESTONE, p).await
    }

    /// `repo`'s milestones with their open / closed counts. `items`: each issue or PR's open
    /// state and milestone (the caller folds them; a list page already has them).
    pub async fn milestones(
        &self,
        repo: &RepoRef,
        items: &[MilestoneItem],
    ) -> Result<Vec<Milestone>> {
        let collab = self.collab_contract(repo).await?;
        let docs = self
            .client()
            .query_all_documents(
                &collab,
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
        match title {
            Some(t) => {
                self.post_event(repo, target, EventKind::MilestoneSet, Some(t), None)
                    .await
            }
            None => {
                self.post_event(repo, target, EventKind::MilestoneClear, None, None)
                    .await
            }
        }
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

    /// Lock or unlock `target`'s conversation. Members only. A locked thread's composer is
    /// offered to members only; consensus cannot stop a non-member's comment (fees are the
    /// only floor), and readers show such a comment as posted after the lock.
    pub async fn set_locked(
        &self,
        repo: &RepoRef,
        target: &Target,
        locked: bool,
    ) -> Result<String> {
        let kind = if locked {
            EventKind::Lock
        } else {
            EventKind::Unlock
        };
        self.post_event(repo, target, kind, None, None).await
    }

    /// `target`'s milestone, pin and lock (the member events, folded).
    pub async fn thread_meta(&self, repo: &RepoRef, target_id: &str) -> Result<ThreadMeta> {
        let log = self.target_log(repo, target_id).await?;
        Ok(fold_thread_meta_v2(&log.events))
    }

    /// The repo's member events of `kinds` (its `feed`), for the pinned list.
    pub async fn feed_events(&self, repo: &RepoRef) -> Result<Vec<crate::rules::Event>> {
        let collab = self.collab_contract(repo).await?;
        let docs = self
            .client()
            .query_all_documents(
                &collab,
                DOC_EVENT,
                &[Self::repo_filter(repo)?],
                &[QueryOrder::asc("repoId"), QueryOrder::asc("$createdAt")],
            )
            .await?;
        Ok(docs.iter().filter_map(super::v2::event_from_doc).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::is_valid_topic;

    #[test]
    fn topic_names_follow_the_contract_pattern() {
        for ok in ["rust", "git", "c", "0x", "a-b-c", &"a".repeat(30)] {
            assert!(is_valid_topic(ok), "{ok}");
        }
        for bad in [
            "",
            "Rust",
            "-rust",
            "rust_cli",
            "rust cli",
            &"a".repeat(31),
            "é",
        ] {
            assert!(!is_valid_topic(bad), "{bad}");
        }
    }
}
