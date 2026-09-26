//! forge-v1 → [`SrcCollab`]: a v1 repository's issues, pull requests, comments, reviews,
//! labels and releases, read with only a client (no identity on the source network), and
//! its collaborators (token holders).
//!
//! v1 state is folded with the v1 rules (as-of token holdings), so the mirror shows what a
//! v1 reader sees today. Each item's key is `dash-v1://<contract>/<kind>/<id-or-number>`,
//! recorded in `imported.url`; an item the v1 repo itself had imported from GitHub keeps its
//! original author and time in `imported`, and says so in its header.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;

use anyhow::{Context, Result};

use forge_core::collab::v2::{event_from_doc, TargetKind};
use forge_core::collab::{CommentAnchor, Imported, ReleaseAsset, Verdict};
use forge_core::platform::{
    FetchedDocument, FieldValue, LoadedContract, PlatformClient, QueryFilter, QueryOrder,
};
use forge_core::rules::v2::Role;
use forge_core::rules::{self, AuthzResolver, EventKind};
use forge_core::scope::{DocScope, RepoRef};
use forge_core::tokens::TokenService;

use crate::model::{
    self, SrcCollab, SrcComment, SrcLabel, SrcPatch, SrcRelease, SrcReview, SrcTarget,
};
use crate::source_github::Classes;

/// A v1 collaborator and the forge-v2 role it maps to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Collaborator {
    /// Identity id.
    pub identity: String,
    /// MAINTAIN → maintainer, WRITE only → writer.
    pub role: Role,
}

/// The newest document per key (`(createdAt, id)` order); documents without a key are
/// skipped.
fn keep_newest(
    docs: &[FetchedDocument],
    key: impl Fn(&FetchedDocument) -> Option<String>,
) -> BTreeMap<String, &FetchedDocument> {
    let mut newest: BTreeMap<String, &FetchedDocument> = BTreeMap::new();
    for d in docs {
        let Some(k) = key(d) else { continue };
        let order = |x: &FetchedDocument| (x.created_at.unwrap_or(0), x.id.clone());
        if newest.get(&k).is_none_or(|cur| order(d) > order(cur)) {
            newest.insert(k, d);
        }
    }
    newest
}

/// An issue's or PR's number, when it is a valid one (1..=u32::MAX).
fn number(d: &FetchedDocument) -> Option<u32> {
    d.field_u64("number")
        .and_then(|n| u32::try_from(n).ok())
        .filter(|n| *n > 0)
}

/// Folded label names as the contract bounds them.
fn label_names(labels: &BTreeSet<String>) -> BTreeSet<String> {
    labels
        .iter()
        .map(|l| model::label_name(l))
        .filter(|l| !l.is_empty())
        .collect()
}

/// The v1 repository being read.
pub struct V1Source<'a> {
    client: &'a PlatformClient,
    repo: RepoRef,
    contract: LoadedContract,
}

fn imported_of(d: &FetchedDocument) -> Option<Imported> {
    match d.fields.get("imported") {
        Some(FieldValue::Object(m)) => Some(Imported {
            author: m
                .get("author")
                .and_then(FieldValue::as_str)
                .unwrap_or_default()
                .to_string(),
            created_at: m
                .get("createdAt")
                .and_then(FieldValue::as_u64)
                .unwrap_or_default(),
            url: m
                .get("url")
                .and_then(FieldValue::as_str)
                .unwrap_or_default()
                .to_string(),
        }),
        _ => None,
    }
}

impl<'a> V1Source<'a> {
    /// Bind to a resolved v1 repository.
    pub async fn new(client: &'a PlatformClient, repo: RepoRef) -> Result<Self> {
        let contract = client
            .fetch_contract(repo.id())
            .await
            .with_context(|| format!("fetching v1 repo contract {}", repo.id()))?;
        Ok(Self {
            client,
            repo,
            contract,
        })
    }

    fn key(&self, what: &str) -> String {
        format!("dash-v1://{}/{what}", self.repo.id())
    }

    async fn all(
        &self,
        doc_type: &str,
        filters: &[QueryFilter],
        order: &[QueryOrder],
    ) -> Result<Vec<FetchedDocument>> {
        self.client
            .query_all_documents(&self.contract, doc_type, filters, order)
            .await
            .with_context(|| format!("reading the v1 repo's {doc_type} documents"))
    }

    async fn by(&self, doc_type: &str, field: &str, id: &str) -> Result<Vec<FetchedDocument>> {
        let bytes = forge_core::platform::decode_identifier(id)?;
        self.all(
            doc_type,
            &[QueryFilter::eq(field, FieldValue::identifier(bytes))],
            &[QueryOrder::asc("$createdAt")],
        )
        .await
    }

    /// Current token holders (frozen holdings are suspended: not carried over).
    pub async fn collaborators(&self) -> Result<Vec<Collaborator>> {
        Ok(TokenService::new(self.client)
            .list_collaborators(self.repo.id())
            .await?
            .into_iter()
            .filter_map(|c| {
                let maintain = c.holdings.maintain && !c.holdings.maintain_frozen;
                let write = c.holdings.write && !c.holdings.write_frozen;
                (maintain || write).then_some(Collaborator {
                    identity: c.identity_id,
                    role: if maintain {
                        Role::Maintainer
                    } else {
                        Role::Writer
                    },
                })
            })
            .collect())
    }

    /// The v1 default branch.
    pub async fn default_branch(&self) -> Option<String> {
        forge_core::repo::RepoReader::new(self.client)
            .read_default_branch(&self.repo)
            .await
            .ok()
            .flatten()
    }

    /// Read everything into the model.
    pub async fn collect(&self, classes: Classes) -> Result<SrcCollab> {
        let Classes {
            issues,
            prs,
            labels,
            releases,
            ..
        } = classes;
        let mut out = SrcCollab::default();
        if labels {
            // The newest definition of a name decides; a retired one drops the label.
            let docs = self
                .all(
                    "label",
                    &[],
                    &[QueryOrder::asc("name"), QueryOrder::asc("$createdAt")],
                )
                .await?;
            let newest = keep_newest(&docs, |d| {
                Some(model::label_name(&d.field_str("name")?)).filter(|n| !n.is_empty())
            });
            out.labels = Some(
                newest
                    .into_iter()
                    .filter(|(_, d)| !d.field_bool("retired"))
                    .map(|(name, d)| SrcLabel {
                        name,
                        color: model::color(&d.field_str("color").unwrap_or_default()),
                        description: model::clip(
                            &d.field_str("description").unwrap_or_default(),
                            200,
                            400,
                        ),
                    })
                    .collect(),
            );
        }
        if releases {
            let docs = self
                .all("release", &[], &[QueryOrder::asc("$createdAt")])
                .await?;
            let newest = keep_newest(&docs, |d| d.field_str("tagName").filter(|t| !t.is_empty()));
            out.releases = Some(
                newest
                    .into_iter()
                    .filter(|(_, d)| !d.field_bool("yanked"))
                    .map(|(tag_name, d)| SrcRelease {
                        tag_name,
                        name: d.field_str("name").unwrap_or_default(),
                        notes: d.field_str("notes").unwrap_or_default(),
                        assets: public_assets(d.field_str("assets")),
                    })
                    .collect(),
            );
        }
        if !(issues || prs) {
            return Ok(out);
        }
        let authz = AuthzResolver::new(
            TokenService::new(self.client)
                .token_history(self.repo.id())
                .await?,
        );
        if issues {
            for d in self
                .all("issue", &[], &[QueryOrder::asc("$createdAt")])
                .await?
            {
                if let Some(t) = self.issue(&d, &authz).await? {
                    out.targets.push(t);
                }
            }
        }
        if prs {
            for d in self
                .all("patch", &[], &[QueryOrder::asc("$createdAt")])
                .await?
            {
                if let Some(t) = self.patch(&d, &authz).await? {
                    out.targets.push(t);
                }
            }
        }
        out.targets
            .sort_by_key(|t| (t.kind == TargetKind::Patch, t.number));
        Ok(out)
    }

    fn header(
        &self,
        noun: &str,
        number: u32,
        author: &str,
        created_ms: u64,
        orig: Option<&Imported>,
    ) -> String {
        let mut h = format!(
            "> Migrated from forge-v1 {} {noun} #{number}, written by {author} on {}",
            self.repo.id(),
            model::date(created_ms / 1000)
        );
        if let Some(o) = orig.filter(|o| !o.url.is_empty()) {
            let _ = write!(h, " (itself imported from {} by @{})", o.url, o.author);
        }
        h.push_str("\n\n");
        h
    }

    fn provenance(key: &str, author: &str, created_ms: u64, orig: Option<&Imported>) -> Imported {
        match orig.filter(|o| !o.author.is_empty()) {
            Some(o) => model::imported(&o.author, o.created_at, key),
            None => model::imported(author, created_ms / 1000, key),
        }
    }

    async fn events(&self, target_id: &str) -> Result<Vec<rules::Event>> {
        Ok(self
            .by("event", "targetId", target_id)
            .await?
            .iter()
            .filter_map(event_from_doc)
            .collect())
    }

    async fn comments(&self, target_id: &str, number: u32, noun: &str) -> Result<Vec<SrcComment>> {
        let mut out = Vec::new();
        for d in self.by("comment", "targetId", target_id).await? {
            let text = d.field_str("body").unwrap_or_default();
            if text.trim().is_empty() {
                continue;
            }
            let orig = imported_of(&d);
            let created = d.created_at.unwrap_or(0);
            let key = self.key(&format!("comment/{}", d.id));
            // The v2 bound (v1 did not clip it); a longer path would fail the write.
            let path = d.field_str("path").map(|p| model::clip(&p, 500, 1000));
            out.push(SrcComment {
                body: model::body(
                    &self.header(
                        &format!("{noun} comment on"),
                        number,
                        &d.owner_id,
                        created,
                        orig.as_ref(),
                    ),
                    &text,
                    &key,
                ),
                imported: Self::provenance(&key, &d.owner_id, created, orig.as_ref()),
                anchor: path.map(|p| CommentAnchor {
                    reply_to: None,
                    commit_oid: d.field_bytes("commitOid"),
                    path: Some(p),
                    line: d.field_u64("line"),
                    side: d.field_u64("side"),
                }),
            });
        }
        Ok(out)
    }

    async fn issue(&self, d: &FetchedDocument, authz: &AuthzResolver) -> Result<Option<SrcTarget>> {
        let Some(number) = number(d) else {
            return Ok(None);
        };
        let events = self.events(&d.id).await?;
        let state = rules::fold_issue_state(&events, &d.owner_id, authz);
        let orig = imported_of(d);
        let created = d.created_at.unwrap_or(0);
        let key = self.key(&format!("issues/{number}"));
        Ok(Some(SrcTarget {
            kind: TargetKind::Issue,
            number,
            title: model::title(
                &d.field_str("title").unwrap_or_default(),
                &format!("Issue #{number}"),
            ),
            body: model::body(
                &self.header("issue", number, &d.owner_id, created, orig.as_ref()),
                &d.field_str("body").unwrap_or_default(),
                &key,
            ),
            imported: Self::provenance(&key, &d.owner_id, created, orig.as_ref()),
            closed: !state.open,
            merged_oid: None,
            labels: label_names(&state.labels),
            draft: false,
            patch: None,
            comments: self.comments(&d.id, number, "issue").await?,
            reviews: Vec::new(),
        }))
    }

    async fn patch(&self, d: &FetchedDocument, authz: &AuthzResolver) -> Result<Option<SrcTarget>> {
        let Some(number) = number(d) else {
            return Ok(None);
        };
        let base_ref_name = d
            .field_str("baseRefName")
            .filter(|b| rules::is_legal_ref_name(b))
            .unwrap_or_else(|| "refs/heads/main".into());
        let Some(head_oid) = d
            .field_bytes("headOid")
            .filter(|h| (20..=32).contains(&h.len()))
        else {
            return Ok(None);
        };
        let events = self.events(&d.id).await?;
        let scope = DocScope {
            contract_id: self.contract.id(),
            repo_id: None,
        };
        let history = forge_core::refs::read_ref_history(
            self.client,
            &self.contract,
            &scope,
            forge_core::backends::sha256(base_ref_name.as_bytes()),
        )
        .await?;
        let tips: BTreeSet<String> = history
            .iter()
            .map(|u| u.new_oid.clone())
            .filter(|o| !o.is_empty() && !o.bytes().all(|b| b == b'0'))
            .collect();
        let newest_tip = history
            .iter()
            .filter(|u| tips.contains(&u.new_oid))
            .max_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)))
            .map(|u| u.new_oid.clone());
        let state = rules::fold_pr_state(
            &events,
            &d.owner_id,
            authz,
            newest_tip.as_deref(),
            |oid, _| tips.contains(oid),
        );
        // The oid of the merge the fold applied: by a holder as of the event, and on the
        // base's history (the same test the fold used); the newest such, by (createdAt, id).
        let merged_oid = state
            .merged
            .then(|| {
                events
                    .iter()
                    .filter(|e| {
                        e.kind == EventKind::Merge
                            && authz.holdings_as_of(&e.actor, e.created_at).any()
                            && e.oid.as_deref().is_some_and(|o| tips.contains(o))
                    })
                    .max_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)))
                    .and_then(|e| e.oid.as_deref())
                    .and_then(model::oid)
            })
            .flatten();
        let orig = imported_of(d);
        let created = d.created_at.unwrap_or(0);
        let key = self.key(&format!("pulls/{number}"));
        Ok(Some(SrcTarget {
            kind: TargetKind::Patch,
            number,
            title: model::title(
                &d.field_str("title").unwrap_or_default(),
                &format!("Pull request #{number}"),
            ),
            body: model::body(
                &self.header("pull request", number, &d.owner_id, created, orig.as_ref()),
                &d.field_str("body").unwrap_or_default(),
                &key,
            ),
            imported: Self::provenance(&key, &d.owner_id, created, orig.as_ref()),
            closed: !state.open,
            merged_oid,
            labels: label_names(&state.labels),
            draft: state.draft,
            patch: Some(SrcPatch {
                base_ref_name,
                source_ref_name: None,
                head_oid,
            }),
            comments: self.comments(&d.id, number, "pull request").await?,
            reviews: self.reviews(&d.id, number).await?,
        }))
    }

    async fn reviews(&self, patch_id: &str, number: u32) -> Result<Vec<SrcReview>> {
        let mut reviews = Vec::new();
        for r in self.by("review", "patchId", patch_id).await? {
            let verdict = Verdict::from_code(r.field_u64("verdict").unwrap_or_default());
            if !matches!(
                verdict,
                Verdict::Approve | Verdict::RequestChanges | Verdict::Comment
            ) {
                continue;
            }
            let Some(commit_oid) = r
                .field_bytes("commitOid")
                .filter(|o| (20..=32).contains(&o.len()))
            else {
                continue;
            };
            let rorig = imported_of(&r);
            let rcreated = r.created_at.unwrap_or(0);
            let rkey = self.key(&format!("review/{}", r.id));
            reviews.push(SrcReview {
                verdict,
                commit_oid,
                body: model::body(
                    &self.header(
                        &format!("review ({}) on pull request", model::verdict_word(verdict)),
                        number,
                        &r.owner_id,
                        rcreated,
                        rorig.as_ref(),
                    ),
                    &r.field_str("body").unwrap_or_default(),
                    &rkey,
                ),
                imported: Self::provenance(&rkey, &r.owner_id, rcreated, rorig.as_ref()),
            });
        }
        Ok(reviews)
    }
}

/// A v1 release's assets, with only their public URIs (they are republished under the
/// migrator's identity, so a private, local or credentialed address must not be); an asset
/// left without any is dropped.
fn public_assets(json: Option<String>) -> Vec<ReleaseAsset> {
    json.and_then(|s| serde_json::from_str::<Vec<ReleaseAsset>>(&s).ok())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|mut a| {
            a.uris.retain(|u| model::is_public_uri(u));
            (!a.uris.is_empty()).then_some(a)
        })
        .collect()
}
