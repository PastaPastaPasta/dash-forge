//! `dg branch`: a repository's branches with who can see them, members-only branches, and
//! cleaning up after `dg publish` (mixed-visibility DESIGN §4.3, D12, §10 "Branches").
//!
//! * `dg branch [list]` lists the branches on Forge in two groups, Public and Members only. A
//!   member sees both, by their real names; anyone else sees the public ones and, when there
//!   are any, "This repo also has members-only branches." (never how many).
//! * `dg branch new --members <b>` starts a branch in this clone that pushes members-only: it
//!   records the intent `git-remote-dash` reads first (`branch.<b>.dashAudience`, D12) and
//!   describes the branch as members-only. It is refused for a name that is already public
//!   (E809: nothing already pushed can be hidden).
//! * `dg branch cleanup` deletes the local branches whose content `dg publish` published (the
//!   mapping in `<git common dir>/dash/published`).

use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};
use serde_json::json;

use forge_core::rules::v2::{Audience, Visibility};
use forge_core::user_error::{codes, UserError};

use crate::common::{Reader, Session};
use crate::context::Ctx;
use crate::fmt::{safe, short};
use crate::git;

/// The git config key holding a branch's audience (D12's local intent): `members` or `public`.
pub const AUDIENCE_KEY: &str = "dashAudience";

/// The `branch.<b>.description` a members-only branch gets (shown by `git branch -v`-style
/// tools and the helper).
const MEMBERS_DESCRIPTION: &str = "members-only";

/// `dg branch` subcommands.
#[derive(Debug, clap::Subcommand)]
pub enum BranchCommand {
    /// List the repository's branches and who can see them (Public, Members only).
    List {
        /// The repository (`owner/name`; inside a clone, the clone's).
        repo: String,
    },
    /// Start a branch here and switch to it. With --members it is members-only: when you push
    /// it, only the repository's members can see its name and commits.
    New {
        /// The branch name (`fix-auth`).
        name: String,
        /// Where it starts (default: the current commit).
        start: Option<String>,
        /// Members-only: only members see its name and commits once pushed. Needs your
        /// encryption key and members-only content turned on in the repository.
        #[arg(long)]
        members: bool,
        /// Public: everyone can see it once pushed (what a new branch is when nothing says
        /// otherwise).
        #[arg(long, conflicts_with = "members")]
        public: bool,
    },
    /// Delete the local branches whose content `dg publish` already published.
    Cleanup {
        /// List what would be deleted, and delete nothing.
        #[arg(long)]
        dry_run: bool,
    },
}

/// Dispatch `dg branch` (`None`: list this clone's repository).
pub async fn run(ctx: &Ctx, cmd: Option<&BranchCommand>) -> Result<()> {
    match cmd {
        None => {
            let repo = crate::storage::clone_repo().ok_or_else(|| {
                crate::errors::usage(
                    "not in a clone of a Forge repository: pass one, `dg branch list <owner/name>`",
                )
            })?;
            list(ctx, &repo).await
        }
        Some(BranchCommand::List { repo }) => list(ctx, repo).await,
        Some(BranchCommand::New {
            name,
            start,
            members,
            public,
        }) => new(ctx, name, start.as_deref(), *members, *public).await,
        Some(BranchCommand::Cleanup { dry_run }) => cleanup(ctx, *dry_run),
    }
}

/// One branch as listed.
struct Row {
    name: String,
    tip: Option<String>,
    members_only: bool,
}

async fn list(ctx: &Ctx, repo: &str) -> Result<()> {
    let s = Reader::open_discussion(ctx, repo).await?;
    let svc = s.service();
    let members = if s.repo.visibility == Visibility::Public {
        svc.read_members_refs(&s.repo).await?
    } else {
        None
    };
    let (rows, hidden_members): (Vec<Row>, bool) = match &members {
        Some(m) => (
            m.refs
                .iter()
                .filter(|r| r.name.starts_with("refs/heads/"))
                .map(|r| Row {
                    name: r.name.clone(),
                    tip: forge_core::rules::tip_of(&r.state),
                    members_only: r.members_only,
                })
                .collect(),
            false,
        ),
        None => {
            let refs = svc.read_refs(&s.repo).await?;
            let others = s.repo.visibility == Visibility::Public
                && svc.members_only_ref_count(&s.repo).await?.0 > 0;
            (
                refs.iter()
                    .filter(|(n, _)| n.starts_with("refs/heads/"))
                    .map(|(n, st)| Row {
                        name: n.clone(),
                        tip: forge_core::rules::tip_of(st),
                        members_only: false,
                    })
                    .collect(),
                others,
            )
        }
    };
    let live: Vec<&Row> = rows.iter().filter(|r| r.tip.is_some()).collect();
    let current = git::current_branch(Path::new(".")).map(|b| git::full_ref(&b));
    let audience = |r: &Row| if r.members_only { "members" } else { "public" };
    ctx.emit(
        json!({
            "repo": s.repo.display(),
            "branches": live.iter().map(|r| json!({
                "name": r.name.trim_start_matches("refs/heads/"),
                "ref": r.name,
                "tip": r.tip,
                "audience": audience(r),
            })).collect::<Vec<_>>(),
            "alsoMembersOnly": hidden_members,
        }),
        || {
            let width = live
                .iter()
                .map(|r| r.name.trim_start_matches("refs/heads/").len())
                .max()
                .unwrap_or(0);
            let print = |title: &str, members_only: bool| {
                let group: Vec<&&Row> = live
                    .iter()
                    .filter(|r| r.members_only == members_only)
                    .collect();
                if group.is_empty() {
                    return;
                }
                println!("{title}");
                for r in group {
                    let name = r.name.trim_start_matches("refs/heads/");
                    let mark = if current.as_deref() == Some(r.name.as_str()) {
                        '*'
                    } else {
                        ' '
                    };
                    println!(
                        "{mark} {:<width$}  {}",
                        safe(name),
                        short(r.tip.as_deref().unwrap_or_default())
                    );
                }
            };
            if live.is_empty() {
                println!("no branches");
            }
            print("Public", false);
            print("Members only 🔒", true);
            if hidden_members {
                println!("This repo also has members-only branches.");
            }
        },
    );
    Ok(())
}

async fn new(
    ctx: &Ctx,
    name: &str,
    start: Option<&str>,
    members: bool,
    public: bool,
) -> Result<()> {
    let cwd = std::env::current_dir().context("reading the current directory")?;
    let full = git::full_ref(name);
    git::require_branch_ref(&full)?;
    let short_name = full.trim_start_matches("refs/heads/").to_string();
    let repo = crate::storage::clone_repo();
    // D12: `dg branch new` asks on a terminal when nothing says who can see the branch and
    // the repository has members-only content.
    let members = if members || public || !ctx.interactive() {
        members
    } else {
        match &repo {
            Some(r) => ask_members(ctx, r, &short_name).await?,
            None => false,
        }
    };
    if members {
        let repo = repo.ok_or_else(|| {
            crate::errors::usage(
                "not in a clone of a Forge repository: a members-only branch is pushed to one",
            )
        })?;
        require_members_branch(ctx, &repo, &full, &short_name).await?;
    }
    let mut args = vec!["switch", "-c", short_name.as_str()];
    if let Some(s) = start {
        args.push(s);
    }
    git::git(&cwd, &args, &[]).with_context(|| format!("creating branch {short_name}"))?;
    let audience = if members {
        Some(Audience::Members)
    } else if public {
        Some(Audience::Public)
    } else {
        None
    };
    if let Some(a) = audience {
        set_audience(&cwd, &short_name, a)?;
    }
    ctx.emit(
        json!({
            "status": "created",
            "branch": short_name,
            "audience": audience.map(crate::audience::json),
        }),
        || {
            println!("✓ switched to a new branch {}", safe(&short_name));
            match audience {
                Some(Audience::Members) => println!(
                    "  members-only: once pushed (`git push origin {}`), only members see its name and commits; publish it later with `dg publish {} --onto main`",
                    safe(&short_name),
                    safe(&short_name)
                ),
                Some(_) => println!("  public: everyone will see it once pushed"),
                None => {}
            }
        },
    );
    Ok(())
}

/// Record `audience` for branch `b` in the clone at `cwd` (D12's local intent).
pub fn set_audience(cwd: &Path, b: &str, audience: Audience) -> Result<()> {
    let word = if audience == Audience::Members {
        "members"
    } else {
        "public"
    };
    git::git(
        cwd,
        &["config", &format!("branch.{b}.{AUDIENCE_KEY}"), word],
        &[],
    )?;
    if audience == Audience::Members {
        git::git(
            cwd,
            &[
                "config",
                &format!("branch.{b}.description"),
                MEMBERS_DESCRIPTION,
            ],
            &[],
        )?;
    }
    Ok(())
}

/// The audience recorded for branch `b` in the clone at `cwd`, if any.
pub fn recorded_audience(cwd: &Path, b: &str) -> Option<Audience> {
    match git::config_get(cwd, &format!("branch.{b}.{AUDIENCE_KEY}"))?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "members" => Some(Audience::Members),
        "public" => Some(Audience::Public),
        _ => None,
    }
}

/// Ask who can see a new branch, on a terminal, when `repo` has members-only content on.
async fn ask_members(ctx: &Ctx, repo: &str, name: &str) -> Result<bool> {
    let s = Reader::open_discussion(ctx, repo).await?;
    if s.repo.visibility != Visibility::Public
        || !forge_core::keyring::has_members_key(&s.client, &s.repo).await?
    {
        return Ok(false);
    }
    ctx.confirm(&format!(
        "Make {} members-only? Only members of {} will see its name and commits (no: public)",
        safe(name),
        s.repo.display()
    ))
}

/// Refuse a members-only branch the signer cannot push: not a member, no key, members-only
/// content off (E312: "turn it on: dg repo members enable"), or a name already public (E809).
async fn require_members_branch(ctx: &Ctx, repo: &str, full: &str, name: &str) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    if s.repo.visibility == Visibility::Private {
        return Err(UserError::new(
            codes::USAGE,
            format!(
                "{} is private: every branch in it is for its members already",
                s.repo.display()
            ),
        )
        .fix("leave out --members")
        .into());
    }
    s.collab()
        .require_members_writer(&s.repo, Audience::Members)
        .await?;
    let svc = forge_core::repo::RepoService::new(&s.client, &s.identity, &s.bridge);
    let public = svc
        .read_refs(&s.repo)
        .await?
        .into_iter()
        .any(|(n, st)| n == full && forge_core::rules::tip_of(&st).is_some());
    if public {
        return Err(already_public(name));
    }
    Ok(())
}

/// E809: `name` is already a public branch.
pub fn already_public(name: &str) -> anyhow::Error {
    UserError::new(
        codes::BRANCH_ALREADY_PUBLIC,
        format!(
            "{} is already public; nothing already pushed can be hidden",
            safe(name)
        ),
    )
    .fix(format!(
        "dg branch new --members {}-2     # start a members-only branch from here",
        safe(name)
    ))
    .into()
}

// ---------------------------------------------------------------------------
// the published mapping and cleanup
// ---------------------------------------------------------------------------

/// The header line of `<git common dir>/dash/published`.
const PUBLISHED_HEADER: &str = "# dash published v1";

/// One `dg publish`: members-only `tip` published as public `commit` on `base`, from `branch`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Published {
    /// The members-only tip published.
    pub tip: String,
    /// The public commit it became.
    pub commit: String,
    /// The public branch (`refs/heads/main`).
    pub base: String,
    /// The members-only branch (`refs/heads/sec/fix`).
    pub branch: String,
}

/// `<git common dir>/dash/published` of the repository at `cwd`.
pub fn published_path(cwd: &Path) -> Result<PathBuf> {
    let dir = git::git(cwd, &["rev-parse", "--git-common-dir"], &[])?;
    Ok(cwd.join(dir).join("dash").join("published"))
}

/// Append `p` to the mapping (created with its header when missing).
pub fn record_published(cwd: &Path, p: &Published) -> Result<()> {
    use std::io::Write as _;
    let path = published_path(cwd)?;
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).with_context(|| format!("creating {}", d.display()))?;
    }
    let fresh = !path.exists();
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .with_context(|| format!("opening {}", path.display()))?;
    if fresh {
        writeln!(f, "{PUBLISHED_HEADER}")?;
    }
    writeln!(f, "{} {} {} {}", p.tip, p.commit, p.base, p.branch)?;
    f.sync_all()?;
    Ok(())
}

/// Every mapping line of `text` (lines that are not four well-formed fields are skipped).
pub fn parse_published(text: &str) -> Vec<Published> {
    text.lines()
        .filter(|l| !l.starts_with('#'))
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let p = Published {
                tip: it.next()?.to_ascii_lowercase(),
                commit: it.next()?.to_ascii_lowercase(),
                base: it.next()?.to_string(),
                branch: it.next()?.to_string(),
            };
            (it.next().is_none()
                && git::is_oid(&p.tip)
                && git::is_oid(&p.commit)
                && git::is_plain_branch_ref(&p.base)
                && git::is_plain_branch_ref(&p.branch))
            .then_some(p)
        })
        .collect()
}

/// The local branches (`refs/heads/…`, with their tips) whose content a recorded publish
/// covers: the tip is the published members-only tip or one of its ancestors, and the public
/// commit is in this clone.
fn cleanable(cwd: &Path, published: &[Published]) -> Vec<(String, String, Published)> {
    let Ok(out) = git::git(
        cwd,
        &[
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/heads",
        ],
        &[],
    ) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for line in out.lines() {
        let Some((name, tip)) = line.split_once(' ') else {
            continue;
        };
        if let Some(p) = published.iter().rev().find(|p| {
            git::has_object(cwd, &p.commit)
                && (tip == p.tip || git::is_ancestor(cwd, tip, &p.tip))
                && name != p.base
        }) {
            found.push((name.to_string(), tip.to_string(), p.clone()));
        }
    }
    found
}

fn cleanup(ctx: &Ctx, dry_run: bool) -> Result<()> {
    let cwd = std::env::current_dir().context("reading the current directory")?;
    let path = published_path(&cwd)?;
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let published = parse_published(&text);
    let current = git::current_branch(&cwd).map(|b| git::full_ref(&b));
    let candidates = cleanable(&cwd, &published);
    let (kept, delete): (Vec<_>, Vec<_>) = candidates
        .into_iter()
        .partition(|(name, _, _)| current.as_deref() == Some(name.as_str()));
    if !delete.is_empty() && !dry_run {
        let names: Vec<&str> = delete
            .iter()
            .map(|(n, _, _)| n.trim_start_matches("refs/heads/"))
            .collect();
        ctx.confirm_or_cancel(&format!(
            "Delete {} (published)? Only this clone's branches; Forge keeps its copy.",
            safe(&names.join(", "))
        ))?;
        for (name, tip, _) in &delete {
            git::git(&cwd, &["update-ref", "-d", name, tip], &[])
                .with_context(|| format!("deleting {name}"))?;
        }
    }
    let row = |(name, tip, p): &(String, String, Published)| {
        json!({
            "branch": name.trim_start_matches("refs/heads/"),
            "tip": tip,
            "publishedAs": p.commit,
            "onto": p.base.trim_start_matches("refs/heads/"),
        })
    };
    ctx.emit(
        json!({
            "deleted": if dry_run { Vec::new() } else { delete.iter().map(row).collect() },
            "wouldDelete": if dry_run { delete.iter().map(row).collect() } else { Vec::new() },
            "keptCurrent": kept.iter().map(row).collect::<Vec<_>>(),
        }),
        || {
            if delete.is_empty() && kept.is_empty() {
                println!("no published branches to clean up");
            }
            for (name, _, p) in &delete {
                let b = name.trim_start_matches("refs/heads/");
                println!(
                    "{} {} (published as {} on {})",
                    if dry_run { "would delete" } else { "✓ deleted" },
                    safe(b),
                    short(&p.commit),
                    safe(p.base.trim_start_matches("refs/heads/"))
                );
            }
            for (name, _, _) in &kept {
                println!(
                    "kept {} (checked out; switch away first)",
                    safe(name.trim_start_matches("refs/heads/"))
                );
            }
            if !delete.is_empty() && !dry_run {
                println!(
                    "  the members-only branches are still on Forge; delete one with `git push origin --delete <branch>`"
                );
            }
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn published_lines_round_trip_and_skip_junk() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let text = format!(
            "{PUBLISHED_HEADER}\n{a} {b} refs/heads/main refs/heads/sec/fix\nnot a line\n{a} {b} main x\n"
        );
        let got = parse_published(&text);
        assert_eq!(
            got,
            vec![Published {
                tip: a.clone(),
                commit: b.clone(),
                base: "refs/heads/main".into(),
                branch: "refs/heads/sec/fix".into(),
            }]
        );
    }
}
