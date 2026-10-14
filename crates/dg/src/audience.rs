//! Who a document is for, in `dg`'s words (mixed-visibility DESIGN §10, D25): Public or
//! Members ("members-only"). Every write that takes `--members` asks for it here, and every read
//! marks members-only items and counts the ones the reader cannot open.

use anyhow::Result;
use forge_core::collab::v2::{
    Collab, LetterInfo, MembersOnly, SentLetter, TargetKind, TargetLog, Unopened,
};
use forge_core::platform::PlatformClient;
use forge_core::rules::letters::{LetterGroup, LetterRequest};
use forge_core::rules::v2::{Audience, Visibility};
use forge_core::scope::RepoRef;
use forge_core::user_error::{codes, UserError};

use crate::common::Reader;
use crate::context::Ctx;

/// What a write asked for: `--members`, or `--to` (people and role groups).
#[derive(Debug, Clone, Copy)]
pub struct Ask<'a> {
    /// `--members`.
    pub members: bool,
    /// `--to`: `maintainers`, `writers`, DPNS names (`@alice`) or identity ids.
    pub to: &'a [String],
}

/// `--to`'s words as a letter request: at most one role group, the rest people resolved to
/// identity ids.
async fn letter_request(client: &PlatformClient, to: &[String]) -> Result<LetterRequest> {
    let mut req = LetterRequest::default();
    for word in to.iter().map(|w| w.trim()).filter(|w| !w.is_empty()) {
        let group = match word.to_ascii_lowercase().as_str() {
            "maintainers" => Some(LetterGroup::Maintainers),
            "writers" => Some(LetterGroup::Writers),
            _ => None,
        };
        match (group, req.group) {
            (Some(g), None) => req.group = Some(g),
            (Some(_), Some(_)) => {
                return Err(crate::errors::usage(
                    "--to names at most one group (maintainers or writers)",
                ))
            }
            (None, _) => {
                let id = crate::common::resolve_identity(client, word, "recipient").await?;
                if !req.people.contains(&id) {
                    req.people.push(id);
                }
            }
        }
    }
    if req.group.is_none() && req.people.is_empty() {
        return Err(crate::errors::usage(
            "--to names nobody: give @names, identity ids, maintainers or writers",
        ));
    }
    Ok(req)
}

/// The audience a new document of `repo` is written for by `collab`, as `ask` asks (`--members`,
/// `--to`) on an issue (`target` `None`) or on `target`'s thread (`reply_to`: the comment
/// replied to): the context's when not asked (members-only inside a members-only thread, the
/// same people inside a conversation for specific people; core refuses a public reply to
/// either). The request is kept on `collab` for every write it makes. A write the signer
/// cannot make is refused here, before anything is priced or signed (no encryption key,
/// members-only content not turned on, no key shared yet; for specific people, whatever the
/// letter rule refuses: too many people, someone without an encryption key).
pub async fn requested(
    client: &PlatformClient,
    collab: &Collab<'_>,
    repo: &RepoRef,
    ask: Ask<'_>,
    target: Option<&str>,
    reply_to: Option<&str>,
) -> Result<Requested> {
    if ask.to.is_empty() {
        collab.request_audience(ask.members.then_some(Audience::Members));
    } else {
        collab.request_letter(letter_request(client, ask.to).await?);
    }
    let audience = collab.new_audience(repo, target, reply_to).await?;
    if audience == Audience::SpecificPeople {
        // resolved now, so a refusal comes before the price and the question names who it goes
        // to (a reply re-lists its thread's people unasked); the write resolves it again
        let sent = collab.plan_letter(repo, target, reply_to).await?;
        let to = to_clause(client, &sent).await;
        return Ok(Requested { audience, to });
    }
    match collab.require_members_writer(repo, audience).await {
        // not asked for, by someone who isn't a member: a thread written before its repository
        // was made public takes public replies (DESIGN §4.10 L3), so theirs is public; any
        // other members-only conversation takes none
        Err(e) if !ask.members && refused_non_member(&e) => {
            collab.request_audience(Some(Audience::Public));
            if let Ok(Audience::Public) = collab.new_audience(repo, target, reply_to).await {
                eprintln!(
                    "note: this conversation was written while {} was private; your reply is public: everyone can read it",
                    repo.display()
                );
                Ok(Requested {
                    audience: Audience::Public,
                    to: String::new(),
                })
            } else {
                collab.request_audience(None);
                Err(members_only_thread(repo))
            }
        }
        other => other
            .map(|()| Requested {
                audience,
                to: String::new(),
            })
            .map_err(Into::into),
    }
}

/// What [`requested`] found: the audience, and for a letter who it goes to, for the question
/// asked before signing.
#[derive(Debug, Clone)]
pub struct Requested {
    /// The audience the write is made for.
    pub audience: Audience,
    /// " to @bob and @carol", " to the maintainers now (@bob and @carol)", with who is left out
    /// for having no encryption key; "" when it is not a letter.
    pub to: String,
}

/// The DPNS names of everyone `sent` names, recipients and skipped.
async fn names_of(
    client: &PlatformClient,
    sent: &SentLetter,
) -> std::collections::BTreeMap<String, String> {
    let ids: Vec<&str> = sent
        .recipients
        .iter()
        .chain(&sent.skipped)
        .map(String::as_str)
        .collect();
    client.dpns_first_names(ids).await
}

/// "@bob has no encryption key" / "@bob and @carol have no encryption key": who a letter left
/// out. Only for a non-empty `sent.skipped`.
fn left_out(sent: &SentLetter, names: &std::collections::BTreeMap<String, String>) -> String {
    let who = and_list(
        &sent
            .skipped
            .iter()
            .map(|id| at_name(id, names))
            .collect::<Vec<_>>(),
    );
    let has = if sent.skipped.len() == 1 {
        "has"
    } else {
        "have"
    };
    format!("{who} {has} no encryption key")
}

/// Who a planned letter goes to, after its writer, as the question before signing says it.
async fn to_clause(client: &PlatformClient, sent: &SentLetter) -> String {
    to_clause_named(sent, &names_of(client, sent).await)
}

/// [`to_clause`] with the names known.
fn to_clause_named(
    sent: &SentLetter,
    names: &std::collections::BTreeMap<String, String>,
) -> String {
    use std::fmt::Write as _;
    let others: Vec<String> = sent
        .recipients
        .iter()
        .skip(1)
        .map(|id| at_name(id, names))
        .collect();
    let listed = if others.is_empty() {
        "nobody but you".to_string()
    } else {
        and_list(&others)
    };
    let mut out = match sent.group {
        Some(LetterGroup::Maintainers) => format!(" to the maintainers now ({listed})"),
        Some(LetterGroup::Writers) => format!(" to the writers and maintainers now ({listed})"),
        None => format!(" to {listed}"),
    };
    if !sent.skipped.is_empty() {
        let _ = write!(out, "; {} and won't receive it", left_out(sent, names));
    }
    out
}

/// The line under a list with rows this reader cannot read: "Issues 3 (1 members-only; only
/// members of o/r can read them)", "Issues 2 (1 to specific people; only the people they were
/// sent to can read them)", or both counts with "you can't read them". `None` for none.
pub fn sealed_rows_line(
    what: &str,
    total: usize,
    (members, letters): (usize, usize),
    repo: &RepoRef,
) -> Option<String> {
    Some(match (members, letters) {
        (0, 0) => return None,
        (m, 0) => format!(
            "{what} {total} ({m} members-only; only members of {} can read them)",
            repo.display()
        ),
        (0, l) => format!(
            "{what} {total} ({l} to specific people; only the people they were sent to can read them)"
        ),
        (m, l) => format!(
            "{what} {total} ({m} members-only, {l} to specific people; you can't read them)"
        ),
    })
}

/// How many of the placeholders a reader cannot open are members-only, and how many are
/// messages to specific people (what [`sealed_rows_line`] counts).
pub fn count_sealed<'a>(placeholders: impl IntoIterator<Item = &'a MembersOnly>) -> (usize, usize) {
    placeholders
        .into_iter()
        .fold((0, 0), |(members, letters), m| {
            if m.audience == Audience::SpecificPeople {
                (members, letters + 1)
            } else {
                (members + 1, letters)
            }
        })
}

/// A name for `id`: `@name` when `names` has its DPNS name, "you" for `me`, else the id.
fn person(
    id: &str,
    me: Option<&str>,
    names: &std::collections::BTreeMap<String, String>,
) -> String {
    if Some(id) == me {
        return "you".to_string();
    }
    at_name(id, names)
}

/// "a, b and c" (an Oxford-free list, as the web's).
fn and_list(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// Who a letter went to, after its writer: "@bob, @carol and you", or for a group
/// "@bob and you (maintainers when sent)" (DESIGN §10: the names, "as listed by the
/// sender"). `me` is the reader.
pub fn letter_to(
    recipients: &[String],
    group: Option<LetterGroup>,
    me: Option<&str>,
    names: &std::collections::BTreeMap<String, String>,
) -> String {
    let mut others: Vec<&String> = recipients.iter().skip(1).collect();
    // "you" last, as the web says it
    others.sort_by_key(|id| Some(id.as_str()) == me);
    let listed = and_list(
        &others
            .iter()
            .map(|id| person(id, me, names))
            .collect::<Vec<_>>(),
    );
    let listed = if listed.is_empty() {
        "nobody else".to_string()
    } else {
        listed
    };
    match group {
        Some(g) => format!("{listed} ({})", g.when_sent()),
        None => listed,
    }
}

/// The lines `dg` prints after posting a letter: who it went to, and who was left out for
/// having no encryption key.
pub async fn sent_lines(client: &PlatformClient, sent: &SentLetter) -> Vec<String> {
    let names = names_of(client, sent).await;
    let me = sent.recipients.first().map(String::as_str);
    let mut out = vec![format!(
        "  sent to {} ({}{} people, you included; only they can read it)",
        letter_to(&sent.recipients, None, me, &names),
        sent.group
            .map(|g| format!("{}; ", g.when_sent()))
            .unwrap_or_default(),
        sent.recipients.len()
    )];
    if !sent.skipped.is_empty() {
        out.push(format!(
            "  note: {} and didn't receive it",
            left_out(sent, &names)
        ));
    }
    out
}

/// What a write that may have posted a letter adds to its output: the `letter` object for
/// `--json` (`null` when it was not a letter) and the lines saying who it went to.
pub async fn posted(
    ctx: &Ctx,
    client: &PlatformClient,
    collab: &Collab<'_>,
) -> (serde_json::Value, Vec<String>) {
    let Some(sent) = collab.last_letter() else {
        return (serde_json::Value::Null, Vec::new());
    };
    let lines = if ctx.json {
        Vec::new()
    } else {
        sent_lines(client, &sent).await
    };
    (sent_json(&sent), lines)
}

/// A posted letter in `--json`: who it went to (`to`, the writer first), its group and who was
/// left out (`skipped`).
pub fn sent_json(sent: &SentLetter) -> serde_json::Value {
    serde_json::json!({
        "to": sent.recipients,
        "group": sent.group,
        "skipped": sent.skipped,
    })
}

/// An opened letter's people in `--json`: `to` (the writer first) and `group`.
pub fn letter_json(info: &LetterInfo) -> serde_json::Value {
    serde_json::json!({ "to": info.recipients, "group": info.group })
}

/// A reply refused because its conversation is members-only and the signer is not a member.
pub fn members_only_thread(repo: &RepoRef) -> anyhow::Error {
    UserError::new(
        codes::NOT_A_WRITER,
        "this conversation is members-only: only members can reply to it",
    )
    .cause(format!(
        "it is for members of {}, and you are not one",
        repo.display()
    ))
    .fix(format!(
        "become a member: `dg collab accept {}`, then ask a maintainer to add you",
        repo.display()
    ))
    .note("checked before anything was signed; nothing was written or paid")
    .into()
}

/// Whether `e` is the refusal of a members-only write by someone who is not a member.
fn refused_non_member(e: &forge_core::Error) -> bool {
    matches!(e, forge_core::Error::User(u) if u.code == codes::NOT_A_WRITER)
}

/// Whether `audience` is worth naming in `repo`: members-only content of a public repository
/// (everything in a private repository is for its members, so nothing is marked there).
pub fn marked(repo: &RepoRef, audience: Audience) -> bool {
    audience == Audience::SpecificPeople
        || (repo.visibility == Visibility::Public && audience != Audience::Public)
}

/// "members-only " before a noun ("Post a members-only comment"), or "" (a letter says who it
/// goes to after the noun: [`suffix`]).
pub fn prefix(repo: &RepoRef, audience: Audience) -> &'static str {
    if audience != Audience::SpecificPeople && marked(repo, audience) {
        "members-only "
    } else {
        ""
    }
}

/// " (members-only)" or " (to specific people)" after a line, or "".
pub fn suffix(repo: &RepoRef, audience: Audience) -> &'static str {
    match audience {
        Audience::SpecificPeople => " (to specific people)",
        _ if marked(repo, audience) => " (members-only)",
        _ => "",
    }
}

/// An item's audience as `--json` names it: `"public"` or `"members"` (`"specificPeople"` for a
/// specific-people letter).
pub fn json(audience: Audience) -> serde_json::Value {
    serde_json::to_value(audience).unwrap_or(serde_json::Value::Null)
}

/// Why a reader cannot open members-only content, in one short clause for a hint: `None` when
/// it is simply not for them (not a member).
pub fn why_hint(repo: &RepoRef, why: Unopened) -> Option<String> {
    let r = repo.display();
    match why {
        Unopened::NotAMember => None,
        Unopened::NoEncryptionKey => Some(format!(
            "you're a member of {r}, but the key stored on this computer holds no encryption key (`dg auth status`)"
        )),
        Unopened::NoKeyShared => Some(format!(
            "you're a member of {r}, but no key has been shared with you yet. Ask a maintainer to share it: Repair on the repo page, or `dg repo keys repair {r}`"
        )),
        Unopened::NotReadable => Some(format!(
            "written for a key you do not hold (after you were removed, or late); `dg repo keys status {r}` lists your keys"
        )),
        Unopened::NotForThisRepo => {
            Some("they do not open with this repository's key (not encrypted for this repo)".to_string())
        }
        Unopened::KeysUnreadable => {
            Some("the repository's keys could not be read just now; try again in a moment".to_string())
        }
        Unopened::Locked => Some(crate::common::UNLOCK_HINT.to_string()),
        Unopened::NewerVersion => {
            Some("written by a newer version of Forge; update dg to read it".to_string())
        }
        Unopened::NotARecipient => {
            Some("only the people they were sent to can read them".to_string())
        }
    }
}

/// The placeholders D14 shows in public `repo` (those that carry `asMember`; a thread's root
/// always has its row), and how many more are only counted. A private repository shows none:
/// what a member cannot open there is counted, as before.
pub fn shown<'m>(repo: &RepoRef, placeholders: &'m [MembersOnly]) -> (Vec<&'m MembersOnly>, usize) {
    let shown: Vec<&MembersOnly> = placeholders
        .iter()
        .filter(|m| m.as_member && repo.visibility == Visibility::Public)
        .collect();
    let counted = placeholders.len() - shown.len();
    (shown, counted)
}

/// A placeholder in `--json`: who, when, its number when it has one, and why it is not readable
/// here. Never anything of its content.
pub fn placeholder_json(m: &MembersOnly) -> serde_json::Value {
    serde_json::json!({
        "id": m.document_id,
        "author": m.author,
        "createdAt": m.created_at,
        "number": m.number,
        "audience": json(m.audience),
        "recipients": m.recipients,
        "readable": false,
        "why": why_word(m.why),
    })
}

/// [`Unopened`] as `--json` names it.
pub fn why_word(why: Unopened) -> &'static str {
    match why {
        Unopened::NotAMember => "notAMember",
        Unopened::NoEncryptionKey => "noEncryptionKey",
        Unopened::NoKeyShared => "noKeyShared",
        Unopened::NotReadable => "notReadable",
        Unopened::NotForThisRepo => "notForThisRepo",
        Unopened::KeysUnreadable => "keysUnreadable",
        Unopened::Locked => "locked",
        Unopened::NewerVersion => "newerVersion",
        Unopened::NotARecipient => "notARecipient",
    }
}

/// "3 members-only comments hidden (you're not a member of o/r)", or for letters (`letter`) "2
/// comments to specific people hidden: only the people they were sent to can read them", with
/// the reason for a reader who cannot read them, or `None` for none. `noun` is singular
/// ("comment"); `shown` of the `n` are placeholders above ("…hidden, 1 shown as a placeholder").
pub fn hidden_line(
    repo: &RepoRef,
    (n, shown): (usize, usize),
    noun: &str,
    why: Option<Unopened>,
    letter: bool,
) -> Option<String> {
    if n == 0 {
        return None;
    }
    let what = if letter {
        format!("{} to specific people", crate::fmt::plural(n, noun))
    } else {
        crate::fmt::plural(n, &format!("members-only {noun}"))
    };
    let shown = match shown {
        0 => String::new(),
        1 if n == 1 => ", shown as a placeholder".to_string(),
        m if m == n => ", shown as placeholders".to_string(),
        1 => ", 1 shown as a placeholder".to_string(),
        m => format!(", {m} shown as placeholders"),
    };
    Some(match why.and_then(|w| why_hint(repo, w)) {
        None => format!(
            "{what} hidden{shown} (you're not a member of {})",
            repo.display()
        ),
        Some(hint) => format!("{what} hidden{shown}: {hint}"),
    })
}

/// `@name` for an identity whose DPNS name `names` holds, else its id: how DESIGN §10 names
/// the author of a members-only item ("#3 · members-only issue by @alice · open").
pub fn at_name(id: &str, names: &std::collections::BTreeMap<String, String>) -> String {
    names
        .get(id)
        .map_or_else(|| id.to_string(), |n| format!("@{}", crate::fmt::safe(n)))
}

/// "members-only issue" / "issue to 3 people": a sealed item's kind (a letter's recipient
/// count is public, D3).
pub fn sealed_noun(m: &MembersOnly, noun: &str) -> String {
    match (m.audience, m.recipients) {
        (Audience::SpecificPeople, Some(n)) => format!(
            "{noun} to {}",
            forge_core::rules::letters::people(usize::from(n))
        ),
        (Audience::SpecificPeople, None) => format!("{noun} to specific people"),
        _ => format!("members-only {noun}"),
    }
}

/// One line for a members-only issue or PR this reader cannot open (DESIGN §10, D14: its
/// number is public anyway): "#3 · members-only issue by @alice · open".
pub fn target_line(number: u32, noun: &str, m: &MembersOnly, who: &str, state: &str) -> String {
    format!("#{number} · {} by {who} · {state}", sealed_noun(m, noun))
}

/// The state word of a target from its transitions (public even when its text is not).
pub fn state_word(kind: TargetKind, log: &TargetLog) -> &'static str {
    let status = forge_core::rules::v2::status_of_code(log.state_code());
    if kind == TargetKind::Patch && status.merged {
        "merged"
    } else if status.open {
        "open"
    } else {
        "closed"
    }
}

/// `dg issue view` / `dg pr view` of a members-only issue or PR this reader cannot open: its
/// row (who, when, open or closed) and why it is not readable here, exit 0. Never E102 ("not
/// found": its number is public) and never an error: an outsider reading it is expected.
pub async fn target_view(
    ctx: &Ctx,
    s: &Reader,
    kind: TargetKind,
    number: u32,
    m: &MembersOnly,
) -> Result<()> {
    let log = s.collab().target_log(&s.repo, &m.document_id).await?;
    let state = state_word(kind, &log);
    let m = &s.placeholders(vec![m.clone()])[0];
    let hint = why_hint(&s.repo, m.why);
    let repo = s.repo.display();
    // A thread written before its repository was made public takes public replies (DESIGN §4.10
    // L3): the ones this reader can read are shown under its row.
    let replies = if s.repo.visibility == Visibility::Public {
        let collab = s.collab();
        let all = collab.comments(&s.repo, &m.document_id).await?;
        // what maintainers hid stays collapsed here too (`dg issue view --show-hidden` on a
        // thread one can read shows it)
        let target = forge_core::collab::v2::Target {
            kind,
            id: m.document_id.clone(),
            number,
            author: m.author.clone(),
        };
        let hidden = collab
            .hidden_items(&s.repo, &target, &log, &all, &[])
            .await?;
        if hidden.thread.is_some() {
            Vec::new()
        } else {
            all.into_iter()
                .filter(|c| hidden.item(&c.document_id).is_none())
                .collect()
        }
    } else {
        Vec::new()
    };
    let names = if ctx.json {
        std::collections::BTreeMap::new()
    } else {
        s.client
            .dpns_first_names(
                std::iter::once(m.author.as_str()).chain(replies.iter().map(|c| c.author.as_str())),
            )
            .await
    };
    // The shape `dg issue view --json` / `dg pr view --json` gives a readable one, with what is
    // not readable here null or empty, and `readable` false.
    let mut out = serde_json::json!({
        "number": number,
        "id": m.document_id,
        "documentId": m.document_id,
        "title": null,
        "body": null,
        "author": m.author,
        "createdAt": m.created_at,
        "audience": json(m.audience),
        "recipients": m.recipients,
        "readable": false,
        "why": why_word(m.why),
        "comments": replies.iter().map(|c| serde_json::json!({"id": c.document_id, "author": c.author, "body": c.body, "audience": json(c.audience), "replyTo": c.reply_to, "createdAt": c.created_at})).collect::<Vec<_>>(),
        "membersOnlyComments": [],
        "events": [],
        "transitions": [],
    });
    let open = state == "open";
    let more = match kind {
        TargetKind::Issue => serde_json::json!({
            "state": state,
            "open": open,
            "labels": [],
            "assignees": [],
        }),
        TargetKind::Patch => serde_json::json!({
            "state": state,
            "labels": [],
            "assignees": [],
            "reviews": [],
        }),
    };
    if let (Some(o), serde_json::Value::Object(more)) = (out.as_object_mut(), more) {
        o.extend(more);
    }
    ctx.emit(out, || {
        println!(
            "{}",
            target_line(number, kind.noun(), m, &at_name(&m.author, &names), state)
        );
        match &hint {
            _ if m.why == Unopened::NotARecipient => {
                println!("(only the people it was sent to can read it)");
            }
            Some(h) => println!("({h})"),
            None => println!("(only members of {repo} can read it)"),
        }
        for c in &replies {
            println!();
            println!(
                "{}{}:",
                at_name(&c.author, &names),
                suffix(&s.repo, c.audience)
            );
            println!("{}", crate::fmt::safe(&c.body));
        }
    });
    Ok(())
}

/// The notes a view prints under its items for those it could not show: the members-only ones
/// this reader cannot open ("3 members-only comments hidden (you're not a member of o/r)"),
/// and malformed ones, never one for the other. In a private repository, one note as before.
pub fn hidden_notes(
    repo: &RepoRef,
    malformed: usize,
    members_only: &[&MembersOnly],
    noun: &str,
) -> Vec<String> {
    if repo.visibility == Visibility::Private {
        let n = malformed + members_only.len();
        return (n > 0)
            .then(|| crate::fmt::hidden_note(repo, n))
            .into_iter()
            .collect();
    }
    // one line per reason (and letters apart), in a fixed order, each counting the
    // placeholders D14 shows
    let mut by_why: Vec<((bool, Unopened), usize, usize)> = Vec::new();
    for m in members_only {
        let shown = usize::from(m.as_member);
        let key = (m.audience == Audience::SpecificPeople, m.why);
        match by_why.iter_mut().find(|(w, _, _)| *w == key) {
            Some(e) => {
                e.1 += 1;
                e.2 += shown;
            }
            None => by_why.push((key, 1, shown)),
        }
    }
    by_why.sort_by_key(|((letter, w), _, _)| (*letter, why_word(*w)));
    by_why
        .into_iter()
        .filter_map(|((letter, why), n, shown)| {
            hidden_line(repo, (n, shown), noun, Some(why), letter)
        })
        .chain((malformed > 0).then(|| crate::fmt::hidden_note(repo, malformed)))
        .collect()
}

/// What maintainers made public among the posts a view read (DESIGN §4.6): by whom, and
/// whether the author sealed a post again since.
pub struct Published(std::collections::BTreeMap<String, forge_core::collab::v2::Publication>);

impl Published {
    /// The publications `collab`'s reads noted for `ids`.
    pub fn of<'a>(collab: &Collab<'_>, ids: impl IntoIterator<Item = &'a str>) -> Self {
        Self(
            ids.into_iter()
                .filter_map(|id| collab.publication(id).map(|p| (id.to_string(), p)))
                .collect(),
        )
    }

    /// The maintainers named, for the names lookup.
    pub fn people(&self) -> impl Iterator<Item = &str> {
        self.0.values().map(|p| p.by.as_str())
    }

    /// `--json`: `null`, or `{"by", "state": "public" | "editedAfter", "publishedRevision"}`.
    pub fn json(&self, id: &str) -> serde_json::Value {
        use forge_core::collab::v2::PublicationState;
        match self.0.get(id) {
            None => serde_json::Value::Null,
            Some(p) => match p.state {
                PublicationState::Public => serde_json::json!({ "by": p.by, "state": "public" }),
                PublicationState::EditedAfter { published_revision } => serde_json::json!({
                    "by": p.by,
                    "state": "editedAfter",
                    "publishedRevision": published_revision,
                }),
            },
        }
    }

    /// The line a post read as `audience` gets: "made public by @m", or what an edit since
    /// changed.
    pub fn line(
        &self,
        id: &str,
        audience: Audience,
        who: &dyn Fn(&str) -> String,
    ) -> Option<String> {
        use forge_core::collab::v2::PublicationState;
        let p = self.0.get(id)?;
        let by = who(&p.by);
        Some(match (&p.state, audience) {
            (PublicationState::Public, _) => format!("made public by {by}"),
            (PublicationState::EditedAfter { .. }, Audience::Public) => {
                format!("the version {by} made public; edited since, for members only")
            }
            (PublicationState::EditedAfter { .. }, _) => {
                format!("edited after {by} made it public: this version is members-only")
            }
        })
    }
}

/// `--json`: the make-public entries that did not match the post they named.
pub fn alerts_json(alerts: &[forge_core::collab::v2::BundleAlert]) -> serde_json::Value {
    serde_json::Value::Array(
        alerts
            .iter()
            .map(|a| serde_json::json!({ "documentId": a.document_id, "revision": a.revision, "by": a.by }))
            .collect(),
    )
}

/// The warning for each make-public entry that does not match the post it names: ignored.
pub fn alert_lines(
    alerts: &[forge_core::collab::v2::BundleAlert],
    who: &dyn Fn(&str) -> String,
) -> Vec<String> {
    alerts
        .iter()
        .map(|a| {
            format!(
                "warning: {}'s make-public entry for post {} doesn't match it, so it was ignored",
                who(&a.by),
                a.document_id
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(visibility: Visibility) -> RepoRef {
        RepoRef {
            forge: forge_core::network::ForgeIds::test_forge(),
            repo_id: "r".into(),
            owner_id: "o".into(),
            name: "n".into(),
            visibility,
        }
    }

    #[test]
    fn only_members_content_of_a_public_repo_is_marked() {
        let public = repo(Visibility::Public);
        let private = repo(Visibility::Private);
        assert_eq!(prefix(&public, Audience::Members), "members-only ");
        assert_eq!(suffix(&public, Audience::Members), " (members-only)");
        assert_eq!(prefix(&public, Audience::Public), "");
        assert_eq!(prefix(&private, Audience::Members), "");
        assert_eq!(json(Audience::Members), serde_json::json!("members"));
        assert_eq!(json(Audience::Public), serde_json::json!("public"));
    }

    #[test]
    fn the_question_before_signing_names_who_a_letter_goes_to() {
        let names = std::collections::BTreeMap::from([("B".to_string(), "bob".to_string())]);
        let sent = |group, recipients: &[&str], skipped: &[&str]| SentLetter {
            recipients: recipients.iter().map(ToString::to_string).collect(),
            skipped: skipped.iter().map(ToString::to_string).collect(),
            group,
        };
        assert_eq!(
            to_clause_named(&sent(None, &["Me", "B", "C"], &[]), &names),
            " to @bob and C"
        );
        assert_eq!(
            to_clause_named(
                &sent(Some(LetterGroup::Maintainers), &["Me", "B"], &["K"]),
                &names
            ),
            " to the maintainers now (@bob); K has no encryption key and won't receive it"
        );
        assert_eq!(
            to_clause_named(&sent(Some(LetterGroup::Writers), &["Me"], &[]), &names),
            " to the writers and maintainers now (nobody but you)"
        );
    }

    #[test]
    fn a_sealed_number_reads_as_its_row() {
        let m = MembersOnly {
            document_id: "d".into(),
            author: "A".into(),
            created_at: 1,
            as_member: true,
            number: Some(3),
            audience: Audience::Members,
            recipients: None,
            why: Unopened::NotAMember,
        };
        assert_eq!(
            target_line(3, "issue", &m, "@alice", "open"),
            "#3 · members-only issue by @alice · open"
        );
        let mut names = std::collections::BTreeMap::new();
        assert_eq!(at_name("A", &names), "A");
        names.insert("A".to_string(), "alice".to_string());
        assert_eq!(at_name("A", &names), "@alice");
    }

    #[test]
    fn notes_keep_members_only_and_malformed_apart() {
        let m = MembersOnly {
            document_id: "d".into(),
            author: "A".into(),
            created_at: 1,
            as_member: false,
            number: None,
            audience: Audience::Members,
            recipients: None,
            why: Unopened::NotAMember,
        };
        let public = repo(Visibility::Public);
        let notes = hidden_notes(&public, 1, &[&m, &m], "comment");
        assert_eq!(notes.len(), 2);
        assert!(
            notes[0].starts_with("2 members-only comments hidden"),
            "{notes:?}"
        );
        assert!(notes[1].contains("1 malformed"), "{notes:?}");
        assert!(hidden_notes(&public, 0, &[], "comment").is_empty());
        let private = repo(Visibility::Private);
        let one = hidden_notes(&private, 1, &[&m], "comment");
        assert_eq!(one.len(), 1);
        assert!(one[0].starts_with("(2 "), "{one:?}");
        assert!(one[0].contains("hidden"), "{one:?}");
    }

    /// Each reason gets its own line, and the placeholders shown above are counted apart.
    #[test]
    fn notes_name_every_reason_and_the_placeholders_shown() {
        let placeholder = |why, as_member| MembersOnly {
            document_id: "d".into(),
            author: "A".into(),
            created_at: 1,
            as_member,
            number: None,
            audience: Audience::Members,
            recipients: None,
            why,
        };
        let public = repo(Visibility::Public);
        let (shown, counted, locked) = (
            placeholder(Unopened::NotReadable, true),
            placeholder(Unopened::NotReadable, false),
            placeholder(Unopened::Locked, true),
        );
        let notes = hidden_notes(&public, 0, &[&shown, &counted, &locked], "comment");
        assert_eq!(notes.len(), 2, "{notes:?}");
        assert!(
            notes.iter().any(|l| l.starts_with(
                "1 members-only comment hidden, shown as a placeholder: unlock your key"
            )),
            "{notes:?}"
        );
        assert!(
            notes.iter().any(|l| l.starts_with(
                "2 members-only comments hidden, 1 shown as a placeholder: written for a key"
            )),
            "{notes:?}"
        );
        assert!(
            notes.iter().all(|l| !l.contains("not a member")),
            "{notes:?}"
        );
    }

    #[test]
    fn the_hidden_line_says_why_without_calling_it_malformed() {
        let r = repo(Visibility::Public);
        let line = hidden_line(&r, (3, 0), "comment", Some(Unopened::NotAMember), false).unwrap();
        assert!(
            line.starts_with("3 members-only comments hidden (you're not a member of "),
            "{line}"
        );
        assert!(!line.contains("malformed"));
        assert_eq!(hidden_line(&r, (0, 0), "comment", None, false), None);
        let one = hidden_line(&r, (1, 0), "review", Some(Unopened::NoKeyShared), false).unwrap();
        assert!(
            one.starts_with("1 members-only review hidden: you're a member"),
            "{one}"
        );
    }
}
