//! What "Everything" makes public in a private repository going public (mixed-visibility DESIGN
//! §4.10 step 0): the discussion written while it was private, counted and opened with the
//! member's own keys, so the pre-flight can say what becomes readable and scan its text for
//! secrets before anything is signed.
//!
//! Only documents stamped `vis: "private"` count: in a repository already made public (Code only,
//! then Everything later) they are the pre-conversion ones, and everything written since is
//! under the seal-off epoch or later, which is never published. Letters (`enc` v0x04) are counted
//! apart: they stay private in both modes.

use std::collections::BTreeSet;

use super::{imported_of, is_letter, Collab, DOC_COMMENT, DOC_EVENT, DOC_ISSUE, DOC_PATCH};
use super::{DOC_RELEASE, DOC_REVIEW};
use crate::error::Result;
use crate::platform::{FetchedDocument, QueryOrder};
use crate::private::DocKind;
use crate::rules::v2::{ContentKind, Visibility};
use crate::scope::RepoRef;

/// Event kind 24: a maintainer hid a comment, review or thread (display only).
const EVENT_HIDE: u64 = 24;
/// Event kind 27: someone asked a bot to work on a thread (its task text is the value).
const EVENT_AGENT_REQUEST: u64 = 27;

/// One piece of discussion text "Everything" would publish, for the secret scan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CensusText {
    /// Where it is, as a person reads it ("issue #3 title", "a comment on #3").
    pub place: String,
    /// The text.
    pub text: String,
}

/// The discussion a private repository holds from before it was made public.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Census {
    /// Issues written while private.
    pub issues: usize,
    /// Pull requests written while private.
    pub prs: usize,
    /// Comments (inline ones included).
    pub comments: usize,
    /// Reviews.
    pub reviews: usize,
    /// Earlier versions of edited issues, pull requests and comments (archival nodes keep each).
    pub revisions: usize,
    /// Hide events: content maintainers hid, which conforming readers keep hiding but anyone
    /// can open once its key is published.
    pub hidden: usize,
    /// Requests sent to bots (their task texts become public).
    pub bot_requests: usize,
    /// Releases written while private.
    pub releases: usize,
    /// Messages to specific people (letters): they stay private.
    pub letters: usize,
    /// Sealed documents this reader cannot open: they become public too, unread here.
    pub unread: usize,
    /// Who wrote what becomes public (base58 identity ids).
    pub authors: BTreeSet<String>,
    /// Imported authors, as `(host, author)` (not Forge identities).
    pub imported: BTreeSet<(String, String)>,
    /// The text that becomes readable, for the secret scan.
    pub texts: Vec<CensusText>,
}

impl Census {
    /// The imported authors' hosts (`github.com`), distinct.
    #[must_use]
    pub fn imported_hosts(&self) -> BTreeSet<&str> {
        self.imported.iter().map(|(h, _)| h.as_str()).collect()
    }
}

/// `url`'s host (`https://github.com/o/r/issues/1` → `github.com`), or the url itself.
fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    rest.split(['/', '?', '#'])
        .next()
        .unwrap_or(rest)
        .to_ascii_lowercase()
}

/// Whether `d` was written while its repository was private.
fn written_private(d: &FetchedDocument) -> bool {
    d.field_str("vis").as_deref() == Some(Visibility::Private.as_str())
}

impl Collab<'_> {
    /// The census of `repo` (private, or made public: read through its private view either way,
    /// with the signer's own keys). Reads every issue, pull request, comment, review, event and
    /// release of the repository once. `before` is the conversion marker's block height of a
    /// repository already made public (events carry no `vis` stamp, so they are placed by it);
    /// `None` while it is private.
    #[allow(clippy::too_many_lines)] // one pass per document type, each counted the same way
    pub async fn make_public_census(&self, repo: &RepoRef, before: Option<u64>) -> Result<Census> {
        let private = repo.private_view();
        let collab = self.collab_contract(&private).await?;
        let community = self.community_contract(&private).await?;
        let core = self.client.fetch_contract(&private.forge().core).await?;
        let filter = [Self::repo_filter(&private)?];
        let order = [QueryOrder::asc("$createdAt")];
        let mut out = Census::default();
        let numbers = |d: &FetchedDocument| d.field_u64("number").map(|n| format!("#{n}"));
        for (doc_type, kind) in [
            (DOC_ISSUE, ContentKind::Issue),
            (DOC_PATCH, ContentKind::Patch),
            (DOC_COMMENT, ContentKind::Comment),
            (DOC_REVIEW, ContentKind::Review),
        ] {
            let docs: Vec<FetchedDocument> = self
                .client
                .query_all_documents(&collab, doc_type, &filter, &order)
                .await?
                .into_iter()
                .filter(written_private)
                .collect();
            let (letters, docs): (Vec<_>, Vec<_>) = docs.into_iter().partition(is_letter);
            out.letters += letters.len();
            let read = self.readable(&private, kind, docs).await?;
            out.unread += read.members_only.len();
            for d in &read.rows {
                out.authors.insert(d.owner_id.clone());
                out.revisions += usize::try_from(d.revision.unwrap_or(1).saturating_sub(1))
                    .unwrap_or(usize::MAX);
                if let Some(i) = imported_of(d) {
                    out.imported.insert((host_of(&i.url), i.author));
                }
                let (noun, place) = match kind {
                    ContentKind::Issue => {
                        out.issues += 1;
                        ("issue", numbers(d).unwrap_or_default())
                    }
                    ContentKind::Patch => {
                        out.prs += 1;
                        ("pull request", numbers(d).unwrap_or_default())
                    }
                    ContentKind::Comment => {
                        out.comments += 1;
                        ("comment", d.id.clone())
                    }
                    _ => {
                        out.reviews += 1;
                        ("review", d.id.clone())
                    }
                };
                for field in ["title", "body", "path"] {
                    if let Some(text) = d.field_str(field).filter(|t| !t.is_empty()) {
                        out.texts.push(CensusText {
                            place: format!("{noun} {place} {field}"),
                            text,
                        });
                    }
                }
            }
        }
        let events: Vec<FetchedDocument> = self
            .client
            .query_all_documents(&community, DOC_EVENT, &filter, &order)
            .await?
            .into_iter()
            .filter(|d| {
                before.is_none_or(|h| d.created_at_block_height.is_some_and(|at| at <= h))
            })
            .collect();
        for d in &events {
            match d.field_u64("kind") {
                Some(EVENT_HIDE) => out.hidden += 1,
                Some(EVENT_AGENT_REQUEST) => out.bot_requests += 1,
                _ => {}
            }
        }
        let sealed: Vec<FetchedDocument> = events
            .into_iter()
            .filter(|d| d.field_bytes("enc").is_some_and(|e| !e.is_empty()))
            .collect();
        let (opened, unread, _) = self
            .readable_events_of(&private, DocKind::Event, sealed)
            .await?;
        out.unread += unread;
        for d in &opened {
            if let Some(text) = d.field_str("value").filter(|t| !t.is_empty()) {
                out.authors.insert(d.owner_id.clone());
                out.texts.push(CensusText {
                    place: format!("event {}", d.id),
                    text,
                });
            }
        }
        out.releases = self
            .client
            .query_all_documents(&core, DOC_RELEASE, &filter, &order)
            .await?
            .iter()
            .filter(|d| written_private(d))
            .count();
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_are_read_from_urls() {
        assert_eq!(host_of("https://GitHub.com/o/r/issues/1"), "github.com");
        assert_eq!(host_of("https://gitlab.example:8443/x?y#z"), "gitlab.example:8443");
        assert_eq!(host_of("not a url"), "not a url");
    }
}
