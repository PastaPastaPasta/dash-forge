//! `dg search issues|prs|repos`: gh's search, with the web search box's grammar
//! (`forge_core::rules::search`, the port of forge-web's `issue-query.ts` / `pull-query.ts`).
//!
//! Issues and PRs are searched in one repository: Platform has no text index, so a search
//! reads the repository's items and their state (as `dg issue list` and `dg pr list` do) and
//! filters them here. Every state is searched unless the query names one, as `gh search` does.
//! Repositories are found by name prefix (the `repo.name` index), by topic (`topic.byName`)
//! and by owner (`($ownerId, name)`).

use std::collections::BTreeSet;

use anyhow::Result;
use serde_json::json;

use forge_core::collab::v2::{IssueView, PatchView};
use forge_core::platform::{FieldValue, QueryFilter, QueryOrder};
use forge_core::rules::search::{
    matches_text, mentions, parse_issue_search, parse_pull_search, tokens, IssueQuery, Parsed,
    PullQuery,
};
use forge_core::rules::v2::{fold_thread_meta_v2, Role, RoleOracle};
use forge_core::user_error::codes;

use crate::common::Reader;
use crate::context::Ctx;
use crate::fmt::safe;
use crate::SearchCommand;

/// Dispatch a `search` subcommand.
pub async fn run(ctx: &Ctx, cmd: &SearchCommand) -> Result<()> {
    match cmd {
        SearchCommand::Issues(a) => Box::pin(issues(ctx, a)).await,
        SearchCommand::Prs(a) => Box::pin(prs(ctx, a)).await,
        SearchCommand::Repos(a) => repos(ctx, a).await,
    }
}

/// The search text: the words given, joined.
fn text_of(words: &[String]) -> String {
    words.join(" ")
}

/// `text` with every `author:` / `assignee:` / `review-requested:` value that names a DPNS
/// name rewritten to its identity id (the web's `resolveSearchNames`), the lookups made
/// together. A name DPNS does not know, or a value no DPNS name could be (`"bob smith"`), is
/// left as typed, as on the web (an `author:` login then matches mirrored items). A lookup
/// that fails for any other reason stops the search rather than match nothing.
async fn resolve_names(
    client: &forge_core::platform::PlatformClient,
    text: &str,
) -> Result<String> {
    let resolve = |tok: String| async move {
        let Some((key, value)) = tok.split_once(':') else {
            return Ok(tok);
        };
        let k = key.to_lowercase();
        let name = value.replace('"', "");
        let name = name.trim_start_matches('@');
        let person = matches!(k.as_str(), "author" | "assignee" | "review-requested");
        let keyword = matches!(name.to_lowercase().as_str(), "me" | "none" | "");
        if !person
            || keyword
            || forge_core::resolve::looks_like_identity_id(name)
            || forge_core::resolve::dpns_label(name).is_none()
        {
            return Ok(tok);
        }
        match forge_core::resolve::resolve_owner(client, name).await {
            Ok(id) => Ok(format!("{k}:{id}")),
            Err(forge_core::Error::User(u)) if u.code == codes::NOT_FOUND => Ok(tok),
            Err(e) => Err(anyhow::Error::from(e)),
        }
    };
    let out = futures::future::try_join_all(tokens(text).into_iter().map(resolve)).await?;
    Ok(out.join(" "))
}

/// The repository a search looks in and its query words. Inside a clone, a first word that
/// does not name a repository (`is:open`, `crash`, `feat/login`: anything `dg` reads as an
/// argument rather than a repository, [`crate::infer::names_a_repo`]) is the query's, and the
/// clone's repository is searched, as `gh search` does: clap reads the first of several words
/// as the repository. Another repository is named there as `@bob/other`, `bob.dash/other` or
/// with the owner's id, as everywhere in `dg`.
fn target(a: &crate::SearchArgs) -> Result<(String, Vec<String>)> {
    if a.limit == 0 {
        return Err(crate::errors::usage("--limit is at least 1"));
    }
    let mut query = a.query.clone();
    if let Some(here) = crate::storage::clone_repo() {
        if !crate::infer::names_a_repo(&a.repo, &here) {
            query.insert(0, a.repo.clone());
            return Ok((here, query));
        }
    }
    Ok((a.repo.clone(), query))
}

/// `me` as the reader's id; any other value as it is.
fn me_or(v: Option<&String>, me: Option<&str>) -> Option<String> {
    v.map(|w| {
        if w == "me" {
            me.unwrap_or_default().to_string()
        } else {
            w.clone()
        }
    })
}

/// What a row offers the shared filters.
struct Row<'a> {
    number: u64,
    title: &'a str,
    body: &'a str,
    author: &'a str,
    /// The source login a mirror recorded (`imported.author`).
    imported_author: Option<&'a str>,
    labels: &'a BTreeSet<String>,
    assignees: &'a BTreeSet<String>,
    milestone: Option<&'a str>,
}

/// The filters issues and PRs share (the web's `rowMatches`), with `me` resolved.
struct Filters<'a> {
    labels: &'a [String],
    not_labels: &'a [String],
    no_label: bool,
    milestone: Option<&'a str>,
    no_milestone: bool,
    author: Option<String>,
    author_login: Option<&'a str>,
    assignee: Option<String>,
    mentions: Option<(String, Option<String>)>,
    text: &'a str,
    scope: &'a str,
    /// Who may mirror (the owner and maintainers, the web's `readProvenanceTrust`): only
    /// their items' recorded source login counts.
    mirror_trust: Option<&'a RoleOracle>,
    owner: &'a str,
}

impl<'a> Filters<'a> {
    /// The row filters of `q` (a PR query's [`PullQuery::issue_part`]), `me` read as the
    /// reader's id, with the mention rule's id and DPNS name when `q.mentions`.
    fn of(
        q: &'a IssueQuery,
        me: Option<&str>,
        my_name: Option<String>,
        mirror_trust: Option<&'a RoleOracle>,
        owner: &'a str,
    ) -> Self {
        Self {
            labels: &q.labels,
            not_labels: &q.not_labels,
            no_label: q.no_label,
            milestone: q.milestone.as_deref(),
            no_milestone: q.no_milestone,
            author: me_or(q.author.as_ref(), me),
            author_login: q.author_login.as_deref(),
            assignee: me_or(q.assignee.as_ref(), me),
            mentions: q
                .mentions
                .then(|| (me.unwrap_or_default().to_string(), my_name)),
            text: &q.q,
            scope: &q.scope,
            mirror_trust,
            owner,
        }
    }

    fn matches(&self, r: &Row<'_>) -> bool {
        self.labels.iter().all(|l| r.labels.contains(l))
            && !self.not_labels.iter().any(|l| r.labels.contains(l))
            && (!self.no_label || r.labels.is_empty())
            && self.milestone.is_none_or(|m| r.milestone == Some(m))
            && (!self.no_milestone || r.milestone.is_none())
            && self.author.as_deref().is_none_or(|a| r.author == a)
            && self.author_login.is_none_or(|login| {
                let trusted = r.author == self.owner
                    || self
                        .mirror_trust
                        .is_some_and(|o| o.current_role(r.author) == Some(Role::Maintainer));
                trusted
                    && r.imported_author
                        .is_some_and(|l| l.eq_ignore_ascii_case(login))
            })
            && match self.assignee.as_deref() {
                None => true,
                Some("none") => r.assignees.is_empty(),
                Some(a) => r.assignees.contains(a),
            }
            && self
                .mentions
                .as_ref()
                .is_none_or(|(id, name)| mentions(r.body, id, name.as_deref()))
            && matches_text(self.text, r.title, r.number, r.body, self.scope)
    }
}

/// What a search could not apply: the grammar's unresolved tokens, and what dg does not read
/// (a comment count is one count read per item, so `comments:` and the comment sort).
fn not_applied(mut unresolved: Vec<String>, q: &IssueQuery) -> Vec<String> {
    if let Some(c) = &q.comments {
        unresolved.push(format!("comments:{c}"));
    }
    if q.sort == "comments" {
        unresolved.push("sort:comments-desc".into());
    }
    unresolved
}

/// Sort `rows` by creation time as `sort` asks (`oldest`, else newest first).
fn sort_by_created<T>(rows: &mut [T], sort: &str, created_at: impl Fn(&T) -> u64) {
    if sort == "oldest" {
        rows.sort_by_key(|r| created_at(r));
    } else {
        rows.sort_by_key(|r| std::cmp::Reverse(created_at(r)));
    }
}

/// The repository's role oracle, read only when an `author:<login>` filter needs it.
async fn mirror_trust(s: &Reader, q: &IssueQuery) -> Result<Option<RoleOracle>> {
    Ok(match q.author_login {
        Some(_) => Some(s.collab().member_oracle(&s.repo).await?),
        None => None,
    })
}

/// How many matches maintainers hid, and the flag that shows them (nothing when none).
fn print_hidden_omitted(omitted: usize) {
    if omitted > 0 {
        println!("({omitted} hidden by maintainers; --include-hidden shows them)");
    }
}

fn print_not_applied(ctx: &Ctx, skipped: &[String]) {
    if !ctx.json && !skipped.is_empty() {
        eprintln!(
            "note: not applied: {} (`dg search --help` lists the qualifiers)",
            safe(&skipped.join(" "))
        );
    }
}

/// The DPNS names of `ids`, for the human output.
async fn names_of<'a>(
    ctx: &Ctx,
    client: &forge_core::platform::PlatformClient,
    ids: impl IntoIterator<Item = &'a str>,
) -> std::collections::BTreeMap<String, String> {
    if ctx.json {
        return std::collections::BTreeMap::new();
    }
    client.dpns_first_names(ids).await
}

#[allow(clippy::too_many_lines)] // read, filter, sort, print: one search
async fn issues(ctx: &Ctx, a: &crate::SearchArgs) -> Result<()> {
    let (repo, words) = target(a)?;
    let s = Reader::open_discussion(ctx, &repo).await?;
    let text = resolve_names(&s.client, &text_of(&words)).await?;
    let base = IssueQuery {
        state: "all".into(),
        ..IssueQuery::default()
    };
    let Parsed {
        query: q,
        unresolved,
    } = parse_issue_search(&text, &base);
    let needs_me =
        q.author.as_deref() == Some("me") || q.assignee.as_deref() == Some("me") || q.mentions;
    let me = if needs_me { Some(s.me(ctx)?) } else { None };
    let my_name = async {
        match (&me, q.mentions) {
            (Some(id), true) => s.client.dpns_first_names([id.as_str()]).await.remove(id),
            _ => None,
        }
    };
    // members-only issues this reader cannot open are not searched (D30), only counted
    let issues = async {
        let read = s.collab().issues_with_state_read(&s.repo).await?;
        Ok::<_, anyhow::Error>((read.rows, read.malformed, read.members_only.len()))
    };
    let (my_name, reads) = futures::join!(
        my_name,
        futures::future::try_join(issues, mirror_trust(&s, &q))
    );
    let ((all, hidden, members_only), oracle) = reads?;
    let f = Filters::of(
        &q,
        me.as_deref(),
        my_name,
        oracle.as_ref(),
        s.repo.owner_id(),
    );
    let mut rows: Vec<(&IssueView, Option<String>)> = all
        .iter()
        .filter(|v| match q.state.as_str() {
            "open" => v.state.open,
            "closed" => !v.state.open,
            _ => true,
        })
        .map(|v| (v, fold_thread_meta_v2(&v.log.events).milestone))
        .filter(|(v, milestone)| {
            f.matches(&Row {
                number: u64::from(v.issue.number),
                title: &v.issue.title,
                body: &v.issue.body,
                author: &v.issue.author,
                imported_author: v.issue.imported.as_ref().map(|i| i.author.as_str()),
                labels: &v.state.labels,
                assignees: &v.state.assignees,
                milestone: milestone.as_deref(),
            })
        })
        .filter(|(v, _)| {
            q.reason.as_deref().is_none_or(|want| {
                forge_core::rules::v2::current_close_reason(&v.log.transitions, v.issue.number)
                    .is_some_and(|c| c.reason.as_str() == want)
            })
        })
        .collect();
    sort_by_created(&mut rows, &q.sort, |(v, _)| v.issue.created_at);
    // RC2 MOD: the matches a maintainer hid, from the events already read (`dg issue list`'s).
    let threads: Vec<_> = rows
        .iter()
        .map(|(v, _)| (v.issue.target(), v.log.events.as_slice()))
        .collect();
    let hides = s.collab().hidden_threads(&s.repo, &threads).await;
    let (mut rows, omitted) = crate::fmt::split_hidden(
        rows,
        &hides,
        |(v, _)| v.issue.document_id.as_str(),
        a.include_hidden,
    );
    let total = rows.len();
    rows.truncate(a.limit as usize);
    let skipped = not_applied(unresolved, &q);
    let (names, hider_names) = futures::join!(
        names_of(
            ctx,
            &s.client,
            rows.iter().map(|((v, _), _)| v.issue.author.as_str()),
        ),
        crate::common::hider_names(ctx, &s.client, rows.iter().filter_map(|(_, h)| *h))
    );
    let who = |id: &str| crate::fmt::with_name(id, &hider_names);
    ctx.emit(
        json!({
            "repo": s.repo.display(),
            "query": q,
            "notApplied": skipped,
            "total": total,
            "count": rows.len(),
            "hidden": hidden,
            "membersOnly": members_only,
            "hiddenOmitted": omitted,
            "issues": rows.iter().map(|((v, m), h)| crate::fmt::with_hidden_by(json!({
                "number": v.issue.number,
                "title": v.issue.title,
                "state": if v.state.open { "open" } else { "closed" },
                "author": v.issue.author,
                "labels": v.state.labels,
                "assignees": v.state.assignees,
                "milestone": m,
                "createdAt": v.issue.created_at,
            }), *h)).collect::<Vec<_>>(),
        }),
        || {
            print_not_applied(ctx, &skipped);
            if rows.is_empty() {
                println!("no issues match in {}", s.repo.display());
            }
            for ((v, _), h) in &rows {
                println!(
                    "#{:<5} {:<6} {}{}  by {}{}",
                    v.issue.number,
                    if v.state.open { "open" } else { "closed" },
                    safe(&v.issue.title),
                    labels_suffix(&v.state.labels),
                    crate::fmt::with_name(&v.issue.author, &names),
                    h.map(|h| crate::fmt::hidden_row_mark(h, &who))
                        .unwrap_or_default()
                );
            }
            if total > rows.len() {
                println!("({} of {total} shown; --limit for more)", rows.len());
            }
            print_hidden_omitted(omitted);
            if members_only > 0 {
                println!("({members_only} members-only issue(s) you can't read are not searched)");
            }
        },
    );
    Ok(())
}

/// ` [bug, docs]`, or nothing.
pub(crate) fn labels_suffix(labels: &BTreeSet<String>) -> String {
    if labels.is_empty() {
        String::new()
    } else {
        format!(
            "  [{}]",
            safe(&labels.iter().cloned().collect::<Vec<_>>().join(", "))
        )
    }
}

/// Whether a PR is in the list state (the web's PR states: `closed` is closed without
/// merging, `unmerged` open or closed without merging).
fn pr_state_matches(state: &str, v: &PatchView) -> bool {
    let (open, merged) = (v.state.open, v.state.merged);
    match state {
        "open" => open,
        "merged" => merged,
        "closed" => !open && !merged,
        "unmerged" => !merged,
        _ => true,
    }
}

#[allow(clippy::too_many_lines)] // read, filter, sort, print: one search
async fn prs(ctx: &Ctx, a: &crate::SearchArgs) -> Result<()> {
    let (repo, words) = target(a)?;
    let s = Reader::open_discussion(ctx, &repo).await?;
    let text = resolve_names(&s.client, &text_of(&words)).await?;
    let base = PullQuery {
        state: "all".into(),
        ..PullQuery::default()
    };
    let Parsed {
        query: q,
        unresolved,
    } = parse_pull_search(&text, &base);
    let needs_me = [&q.author, &q.assignee, &q.review_requested]
        .iter()
        .any(|v| v.as_deref() == Some("me"));
    let me = if needs_me { Some(s.me(ctx)?) } else { None };
    // The newest page of PRs (100), folded with their state in a fixed number of reads.
    let iq = q.issue_part();
    let page = async { Ok::<_, anyhow::Error>(s.collab().list_patch_views(&s.repo, 100).await?) };
    let (page, oracle) = Box::pin(futures::future::try_join(page, mirror_trust(&s, &iq))).await?;
    let f = Filters::of(&iq, me.as_deref(), None, oracle.as_ref(), s.repo.owner_id());
    let requested = me_or(q.review_requested.as_ref(), me.as_deref());
    let mut rows: Vec<&PatchView> = page
        .rows
        .iter()
        .map(|(v, _)| v)
        .filter(|v| pr_state_matches(&q.state, v))
        .filter(|v| q.draft.is_none_or(|d| v.state.draft == d))
        .filter(|v| {
            requested.as_deref().is_none_or(|r| {
                v.review
                    .requested_reviewers
                    .iter()
                    .any(|rr| rr.identity == r)
            })
        })
        .filter(|v| {
            f.matches(&Row {
                number: u64::from(v.patch.number),
                title: &v.patch.title,
                body: &v.patch.body,
                author: &v.patch.author,
                imported_author: v.patch.imported.as_ref().map(|i| i.author.as_str()),
                labels: &v.state.labels,
                assignees: &v.state.assignees,
                milestone: v.review.milestone.as_deref(),
            })
        })
        .collect();
    sort_by_created(&mut rows, &q.sort, |v| v.patch.created_at);
    // RC2 MOD: the matches a maintainer hid, from the events already read (`dg pr list`'s).
    let threads: Vec<_> = rows
        .iter()
        .map(|v| (v.patch.target(), v.log.events.as_slice()))
        .collect();
    let hides = s.collab().hidden_threads(&s.repo, &threads).await;
    let (mut rows, omitted) = crate::fmt::split_hidden(
        rows,
        &hides,
        |v| v.patch.document_id.as_str(),
        a.include_hidden,
    );
    let total = rows.len();
    rows.truncate(a.limit as usize);
    let skipped = not_applied(unresolved, &iq);
    let (names, hider_names) = futures::join!(
        names_of(
            ctx,
            &s.client,
            rows.iter().map(|(v, _)| v.patch.author.as_str())
        ),
        crate::common::hider_names(ctx, &s.client, rows.iter().filter_map(|(_, h)| *h))
    );
    let who = |id: &str| crate::fmt::with_name(id, &hider_names);
    ctx.emit(
        json!({
            "repo": s.repo.display(),
            "query": q,
            "notApplied": skipped,
            "total": total,
            "count": rows.len(),
            "searchedNewest": page.rows.len(),
            "truncated": page.more,
            "hiddenOmitted": omitted,
            "prs": rows.iter().map(|(v, h)| crate::fmt::with_hidden_by(json!({
                "number": v.patch.number,
                "title": v.patch.title,
                "state": crate::pr::state_field(v),
                "draft": v.state.draft,
                "author": v.patch.author,
                "labels": v.state.labels,
                "assignees": v.state.assignees,
                "milestone": v.review.milestone,
                "baseRefName": v.merge_base.ref_name,
                "headRefName": v.patch.source_ref_name,
                "createdAt": v.patch.created_at,
            }), *h)).collect::<Vec<_>>(),
        }),
        || {
            print_not_applied(ctx, &skipped);
            if rows.is_empty() {
                println!("no pull requests match in {}", s.repo.display());
            }
            for (v, h) in &rows {
                println!(
                    "#{:<5} {:<6} {}{}  by {}{}",
                    v.patch.number,
                    crate::pr::state_label(v),
                    safe(&v.patch.title),
                    labels_suffix(&v.state.labels),
                    crate::fmt::with_name(&v.patch.author, &names),
                    h.map(|h| crate::fmt::hidden_row_mark(h, &who))
                        .unwrap_or_default()
                );
            }
            if total > rows.len() {
                println!("({} of {total} shown; --limit for more)", rows.len());
            }
            print_hidden_omitted(omitted);
            if page.more {
                println!("(searched the newest {} pull requests)", page.rows.len());
            }
        },
    );
    Ok(())
}

/// The repo-name prefix of `text` (lowercased, the name part of `owner/name`), or `None` when
/// no repo name could start with it (names are `[a-z0-9._-]`): the web's `searchPrefix`.
fn name_prefix(text: &str) -> Option<String> {
    let t = text.trim().to_lowercase();
    let name = t.rsplit('/').next().unwrap_or("").to_string();
    (!name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-')))
    .then_some(name)
}

/// The exclusive upper bound of every string starting with `prefix` (its last char + 1).
fn prefix_upper(prefix: &str) -> String {
    let mut s = prefix.to_string();
    if let Some(last) = s.pop() {
        s.push(char::from_u32(last as u32 + 1).unwrap_or(last));
    }
    s
}

/// One repository found.
struct Found {
    repo: forge_core::scope::RepoRef,
    description: String,
}

#[allow(clippy::too_many_lines)] // three sources (owner, topic, name), then print
async fn repos(ctx: &Ctx, a: &crate::SearchReposArgs) -> Result<()> {
    let client = ctx.connect().await?;
    let forge = client.target().require_v2()?.clone();
    // Qualifiers: `topic:x`, `user:x` / `owner:x` / `org:x`; the rest is the name prefix.
    let mut topic = a.topic.clone();
    let mut owner = a.owner.clone();
    let mut words = Vec::new();
    for tok in tokens(&text_of(&a.query)) {
        match tok.split_once(':') {
            Some((k, v)) if k.eq_ignore_ascii_case("topic") => {
                topic = Some(v.replace('"', ""));
            }
            Some((k, v)) if matches!(k.to_lowercase().as_str(), "user" | "owner" | "org") => {
                owner = Some(v.replace('"', ""));
            }
            _ => words.push(tok),
        }
    }
    let text = words.join(" ");
    // Topics are lower case (`topic.name`'s pattern), as on GitHub.
    let topic = topic.map(|t| t.trim().to_lowercase());
    let owner_id = match &owner {
        Some(o) => {
            Some(forge_core::resolve::resolve_owner(&client, o.trim_start_matches('@')).await?)
        }
        None => None,
    };
    let core = client.fetch_contract(&forge.core).await?;
    let limit = a.limit.clamp(1, 100);
    // Narrowed after the read (by owner or words): read a full page, else just what is shown.
    let topic_reads = if owner_id.is_some() || !text.trim().is_empty() {
        100
    } else {
        limit
    };
    let from_docs = |docs: Vec<forge_core::platform::FetchedDocument>| -> Vec<Found> {
        docs.iter()
            .filter_map(|d| {
                Some(Found {
                    repo: forge_core::resolve::repo_ref_from_doc(&forge, d).ok()?,
                    description: d.field_str("description").unwrap_or_default(),
                })
            })
            .collect()
    };
    let mut found: Vec<Found> = if let Some(t) = &topic {
        let ids: Vec<FieldValue> = client
            .query_documents(
                &core,
                forge_core::collab::parity::DOC_TOPIC,
                &[QueryFilter::eq("name", FieldValue::text(t.as_str()))],
                &[QueryOrder::desc("$createdAt")],
                topic_reads,
                None,
            )
            .await?
            .iter()
            .filter_map(|d| d.field_bytes32("repoId"))
            .map(FieldValue::identifier)
            .collect();
        if ids.is_empty() {
            Vec::new()
        } else {
            // The tagged repositories in one read (at most 100 ids, Drive's `in` bound).
            let n = u32::try_from(ids.len()).unwrap_or(100);
            let docs = client
                .query_documents(
                    &core,
                    forge_core::resolve::DOC_REPO,
                    &[QueryFilter::in_list("$id", ids)],
                    &[],
                    n,
                    None,
                )
                .await?;
            from_docs(docs)
        }
    } else if let Some(id) = &owner_id {
        forge_core::resolve::list_owned(&client, id)
            .await?
            .into_iter()
            .map(|r| Found {
                repo: r.repo,
                description: r.description,
            })
            .collect()
    } else {
        let Some(prefix) = name_prefix(&text) else {
            return Err(crate::errors::usage(
                "name what to search for: a repository name (or its start), topic:<name> or owner:<name>",
            ));
        };
        let docs = client
            .query_documents(
                &core,
                forge_core::resolve::DOC_REPO,
                &[
                    QueryFilter::gte("name", FieldValue::text(prefix.as_str())),
                    QueryFilter {
                        field: "name".into(),
                        op: forge_core::platform::QueryOp::Lt,
                        value: FieldValue::text(prefix_upper(&prefix)),
                    },
                ],
                &[QueryOrder::asc("name")],
                limit,
                None,
            )
            .await?;
        from_docs(docs)
    };
    // With an owner or a topic, the text narrows by name or description (case-insensitive),
    // and a topic's repositories by owner.
    if let (Some(id), Some(_)) = (&owner_id, &topic) {
        found.retain(|f| f.repo.owner_id() == id);
    }
    if owner_id.is_some() || topic.is_some() {
        let words: Vec<String> = text.split_whitespace().map(str::to_lowercase).collect();
        found.retain(|f| {
            let hay = format!("{} {}", f.repo.name(), f.description).to_lowercase();
            words.iter().all(|w| hay.contains(w))
        });
    }
    found.truncate(limit as usize);
    let names = names_of(ctx, &client, found.iter().map(|f| f.repo.owner_id())).await;
    ctx.emit(
        json!({
            "count": found.len(),
            "repos": found.iter().map(|f| json!({
                "ownerId": f.repo.owner_id(),
                "name": f.repo.name(),
                "repoId": f.repo.id(),
                "fullName": f.repo.display(),
                "description": f.description,
                "visibility": f.repo.visibility,
            })).collect::<Vec<_>>(),
        }),
        || {
            if found.is_empty() {
                println!("no repositories match");
            }
            for f in &found {
                let owner = names
                    .get(f.repo.owner_id())
                    .map_or_else(|| f.repo.owner_id().to_string(), |n| safe(n).to_string());
                let private = if f.repo.visibility == forge_core::rules::v2::Visibility::Private {
                    "  (private)"
                } else {
                    ""
                };
                let description = if f.description.is_empty() {
                    String::new()
                } else {
                    format!("  {}", safe(&f.description))
                };
                println!("{owner}/{}{private}{description}", f.repo.name());
            }
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{name_prefix, prefix_upper};

    /// Inside a clone, the first of several query words is the query's unless it names a
    /// repository (clap reads it as one).
    #[test]
    fn inside_a_clone_a_qualifier_is_no_repository() {
        use crate::infer::names_a_repo;
        let here = "alice/project";
        assert!(!names_a_repo("is:open", here));
        assert!(!names_a_repo("crash", here));
        assert!(!names_a_repo("label:a/b", here));
        // A path or a branch is a query word, as for every other command.
        assert!(!names_a_repo("feat/login", here));
        assert!(!names_a_repo("src/main.rs", here));
        assert!(names_a_repo("project", here));
        assert!(names_a_repo("@bob/other", here));
        assert!(names_a_repo("bob.dash/other", here));
    }

    /// The web's `searchPrefix`: the name part, lowercased; nothing a name cannot start with.
    #[test]
    fn a_repo_search_reads_a_name_prefix() {
        assert_eq!(name_prefix("Forge"), Some("forge".into()));
        assert_eq!(name_prefix("alice/dash-f"), Some("dash-f".into()));
        assert_eq!(name_prefix("two words"), None);
        assert_eq!(name_prefix(""), None);
        assert_eq!(prefix_upper("dash"), "dasi");
    }
}
