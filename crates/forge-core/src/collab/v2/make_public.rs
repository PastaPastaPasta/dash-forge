//! Making members-only discussion public by its author (mixed-visibility DESIGN §4.6, D5;
//! the rules are [`crate::rules::make_public`]). An issue, PR or comment goes public by a replace
//! that drops `enc` and `epoch` and sets its text in plaintext; a review, which cannot be
//! replaced, by a public comment attached to it. Someone else's post is refused before anything
//! is read with a key or signed: other people's words go public only through a maintainer, and
//! that is not built yet.

use std::collections::{BTreeMap, BTreeSet};

use super::{
    content_kind_of, content_of, edit_check, id_field, is_sealed, owner_check, stored_audience,
    Collab, DocKeys, DOC_COMMENT, DOC_ISSUE, DOC_PATCH, DOC_REVIEW,
};
use crate::collab::CommentAnchor;
use crate::error::{Error, Result};
use crate::platform::{FetchedDocument, FieldValue};
use crate::private::{DocKind, Fields, Opened};
use crate::rules::v2::{
    audience_edit, make_public_changes, review_text_carriers, Audience, AudienceEdit,
    CarrierComment, CarrierReview, MadePublic, MakePublicRefusal, Role, Visibility,
};
use crate::scope::RepoRef;
use crate::user_error::{codes, UserError};

/// A post its author asked to make public, read and checked, before anything is signed.
#[derive(Debug, Clone)]
pub struct MakePublicPlan {
    /// What it is: an issue, a PR, a comment or a review.
    pub kind: DocKind,
    /// Its document id.
    pub id: String,
    /// An issue's or PR's number.
    pub number: Option<u32>,
    /// Who it was written for (members-only, or a letter).
    pub audience: Audience,
    /// The replace (for a review: the text its attached comment carries, in `set["body"]`).
    pub changes: MadePublic,
    /// The PR a review is on, which its attached comment is written to.
    review_patch: Option<String>,
    stored: FetchedDocument,
}

impl MakePublicPlan {
    /// The text that becomes public (an issue's title first, then its body), as it reads now.
    #[must_use]
    pub fn texts(&self) -> Vec<&str> {
        ["title", "body"]
            .iter()
            .filter_map(|f| self.changes.set.get(*f).map(String::as_str))
            .collect()
    }

    /// The word for what is made public ("comment", "issue", "pull request", "review").
    #[must_use]
    pub fn noun(&self) -> &'static str {
        match self.kind {
            DocKind::Issue => "issue",
            DocKind::Patch => "pull request",
            DocKind::Review => "review",
            _ => "comment",
        }
    }
}

/// A refusal of making a post public, before anything is signed.
fn refused(what: impl Into<String>, cause: impl Into<String>) -> Error {
    UserError::new(codes::USAGE, what)
        .cause(cause)
        .note("checked before anything was signed; nothing was written or paid")
        .into()
}

impl Collab<'_> {
    /// The post `id` of `repo`, found by trying each type that can be made public: a comment,
    /// a review, an issue, then a PR. `None` when it is none of them.
    pub async fn find_post(
        &self,
        repo: &RepoRef,
        id: &str,
    ) -> Result<Option<(DocKind, FetchedDocument)>> {
        let collab = self.collab_contract(repo).await?;
        for (kind, doc_type) in [
            (DocKind::Comment, DOC_COMMENT),
            (DocKind::Review, DOC_REVIEW),
            (DocKind::Issue, DOC_ISSUE),
            (DocKind::Patch, DOC_PATCH),
        ] {
            if let Some(d) = self.client.fetch_document(&collab, doc_type, id).await? {
                return Ok(Some((kind, d)));
            }
        }
        Ok(None)
    }

    /// Plan making the signer's post `stored` (a `kind` document of `repo`) public: refused,
    /// before anything is signed, when it is someone else's (with the words for the signer's
    /// role), already public, in a private repository, imported with sealed provenance, or a
    /// comment in a conversation that is still members-only (DESIGN §3.3: a public post never
    /// answers members-only text). `going_public`: the ids of posts made public in the same
    /// batch, which a comment's conversation counts as public. Its text is opened with the keys
    /// the signer holds, so a former member can still make what they wrote public.
    pub async fn make_public_plan(
        &self,
        repo: &RepoRef,
        kind: DocKind,
        stored: FetchedDocument,
        going_public: &BTreeSet<String>,
    ) -> Result<MakePublicPlan> {
        let me = self.signer_id()?;
        if stored.owner_id != me {
            return Err(self.not_your_post(repo).await);
        }
        owner_check(repo, kind.type_name(), &stored, &me, "make public")?;
        if kind == DocKind::Patch {
            // a members-only PR's branch names are sealed and immutable: phase 3 builds it
            return Err(refused(
                "a pull request can't be made public this way yet",
                "only issues, comments and reviews can be made public by their author for now",
            ));
        }
        if stored.field_str("vis").as_deref() == Some("private") {
            return Err(refused(
                "Posts from before this repo was public can be made public by a maintainer.",
                "it was written while the repository was private",
            ));
        }
        if repo.visibility == Visibility::Private {
            return Err(refused(
                format!(
                    "{} is private: its posts can't be made public one at a time",
                    repo.display()
                ),
                "everything in a private repository is for its members",
            ));
        }
        let audience = stored_audience(&stored);
        if audience == Audience::Public {
            return Err(
                UserError::new(codes::USAGE, "it is already public; nothing was written").into(),
            );
        }
        let opened = self.open_own(repo, kind, &stored).await?;
        let changes = planned_changes(kind, opened)?;
        let review_patch = if kind == DocKind::Review {
            id_field(&stored, "patchId")
        } else {
            None
        };
        // A comment answers its issue or PR and its thread; a review's comment, its PR.
        let target = match kind {
            DocKind::Comment => id_field(&stored, "targetId"),
            DocKind::Review => review_patch.clone(),
            _ => None,
        };
        if let Some(t) = target {
            self.require_public_conversation(repo, &t, &stored, going_public)
                .await?;
        }
        if let Some(patch) = review_patch.as_deref() {
            if self.review_text_public(repo, patch, &stored.id).await? {
                return Err(UserError::new(
                    codes::USAGE,
                    "this review's text is already public; nothing was written",
                )
                .into());
            }
        }
        Ok(MakePublicPlan {
            kind,
            id: stored.id.clone(),
            number: stored
                .field_u64("number")
                .and_then(|n| u32::try_from(n).ok()),
            audience,
            changes,
            review_patch,
            stored,
        })
    }

    /// Refuse making a post public inside a conversation that is still members-only: its
    /// target `target` and, for a reply, the comment it replies to and its root (DESIGN §3.3),
    /// each counted as public when it is in `going_public`.
    async fn require_public_conversation(
        &self,
        repo: &RepoRef,
        target: &str,
        stored: &FetchedDocument,
        going_public: &BTreeSet<String>,
    ) -> Result<()> {
        let of = |d: &FetchedDocument| {
            if going_public.contains(&d.id) {
                Audience::Public
            } else {
                stored_audience(d)
            }
        };
        let mut parent = if going_public.contains(target) {
            Audience::Public
        } else {
            self.target_audience(repo, target).await?
        };
        if let Some(reply_to) = id_field(stored, "replyTo") {
            let collab = self.collab_contract(repo).await?;
            let thread = self
                .thread_docs(repo, &collab, target, &reply_to)
                .await?
                .docs();
            parent = thread.iter().map(of).fold(parent, Audience::narrower);
        }
        if parent == Audience::Public {
            return Ok(());
        }
        Err(refused(
            "this conversation is members-only, so a post in it can't be made public",
            "everyone could read it, and it answers text only members can read",
        ))
    }

    /// Make the planned post public, with `body` as the text its body field takes (a long
    /// text's public field from `long_body`, or the planned text). An issue, PR or comment is
    /// replaced, guarded by the revision the plan read; a review gets its attached public
    /// comment. Returns the id of the document written.
    pub async fn make_public(
        &self,
        repo: &RepoRef,
        plan: &MakePublicPlan,
        body: Option<&str>,
    ) -> Result<String> {
        if plan.kind == DocKind::Review {
            let patch = plan.review_patch.as_deref().ok_or(Error::NotFound)?;
            let text = body
                .or_else(|| plan.changes.set.get("body").map(String::as_str))
                .unwrap_or_default();
            let anchor = CommentAnchor {
                review_id: Some(plan.id.clone()),
                ..CommentAnchor::default()
            };
            return self.comment(repo, patch, text, Some(&anchor), None).await;
        }
        let (mut changes, revision) = self.make_public_replace(repo, plan, body)?;
        let collab = self.collab_contract(repo).await?;
        for field in self.dead_references(repo, &collab, &plan.stored).await? {
            changes.insert(field.to_string(), None);
        }
        self.engine()?
            .replace_document_guarded(
                &collab,
                plan.kind.type_name(),
                &plan.id,
                &changes,
                Some(revision),
            )
            .await?;
        Ok(plan.id.clone())
    }

    /// Check, before anything is stored or signed, that the planned replace is the author's
    /// edit to Public ([`audience_edit`]): what a caller storing a long body's public artifact
    /// first asks, so nothing is stored for a replace that would be refused.
    pub fn check_make_public(&self, repo: &RepoRef, plan: &MakePublicPlan) -> Result<()> {
        if plan.kind == DocKind::Review {
            return Ok(());
        }
        self.make_public_replace(repo, plan, None).map(|_| ())
    }

    /// The replace that makes the planned post public, and the revision it is guarded by:
    /// refused unless it is exactly the author's edit to Public.
    fn make_public_replace(
        &self,
        repo: &RepoRef,
        plan: &MakePublicPlan,
        body: Option<&str>,
    ) -> Result<(BTreeMap<String, Option<FieldValue>>, u64)> {
        let ck = content_kind_of(plan.kind).ok_or(Error::NotFound)?;
        let doc_type = plan.kind.type_name();
        let me = self.signer_id()?;
        let revision = edit_check(repo, doc_type, &plan.stored, &me)?;
        let mut changes: BTreeMap<String, Option<FieldValue>> = plan
            .changes
            .set
            .iter()
            .map(|(k, v)| (k.clone(), Some(FieldValue::text(v))))
            .collect();
        if let Some(b) = body {
            changes.insert("body".to_string(), Some(FieldValue::text(b)));
        }
        for f in &plan.changes.remove {
            changes.insert(f.clone(), None);
        }
        let mut edited = plan.stored.clone();
        for (k, v) in &changes {
            match v {
                Some(v) => edited.fields.insert(k.clone(), v.clone()),
                None => edited.fields.remove(k),
            };
        }
        let outcome = audience_edit(
            repo.visibility,
            &content_of(ck, &plan.stored),
            &content_of(ck, &edited),
            &plan.stored.owner_id,
            &me,
        );
        if outcome != AudienceEdit::MakesPublic {
            return Err(refused(
                format!("this {} can't be made public as it reads now", plan.noun()),
                "its public form would not be well-formed",
            ));
        }
        Ok((changes, revision))
    }

    /// Whether the signer already made the text of their review `review_id` (on PR `patch`)
    /// public: a public comment attached to it ([`crate::rules::v2::review_text_carriers`]).
    async fn review_text_public(
        &self,
        repo: &RepoRef,
        patch: &str,
        review_id: &str,
    ) -> Result<bool> {
        let (comments, _, _) = self.comments_read(repo, patch).await?;
        let me = self.signer_id()?;
        let carriers = review_text_carriers(
            &[CarrierReview {
                id: review_id.to_string(),
                reviewer: me,
                sealed: true,
            }],
            &comments.iter().map(carrier_of).collect::<Vec<_>>(),
        );
        Ok(!carriers.is_empty())
    }

    /// The refusal of making someone else's post public, in the words for the signer's role
    /// (DESIGN §10): a maintainer will make other people's posts public by a bundle, which is
    /// not built yet.
    async fn not_your_post(&self, repo: &RepoRef) -> Error {
        let maintainer = matches!(self.signer_role(repo).await, Ok(Some(Role::Maintainer)));
        let what = if maintainer {
            "Only its author can make this post public."
        } else {
            "Only maintainers can make other people's posts public."
        };
        UserError::new(codes::NOT_A_WRITER, what)
            .cause("you are not its author")
            .note("checked before anything was signed; nothing was written or paid")
            .into()
    }

    /// The signer's own sealed post opened with the keys they hold (a former member's included).
    async fn open_own(
        &self,
        repo: &RepoRef,
        kind: DocKind,
        stored: &FetchedDocument,
    ) -> Result<Fields> {
        if !is_sealed(stored) {
            return Err(Error::NotFound);
        }
        let opened = match self.lane_keys(repo).await? {
            DocKeys::Held(kr, _) => kr.open(kind, stored),
            DocKeys::None(_) => Opened::Malformed,
        };
        match opened {
            Opened::Readable(f) => Ok(*f),
            _ => Err(UserError::new(
                codes::NOT_A_KEY_HOLDER,
                "this post can't be read with your keys, so it can't be made public",
            )
            .fix(format!(
                "`dg repo keys status {}` explains the keys you hold",
                repo.display()
            ))
            .note("nothing was written")
            .into()),
        }
    }
}

/// The replace (for a review, the text its attached comment carries) that makes the opened
/// `kind` post public, or why it cannot be.
fn planned_changes(kind: DocKind, opened: Fields) -> Result<MadePublic> {
    if kind == DocKind::Review {
        let body = opened
            .body
            .filter(|b| !b.trim().is_empty())
            .ok_or_else(|| {
                refused(
                    "this review has no text to make public",
                    "only its verdict was posted, and that is public already",
                )
            })?;
        return Ok(MadePublic {
            set: BTreeMap::from([("body".to_string(), body)]),
            ..MadePublic::default()
        });
    }
    let ck = content_kind_of(kind)
        .ok_or_else(|| refused("this can't be made public", "it is not a post"))?;
    make_public_changes(ck, &opened).map_err(|e| match e {
        MakePublicRefusal::Imported => refused(
            "this post was imported, and its original author's name can't be made public",
            "published without it, the words would read as yours",
        ),
        MakePublicRefusal::Empty | MakePublicRefusal::NotEditable => refused(
            "this post has no text to make public",
            "its required text is missing",
        ),
    })
}

/// Put each members-only review's made-public text in place (DESIGN §4.6): the public comment
/// its author attached to it ([`crate::rules::v2::review_text_carriers`]) becomes the review's
/// text, for everyone, and leaves `comments`. Returns the carrying comment of each review it
/// changed, by review id.
pub fn apply_review_texts(
    reviews: &mut [super::Review],
    comments: &mut Vec<super::Comment>,
    hidden: impl Fn(&str) -> bool,
) -> BTreeMap<String, String> {
    let carriers = review_text_carriers(
        &reviews
            .iter()
            .map(|r| CarrierReview {
                id: r.document_id.clone(),
                reviewer: r.reviewer.clone(),
                sealed: r.audience != Audience::Public,
            })
            .collect::<Vec<_>>(),
        // a carrier a maintainer hid shows as the hidden comment it is, not as the review's text
        &comments
            .iter()
            .filter(|c| !hidden(&c.document_id))
            .map(carrier_of)
            .collect::<Vec<_>>(),
    );
    for r in reviews.iter_mut() {
        let Some(cid) = carriers.get(&r.document_id) else {
            continue;
        };
        if let Some(c) = comments.iter().find(|c| &c.document_id == cid) {
            r.body.clone_from(&c.body);
            r.audience = Audience::Public;
            r.members_only = false;
        }
    }
    let used: BTreeSet<&String> = carriers.values().collect();
    comments.retain(|c| !used.contains(&c.document_id));
    carriers
}

/// A comment as [`crate::rules::v2::review_text_carriers`] takes it.
fn carrier_of(c: &super::Comment) -> CarrierComment {
    CarrierComment {
        id: c.document_id.clone(),
        owner: c.author.clone(),
        review_id: c.review_id.clone(),
        reply_to: c.reply_to.clone(),
        path: c.anchor.path.clone(),
        line: c.anchor.line,
        commit_oid: c.anchor.commit_oid.clone(),
        sealed: c.audience != Audience::Public,
        created_at: c.created_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::v2::AnchorFields;
    use crate::rules::Verdict;

    fn review(id: &str, audience: Audience, members_only: bool) -> super::super::Review {
        super::super::Review {
            document_id: id.into(),
            reviewer: "bob".into(),
            verdict: Verdict::Comment,
            commit_oid: "ab".repeat(20),
            body: String::new(),
            comment_count: None,
            created_at: 10,
            imported: None,
            members_only,
            audience,
        }
    }

    fn comment(id: &str, author: &str, at: u64) -> super::super::Comment {
        super::super::Comment {
            document_id: id.into(),
            author: author.into(),
            body: format!("text of {id}"),
            reply_to: None,
            review_id: Some("R1".into()),
            anchor: AnchorFields::default(),
            created_at: at,
            imported: None,
            diff_hunk: None,
            audience: Audience::Public,
        }
    }

    #[test]
    fn the_reviewers_newest_public_comment_becomes_the_reviews_text() {
        let mut reviews = vec![review("R1", Audience::Members, true)];
        let mut comments = vec![
            comment("C1", "bob", 1),
            comment("C2", "bob", 2),
            comment("C3", "eve", 3),
        ];
        let got = apply_review_texts(&mut reviews, &mut comments, |_| false);
        assert_eq!(got.get("R1").map(String::as_str), Some("C2"));
        assert_eq!(reviews[0].body, "text of C2");
        assert_eq!(reviews[0].audience, Audience::Public);
        assert!(!reviews[0].members_only);
        let left: Vec<&str> = comments.iter().map(|c| c.document_id.as_str()).collect();
        assert_eq!(left, ["C1", "C3"]);
    }

    #[test]
    fn a_hidden_carrier_or_a_public_review_changes_nothing() {
        let mut reviews = vec![review("R1", Audience::Members, true)];
        let mut comments = vec![comment("C1", "bob", 1)];
        assert!(apply_review_texts(&mut reviews, &mut comments, |id| id == "C1").is_empty());
        assert!(reviews[0].members_only && comments.len() == 1);
        let mut public = vec![review("R1", Audience::Public, false)];
        assert!(apply_review_texts(&mut public, &mut comments, |_| false).is_empty());
        assert!(public[0].body.is_empty());
    }
}
