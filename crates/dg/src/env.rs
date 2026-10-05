//! `dg env` — environments: per-environment configuration and secrets kept outside git
//! (`forge_core::env`; mixed-visibility design §4.5, phase 1 "Environments lite").
//!
//! Each change saves a new snapshot of one whole environment, encrypted for its audience:
//! Maintainers (the current maintainers, by default for `production`, `prod*`, `staging` and
//! `release*`) or Members (everyone holding the repository's members key, now and later). Only
//! maintainers change environments. A snapshot counts only when its author is a current
//! maintainer; two people changing one environment at once leave two versions, which `run`,
//! `get` and `export` refuse until a maintainer keeps one (`--keep`).

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::io::{IsTerminal as _, Read as _, Write as _};
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};
use clap::{Subcommand, ValueEnum};
use serde_json::{json, Value};
use zeroize::Zeroizing;

use forge_core::env::format::{diff, parse_dotenv, render_dotenv, Change};
use forge_core::env::service::{conflict_error, utc, Blocked, Book, Draft, Environments, Prepared};
use forge_core::env::{
    default_audience, valid_env_name, valid_var_name, Audience, Snapshot, Var, VarType,
    ACCESS_SENTENCE, MEMBERS_SENTENCE,
};
use forge_core::scope::RepoRef as Repo;
use forge_core::user_error::{codes, UserError};

use crate::common::Session;
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line};

/// An audience as `--audience` takes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum AudienceArg {
    /// The current maintainers.
    Maintainers,
    /// Everyone holding the repository's members key, now and later.
    Members,
}

impl AudienceArg {
    fn core(self) -> Audience {
        match self {
            Self::Maintainers => Audience::Maintainers,
            Self::Members => Audience::Members,
        }
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
        /// Who can read the environment (default: its current audience; a new one by its name).
        #[arg(long, value_enum)]
        audience: Option<AudienceArg>,
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
    /// temporary file is private to you and erased afterwards.
    Edit {
        /// The repository.
        repo: String,
        /// The environment.
        #[arg(long)]
        env: String,
        /// Mark new and changed entries as secrets.
        #[arg(long)]
        secret: bool,
        /// Who can read the environment.
        #[arg(long, value_enum)]
        audience: Option<AudienceArg>,
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
        /// Who can read the environment.
        #[arg(long, value_enum)]
        audience: Option<AudienceArg>,
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
            | Self::Import { repo, .. } => ("environment not changed", Some(repo)),
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
            audience,
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
                *audience,
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
            audience,
            keep,
        } => edit(ctx, repo, env, *secret, *audience, keep.as_deref()).await,
        EnvCommand::Import {
            repo,
            file,
            env,
            secret,
            audience,
            keep,
        } => import(ctx, repo, file, env, *secret, *audience, keep.as_deref()).await,
        EnvCommand::Run { repo, env, command } => run_with(ctx, repo, env, command).await,
        EnvCommand::Export {
            repo,
            env,
            output,
            force,
        } => export(ctx, repo, env, output.as_deref(), *force).await,
        EnvCommand::History { repo, env } => history(ctx, repo, env).await,
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

/// Read every environment of `s.repo` as the session's identity.
async fn book(s: &Session) -> Result<Book> {
    Ok(Environments::new(&s.client, &s.identity, &s.bridge)
        .read(&s.repo)
        .await?)
}

/// The values of `env`, or the error that says why they cannot be used (fail closed).
fn current<'b>(book: &'b Book, s: &Session, env: &str) -> Result<&'b Snapshot> {
    book.current(env)
        .map_err(|b| blocked_error(&s.repo, env, b, book.maintainers.contains(&s.identity.id())))
}

fn blocked_error(repo: &Repo, env: &str, blocked: Blocked, maintainer: bool) -> anyhow::Error {
    match blocked {
        Blocked::Missing { hidden } => {
            let mut u = UserError::new(
                codes::NOT_FOUND,
                format!("{} has no environment {env} you can read", repo.display()),
            );
            if hidden > 0 {
                let why = if maintainer {
                    ""
                } else {
                    " Environments for Maintainers are sent only to the repo's maintainers, and you aren't one."
                };
                u = u.cause(format!(
                    "{} there can't be read by you. {env} may be one of them.{why}",
                    count(hidden, "environment")
                ));
            }
            u.fix(format!(
                "`dg env ls {}` lists the environments you can read",
                repo.display()
            ))
            .into()
        }
        Blocked::Conflict(heads) => conflict_error(repo, env, &heads).into(),
        Blocked::Unreadable { head, reason } => {
            let u = UserError::new(
                codes::NOT_A_KEY_HOLDER,
                format!("the latest change to {env} can't be read by you"),
            )
            .cause(format!(
                "{} by {} at {}: {reason}",
                head.short(),
                head.author,
                utc(head.created_at)
            ));
            let u = if maintainer {
                u.fix("ask a maintainer who can read it to save it again. It then goes to every maintainer with an encryption key.")
            } else {
                u.fix(format!(
                    "if you're a member who should hold the members key, ask a maintainer to run `dg repo keys repair {}`",
                    repo.display()
                ))
                .note("each change can be read only by the people it was saved for")
            };
            u.into()
        }
    }
}

fn audience_line(snap: &Snapshot) -> String {
    match snap.audience {
        Audience::Maintainers => format!(
            "Maintainers: {} ({} when last saved)",
            snap.to.join(", "),
            if snap.to.len() == 1 {
                "the maintainer"
            } else {
                "the maintainers"
            }
        ),
        Audience::Members => format!("Members. {MEMBERS_SENTENCE}"),
    }
}

/// `dg env ls --env <env>`: one environment's entries, values hidden.
fn ls_env(ctx: &Ctx, s: &Session, book: &Book, env: &str) -> Result<()> {
    let snap = current(book, s, env)?;
    let head = &book.heads(env)[0];
    ctx.emit(
        json!({
            "env": env,
            "audience": snap.audience,
            "to": snap.to,
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
        return ls_env(ctx, &s, &book, env);
    }
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
                "audience": snap.map(|s| s.audience),
                "entries": snap.map(|s| s.vars.len()),
                "updatedBy": head.as_ref().map(|h| h.author.clone()),
                "updatedAt": head.as_ref().map(|h| h.created_at),
                "versions": e.heads.len(),
            })
        })
        .collect();
    let hidden = book.resolution.hidden.len();
    let ignored = book.resolution.ignored.len();
    ctx.emit(
        json!({ "environments": rows, "hidden": hidden, "ignored": ignored }),
        || {
            if book.resolution.environments.is_empty() && hidden == 0 {
                println!("No environments yet. Secrets stored here are encrypted for the people you choose and injected with `dg env run`. They're never committed to git.");
                return;
            }
            for e in &book.resolution.environments {
                let head = book.heads(&e.env).pop();
                let when = head
                    .as_ref()
                    .map(|h| format!("updated {} by {}", utc(h.created_at), h.author))
                    .unwrap_or_default();
                let what = match book.current(&e.env) {
                    Ok(snap) => format!(
                        "{:<12} {} entr{}",
                        snap.audience.label(),
                        snap.vars.len(),
                        if snap.vars.len() == 1 { "y" } else { "ies" }
                    ),
                    Err(Blocked::Conflict(h)) => {
                        format!("two people changed it at once ({} versions)", h.len())
                    }
                    Err(_) => "latest change can't be read by you".into(),
                };
                println!("{:<24} {what:<44} {when}", e.env);
            }
            if hidden > 0 {
                println!("+ {} you can't read", count(hidden, "environment"));
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
    audience: Option<AudienceArg>,
    keep: Option<&str>,
) -> Result<()> {
    check_env_name(env)?;
    for e in entries {
        split_entry(e)?;
    }
    let s = Session::open_for_write(ctx, repo, "environment not changed").await?;
    let envs = Environments::new(&s.client, &s.identity, &s.bridge);
    envs.require_maintainer(&s.repo, &format!("change {env}"))
        .await?;
    let values = entry_values(ctx, entries)?;
    save(ctx, &s, &envs, env, audience, keep, |vars| {
        apply_set(vars, &values, secret, note);
        Ok(())
    })
    .await
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
    let envs = Environments::new(&s.client, &s.identity, &s.bridge);
    save(ctx, &s, &envs, env, None, keep, |vars| {
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
    audience: Option<AudienceArg>,
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
    let envs = Environments::new(&s.client, &s.identity, &s.bridge);
    save(ctx, &s, &envs, env, audience, keep, |vars| {
        apply_set(vars, &values, secret, None);
        Ok(())
    })
    .await
}

/// The header `dg env edit` puts above the entries.
fn edit_header(repo: &Repo, env: &str, audience: Audience) -> String {
    format!(
        "# dg env edit: {} · {env} ({})\n# One NAME=value per line. Delete a line to remove the entry. Lines starting with # are ignored.\n# Saved as one change when you close the editor. Nothing is saved if nothing changed.\n",
        repo.display(),
        audience.label()
    )
}

/// Open `text` in the user's editor in a private temporary file and return what they saved.
/// The file is overwritten and removed afterwards.
fn run_editor(text: &str) -> Result<Zeroizing<String>> {
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
    let saved = std::fs::read_to_string(&path).map(Zeroizing::new);
    // overwrite before removing: the file held every value
    if let Ok(meta) = std::fs::metadata(&path) {
        let _ = std::fs::write(&path, vec![0u8; usize::try_from(meta.len()).unwrap_or(0)]);
    }
    let _ = std::fs::remove_file(&path);
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
    audience: Option<AudienceArg>,
    keep: Option<&str>,
) -> Result<()> {
    check_env_name(env)?;
    if !std::io::stdin().is_terminal() || ctx.json {
        return Err(UserError::new(codes::USAGE, "dg env edit needs a terminal")
            .fix("use `dg env set`, `dg env unset` or `dg env import` in scripts")
            .into());
    }
    let s = Session::open_for_write(ctx, repo, "environment not changed").await?;
    let envs = Environments::new(&s.client, &s.identity, &s.bridge);
    envs.require_maintainer(&s.repo, &format!("change {env}"))
        .await?;
    let book = envs.read(&s.repo).await?;
    let base = book.base(&s.repo, env, keep)?;
    let shown = audience
        .map(AudienceArg::core)
        .or(base.audience)
        .unwrap_or_else(|| default_audience(env));
    let mut text = Zeroizing::new(edit_header(&s.repo, env, shown));
    text.push_str(&render_dotenv(&base.vars));
    let saved = run_editor(&text)?;
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
    commit(ctx, &s, &envs, &book, env, audience, keep, |vars| {
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

/// Read the book, apply `change` to the environment's entries and save it as one snapshot.
async fn save(
    ctx: &Ctx,
    s: &Session,
    envs: &Environments<'_>,
    env: &str,
    audience: Option<AudienceArg>,
    keep: Option<&str>,
    change: impl FnOnce(&mut BTreeMap<String, Var>) -> Result<()>,
) -> Result<()> {
    envs.require_maintainer(&s.repo, &format!("change {env}"))
        .await?;
    let book = envs.read(&s.repo).await?;
    commit(ctx, s, envs, &book, env, audience, keep, change).await
}

#[allow(clippy::too_many_arguments, clippy::too_many_lines)] // the plan, its warnings, the write
async fn commit(
    ctx: &Ctx,
    s: &Session,
    envs: &Environments<'_>,
    book: &Book,
    env: &str,
    audience: Option<AudienceArg>,
    keep: Option<&str>,
    change: impl FnOnce(&mut BTreeMap<String, Var>) -> Result<()>,
) -> Result<()> {
    let base = book.base(&s.repo, env, keep)?;
    let before = Snapshot {
        env: env.to_owned(),
        audience: base.audience.unwrap_or(Audience::Members),
        generated_at: 0,
        to: Vec::new(),
        vars: base.vars.clone(),
    };
    let mut vars = base.vars.clone();
    change(&mut vars)?;
    let audience = audience
        .map(AudienceArg::core)
        .or(base.audience)
        .unwrap_or_else(|| default_audience(env));
    let after = Snapshot {
        env: env.to_owned(),
        audience,
        generated_at: 0,
        to: Vec::new(),
        vars,
    };
    let changes = diff(base.audience.map(|_| &before), &after);
    let resolving = base.supersedes.len() > 1;
    if changes.is_empty() && base.audience == Some(audience) && !resolving {
        ctx.emit(json!({ "status": "unchanged", "env": env }), || {
            println!("{env} already holds that. Nothing to save.");
        });
        return Ok(());
    }
    let draft = Draft {
        env: env.to_owned(),
        audience,
        vars: after.vars,
        supersedes: base.supersedes.clone(),
    };
    let prepared = envs.prepare(&s.repo, &draft).await?;
    let quote = prepared.credits();
    let new_env = base.audience.is_none();
    let hidden = book.resolution.hidden.len();
    let mut lines = vec![format!(
        "Save {env} in {} for {} ({})?",
        s.repo.display(),
        audience_phrase(&prepared, audience),
        summary(&changes)
    )];
    if let Some(old) = base.audience.filter(|a| *a != audience) {
        lines.push(format!(
            "  Who can read it changes from {} to {}. Earlier versions stay readable by whoever could read them.",
            old.label(),
            audience.label()
        ));
    }
    if audience == Audience::Members {
        lines.push(format!("  {MEMBERS_SENTENCE}"));
    }
    for who in &prepared.skipped {
        lines.push(format!(
            "  {who} is a maintainer without an encryption key and won't be able to read it."
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
            base.supersedes.len()
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
            "id": saved.id,
            "packHash": saved.pack_hash,
            "sizeBytes": saved.size_bytes,
            "quote": cost_json(quote, ctx.usd_price()),
            "spent": cost_json(spent, ctx.usd_price()),
        }),
        || {
            println!(
                "✓ saved {env} ({}): {}",
                audience_phrase(&prepared, audience),
                summary(&changes)
            );
            println!("  spent {}", cost_line(spent, ctx.usd_price()));
        },
    );
    Ok(())
}

fn audience_phrase(prepared: &Prepared, audience: Audience) -> String {
    match audience {
        Audience::Maintainers => format!(
            "Maintainers, sent to {} {}",
            prepared.to.len(),
            if prepared.to.len() == 1 {
                "person"
            } else {
                "people"
            }
        ),
        Audience::Members => "Members".into(),
    }
}

/// `n thing` or `n things`.
fn count(n: usize, thing: &str) -> String {
    if n == 1 {
        format!("1 {thing}")
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

async fn run_with(ctx: &Ctx, repo: &str, env: &str, command: &[String]) -> Result<()> {
    check_env_name(env)?;
    let s = Session::open(ctx, repo).await?;
    let book = book(&s).await?;
    let snap = current(&book, &s, env)?;
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

/// Create (or with `replace`, replace) `path` holding `bytes`, readable by its owner only.
fn write_private(path: &Path, bytes: &[u8], replace: bool) -> Result<()> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true);
    if replace {
        opts.create(true).truncate(true);
    } else {
        opts.create_new(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        opts.mode(0o600);
    }
    let mut f = opts.open(path).map_err(|e| {
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
    #[cfg(unix)]
    {
        // an existing file keeps its mode on open: tighten it
        use std::os::unix::fs::PermissionsExt as _;
        f.set_permissions(std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("restricting {}", path.display()))?;
    }
    f.write_all(bytes)
        .with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

fn git_in(dir: &Path, args: &[&str]) -> Option<std::process::Output> {
    std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .ok()
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

/// The directory holding `path` and its file name.
fn dir_of(path: &Path) -> PathBuf {
    match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    }
}

/// Whether `path` is tracked by git (an export must not overwrite a committed file).
fn tracked(path: &Path) -> bool {
    let dir = dir_of(path);
    let Some(name) = path.file_name() else {
        return false;
    };
    git_in(
        &dir,
        &["ls-files", "--error-unmatch", "--", &name.to_string_lossy()],
    )
    .is_some_and(|o| o.status.success())
}

/// Keep `path` out of git: add `/<path from the top>` to the repository's `info/exclude` unless
/// it is ignored already, then verify with `git check-ignore`.
fn exclude_from_git(path: &Path) -> Result<GitGuard> {
    let dir = dir_of(path);
    let Some(top) = git_in(&dir, &["rev-parse", "--show-toplevel"])
        .filter(|o| o.status.success())
        .map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim()))
    else {
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
    let abs =
        std::fs::canonicalize(path).with_context(|| format!("resolving {}", path.display()))?;
    let top = std::fs::canonicalize(&top).unwrap_or(top);
    let rel = abs
        .strip_prefix(&top)
        .context("the output file is outside its git work tree")?;
    let entry = format!("/{}", rel.to_string_lossy().replace('\\', "/"));
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

/// Write the export file and keep it out of git.
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
    write_private(path, text.as_bytes(), force)?;
    exclude_from_git(path)
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
        GitGuard::Ignored { added: Some(e) } => (json!(true), format!("added {e} to .git/info/exclude, and git check-ignore confirms it")),
        GitGuard::Ignored { added: None } => (json!(true), "already ignored by git (git check-ignore)".to_owned()),
        GitGuard::NotIgnored => (json!(false), "WARNING: git still does not ignore it, because a .gitignore rule un-ignores it. Don't commit it.".to_owned()),
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
                "✓ wrote {} entr{} of {env} to {} (readable by you only)",
                snap.vars.len(),
                if snap.vars.len() == 1 { "y" } else { "ies" },
                path.display()
            );
            println!("  {note}");
        },
    );
    if guard == GitGuard::NotIgnored {
        eprintln!(
            "warning: {} is not ignored by git. Check your .gitignore before committing.",
            path.display()
        );
    }
    Ok(())
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
    let conflict = matches!(book.current(env), Err(Blocked::Conflict(_)));
    ctx.emit(
        json!({ "env": env, "state": state.state, "heads": state.heads, "changes": items }),
        || {
            println!("{env} in {} · {}", s.repo.display(), count(items.len(), "change"));
            for i in &items {
                let what = match &i.unreadable {
                    Some(why) => format!("can't be read by you: {why}"),
                    None => format!(
                        "{:<12} {}",
                        i.audience.map_or("", |a| a.label()),
                        summary(&i.changes)
                    ),
                };
                println!(
                    "  {}  {}  {}  {:>6} B  {what}",
                    utc(i.head.created_at),
                    i.head.short(),
                    i.head.author,
                    i.size_bytes
                );
            }
            if conflict {
                println!(
                    "Two people changed {env} at the same time: keep one with `dg env edit --env {env} --keep <id>`."
                );
            }
            println!("{ACCESS_SENTENCE}");
        },
    );
    Ok(())
}

/// The removal checklist for `member` leaving `s.repo` (DESIGN §4.5 "Audit and exposure"):
/// the environments and current value names they could read, as JSON and as text to print after
/// a line (each of its lines starts with a newline; empty when there is nothing to say).
/// `held_members_key`: whether they held the members key. Reading fails softly (a note).
pub async fn removal_checklist(
    s: &Session,
    member: &str,
    held_members_key: bool,
) -> (Value, String) {
    let book = match book(s).await {
        Ok(b) => b,
        Err(e) => {
            return (
                Value::Null,
                format!("\ncouldn't list the environments {member} could read: {e}"),
            )
        }
    };
    let exposed = book.exposure(member, held_members_key);
    let mut lines = String::new();
    for e in &exposed {
        let n = e.names.len();
        let past = if e.audience == Audience::Members {
            " (and every past value of it)"
        } else {
            ""
        };
        let _ = write!(
            lines,
            "\n{member} could read {n} {} value{}{past}. Rotate {} at the source: {}",
            e.env,
            if n == 1 { "" } else { "s" },
            if n == 1 { "it" } else { "them" },
            e.names.join(", ")
        );
    }
    (serde_json::to_value(&exposed).unwrap_or(Value::Null), lines)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let snap = Snapshot {
            env: "dev".into(),
            audience: Audience::Members,
            generated_at: 0,
            to: Vec::new(),
            vars: BTreeMap::new(),
        };
        let line = audience_line(&snap);
        for banned in ["sealed", "lane", "named", "restricted", "reveal"] {
            assert!(!line.to_lowercase().contains(banned), "{line}");
        }
        assert!(line.contains(MEMBERS_SENTENCE));
    }

    #[test]
    fn child_gets_every_value() {
        let vars: BTreeMap<String, Var> = [("A".into(), var("x y"))].into();
        let got = child_vars(&vars);
        assert_eq!(got[0].0, "A");
        assert_eq!(got[0].1.as_str(), "x y");
    }
}
