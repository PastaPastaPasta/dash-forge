//! Making members-only discussion public by its author (mixed-visibility DESIGN §4.6, D5,
//! §2.4). A document's audience is fixed when it is written, with one exception: its author may
//! make their own members-only or letter issue, PR or comment public, by a replace that drops
//! `enc` and `epoch` and sets the plaintext fields. A review cannot be replaced, so its author
//! makes its text public with a public comment attached to it (`reviewId`, no anchor).
//!
//! Until the mainnet contract (`aud`, §4.11) the clients allow exactly this change and refuse
//! every other before signing. On the live contracts `comment.path` and `comment.diffHunk`,
//! `patch.baseRefName`/`sourceRefName` and `imported` are immutable, so a made-public inline
//! comment keeps no file name ([`MadePublic::lost`]) and an item whose import provenance is
//! sealed cannot be made public at all ([`MakePublicRefusal::Imported`]).
//!
//! Every function is pure; the `make_public__*` vectors are shared with
//! `forge-web/lib/rules/make-public.ts`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::v2::{
    edit_keeps_audience, git_plane_well_formed, Audience, ContentDoc, ContentKind, Visibility,
};
use crate::private::Fields;

/// What an edit does to the audience of the document it replaces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AudienceEdit {
    /// The audience stays: a plaintext edit of a public document, a re-seal of a sealed one.
    Keeps,
    /// The author's edit to Public of their own members-only or letter document.
    MakesPublic,
    /// Someone else's document: only its author can replace it (consensus too).
    NotAuthor,
    /// Any other audience change: a sealed edit of a public document, Members to a letter or
    /// back, or anything public in a private repository.
    Fixed,
    /// The edit's content does not fit its audience (plaintext beside `enc`, an `epoch` left
    /// on a public document, a required field missing).
    Malformed,
}

/// What an edit of `stored` (written by `author`) into `edited`, signed by `signer`, does to the
/// document's audience in a repository of `visibility` (DESIGN §2.4, §4.6).
#[must_use]
pub fn audience_edit(
    visibility: Visibility,
    stored: &ContentDoc,
    edited: &ContentDoc,
    author: &str,
    signer: &str,
) -> AudienceEdit {
    if author != signer {
        return AudienceEdit::NotAuthor;
    }
    let (was, now) = (Audience::of(stored), Audience::of(edited));
    if was == now {
        return if edit_keeps_audience(stored, edited) {
            AudienceEdit::Keeps
        } else {
            AudienceEdit::Malformed
        };
    }
    if was == Audience::Public || now != Audience::Public || visibility != Visibility::Public {
        return AudienceEdit::Fixed;
    }
    if edited.epoch.is_none() && git_plane_well_formed(edited) {
        AudienceEdit::MakesPublic
    } else {
        AudienceEdit::Malformed
    }
}

/// Why a document cannot be made public by its author's edit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MakePublicRefusal {
    /// Its import provenance (the original author and URL) is sealed, and `imported` cannot
    /// change: published without it, the words would read as the importer's.
    Imported,
    /// The opened content lacks the field its public form needs (an issue's title, a comment's
    /// body).
    Empty,
    /// Not an issue, PR or comment (a review is made public by an attached comment).
    NotEditable,
}

/// The replace that makes a sealed document public: the plaintext fields it sets, the fields it
/// removes, and the sealed fields that cannot be published because they are immutable on the
/// live contracts (they are lost for everyone, members included).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MadePublic {
    /// Plaintext content fields to set, by property name.
    pub set: BTreeMap<String, String>,
    /// Properties to remove: always `enc` and `epoch`.
    pub remove: Vec<String>,
    /// Sealed fields left behind, by property name (an inline comment's `path`).
    pub lost: Vec<String>,
}

/// The replace that makes a sealed `kind` document public, from its opened content `opened`
/// (DESIGN §4.6): the text as it stands now becomes the document's plaintext.
///
/// # Errors
/// [`MakePublicRefusal`]: sealed import provenance, a missing required field, or a kind that
/// is not replaced this way.
pub fn make_public_changes(
    kind: ContentKind,
    opened: &Fields,
) -> Result<MadePublic, MakePublicRefusal> {
    if opened.imported_author.is_some() || opened.imported_url.is_some() {
        return Err(MakePublicRefusal::Imported);
    }
    // blank is Unicode White_Space only (`char::is_whitespace`), as the contract's `\S` reads it
    let text = |v: &Option<String>| v.as_ref().filter(|s| !s.trim().is_empty()).cloned();
    let (title, body) = (text(&opened.title), text(&opened.body));
    let mut out = MadePublic {
        remove: vec!["enc".to_string(), "epoch".to_string()],
        ..MadePublic::default()
    };
    let mut lose = |field: &str, v: &Option<String>| {
        if v.is_some() {
            out.lost.push(field.to_string());
        }
    };
    match kind {
        ContentKind::Issue | ContentKind::Patch => {
            if kind == ContentKind::Patch {
                lose("baseRefName", &opened.base_ref_name);
                lose("sourceRefName", &opened.source_ref_name);
            }
            let title = title.ok_or(MakePublicRefusal::Empty)?;
            out.set.insert("title".to_string(), title);
            if let Some(b) = body {
                out.set.insert("body".to_string(), b);
            }
        }
        ContentKind::Comment => {
            lose("path", &opened.path);
            out.set
                .insert("body".to_string(), body.ok_or(MakePublicRefusal::Empty)?);
        }
        _ => return Err(MakePublicRefusal::NotEditable),
    }
    Ok(out)
}

/// A review, as [`review_text_carriers`] takes it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CarrierReview {
    /// `$id`.
    pub id: String,
    /// `$ownerId`.
    pub reviewer: String,
    /// It carries `enc` (members-only or a letter).
    #[serde(default)]
    pub sealed: bool,
}

/// A comment, as [`review_text_carriers`] takes it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CarrierComment {
    /// `$id`.
    pub id: String,
    /// `$ownerId`.
    pub owner: String,
    /// `reviewId`.
    #[serde(default)]
    pub review_id: Option<String>,
    /// `replyTo`.
    #[serde(default)]
    pub reply_to: Option<String>,
    /// `path`.
    #[serde(default)]
    pub path: Option<String>,
    /// `line`.
    #[serde(default)]
    pub line: Option<u64>,
    /// `commitOid`, hex.
    #[serde(default)]
    pub commit_oid: Option<String>,
    /// It carries `enc`.
    #[serde(default)]
    pub sealed: bool,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
}

impl CarrierComment {
    /// Whether this comment carries a review's text: public, attached to a review, and with no
    /// anchor or thread of its own (a made-public inline comment keeps its line and commit).
    fn carries_text(&self) -> bool {
        let none = |s: &Option<String>| s.as_deref().is_none_or(str::is_empty);
        !self.sealed
            && self.review_id.is_some()
            && none(&self.path)
            && self.line.is_none()
            && none(&self.reply_to)
            && none(&self.commit_oid)
    }
}

/// The public comment that carries each sealed review's text, by review id (DESIGN §4.6: "a
/// public comment attached to the review", rendered in place of its placeholder). Only the
/// review's author's comment counts (consensus admits no other `reviewId` comment; readers check
/// again), and the newest by `(createdAt, id)` wins.
#[must_use]
pub fn review_text_carriers(
    reviews: &[CarrierReview],
    comments: &[CarrierComment],
) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for r in reviews.iter().filter(|r| r.sealed) {
        let newest = comments
            .iter()
            .filter(|c| {
                c.carries_text()
                    && c.review_id.as_deref() == Some(r.id.as_str())
                    && c.owner == r.reviewer
            })
            .max_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
        if let Some(c) = newest {
            out.insert(r.id.clone(), c.id.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(kind: ContentKind) -> ContentDoc {
        ContentDoc {
            kind,
            title: None,
            body: None,
            ref_name: None,
            base_ref_name: None,
            source_ref_name: None,
            ref_name_hash: None,
            base_ref_name_hash: None,
            source_ref_name_hash: None,
            path: None,
            default_branch: None,
            protected_patterns: None,
            enc: None,
            epoch: None,
            release_fields: Vec::new(),
        }
    }

    fn sealed(kind: ContentKind, version: &str) -> ContentDoc {
        ContentDoc {
            enc: Some(format!("{version}{}", "00".repeat(60))),
            epoch: Some(0),
            ..doc(kind)
        }
    }

    fn public_comment(body: &str) -> ContentDoc {
        ContentDoc {
            body: Some(body.into()),
            ..doc(ContentKind::Comment)
        }
    }

    #[test]
    fn only_the_author_makes_a_sealed_document_public() {
        let (stored, edited) = (
            sealed(ContentKind::Comment, "03"),
            public_comment("now public"),
        );
        let edit = |vis, author, signer| audience_edit(vis, &stored, &edited, author, signer);
        assert_eq!(
            edit(Visibility::Public, "a", "a"),
            AudienceEdit::MakesPublic
        );
        assert_eq!(edit(Visibility::Public, "a", "b"), AudienceEdit::NotAuthor);
        assert_eq!(edit(Visibility::Private, "a", "a"), AudienceEdit::Fixed);
        let letter = sealed(ContentKind::Comment, "04");
        assert_eq!(
            audience_edit(Visibility::Public, &letter, &edited, "a", "a"),
            AudienceEdit::MakesPublic
        );
    }

    #[test]
    fn every_other_audience_change_is_refused() {
        let pub_c = public_comment("x");
        let (members, letter) = (
            sealed(ContentKind::Comment, "03"),
            sealed(ContentKind::Comment, "04"),
        );
        let edit =
            |s: &ContentDoc, e: &ContentDoc| audience_edit(Visibility::Public, s, e, "a", "a");
        assert_eq!(edit(&pub_c, &members), AudienceEdit::Fixed);
        assert_eq!(edit(&members, &letter), AudienceEdit::Fixed);
        assert_eq!(edit(&letter, &members), AudienceEdit::Fixed);
        assert_eq!(edit(&members, &members), AudienceEdit::Keeps);
        assert_eq!(edit(&pub_c, &pub_c), AudienceEdit::Keeps);
        let mut epoch_left = public_comment("x");
        epoch_left.epoch = Some(0);
        assert_eq!(edit(&members, &epoch_left), AudienceEdit::Malformed);
        assert_eq!(
            edit(&members, &doc(ContentKind::Comment)),
            AudienceEdit::Malformed
        );
    }

    #[test]
    fn an_inline_comment_loses_its_path_and_provenance_is_refused() {
        let opened = Fields {
            body: Some("nit".into()),
            path: Some("src/lib.rs".into()),
            ..Fields::default()
        };
        let got = make_public_changes(ContentKind::Comment, &opened).expect("public");
        assert_eq!(got.set.get("body").map(String::as_str), Some("nit"));
        assert_eq!(got.remove, ["enc", "epoch"]);
        assert_eq!(got.lost, ["path"]);
        let imported = Fields {
            imported_author: Some("octo".into()),
            ..opened
        };
        assert_eq!(
            make_public_changes(ContentKind::Comment, &imported),
            Err(MakePublicRefusal::Imported)
        );
        assert_eq!(
            make_public_changes(ContentKind::Issue, &Fields::default()),
            Err(MakePublicRefusal::Empty)
        );
    }

    #[test]
    fn the_reviewers_newest_unanchored_public_comment_carries_the_text() {
        let review = CarrierReview {
            id: "R".into(),
            reviewer: "bob".into(),
            sealed: true,
        };
        let c = |id: &str, owner: &str, at: u64| CarrierComment {
            id: id.into(),
            owner: owner.into(),
            review_id: Some("R".into()),
            reply_to: None,
            path: None,
            line: None,
            commit_oid: None,
            sealed: false,
            created_at: at,
        };
        let inline = CarrierComment {
            line: Some(3),
            ..c("inline", "bob", 9)
        };
        let comments = [
            c("old", "bob", 1),
            c("new", "bob", 2),
            c("eve", "eve", 5),
            inline,
        ];
        let got = review_text_carriers(std::slice::from_ref(&review), &comments);
        assert_eq!(got.get("R").map(String::as_str), Some("new"));
        let public = CarrierReview {
            sealed: false,
            ..review
        };
        assert!(review_text_carriers(&[public], &comments).is_empty());
    }
}
