//! `dg env` — environments: per-environment configuration and secrets kept outside git
//! (`forge_core::env`; mixed-visibility design §4.5, phase 1 "Environments lite", phase R).
//!
//! Each change saves a new snapshot of one whole environment, encrypted as a letter to the people
//! its audience covers when it is saved: Maintainers, Writers and maintainers, All members, or
//! Specific people, plus anyone added (a CI bot). There is no default: the first save names the
//! audience (E611 otherwise). Only maintainers change environments. A snapshot counts only when
//! its author is a current maintainer; two people changing one environment at once leave two
//! versions, which `run`, `get` and `export` refuse until a maintainer keeps one (`--keep`).
//! Every membership change that changes a group saves its environments again (D34,
//! [`prepare_regroup`]).

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::io::{IsTerminal as _, Read as _, Write as _};
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};
use clap::{Args, Subcommand, ValueEnum};
use serde_json::{json, Value};
use zeroize::Zeroizing;

use forge_core::env::format::{diff, parse_dotenv, render_dotenv, Change};
use forge_core::env::service::{
    audience_required, conflict_error, conflict_headline, not_shared_yet, resolve_people, utc,
    Blocked, Book, Draft, Environments, Prepared,
};
use forge_core::env::{
    valid_env_name, valid_var_name, Audience, Group, Snapshot, Var, VarType, ACCESS_SENTENCE,
    OLD_FORMAT_HISTORY_SENTENCE, OLD_FORMAT_SENTENCE,
};
use forge_core::members::{Member, MemberReader};
use forge_core::rules::v2::Role;
use forge_core::scope::RepoRef as Repo;
use forge_core::user_error::{codes, UserError};

use crate::common::Session;
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line};

/// An audience as `--audience` takes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum AudienceArg {
    /// The owner and maintainers.
    Maintainers,
    /// The owner, maintainers and writers ("Writers and maintainers").
    Writers,
    /// Every member: maintainers, writers, triage members and readers ("All members").
    Members,
    /// Only the people given with --to ("Specific people").
    People,
}

impl AudienceArg {
    fn group(self) -> Option<Group> {
        match self {
            Self::Maintainers => Some(Group::Maintainers),
            Self::Writers => Some(Group::Writers),
            Self::Members => Some(Group::Members),
            Self::People => None,
        }
    }
}

/// Who can read an environment, as `set`, `edit` and `import` take it.
#[derive(Debug, Clone, Default, Args)]
pub struct AudienceOpts {
    /// Who can read the environment. Required the first time it is saved; later changes keep
    /// it unless you give it again.
    #[arg(long, value_enum)]
    pub audience: Option<AudienceArg>,
    /// With `--audience people`: who (identity ids or names, comma-separated). You are added.
    #[arg(long, value_delimiter = ',', value_name = "@ID,...")]
    pub to: Vec<String>,
    /// Also give these people access beside the group (a CI bot, for example).
    #[arg(long, value_delimiter = ',', value_name = "@ID,...")]
    pub also: Vec<String>,
}

impl AudienceOpts {
    fn given(&self) -> bool {
        self.audience.is_some() || !self.to.is_empty() || !self.also.is_empty()
    }
}

/// The identities `who` names (ids or names, `@` optional), as base58 ids.
async fn identities(s: &Session, who: &[String]) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for w in who.iter().map(|w| w.trim()).filter(|w| !w.is_empty()) {
        out.push(crate::common::resolve_identity(&s.client, w, "person").await?);
    }
    Ok(out)
}

/// The audience `opts` give (none when they give none), the people resolved to identity ids.
/// Specific people always include the signer.
async fn audience_of(s: &Session, opts: &AudienceOpts) -> Result<Option<Audience>> {
    if !opts.given() {
        return Ok(None);
    }
    let usage = |m: &str| -> anyhow::Error { UserError::new(codes::USAGE, m.to_owned()).into() };
    let Some(arg) = opts.audience else {
        return Err(usage(
            "--to and --also go with --audience (to add people to an existing environment, use `dg env share`)",
        ));
    };
    match arg {
        AudienceArg::People if opts.to.is_empty() && opts.also.is_empty() => {
            Err(usage("--audience people needs --to @someone,@someone-else"))
        }
        AudienceArg::People => {
            let mut people = identities(s, &opts.to).await?;
            people.extend(identities(s, &opts.also).await?);
            people.push(s.identity.id());
            Ok(Some(Audience::new(None, people)))
        }
        _ if !opts.to.is_empty() => Err(usage(
            "--to goes with --audience people; to add people to a group, use --also",
        )),
        group => Ok(Some(Audience::new(
            group.group(),
            identities(s, &opts.also).await?,
        ))),
    }
}

/// `dg env` subcommands.
#[derive(Debug, Subcommand)]
pub enum EnvCommand {
    /// List environments, or one environment's entries
    ///
    /// Values are never shown: use `dg env get` or `dg env run`.
    #[command(visible_alias = "list")]
    Ls {
        /// The repository (`owner/name`; default: this clone's).
        repo: String,
        /// Show this environment's entries.
        #[arg(long)]
        env: Option<String>,
    },
    /// Print one value
    ///
    /// The value goes to stdout, for scripts.
    Get {
        /// The repository.
        repo: String,
        /// The entry's name.
        name: String,
        /// The environment.
        #[arg(long)]
        env: String,
    },
    /// Set entries, as one change
    ///
    /// Give `NAME=value`, or `NAME` alone to be asked for the value. With one `NAME` and no
    /// terminal, the value is read from stdin. Values on the command line can be seen by other
    /// users of this computer.
    Set {
        /// The repository.
        repo: String,
        /// `NAME=value` or `NAME`.
        #[arg(required = true, value_name = "NAME[=VALUE]")]
        entries: Vec<String>,
        /// The environment.
        #[arg(long)]
        env: String,
        /// Mark these entries as secrets (otherwise a new entry is a plain setting and an existing
        /// one keeps its type).
        #[arg(long)]
        secret: bool,
        /// A note for these entries (shown with them; not secret from the audience).
        #[arg(long)]
        note: Option<String>,
        #[command(flatten)]
        who: AudienceOpts,
        /// Two versions exist: keep this one (its id or the start of it) and change it.
        #[arg(long, value_name = "ID")]
        keep: Option<String>,
    },
    /// Remove entries, as one change
    Unset {
        /// The repository.
        repo: String,
        /// The entries' names.
        #[arg(required = true)]
        names: Vec<String>,
        /// The environment.
        #[arg(long)]
        env: String,
        /// Two versions exist: keep this one (its id or the start of it) and change it.
        #[arg(long, value_name = "ID")]
        keep: Option<String>,
    },
    /// Edit an environment in your editor
    ///
    /// Opens $VISUAL or $EDITOR on the whole environment and saves it as one change. The
    /// temporary file is private to you and removed afterwards. Your editor may keep its own
    /// swap or backup copies elsewhere.
    Edit {
        /// The repository.
        repo: String,
        /// The environment.
        #[arg(long)]
        env: String,
        /// Mark new and changed entries as secrets.
        #[arg(long)]
        secret: bool,
        #[command(flatten)]
        who: AudienceOpts,
        /// Two versions exist: start from this one (its id or the start of it).
        #[arg(long, value_name = "ID")]
        keep: Option<String>,
    },
    /// Import a .env file, as one change
    ///
    /// Give `-` to read stdin.
    Import {
        /// The repository.
        repo: String,
        /// The file.
        file: PathBuf,
        /// The environment.
        #[arg(long)]
        env: String,
        /// Mark the imported entries as secrets.
        #[arg(long)]
        secret: bool,
        #[command(flatten)]
        who: AudienceOpts,
        /// Two versions exist: keep this one (its id or the start of it) and change it.
        #[arg(long, value_name = "ID")]
        keep: Option<String>,
    },
    /// Run a command with an environment's values
    ///
    /// The values are added to the command's environment variables only. Nothing is written to
    /// disk.
    Run {
        /// The repository.
        repo: String,
        /// The environment.
        #[arg(long)]
        env: String,
        /// Let the environment replace variables this shell already has, or set ones that change
        /// how programs start (PATH, LD_*, DYLD_*, NODE_OPTIONS, PYTHONPATH, GIT_* and others).
        #[arg(long)]
        allow_env_override: bool,
        /// The command and its arguments, after `--`.
        #[arg(last = true, required = true, value_name = "COMMAND")]
        command: Vec<String>,
    },
    /// Write an environment as .env text
    ///
    /// With -o, to a file only you can read, kept out of git. Without it, to stdout for piping.
    Export {
        /// The repository.
        repo: String,
        /// The environment.
        #[arg(long)]
        env: String,
        /// Write to this file (created 0600, added to .git/info/exclude and checked with
        /// `git check-ignore`).
        #[arg(short, long, value_name = "FILE")]
        output: Option<PathBuf>,
        /// Replace the file when it exists.
        #[arg(long, requires = "output")]
        force: bool,
    },
    /// Show who changed an environment, and when
    ///
    /// Each change lists the entries it touched, never their values.
    History {
        /// The repository.
        repo: String,
        /// The environment.
        #[arg(long)]
        env: String,
    },
    /// Change who can read an environment
    ///
    /// Saves it again for the new audience. Earlier versions stay readable by whoever could read
    /// them.
    Audience {
        /// The repository.
        repo: String,
        /// The environment.
        #[arg(long)]
        env: String,
        /// The new audience.
        #[arg(long = "set", value_enum, value_name = "AUDIENCE")]
        set: AudienceArg,
        /// With `--set people`: who (identity ids or names, comma-separated). You are added.
        #[arg(long, value_delimiter = ',', value_name = "@ID,...")]
        to: Vec<String>,
        /// Also give these people access beside the group.
        #[arg(long, value_delimiter = ',', value_name = "@ID,...")]
        also: Vec<String>,
    },
    /// Give more people access to an environment
    ///
    /// Adds them beside its audience and saves it again. They read its current values, not
    /// earlier ones.
    Share {
        /// The repository.
        repo: String,
        /// The environment.
        #[arg(long)]
        env: String,
        /// Who (identity ids or names).
        #[arg(required = true, value_name = "@ID")]
        people: Vec<String>,
    },
    /// Stop giving people access to an environment
    ///
    /// Saves it again without them and lists the values they could read, to change where
    /// they're used.
    Unshare {
        /// The repository.
        repo: String,
        /// The environment.
        #[arg(long)]
        env: String,
        /// Who (identity ids or names).
        #[arg(required = true, value_name = "@ID")]
        people: Vec<String>,
    },
    /// Save environments again for the people their audience covers now
    ///
    /// For someone who joined a group or changed their encryption key since the last save, and
    /// to rewrite environments saved in the old format.
    Resave {
        /// The repository.
        repo: String,
        /// The environment.
        #[arg(long, required_unless_present = "all", conflicts_with = "all")]
        env: Option<String>,
        /// Every environment saved in the old format or not shared with everyone its audience
        /// covers now.
        #[arg(long)]
        all: bool,
    },
    /// Record that values saved in the old format were changed where they're used
    ///
    /// Values saved in the old format can be read by anyone who joins later. Once you have
    /// changed them at their source (and in the environment), mark them changed. With no names,
    /// every such value is marked.
    MarkChanged {
        /// The repository.
        repo: String,
        /// The environment.
        #[arg(long)]
        env: String,
        /// The entries' names (default: every one saved in the old format and not marked yet).
        names: Vec<String>,
    },
}

impl EnvCommand {
    /// The error headline and the repo, for `errors::context_for`.
    pub fn context(&self) -> (&'static str, Option<&String>) {
        match self {
            Self::Ls { repo, .. } | Self::History { repo, .. } => {
                ("could not read the environments", Some(repo))
            }
            Self::Get { repo, .. } | Self::Export { repo, .. } => {
                ("could not read the environment", Some(repo))
            }
            Self::Run { repo, .. } => ("command not run", Some(repo)),
            Self::Set { repo, .. }
            | Self::Unset { repo, .. }
            | Self::Edit { repo, .. }
            | Self::Import { repo, .. }
            | Self::Audience { repo, .. }
            | Self::Share { repo, .. }
            | Self::Unshare { repo, .. }
            | Self::Resave { repo, .. }
            | Self::MarkChanged { repo, .. } => ("environment not changed", Some(repo)),
        }
    }
}

/// Dispatch an `env` subcommand.
pub async fn run(ctx: &Ctx, cmd: &EnvCommand) -> Result<()> {
    match cmd {
        EnvCommand::Ls { repo, env } => ls(ctx, repo, env.as_deref()).await,
        EnvCommand::Get { repo, name, env } => get(ctx, repo, name, env).await,
        EnvCommand::Set {
            repo,
            entries,
            env,
            secret,
            note,
            who,
            keep,
        } => {
            let (repo, entries) = shift_entries(repo, entries);
            set(
                ctx,
                &repo,
                &entries,
                env,
                *secret,
                note.as_deref(),
                who,
                keep.as_deref(),
            )
            .await
        }
        EnvCommand::Unset {
            repo,
            names,
            env,
            keep,
        } => {
            let (repo, names) = shift_entries(repo, names);
            unset(ctx, &repo, &names, env, keep.as_deref()).await
        }
        EnvCommand::Edit {
            repo,
            env,
            secret,
            who,
            keep,
        } => edit(ctx, repo, env, *secret, who, keep.as_deref()).await,
        EnvCommand::Import {
            repo,
            file,
            env,
            secret,
            who,
            keep,
        } => import(ctx, repo, file, env, *secret, who, keep.as_deref()).await,
        EnvCommand::Run {
            repo,
            env,
            command,
            allow_env_override,
        } => run_with(ctx, repo, env, command, *allow_env_override).await,
        EnvCommand::Export {
            repo,
            env,
            output,
            force,
        } => export(ctx, repo, env, output.as_deref(), *force).await,
        EnvCommand::History { repo, env } => history(ctx, repo, env).await,
        EnvCommand::Audience {
            repo,
            env,
            set,
            to,
            also,
        } => {
            let opts = AudienceOpts {
                audience: Some(*set),
                to: to.clone(),
                also: also.clone(),
            };
            change_audience(ctx, repo, env, &opts).await
        }
        EnvCommand::Share { repo, env, people } => share(ctx, repo, env, people, true).await,
        EnvCommand::Unshare { repo, env, people } => share(ctx, repo, env, people, false).await,
        EnvCommand::Resave { repo, env, all } => resave(ctx, repo, env.as_deref(), *all).await,
        EnvCommand::MarkChanged { repo, env, names } => mark_changed(ctx, repo, env, names).await,
    }
}

/// Inside a clone, `dg env set A=1 B=2 --env dev` parses with `A=1` as the repository (the line
/// is valid as typed, so the clone's repository is not filled in). An argument in the repository
/// slot that can only be an entry (it holds `=`, or is an upper-case variable name with no `/`:
/// repository names are lower case) is moved back among the entries.
fn shift_entries(repo: &str, entries: &[String]) -> (String, Vec<String>) {
    let entry_like = repo.contains('=')
        || (!repo.contains('/')
            && valid_var_name(repo)
            && repo.chars().any(|c| c.is_ascii_uppercase()));
    match (entry_like, crate::storage::clone_repo()) {
        (true, Some(here)) => {
            let mut all = vec![repo.to_owned()];
            all.extend(entries.iter().cloned());
            (here, all)
        }
        _ => (repo.to_owned(), entries.to_vec()),
    }
}

fn check_env_name(env: &str) -> Result<()> {
    if valid_env_name(env) {
        return Ok(());
    }
    Err(UserError::new(
        codes::USAGE,
        format!("{:?} is not an environment name", crate::fmt::safe(env)),
    )
    .cause("an environment name is 1 to 64 letters, digits, `.`, `_` or `-`, starting with a letter or digit")
    .into())
}

fn check_var_name(name: &str) -> Result<()> {
    if valid_var_name(name) {
        return Ok(());
    }
    Err(UserError::new(
        codes::USAGE,
        format!("{:?} is not a variable name", crate::fmt::safe(name)),
    )
    .cause("a variable name is letters, digits and `_`, not starting with a digit (as a shell takes it)")
    .into())
}

/// Environments as the session's identity.
fn environments(s: &Session) -> Environments<'_> {
    Environments::new(&s.client, &s.identity, &s.bridge)
}

/// Read every environment of `s.repo` as the session's identity.
async fn book(s: &Session) -> Result<Book> {
    Ok(environments(s).read(&s.repo).await?)
}

/// The values of `env`, or the error that says why they cannot be used (fail closed).
fn current<'b>(book: &'b Book, s: &Session, env: &str) -> Result<&'b Snapshot> {
    warn_ignored(book, env);
    book.current(env)
        .map_err(|b| blocked_error(&s.repo, env, b, book.maintainers.contains(&s.identity.id())))
}

/// One stderr line when someone who isn't a maintainer now posted a change naming `env`'s head:
/// it is ignored (D24), and a maintainer should look (never used, never offered to save).
fn warn_ignored(book: &Book, env: &str) {
    let ignored = book.ignored_newer(env);
    let Some(last) = ignored.last() else {
        return;
    };
    let more = match ignored.len() {
        1 => String::new(),
        n => format!(" (and {} more)", n - 1),
    };
    eprintln!(
        "warning: {env} has a newer change by {} at {} ({}){more}, who isn't a maintainer now; it was ignored. Ask a maintainer to check {env}'s values.",
        last.author,
        utc(last.created_at),
        last.short()
    );
}

fn blocked_error(repo: &Repo, env: &str, blocked: Blocked, maintainer: bool) -> anyhow::Error {
    match blocked {
        Blocked::Missing { hidden: 0 } => UserError::new(
            codes::NOT_FOUND,
            format!("{} has no environment {env}", repo.display()),
        )
        .fix(format!(
            "`dg env ls {}` lists the environments you can read",
            repo.display()
        ))
        .into(),
        // E612: "not in the audience" and "in the group, not saved since" look the same here
        Blocked::Missing { hidden } => not_shared_yet(repo, Some(env))
            .cause(format!(
                "{} there can't be read by you. {env} may be one of them.",
                count(hidden, "environment")
            ))
            .into(),
        Blocked::Conflict { heads, split } => conflict_error(repo, env, &heads, split).into(),
        Blocked::Unreadable {
            head,
            reason,
            unfetched: true,
        } => forge_core::env::service::unfetched_error(env, &head, &reason).into(),
        Blocked::Unreadable { head, reason, .. } => {
            let cause = format!(
                "the latest change, {} by {} at {}: {reason}",
                head.short(),
                head.author,
                utc(head.created_at)
            );
            if !maintainer {
                return not_shared_yet(repo, Some(env)).cause(cause).into();
            }
            UserError::new(
                codes::NOT_A_KEY_HOLDER,
                format!("the latest change to {env} can't be read by you"),
            )
            .cause(cause)
            .fix(format!("ask {} to save it again (`dg env resave --env {env}`)", head.author))
            .note("each change can be read only by the people it was saved for")
            .into()
        }
    }
}

/// "Writers and maintainers: alice, bob (when last saved)".
fn audience_line(snap: &Snapshot) -> String {
    if snap.members_key() {
        return "All members (saved in the old format, under the members key)".into();
    }
    format!(
        "{}: {} ({} when last saved)",
        snap.audience.label(),
        snap.to.join(", "),
        count(snap.to.len(), "person")
    )
}

/// The old-format banner of `env`, when it needs one (DESIGN §10).
fn old_format_line(book: &Book, env: &str) -> Option<String> {
    let old = book.old_format_of(env).filter(|o| o.needs_attention())?;
    Some(if old.latest {
        format!("{OLD_FORMAT_SENTENCE} `dg env resave --env {env}`")
    } else if old.unmarked.is_empty() {
        format!("{OLD_FORMAT_HISTORY_SENTENCE} (`dg env mark-changed --env {env}`)")
    } else {
        format!(
            "{OLD_FORMAT_HISTORY_SENTENCE} Not marked yet: {} (`dg env mark-changed --env {env}`)",
            old.unmarked.join(", ")
        )
    })
}

/// Why an environment needs saving again, for a maintainer (DESIGN §10, E612's precise list).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Stale {
    who: String,
    why: String,
}

/// The repository's members and their current encryption key ids, read once for the precise
/// list of [`stale_of`].
struct People {
    owner: String,
    members: Vec<Member>,
    keys: BTreeMap<String, Option<u32>>,
}

impl People {
    async fn read(s: &Session, book: &Book) -> Result<Self> {
        let members = MemberReader::new(&s.client).list(&s.repo).await?;
        let owner = s.repo.owner_id().to_owned();
        let mut ids: BTreeSet<String> = members.iter().map(|m| m.identity_id.clone()).collect();
        ids.insert(owner.clone());
        for e in &book.resolution.environments {
            if let Ok(snap) = book.current(&e.env) {
                ids.extend(snap.to.iter().cloned());
                ids.extend(snap.audience.also.iter().cloned());
            }
        }
        let core = s.repo.forge().core.clone();
        let mut keys = BTreeMap::new();
        for id in ids {
            let key = match s.client.fetch_identity(&id).await {
                Ok(identity) => {
                    forge_core::keyring::recipient_key(&identity.public_keys(), &core).map(|k| k.id)
                }
                Err(_) => None,
            };
            keys.insert(id, key);
        }
        Ok(Self {
            owner,
            members,
            keys,
        })
    }

    fn role_word(&self, id: &str) -> &'static str {
        match forge_core::members::best_role(&self.members, id) {
            Some(Role::Maintainer) => "a maintainer",
            Some(Role::Writer) => "a writer",
            Some(Role::Triage) => "a triage member",
            Some(Role::Reader) => "a reader",
            None if id == self.owner => "the owner",
            None => "added to it",
        }
    }
}

/// Who `env`'s latest version misses or still includes, against its audience now, and whose key
/// changed since it was saved. Old-format Members versions are the old-format banner's business.
fn stale_of(book: &Book, env: &str, people: &People) -> Vec<Stale> {
    let Ok(snap) = book.current(env) else {
        return Vec::new();
    };
    if snap.members_key() {
        return Vec::new();
    }
    let author = book.heads(env).pop().map(|h| h.author).unwrap_or_default();
    let expected = resolve_people(&snap.audience, &people.owner, &people.members);
    let to: BTreeSet<&String> = snap.to.iter().collect();
    let mut out = Vec::new();
    for who in expected.iter().filter(|p| !to.contains(p)) {
        let why = if people.keys.get(who).copied().flatten().is_none() {
            format!("{who} has no encryption key yet, so {env} can't be shared with them")
        } else {
            format!("{who} is {}, but {env} hasn't been saved since", people.role_word(who))
        };
        out.push(Stale {
            who: who.clone(),
            why,
        });
    }
    for who in snap
        .to
        .iter()
        .filter(|p| !expected.contains(*p) && **p != author)
    {
        out.push(Stale {
            who: who.clone(),
            why: format!("{who} isn't in its audience any more, but can read {env} until it's saved again"),
        });
    }
    for (who, key) in snap.to.iter().zip(&snap.to_keys) {
        if let Some(Some(now)) = people.keys.get(who) {
            if now != key {
                out.push(Stale {
                    who: who.clone(),
                    why: format!("{who}'s encryption key changed since {env} was saved"),
                });
            }
        }
    }
    out
}

/// Whether the session's identity is a current maintainer of the repository the book is of.
fn is_maintainer(book: &Book, s: &Session) -> bool {
    book.maintainers.contains(&s.identity.id())
}

/// `dg env ls --env <env>`: one environment's entries, values hidden.
async fn ls_env(ctx: &Ctx, s: &Session, book: &Book, env: &str) -> Result<()> {
    let snap = current(book, s, env)?;
    let head = &book.heads(env)[0];
    let stale = if is_maintainer(book, s) {
        stale_of(book, env, &People::read(s, book).await?)
    } else {
        Vec::new()
    };
    let old = book.old_format_of(env);
    ctx.emit(
        json!({
            "env": env,
            "audience": snap.audience,
            "oldFormat": old,
            "to": snap.to,
            "needsSaving": stale,
            "updatedBy": head.author,
            "updatedAt": head.created_at,
            "entries": snap.vars.iter().map(|(n, v)| json!({
                "name": n, "type": v.kind.as_str(), "note": v.note,
            })).collect::<Vec<_>>(),
        }),
        || {
            println!("{env} in {}", s.repo.display());
            println!("Who can read this: {}", audience_line(snap));
            println!("Updated {} by {}", utc(head.created_at), head.author);
            if let Some(line) = old_format_line(book, env) {
                println!("{line}");
            }
            for st in &stale {
                println!("Save it again: {} (`dg env resave --env {env}`)", st.why);
            }
            if snap.vars.is_empty() {
                println!("(no entries)");
            }
            for (n, v) in &snap.vars {
                let note = if v.note.is_empty() {
                    String::new()
                } else {
                    format!("  # {}", crate::fmt::safe(&v.note))
                };
                println!("  {n:<32} {:<8} ••••••{note}", v.kind.as_str());
            }
            println!("{ACCESS_SENTENCE}");
        },
    );
    Ok(())
}

async fn ls(ctx: &Ctx, repo: &str, env: Option<&str>) -> Result<()> {
    if let Some(e) = env {
        check_env_name(e)?;
    }
    let s = Session::open(ctx, repo).await?;
    let book = book(&s).await?;
    if let Some(env) = env {
        return ls_env(ctx, &s, &book, env).await;
    }
    let people = if is_maintainer(&book, &s) {
        Some(People::read(&s, &book).await?)
    } else {
        None
    };
    let stale: BTreeMap<String, Vec<Stale>> = book
        .resolution
        .environments
        .iter()
        .map(|e| {
            let st = people
                .as_ref()
                .map(|p| stale_of(&book, &e.env, p))
                .unwrap_or_default();
            (e.env.clone(), st)
        })
        .collect();
    let rows: Vec<Value> = book
        .resolution
        .environments
        .iter()
        .map(|e| {
            let head = book.heads(&e.env).pop();
            let snap = book.current(&e.env).ok();
            json!({
                "env": e.env,
                "state": e.state,
                "audience": snap.map(|s| &s.audience),
                "entries": snap.map(|s| s.vars.len()),
                "oldFormat": book.old_format_of(&e.env),
                "needsSaving": stale.get(&e.env),
                "updatedBy": head.as_ref().map(|h| h.author.clone()),
                "updatedAt": head.as_ref().map(|h| h.created_at),
                "versions": e.heads.len(),
                "ignoredNewer": e.ignored_newer.len(),
            })
        })
        .collect();
    let hidden = book.resolution.hidden.len();
    let ignored = book
        .resolution
        .ignored
        .iter()
        .filter(|i| i.reason == forge_core::env::chain::IgnoredReason::NotAMaintainer)
        .count();
    ctx.emit(
        json!({ "environments": rows, "hidden": hidden, "ignored": ignored }),
        || {
            if book.resolution.environments.is_empty() && hidden == 0 {
                println!("No environments yet. Values stored here are encrypted for the people you choose and injected with `dg env run`. They're never committed to git.");
                return;
            }
            for e in &book.resolution.environments {
                warn_ignored(&book, &e.env);
                let head = book.heads(&e.env).pop();
                let when = head
                    .as_ref()
                    .map(|h| format!("updated {} by {}", utc(h.created_at), h.author))
                    .unwrap_or_default();
                let what = match book.current(&e.env) {
                    Ok(snap) => format!(
                        "{:<28} {}",
                        if snap.members_key() {
                            "All members (old format)".to_owned()
                        } else {
                            snap.audience.label()
                        },
                        count(snap.vars.len(), "entry")
                    ),
                    Err(Blocked::Conflict { heads: h, .. }) => format!(
                        "changed at the same time: {} versions, one must be kept",
                        h.len()
                    ),
                    Err(_) => "latest change can't be read by you".into(),
                };
                println!("{:<24} {what:<44} {when}", e.env);
                if let Some(line) = old_format_line(&book, &e.env) {
                    println!("  {line}");
                }
                for st in stale.get(&e.env).into_iter().flatten() {
                    println!("  Save it again: {}", st.why);
                }
            }
            if hidden > 0 {
                println!("+ {} you can't read", count(hidden, "environment"));
                if people.is_none() {
                    println!("  An environment in this repo hasn't been shared with you. If you should have access, ask a maintainer to save it again.");
                }
            }
            if ignored > 0 {
                println!(
                    "Ignored: {} by people who aren't maintainers now.",
                    count(ignored, "change")
                );
            }
            println!("{ACCESS_SENTENCE}");
        },
    );
    Ok(())
}

async fn get(ctx: &Ctx, repo: &str, name: &str, env: &str) -> Result<()> {
    check_env_name(env)?;
    check_var_name(name)?;
    let s = Session::open(ctx, repo).await?;
    let book = book(&s).await?;
    let snap = current(&book, &s, env)?;
    let Some(v) = snap.vars.get(name) else {
        return Err(
            UserError::new(codes::NOT_FOUND, format!("{env} has no entry {name}"))
                .fix(format!("`dg env ls --env {env}` lists its entries"))
                .into(),
        );
    };
    ctx.emit(
        json!({ "env": env, "name": name, "type": v.kind.as_str(), "value": v.value }),
        || println!("{}", v.value),
    );
    Ok(())
}

/// One `NAME=value` or `NAME` argument: the name and the value, when given.
fn split_entry(entry: &str) -> Result<(String, Option<Zeroizing<String>>)> {
    let (name, value) = match entry.split_once('=') {
        Some((n, v)) => (n, Some(Zeroizing::new(v.to_owned()))),
        None => (entry, None),
    };
    check_var_name(name)?;
    Ok((name.to_owned(), value))
}

/// The values to set: from the arguments, else asked for on the terminal, else (one name, stdin
/// not a terminal) read from stdin.
fn entry_values(ctx: &Ctx, entries: &[String]) -> Result<Vec<(String, Zeroizing<String>)>> {
    let parsed: Vec<(String, Option<Zeroizing<String>>)> = entries
        .iter()
        .map(|e| split_entry(e))
        .collect::<Result<_>>()?;
    let missing = parsed.iter().filter(|(_, v)| v.is_none()).count();
    let stdin_tty = std::io::stdin().is_terminal();
    if missing > 0 && !stdin_tty && (missing > 1 || parsed.len() > 1) {
        return Err(UserError::new(
            codes::USAGE,
            "values to ask for, and no terminal to ask on",
        )
        .fix("give each value as NAME=value, or one NAME with its value on stdin: `printf %s \"$VALUE\" | dg env set NAME --env …`")
        .into());
    }
    let mut out = Vec::new();
    for (name, value) in parsed {
        let value = match value {
            Some(v) => v,
            None if stdin_tty && !ctx.json => Zeroizing::new(crate::prompt::read_hidden(
                format!("Value for {name} (hidden): "),
                "reading the value",
            )?),
            None if !stdin_tty => {
                let mut v = Zeroizing::new(String::new());
                std::io::stdin()
                    .read_to_string(&mut v)
                    .context("reading the value from stdin")?;
                if v.ends_with('\n') {
                    v.pop();
                    if v.ends_with('\r') {
                        v.pop();
                    }
                }
                v
            }
            None => {
                return Err(UserError::new(codes::USAGE, format!("no value for {name}"))
                    .fix("give it as NAME=value (with --json nothing is asked)")
                    .into())
            }
        };
        out.push((name, value));
    }
    Ok(out)
}

/// Set `values` in `vars`: an existing entry keeps its type and note unless `secret` or `note`
/// says otherwise; a new one is a secret with `secret`, else a plain setting.
fn apply_set(
    vars: &mut BTreeMap<String, Var>,
    values: &[(String, Zeroizing<String>)],
    secret: bool,
    note: Option<&str>,
) {
    for (name, value) in values {
        let (kind, old_note) = vars
            .get(name)
            .map_or((VarType::Variable, String::new()), |v| {
                (v.kind, v.note.clone())
            });
        vars.insert(
            name.clone(),
            Var {
                value: value.as_str().to_owned(),
                kind: if secret { VarType::Secret } else { kind },
                note: note.map_or(old_note, str::to_owned),
            },
        );
    }
}

#[allow(clippy::too_many_arguments)]
async fn set(
    ctx: &Ctx,
    repo: &str,
    entries: &[String],
    env: &str,
    secret: bool,
    note: Option<&str>,
    who: &AudienceOpts,
    keep: Option<&str>,
) -> Result<()> {
    check_env_name(env)?;
    for e in entries {
        split_entry(e)?;
    }
    let s = Session::open_for_write(ctx, repo, "environment not changed").await?;
    let envs = environments(&s);
    envs.require_maintainer(&s.repo, &format!("change {env}"))
        .await?;
    let audience = audience_of(&s, who).await?;
    let book = envs.read(&s.repo).await?;
    // E611 before any value is asked for, and before anything is signed
    require_audience(&book, env, audience.as_ref())?;
    let values = entry_values(ctx, entries)?;
    commit(ctx, &s, &envs, &book, env, audience, keep, false, |next| {
        apply_set(&mut next.vars, &values, secret, note);
        Ok(())
    })
    .await
}

/// E611 when `env` has never been saved and no audience is given.
fn require_audience(book: &Book, env: &str, given: Option<&Audience>) -> Result<()> {
    let exists = book.state(env).is_some();
    if exists || given.is_some() {
        return Ok(());
    }
    Err(audience_required(env).into())
}

async fn unset(
    ctx: &Ctx,
    repo: &str,
    names: &[String],
    env: &str,
    keep: Option<&str>,
) -> Result<()> {
    check_env_name(env)?;
    for n in names {
        check_var_name(n)?;
    }
    let s = Session::open_for_write(ctx, repo, "environment not changed").await?;
    let envs = environments(&s);
    save(ctx, &s, &envs, env, None, keep, |next| {
        let vars = &mut next.vars;
        let missing: Vec<&String> = names.iter().filter(|n| !vars.contains_key(*n)).collect();
        if !missing.is_empty() {
            let list: Vec<&str> = missing.iter().map(|s| s.as_str()).collect();
            return Err(UserError::new(
                codes::NOT_FOUND,
                format!(
                    "{env} has no entr{} {}",
                    if list.len() == 1 { "y" } else { "ies" },
                    list.join(", ")
                ),
            )
            .fix(format!("`dg env ls --env {env}` lists its entries"))
            .note("nothing was written")
            .into());
        }
        for n in names {
            vars.remove(n);
        }
        Ok(())
    })
    .await
}

async fn import(
    ctx: &Ctx,
    repo: &str,
    file: &Path,
    env: &str,
    secret: bool,
    who: &AudienceOpts,
    keep: Option<&str>,
) -> Result<()> {
    check_env_name(env)?;
    let text = Zeroizing::new(if file == Path::new("-") {
        let mut t = String::new();
        std::io::stdin()
            .read_to_string(&mut t)
            .context("reading stdin")?;
        t
    } else {
        std::fs::read_to_string(file).with_context(|| format!("reading {}", file.display()))?
    });
    let parsed = parse_dotenv(&text).map_err(|e| {
        anyhow::Error::from(
            UserError::new(
                codes::USAGE,
                format!("{} is not a .env file I can read", file.display()),
            )
            .cause(e.to_string()),
        )
    })?;
    if parsed.is_empty() {
        return Err(
            UserError::new(codes::USAGE, format!("{} holds no entries", file.display())).into(),
        );
    }
    let values: Vec<(String, Zeroizing<String>)> = parsed.into_iter().collect();
    let s = Session::open_for_write(ctx, repo, "environment not changed").await?;
    let envs = environments(&s);
    let audience = audience_of(&s, who).await?;
    save(ctx, &s, &envs, env, audience, keep, |next| {
        apply_set(&mut next.vars, &values, secret, None);
        Ok(())
    })
    .await
}

/// The header `dg env edit` puts above the entries.
fn edit_header(repo: &Repo, env: &str, audience: &Audience) -> String {
    format!(
        "# dg env edit: {} · {env} ({})\n# One NAME=value per line. Delete a line to remove the entry. Lines starting with # are ignored.\n# Saved as one change when you close the editor. Nothing is saved if nothing changed.\n",
        repo.display(),
        audience.label()
    )
}

/// Open `text` in the user's editor in a private temporary file and return what they saved
/// (`signals` installed by the caller while the editor runs).
/// The file is overwritten with zeros and removed afterwards, also after a hangup or
/// termination; the editor's own swap or backup copies elsewhere are beyond `dg`'s reach.
fn run_editor(text: &str, signals: &mut EditorSignals) -> Result<Zeroizing<String>> {
    let editor = std::env::var("VISUAL")
        .or_else(|_| std::env::var("EDITOR"))
        .unwrap_or_else(|_| "vi".into());
    let dir = tempfile::Builder::new()
        .prefix("dg-env-")
        .tempdir()
        .context("creating a private temporary directory")?;
    let path = dir.path().join("environment.env");
    write_private(&path, text.as_bytes(), false)?;
    let status = std::process::Command::new("sh")
        .arg("-c")
        .arg(format!("{editor} \"$1\""))
        .arg("sh")
        .arg(&path)
        .status()
        .with_context(|| format!("starting the editor ({editor})"));
    let terminated = signals.stopped();
    let saved = std::fs::read_to_string(&path).map(Zeroizing::new);
    // overwrite before removing: the file held every value
    if let Ok(meta) = std::fs::metadata(&path) {
        let _ = std::fs::write(&path, vec![0u8; usize::try_from(meta.len()).unwrap_or(0)]);
    }
    let _ = std::fs::remove_file(&path);
    drop(dir);
    if terminated {
        return Err(
            UserError::new(codes::CANCELLED, "stopped while the editor was open")
                .note("nothing was written, and the temporary file was removed")
                .into(),
        );
    }
    let status = status?;
    if !status.success() {
        return Err(
            UserError::new(codes::CANCELLED, "the editor exited with an error")
                .note("nothing was written")
                .into(),
        );
    }
    saved.context("reading the edited file")
}

async fn edit(
    ctx: &Ctx,
    repo: &str,
    env: &str,
    secret: bool,
    who: &AudienceOpts,
    keep: Option<&str>,
) -> Result<()> {
    check_env_name(env)?;
    if !std::io::stdin().is_terminal() || ctx.json {
        return Err(UserError::new(codes::USAGE, "dg env edit needs a terminal")
            .fix("use `dg env set`, `dg env unset` or `dg env import` in scripts")
            .into());
    }
    let s = Session::open_for_write(ctx, repo, "environment not changed").await?;
    let envs = environments(&s);
    envs.require_maintainer(&s.repo, &format!("change {env}"))
        .await?;
    let audience = audience_of(&s, who).await?;
    let book = envs.read(&s.repo).await?;
    require_audience(&book, env, audience.as_ref())?;
    let base = book.base(&s.repo, env, keep)?;
    let shown = audience
        .clone()
        .or(base.audience)
        .ok_or_else(|| audience_required(env))?;
    let mut text = Zeroizing::new(edit_header(&s.repo, env, &shown));
    text.push_str(&render_dotenv(&base.vars));
    // Ctrl-C and Ctrl-\\ belong to the editor; a hangup or termination still reaches the cleanup
    let mut signals = EditorSignals::install()?;
    let saved = run_editor(&text, &mut signals);
    signals.restore();
    let saved = saved?;
    let parsed = parse_dotenv(&saved).map_err(|e| {
        anyhow::Error::from(
            UserError::new(
                codes::USAGE,
                "the edited environment is not .env text I can read",
            )
            .cause(e.to_string())
            .note("nothing was written"),
        )
    })?;
    commit(ctx, &s, &envs, &book, env, audience, keep, false, |next| {
        let vars = &mut next.vars;
        let old = std::mem::take(vars);
        for (name, value) in &parsed {
            let (kind, note, changed) = old
                .get(name)
                .map_or((VarType::Variable, String::new(), true), |v| {
                    (v.kind, v.note.clone(), v.value != value.as_str())
                });
            vars.insert(
                name.clone(),
                Var {
                    value: value.as_str().to_owned(),
                    kind: if secret && changed {
                        VarType::Secret
                    } else {
                        kind
                    },
                    note,
                },
            );
        }
        Ok(())
    })
    .await
}

/// What a change edits: the entries, the audience and the names marked changed.
struct Next {
    vars: BTreeMap<String, Var>,
    audience: Option<Audience>,
    marked: Vec<String>,
}

/// Read the book, apply `change` to the environment and save it as one snapshot.
async fn save(
    ctx: &Ctx,
    s: &Session,
    envs: &Environments<'_>,
    env: &str,
    audience: Option<Audience>,
    keep: Option<&str>,
    change: impl FnOnce(&mut Next) -> Result<()>,
) -> Result<()> {
    envs.require_maintainer(&s.repo, &format!("change {env}"))
        .await?;
    let book = envs.read(&s.repo).await?;
    commit(ctx, s, envs, &book, env, audience, keep, false, change).await
}

/// Save `env` changed by `change`, as one snapshot, after the plan and a confirmation:
/// `audience` replaces its audience when given; `again` saves even when nothing changed (to
/// reach the people its audience covers now).
#[allow(clippy::too_many_arguments, clippy::too_many_lines)] // the plan, its warnings, the write
async fn commit(
    ctx: &Ctx,
    s: &Session,
    envs: &Environments<'_>,
    book: &Book,
    env: &str,
    audience: Option<Audience>,
    keep: Option<&str>,
    again: bool,
    change: impl FnOnce(&mut Next) -> Result<()>,
) -> Result<()> {
    let base = book.base(&s.repo, env, keep)?;
    let mut next = Next {
        vars: base.vars.clone(),
        audience: audience.or_else(|| base.audience.clone()),
        marked: base.marked_changed.clone(),
    };
    change(&mut next)?;
    let audience = next.audience.ok_or_else(|| audience_required(env))?;
    let before = Snapshot::new(env, [0; 16], audience.clone(), base.vars.clone());
    let after = Snapshot::new(env, [0; 16], audience.clone(), next.vars);
    let changes = diff(base.audience.is_some().then_some(&before), &after);
    let resolving = base.heads > 1;
    let old_format = base.version == 1;
    if changes.is_empty()
        && base.audience.as_ref() == Some(&audience)
        && next.marked == base.marked_changed
        && !resolving
        && !old_format
        && !again
    {
        ctx.emit(json!({ "status": "unchanged", "env": env }), || {
            println!("{env} already holds that. Nothing to save.");
        });
        return Ok(());
    }
    let draft = Draft {
        env: env.to_owned(),
        id: base.id_or_new()?,
        audience: audience.clone(),
        vars: after.vars,
        supersedes: base.supersedes.clone(),
        saved_for: None,
        marked_changed: next.marked.clone(),
        people: None,
    };
    let prepared = envs.prepare(&s.repo, &draft).await?;
    let quote = prepared.credits();
    let new_env = base.audience.is_none();
    let hidden = book.resolution.hidden.len();
    let mut lines = vec![format!(
        "Save {env} in {} for {} ({})?",
        s.repo.display(),
        audience_phrase(&prepared),
        summary(&changes)
    )];
    if let Some(old) = base.audience.as_ref().filter(|a| **a != audience) {
        lines.push(format!(
            "  Who can read it changes from {} to {}. Earlier versions stay readable by whoever could read them.",
            old.label(),
            audience.label()
        ));
    }
    if new_env || base.audience.as_ref() != Some(&audience) {
        lines.push("  People who join this group later get the current values when it's saved again, never earlier ones.".into());
    }
    if old_format && book.old_format_of(env).is_some_and(|o| o.latest) {
        lines.push(format!(
            "  This saves it in the new format. Values saved in the old format stay readable by anyone who joins later: change them where they're used, then `dg env mark-changed --env {env}`."
        ));
    }
    for who in &prepared.skipped {
        lines.push(format!(
            "  {who} has no encryption key and won't be able to read it."
        ));
    }
    if new_env && hidden > 0 {
        lines.push(format!(
            "  You can't read {} here. If one of them is also called {env}, this makes a second {env} that conflicts with it.",
            count(hidden, "environment")
        ));
    }
    if resolving {
        lines.push(format!(
            "  This keeps one of the {} versions of {env} and replaces them all.",
            base.heads
        ));
    }
    lines.push(format!(
        "  One chunk and one record, {}.",
        cost_line(quote, ctx.usd_price())
    ));
    for l in &lines[1..] {
        eprintln!("{l}");
    }
    ctx.confirm_or_cancel(&lines[0])?;
    let (saved, spent) = s.metered(|| envs.store(&s.repo, &prepared)).await?;
    ctx.emit(
        json!({
            "status": "saved",
            "env": env,
            "audience": saved.audience,
            "to": saved.to,
            "skipped": saved.skipped,
            "changes": changes,
            "markedChanged": next.marked,
            "id": saved.id,
            "packHash": saved.pack_hash,
            "sizeBytes": saved.size_bytes,
            "quote": cost_json(quote, ctx.usd_price()),
            "spent": cost_json(spent, ctx.usd_price()),
        }),
        || {
            println!(
                "✓ saved {env} ({}): {}",
                audience_phrase(&prepared),
                summary(&changes)
            );
            println!("  spent {}", cost_line(spent, ctx.usd_price()));
        },
    );
    Ok(())
}

/// "Writers and maintainers, sent to 4 people".
fn audience_phrase(prepared: &Prepared) -> String {
    format!(
        "{}, sent to {}",
        prepared.audience.label(),
        count(prepared.to.len(), "person")
    )
}

/// `n thing` or `n things`.
fn count(n: usize, thing: &str) -> String {
    if n == 1 {
        format!("1 {thing}")
    } else if thing == "person" {
        format!("{n} people")
    } else if let Some(stem) = thing.strip_suffix('y') {
        format!("{n} {stem}ies")
    } else {
        format!("{n} {thing}s")
    }
}

/// `+ A, ~ B, - C` (names only).
fn summary(changes: &[(String, Change)]) -> String {
    if changes.is_empty() {
        return "no entry changed".into();
    }
    changes
        .iter()
        .map(|(n, c)| {
            let mark = match c {
                Change::Added => '+',
                Change::Changed => '~',
                Change::Removed => '-',
            };
            format!("{mark} {n}")
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// The child's environment variables: the inherited ones with `vars` added (they win).
fn child_vars(vars: &BTreeMap<String, Var>) -> Vec<(String, Zeroizing<String>)> {
    vars.iter()
        .map(|(n, v)| (n.clone(), Zeroizing::new(v.value.clone())))
        .collect()
}

/// Variables that decide which program runs or what it loads: an environment may set them only
/// with `--allow-env-override` (case-insensitively on Windows).
const STARTUP_VARS: [&str; 21] = [
    "PATH",
    "HOME",
    "XDG_CONFIG_HOME",
    "BASH_ENV",
    "ENV",
    "ZDOTDIR",
    "SHELLOPTS",
    "PS4",
    "NODE_OPTIONS",
    "NODE_PATH",
    "PYTHONPATH",
    "PYTHONHOME",
    "PERL5OPT",
    "PERL5LIB",
    "RUBYOPT",
    "RUBYLIB",
    "JAVA_TOOL_OPTIONS",
    "_JAVA_OPTIONS",
    "JDK_JAVA_OPTIONS",
    "RUSTC_WRAPPER",
    "SHELL",
];

/// Prefixes treated as [`STARTUP_VARS`]: dynamic linker, git and npm configuration.
const STARTUP_PREFIXES: [&str; 4] = ["LD_", "DYLD_", "GIT_", "npm_config_"];

/// A variable name as the OS compares it: case-insensitively on Windows.
fn fold_case(name: &str) -> String {
    if cfg!(windows) {
        name.to_ascii_uppercase()
    } else {
        name.to_owned()
    }
}

/// Whether variable `name` changes how programs start.
fn is_startup_var(name: &str) -> bool {
    let n = fold_case(name);
    STARTUP_VARS.iter().any(|v| fold_case(v) == n)
        || STARTUP_PREFIXES
            .iter()
            .any(|p| n.starts_with(&fold_case(p)))
}

/// The names in `vars` that `--allow-env-override` must allow: those that change how programs
/// start, and any that would replace a variable `parent` already has.
fn startup_overrides<'v>(
    vars: &'v BTreeMap<String, Var>,
    parent: &BTreeSet<String>,
) -> Vec<&'v str> {
    vars.keys()
        .map(String::as_str)
        .filter(|n| is_startup_var(n) || parent.contains(&fold_case(n)))
        .collect()
}

async fn run_with(
    ctx: &Ctx,
    repo: &str,
    env: &str,
    command: &[String],
    allow_override: bool,
) -> Result<()> {
    check_env_name(env)?;
    let s = Session::open(ctx, repo).await?;
    let book = book(&s).await?;
    let snap = current(&book, &s, env)?;
    let parent: BTreeSet<String> = std::env::vars_os()
        .filter_map(|(k, _)| k.into_string().ok())
        .map(|k| fold_case(&k))
        .collect();
    let risky = startup_overrides(&snap.vars, &parent);
    if !risky.is_empty() && !allow_override {
        return Err(UserError::new(
            codes::USAGE,
            format!("{env} sets {}, which this shell already sets or which change how programs start", risky.join(", ")),
        )
        .cause("a maintainer's value there would replace yours, or decide which program runs or what it loads, on this computer")
        .fix("pass --allow-env-override if you mean to use them")
        .note("nothing was run")
        .into());
    }
    let vars = child_vars(&snap.vars);
    let (program, args) = command
        .split_first()
        .ok_or_else(|| crate::errors::usage("name the command to run after `--`"))?;
    let mut cmd = std::process::Command::new(program);
    cmd.args(args);
    for (n, v) in &vars {
        cmd.env(n, v.as_str());
    }
    let status = cmd
        .status()
        .with_context(|| format!("starting {}", crate::fmt::safe(program)))?;
    drop(vars);
    std::io::stdout().flush().ok();
    if status.success() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt as _;
        if let Some(sig) = status.signal() {
            std::process::exit(128 + sig);
        }
    }
    std::process::exit(status.code().unwrap_or(1));
}

/// Signals while the editor runs (Unix): SIGINT and SIGQUIT are taken from `dg`'s default
/// (it no longer dies on them; the editor, in the same process group, gets them), and SIGHUP
/// and SIGTERM are noted so the temporary file is still removed before `dg` stops.
struct EditorSignals {
    /// SIGINT and SIGQUIT: held so `dg` ignores them while the editor runs, then acts on them.
    #[cfg(unix)]
    held: Vec<tokio::signal::unix::Signal>,
    #[cfg(unix)]
    stop: Vec<tokio::signal::unix::Signal>,
}

impl EditorSignals {
    fn install() -> Result<Self> {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            let watch = |kinds: [SignalKind; 2]| {
                kinds
                    .into_iter()
                    .map(signal)
                    .collect::<std::io::Result<Vec<_>>>()
                    .context("watching signals")
            };
            Ok(Self {
                held: watch([SignalKind::interrupt(), SignalKind::quit()])?,
                stop: watch([SignalKind::hangup(), SignalKind::terminate()])?,
            })
        }
        #[cfg(not(unix))]
        Ok(Self {})
    }

    /// After the editor: the signals act as by default again (the process ends with the usual
    /// status), since a registration cannot be undone.
    fn restore(self) {
        #[cfg(unix)]
        {
            let codes = [130, 131, 129, 143];
            for (mut sig, code) in self.held.into_iter().chain(self.stop).zip(codes) {
                tokio::spawn(async move {
                    if sig.recv().await.is_some() {
                        std::process::exit(code);
                    }
                });
            }
        }
    }

    /// Whether a hangup or termination arrived.
    fn stopped(&mut self) -> bool {
        #[cfg(unix)]
        {
            use futures::FutureExt as _;
            self.stop
                .iter_mut()
                .any(|s| s.recv().now_or_never().flatten().is_some())
        }
        #[cfg(not(unix))]
        false
    }
}

/// Create `path` holding `bytes`, readable by its owner only: a new file (an existing one, or a
/// symlink, is refused), or with `replace` a new file renamed over it, so a symlink at `path` is
/// replaced, never followed.
fn write_private(path: &Path, bytes: &[u8], replace: bool) -> Result<()> {
    let create = |at: &Path| -> std::io::Result<std::fs::File> {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            opts.mode(0o600);
        }
        opts.open(at)
    };
    if !replace {
        let mut f = create(path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                anyhow::Error::from(
                    UserError::new(
                        codes::ALREADY_EXISTS,
                        format!("{} already exists", path.display()),
                    )
                    .fix("pass --force to replace it, or choose another file with -o"),
                )
            } else {
                anyhow::Error::new(e).context(format!("creating {}", path.display()))
            }
        })?;
        return f
            .write_all(bytes)
            .with_context(|| format!("writing {}", path.display()));
    }
    if path.symlink_metadata().is_ok_and(|m| m.is_dir()) {
        return Err(
            UserError::new(codes::USAGE, format!("{} is a directory", path.display())).into(),
        );
    }
    // a private (0600) file beside it, renamed over it
    let mut temp = tempfile::Builder::new()
        .prefix(".dg-env-")
        .tempfile_in(dir_of(path))
        .with_context(|| format!("writing beside {}", path.display()))?;
    temp.write_all(bytes)
        .and_then(|()| temp.as_file().sync_all())
        .with_context(|| format!("writing {}", path.display()))?;
    temp.persist(path).map_err(|e| {
        anyhow::Error::new(e.error).context(format!("replacing {}", path.display()))
    })?;
    Ok(())
}

/// `git -C dir args`. Pathspec arguments pass `--literal-pathspecs` first (`check-ignore` takes
/// paths, which it never expands, and refuses the option).
fn git_in(dir: &Path, args: &[&str]) -> Option<std::process::Output> {
    std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .ok()
}

/// Whether `dir` or a directory above it holds a `.git` (a work tree), found without git.
fn inside_work_tree(dir: &Path) -> bool {
    let Ok(abs) = std::fs::canonicalize(dir) else {
        return false;
    };
    abs.ancestors().any(|d| d.join(".git").exists())
}

/// How an exported file sits in git.
#[derive(Debug, Clone, PartialEq, Eq)]
enum GitGuard {
    /// Not inside a git work tree.
    NoRepository,
    /// Ignored (already, or after the entry added to `exclude`, named).
    Ignored {
        /// The `info/exclude` entry added, when one was.
        added: Option<String>,
    },
    /// `git check-ignore` still does not ignore it (a negating rule elsewhere).
    NotIgnored,
}

/// The directory holding `path` (`.` for a bare file name).
fn dir_of(path: &Path) -> PathBuf {
    match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    }
}

/// Whether `path` is tracked by git, or a tracked file in its directory has the same name but
/// for case (on a case-insensitive file system writing `path` would overwrite it).
fn tracked(path: &Path) -> bool {
    let dir = dir_of(path);
    let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return false;
    };
    git_in(&dir, &["--literal-pathspecs", "ls-files", "-z", "--", "."])
        .filter(|o| o.status.success())
        .is_some_and(|o| {
            o.stdout
                .split(|b| *b == 0)
                .map(String::from_utf8_lossy)
                .any(|f| f.to_lowercase() == name.to_lowercase())
        })
}

/// Keep `path` out of git: add `/<path from the top>` to the repository's `info/exclude` unless
/// it is ignored already, then verify with `git check-ignore`.
fn exclude_from_git(path: &Path) -> Result<GitGuard> {
    let dir = dir_of(path);
    let Some(top) = git_in(&dir, &["rev-parse", "--show-toplevel"])
        .filter(|o| o.status.success())
        .map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim()))
    else {
        // fail closed: a work tree git cannot read (git missing or failing) is not "no repository"
        if inside_work_tree(&dir) {
            return Err(UserError::new(
                codes::GIT_REPO,
                format!("can't check that git ignores {}", path.display()),
            )
            .cause("it is inside a git work tree, and git could not be run there")
            .fix("install git or fix the repository, then export again, or export outside the work tree")
            .note("nothing was written")
            .into());
        }
        return Ok(GitGuard::NoRepository);
    };
    let name = path
        .file_name()
        .context("the output path names no file")?
        .to_string_lossy()
        .into_owned();
    let ignored =
        || git_in(&dir, &["check-ignore", "-q", "--", &name]).is_some_and(|o| o.status.success());
    if ignored() {
        return Ok(GitGuard::Ignored { added: None });
    }
    // the file need not exist yet: its directory does
    let abs = std::fs::canonicalize(&dir)
        .with_context(|| format!("resolving {}", dir.display()))?
        .join(&name);
    let top = std::fs::canonicalize(&top).unwrap_or(top);
    let rel = abs
        .strip_prefix(&top)
        .context("the output file is outside its git work tree")?;
    let entry = format!(
        "/{}",
        ignore_pattern(&rel.to_string_lossy().replace('\\', "/"))
    );
    let exclude = git_in(&dir, &["rev-parse", "--git-path", "info/exclude"])
        .filter(|o| o.status.success())
        .map(|o| dir.join(String::from_utf8_lossy(&o.stdout).trim()))
        .context("finding .git/info/exclude")?;
    if let Some(parent) = exclude.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let current = std::fs::read_to_string(&exclude).unwrap_or_default();
    if !current.lines().any(|l| l.trim() == entry) {
        let mut text = current;
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str("# dg env export\n");
        text.push_str(&entry);
        text.push('\n');
        std::fs::write(&exclude, text).with_context(|| format!("writing {}", exclude.display()))?;
    }
    Ok(if ignored() {
        GitGuard::Ignored { added: Some(entry) }
    } else {
        GitGuard::NotIgnored
    })
}

/// `path` (from the work tree's top) as a gitignore pattern that matches exactly it: the
/// pattern characters and a leading `#` or `!` escaped.
fn ignore_pattern(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for (i, c) in path.chars().enumerate() {
        if matches!(c, '\\' | '*' | '?' | '[' | ']') || (i == 0 && matches!(c, '#' | '!')) {
            out.push('\\');
        }
        out.push(c);
    }
    if out.ends_with(' ') {
        out.insert(out.len() - 1, '\\');
    }
    out
}

/// Keep `path` out of git, then write it: refused when git tracks it (or a file differing only
/// in case), when git cannot be run inside its work tree, or when it is still not
/// ignored after the `info/exclude` entry (a `.gitignore` rule un-ignores it). Inside no git
/// repository it is simply written.
fn write_export(path: &Path, text: &str, force: bool) -> Result<GitGuard> {
    if tracked(path) {
        return Err(UserError::new(
            codes::REJECTED,
            format!(
                "{} is tracked by git, so secrets written to it would be committed",
                path.display()
            ),
        )
        .fix("choose another file with -o, or `git rm --cached` it first")
        .note("nothing was written")
        .into());
    }
    let guard = exclude_from_git(path)?;
    if guard == GitGuard::NotIgnored {
        return Err(UserError::new(
            codes::REJECTED,
            format!("git would not ignore {}", path.display()),
        )
        .cause("a .gitignore rule un-ignores it, so the values could be committed")
        .fix("choose a path git ignores, or fix the .gitignore rule, then export again")
        .note("nothing was written")
        .into());
    }
    write_private(path, text.as_bytes(), force)?;
    Ok(guard)
}

async fn export(
    ctx: &Ctx,
    repo: &str,
    env: &str,
    output: Option<&Path>,
    force: bool,
) -> Result<()> {
    check_env_name(env)?;
    let s = Session::open(ctx, repo).await?;
    let book = book(&s).await?;
    let snap = current(&book, &s, env)?;
    let text = render_dotenv(&snap.vars);
    let Some(path) = output else {
        // stdout, for piping: the text only
        let mut out = std::io::stdout().lock();
        out.write_all(text.as_bytes()).context("writing stdout")?;
        out.flush().ok();
        return Ok(());
    };
    let guard = write_export(path, &text, force)?;
    let (ignored, note) = match &guard {
        GitGuard::NoRepository => (Value::Null, "not inside a git repository".to_owned()),
        GitGuard::Ignored { added: Some(e) } => (
            json!(true),
            format!("added {e} to .git/info/exclude, and git check-ignore confirms it"),
        ),
        GitGuard::Ignored { added: None } => (
            json!(true),
            "already ignored by git (git check-ignore)".to_owned(),
        ),
        GitGuard::NotIgnored => (json!(false), "git does not ignore it".to_owned()),
    };
    ctx.emit(
        json!({
            "status": "written",
            "env": env,
            "file": path.display().to_string(),
            "entries": snap.vars.len(),
            "mode": "0600",
            "ignored": ignored,
        }),
        || {
            println!(
                "✓ wrote {} of {env} to {} (readable by you only)",
                count(snap.vars.len(), "entry"),
                path.display()
            );
            println!("  {note}");
        },
    );
    Ok(())
}

/// `dg env audience --env E --set …`: save `env` again for a new audience.
async fn change_audience(ctx: &Ctx, repo: &str, env: &str, opts: &AudienceOpts) -> Result<()> {
    check_env_name(env)?;
    let s = Session::open_for_write(ctx, repo, "environment not changed").await?;
    let envs = environments(&s);
    envs.require_maintainer(&s.repo, &format!("change {env}"))
        .await?;
    let audience = audience_of(&s, opts).await?;
    let book = existing(&envs, &s, env).await?;
    commit(ctx, &s, &envs, &book, env, audience, None, false, |_| Ok(())).await
}

/// The book, when `env` is an environment of it this reader can name (else the error).
async fn existing(envs: &Environments<'_>, s: &Session, env: &str) -> Result<Book> {
    let book = envs.read(&s.repo).await?;
    if book.state(env).is_none() {
        return Err(blocked_error(
            &s.repo,
            env,
            Blocked::Missing {
                hidden: book.resolution.hidden.len(),
            },
            true,
        ));
    }
    Ok(book)
}

/// `dg env share|unshare --env E @who…`: add people beside the audience, or take them away
/// (then list what they could read, to change where it's used).
async fn share(ctx: &Ctx, repo: &str, env: &str, people: &[String], add: bool) -> Result<()> {
    check_env_name(env)?;
    let s = Session::open_for_write(ctx, repo, "environment not changed").await?;
    let envs = environments(&s);
    let who = identities(&s, people).await?;
    envs.require_maintainer(&s.repo, &format!("change {env}"))
        .await?;
    let book = existing(&envs, &s, env).await?;
    commit(ctx, &s, &envs, &book, env, None, None, false, |next| {
        let Some(aud) = next.audience.as_mut() else {
            return Err(audience_required(env).into());
        };
        let mut also: BTreeSet<String> = aud.also.iter().cloned().collect();
        for w in &who {
            if add {
                also.insert(w.clone());
            } else if !also.remove(w) {
                return Err(UserError::new(
                    codes::NOT_FOUND,
                    format!("{w} isn't added to {env} by name"),
                )
                .cause(format!(
                    "{env} is for {}; to take someone in its group away, change their role or the audience",
                    aud.label()
                ))
                .note("nothing was written")
                .into());
            }
        }
        if aud.group.is_none() && also.is_empty() {
            return Err(UserError::new(
                codes::USAGE,
                format!("{env} would be for nobody"),
            )
            .fix(format!("give it another audience: `dg env audience --env {env} --set maintainers`"))
            .note("nothing was written")
            .into());
        }
        aud.also = also.into_iter().collect();
        Ok(())
    })
    .await?;
    if !add {
        for w in &who {
            for e in book.exposure(w, false).iter().filter(|e| e.env == env) {
                eprintln!(
                    "{w} could read {}. Change them where they're used: {}",
                    count(e.names.len(), &format!("{env} value")),
                    e.names.join(", ")
                );
            }
        }
    }
    Ok(())
}

/// `dg env resave`: save environments again for the people their audience covers now, and in
/// the new format.
async fn resave(ctx: &Ctx, repo: &str, env: Option<&str>, all: bool) -> Result<()> {
    if let Some(e) = env {
        check_env_name(e)?;
    }
    let s = Session::open_for_write(ctx, repo, "environment not saved again").await?;
    let envs = environments(&s);
    envs.require_maintainer(&s.repo, "save environments again")
        .await?;
    if let Some(env) = env {
        let book = existing(&envs, &s, env).await?;
        return commit(ctx, &s, &envs, &book, env, None, None, true, |_| Ok(())).await;
    }
    let book = envs.read(&s.repo).await?;
    debug_assert!(all);
    let people = People::read(&s, &book).await?;
    let mut todo = Vec::new();
    let mut skipped = Vec::new();
    for e in &book.resolution.environments {
        match book.current(&e.env) {
            Ok(snap) if snap.version == 1 || !stale_of(&book, &e.env, &people).is_empty() => {
                todo.push(e.env.clone());
            }
            Ok(_) => {}
            Err(Blocked::Conflict { .. }) => skipped.push(format!(
                "{}: not saved again: it has versions saved at the same time; keep one first (`dg env history --env {}`)",
                e.env, e.env
            )),
            Err(_) => skipped.push(format!(
                "{}: not saved again: you can't read its latest change. Ask {}",
                e.env,
                book.heads(&e.env).pop().map(|h| h.author).unwrap_or_default()
            )),
        }
    }
    if !book.resolution.hidden.is_empty() {
        skipped.push(format!(
            "{} you can't read: not saved again. Ask {}",
            count(book.resolution.hidden.len(), "environment"),
            hidden_authors(&book).join(", ")
        ));
    }
    for line in &skipped {
        eprintln!("{line}");
    }
    if todo.is_empty() {
        ctx.emit(json!({ "status": "unchanged", "saved": [], "notSaved": skipped }), || {
            println!("Every environment you can read is up to date. Nothing to save.");
        });
        return Ok(());
    }
    for env in &todo {
        commit(ctx, &s, &envs, &book, env, None, None, true, |_| Ok(())).await?;
    }
    Ok(())
}

/// The authors of the latest changes of environments this reader can't name.
fn hidden_authors(book: &Book) -> Vec<String> {
    let authors: BTreeSet<String> = book
        .resolution
        .hidden
        .iter()
        .flat_map(|h| h.heads.iter())
        .filter_map(|id| book.manifest(id).map(|m| m.owner_id.clone()))
        .collect();
    authors.into_iter().collect()
}

/// `dg env mark-changed --env E [NAME…]`: record that values held in old-format versions were
/// changed where they're used.
async fn mark_changed(ctx: &Ctx, repo: &str, env: &str, names: &[String]) -> Result<()> {
    check_env_name(env)?;
    for n in names {
        check_var_name(n)?;
    }
    let s = Session::open_for_write(ctx, repo, "nothing marked").await?;
    let envs = environments(&s);
    envs.require_maintainer(&s.repo, &format!("change {env}"))
        .await?;
    let book = envs.read(&s.repo).await?;
    let Some(old) = book.old_format_of(env) else {
        return Err(UserError::new(
            codes::USAGE,
            format!("{env} has no values saved in the old format"),
        )
        .note("nothing was written")
        .into());
    };
    // the values held in old-format versions, by name
    let state = book.state(env).expect("old_format_of found it");
    let mut held: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for id in state.snapshots.iter().filter(|id| book.old_format.contains(*id)) {
        if let Some(snap) = book.snapshot(id) {
            for (n, v) in &snap.vars {
                held.entry(n).or_default().push(&v.value);
            }
        }
    }
    let picked: Vec<String> = if names.is_empty() {
        old.unmarked.clone()
    } else {
        names.to_vec()
    };
    if let Some(n) = picked.iter().find(|n| !held.contains_key(n.as_str())) {
        return Err(UserError::new(
            codes::USAGE,
            format!("{n} has no value saved in the old format in {env} that you can read"),
        )
        .note("nothing was written")
        .into());
    }
    if picked.is_empty() {
        ctx.emit(json!({ "status": "unchanged", "env": env }), || {
            println!("Every value of {env} saved in the old format is marked changed. Nothing to save.");
        });
        return Ok(());
    }
    let current = book.current(env).map_err(|b| blocked_error(&s.repo, env, b, true))?;
    let still: Vec<&String> = picked
        .iter()
        .filter(|n| {
            current
                .vars
                .get(n.as_str())
                .is_some_and(|v| held[n.as_str()].contains(&v.value.as_str()))
        })
        .collect();
    if !still.is_empty() {
        let list: Vec<&str> = still.iter().map(|n| n.as_str()).collect();
        return Err(UserError::new(
            codes::USAGE,
            format!(
                "{} still {} a value saved in the old format",
                list.join(", "),
                if list.len() == 1 { "holds" } else { "hold" }
            ),
        )
        .fix(format!(
            "change it where it's used, then here: `dg env set {} --env {env}`, then mark it changed",
            list.join(" ")
        ))
        .note("nothing was written")
        .into());
    }
    commit(ctx, &s, &envs, &book, env, None, None, false, |next| {
        let mut marked: BTreeSet<String> = next.marked.iter().cloned().collect();
        marked.extend(picked.iter().cloned());
        next.marked = marked.into_iter().collect();
        Ok(())
    })
    .await
}

async fn history(ctx: &Ctx, repo: &str, env: &str) -> Result<()> {
    check_env_name(env)?;
    let s = Session::open(ctx, repo).await?;
    let book = book(&s).await?;
    let Some(state) = book.state(env) else {
        return Err(blocked_error(
            &s.repo,
            env,
            Blocked::Missing {
                hidden: book.resolution.hidden.len(),
            },
            book.maintainers.contains(&s.identity.id()),
        ));
    };
    let items = book.history(env);
    let conflict = match book.current(env) {
        Err(Blocked::Conflict { heads, split }) => Some(conflict_headline(env, &heads, split)),
        _ => None,
    };
    let ignored = book.ignored_for(env);
    ctx.emit(
        json!({
            "env": env,
            "state": state.state,
            "heads": state.heads,
            "changes": items,
            "ignored": ignored,
        }),
        || {
            println!(
                "{env} in {} · {}",
                s.repo.display(),
                count(items.len(), "change")
            );
            for i in &items {
                let old = if book.old_format.contains(&i.head.id) {
                    " (old format)"
                } else {
                    ""
                };
                let what = if let Some(why) = &i.unreadable {
                    format!("can't be read by you: {why}{old}")
                } else {
                    let again = i
                        .saved_for
                        .as_ref()
                        .map(|m| format!("saved again for {m}: "))
                        .unwrap_or_default();
                    format!(
                        "{:<24} {again}{}{old}",
                        i.audience.as_ref().map(Audience::label).unwrap_or_default(),
                        summary(&i.changes)
                    )
                };
                println!(
                    "  {}  {}  {}  {:>6} B  {what}",
                    utc(i.head.created_at),
                    i.head.short(),
                    i.head.author,
                    i.size_bytes
                );
            }
            for h in &ignored {
                println!(
                    "  {}  {}  {}  ignored: not a maintainer now, never used",
                    utc(h.created_at),
                    h.short(),
                    h.author
                );
            }
            if let Some(headline) = &conflict {
                println!(
                    "{headline}. Compare the versions above, then a maintainer keeps one: `dg env edit --env {env} --keep <id>`."
                );
            }
            println!("{ACCESS_SENTENCE}");
        },
    );
    Ok(())
}

/// One snapshot a membership change saves, planned before it (values held in memory only).
struct Pin {
    env: String,
    /// The heads this environment is predicted to have once the change lands: saved only if it
    /// still has exactly these, so nothing that changed meanwhile is overwritten.
    predicted: Vec<String>,
    supersedes: Vec<[u8; 32]>,
    snapshot: Snapshot,
    /// Who it is for once saved (the snapshot's audience, without a removed member).
    audience: Audience,
    /// The people that audience covers once the change lands (the writer is added).
    people: BTreeSet<String>,
    saved_for: Option<String>,
    /// For a person: what this save keeps.
    what: String,
    size: u64,
}

impl Pin {
    /// A save of `snap` (the current version of `env`, manifest `size` bytes) for `audience` and
    /// `people`.
    #[allow(clippy::too_many_arguments)]
    fn new(
        env: &str,
        snap: &Snapshot,
        audience: Audience,
        people: BTreeSet<String>,
        predicted: Vec<String>,
        supersedes: Vec<[u8; 32]>,
        what: String,
    ) -> Self {
        // the plaintext grows by about one id per added recipient, and the header by one slot
        let n = people.len() + 1;
        let plain = snap.encode().map_or(512, |p| p.len());
        let plain = (plain + 48 * n.saturating_sub(snap.to.len())).div_ceil(512) * 512;
        let size = (plain + forge_core::private::named::artifact_header_len(n) + 16) as u64;
        Self {
            env: env.to_owned(),
            predicted,
            supersedes,
            snapshot: snap.clone(),
            audience,
            people,
            saved_for: None,
            what,
            size,
        }
    }

    fn credits(&self) -> u64 {
        forge_core::env::service::snapshot_credits(self.size)
    }
}

/// `snap`'s audience without `removed` among the people it adds.
fn audience_without(snap: &Snapshot, removed: Option<&str>) -> Audience {
    let mut a = snap.audience.clone();
    if let Some(r) = removed {
        a.also.retain(|p| p != r);
    }
    a
}

/// The `packHash`es of `ids` in `book`.
fn hashes_of(book: &Book, ids: &[String]) -> Vec<[u8; 32]> {
    ids.iter()
        .filter_map(|id| book.manifest(id).map(|m| m.pack_hash))
        .collect()
}

/// `first`, then `rest` not already in it, at most [`MAX_SUPERSEDES`].
fn joined(first: Vec<[u8; 32]>, rest: Vec<[u8; 32]>) -> Vec<[u8; 32]> {
    let mut out = first;
    for h in rest {
        if !out.contains(&h) {
            out.push(h);
        }
    }
    out.truncate(forge_core::env::service::MAX_SUPERSEDES);
    out
}

/// The membership documents of a repository once `member` gets `role` (`Some`), or loses the
/// document `role`'s type is held in (`None` with `role` the removed one): what a membership
/// change's plan resolves groups against.
#[must_use]
pub fn members_after(before: &[Member], member: &str, role: Role, grant: bool) -> Vec<Member> {
    let ty = forge_core::members::doc_type(role);
    let mut out: Vec<Member> = before
        .iter()
        .filter(|m| !(m.identity_id == member && forge_core::members::doc_type(m.role) == ty))
        .cloned()
        .collect();
    if grant {
        out.push(Member {
            identity_id: member.to_owned(),
            role,
            document_id: String::new(),
            created_at: 0,
        });
    }
    out
}

/// What a membership change does to the environments whose groups it changes (D34, DESIGN §4.5
/// "Groups change"): each one this signer can read is saved again for the people its audience
/// covers once the change lands, after showing the plan and the cost; the rest are named so
/// someone who can read them saves them.
#[derive(Default)]
pub struct Regroup {
    pins: Vec<Pin>,
    /// "not updated" lines: environments that change and can't be saved from here.
    not_updated: Vec<String>,
    /// The plan, as JSON.
    pub planned: Value,
}

impl Regroup {
    /// Print the plan to stderr; the sentence the confirmation adds (empty when nothing is saved).
    #[must_use]
    pub fn explain(&self, price: Option<f64>) -> String {
        for p in &self.pins {
            eprintln!("  {}: {}", p.env, p.what);
        }
        for l in &self.not_updated {
            eprintln!("  {l}");
        }
        if self.pins.is_empty() {
            return String::new();
        }
        format!(
            " Then {} saved again for the people {} covers ({}).",
            if self.pins.len() == 1 {
                format!("{} is", self.pins[0].env)
            } else {
                format!("{} are", count(self.pins.len(), "environment"))
            },
            if self.pins.len() == 1 { "its audience" } else { "their audiences" },
            cost_line(self.pins.iter().map(Pin::credits).sum(), price)
        )
    }

    /// The environments planned, by name.
    fn envs(&self) -> BTreeSet<String> {
        self.pins.iter().map(|p| p.env.clone()).collect()
    }

    /// Save the planned snapshots (after the change landed).
    pub async fn save(&self, s: &Session) -> (Value, String) {
        let (saved, mut text) = save_pins(s, &self.pins, " for its audience now").await;
        for l in &self.not_updated {
            let _ = write!(text, "\n{l}");
        }
        (saved, text)
    }
}

/// [`Regroup`] for a change of `s.repo`'s members from `before` to `after`; `removed`: a member
/// who leaves (dropped from the people environments add, and named for environments this signer
/// can't open); `skip`: environments another plan of this change already saves.
pub async fn prepare_regroup(
    s: &Session,
    before: &[Member],
    after: &[Member],
    removed: Option<&str>,
    skip: &BTreeSet<String>,
) -> Result<Regroup> {
    let book = book(s).await?;
    Ok(plan_regroup(&book, s.repo.owner_id(), before, after, removed, skip))
}

/// [`prepare_regroup`] over a book already read.
fn plan_regroup(
    book: &Book,
    owner: &str,
    before: &[Member],
    after: &[Member],
    removed: Option<&str>,
    skip: &BTreeSet<String>,
) -> Regroup {
    let mut out = Regroup::default();
    let mut planned = Vec::new();
    for e in &book.resolution.environments {
        if skip.contains(&e.env) {
            continue;
        }
        let snap = match book.current(&e.env) {
            Ok(snap) => snap,
            Err(Blocked::Conflict { .. }) => {
                out.not_updated.push(format!(
                    "{}: not updated: it has versions saved at the same time. Keep one, then `dg env resave --env {}`.",
                    e.env, e.env
                ));
                continue;
            }
            Err(_) => {
                let author = book.heads(&e.env).pop().map(|h| h.author).unwrap_or_default();
                out.not_updated.push(format!(
                    "{}: not updated: you can't read its latest change. Ask {author} to save it again.",
                    e.env
                ));
                continue;
            }
        };
        let aud = audience_without(snap, removed);
        let was = resolve_people(&snap.audience, owner, before);
        let will = resolve_people(&aud, owner, after);
        if was == will {
            continue;
        }
        let added: Vec<&String> = will.difference(&was).collect();
        let gone: Vec<&String> = was.difference(&will).collect();
        let mut what = aud.label();
        for a in &added {
            let _ = write!(what, ", +{a}");
        }
        for g in &gone {
            let _ = write!(what, ", -{g}");
        }
        planned.push(json!({ "env": e.env, "added": added, "removed": gone }));
        out.pins.push(Pin::new(
            &e.env,
            snap,
            aud,
            will,
            e.heads.clone(),
            book.window(&e.env),
            what,
        ));
    }
    if !book.resolution.hidden.is_empty() {
        let n = count(book.resolution.hidden.len(), "environment");
        let authors = hidden_authors(book).join(", ");
        out.not_updated.push(match removed {
            Some(m) => format!(
                "{m} may be named in {n} you can't open. Ask {authors} to save {} again without {m}.",
                if book.resolution.hidden.len() == 1 { "it" } else { "them" }
            ),
            None => format!("{n} you can't open {} not updated. Ask {authors}.", if book.resolution.hidden.len() == 1 { "is" } else { "are" }),
        });
    }
    out.planned = json!({ "save": planned, "notUpdated": out.not_updated });
    out
}

/// What removing a member does to environments, worked out before the confirmation: the
/// checklist of what they could read; for a maintainer, the snapshots that keep every
/// environment as it is once their snapshots stop counting (a dry run of the resolution without
/// them, compared per environment); and the environments whose group they leave, saved again
/// without them ([`Regroup`]).
#[derive(Default)]
pub struct Removal {
    /// The checklist, as JSON.
    pub exposed: Value,
    checklist: String,
    pins: Vec<Pin>,
    /// Environments that change and that the remover cannot save again (not readable here).
    cannot: Vec<String>,
    regroup: Regroup,
}

impl Removal {
    /// Print to stderr what the removal saves again (per environment, values hidden) and what
    /// it cannot; the sentence the removal prompt adds (empty when nothing is saved again).
    #[must_use]
    pub fn explain(&self, price: Option<f64>) -> String {
        explain_pins(&self.pins, &self.cannot, "After the removal");
        let regroup = self.regroup.explain(price);
        if self.pins.is_empty() {
            return regroup;
        }
        format!(
            ". {} will then be saved again as you ({}), unless you say no next or pass --no-resave{regroup}",
            count(self.pins.len(), "environment"),
            cost_line(self.pins.iter().map(Pin::credits).sum(), price)
        )
    }

    /// [`Self::explain`] under `--no-resave`: name each environment that changes when `member`
    /// goes (none is saved again), then drop the saves. Returns the prompt's sentence.
    pub fn explain_skipped(&mut self, member: &str) -> String {
        explain_pins(&[], &self.cannot, "After the removal");
        let n = self.pins.len() + self.regroup.pins.len();
        if n == 0 {
            return String::new();
        }
        for p in self.pins.iter().chain(&self.regroup.pins) {
            eprintln!(
                "  {}: changes when {member} goes. Not saved again (--no-resave): {member} can read its current values until someone does.",
                p.env
            );
        }
        self.skip_saves(member);
        let verb = if n == 1 {
            "changes and is"
        } else {
            "change and are"
        };
        format!(
            ". {} {verb} not saved again (--no-resave)",
            count(n, "environment")
        )
    }

    /// Whether anything is to be saved again.
    #[must_use]
    pub fn saves(&self) -> bool {
        !self.pins.is_empty() || !self.regroup.pins.is_empty()
    }

    /// Drop the saves (`--no-resave`, or a no at their own confirmation).
    pub fn skip_saves(&mut self, member: &str) {
        let envs: Vec<&str> = self
            .pins
            .iter()
            .chain(&self.regroup.pins)
            .map(|p| p.env.as_str())
            .collect();
        if !envs.is_empty() {
            let _ = write!(
                self.checklist,
                "\nNot saved again: {}. {member} can read their current values until someone saves them again (`dg env resave --all`).",
                envs.join(", ")
            );
        }
        self.pins.clear();
        self.regroup.pins.clear();
    }

    /// The plan of the environments saved again for their audience, as JSON.
    #[must_use]
    pub fn regroup_json(&self) -> Value {
        self.regroup.planned.clone()
    }
}

fn explain_pins(pins: &[Pin], cannot: &[String], when: &str) {
    for p in pins {
        eprintln!("  {}: {}", p.env, p.what);
    }
    for env in cannot {
        eprintln!(
            "  {env}: {when} it changes, and you can't read it, so you can't save it first. Ask a maintainer who can read it, or check it afterwards with `dg env history --env {env}`."
        );
    }
}

/// [`Removal`] for `member` leaving `s.repo` (their `role` document goes; `before` the members
/// now), read before anything changes. `held_members_key`: whether they held the members key.
/// Reading fails softly (a note in the checklist).
pub async fn prepare_removal(
    s: &Session,
    member: &str,
    role: Role,
    before: &[Member],
    held_members_key: bool,
) -> Removal {
    let book = match book(s).await {
        Ok(b) => b,
        Err(e) => {
            return Removal {
                checklist: format!("\ncouldn't list the environments {member} could read: {e}"),
                ..Removal::default()
            }
        }
    };
    let after = members_after(before, member, role, false);
    let exposed = book.exposure(member, held_members_key);
    let mut checklist = String::new();
    for e in &exposed {
        let n = e.names.len();
        let past = if e.old_format {
            " (and every past value saved in the old format)"
        } else {
            ""
        };
        let _ = write!(
            checklist,
            "\n{member} could read {n} {} value{}{past}. Change {} where {} used: {}",
            e.env,
            if n == 1 { "" } else { "s" },
            if n == 1 { "it" } else { "them" },
            if n == 1 { "it's" } else { "they're" },
            e.names.join(", ")
        );
    }
    // environments the remover cannot read at all: hidden ones, and those whose latest change
    // does not open here (a conflict is readable, only undecided)
    let unreadable = book.resolution.hidden.len()
        + book
            .resolution
            .environments
            .iter()
            .filter(|e| e.state == forge_core::env::State::Unreadable)
            .count();
    if unreadable > 0 {
        let _ = write!(
            checklist,
            "\nYou can't read {} here, so it isn't listed. {member} may have been able to read values there.",
            count(unreadable, "environment")
        );
    }
    let (pins, cannot) = if role == Role::Maintainer {
        plan_removal(&book, member, &after, s.repo.owner_id())
    } else {
        (Vec::new(), Vec::new())
    };
    let skip: BTreeSet<String> = pins.iter().map(|p| p.env.clone()).collect();
    let regroup = plan_regroup(&book, s.repo.owner_id(), before, &after, Some(member), &skip);
    Removal {
        exposed: serde_json::to_value(&exposed).unwrap_or(Value::Null),
        checklist,
        pins,
        cannot,
        regroup,
    }
}

/// The saves that keep every environment as it is when `member` stops being a maintainer: a dry
/// run of the resolution without them, per environment whose heads change. Each is saved for its
/// audience as it will be (`after`, the members once they are gone).
/// - One head (theirs, or anyone's when their snapshots held the chain together): it is saved
///   again as the remover, naming the heads the dry run predicts, so one head remains.
/// - A conflict: each head of theirs is saved again naming only what it superseded, so the
///   conflict stays for a maintainer to settle (never decided by the removal).
fn plan_removal(
    book: &Book,
    member: &str,
    after: &[Member],
    owner: &str,
) -> (Vec<Pin>, Vec<String>) {
    let mut without = book.maintainers.clone();
    without.remove(member);
    let resolved_after = book.resolution_with(&without);
    let diff_env = forge_core::env::chain::changed(&book.resolution, &resolved_after);
    let (mut pins, mut cannot) = (Vec::new(), Vec::new());
    let for_audience = |snap: &Snapshot| {
        let aud = audience_without(snap, Some(member));
        let people = resolve_people(&aud, owner, after);
        (aud, people)
    };
    for env in diff_env.changed.iter().chain(&diff_env.vanished) {
        let Some(state) = book.state(env) else {
            continue;
        };
        let (predicted, kept_ids) = resolved_after
            .env(env)
            .map(|a| (a.heads.clone(), a.snapshots.clone()))
            .unwrap_or_default();
        match state.state {
            forge_core::env::State::Current => {
                let id = &state.heads[0];
                let (Some(m), Some(snap)) = (book.manifest(id), book.snapshot(id)) else {
                    cannot.push(env.clone());
                    continue;
                };
                let theirs = m.owner_id == member;
                let (aud, people) = for_audience(snap);
                let what = if theirs {
                    format!(
                        "saved again as you with the values {member} last saved ({}). Their change: {}. Values are not shown.",
                        aud.label(),
                        summary(&diff(book.previous_by_other(state, m, member), snap))
                    )
                } else {
                    format!("saved again as you, unchanged, so its history stays in one piece without {member}.")
                };
                let mut first = hashes_of(book, &predicted);
                if theirs {
                    first.insert(0, m.pack_hash);
                }
                let supersedes = joined(first, book.window_over(&kept_ids, &predicted));
                let mut pin = Pin::new(env, snap, aud, people, predicted, supersedes, what);
                pin.saved_for = theirs.then(|| member.to_owned());
                pins.push(pin);
            }
            forge_core::env::State::Conflict => {
                for id in &state.heads {
                    let Some(m) = book.manifest(id).filter(|m| m.owner_id == member) else {
                        continue;
                    };
                    let Some(snap) = book.snapshot(id) else {
                        cannot.push(env.clone());
                        continue;
                    };
                    // Their version again, linked to the versions it came from that still
                    // count: it stays one of the versions at the same time, sharing their
                    // history, without replacing any other head.
                    let mut first = vec![m.pack_hash];
                    first.extend(kept_ancestors(book, &state.snapshots, &kept_ids, m));
                    let (aud, people) = for_audience(snap);
                    let mut pin = Pin::new(
                        env,
                        snap,
                        aud,
                        people,
                        predicted.clone(),
                        joined(first, Vec::new()),
                        format!(
                            "has versions saved at the same time; {member}'s ({}) is saved again as you so it stays one of them. Values are not shown.",
                            &id[..id.len().min(10)]
                        ),
                    );
                    pin.saved_for = Some(member.to_owned());
                    pins.push(pin);
                }
            }
            forge_core::env::State::Unreadable => cannot.push(env.clone()),
        }
    }
    (pins, cannot)
}

/// The pack hashes of the snapshots among `kept` (those that still count without the removed
/// member) that `head` descends from through the links among `counted` (the resolution before),
/// newest first.
fn kept_ancestors(
    book: &Book,
    counted: &[String],
    kept: &[String],
    head: &forge_core::repo::PackManifestInfo,
) -> Vec<[u8; 32]> {
    let manifests: Vec<&forge_core::repo::PackManifestInfo> =
        counted.iter().filter_map(|id| book.manifest(id)).collect();
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    let mut todo = vec![head];
    let mut found = Vec::new();
    while let Some(m) = todo.pop() {
        for parent in manifests.iter().filter(|p| {
            m.supersedes.contains(&p.pack_hash)
                && p.created_at_block_height < m.created_at_block_height
        }) {
            if seen.insert(parent.document_id.as_str()) {
                if kept.contains(&parent.document_id) {
                    found.push(*parent);
                }
                todo.push(parent);
            }
        }
    }
    found.sort_by(|a, b| {
        (b.created_at_block_height, &b.document_id)
            .cmp(&(a.created_at_block_height, &a.document_id))
    });
    found.into_iter().map(|m| m.pack_hash).collect()
}

/// After the membership change: save each planned snapshot, as the signer, but only those whose
/// environment still has exactly the predicted heads (checked against one read made before any is
/// written).
/// Returns the environments saved as JSON, and text to print (each line starting with a
/// newline).
async fn save_pins(s: &Session, pins: &[Pin], done: &str) -> (Value, String) {
    let mut text = String::new();
    let mut saved_envs = Vec::new();
    if pins.is_empty() {
        return (json!(saved_envs), text);
    }
    let envs = environments(s);
    let book = match envs.read(&s.repo).await {
        Ok(b) => b,
        Err(e) => {
            let _ = write!(text, "\ncouldn't read the environments to save them: {e}");
            return (json!(saved_envs), text);
        }
    };
    for pin in pins {
        let heads = book.state(&pin.env).map(|st| st.heads.as_slice());
        if heads.unwrap_or_default() != pin.predicted.as_slice() {
            let _ = write!(
                text,
                "\n{} changed after the plan was shown, so it wasn't saved. Check it: `dg env history --env {}`.",
                pin.env, pin.env
            );
            continue;
        }
        let written = async {
            let id = match pin.snapshot.id {
                Some(id) => id,
                None => book.base(&s.repo, &pin.env, None)?.id_or_new()?,
            };
            let draft = Draft {
                env: pin.env.clone(),
                id,
                audience: pin.audience.clone(),
                vars: pin.snapshot.vars.clone(),
                supersedes: pin.supersedes.clone(),
                saved_for: pin.saved_for.clone(),
                marked_changed: pin.snapshot.marked_changed.clone(),
                people: Some(pin.people.clone()),
            };
            let prepared = envs.prepare(&s.repo, &draft).await?;
            envs.store(&s.repo, &prepared).await
        };
        match written.await {
            Ok(saved) => {
                let _ = write!(
                    text,
                    "\nSaved {} as you ({}, {}){done}.",
                    pin.env,
                    pin.audience.label(),
                    count(saved.to.len(), "person")
                );
                saved_envs.push(pin.env.clone());
            }
            Err(e) => {
                let _ = write!(
                    text,
                    "\ncouldn't save {}: {e}. Check it: `dg env history --env {}`.",
                    pin.env, pin.env
                );
            }
        }
    }
    (json!(saved_envs), text)
}

/// After `member` is removed (and the key rotated): the planned saves (see [`plan_removal`] and
/// [`Regroup`]), then the checklist.
pub async fn finish_removal(s: &Session, removal: &Removal) -> (Value, String) {
    let (saved, mut text) =
        save_pins(s, &removal.pins, " again, as it was before the removal").await;
    let (regrouped, regroup_text) = removal.regroup.save(s).await;
    text.push_str(&regroup_text);
    text.push_str(&removal.checklist);
    let mut all: Vec<Value> = saved.as_array().cloned().unwrap_or_default();
    all.extend(regrouped.as_array().cloned().unwrap_or_default());
    (Value::Array(all), text)
}

/// What making `member` a maintainer does to environments: their earlier snapshots (ignored
/// while they were not one) would start counting and could change values or split a chain. A
/// dry run of the resolution with them finds the environments that change; each is saved first
/// with its current values, naming their dormant snapshots, so nothing changes when the role
/// lands. Each is saved for its audience with them in it.
#[derive(Default)]
pub struct Promotion {
    pins: Vec<Pin>,
    cannot: Vec<String>,
    appeared: Vec<String>,
}

impl Promotion {
    /// Print to stderr what would change and what is saved first; the sentence the add prompt
    /// starts with (empty when nothing is saved).
    #[must_use]
    pub fn explain(&self, member: &str, price: Option<f64>) -> String {
        explain_pins(&self.pins, &self.cannot, "When the role lands");
        for env in &self.appeared {
            eprintln!("  {env}: {member} saved it while not a maintainer; it appears once the role lands.");
        }
        if self.pins.is_empty() {
            return String::new();
        }
        format!(
            "First this saves {} as you, as listed above ({}). ",
            count(self.pins.len(), "environment"),
            cost_line(self.pins.iter().map(Pin::credits).sum(), price)
        )
    }

    /// The environments it saves.
    #[must_use]
    pub fn envs(&self) -> BTreeSet<String> {
        self.pins.iter().map(|p| p.env.clone()).collect()
    }

    /// Save the planned snapshots, before the role is granted.
    pub async fn save(&self, s: &Session) -> (Value, String) {
        save_pins(s, &self.pins, ", so it stays as it is").await
    }
}

/// [`Promotion`] for `member` becoming a maintainer of `s.repo`; `after`: the members once they
/// are one.
pub async fn prepare_promotion(s: &Session, member: &str, after: &[Member]) -> Result<Promotion> {
    let envs = environments(s);
    let now = envs.read(&s.repo).await?;
    if !now.manifests.iter().any(|m| m.owner_id == member) {
        return Ok(Promotion::default());
    }
    let then = envs.read_with_maintainer(&s.repo, member).await?;
    let diff_env = forge_core::env::chain::changed(&now.resolution, &then.resolution);
    let (mut pins, mut cannot) = (Vec::new(), Vec::new());
    for env in &diff_env.changed {
        let Ok(snap) = now.current(env) else {
            cannot.push(env.clone());
            continue;
        };
        let current = now
            .state(env)
            .map(|st| st.heads.clone())
            .unwrap_or_default();
        // The current version, then the window over the predicted history: its heads (the
        // member's dormant changes that would take over) first, each author's newest next.
        // Every snapshot the predicted history doesn't end in is already replaced by a counted one.
        let (ids, heads) = then
            .state(env)
            .map(|st| (st.snapshots.clone(), st.heads.clone()))
            .unwrap_or_default();
        let people = resolve_people(&snap.audience, s.repo.owner_id(), after);
        pins.push(Pin::new(
            env,
            snap,
            snap.audience.clone(),
            people,
            current.clone(),
            joined(hashes_of(&now, &current), then.window_over(&ids, &heads)),
            format!("{member}'s earlier changes would replace its values; it is saved first with its current values, which stay."),
        ));
    }
    Ok(Promotion {
        pins,
        cannot,
        appeared: diff_env.appeared,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALICE: &str = "alice";
    const BOB: &str = "bob";

    /// A kind-8 manifest `id` by `owner` at block `height`, superseding the snapshots `sup`.
    fn manifest(
        id: &str,
        owner: &str,
        height: u64,
        sup: &[&str],
    ) -> forge_core::repo::PackManifestInfo {
        let hash = |s: &str| {
            let mut h = [0u8; 32];
            h[..s.len()].copy_from_slice(s.as_bytes());
            h
        };
        forge_core::repo::PackManifestInfo {
            document_id: id.into(),
            created_at: height * 1000,
            owner_id: owner.into(),
            pack_hash: hash(id),
            kind: 8,
            size_bytes: 512,
            object_count: 0,
            chunk_count: 1,
            storage: 0,
            uris: Vec::new(),
            supersedes: sup.iter().map(|s| hash(s)).collect(),
            tips: Vec::new(),
            created_at_block_height: height,
        }
    }

    /// A book of `production` snapshots `manifests` (newest last) with `maintainers`.
    fn book(maintainers: &[&str], manifests: Vec<forge_core::repo::PackManifestInfo>) -> Book {
        let opened = manifests
            .iter()
            .map(|m| {
                let mut snap = Snapshot::new(
                    "production",
                    [1; 16],
                    Audience::group(Group::Maintainers),
                    [("V".to_owned(), var(&m.document_id))].into(),
                );
                snap.generated_at = m.created_at;
                (
                    m.document_id.clone(),
                    forge_core::env::service::Opened::Snapshot(snap),
                )
            })
            .collect();
        let maintainers: BTreeSet<String> = maintainers.iter().map(|&m| m.to_owned()).collect();
        let mut b = Book {
            maintainers: maintainers.clone(),
            manifests: manifests.into_iter().rev().collect(),
            opened,
            old_format: BTreeSet::new(),
            resolution: forge_core::env::Resolution::default(),
        };
        b.resolution = b.resolution_with(&maintainers);
        b
    }

    /// The book after the removal of `member` and the planned saves (by alice, at `height`).
    fn after_saves(b: &Book, member: &str, height: u64) -> Book {
        let (pins, cannot) = plan_removal(b, member, &[], ALICE);
        assert!(cannot.is_empty());
        let mut manifests: Vec<_> = b.manifests.iter().rev().cloned().collect();
        for (i, p) in pins.iter().enumerate() {
            let mut m = manifest(&format!("pin{i}"), ALICE, height + i as u64, &[]);
            m.supersedes.clone_from(&p.supersedes);
            manifests.push(m);
        }
        let left: Vec<&str> = b
            .maintainers
            .iter()
            .map(String::as_str)
            .filter(|&m| m != member)
            .collect();
        let mut a = book(&left, manifests);
        for (i, p) in pins.iter().enumerate() {
            a.opened.insert(
                format!("pin{i}"),
                forge_core::env::service::Opened::Snapshot(p.snapshot.clone()),
            );
        }
        a
    }

    #[test]
    fn a_removed_maintainers_version_in_a_conflict_keeps_its_shared_history() {
        // h by alice; d (alice) and bob's f1 -> f2 both from h: a conflict between d and f2.
        let b = book(
            &[ALICE, BOB],
            vec![
                manifest("h", ALICE, 10, &[]),
                manifest("d", ALICE, 11, &["h"]),
                manifest("f1", BOB, 11, &["h"]),
                manifest("f2", BOB, 12, &["f1"]),
            ],
        );
        assert_eq!(b.heads("production").len(), 2);
        let a = after_saves(&b, BOB, 20);
        let st = a.state("production").unwrap();
        assert_eq!(st.state, forge_core::env::State::Conflict);
        let heads: BTreeSet<&str> = st.heads.iter().map(String::as_str).collect();
        assert_eq!(heads, ["d", "pin0"].into());
        assert!(
            matches!(
                a.current("production"),
                Err(Blocked::Conflict { split: false, .. })
            ),
            "the saved version shares h with d"
        );
    }

    #[test]
    fn a_removed_maintainers_latest_version_is_saved_again_and_stays_current() {
        let b = book(
            &[ALICE, BOB],
            vec![
                manifest("h", ALICE, 10, &[]),
                manifest("f", BOB, 11, &["h"]),
            ],
        );
        let a = after_saves(&b, BOB, 20);
        let st = a.state("production").unwrap();
        assert_eq!(st.state, forge_core::env::State::Current);
        assert_eq!(st.heads, ["pin0"]);
        assert_eq!(a.current("production").unwrap().vars["V"].value, "f");
    }

    fn git(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
    }

    fn var(v: &str) -> Var {
        Var {
            value: v.into(),
            kind: VarType::Variable,
            note: String::new(),
        }
    }

    #[test]
    fn export_writes_0600_excludes_and_verifies() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q"]);
        let path = dir.path().join(".env");
        let vars: BTreeMap<String, Var> =
            [("A".into(), var("1")), ("B".into(), var("two words"))].into();
        let guard = write_export(&path, &render_dotenv(&vars), false).unwrap();
        assert_eq!(
            guard,
            GitGuard::Ignored {
                added: Some("/.env".into())
            }
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let back = parse_dotenv(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(back["B"].as_str(), "two words");
        // again: refused without --force, replaced with it, the exclude entry not repeated
        assert!(write_export(&path, "A=2\n", false).is_err());
        let guard = write_export(&path, "A=2\n", true).unwrap();
        assert_eq!(guard, GitGuard::Ignored { added: None });
        let exclude = std::fs::read_to_string(dir.path().join(".git/info/exclude")).unwrap();
        assert_eq!(exclude.matches("/.env").count(), 1);
    }

    #[test]
    fn export_refuses_a_tracked_file_and_works_outside_git() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q"]);
        let path = dir.path().join("config.env");
        std::fs::write(&path, "X=1\n").unwrap();
        git(dir.path(), &["add", "config.env"]);
        assert!(write_export(&path, "A=1\n", true).is_err());
        let outside = tempfile::tempdir().unwrap();
        let p = outside.path().join("plain.env");
        assert_eq!(
            write_export(&p, "A=1\n", false).unwrap(),
            GitGuard::NoRepository
        );
    }

    #[test]
    fn export_in_a_subdirectory_excludes_the_path_from_the_top() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q"]);
        std::fs::create_dir(dir.path().join("app")).unwrap();
        let path = dir.path().join("app/.env.local");
        let guard = write_export(&path, "A=1\n", false).unwrap();
        assert_eq!(
            guard,
            GitGuard::Ignored {
                added: Some("/app/.env.local".into())
            }
        );
    }

    #[test]
    fn set_keeps_types_and_notes_unless_told() {
        let mut vars: BTreeMap<String, Var> = BTreeMap::new();
        vars.insert(
            "OLD".into(),
            Var {
                value: "1".into(),
                kind: VarType::Secret,
                note: "keep me".into(),
            },
        );
        apply_set(
            &mut vars,
            &[
                ("OLD".into(), Zeroizing::new("2".into())),
                ("NEW".into(), Zeroizing::new("3".into())),
            ],
            false,
            None,
        );
        assert_eq!(vars["OLD"].kind, VarType::Secret);
        assert_eq!(vars["OLD"].note, "keep me");
        assert_eq!(vars["NEW"].kind, VarType::Variable);
        apply_set(
            &mut vars,
            &[("NEW".into(), Zeroizing::new("4".into()))],
            true,
            Some("n"),
        );
        assert_eq!(
            (vars["NEW"].kind, vars["NEW"].note.as_str()),
            (VarType::Secret, "n")
        );
    }

    #[test]
    fn entries_split_on_the_first_equals() {
        let (n, v) = split_entry("URL=a=b").unwrap();
        assert_eq!((n.as_str(), v.unwrap().as_str()), ("URL", "a=b"));
        assert!(split_entry("1BAD=x").is_err());
        assert!(split_entry("NAME").unwrap().1.is_none());
    }

    #[test]
    fn copy_uses_the_glossary() {
        let mut snap = Snapshot::new(
            "dev",
            [1; 16],
            Audience::group(Group::Writers),
            BTreeMap::new(),
        );
        snap.to = vec![ALICE.into()];
        let mut lines = vec![audience_line(&snap)];
        snap.version = 1;
        snap.audience = Audience::group(Group::Members);
        snap.to.clear();
        lines.push(audience_line(&snap));
        for line in lines {
            for banned in ["sealed", "lane", "named", "restricted", "reveal"] {
                assert!(!line.to_lowercase().contains(banned), "{line}");
            }
        }
    }

    fn member(id: &str, role: Role) -> Member {
        Member {
            identity_id: id.into(),
            role,
            document_id: String::new(),
            created_at: 0,
        }
    }

    /// A book with one current environment `env` for `audience`, sent to `to`.
    fn group_book(env: &str, audience: Audience, to: &[&str]) -> Book {
        let mut b = book(&[ALICE], vec![manifest("h", ALICE, 10, &[])]);
        let mut snap = Snapshot::new(env, [1; 16], audience, [("V".to_owned(), var("x"))].into());
        snap.to = to.iter().map(|t| (*t).to_owned()).collect();
        snap.to_keys = vec![1; to.len()];
        b.opened
            .insert("h".into(), forge_core::env::service::Opened::Snapshot(snap));
        b.resolution = b.resolution_with(&b.maintainers.clone());
        b
    }

    #[test]
    fn adding_a_reader_resaves_all_members_but_not_writers() {
        let before = vec![member(ALICE, Role::Maintainer), member(BOB, Role::Writer)];
        let after = members_after(&before, "rae", Role::Reader, true);
        for (group, resaved) in [
            (Group::Members, true),
            (Group::Writers, false),
            (Group::Maintainers, false),
        ] {
            let b = group_book("dev", Audience::group(group), &[ALICE, BOB]);
            let r = plan_regroup(&b, ALICE, &before, &after, None, &BTreeSet::new());
            assert_eq!(r.envs().len(), usize::from(resaved), "{group:?}");
            if resaved {
                assert!(r.pins[0].people.contains("rae"));
            }
        }
    }

    #[test]
    fn a_writer_promoted_or_demoted_resaves_the_groups_they_move_between() {
        let before = vec![member(ALICE, Role::Maintainer), member(BOB, Role::Writer)];
        let demoted = members_after(&before, BOB, Role::Reader, true);
        let b = group_book("ci", Audience::group(Group::Writers), &[ALICE, BOB]);
        let r = plan_regroup(&b, ALICE, &before, &demoted, None, &BTreeSet::new());
        assert_eq!(r.envs(), ["ci".to_owned()].into());
        assert!(!r.pins[0].people.contains(BOB));
        let b = group_book("dev", Audience::group(Group::Members), &[ALICE, BOB]);
        let r = plan_regroup(&b, ALICE, &before, &demoted, None, &BTreeSet::new());
        assert!(r.envs().is_empty(), "still a member");
    }

    #[test]
    fn a_removal_resaves_without_them_even_where_named() {
        let before = vec![member(ALICE, Role::Maintainer), member(BOB, Role::Writer)];
        let after = members_after(&before, BOB, Role::Writer, false);
        let b = group_book(
            "deploy",
            Audience::new(None, [ALICE.to_owned(), BOB.to_owned()]),
            &[ALICE, BOB],
        );
        let r = plan_regroup(&b, ALICE, &before, &after, Some(BOB), &BTreeSet::new());
        assert_eq!(r.pins[0].audience.also, vec![ALICE.to_owned()]);
        assert!(!r.pins[0].people.contains(BOB));
    }

    #[test]
    fn stale_lists_who_is_missing_and_whose_key_changed() {
        let b = group_book("ci", Audience::group(Group::Writers), &[ALICE, BOB]);
        let people = People {
            owner: ALICE.into(),
            members: vec![
                member(ALICE, Role::Maintainer),
                member(BOB, Role::Writer),
                member("dana", Role::Writer),
                member("noah", Role::Writer),
            ],
            keys: [
                (ALICE.to_owned(), Some(1)),
                (BOB.to_owned(), Some(2)),
                ("dana".to_owned(), Some(1)),
                ("noah".to_owned(), None),
            ]
            .into(),
        };
        let st = stale_of(&b, "ci", &people);
        let whys: Vec<&str> = st.iter().map(|s| s.why.as_str()).collect();
        assert!(whys.contains(&"dana is a writer, but ci hasn't been saved since"), "{whys:?}");
        assert!(whys.iter().any(|w| w.starts_with("noah has no encryption key")));
        assert!(whys.contains(&"bob's encryption key changed since ci was saved"));
    }

    #[test]
    fn counts_pluralise() {
        assert_eq!(count(1, "entry"), "1 entry");
        assert_eq!(count(3, "entry"), "3 entries");
        assert_eq!(count(2, "environment"), "2 environments");
    }

    #[cfg(unix)]
    #[test]
    fn export_force_replaces_a_symlink_instead_of_following_it() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q"]);
        let victim = dir.path().join("victim.txt");
        std::fs::write(&victim, "keep me\n").unwrap();
        let link = dir.path().join(".env");
        std::os::unix::fs::symlink(&victim, &link).unwrap();
        assert!(
            write_export(&link, "A=1\n", false).is_err(),
            "no --force: refused"
        );
        write_export(&link, "A=1\n", true).unwrap();
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep me\n");
        assert!(!link.symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(&link).unwrap(), "A=1\n");
    }

    #[test]
    fn export_is_refused_when_a_gitignore_un_ignores_the_file() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q"]);
        std::fs::write(dir.path().join(".gitignore"), "!/.env\n").unwrap();
        let path = dir.path().join(".env");
        assert!(write_export(&path, "A=1\n", false).is_err());
        assert!(!path.exists(), "nothing written");
    }

    #[test]
    fn ignore_patterns_match_only_the_path() {
        assert_eq!(ignore_pattern(".env"), ".env");
        assert_eq!(ignore_pattern("a*b/[x]?"), "a\\*b/\\[x\\]\\?");
        assert_eq!(ignore_pattern("#x"), "\\#x");
        assert_eq!(ignore_pattern("!x "), "\\!x\\ ");
    }

    #[test]
    fn startup_variables_are_named() {
        let vars: BTreeMap<String, Var> = [
            ("PATH".into(), var("/tmp")),
            ("DYLD_INSERT_LIBRARIES".into(), var("x")),
            ("NODE_OPTIONS".into(), var("--require x")),
            ("API_TOKEN".into(), var("t")),
        ]
        .into();
        assert_eq!(
            startup_overrides(&vars, &BTreeSet::new()),
            vec!["DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "PATH"]
        );
        let parent: BTreeSet<String> = ["API_TOKEN".to_owned()].into();
        assert_eq!(
            startup_overrides(&vars, &parent).len(),
            4,
            "shadowing the parent too"
        );
        for n in [
            "GIT_SSH_COMMAND",
            "LD_AUDIT",
            "npm_config_registry",
            "PYTHONPATH",
            "HOME",
        ] {
            assert!(is_startup_var(n), "{n}");
        }
        assert!(!is_startup_var("DATABASE_URL"));
    }

    #[test]
    fn export_refuses_a_name_differing_only_in_case_from_a_tracked_file() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q"]);
        std::fs::write(dir.path().join("Config.env"), "X=1\n").unwrap();
        git(dir.path(), &["add", "Config.env"]);
        assert!(write_export(&dir.path().join("config.env"), "A=1\n", true).is_err());
    }

    #[test]
    fn export_fails_closed_inside_a_work_tree_git_cannot_read() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap(); // not a repository git accepts
        let path = dir.path().join(".env");
        assert!(write_export(&path, "A=1\n", false).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn child_gets_every_value() {
        let vars: BTreeMap<String, Var> = [("A".into(), var("x y"))].into();
        let got = child_vars(&vars);
        assert_eq!(got[0].0, "A");
        assert_eq!(got[0].1.as_str(), "x y");
    }
}
