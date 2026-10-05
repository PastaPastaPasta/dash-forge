//! Labels, assignees and the milestone of an issue or a pull request, as `gh issue edit` /
//! `gh pr edit` change them (`--add-label`, `--remove-assignee`, `--milestone`, …): every
//! change is one member `event` (kinds 4–7, 17, 18), planned and checked before anything is
//! signed, confirmed once, then written in order.
//!
//! A label must be one the repository defines (spelt as defined), a milestone an open one; a
//! label or assignee already on (or already off) the item is skipped, as is a milestone it is
//! already in (QW-035). Maintainers, writers and triage members only (`forge-v2.md` §2.1).

use std::collections::BTreeSet;

use anyhow::{Context as _, Result};

use forge_core::collab::v2::Target;
use forge_core::platform::PlatformClient;
use forge_core::rules::v2::Role;
use forge_core::rules::EventKind;
use forge_core::user_error::{codes, UserError};

use crate::common::Session;
use crate::fmt::safe;

/// The metadata changes an `edit` asks for.
#[derive(Debug, Default, Clone)]
pub struct MetaEdit {
    /// Labels to add.
    pub add_labels: Vec<String>,
    /// Labels to remove.
    pub remove_labels: Vec<String>,
    /// Assignees to add (ids, DPNS names, `@me`).
    pub add_assignees: Vec<String>,
    /// Assignees to remove.
    pub remove_assignees: Vec<String>,
    /// A milestone change.
    pub milestone: Option<MilestoneChange>,
}

/// What an edit does to the milestone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MilestoneChange {
    /// Put it in this (open) milestone.
    Set(String),
    /// Take it out of its milestone.
    Clear,
}

impl MetaEdit {
    /// Whether nothing is asked.
    pub fn is_empty(&self) -> bool {
        self.add_labels.is_empty()
            && self.remove_labels.is_empty()
            && self.add_assignees.is_empty()
            && self.remove_assignees.is_empty()
            && self.milestone.is_none()
    }
}

/// What an issue or PR carries now, when `known`: not when a private repository's sealed
/// value did not open, and then every change asked for is written.
#[derive(Debug, Default, Clone)]
pub struct Current {
    /// Whether the fields below are what the item carries.
    pub known: bool,
    /// Its labels.
    pub labels: BTreeSet<String>,
    /// Its assignees (identity ids).
    pub assignees: BTreeSet<String>,
    /// Its milestone.
    pub milestone: Option<String>,
}

impl Current {
    /// What a folded item carries, known only when every value in its log was readable
    /// (`readable`: no sealed value failed to open).
    pub fn of(
        readable: bool,
        labels: &BTreeSet<String>,
        assignees: &BTreeSet<String>,
        milestone: Option<String>,
    ) -> Self {
        Self {
            known: readable,
            labels: labels.clone(),
            assignees: assignees.clone(),
            milestone,
        }
    }

    fn labels(&self) -> Option<&BTreeSet<String>> {
        self.known.then_some(&self.labels)
    }

    fn assignees(&self) -> Option<&BTreeSet<String>> {
        self.known.then_some(&self.assignees)
    }
}

/// One event an edit writes.
#[derive(Debug, Clone)]
pub struct Planned {
    /// The event kind.
    pub kind: EventKind,
    /// Its `value` (a label, an identity, a milestone title, a base ref).
    pub value: Option<String>,
    /// What it does, for the prompt and the summary (`add label bug`).
    pub phrase: String,
    /// Its estimated credits.
    pub quote: u64,
}

impl Planned {
    /// An event of `kind` with `value`, quoted as a member event (`addressee`: it also writes
    /// an `addressee` index entry, as an assignee's `refId` does).
    pub fn new(kind: EventKind, value: Option<String>, phrase: String, addressee: bool) -> Self {
        let quote = crate::quote::event(value.as_deref().map_or(0, str::len) as u64, addressee);
        Self {
            kind,
            value,
            phrase,
            quote,
        }
    }
}

/// An edit's plan: the events to write and what was asked but would change nothing.
#[derive(Debug, Default)]
pub struct Plan {
    /// The events, in the order they are written.
    pub events: Vec<Planned>,
    /// Changes left out because the item already reads that way (`bug already on`).
    pub unchanged: Vec<String>,
}

/// Plan `edit` on an item that carries `current`: refused (E102, E601) before anything is
/// signed when a label or milestone is not defined, a milestone is closed, or the signer is
/// not a maintainer, writer or triage member.
pub async fn plan(s: &Session, edit: &MetaEdit, current: &Current, what: &str) -> Result<Plan> {
    let mut plan = Plan::default();
    if edit.is_empty() {
        return Ok(plan);
    }
    let collab = s.collab();
    collab
        .require_role(
            &s.repo,
            Role::Triage,
            &format!("change the labels, assignees or milestone of {what}"),
        )
        .await?;
    let repo = s.repo.display();
    if !edit.add_labels.is_empty() {
        let defined = collab
            .labels(&s.repo)
            .await
            .context("reading the repository's labels")?;
        let names = defined_labels(&trimmed(&edit.add_labels), &defined, &repo)?;
        let names = spelt_as_on(&names, current.labels());
        push_changes(&mut plan, &names, current.labels(), true, |n| {
            Planned::new(
                EventKind::LabelAdd,
                Some(n.to_string()),
                format!("add label {}", safe(n)),
                false,
            )
        });
    }
    if !edit.remove_labels.is_empty() {
        let names = spelt_as_on(&trimmed(&edit.remove_labels), current.labels());
        push_changes(&mut plan, &names, current.labels(), false, |n| {
            Planned::new(
                EventKind::LabelRemove,
                Some(n.to_string()),
                format!("remove label {}", safe(n)),
                false,
            )
        });
    }
    for (who, add) in [(&edit.add_assignees, true), (&edit.remove_assignees, false)] {
        if who.is_empty() {
            continue;
        }
        let mut ids = Vec::with_capacity(who.len());
        for w in &trimmed(who) {
            ids.push(identity_arg(&s.client, || Ok(s.identity.id()), w).await?);
        }
        push_changes(&mut plan, &ids, current.assignees(), add, |id| {
            let (kind, verb) = if add {
                (EventKind::Assign, "assign")
            } else {
                (EventKind::Unassign, "unassign")
            };
            Planned::new(kind, Some(id.to_string()), format!("{verb} {id}"), true)
        });
    }
    match &edit.milestone {
        None => {}
        Some(MilestoneChange::Set(title)) => {
            require_open_milestone(s, title).await?;
            if current.known && current.milestone.as_deref() == Some(title.as_str()) {
                plan.unchanged
                    .push(format!("already in milestone {}", safe(title)));
            } else {
                plan.events.push(Planned::new(
                    EventKind::MilestoneSet,
                    Some(title.clone()),
                    format!("put it in milestone {}", safe(title)),
                    false,
                ));
            }
        }
        Some(MilestoneChange::Clear) => {
            if current.known && current.milestone.is_none() {
                plan.unchanged.push("in no milestone".into());
            } else {
                plan.events.push(Planned::new(
                    EventKind::MilestoneClear,
                    None,
                    "take it out of its milestone".into(),
                    false,
                ));
            }
        }
    }
    Ok(plan)
}

/// Write `planned` on `target`, in order; the event ids. An assignee event names the identity
/// in `refId` too (the `addressee` index behind "assigned to me").
pub async fn write(s: &Session, target: &Target, planned: &[Planned]) -> Result<Vec<String>> {
    let collab = s.collab();
    let mut ids = Vec::with_capacity(planned.len());
    for p in planned {
        let id = match (p.kind, p.value.as_deref()) {
            (EventKind::Assign | EventKind::Unassign, Some(who)) => {
                collab
                    .set_assignee(&s.repo, target, who, p.kind == EventKind::Assign)
                    .await?
            }
            (kind, value) => {
                collab
                    .post_event(&s.repo, target, kind, value, None)
                    .await?
            }
        };
        ids.push(id);
    }
    Ok(ids)
}

/// An `edit` of an issue or a PR: the document replace (title, body; its author only) and the
/// planned events, confirmed once and written replace first.
pub struct Edit<'a> {
    /// `issue` or `PR`, for messages.
    pub noun: &'static str,
    /// The JSON key naming the number (`issue` / `pr`).
    pub key: &'static str,
    /// The item's number.
    pub number: u64,
    /// The item as a target.
    pub target: Target,
    /// The new title.
    pub title: Option<&'a str>,
    /// The new body.
    pub body: Option<&'a str>,
    /// How `body` is written: whole, or (over its field) as a long body's artifact and the
    /// field naming it (forge-v2.md §6.3). Set when `body` is.
    pub long: Option<crate::long_body::Planned<'a>>,
    /// With a new title alone: the stored long body cut again for the room the title leaves
    /// (`crate::long_body::refit_kept`), written in the same replace.
    pub refit: Option<String>,
    /// The item's imported provenance, which shares a private item's sealed room with the body.
    pub imported: Option<&'a forge_core::collab::Imported>,
    /// Said after the replace's price (a private PR's epoch note).
    pub replace_note: String,
    /// The events to write (labels, assignees, milestone, a PR's retarget).
    pub plan: Plan,
    /// The `title` field of the JSON answer.
    pub title_json: serde_json::Value,
}

/// Carry out `e`: refused before the prompt when a title or body change is asked by someone
/// who is not the author (consensus admits an edit from the author only); nothing written
/// when nothing would change.
pub async fn run_edit(ctx: &crate::context::Ctx, s: &Session, e: Edit<'_>) -> Result<()> {
    use crate::fmt::{cost_json, cost_line};
    use serde_json::json;
    let (noun, number) = (e.noun, e.number);
    let replace = e.title.is_some() || e.body.is_some();
    if replace && s.identity.id() != e.target.author {
        return Err(UserError::new(
            codes::NOT_A_WRITER,
            format!("{noun} #{number} not edited: only its author can change its title or description"),
        )
        .cause("consensus admits a replace of an issue or PR from its author only")
        .fix("ask the author to edit it; members can still label, assign, set a milestone (and retarget a PR) without --title/--body")
        .note("checked before anything was signed; nothing was written or paid")
        .into());
    }
    let unchanged_json = e.plan.unchanged.clone();
    if !replace && e.plan.events.is_empty() {
        ctx.emit(
            json!({ "status": "unchanged", e.key: number, "written": false, "unchanged": unchanged_json }),
            || println!("{noun} #{number}: {}; nothing written", e.plan.unchanged.join(", ")),
        );
        return Ok(());
    }
    if !ctx.json && !e.plan.unchanged.is_empty() {
        println!("{noun} #{number}: {}; skipped", e.plan.unchanged.join(", "));
    }
    let replace_quote = if replace {
        let body_bytes = e.long.as_ref().map_or_else(
            || e.body.map_or(0, str::len),
            |p| usize::try_from(p.field_bytes()).unwrap_or(usize::MAX),
        );
        crate::pr::estimate(
            crate::pr::Est::Replace,
            e.title.map_or(0, str::len) + body_bytes,
        ) + e.long.as_ref().map_or(0, |p| p.extra_credits(&s.repo))
    } else {
        0
    };
    let quote = replace_quote + e.plan.events.iter().map(|p| p.quote).sum::<u64>();
    let (what, docs) = edit_words(&e);
    ctx.confirm_or_cancel(&format!(
        "Edit {noun} #{number}: {}? ({docs}, {}{}{})",
        what.join("; "),
        cost_line(quote, ctx.usd_price()),
        e.long
            .as_ref()
            .map_or_else(String::new, crate::long_body::Planned::clause),
        e.replace_note
    ))?;
    let before = s.balance().await;
    let replaced = if replace {
        let collab = s.collab();
        // a long body's full text is stored first; a new title alone carries a refit body
        let body = match &e.long {
            Some(p) => {
                // an edit keeps the item's audience
                let audience = collab.audience_of_target(&s.repo, &e.target.id).await?;
                Some(p.field_text(&collab, &s.repo, e.imported, audience).await?)
            }
            None => e.refit.clone(),
        };
        collab
            .update_target(&s.repo, &e.target, e.title, body.as_deref())
            .await?
    } else {
        false
    };
    let ids = write(s, &e.target, &e.plan.events).await?;
    let spent = s.spent_since(before).await;
    let price = ctx.usd_price();
    let written = replaced || !ids.is_empty();
    ctx.emit(
        json!({
            "status": if written { "edited" } else { "unchanged" },
            e.key: number,
            "written": written,
            "title": e.title_json,
            "bodyChanged": e.body.is_some(),
            "changes": e.plan.events.iter().map(|p| json!({
                "kind": p.kind,
                "value": p.value,
            })).collect::<Vec<_>>(),
            "eventIds": ids,
            "unchanged": unchanged_json,
            "cost": cost_json(spent, price),
        }),
        || {
            if written {
                println!(
                    "✓ edited {noun} #{number}: {} · {}",
                    what.join("; "),
                    cost_line(spent, price)
                );
            } else {
                println!("{noun} #{number} already reads that way; nothing written");
            }
        },
    );
    Ok(())
}

/// What `e` does (`replace the title; add label bug`) and what it writes (`one document replace
/// and 1 event`), for the prompt and the summary.
fn edit_words(e: &Edit<'_>) -> (Vec<String>, String) {
    let replace = e.title.is_some() || e.body.is_some();
    let mut what: Vec<String> = Vec::new();
    if replace {
        what.push(
            match (e.title.is_some(), e.body.is_some()) {
                (true, true) => "replace the title and description",
                (true, false) => "replace the title",
                _ => "replace the description",
            }
            .into(),
        );
    }
    what.extend(e.plan.events.iter().map(|p| p.phrase.clone()));
    let n = e.plan.events.len();
    let events = format!("{n} event{}", if n == 1 { "" } else { "s" });
    let docs = match (replace, n) {
        (true, 0) => "one document replace".to_string(),
        (false, _) => events,
        (true, _) => format!("one document replace and {events}"),
    };
    (what, docs)
}

/// Split `wanted` into the changes an add (or a removal) would make, pushed onto `plan` by
/// `event`, and those it would not, recorded as unchanged ([`changes`]).
fn push_changes(
    plan: &mut Plan,
    wanted: &[String],
    current: Option<&BTreeSet<String>>,
    add: bool,
    event: impl Fn(&str) -> Planned,
) {
    let (write, same) = changes(wanted, current, add);
    plan.events.extend(write.iter().map(|w| event(w)));
    let already = if add { "already on" } else { "not on" };
    plan.unchanged
        .extend(same.iter().map(|w| format!("{} {already}", safe(w))));
}

/// The milestone `title` must be one the repository defines, and open (E102 / E104).
pub async fn require_open_milestone(s: &Session, title: &str) -> Result<()> {
    let repo = s.repo.display();
    let defined = s.collab().milestones(&s.repo, &[]).await?;
    match defined.iter().find(|m| m.title == title) {
        Some(m) if !m.closed => Ok(()),
        Some(_) => Err(crate::errors::usage(format!(
            "milestone {title:?} is closed: reopen it first (`dg milestone close {repo} {title:?} --reopen`)"
        ))),
        None => Err(crate::errors::not_found(
            format!("no milestone {title:?} in {repo}"),
            format!("`dg milestone list {repo}` lists them; `dg milestone create` defines one"),
        )),
    }
}

/// Label names (or identities) as the web writes them: trimmed (the fold compares them
/// exactly), and none empty (`--add-label "bug, docs,"`).
pub fn trimmed(names: &[String]) -> Vec<String> {
    names
        .iter()
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .collect()
}

/// `me`, a DPNS name or an identity id (`who`), as a base58 identity id. The `me` closure
/// gives the caller's own id; it is called only when `who` is `me`, so a read that names
/// nobody never opens the key.
pub async fn identity_arg(
    client: &PlatformClient,
    me: impl FnOnce() -> Result<String>,
    who: &str,
) -> Result<String> {
    if who == "me" || who == "@me" {
        return me();
    }
    Ok(forge_core::resolve::resolve_owner(client, who.trim_start_matches('@')).await?)
}

/// Split the `wanted` labels or assignees into those an add (or a removal) would change and
/// those it would not, given what the item has now (`current`; `None`: unknown, so every
/// one is written). A name given twice is written once.
pub fn changes(
    wanted: &[String],
    current: Option<&BTreeSet<String>>,
    add: bool,
) -> (Vec<String>, Vec<String>) {
    let mut write = Vec::new();
    let mut unchanged = Vec::new();
    for w in wanted {
        if write.contains(w) || unchanged.contains(w) {
            continue;
        }
        if current.is_some_and(|c| c.contains(w) == add) {
            unchanged.push(w.clone());
        } else {
            write.push(w.clone());
        }
    }
    (write, unchanged)
}

/// `wanted` as the repository's live (not retired) label definitions spell them, matched
/// without regard to case as the web's picker does; E102 naming the ones it lacks, and the
/// labels it has, before anything is signed (QW2-015; `gh issue edit --add-label` refuses a
/// label that does not exist the same way).
pub fn defined_labels(
    wanted: &[String],
    defined: &[forge_core::collab::Label],
    repo: &str,
) -> Result<Vec<String>> {
    let live: Vec<&str> = defined
        .iter()
        .filter(|l| !l.retired)
        .map(|l| l.name.as_str())
        .collect();
    let mut out = Vec::with_capacity(wanted.len());
    let mut missing = Vec::new();
    for w in wanted {
        match live.iter().find(|d| d.eq_ignore_ascii_case(w)) {
            Some(d) => out.push((*d).to_string()),
            None => missing.push(w.clone()),
        }
    }
    if missing.is_empty() {
        return Ok(out);
    }
    let have = if live.is_empty() {
        "it defines no labels".to_string()
    } else {
        format!("its labels: {}", safe(&live.join(", ")))
    };
    let first = crate::storage_wizard::shell_word(missing.first().map_or("", String::as_str));
    Err(UserError::new(
        codes::NOT_FOUND,
        format!(
            "label not changed: {} {} not defined in {repo}",
            label_list(&missing),
            if missing.len() == 1 { "is" } else { "are" }
        ),
    )
    .cause(have)
    .fix(format!(
        "define it first: `dg label create {repo} {}`",
        safe(&first)
    ))
    .note("checked before anything was signed; nothing was written or paid")
    .into())
}

/// `names` spelt as the item's `current` labels spell them, where one matches without
/// regard to case (`None`: unknown, left as they are).
pub fn spelt_as_on(names: &[String], current: Option<&BTreeSet<String>>) -> Vec<String> {
    names
        .iter()
        .map(|n| {
            current
                .and_then(|c| c.iter().find(|l| l.eq_ignore_ascii_case(n)))
                .unwrap_or(n)
                .clone()
        })
        .collect()
}

/// `bug` or `bug, docs` for a message, terminal-safe.
pub fn label_list(names: &[String]) -> String {
    safe(&names.join(", ")).to_string()
}

#[cfg(test)]
mod tests {
    use super::{edit_words, Edit, Plan, Planned};
    use forge_core::collab::v2::{Target, TargetKind};
    use forge_core::rules::EventKind;

    fn edit(title: Option<&'static str>, events: usize) -> Edit<'static> {
        let planned = (0..events)
            .map(|i| {
                Planned::new(
                    EventKind::LabelAdd,
                    Some(format!("l{i}")),
                    format!("add label l{i}"),
                    false,
                )
            })
            .collect();
        Edit {
            noun: "PR",
            key: "pr",
            number: 1,
            target: Target {
                kind: TargetKind::Patch,
                id: "T".into(),
                number: 1,
                author: "a".into(),
            },
            title,
            body: None,
            long: None,
            refit: None,
            imported: None,
            replace_note: String::new(),
            plan: Plan {
                events: planned,
                unchanged: vec![],
            },
            title_json: serde_json::Value::Null,
        }
    }

    /// One prompt names every change and what it writes.
    #[test]
    fn the_prompt_names_every_change_and_the_documents() {
        assert_eq!(
            edit_words(&edit(Some("t"), 2)),
            (
                vec![
                    "replace the title".to_string(),
                    "add label l0".into(),
                    "add label l1".into()
                ],
                "one document replace and 2 events".to_string()
            )
        );
        assert_eq!(edit_words(&edit(None, 1)).1, "1 event");
        assert_eq!(edit_words(&edit(Some("t"), 0)).1, "one document replace");
    }

    /// An event's quote grows with its value, and an assignee's `refId` adds its index entry.
    #[test]
    fn a_planned_event_is_quoted_by_its_value() {
        let short = Planned::new(EventKind::LabelAdd, Some("a".into()), String::new(), false);
        let long = Planned::new(
            EventKind::LabelAdd,
            Some("a".repeat(40)),
            String::new(),
            false,
        );
        let addressed = Planned::new(EventKind::Assign, Some("a".into()), String::new(), true);
        assert!(long.quote > short.quote);
        assert!(addressed.quote > short.quote);
    }
}
