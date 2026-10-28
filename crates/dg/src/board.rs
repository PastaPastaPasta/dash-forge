//! `dg board` — a repository's boards (`docs/design/boards.md` §6; forge-meta `board` and
//! `card`, UPDATE-3). Reads, item assembly and writes are forge-core's
//! (`forge_core::collab::boards`), the fold, rank, query and view rules
//! `forge_core::rules::boards`, shared with the web through the `board_*` vectors.
//!
//! An item is named `#12` (or `12`) in the board's home repository, `owner/name#12` in another,
//! and `pr#12` / `issue#12` where an issue and a pull request share a number. Every write is
//! one document per item, priced and confirmed first (`--yes` skips the prompt).

use std::collections::{BTreeMap, HashMap};

use anyhow::Result;
use serde_json::{json, Value};

use crate::common::{Reader, Session};
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, plural};
use crate::{BoardCommand, BoardTemplate};
use forge_core::collab::boards::{
    cross_repo_card_needs_confirm, parse_item_reference, plan_card_writes, Board, BoardSnapshot,
    BoardState, BulkWritten, CardItem, CardPatch, CardWritten, DropAt, CROSS_REPO_WARNING,
};
use forge_core::collab::v2::Collab;
use forge_core::rules::boards::{
    column_totals, date_of, default_spec, group_rows, iteration_at, iteration_progress,
    iteration_range, matches_board_query, monday_of, parse_board_query, repo_names_of, sort_rows,
    sum_field_of, BoardColumn, BoardField, BoardItem, BoardRow, BoardSource, BoardSpec, BoardView,
    FieldOption, FieldType, ItemKind, Placement, QueryContext, Scalar, SourceKind, ViewLayout,
    CARD_ACTIVE, CARD_ARCHIVED, CARD_REMOVED, MAX_COLUMNS,
};
use forge_core::scope::RepoRef;

/// Dispatch a `board` subcommand.
pub async fn run(ctx: &Ctx, cmd: &BoardCommand) -> Result<()> {
    match cmd {
        BoardCommand::List { repo, deleted } => list(ctx, repo, *deleted).await,
        BoardCommand::View {
            repo,
            board,
            view,
            archived,
        } => Box::pin(show(ctx, repo, board, view.as_deref(), *archived)).await,
        BoardCommand::Create {
            repo,
            name,
            columns,
            template,
        } => create(ctx, repo, name, columns.as_deref(), *template).await,
        BoardCommand::Move {
            repo,
            board,
            item,
            column,
            top,
            bottom: _,
            before,
            after,
        } => {
            let at = match (before, after) {
                (Some(m), _) => Where::Before(m.clone()),
                (_, Some(m)) => Where::After(m.clone()),
                _ if *top => Where::Top,
                _ => Where::Bottom,
            };
            Box::pin(move_item(ctx, repo, board, item, column, at)).await
        }
        BoardCommand::Set {
            repo,
            board,
            item,
            values,
        } => Box::pin(set(ctx, repo, board, item, values)).await,
        BoardCommand::Add {
            repo,
            board,
            items,
            column,
            title,
        } => match title {
            Some(t) => Box::pin(quick_add(ctx, repo, board, t, column.as_deref())).await,
            None => Box::pin(bulk(ctx, repo, board, items, Bulk::Add(column.clone()))).await,
        },
        BoardCommand::Archive {
            repo,
            board,
            items,
            restore,
        } => {
            let op = if *restore {
                Bulk::Restore
            } else {
                Bulk::Archive
            };
            Box::pin(bulk(ctx, repo, board, items, op)).await
        }
        BoardCommand::Remove { repo, board, items } => {
            Box::pin(bulk(ctx, repo, board, items, Bulk::Remove)).await
        }
        BoardCommand::NextIteration { repo, board, field } => {
            Box::pin(next_iteration(ctx, repo, board, field.as_deref())).await
        }
        BoardCommand::Close {
            repo,
            board,
            reopen,
        } => {
            let state = if *reopen {
                BoardState::Open
            } else {
                BoardState::Closed
            };
            set_state(ctx, repo, board, state).await
        }
        BoardCommand::Delete { repo, board } => {
            set_state(ctx, repo, board, BoardState::Deleted).await
        }
    }
}

/// Now, in ms (the fold's `now`).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

/// `--columns "Todo,In progress,Done"`: trimmed names, none empty, at most 20.
fn parse_columns(s: &str) -> Result<Vec<String>> {
    let names: Vec<String> = s.split(',').map(|n| n.trim().to_string()).collect();
    if names.iter().any(String::is_empty) {
        return Err(crate::errors::usage(format!(
            "--columns {s:?}: a column name is empty; separate names with commas, like \"Todo,In progress,Done\""
        )));
    }
    if names.len() > MAX_COLUMNS {
        return Err(crate::errors::usage(format!(
            "--columns: a board has at most {MAX_COLUMNS} columns, not {}",
            names.len()
        )));
    }
    Ok(names)
}

/// The web's Priority field (P0–P3), as its templates define it.
fn priority_field() -> BoardField {
    let option = |id, name: &str, color: &str| FieldOption {
        id,
        name: name.into(),
        color: Some(color.into()),
    };
    BoardField {
        id: 1,
        name: "Priority".into(),
        kind: FieldType::Sel,
        options: Some(vec![
            option(1, "P0", "#d1242f"),
            option(2, "P1", "#fb8f44"),
            option(3, "P2", "#d4a72c"),
            option(4, "P3", "#8c959f"),
        ]),
        start: None,
        days: None,
    }
}

/// A view with only its id, name, layout and filter.
fn view(id: u8, name: &str, layout: ViewLayout, q: &str) -> BoardView {
    BoardView {
        id,
        name: name.into(),
        layout,
        q: q.into(),
        group: None,
        lane: None,
        sort: None,
        cols: None,
        date: None,
    }
}

/// Columns 1…n named `names`.
fn columns_of<S: AsRef<str>>(names: impl IntoIterator<Item = S>) -> Vec<BoardColumn> {
    names
        .into_iter()
        .enumerate()
        .map(|(i, name)| BoardColumn {
            id: u8::try_from(i + 1).unwrap_or(u8::MAX),
            name: name.as_ref().to_string(),
            color: None,
            wip: None,
        })
        .collect()
}

/// `template`'s definition for a board of home repository `home` created at `now`, as the
/// web's create dialog writes it (`board-templates.ts`, parity).
fn template_spec(template: BoardTemplate, home: &str, now: i64) -> BoardSpec {
    let source = |k, q: &str| BoardSource {
        r: Some(home.to_string()),
        k,
        q: q.into(),
    };
    let cols = |c: &[&str]| Some(c.iter().map(|s| (*s).to_string()).collect());
    match template {
        BoardTemplate::Kanban => default_spec(home, now),
        BoardTemplate::Sprint => BoardSpec {
            v: 1,
            desc: None,
            columns: columns_of(["Backlog", "Todo", "In progress", "In review", "Done"]),
            def: 1,
            done: 5,
            sources: vec![source(SourceKind::All, "")],
            fields: vec![
                BoardField {
                    id: 1,
                    name: "Iteration".into(),
                    kind: FieldType::Iter,
                    options: None,
                    start: Some(monday_of(now)),
                    days: Some(14),
                },
                BoardField {
                    id: 2,
                    name: "Estimate".into(),
                    kind: FieldType::Num,
                    options: None,
                    start: None,
                    days: None,
                },
            ],
            views: vec![
                view(1, "Board", ViewLayout::Board, ""),
                view(2, "Current sprint", ViewLayout::Board, "iteration:@current"),
                BoardView {
                    group: Some("f1".into()),
                    cols: cols(&["title", "status", "assignees", "f1", "f2"]),
                    ..view(3, "Table", ViewLayout::Table, "")
                },
                BoardView {
                    date: Some(vec![1]),
                    ..view(4, "Roadmap", ViewLayout::Roadmap, "")
                },
            ],
            arch: 14,
        },
        BoardTemplate::Triage => BoardSpec {
            v: 1,
            desc: None,
            columns: columns_of(["Needs triage", "Confirmed", "In progress", "Fixed"]),
            def: 1,
            done: 4,
            sources: vec![source(SourceKind::Issues, "label:bug")],
            fields: vec![priority_field()],
            views: vec![
                view(1, "Board", ViewLayout::Board, ""),
                BoardView {
                    group: Some("f1".into()),
                    cols: cols(&["title", "status", "assignees", "labels", "f1"]),
                    ..view(2, "By priority", ViewLayout::Table, "is:open")
                },
            ],
            arch: 14,
        },
        BoardTemplate::Empty => BoardSpec {
            v: 1,
            desc: None,
            columns: columns_of(["Todo"]),
            def: 1,
            done: 0,
            sources: Vec::new(),
            fields: Vec::new(),
            views: Vec::new(),
            arch: 0,
        },
    }
}

/// A new board's definition: `template`'s for home repository `home` at `now`, its columns
/// replaced by `columns` when given (ids 1…n; the first is the default column, one named Done
/// the Done column).
pub(crate) fn spec_for(
    template: BoardTemplate,
    home: &str,
    columns: Option<&str>,
    now: i64,
) -> Result<BoardSpec> {
    let mut spec = template_spec(template, home, now);
    if let Some(cols) = columns {
        spec.columns = columns_of(parse_columns(cols)?);
        spec.def = 1;
        spec.done = spec
            .columns
            .iter()
            .find(|c| c.name.eq_ignore_ascii_case("done"))
            .map_or(0, |c| c.id);
    }
    Ok(spec)
}

/// An item as typed: its kind when `pr#12` / `issue#12` says it, its repository when
/// `owner/name#12` names one, and its number.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ItemArg {
    kind: Option<ItemKind>,
    repo: Option<String>,
    number: u32,
}

/// `#12`, `12`, `owner/name#12`, a link of the web app, or any of the first three with `pr` or
/// `issue` before the `#`.
fn parse_item_arg(s: &str) -> Result<ItemArg> {
    let t = s.trim();
    let lower = t.to_ascii_lowercase();
    let (kind, rest) = if let Some(r) = lower.strip_prefix("pr#") {
        (Some(ItemKind::Pr), format!("#{}", &t[t.len() - r.len()..]))
    } else if let Some(r) = lower.strip_prefix("issue#") {
        (
            Some(ItemKind::Issue),
            format!("#{}", &t[t.len() - r.len()..]),
        )
    } else if !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit()) {
        (None, format!("#{t}"))
    } else {
        (None, t.to_string())
    };
    let Some(r) = parse_item_reference(&rest) else {
        return Err(crate::errors::usage(format!(
            "{:?} is not an issue or pull request: write #12, owner/name#12, or pr#12 for a pull request",
            crate::fmt::safe(s)
        )));
    };
    Ok(ItemArg {
        kind,
        repo: r.repo.map(|(o, n)| format!("{o}/{n}")),
        number: r.number,
    })
}

/// Column `name` of `spec` (case-insensitive), or its id. `none` / `No status` is 0 only on a
/// board whose default column is "No status" (`def` 0): elsewhere a card without a column
/// shows in the default column (§2.4), so moving one there would say one thing and do another.
fn find_column(spec: &BoardSpec, name: &str) -> Option<u8> {
    let n = name.trim();
    if n.eq_ignore_ascii_case("none") || n.eq_ignore_ascii_case("no status") {
        return (spec.def == 0).then_some(0);
    }
    spec.columns
        .iter()
        .find(|c| c.name.to_lowercase() == n.to_lowercase())
        .or_else(|| {
            spec.columns
                .iter()
                .find(|c| n.parse::<u8>().ok() == Some(c.id))
        })
        .map(|c| c.id)
}

fn column_name(spec: &BoardSpec, id: u8) -> String {
    spec.columns
        .iter()
        .find(|c| c.id == id)
        .map_or_else(|| "No status".to_string(), |c| c.name.clone())
}

/// The names of `spec`'s columns, in order.
fn column_names(spec: &BoardSpec) -> Vec<String> {
    spec.columns.iter().map(|c| c.name.clone()).collect()
}

/// How a board is named in prompts and output.
fn board_name(b: &Board) -> &str {
    b.name.as_deref().unwrap_or("(sealed)")
}

fn no_column(spec: &BoardSpec, name: &str) -> anyhow::Error {
    let names: Vec<String> = column_names(spec)
        .iter()
        .map(|n| format!("{n:?}"))
        .collect();
    crate::errors::usage(format!(
        "this board has no column {name:?}; its columns are {}",
        crate::fmt::join_and(&names)
    ))
}

/// Field `name` of `spec` (case-insensitive).
fn find_field<'s>(spec: &'s BoardSpec, name: &str) -> Option<&'s BoardField> {
    let n = name.trim().to_lowercase();
    spec.fields.iter().find(|f| f.name.to_lowercase() == n)
}

/// `raw` as a value of `field` at `now`: `None` clears it (an empty value). A select takes an
/// option's name, a number a number, a date `YYYY-MM-DD` or `@today`, an iteration `@current`,
/// `@next`, `@previous`, `3` or `Iteration 3`, a text field anything. The board rules judge the
/// result again before anything is signed.
fn parse_value(field: &BoardField, raw: &str, now: i64) -> Result<Option<Scalar>> {
    let v = raw.trim();
    if v.is_empty() {
        return Ok(None);
    }
    let bad = |why: &str| {
        crate::errors::usage(format!(
            "{v:?} is not a value of {}: {why}",
            crate::fmt::safe(&field.name)
        ))
    };
    Ok(Some(match field.kind {
        FieldType::Sel => {
            let options = field.options.as_deref().unwrap_or_default();
            let o = options
                .iter()
                .find(|o| o.name.to_lowercase() == v.to_lowercase())
                .ok_or_else(|| {
                    let names: Vec<String> =
                        options.iter().map(|o| format!("{:?}", o.name)).collect();
                    bad(&format!("pick one of {}", crate::fmt::join_and(&names)))
                })?;
            Scalar::from(i64::from(o.id))
        }
        FieldType::Num => Scalar::Num(
            v.parse::<f64>()
                .ok()
                .filter(|x| x.is_finite())
                .ok_or_else(|| bad("a number"))?,
        ),
        FieldType::Date if v.eq_ignore_ascii_case("@today") => Scalar::Text(date_of(now)),
        FieldType::Date => {
            if forge_core::rules::boards::date_days(v).is_none() {
                return Err(bad("a date, YYYY-MM-DD"));
            }
            Scalar::Text(v.to_string())
        }
        FieldType::Iter => {
            let current = iteration_at(field, now);
            let lower = v.to_lowercase();
            let k = match lower.as_str() {
                "@current" => current,
                "@next" => Some(current.map_or(0, |c| c + 1)),
                "@previous" => current.filter(|c| *c > 0).map(|c| c - 1),
                _ => {
                    let prefix = format!("{} ", field.name.to_lowercase());
                    let n = lower.strip_prefix(&prefix).unwrap_or(&lower);
                    n.parse::<i64>().ok().filter(|n| *n >= 1).map(|n| n - 1)
                }
            };
            Scalar::from(k.ok_or_else(|| {
                bad("an iteration: @current, @next, @previous, or its number (3, or \"Iteration 3\")")
            })?)
        }
        FieldType::Text => Scalar::Text(v.to_string()),
    }))
}

/// `field=value` pairs as one card patch: fields by name (`status=<column>` moves the card).
fn parse_assignments(spec: &BoardSpec, values: &[String], now: i64) -> Result<CardPatch> {
    let mut patch = CardPatch::default();
    for pair in values {
        let Some((key, raw)) = pair.split_once('=') else {
            return Err(crate::errors::usage(format!(
                "{pair:?}: write field=value (an empty value clears the field)"
            )));
        };
        if key.trim().eq_ignore_ascii_case("status") {
            patch.col = Some(find_column(spec, raw).ok_or_else(|| no_column(spec, raw))?);
            continue;
        }
        let Some(field) = find_field(spec, key) else {
            let names: Vec<String> = spec
                .fields
                .iter()
                .map(|f| format!("{:?}", f.name))
                .collect();
            return Err(crate::errors::usage(if names.is_empty() {
                format!("this board has no field {key:?} (it has no fields)")
            } else {
                format!(
                    "this board has no field {key:?}; its fields are {}",
                    crate::fmt::join_and(&names)
                )
            }));
        };
        patch.fields.insert(field.id, parse_value(field, raw, now)?);
    }
    Ok(patch)
}

/// How a field's value reads: an option's name, an iteration's name, a number as the web
/// prints it, the text.
fn value_text(field: &BoardField, v: &Scalar) -> String {
    let n = serde_json::to_value(v).ok();
    let as_int = n.as_ref().and_then(Value::as_i64);
    match field.kind {
        FieldType::Sel => field
            .options
            .as_deref()
            .unwrap_or_default()
            .iter()
            .find(|o| Some(i64::from(o.id)) == as_int)
            .map_or_else(String::new, |o| o.name.clone()),
        FieldType::Iter => as_int
            .and_then(|k| iteration_range(field, k))
            .map_or_else(String::new, |r| r.name),
        _ => match n {
            Some(Value::String(s)) => s,
            Some(other) => other.to_string(),
            None => String::new(),
        },
    }
}

/// An item's field values by field name, as they read.
fn named_fields(spec: &BoardSpec, p: &Placement) -> BTreeMap<String, String> {
    p.fields
        .iter()
        .filter_map(|(id, v)| spec.field(*id).map(|f| (f.name.clone(), value_text(f, v))))
        .collect()
}

/// How an item is named: `#12` in the home repository (`repo` `None`), `owner/name #12`
/// elsewhere; a pull request with `pr`.
fn ref_label(kind: ItemKind, repo: Option<&str>, number: u64) -> String {
    let prefix = if kind == ItemKind::Pr { "pr" } else { "" };
    match repo {
        None => format!("{prefix}#{number}"),
        Some(r) => format!("{r} {prefix}#{number}"),
    }
}

/// [`ref_label`] of a board item; "a private item" for a placeholder.
fn item_label(item: &BoardItem, home: &str) -> String {
    if item.number == 0 {
        return "a private item".into();
    }
    let repo = (item.repo_id != home).then(|| item.repo.as_deref().unwrap_or(&item.repo_id));
    ref_label(item.kind, repo, item.number)
}

// ---------------------------------------------------------------------------------------------
// Resolving
// ---------------------------------------------------------------------------------------------

/// The board `arg` names in `repo`: its number (key) or its name (case-insensitive).
async fn find_board(collab: &Collab<'_>, repo: &RepoRef, arg: &str) -> Result<Board> {
    let listed = || format!("`dg board list {}` lists its boards", repo.display());
    if let Ok(key) = arg.trim().parse::<u32>() {
        if let Some(b) = collab.board_definition(repo, key).await? {
            if b.state != BoardState::Deleted {
                return Ok(b);
            }
        }
    }
    let boards = collab.boards(repo, false).await?;
    let found: Vec<&Board> = boards
        .iter()
        .filter(|b| {
            b.name
                .as_deref()
                .is_some_and(|n| n.to_lowercase() == arg.trim().to_lowercase())
        })
        .collect();
    match found.as_slice() {
        [one] => Ok((*one).clone()),
        [] => Err(crate::errors::not_found(
            format!("no board {:?} in {}", crate::fmt::safe(arg), repo.display()),
            listed(),
        )),
        many => Err(crate::errors::usage(format!(
            "{} boards in {} are named {:?}: name one by its number ({})",
            many.len(),
            repo.display(),
            crate::fmt::safe(arg),
            many.iter()
                .map(|b| b.key.to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ))),
    }
}

/// The board's snapshot now, or E102.
async fn snapshot(collab: &Collab<'_>, repo: &RepoRef, board: &Board) -> Result<BoardSnapshot> {
    collab
        .board_snapshot(repo, board.key, now_ms())
        .await?
        .ok_or_else(|| {
            crate::errors::not_found(
                format!(
                    "board {} of {} has no definition",
                    board.key,
                    repo.display()
                ),
                format!("`dg board list {}` lists its boards", repo.display()),
            )
        })
}

/// The item `arg` names, on the board or not: one of the board's items with that number (and
/// repository, and kind), else issue (then pull request) `number` of its repository.
async fn find_item(
    collab: &Collab<'_>,
    s: &Session,
    snap: &BoardSnapshot,
    arg: &str,
) -> Result<(CardItem, String)> {
    let a = parse_item_arg(arg)?;
    let repo = match &a.repo {
        None => s.repo.clone(),
        Some(r) => {
            let parsed = crate::common::RepoRef::parse(r)?;
            crate::common::resolve(&s.client, &s.identity, &parsed).await?
        }
    };
    let on: Vec<&BoardItem> = snap
        .items
        .items
        .iter()
        .filter(|i| {
            i.repo_id == repo.id()
                && i.number == u64::from(a.number)
                && a.kind.is_none_or(|k| k == i.kind)
        })
        .collect();
    match on.as_slice() {
        [one] => return Ok((CardItem::of(one), item_label(one, s.repo.id()))),
        [_, _, ..] => {
            return Err(crate::errors::usage(format!(
            "issue #{n} and pull request #{n} are both on this board: write issue#{n} or pr#{n}",
            n = a.number
        )))
        }
        [] => {}
    }
    let Some((id, kind)) = collab
        .resolve_item_by_number(&repo, a.number, a.kind)
        .await?
    else {
        return Err(crate::errors::not_found(
            format!(
                "no issue or pull request #{} in {}",
                a.number,
                repo.display()
            ),
            format!("`dg issue list {}` lists its issues", repo.display()),
        ));
    };
    let display = repo.display();
    let label = ref_label(
        kind,
        (repo.id() != s.repo.id()).then_some(display.as_str()),
        u64::from(a.number),
    );
    Ok((
        CardItem {
            id,
            repo_id: repo.id().to_string(),
        },
        label,
    ))
}

/// The end of a write's prompt: the warning when it publishes that a private board tracks
/// another repository's items (§3.3), and the closing parenthesis.
fn cross_repo_suffix(home: &RepoRef, items: &[CardItem]) -> String {
    if items
        .iter()
        .any(|i| cross_repo_card_needs_confirm(home, &i.repo_id))
    {
        format!(". Note: {CROSS_REPO_WARNING})")
    } else {
        ")".into()
    }
}

/// The estimated price of card writes for `ids` on `snap`'s board: a create for each item the
/// signer has no card for, a replace for the rest.
fn card_quote(s: &Session, snap: &BoardSnapshot, ids: &[String]) -> u64 {
    let (creates, replaces) = plan_card_writes(&snap.read.cards, &s.identity.id(), ids);
    crate::quote::card_writes(creates, replaces, card_bytes(&s.repo))
}

/// What every card command starts with: a session for writing, the board `board` names (open),
/// and its definition.
async fn open_board(
    ctx: &Ctx,
    repo: &str,
    board: &str,
    refusal: &str,
) -> Result<(Session, Board, BoardSpec)> {
    let s = Session::open_for_write(ctx, repo, refusal).await?;
    let b = find_board(&s.collab(), &s.repo, board).await?;
    require_open(&b)?;
    let spec = spec_of(&b)?.clone();
    Ok((s, b, spec))
}

/// The bytes a card write stores beyond its fixed shape (the web's `BOARD_WRITE_BYTES.card`),
/// sealed ones with their framing.
fn card_bytes(repo: &RepoRef) -> u64 {
    if repo.visibility == forge_core::rules::v2::Visibility::Private {
        40 + 29 + 32
    } else {
        40
    }
}

/// Refuse a board that is not open before anything is priced.
fn require_open(board: &Board) -> Result<()> {
    match board.state {
        BoardState::Open => Ok(()),
        BoardState::Closed => Err(crate::errors::usage(format!(
            "board {} is closed: reopen it with `dg board close <repo> {} --reopen` to change it",
            board.key, board.key
        ))),
        BoardState::Deleted => Err(crate::errors::usage(format!(
            "board {} was deleted",
            board.key
        ))),
    }
}

/// The board's definition, or the refusal that it did not open here.
fn spec_of(board: &Board) -> Result<&BoardSpec> {
    board.spec.as_ref().ok_or_else(|| {
        crate::errors::usage(format!(
            "board {}'s definition can't be read here ({})",
            board.key,
            board.spec_error.as_deref().unwrap_or("unreadable")
        ))
    })
}

// ---------------------------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------------------------

/// A board as `list` and `view` print it.
fn board_json(b: &Board) -> Value {
    json!({
        "key": b.key,
        "name": b.name,
        "state": b.state.as_str(),
        "sealed": b.sealed,
        "repoId": b.repo_id,
        "columns": b.spec.as_ref().map(column_names),
        "specError": b.spec_error,
        "updatedAt": b.newest.updated_at,
        "editedBy": b.newest.owner_id,
    })
}

pub(crate) fn list_json(boards: &[Board]) -> Value {
    json!({
        "count": boards.len(),
        "boards": boards.iter().map(board_json).collect::<Vec<_>>(),
    })
}

/// One group of a shown board: its label, its items in shown order, its totals.
struct Group {
    key: Value,
    name: String,
    items: Vec<String>,
    count: usize,
    sum: Option<Scalar>,
    wip: Option<u16>,
    over: bool,
}

/// What `view` shows: the groups (the columns, or the view's grouping) of the items that pass
/// the view's filter, in its sort, with totals and WIP.
pub(crate) struct Shown {
    view: Option<BoardView>,
    group_by: String,
    sum_field: Option<u8>,
    groups: Vec<Group>,
    unresolved: Vec<String>,
    ids: Vec<String>,
}

/// The query view `view` (`None`: every item) filters by, with `is:archived` when asked for.
fn view_query(view: Option<&BoardView>, archived: bool) -> String {
    let mut q = view.map_or_else(String::new, |v| v.q.clone());
    if archived {
        q.push_str(" is:archived");
    }
    q
}

/// The repository ids the `repo:` names of query `q` resolve to (§4.4, [`repo_names_of`]):
/// `owner/name` (the owner an identity id or a DPNS name) or a bare name of `home`'s owner, as
/// the web resolves them. A name that names no repository is left out (the query reports it).
async fn resolve_repo_names(
    client: &forge_core::platform::PlatformClient,
    home: &RepoRef,
    q: &str,
) -> Result<HashMap<String, String>> {
    use forge_core::Error;
    let mut out = HashMap::new();
    for name in repo_names_of(q) {
        let found = match name.split_once('/') {
            Some((owner, repo)) => forge_core::resolve::resolve_named(client, owner, repo).await,
            None => forge_core::resolve::resolve_named(client, home.owner_id(), &name).await,
        };
        match found {
            Ok(r) => {
                out.insert(name, r.id().to_string());
            }
            Err(Error::NotFound | Error::User(_) | Error::Config(_)) => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(out)
}

/// The groups of `snap` as view `view` (`None`: the board's columns, every item) shows them;
/// `repos` are the ids its `repo:` names resolved to ([`resolve_repo_names`]).
pub(crate) fn shown(
    snap: &BoardSnapshot,
    spec: &BoardSpec,
    view: Option<&BoardView>,
    archived: bool,
    me: Option<&str>,
    repos: &HashMap<String, String>,
) -> Shown {
    let placements = snap.placement_index();
    let q = view_query(view, archived);
    let query = parse_board_query(&q, spec, repos);
    let ctx = QueryContext {
        me: me.map(str::to_string),
        now: snap.now,
    };
    let rows: Vec<BoardRow<'_>> = snap
        .items
        .items
        .iter()
        .filter_map(|i| {
            let p = placements.get(i.id.as_str())?;
            matches_board_query(i, p, spec, &query, &ctx).then_some(BoardRow {
                item: i,
                placement: p,
            })
        })
        .collect();
    let rows = sort_rows(&rows, view.and_then(|v| v.sort.as_deref()), spec);
    let group_by = view
        .filter(|v| v.layout == ViewLayout::Board)
        .and_then(|v| v.group.clone())
        .unwrap_or_else(|| "status".into());
    let sum_field = sum_field_of(spec, view);
    let by_id: BTreeMap<&str, BoardRow<'_>> =
        rows.iter().map(|r| (r.item.id.as_str(), *r)).collect();
    let wip: BTreeMap<u8, (Option<u16>, bool)> = column_totals(&rows, spec, sum_field)
        .into_iter()
        .map(|t| (t.id, (t.wip, t.over)))
        .collect();
    let field = forge_core::rules::boards::field_key_id(&group_by).and_then(|id| spec.field(id));
    let groups = group_rows(&rows, &group_by, spec, snap.now)
        .into_iter()
        .map(|g| {
            let in_group: Vec<BoardRow<'_>> = g
                .items
                .iter()
                .filter_map(|id| by_id.get(id.as_str()).copied())
                .collect();
            let t = forge_core::rules::boards::totals(&in_group, sum_field);
            let key = serde_json::to_value(&g.key).unwrap_or(Value::Null);
            let name = match (&g.key, group_by.as_str(), field) {
                (None, "status", _) => "No status".to_string(),
                (None, k, Some(f)) if k.starts_with('f') => format!("No {}", f.name),
                (None, k, _) => format!("No {k}"),
                (Some(_), "status", _) => column_name(
                    spec,
                    key.as_u64().and_then(|n| u8::try_from(n).ok()).unwrap_or(0),
                ),
                (Some(k), _, Some(f)) => value_text(f, k),
                (Some(_), _, None) => match &key {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                },
            };
            let (wip, over) = if group_by == "status" {
                key.as_u64()
                    .and_then(|n| u8::try_from(n).ok())
                    .and_then(|id| wip.get(&id).copied())
                    .unwrap_or((None, false))
            } else {
                (None, false)
            };
            Group {
                key,
                name,
                items: g.items,
                count: t.count,
                sum: t.sum,
                wip,
                over,
            }
        })
        .collect();
    Shown {
        view: view.cloned(),
        group_by,
        sum_field,
        groups,
        unresolved: query.unresolved,
        ids: rows.iter().map(|r| r.item.id.clone()).collect(),
    }
}

/// The current iteration's progress of `spec`'s first iteration field (§4.5), as JSON.
fn progress_json(snap: &BoardSnapshot, spec: &BoardSpec, sum_field: Option<u8>) -> Value {
    let Some(field) = spec.fields.iter().find(|f| f.kind == FieldType::Iter) else {
        return Value::Null;
    };
    let Some(k) = iteration_at(field, snap.now) else {
        return Value::Null;
    };
    let placements = snap.placement_index();
    let rows: Vec<BoardRow<'_>> = snap
        .items
        .items
        .iter()
        .filter_map(|i| {
            let p = placements.get(i.id.as_str())?;
            (p.on && p.archived.is_none()).then_some(BoardRow {
                item: i,
                placement: p,
            })
        })
        .collect();
    let p = iteration_progress(&rows, spec, field.id, k, sum_field);
    json!({
        "field": field.name,
        "iteration": iteration_range(field, k),
        "total": p.total,
        "done": p.done,
        "points": p.points,
        "donePoints": p.done_points,
    })
}

/// `dg board view --json`: the board, the groups shown, every item with its placement, and the
/// fold itself.
pub(crate) fn view_json(snap: &BoardSnapshot, s: &Shown) -> Value {
    let board = &snap.read.board;
    let spec = board.spec.as_ref();
    let placements = snap.placement_index();
    let items: Vec<Value> = snap
        .items
        .items
        .iter()
        .map(|i| {
            let p = placements.get(i.id.as_str());
            json!({
                "id": i.id,
                "number": i.number,
                "repoId": i.repo_id,
                "repo": i.repo,
                "kind": i.kind,
                "state": i.state,
                "title": i.title,
                "labels": i.labels,
                "assignees": i.assignees,
                "milestone": i.milestone,
                "author": i.author,
                "closedAt": i.closed_at,
                "hidden": snap.items.hidden.contains(&i.id),
                "on": p.is_some_and(|p| p.on),
                "shown": s.ids.contains(&i.id),
                "column": p.and_then(|p| spec.map(|sp| column_name(sp, p.col))),
                "col": p.map(|p| p.col),
                "rank": p.map(|p| p.rank.clone()),
                "archived": p.and_then(|p| p.archived),
                "removed": p.is_some_and(|p| p.removed),
                "fields": match (spec, p) {
                    (Some(sp), Some(p)) => json!(named_fields(sp, p)),
                    _ => json!({}),
                },
            })
        })
        .collect();
    json!({
        "board": board_json(board),
        "view": s.view.as_ref().map(|v| v.name.clone()),
        "groupBy": s.group_by,
        "sumField": s.sum_field.and_then(|id| spec.and_then(|sp| sp.field(id)).map(|f| f.name.clone())),
        "now": snap.now,
        "columns": s.groups.iter().map(|g| json!({
            "key": g.key,
            "name": g.name,
            "count": g.count,
            "sum": g.sum,
            "wip": g.wip,
            "over": g.over,
            "items": g.items,
        })).collect::<Vec<_>>(),
        "items": items,
        "progress": spec.map_or(Value::Null, |sp| progress_json(snap, sp, s.sum_field)),
        "unresolved": s.unresolved,
        "hidden": snap.items.hidden,
        "missing": snap.items.missing,
        "partial": snap.items.partial,
        "hasOlderClosed": snap.items.has_older_closed,
        "fold": snap.fold,
    })
}

/// One card write as the commands print it.
pub(crate) fn card_json(w: &CardWritten, label: &str) -> Value {
    json!({
        "item": w.item,
        "label": label,
        "documentId": w.document_id,
        "created": w.created,
        "changed": w.changed,
        "col": w.col,
        "rank": w.rank,
        "state": match w.state {
            CARD_ARCHIVED => "archived",
            CARD_REMOVED => "removed",
            _ => "active",
        },
    })
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

async fn list(ctx: &Ctx, repo: &str, deleted: bool) -> Result<()> {
    let r = Reader::open(ctx, repo).await?;
    let boards = r.collab().boards(&r.repo, deleted).await?;
    ctx.emit(list_json(&boards), || {
        if boards.is_empty() {
            println!(
                "no boards in {} (create one with `dg board create {repo} --name <name>`)",
                r.repo.display()
            );
        }
        for b in &boards {
            let cols = b.spec.as_ref().map_or_else(
                || "definition unreadable".to_string(),
                |s| {
                    s.columns
                        .iter()
                        .map(|c| c.name.clone())
                        .collect::<Vec<_>>()
                        .join(" → ")
                },
            );
            println!(
                "{:<10} {:<30} {:<7} {cols}",
                b.key,
                crate::fmt::safe(board_name(b)),
                b.state.as_str()
            );
        }
    });
    Ok(())
}

async fn show(
    ctx: &Ctx,
    repo: &str,
    board: &str,
    view: Option<&str>,
    archived: bool,
) -> Result<()> {
    let r = Reader::open_discussion(ctx, repo).await?;
    let collab = r.collab();
    let b = find_board(&collab, &r.repo, board).await?;
    let Some(snap) = collab.board_snapshot(&r.repo, b.key, now_ms()).await? else {
        return Err(crate::errors::not_found(
            format!("no board {board:?} in {}", r.repo.display()),
            format!("`dg board list {repo}` lists its boards"),
        ));
    };
    let spec = spec_of(&snap.read.board)?.clone();
    let chosen = match view {
        None => None,
        Some(name) => Some(
            spec.views
                .iter()
                .find(|v| v.name.to_lowercase() == name.trim().to_lowercase())
                .cloned()
                .ok_or_else(|| {
                    let names: Vec<String> =
                        spec.views.iter().map(|v| format!("{:?}", v.name)).collect();
                    crate::errors::usage(format!(
                        "this board has no view {name:?}{}",
                        if names.is_empty() {
                            String::new()
                        } else {
                            format!("; its views are {}", crate::fmt::join_and(&names))
                        }
                    ))
                })?,
        ),
    };
    let repos =
        resolve_repo_names(&r.client, &r.repo, &view_query(chosen.as_ref(), archived)).await?;
    let shown = shown(&snap, &spec, chosen.as_ref(), archived, r.viewer(), &repos);
    ctx.emit(view_json(&snap, &shown), || {
        print_board(&snap, &spec, &shown);
    });
    Ok(())
}

#[allow(clippy::too_many_lines)] // each group, then the progress and the notes
fn print_board(snap: &BoardSnapshot, spec: &BoardSpec, s: &Shown) {
    let b = &snap.read.board;
    let home = &b.repo_id;
    let sum_name = s
        .sum_field
        .and_then(|id| spec.field(id))
        .map(|f| f.name.clone());
    println!(
        "{} · board {} · {}{}",
        crate::fmt::safe(board_name(b)),
        b.key,
        b.state.as_str(),
        s.view
            .as_ref()
            .map_or_else(String::new, |v| format!(" · view {:?}", v.name))
    );
    let by_id: BTreeMap<&str, &BoardItem> = snap
        .items
        .items
        .iter()
        .map(|i| (i.id.as_str(), i))
        .collect();
    let placements = snap.placement_index();
    for g in &s.groups {
        let mut head = format!(
            "{} · {}",
            crate::fmt::safe(&g.name),
            plural(g.count, "item")
        );
        if let (Some(sum), Some(name)) = (&g.sum, &sum_name) {
            let _ = std::fmt::Write::write_fmt(
                &mut head,
                format_args!(
                    " · {name} {}",
                    serde_json::to_value(sum)
                        .map(|v| v.to_string())
                        .unwrap_or_default()
                ),
            );
        }
        if let Some(w) = g.wip {
            let over = if g.over { " (over the limit)" } else { "" };
            let _ =
                std::fmt::Write::write_fmt(&mut head, format_args!(" · WIP {}/{w}{over}", g.count));
        }
        println!("\n── {head}");
        for id in &g.items {
            let (Some(item), Some(p)) = (by_id.get(id.as_str()), placements.get(id.as_str()))
            else {
                continue;
            };
            let state = match item.state {
                forge_core::rules::boards::ItemState::Open => "",
                forge_core::rules::boards::ItemState::Closed => " (closed)",
                forge_core::rules::boards::ItemState::Merged => " (merged)",
            };
            let fields = named_fields(spec, p)
                .into_iter()
                .map(|(k, v)| format!("{k}: {v}"))
                .collect::<Vec<_>>()
                .join(" · ");
            let archived = if p.archived.is_some() {
                " [archived]"
            } else {
                ""
            };
            println!(
                "  {:<8} {}{state}{archived}{}",
                item_label(item, home),
                crate::fmt::safe(&item.title),
                if fields.is_empty() {
                    String::new()
                } else {
                    format!("  [{}]", crate::fmt::safe(&fields))
                }
            );
        }
    }
    if let Value::Object(p) = progress_json(snap, spec, s.sum_field) {
        println!(
            "\n{} {}: {}/{} done",
            p["field"].as_str().unwrap_or_default(),
            p["iteration"]["name"].as_str().unwrap_or_default(),
            p["done"],
            p["total"]
        );
    }
    if !s.unresolved.is_empty() {
        eprintln!(
            "note: the view's filter names what this board does not have: {}",
            s.unresolved.join(", ")
        );
    }
    if snap.items.partial {
        eprintln!("note: only the newest 100 pull requests of a source repository are read");
    }
    if snap.items.has_older_closed {
        eprintln!(
            "note: older closed items are left out (as the web's board does until \"Show older\")"
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

async fn create(
    ctx: &Ctx,
    repo: &str,
    name: &str,
    columns: Option<&str>,
    template: BoardTemplate,
) -> Result<()> {
    let s = Session::open_for_write(ctx, repo, "board not created").await?;
    let spec = spec_for(template, s.repo.id(), columns, now_ms())?;
    let collab = s.collab();
    let fields = forge_core::collab::boards::check_board_input(name, &spec)?;
    let price = ctx.fiat_price();
    let quote = crate::quote::board_create((fields.name.len() + fields.spec.len()) as u64);
    ctx.confirm_or_cancel(&format!(
        "Create board {:?} in {} with columns {}? (one document, {} estimated; maintainers and writers)",
        fields.name,
        s.repo.display(),
        column_names(&spec).join(", "),
        cost_line(quote, price)
    ))?;
    // The create's intent (the web's `newBoardKey`): the name and definition, so running the
    // same create again after its result was lost names the same board and makes no second one.
    let intent = format!("{}\u{0}{}", fields.name, fields.spec);
    let (w, spent) = s
        .metered(|| collab.create_board(&s.repo, &fields.name, &spec, Some(&intent)))
        .await?;
    let status = if w.created { "created" } else { "exists" };
    ctx.emit(
        json!({
            "status": status,
            "key": w.key,
            "name": fields.name,
            "documentId": w.document_id,
            "id": w.document_id,
            "columns": column_names(&spec),
            "cost": cost_json(spent, price),
        }),
        || {
            let what = if w.created {
                "created"
            } else {
                "already created by an earlier run"
            };
            println!(
                "✓ board {} {what}: number {} · {}",
                fields.name,
                w.key,
                cost_line(spent, price)
            );
            println!("  dg board view {repo} {}", w.key);
        },
    );
    Ok(())
}

async fn set_state(ctx: &Ctx, repo: &str, board: &str, state: BoardState) -> Result<()> {
    let s = Session::open_for_write(ctx, repo, "board not changed").await?;
    let collab = s.collab();
    let b = find_board(&collab, &s.repo, board).await?;
    let price = ctx.fiat_price();
    let own = forge_core::collab::boards::own_revision(&b, &s.identity.id()).is_some();
    let bytes = b
        .spec
        .as_ref()
        .and_then(|sp| forge_core::rules::boards::serialize_spec(sp).ok())
        .map_or(0, |j| j.len()) as u64;
    let quote = if own {
        crate::quote::board_replace(bytes)
    } else {
        crate::quote::board_create(bytes)
    };
    let (verb, status) = match state {
        BoardState::Open => ("Reopen", "reopened"),
        BoardState::Closed => ("Close", "closed"),
        BoardState::Deleted => ("Delete", "deleted"),
    };
    ctx.confirm_or_cancel(&format!(
        "{verb} board {:?} ({}) in {}? (one document, {} estimated)",
        board_name(&b),
        b.key,
        s.repo.display(),
        cost_line(quote, price)
    ))?;
    let (w, spent) = s
        .metered(|| collab.set_board_state(&s.repo, b.key, state))
        .await?;
    ctx.emit(
        json!({
            "status": status,
            "key": b.key,
            "documentId": w.document_id,
            "changed": w.changed,
            "cost": cost_json(spent, price),
        }),
        || println!("✓ board {} {status} · {}", b.key, cost_line(spent, price)),
    );
    Ok(())
}

/// Where `move` puts the card, as typed.
enum Where {
    Top,
    Bottom,
    Before(String),
    After(String),
}

async fn move_item(
    ctx: &Ctx,
    repo: &str,
    board: &str,
    item: &str,
    column: &str,
    at: Where,
) -> Result<()> {
    let (s, b, spec) = open_board(ctx, repo, board, "board not changed").await?;
    let collab = s.collab();
    let col = find_column(&spec, column).ok_or_else(|| no_column(&spec, column))?;
    let snap = snapshot(&collab, &s.repo, &b).await?;
    let (target, label) = find_item(&collab, &s, &snap, item).await?;
    let drop = match at {
        Where::Top => DropAt::Top,
        Where::Bottom => DropAt::Bottom,
        Where::Before(m) => DropAt::Before(find_item(&collab, &s, &snap, &m).await?.0.id),
        Where::After(m) => DropAt::After(find_item(&collab, &s, &snap, &m).await?.0.id),
    };
    let column_cards = snap.column(col);
    let price = ctx.fiat_price();
    let quote = card_quote(&s, &snap, std::slice::from_ref(&target.id));
    ctx.confirm_or_cancel(&format!(
        "Move {label} to {:?} on board {:?}? (one document, {} estimated{}",
        column_name(&spec, col),
        board_name(&b),
        cost_line(quote, price),
        cross_repo_suffix(&s.repo, std::slice::from_ref(&target))
    ))?;
    let (w, spent) = s
        .metered(|| collab.move_card(&s.repo, &b, &target, col, &column_cards, &drop, true))
        .await?;
    ctx.emit(
        json!({
            "status": "moved",
            "board": b.key,
            "column": column_name(&spec, col),
            "card": card_json(&w, &label),
            "cost": cost_json(spent, price),
        }),
        || {
            println!(
                "✓ {label} moved to {} · {}",
                column_name(&spec, col),
                cost_line(spent, price)
            );
        },
    );
    Ok(())
}

async fn set(ctx: &Ctx, repo: &str, board: &str, item: &str, values: &[String]) -> Result<()> {
    let (s, b, spec) = open_board(ctx, repo, board, "board not changed").await?;
    let collab = s.collab();
    let patch = parse_assignments(&spec, values, now_ms())?;
    let snap = snapshot(&collab, &s.repo, &b).await?;
    let (target, label) = find_item(&collab, &s, &snap, item).await?;
    let price = ctx.fiat_price();
    let quote = card_quote(&s, &snap, std::slice::from_ref(&target.id));
    ctx.confirm_or_cancel(&format!(
        "Set {} on {label} on board {:?}? (one document, {} estimated{}",
        values.join(" "),
        board_name(&b),
        cost_line(quote, price),
        cross_repo_suffix(&s.repo, std::slice::from_ref(&target))
    ))?;
    let (w, spent) = s
        .metered(|| collab.write_card(&s.repo, &b, &target, &patch, true))
        .await?;
    let fields: BTreeMap<String, String> =
        forge_core::rules::boards::parse_field_values(w.f.as_deref(), &spec)
            .iter()
            .filter_map(|(id, v)| spec.field(*id).map(|f| (f.name.clone(), value_text(f, v))))
            .collect();
    ctx.emit(
        json!({
            "status": "set",
            "board": b.key,
            "fields": fields,
            "card": card_json(&w, &label),
            "cost": cost_json(spent, price),
        }),
        || println!("✓ {label} updated · {}", cost_line(spent, price)),
    );
    Ok(())
}

/// The bulk card writes.
enum Bulk {
    /// Put on the board (in this column).
    Add(Option<String>),
    Archive,
    Restore,
    Remove,
}

impl Bulk {
    fn verb(&self) -> (&'static str, &'static str) {
        match self {
            Self::Add(_) => ("Add", "added"),
            Self::Archive => ("Archive", "archived"),
            Self::Restore => ("Restore", "restored"),
            Self::Remove => ("Remove", "removed"),
        }
    }
}

/// The landed part of a bulk write, and the E106 error when it stopped early.
fn bulk_outcome(
    ctx: &Ctx,
    done: &BulkWritten,
    labels: &BTreeMap<String, String>,
    body: Value,
    past: &str,
) -> Result<()> {
    let print_landed = || {
        for w in &done.written {
            println!(
                "✓ {} {past}",
                labels.get(&w.item).map_or("item", String::as_str)
            );
        }
    };
    let Some((item, e)) = &done.failed else {
        ctx.emit(body, print_landed);
        return Ok(());
    };
    let label = labels.get(item).cloned().unwrap_or_else(|| item.clone());
    let error = forge_core::user_error::UserError::new(
        forge_core::user_error::codes::PARTIAL,
        format!(
            "{} of {} {past}; {label} was not: {e}",
            done.written.len(),
            done.written.len() + 1 + done.skipped.len()
        ),
    )
    .note(format!("{} not tried", plural(done.skipped.len(), "item")))
    .fix("run the same command again: items already done are unchanged and cost nothing more");
    if !ctx.json {
        print_landed();
    }
    Err(crate::errors::reported(error, body))
}

/// The JSON of a bulk write.
pub(crate) fn bulk_json(
    status: &str,
    key: u32,
    done: &BulkWritten,
    labels: &BTreeMap<String, String>,
    cost: &Value,
) -> Value {
    json!({
        "status": status,
        "board": key,
        "count": done.written.len(),
        "cards": done.written.iter().map(|w| card_json(w, labels.get(&w.item).map_or("", String::as_str))).collect::<Vec<_>>(),
        "failed": done.failed.as_ref().map(|(item, e)| json!({ "item": item, "error": e.to_string() })),
        "skipped": done.skipped,
        "cost": cost,
    })
}

async fn bulk(ctx: &Ctx, repo: &str, board: &str, items: &[String], op: Bulk) -> Result<()> {
    let (s, b, spec) = open_board(ctx, repo, board, "board not changed").await?;
    let collab = s.collab();
    let col = match &op {
        Bulk::Add(Some(c)) => Some(find_column(&spec, c).ok_or_else(|| no_column(&spec, c))?),
        _ => None,
    };
    let snap = snapshot(&collab, &s.repo, &b).await?;
    let mut targets: Vec<CardItem> = Vec::new();
    let mut labels = BTreeMap::new();
    for arg in items {
        let (t, label) = find_item(&collab, &s, &snap, arg).await?;
        if !targets.contains(&t) {
            labels.insert(t.id.clone(), label);
            targets.push(t);
        }
    }
    let patch = match &op {
        Bulk::Add(_) => CardPatch {
            col,
            state: Some(CARD_ACTIVE),
            ..CardPatch::default()
        },
        Bulk::Archive => CardPatch::state(CARD_ARCHIVED),
        Bulk::Restore => CardPatch::state(CARD_ACTIVE),
        Bulk::Remove => CardPatch::state(CARD_REMOVED),
    };
    let writes: Vec<(CardItem, CardPatch)> =
        targets.iter().map(|t| (t.clone(), patch.clone())).collect();
    let ids: Vec<String> = targets.iter().map(|t| t.id.clone()).collect();
    let price = ctx.fiat_price();
    let quote = card_quote(&s, &snap, &ids);
    let (verb, past) = op.verb();
    let names: Vec<String> = targets.iter().map(|t| labels[&t.id].clone()).collect();
    ctx.confirm_or_cancel(&format!(
        "{verb} {} on board {:?}? ({}, {} estimated{}",
        crate::fmt::join_and(&names),
        board_name(&b),
        plural(writes.len(), "document"),
        cost_line(quote, price),
        cross_repo_suffix(&s.repo, &targets)
    ))?;
    let before = s.balance().await;
    let done = collab.write_cards(&s.repo, &b, &writes, true).await;
    let spent = s.spent_since(before).await;
    let body = bulk_json(past, b.key, &done, &labels, &cost_json(spent, price));
    bulk_outcome(ctx, &done, &labels, body, past)
}

async fn quick_add(
    ctx: &Ctx,
    repo: &str,
    board: &str,
    title: &str,
    column: Option<&str>,
) -> Result<()> {
    let (s, b, spec) = open_board(ctx, repo, board, "issue not created").await?;
    s.refuse_if_banned("issue not created").await?;
    let collab = s.collab();
    let col = match column {
        Some(c) => find_column(&spec, c).ok_or_else(|| no_column(&spec, c))?,
        None => spec.def,
    };
    let snap = snapshot(&collab, &s.repo, &b).await?;
    let price = ctx.fiat_price();
    let quote = crate::quote::target_create(title.len() as u64)
        + crate::quote::card_create(card_bytes(&s.repo));
    ctx.confirm_or_cancel(&format!(
        "Open issue {title:?} in {} and put it in {:?} on board {:?}? (two documents, {} estimated)",
        s.repo.display(),
        column_name(&spec, col),
        board_name(&b),
        cost_line(quote, price)
    ))?;
    let journal = forge_core::create::default_journal_dir()?;
    let column_cards = snap.column(col);
    let before = s.balance().await;
    let added = collab
        .quick_add_issue(&s.repo, &b, title, col, &column_cards, None, &journal, true)
        .await?;
    let spent = s.spent_since(before).await;
    let label = format!("#{}", added.item.number);
    match &added.card {
        Ok(w) => {
            ctx.emit(
                json!({
                    "status": "added",
                    "board": b.key,
                    "issue": { "number": added.item.number, "id": added.item.id },
                    "column": column_name(&spec, col),
                    "card": card_json(w, &label),
                    "cost": cost_json(spent, price),
                }),
                || {
                    println!(
                        "✓ issue {label} opened and put in {} · {}",
                        column_name(&spec, col),
                        cost_line(spent, price)
                    );
                },
            );
            Ok(())
        }
        Err(e) => {
            let error = forge_core::user_error::UserError::new(
                forge_core::user_error::codes::PARTIAL,
                format!("issue {label} was opened, but not put on the board: {e}"),
            )
            .fix(format!("`dg board add {repo} {} {label}`", b.key));
            Err(crate::errors::reported(
                error,
                json!({
                    "status": "created",
                    "board": b.key,
                    "issue": { "number": added.item.number, "id": added.item.id },
                    "cost": cost_json(spent, price),
                }),
            ))
        }
    }
}

async fn next_iteration(ctx: &Ctx, repo: &str, board: &str, field: Option<&str>) -> Result<()> {
    let (s, b, spec) = open_board(ctx, repo, board, "board not changed").await?;
    let collab = s.collab();
    let iter = match field {
        Some(name) => find_field(&spec, name)
            .filter(|f| f.kind == FieldType::Iter)
            .ok_or_else(|| {
                crate::errors::usage(format!("this board has no iteration field {name:?}"))
            })?,
        None => spec
            .fields
            .iter()
            .find(|f| f.kind == FieldType::Iter)
            .ok_or_else(|| crate::errors::usage("this board has no iteration field"))?,
    };
    let snap = snapshot(&collab, &s.repo, &b).await?;
    // the board read again: its definition may not open now (another member sealed or broke it)
    spec_of(&snap.read.board)?;
    let placements: Vec<Placement> = snap
        .fold
        .as_ref()
        .map(|f| f.items.clone())
        .unwrap_or_default();
    let Some((next, moving)) = forge_core::collab::boards::next_iteration_plan(
        &spec,
        iter.id,
        &snap.items.items,
        &placements,
        snap.now,
    ) else {
        return Err(crate::errors::usage(format!(
            "{} has no current iteration to move items from (its first starts {})",
            iter.name,
            iter.start.as_deref().unwrap_or("later")
        )));
    };
    let next_name = iteration_range(iter, next)
        .map_or_else(|| format!("{} {}", iter.name, next + 1), |r| r.name);
    let labels: BTreeMap<String, String> = moving
        .iter()
        .filter_map(|m| {
            snap.item(&m.id)
                .map(|i| (m.id.clone(), item_label(i, s.repo.id())))
        })
        .collect();
    if moving.is_empty() {
        ctx.emit(
            json!({ "status": "moved", "board": b.key, "iteration": next_name, "count": 0, "cards": [], "failed": null, "skipped": [], "cost": cost_json(0, ctx.fiat_price()) }),
            || println!("nothing to move: every item of the current iteration is done"),
        );
        return Ok(());
    }
    let ids: Vec<String> = moving.iter().map(|m| m.id.clone()).collect();
    let price = ctx.fiat_price();
    let quote = card_quote(&s, &snap, &ids);
    let names: Vec<String> = ids
        .iter()
        .map(|id| labels.get(id).cloned().unwrap_or_default())
        .collect();
    ctx.confirm_or_cancel(&format!(
        "Move {} into {next_name}? ({}, {} estimated)",
        crate::fmt::join_and(&names),
        plural(ids.len(), "document"),
        cost_line(quote, price)
    ))?;
    let before = s.balance().await;
    let done = collab
        .move_open_to_next_iteration(&s.repo, &snap, iter.id)
        .await?;
    let spent = s.spent_since(before).await;
    let mut body = bulk_json("moved", b.key, &done, &labels, &cost_json(spent, price));
    body["iteration"] = json!(next_name);
    bulk_outcome(
        ctx,
        &done,
        &labels,
        body,
        &format!("moved into {next_name}"),
    )
}

#[cfg(test)]
mod tests;
