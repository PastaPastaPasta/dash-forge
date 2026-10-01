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
use crate::rules::v2::{
    hidden_items, hide_blocked, HiddenItems, HideBlock, HideScope, Role, ThreadItem,
};
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
    /// Maintainers only. Refused before signing for anyone else, for an `item` that is no
    /// comment (or, on a PR, review) of `target`, and for a write readers would ignore or that
    /// changes nothing ([`hide_blocked`]: the owner's content or decision, an inline comment
    /// hidden with its review, already hidden or not hidden). Returns the event's id.
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
            |id| format!("{id} on {} #{}", target.kind.noun(), target.number),
        );
        let verb = if hidden { "hide" } else { "unhide" };
        self.require_role(repo, Role::Maintainer, &format!("{verb} {what}"))
            .await?;
        let comments = self.comments(repo, &target.id).await?;
        let reviews = if target.kind == TargetKind::Patch {
            self.reviews(repo, &target.id).await?
        } else {
            Vec::new()
        };
        let (comments, reviews) = thread_items(&comments, &reviews);
        if let Some(id) = item {
            if !comments.iter().chain(&reviews).any(|c| c.id == id) {
                let kinds = if target.kind == TargetKind::Patch {
                    "comment or review"
                } else {
                    "comment"
                };
                return Err(Error::Config(format!(
                    "{id} is no {kinds} of {} #{} that you can read",
                    target.kind.noun(),
                    target.number
                )));
            }
        }
        let log = self.target_log(repo, &target.id).await?;
        let scope = self.hide_scope(repo, target).await;
        if let Some(block) = hide_blocked(
            &log.events,
            &scope,
            &comments,
            &reviews,
            &self.signer_id()?,
            item,
            hidden,
        ) {
            return Err(Error::Config(blocked_words(block, &what, repo)));
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

    /// Who may hide in `target`, as a reader judges it. A failed read of the contract's proof or
    /// of the members falls back to the stricter rule (no proof, no maintainers: the owner's hides
    /// alone), so a reader never fails over it.
    async fn hide_scope(&self, repo: &RepoRef, target: &Target) -> HideScope {
        let proved = self.hides_proved(repo).await.unwrap_or(false);
        let maintainers: BTreeSet<String> = if proved {
            BTreeSet::new()
        } else {
            MemberReader::new(self.client())
                .list(repo)
                .await
                .unwrap_or_default()
                .into_iter()
                .filter(|m| m.role == Role::Maintainer)
                .map(|m| m.identity_id)
                .collect()
        };
        HideScope {
            thread_id: target.id.clone(),
            thread_author: target.author.clone(),
            owner: repo.owner_id().to_string(),
            maintainers,
            proved,
        }
    }

    /// What a reader collapses in `target` ([`hidden_items`]), from its log, comments and reviews
    /// as already read. Without the contract's proof it reads the repo's maintainers now; a failed
    /// read of either counts the owner's hides alone (never an error).
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
        let scope = self.hide_scope(repo, target).await;
        let (comments, reviews) = thread_items(comments, reviews);
        Ok(hidden_items(&log.events, &scope, &comments, &reviews))
    }
}

/// Why a hide or unhide is refused before signing ([`HideBlock`]).
fn blocked_words(block: HideBlock, what: &str, repo: &RepoRef) -> String {
    let owner = format!("the owner of {}", repo.display());
    match block {
        HideBlock::OwnersContent => {
            format!("{what} was written by {owner}: only the owner can hide it; nothing written")
        }
        HideBlock::OwnerDecided => format!(
            "{owner} already hid or unhid {what}, and readers follow the owner: nothing written"
        ),
        HideBlock::WithItsReview => {
            format!("{what} is hidden with its review: unhide the review instead; nothing written")
        }
        HideBlock::AlreadyHidden => format!("{what} is already hidden; nothing written"),
        HideBlock::NotHidden => format!("{what} is not hidden; nothing written"),
    }
}
