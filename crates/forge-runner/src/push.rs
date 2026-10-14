//! A bot's push from a job (phase 4E; mixed-visibility DESIGN §4.9 "Pushing" and "The runner",
//! D42; `docs/security/private-repos.md` §24.4). Runner conventions, not consensus: consensus
//! holds the bot to its grants (a live grant from a current maintainer, for this ref, before its
//! end), and this module adds what it cannot.
//!
//! * **One job, one target branch**, named in the request.
//! * **Proper requests only:** a fork's pull request or a non-member's request never pushes.
//! * **Taint:** a job that read members-only input pushes only to a members-only branch shared
//!   with the bot (a branch with its own key) whose people are all among the narrowest
//!   members-only input it read; never to a public branch.
//! * **The access:** a grant that can be pushed under now covers the branch (one older than the
//!   bot's current member row does not), and the bot's notice did not suspend its pushes.
//! * **The notice's push rules:** fast-forward only (by default), and with `openPrNotPush` only
//!   a new branch.
//!
//! The push itself is `git push` through `git-remote-dash`, signing with the runner's key
//! (`DASH_FORGE_KEY`): the helper's publication guard, ledger and secret scan run for it as for
//! any push (D21, E805, E807, E810), and the helper checks the grant again before anything is
//! stored. The access is read from `dg --json bot list` (the grants with their status, the
//! notice's rules) and `dg --json auth status` (the bot's own id).

use std::collections::BTreeSet;
use std::path::Path;
use std::process::{Command, Stdio};

use anyhow::{bail, Context as _, Result};

use crate::config::{Config, RepoConfig};

/// What a job asks to push.
#[derive(Debug, Clone)]
pub struct PushRequest {
    /// The one branch the request named (`fix-auth` or `refs/heads/fix-auth`).
    pub branch: String,
    /// The commit to push (in `git_dir`'s object store).
    pub commit: String,
    /// The members-only input the job read: `None` when it read public input only; else the
    /// people of the narrowest members-only input (identity ids, bots left out).
    pub members_input: Option<BTreeSet<String>>,
    /// The request is a proper one: a member asked, about a pull request whose head is in this
    /// repository. A fork's pull request or a stranger's request never pushes.
    pub proper: bool,
}

/// The branch a bot may push to, as its access describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Granted {
    /// Public refs starting with this prefix.
    Prefix(String),
    /// One members-only branch shared with the bot (full name) and its people now (bots left
    /// out).
    Members {
        /// The full ref name.
        name: String,
        /// Who it is for now, bots left out.
        people: BTreeSet<String>,
    },
}

/// A bot's push access as `dg bot list` reads it now.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Access {
    /// What it may push to now (grants that can be pushed under).
    pub granted: Vec<Granted>,
    /// A maintainer's notice suspended its pushes.
    pub suspended: bool,
    /// The notice's rules: fast-forward only.
    pub fast_forward_only: bool,
    /// The notice's rules: never push to an existing branch.
    pub open_pr_not_push: bool,
    /// Usable grants of members-only branches `dg` could not name (the key that opens them was
    /// not loaded): a push to such a branch would be refused for the wrong reason.
    pub unnamed_members: usize,
}

/// Why the runner does not push.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// A fork's pull request or a request from outside the members.
    NotProper,
    /// The job read members-only input and the branch is public.
    Tainted,
    /// The job read members-only input and the branch is for people outside it.
    Wider,
    /// No push access covers the branch.
    NotGranted,
    /// A maintainer suspended the bot's pushes.
    Suspended,
    /// The push would not fast-forward the branch.
    NotFastForward,
    /// The notice has the bot open pull requests instead, and the branch exists.
    Exists,
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Refusal::NotProper => {
                "a fork's pull request or a request from outside the members never pushes"
            }
            Refusal::Tainted => {
                "the job read members-only content, so it pushes only to a members-only branch shared with the bot"
            }
            Refusal::Wider => {
                "the job read members-only content that fewer people can read than this branch's audience"
            }
            Refusal::NotGranted => "the bot has no push access to this branch",
            Refusal::Suspended => "a maintainer suspended the bot's pushes",
            Refusal::NotFastForward => "the push would not fast-forward the branch",
            Refusal::Exists => {
                "the bot opens pull requests instead of pushing to an existing branch"
            }
        })
    }
}

/// `branch` as a full ref name.
#[must_use]
pub fn full_branch(branch: &str) -> String {
    if branch.starts_with("refs/") {
        branch.to_owned()
    } else {
        format!("refs/heads/{branch}")
    }
}

/// Whether the runner pushes `req` (its branch `full` currently at `tip`, `None` when it does
/// not exist) under `access`; `fast_forward(old, new)` says whether `new` contains `old`. The
/// first rule broken is the refusal, in the order of the module documentation.
pub fn decide(
    req: &PushRequest,
    full: &str,
    access: &Access,
    tip: Option<&str>,
    fast_forward: impl Fn(&str, &str) -> bool,
) -> std::result::Result<(), Refusal> {
    if !req.proper {
        return Err(Refusal::NotProper);
    }
    let granted = access.granted.iter().find(|g| match g {
        Granted::Prefix(p) => full.starts_with(p.as_str()),
        Granted::Members { name, .. } => name == full,
    });
    match (&req.members_input, granted) {
        (Some(_), Some(Granted::Prefix(_)) | None) => return Err(Refusal::Tainted),
        (Some(input), Some(Granted::Members { people, .. })) if !people.is_subset(input) => {
            return Err(Refusal::Wider)
        }
        (_, None) => return Err(Refusal::NotGranted),
        _ => {}
    }
    if access.suspended {
        return Err(Refusal::Suspended);
    }
    match tip {
        Some(_) if access.open_pr_not_push => Err(Refusal::Exists),
        Some(old) if access.fast_forward_only && !fast_forward(old, &req.commit) => {
            Err(Refusal::NotFastForward)
        }
        _ => Ok(()),
    }
}

/// [`Access`] of bot `bot` from `dg --json bot list`.
pub fn access_of(v: &serde_json::Value, bot: &str) -> Access {
    let Some(row) = v["bots"]
        .as_array()
        .and_then(|bots| bots.iter().find(|b| b["bot"].as_str() == Some(bot)))
    else {
        return Access::default();
    };
    let push = &row["push"];
    let policy = &push["policy"];
    let usable: Vec<&serde_json::Value> = push["grants"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|g| g["status"].as_str() == Some("usable"))
        .collect();
    let unnamed_members = usable
        .iter()
        .filter(|g| g["prefix"].is_null() && g["branchRef"].as_str().is_none())
        .count();
    let granted = usable
        .into_iter()
        .filter_map(|g| {
            if let Some(p) = g["prefix"].as_str() {
                return Some(Granted::Prefix(p.to_owned()));
            }
            Some(Granted::Members {
                name: g["branchRef"].as_str()?.to_owned(),
                people: g["people"]
                    .as_array()?
                    .iter()
                    .filter_map(|p| p.as_str().map(str::to_owned))
                    .collect(),
            })
        })
        .collect();
    Access {
        granted,
        suspended: push["suspended"].as_bool().unwrap_or(false),
        fast_forward_only: policy["fastForwardOnly"].as_bool().unwrap_or(true),
        open_pr_not_push: policy["openPrNotPush"].as_bool().unwrap_or(false),
        unnamed_members,
    }
}

/// A branch's tip as the bot reads it now (`dg --json branch list`, with its key: a members-only
/// branch shared with it is listed by its real name and commit), `None` when it does not exist.
fn tip_now(cfg: &Config, repo: &RepoConfig, full: &str) -> Result<Option<String>> {
    let v = dg_json(cfg, &["branch", "list", &repo.repo], "dg branch list")?;
    Ok(v["branches"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|b| b["ref"].as_str() == Some(full))
        .and_then(|b| b["tip"].as_str().map(str::to_ascii_lowercase)))
}

/// Everyone a members-only input of the whole repository is readable by (`dg --json collab
/// list`): every member and the owner, bots left out.
pub fn human_members(v: &serde_json::Value) -> BTreeSet<String> {
    v["members"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["role"].as_str() != Some("bot"))
        .filter_map(|m| m["identityId"].as_str().map(str::to_owned))
        .chain(v["ownerId"].as_str().map(str::to_owned))
        .collect()
}

/// `forge-runner push`'s arguments.
#[derive(Debug)]
pub struct CliArgs<'a> {
    /// The one branch.
    pub branch: &'a str,
    /// The commit.
    pub commit: &'a str,
    /// The git directory holding it.
    pub git_dir: &'a Path,
    /// The job read the repository's members-only content.
    pub members_input: bool,
    /// The job read members-only content for these people only.
    pub members_input_people: &'a [String],
    /// A fork's pull request or a request from outside the members.
    pub not_member: bool,
}

/// `forge-runner push`: the request from the command line, pushed or refused (an error naming
/// why, nothing written).
pub fn cli(cfg: &Config, repo: &RepoConfig, a: &CliArgs<'_>) -> Result<()> {
    let members_input = if a.members_input {
        let v = dg_json(cfg, &["collab", "list", &repo.repo], "dg collab list")?;
        Some(human_members(&v))
    } else if a.members_input_people.is_empty() {
        None
    } else {
        Some(a.members_input_people.iter().cloned().collect())
    };
    let req = PushRequest {
        branch: a.branch.to_owned(),
        commit: a.commit.to_ascii_lowercase(),
        members_input,
        proper: !a.not_member,
    };
    match push(cfg, repo, a.git_dir, &req)? {
        Pushed::Pushed { branch, commit } => {
            println!("pushed {commit} to {branch}");
            Ok(())
        }
        Pushed::Refused(why) => bail!("not pushed: {why} (nothing was written)"),
    }
}

/// Runs `cmd` with the runner's network, returning stdout or an error with what it said.
fn run(cfg: &Config, mut cmd: Command, what: &str) -> Result<String> {
    if let Some(n) = &cfg.network {
        cmd.env("DASH_FORGE_NETWORK", n);
    }
    if let Some(n) = &cfg.devnet_name {
        cmd.env("DASH_FORGE_DEVNET_NAME", n);
    }
    let out = cmd
        .stdin(Stdio::null())
        .output()
        .with_context(|| format!("{what}: could not start"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        bail!("{what} failed ({}): {}", out.status, err.trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `dg --json <args>`, run with the runner's network and parsed (`what` names it in errors).
fn dg_json(cfg: &Config, args: &[&str], what: &str) -> Result<serde_json::Value> {
    let mut cmd = Command::new(&cfg.bin.dg);
    cmd.arg("--json").args(args);
    serde_json::from_str(&run(cfg, cmd, what)?).with_context(|| format!("{what}: not JSON"))
}

/// The bot's own identity id (`dg --json auth status`, signing with `DASH_FORGE_KEY`).
fn own_id(cfg: &Config) -> Result<String> {
    let v = dg_json(cfg, &["auth", "status"], "dg auth status")?;
    v["identityId"]
        .as_str()
        .map(str::to_owned)
        .context("dg auth status: no identity (set DASH_FORGE_KEY to the bot's key)")
}

/// What the runner did with a push request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pushed {
    /// Pushed `commit` to `branch`.
    Pushed {
        /// The full ref name.
        branch: String,
        /// The commit.
        commit: String,
    },
    /// Refused before anything was written.
    Refused(Refusal),
}

/// Push `req` for repository `repo` from `git_dir` as the bot (`DASH_FORGE_KEY`), when
/// [`decide`] allows it. The helper checks the bot's grant again and runs the publication
/// guard, ledger and secret scan.
pub fn push(cfg: &Config, repo: &RepoConfig, git_dir: &Path, req: &PushRequest) -> Result<Pushed> {
    let full = full_branch(&req.branch);
    let bot = own_id(cfg)?;
    let list = dg_json(cfg, &["bot", "list", &repo.repo], "dg bot list")?;
    let access = access_of(&list, &bot);
    let tip = tip_now(cfg, repo, &full)?;
    let tip = tip.as_deref();
    let ff = |old: &str, new: &str| {
        Command::new(&cfg.bin.git)
            .arg("--git-dir")
            .arg(git_dir)
            .args(["merge-base", "--is-ancestor", old, new])
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    };
    match decide(req, &full, &access, tip, ff) {
        Err(Refusal::NotGranted | Refusal::Tainted) if access.unnamed_members > 0 => bail!(
            "the bot's push access names {} members-only branch(es) dg could not open: is \
             DASH_FORGE_KEY the bot's key, with its encryption key?",
            access.unnamed_members
        ),
        Err(why) => return Ok(Pushed::Refused(why)),
        Ok(()) => {}
    }
    let public = !access
        .granted
        .iter()
        .any(|g| matches!(g, Granted::Members { name, .. } if *name == full));
    let mut cmd = Command::new(&cfg.bin.git);
    cmd.arg("--git-dir").arg(git_dir).arg("push");
    if public {
        cmd.args(["-o", "public"]);
    }
    cmd.arg(repo.url()).arg(format!("{}:{full}", req.commit));
    run(cfg, cmd, "git push")?;
    Ok(Pushed::Pushed {
        branch: full,
        commit: req.commit.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(xs: &[&str]) -> BTreeSet<String> {
        xs.iter().map(|s| (*s).to_owned()).collect()
    }

    fn access() -> Access {
        Access {
            granted: vec![
                Granted::Prefix("refs/heads/bot/ci-bot/".into()),
                Granted::Members {
                    name: "refs/heads/fix-auth".into(),
                    people: set(&["a", "b"]),
                },
            ],
            suspended: false,
            fast_forward_only: true,
            open_pr_not_push: false,
            unnamed_members: 0,
        }
    }

    fn req(branch: &str, input: Option<&[&str]>) -> PushRequest {
        PushRequest {
            branch: branch.into(),
            commit: "c2".into(),
            members_input: input.map(set),
            proper: true,
        }
    }

    fn decide_for(
        r: &PushRequest,
        a: &Access,
        tip: Option<&str>,
    ) -> std::result::Result<(), Refusal> {
        decide(r, &full_branch(&r.branch), a, tip, |old, _| old == "c1")
    }

    #[test]
    fn a_public_job_pushes_under_its_prefix_only() {
        let a = access();
        assert_eq!(decide_for(&req("bot/ci-bot/x", None), &a, None), Ok(()));
        assert_eq!(
            decide_for(&req("main", None), &a, Some("c1")),
            Err(Refusal::NotGranted)
        );
        let mut stranger = req("bot/ci-bot/x", None);
        stranger.proper = false;
        assert_eq!(decide_for(&stranger, &a, None), Err(Refusal::NotProper));
    }

    #[test]
    fn a_tainted_job_never_pushes_a_public_branch() {
        let a = access();
        assert_eq!(
            decide_for(&req("bot/ci-bot/x", Some(&["a", "b", "c"])), &a, None),
            Err(Refusal::Tainted)
        );
        assert_eq!(
            decide_for(&req("fix-auth", Some(&["a", "b", "c"])), &a, Some("c1")),
            Ok(())
        );
        assert_eq!(
            decide_for(&req("fix-auth", Some(&["a"])), &a, Some("c1")),
            Err(Refusal::Wider)
        );
    }

    #[test]
    fn the_notice_rules_hold() {
        let mut a = access();
        assert_eq!(
            decide_for(&req("bot/ci-bot/x", None), &a, Some("c0")),
            Err(Refusal::NotFastForward)
        );
        a.open_pr_not_push = true;
        assert_eq!(
            decide_for(&req("bot/ci-bot/x", None), &a, Some("c1")),
            Err(Refusal::Exists)
        );
        a.suspended = true;
        assert_eq!(
            decide_for(&req("bot/ci-bot/x", None), &a, None),
            Err(Refusal::Suspended)
        );
    }

    #[test]
    fn access_reads_dg_bot_list() {
        let v = serde_json::json!({"bots": [{"bot": "B", "push": {
        "suspended": false,
        "policy": {"fastForwardOnly": true, "deleteOwnOnly": true, "openPrNotPush": false},
        "grants": [
            {"prefix": "refs/heads/bot/b/", "status": "usable"},
            {"prefix": "refs/heads/old/", "status": "expired"},
            {"scope": "ab", "branchRef": "refs/heads/fix", "people": ["a"], "status": "usable"}
        ]}}]});
        let a = access_of(&v, "B");
        assert_eq!(a.granted.len(), 2);
        assert!(a.fast_forward_only && !a.suspended);
        assert_eq!(access_of(&v, "C"), Access::default());
    }
}
