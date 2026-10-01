//! Maintainer moderation (RC2 MOD, `docs/contracts/forge-v2.md` §3.2): hide and unhide a
//! comment, a review or a whole issue or PR. A third `impl` of [`super::v2::Collab`].
//!
//! A hide is an immutable member `event` (kind 24; 25 unhides) that names the item in `refId`
//! (none: the thread) and an optional reason in `value` (sealed in a private repo, like every
//! event value). Where forge-community has `event.asMaintainer` (the `event_as_maintainer` build
//! flag) the event names the writer's own maintainer document, and consensus refuses it from
//! anyone else; elsewhere consensus admits any member's event and readers count only the owner's
//! and current maintainers' ([`crate::rules::v2::hidden_items`]). Nothing is deleted: Platform v5
//! cannot scope a delete of someone else's document to one repo.

use std::collections::BTreeSet;

use super::v2::{event_payload_props, Collab, Comment, EventPayload, Review, Target, TargetLog};
use super::v2::{TargetKind, DOC_EVENT};
use crate::error::{Error, Result};
use crate::members::MemberReader;
use crate::platform::{self, FieldValue};
use crate::rules::v2::{hidden_items, HiddenItems, HideScope, Role, ThreadItem};
use crate::rules::EventKind;
use crate::scope::RepoRef;

/// forge-community `event.asMaintainer` (RC2 MOD): the writer's maintainer document, proved.
pub const EVENT_AS_MAINTAINER: &str = "asMaintainer";

/// The comments and reviews of a thread as [`hidden_items`] reads them.
#[must_use]
pub fn thread_items(
    comments: &[Comment],
    reviews: &[Review],
) -> (Vec<ThreadItem>, Vec<ThreadItem>) {
    let comments = comments
        .iter()
        .map(|c| ThreadItem {
            id: c.document_id.clone(),
            author: c.author.clone(),
            review_id: c.review_id.clone(),
        })
        .collect();
    let reviews = reviews
        .iter()
        .map(|r| ThreadItem {
            id: r.document_id.clone(),
            author: r.reviewer.clone(),
            review_id: None,
        })
        .collect();
    (comments, reviews)
}

impl Collab<'_> {
    /// Whether `repo`'s forge-community proves a hide's maintainer (`event.asMaintainer`): then
    /// every hide counts, also after its writer stops being a maintainer.
    pub async fn hides_proved(&self, repo: &RepoRef) -> Result<bool> {
        Ok(self
            .community_contract(repo)
            .await?
            .has_property(DOC_EVENT, EVENT_AS_MAINTAINER))
    }

    /// Hide (`hidden`) or unhide comment or review `item` of `target`, or with `item` `None` the
    /// whole issue or PR, giving `reason` (one of [`crate::rules::v2::HIDE_REASONS`]; hides only).
    /// Maintainers only: refused before signing for anyone else, and for an `item` that is no
    /// comment (or, on a PR, review) of `target`, which readers would ignore. Returns the
    /// event's id.
    pub async fn set_hidden(
        &self,
        repo: &RepoRef,
        target: &Target,
        item: Option<&str>,
        reason: Option<&str>,
        hidden: bool,
    ) -> Result<String> {
        let kind = if hidden {
            EventKind::Hide
        } else {
            EventKind::Unhide
        };
        let mut props = event_payload_props(
            target,
            kind,
            &EventPayload {
                value: if hidden { reason } else { None },
                oid: None,
                ref_id: item,
            },
        )?;
        let what = item.map_or_else(
            || format!("{} #{}", target.kind.noun(), target.number),
            |_| format!("content on {} #{}", target.kind.noun(), target.number),
        );
        let verb = if hidden { "hide" } else { "unhide" };
        self.require_role(repo, Role::Maintainer, &format!("{verb} {what}"))
            .await?;
        if let Some(id) = item {
            self.require_thread_item(repo, target, id).await?;
        }
        let community = self.community_contract(repo).await?;
        if community.has_property(DOC_EVENT, EVENT_AS_MAINTAINER) {
            props.insert(
                EVENT_AS_MAINTAINER.to_string(),
                FieldValue::identifier(platform::decode_identifier(&self.signer_id()?)?),
            );
        }
        self.write(repo, &community, DOC_EVENT, props).await
    }

    /// Refuse an `id` that is no comment of `target` (or, on a PR, review): consensus never
    /// checks a hide's `refId`, and readers ignore one from another thread.
    async fn require_thread_item(&self, repo: &RepoRef, target: &Target, id: &str) -> Result<()> {
        let comments = self.comments(repo, &target.id).await?;
        if comments.iter().any(|c| c.document_id == id) {
            return Ok(());
        }
        if target.kind == TargetKind::Patch
            && self
                .reviews(repo, &target.id)
                .await?
                .iter()
                .any(|r| r.document_id == id)
        {
            return Ok(());
        }
        let what = if target.kind == TargetKind::Patch {
            "comment or review"
        } else {
            "comment"
        };
        Err(Error::Config(format!(
            "{id} is no {what} of {} #{} that you can read",
            target.kind.noun(),
            target.number
        )))
    }

    /// What a reader collapses in `target` ([`hidden_items`]), from its log, comments and reviews
    /// as already read. Without the contract's proof it reads the repo's maintainers now.
    pub async fn hidden_items(
        &self,
        repo: &RepoRef,
        target: &Target,
        log: &TargetLog,
        comments: &[Comment],
        reviews: &[Review],
    ) -> Result<HiddenItems> {
        let has_hides = log
            .events
            .iter()
            .any(|e| matches!(e.kind, EventKind::Hide | EventKind::Unhide));
        if !has_hides {
            return Ok(HiddenItems::default());
        }
        let proved = self.hides_proved(repo).await?;
        let maintainers: BTreeSet<String> = if proved {
            BTreeSet::new()
        } else {
            MemberReader::new(self.client())
                .list(repo)
                .await?
                .into_iter()
                .filter(|m| m.role == Role::Maintainer)
                .map(|m| m.identity_id)
                .collect()
        };
        let scope = HideScope {
            thread_id: target.id.clone(),
            thread_author: target.author.clone(),
            owner: repo.owner_id().to_string(),
            maintainers,
            proved,
        };
        let (comments, reviews) = thread_items(comments, reviews);
        Ok(hidden_items(&log.events, &scope, &comments, &reviews))
    }
}
