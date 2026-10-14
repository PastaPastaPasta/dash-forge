//! Asking a bot to work on something: member `event` kind 27 (mixed-visibility DESIGN §4.9
//! "Asking a bot", D33; `docs/security/private-repos.md` §22.2), a client convention inside the
//! contract's open `event.kind` (4–255 on sakura's live set, which admits it from a maintainer or
//! a role-1/role-2 writer; the registered set's triage allow-list leaves 27 out, so there only a
//! maintainer or a role-1 writer).
//!
//! * `targetId` / `targetNumber`: the issue or pull request the bot is asked about;
//! * `refId`: **the bot's identity id**. It puts the request in the sparse `addressee
//!   (refId, $createdAt)` index under the bot, so a runner reads its bot's requests, newest past
//!   its cursor, with one query, as it reads CI re-runs (kind 26) under the repository's id;
//! * `value`: the task (1–120 characters, at most 480 bytes, `event.value`'s bounds). Like every
//!   event value it follows its target: sealed in `enc` on a members-only thread and in a
//!   private repository, so everyone sees that someone asked and only members what.
//!
//! What a client checks before signing ([`check_ask`], E813): the bot's current access notice
//! ([`crate::private::access_notice`]) is live, allows something, names the asker's role among
//! its askers and the thread among its threads, and allows reading on request when the thread
//! is members-only. On a members-only thread the asker also writes the `read` key letter
//! (kind 10), which needs Write. A runner applies the same check to the notice that counted when
//! the request was written ([`request_allowed`]).

use serde::{Deserialize, Serialize};

use super::v2::Role;
use crate::private::access_notice::{AccessNotice, Askers, MAY_READ_ON_REQUEST};

/// The `event.kind` of a request to a bot.
pub const AGENT_REQUEST_KIND: u64 = 27;

/// A task's bounds: characters, then UTF-8 bytes (`event.value`).
pub const TASK_MAX: (usize, usize) = (120, 480);

/// Whether `task` fits an event's `value` (1–120 characters, at most 480 bytes, no control
/// character but a newline).
#[must_use]
pub fn is_task(task: &str) -> bool {
    !task.trim().is_empty()
        && task.chars().count() <= TASK_MAX.0
        && task.len() <= TASK_MAX.1
        && !task.chars().any(|c| c.is_control() && c != '\n')
}

/// An `event` document as the request rule reads it (ids as base58).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestEvent {
    /// `$id`.
    pub id: String,
    /// `repoId`.
    pub repo_id: String,
    /// `targetId`.
    pub target_id: String,
    /// `targetNumber`.
    pub target_number: u64,
    /// `kind`.
    pub kind: u64,
    /// `refId`, when present.
    #[serde(default)]
    pub ref_id: Option<String>,
    /// `value` (opened, when sealed and this reader holds the key), when present.
    #[serde(default)]
    pub value: Option<String>,
    /// A sealed `value` this reader could not open: the task is members-only.
    #[serde(default)]
    pub value_hidden: bool,
    /// `$ownerId`: who asked.
    pub actor: String,
    /// `$createdAt` (ms).
    pub created_at: u64,
}

/// A well-formed request to a bot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequest {
    /// The event's `$id`: the job a `read` letter names.
    pub id: String,
    /// The issue's or pull request's document id.
    pub target_id: String,
    /// Its number.
    pub number: u32,
    /// The bot asked (base58).
    pub bot: String,
    /// The task, or `None` when it is members-only and this reader cannot open it.
    pub task: Option<String>,
    /// Who asked.
    pub asker: String,
    /// When (`$createdAt`, ms).
    pub created_at: u64,
}

/// The request `e` makes in repository `repo_id`, or `None` when it is not a well-formed one:
/// another kind, another repository's event, no `refId` (no bot), no target number, or a task
/// that is neither readable within bounds nor sealed.
#[must_use]
pub fn agent_request(repo_id: &str, e: &RequestEvent) -> Option<AgentRequest> {
    if e.kind != AGENT_REQUEST_KIND || e.repo_id != repo_id {
        return None;
    }
    let bot = e.ref_id.clone().filter(|b| !b.is_empty())?;
    let number = u32::try_from(e.target_number).ok().filter(|n| *n > 0)?;
    let task = match (&e.value, e.value_hidden) {
        (Some(v), _) if is_task(v) => Some(v.clone()),
        (None, true) => None,
        _ => return None,
    };
    Some(AgentRequest {
        id: e.id.clone(),
        target_id: e.target_id.clone(),
        number,
        bot,
        task,
        asker: e.actor.clone(),
        created_at: e.created_at,
    })
}

/// Why asking a bot is refused before signing (E813).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "why")]
pub enum AskRefusal {
    /// No current notice gives the bot access here, or the newest allows nothing.
    NoAccess,
    /// The notice's `until` has passed.
    Ended {
        /// When it ended (ms).
        until: u64,
    },
    /// The asker's role is not among the notice's askers.
    Askers {
        /// Who may ask.
        askers: Askers,
        /// The asker's role (`None`: not a member).
        role: Option<Role>,
    },
    /// The notice lists threads and this is not one of them.
    Thread {
        /// The thread asked about.
        number: u32,
    },
    /// The thread is members-only and the notice does not let the bot read on request.
    NoRead,
}

/// Whether `role` (the owner passes as [`Role::Maintainer`]) is among `askers`.
#[must_use]
pub fn asker_allowed(askers: Askers, role: Option<Role>) -> bool {
    match askers {
        Askers::Writers => matches!(role, Some(Role::Maintainer | Role::Writer)),
        Askers::Maintainers => role == Some(Role::Maintainer),
    }
}

/// Check, before anything is signed, that someone of `role` (the owner as
/// [`Role::Maintainer`]; `None` outside the members) may ask the bot of `notice` (its current
/// notice, if any) about thread `number`, members-only or not, at `now` (ms).
///
/// # Errors
/// The first [`AskRefusal`] that applies, in the order: access, its end, askers, threads,
/// reading.
pub fn check_ask(
    notice: Option<&AccessNotice>,
    role: Option<Role>,
    number: u32,
    members_only: bool,
    now: u64,
) -> Result<(), AskRefusal> {
    let n = notice
        .filter(|n| !n.may.is_empty())
        .ok_or(AskRefusal::NoAccess)?;
    if let Some(until) = n.until.filter(|_| !n.live_at(now)) {
        return Err(AskRefusal::Ended { until });
    }
    if !asker_allowed(n.askers, role) {
        return Err(AskRefusal::Askers {
            askers: n.askers,
            role,
        });
    }
    if !n.threads.covers(number) {
        return Err(AskRefusal::Thread { number });
    }
    if members_only && !n.may(MAY_READ_ON_REQUEST) {
        return Err(AskRefusal::NoRead);
    }
    Ok(())
}

/// Whether a written request counts for a runner: [`check_ask`] passes for the asker's role at
/// the request's `$createdAt` against the notice that counted then.
#[must_use]
pub fn request_allowed(
    req: &AgentRequest,
    notice: Option<&AccessNotice>,
    role_then: Option<Role>,
    members_only: bool,
) -> bool {
    check_ask(notice, role_then, req.number, members_only, req.created_at).is_ok()
}

/// A role as the access copy names it (DESIGN §10 glossary).
#[must_use]
pub fn role_words(role: Option<Role>) -> &'static str {
    match role {
        Some(Role::Maintainer) => "Maintain access",
        Some(Role::Writer) => "Write access",
        Some(Role::Triage) => "Triage access",
        Some(Role::Reader) => "Read access",
        Some(Role::Bot) => "the Bot role",
        None => "no access",
    }
}

impl AskRefusal {
    /// The E813 message and its fix line, for bot `@bot` in repository `repo` (`o/r`), with
    /// `until_words` the notice's end as the copy writes a date.
    #[must_use]
    pub fn words(&self, bot: &str, repo: &str, until_words: &str) -> (String, String) {
        let change = format!("ask a maintainer to change {bot}'s access");
        match self {
            Self::NoAccess => (
                format!("{bot} has no access in {repo}"),
                format!("ask a maintainer to give {bot} access (Settings → Bots and runners)"),
            ),
            Self::Ended { .. } => (
                format!("{bot}'s access in {repo} ended on {until_words}"),
                change,
            ),
            Self::Askers { askers, role } => {
                let who = match askers {
                    Askers::Writers => "someone with Write access",
                    Askers::Maintainers => "a maintainer",
                };
                let people = match role {
                    None => format!("people outside {repo}'s members"),
                    Some(_) => format!("people with {}", role_words(*role)),
                };
                (
                    format!("{bot} can't be asked by {people} in {repo}"),
                    format!("{change}, or ask {who}"),
                )
            }
            Self::Thread { number } => (
                format!("{bot} can't be asked about #{number} in {repo}"),
                format!("ask a maintainer to add #{number} to {bot}'s access"),
            ),
            Self::NoRead => (
                format!("{bot} can't read members-only threads in {repo}"),
                format!(
                    "ask a maintainer to let {bot} read pull requests and issues it's asked about"
                ),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::private::access_notice::{Threads, MAY_POST};

    fn notice(may: &[&str], askers: Askers, threads: Threads) -> AccessNotice {
        AccessNotice {
            may: may.iter().map(|s| (*s).to_owned()).collect(),
            askers,
            threads,
            until: Some(1000),
            ..AccessNotice::empty([1; 32])
        }
    }

    #[test]
    fn asking_follows_the_notice() {
        let n = notice(
            &[MAY_POST, MAY_READ_ON_REQUEST],
            Askers::Writers,
            Threads::Listed(vec![42]),
        );
        let w = Some(Role::Writer);
        assert_eq!(check_ask(Some(&n), w, 42, true, 10), Ok(()));
        assert_eq!(check_ask(None, w, 42, false, 10), Err(AskRefusal::NoAccess));
        let revoked = notice(&[], Askers::Writers, Threads::All);
        assert_eq!(
            check_ask(Some(&revoked), w, 42, false, 10),
            Err(AskRefusal::NoAccess)
        );
        assert_eq!(
            check_ask(Some(&n), w, 42, false, 1000),
            Err(AskRefusal::Ended { until: 1000 })
        );
        assert_eq!(
            check_ask(Some(&n), Some(Role::Triage), 42, false, 10),
            Err(AskRefusal::Askers {
                askers: Askers::Writers,
                role: Some(Role::Triage)
            })
        );
        assert_eq!(
            check_ask(Some(&n), w, 7, false, 10),
            Err(AskRefusal::Thread { number: 7 })
        );
        let post_only = notice(&[MAY_POST], Askers::Maintainers, Threads::All);
        assert_eq!(
            check_ask(Some(&post_only), Some(Role::Maintainer), 7, true, 10),
            Err(AskRefusal::NoRead)
        );
        assert!(matches!(
            check_ask(Some(&post_only), w, 7, false, 10),
            Err(AskRefusal::Askers { .. })
        ));
        assert_eq!(
            check_ask(Some(&post_only), Some(Role::Maintainer), 7, false, 10),
            Ok(())
        );
    }

    #[test]
    fn the_triage_refusal_reads_as_the_design_says() {
        let (msg, fix) = AskRefusal::Askers {
            askers: Askers::Writers,
            role: Some(Role::Triage),
        }
        .words("@ci-bot", "o/r", "");
        assert_eq!(msg, "@ci-bot can't be asked by people with Triage access in o/r");
        assert_eq!(
            fix,
            "ask a maintainer to change @ci-bot's access, or ask someone with Write access"
        );
    }

    #[test]
    fn a_request_names_its_bot_and_its_task() {
        let e = RequestEvent {
            id: "E".into(),
            repo_id: "R".into(),
            target_id: "T".into(),
            target_number: 42,
            kind: AGENT_REQUEST_KIND,
            ref_id: Some("B".into()),
            value: Some("fix the failing test".into()),
            value_hidden: false,
            actor: "A".into(),
            created_at: 5,
        };
        let r = agent_request("R", &e).unwrap();
        assert_eq!((r.bot.as_str(), r.number), ("B", 42));
        assert_eq!(r.task.as_deref(), Some("fix the failing test"));
        let hidden = RequestEvent {
            value: None,
            value_hidden: true,
            ..e.clone()
        };
        assert_eq!(agent_request("R", &hidden).unwrap().task, None);
        assert!(agent_request("other", &e).is_none());
        assert!(agent_request("R", &RequestEvent { ref_id: None, ..e.clone() }).is_none());
        assert!(agent_request("R", &RequestEvent { value: None, ..e.clone() }).is_none());
        assert!(agent_request("R", &RequestEvent { kind: 26, ..e }).is_none());
        assert!(!is_task(&"x".repeat(121)) && !is_task(" ") && is_task("a\nb"));
    }
}
