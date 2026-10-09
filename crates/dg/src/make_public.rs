//! `dg make-public`: an author makes their own members-only posts public (mixed-visibility
//! DESIGN §4.6, §10). An issue or comment is edited to Public as it reads now (a pull request
//! waits for members-only PRs, phase 3); a review, which cannot be edited, gets a public comment
//! attached to it that carries its text.
//! Someone else's post is refused before anything is signed. Every post named is checked first,
//! and nothing is written unless all of them can be made public.

use std::collections::BTreeSet;

use anyhow::Result;
use serde_json::json;

use forge_core::collab::long_body::BodyField;
use forge_core::collab::v2::{Collab, MakePublicPlan, TargetKind, TargetRead};
use forge_core::platform::FetchedDocument;
use forge_core::private::DocKind;
use forge_core::rules::v2::Audience;
use forge_core::scope::RepoRef;
use forge_core::user_error::{codes, UserError};

use crate::common::Session;
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line};
use crate::long_body::Planned;

/// Where a post's id is listed, for an id that names none.
const POST_IDS: &str =
    "`dg issue view <repo> <n> --json` (or `dg pr view <repo> <n> --comments --json`)";

/// One post to make public, planned: what is written and its full text.
struct Post {
    plan: MakePublicPlan,
    /// The body's full text (a long one read whole), when it has one.
    body: Option<String>,
}

/// `dg make-public <repo> <post>…`.
pub async fn run(ctx: &Ctx, repo: &str, posts: &[String]) -> Result<()> {
    let s = Session::open_for_write(ctx, repo, "nothing made public").await?;
    let collab = s.collab();
    // every post is found first, so a comment whose issue is made public in the same command
    // counts its conversation as public
    let mut found = Vec::new();
    for p in posts {
        found.push(find(&collab, &s.repo, p).await?);
    }
    let going: BTreeSet<String> = found.iter().map(|(_, d)| d.id.clone()).collect();
    let mut planned = Vec::new();
    for post in found {
        let post = plan(&collab, &s.repo, post, &going).await?;
        // nothing is stored for a replace that would be refused
        collab.check_make_public(&s.repo, &post.plan)?;
        planned.push(post);
    }
    let bodies = planned
        .iter()
        .map(|p| {
            p.body
                .as_deref()
                .map(|b| Planned::new(&s.repo, body_field(&p.plan), None, b, Audience::Public))
                .transpose()
        })
        .collect::<Result<Vec<_>>>()?;
    let quote: u64 = planned
        .iter()
        .zip(&bodies)
        .map(|(p, b)| {
            let bytes = p.plan.texts().iter().map(|t| t.len()).sum();
            let est = if p.plan.kind == DocKind::Review {
                crate::pr::Est::Comment
            } else {
                crate::pr::Est::Replace
            };
            crate::pr::estimate(est, bytes) + b.as_ref().map_or(0, |b| b.extra_credits(&s.repo))
        })
        .sum();
    if !ctx.json {
        for p in &planned {
            println!("{}", question(&p.plan));
            if p.plan.changes.lost.iter().any(|f| f == "path") {
                println!(
                    "  Its file name can't be made public, so the comment will show without it."
                );
            }
        }
    }
    let clauses: String = bodies.iter().flatten().map(Planned::clause).collect();
    ctx.confirm_or_cancel(&format!(
        "Make {} public? ({}{clauses})",
        crate::fmt::plural(planned.len(), "post"),
        cost_line(quote, ctx.usd_price())
    ))?;
    let before = s.balance().await;
    let written = write_all(&collab, &s.repo, &planned, &bodies).await?;
    let spent = s.spent_since(before).await;
    let price = ctx.usd_price();
    ctx.emit(
        json!({
            "status": "madePublic",
            "posts": written.iter().map(|(p, id)| json!({
                "id": p.plan.id,
                "kind": p.plan.noun(),
                "number": p.plan.number,
                "written": id,
                "lost": p.plan.changes.lost,
            })).collect::<Vec<_>>(),
            "cost": cost_json(spent, price),
        }),
        || {
            for (p, id) in &written {
                match p.plan.kind {
                    DocKind::Review => println!(
                        "✓ made the text of review {} public (comment {id})",
                        p.plan.id
                    ),
                    _ => println!("✓ made {} public", label(&p.plan)),
                }
            }
            println!("  {}", cost_line(spent, price));
        },
    );
    Ok(())
}

/// Make every planned post public, in order. A failure after the first says which are public
/// already: the headline alone ("nothing made public") would not.
async fn write_all<'p>(
    collab: &Collab<'_>,
    repo: &RepoRef,
    planned: &'p [Post],
    bodies: &[Option<Planned<'_>>],
) -> Result<Vec<(&'p Post, String)>> {
    let mut written: Vec<(&Post, String)> = Vec::new();
    for (p, b) in planned.iter().zip(bodies) {
        let one = async {
            let field = match b {
                Some(b) => Some(b.field_text(collab, repo, None).await?),
                None => None,
            };
            anyhow::Ok(collab.make_public(repo, &p.plan, field.as_deref()).await?)
        };
        match one.await {
            Ok(id) => written.push((p, id)),
            Err(e) if !written.is_empty() => {
                let done: Vec<String> = written.iter().map(|(p, _)| label(&p.plan)).collect();
                return Err(e.context(format!(
                    "made public: {}; then {} failed",
                    done.join(", "),
                    label(&p.plan)
                )));
            }
            Err(e) => return Err(e),
        }
    }
    Ok(written)
}

/// The question §10 asks before a post is made public.
fn question(plan: &MakePublicPlan) -> String {
    if plan.kind == DocKind::Review {
        return format!(
            "Make your review's text public? It's added as a public comment on your review ({}). This can't be undone.",
            plan.id
        );
    }
    format!(
        "Make your {} public? Everyone will be able to read it as you save it now. Earlier versions stay members-only. This can't be undone.",
        label(plan)
    )
}

/// "issue #3", "comment 7bY…".
fn label(plan: &MakePublicPlan) -> String {
    match plan.number {
        Some(n) => format!("{} #{n}", plan.noun()),
        None => format!("{} {}", plan.noun(), plan.id),
    }
}

/// The field a post's public body goes in (an inline comment's path is not kept).
fn body_field(plan: &MakePublicPlan) -> BodyField<'_> {
    let title = plan.changes.set.get("title").map_or("", String::as_str);
    match plan.kind {
        DocKind::Issue => BodyField::Issue { title },
        DocKind::Patch => BodyField::Patch {
            title,
            base_ref_name: "",
            source_ref_name: "",
        },
        _ => BodyField::Comment { path: None },
    }
}

/// Find post `arg` of `repo`: a document id, or an issue's or PR's number (`3`, `#3`).
async fn find(
    collab: &Collab<'_>,
    repo: &RepoRef,
    arg: &str,
) -> Result<(DocKind, FetchedDocument)> {
    let id = if let Ok(n) = arg.trim_start_matches('#').parse::<u32>() {
        number_id(collab, repo, n).await?
    } else {
        crate::common::document_id_arg(arg, "post id", POST_IDS)?;
        arg.to_string()
    };
    collab.find_post(repo, &id).await?.ok_or_else(|| {
        UserError::new(
            codes::NOT_FOUND,
            format!(
                "{} is not an issue, pull request, comment or review of {}",
                crate::fmt::safe(arg),
                repo.display()
            ),
        )
        .fix(format!("{POST_IDS} lists the ids"))
        .into()
    })
}

/// Plan making post `stored` public, its long body read whole; `going`: the ids of every post of
/// this command (a comment's conversation counts them as public).
async fn plan(
    collab: &Collab<'_>,
    repo: &RepoRef,
    (kind, stored): (DocKind, FetchedDocument),
    going: &BTreeSet<String>,
) -> Result<Post> {
    let mut plan = collab.make_public_plan(repo, kind, stored, going).await?;
    let mut body = plan.changes.set.get("body").cloned();
    if let Some(b) = body.as_mut() {
        // a long body continues in a members-only artifact: read it whole, so the public one
        // carries all of it
        let why = crate::long_body::read_in_place(collab, repo, vec![(b, plan.audience)]).await;
        if let Some(why) = why.into_iter().flatten().next() {
            return Err(UserError::new(
                codes::USAGE,
                format!("the full text of {} could not be read: {why}", label(&plan)),
            )
            .note("nothing was written")
            .into());
        }
        plan.changes.set.insert("body".to_string(), b.clone());
    }
    Ok(Post { plan, body })
}

/// The document id of issue or PR number `n` of `repo`.
async fn number_id(collab: &Collab<'_>, repo: &RepoRef, n: u32) -> Result<String> {
    for kind in [TargetKind::Issue, TargetKind::Patch] {
        match collab.target_read(repo, kind, n).await? {
            Some(TargetRead::Readable(d)) => return Ok(d.id),
            Some(TargetRead::MembersOnly(m)) => return Ok(m.document_id),
            None => {}
        }
    }
    Err(UserError::new(
        codes::NOT_FOUND,
        format!("{} has no issue or pull request #{n}", repo.display()),
    )
    .into())
}
