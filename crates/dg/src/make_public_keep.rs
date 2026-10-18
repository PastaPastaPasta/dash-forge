//! Keep private-era branches that changed at the conversion boundary as ordinary members-only
//! branches. Public publication uses a separate, below-boundary repository.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::{Context as _, Result};
use forge_core::cost::push_fees::{self, PushShape};
use forge_core::repo::RepoService;
use forge_core::rules::tip_of;
use forge_core::scope::RepoRef;
use serde::Serialize;

use crate::common::Session;
use crate::context::Ctx;
use crate::fmt::{cost_line, plural_with, safe};
use crate::git;
use crate::repo_make_public::{pack_size, private_dir, short_ref, work_repo_at};

type Refs = BTreeMap<String, String>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum Keep {
    Push {
        target: String,
    },
    Kept {
        #[serde(rename = "as")]
        as_: String,
    },
    Public,
    Tag,
    NotKept {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct KeepPlan {
    name: String,
    tip: String,
    keep: Keep,
}

/// Plan from live tips alone. `members` contains only ordinary all-members branches, never
/// narrower branches. `reserved` also holds narrower names. All names are full refs; each
/// alias is reserved before the next choice.
pub(crate) fn plan_keep(
    all_era: &Refs,
    below: &Refs,
    public: &Refs,
    members: &Refs,
    default_ref: &str,
    is_ancestor: impl Fn(&str, &str) -> bool,
    reserved: &BTreeSet<String>,
) -> Vec<KeepPlan> {
    let mut taken: BTreeSet<String> = all_era
        .keys()
        .chain(below.keys())
        .chain(public.keys())
        .chain(members.keys())
        .chain(reserved.iter())
        .cloned()
        .chain([default_ref.to_owned()])
        .collect();
    let clashes = |name: &str, names: &BTreeSet<String>| {
        names.iter().any(|n| {
            n == name || n.starts_with(&format!("{name}/")) || name.starts_with(&format!("{n}/"))
        })
    };
    let mut out = Vec::new();
    for (name, tip) in all_era {
        if below.get(name) == Some(tip) {
            continue;
        }
        let keep = if !name.starts_with("refs/heads/") {
            Keep::Tag
        } else if public.values().any(|p| is_ancestor(tip, p)) {
            Keep::Public
        } else if let Some((as_, _)) = members.iter().find(|(_, m)| is_ancestor(tip, m)) {
            Keep::Kept { as_: as_.clone() }
        } else {
            let keep = if !public.contains_key(name)
                && !below.contains_key(name)
                && !members.contains_key(name)
                && !reserved.contains(name)
                && name != default_ref
                && !public
                    .keys()
                    .chain(below.keys())
                    .chain(members.keys())
                    .chain(reserved.iter())
                    .any(|n| {
                        n.starts_with(&format!("{name}/")) || name.starts_with(&format!("{n}/"))
                    }) {
                Keep::Push {
                    target: name.clone(),
                }
            } else {
                let base = format!("refs/heads/members/{}", short_ref(name));
                if let Some(parent) = taken.iter().find(|n| base.starts_with(&format!("{n}/"))) {
                    Keep::NotKept {
                        reason: format!(
                            "members-only alias is blocked by branch {}",
                            short_ref(parent)
                        ),
                    }
                } else {
                    let mut candidate = base.clone();
                    let mut suffix = 2;
                    while clashes(&candidate, &taken) {
                        candidate = format!("{base}-{suffix}");
                        suffix += 1;
                    }
                    Keep::Push { target: candidate }
                }
            };
            if let Keep::Push { target } = &keep {
                taken.insert(target.clone());
            }
            keep
        };
        out.push(KeepPlan {
            name: name.clone(),
            tip: tip.clone(),
            keep,
        });
    }
    out
}

async fn member_tips(svc: &RepoService<'_>, repo: &RepoRef) -> Result<(Refs, BTreeSet<String>)> {
    let refs: Vec<_> = svc
        .read_members_refs(repo)
        .await?
        .into_iter()
        .flat_map(|m| m.refs)
        .filter(|r| r.members_only && r.name.starts_with("refs/heads/"))
        .filter_map(|r| tip_of(&r.state).map(|tip| (r.name, tip, r.narrower)))
        .collect();
    let reserved = refs.iter().map(|(n, _, _)| n.clone()).collect();
    let ordinary = refs
        .into_iter()
        .filter(|(_, _, narrower)| !narrower)
        .map(|(n, t, _)| (n, t))
        .collect();
    Ok((ordinary, reserved))
}

/// Called on every post-flip run, including a finished conversion's maintainer resume.
#[allow(clippy::too_many_arguments)] // the conversion's existing context plus its confirmation
pub(crate) async fn keep_for_members(
    ctx: &Ctx,
    s: &Session,
    psvc: &RepoService<'_>,
    private: &RepoRef,
    public: &RepoRef,
    cutoff: Option<u32>,
    dir: &Path,
    confirm: bool,
) -> Result<Vec<KeepPlan>> {
    sweep_keep_dirs(dir)?;
    with_boundary(cutoff, |cutoff| async move {
        let live = |refs: Vec<(String, forge_core::rules::RefState)>| -> Refs {
            refs.into_iter()
                .filter_map(|(n, st)| tip_of(&st).map(|t| (n, t)))
                .collect()
        };
        let all = live(psvc.read_refs_below(private, None).await?);
        let below = live(psvc.read_refs_below(private, Some(cutoff)).await?);
        if all.iter().all(|(n, t)| below.get(n) == Some(t)) {
            return Ok(Vec::new());
        }
        let svc = RepoService::new(&s.client, &s.identity, &s.bridge);
        let public_tips = live(svc.read_refs(public).await?);
        let (members, reserved) = member_tips(&svc, public).await?;
        let default = git::full_ref(
            &svc.read_default_branch(public)
                .await?
                .unwrap_or_else(|| "main".into()),
        );
        let exact = plan_keep(
            &all,
            &below,
            &public_tips,
            &members,
            &default,
            |a, b| a == b,
            &reserved,
        );
        if !has_pushes(&exact) {
            return Ok(exact);
        }
        with_keep_dir(dir, |keep_dir| async move {
            let env = git::dash_env_signing(ctx)?;
            git::git_dash(
                dir,
                &[
                    "clone",
                    "--no-checkout",
                    &public.remote_url(),
                    &keep_dir.to_string_lossy(),
                ],
                &env,
            )
            .context("cloning the public repository to keep branches for members")?;
            inherit_cost_consent(&std::env::current_dir()?, &keep_dir)?;
            work_repo_at(psvc, private, &[], None, &keep_dir).await?;
            let mut plan = plan_keep(
                &all,
                &below,
                &public_tips,
                &members,
                &default,
                |a, b| a == b || git::is_ancestor(&keep_dir, a, b),
                &reserved,
            );
            let (specs, credits) = prepare_push(&keep_dir, &mut plan);
            if specs.is_empty() {
                return Ok(plan);
            }
            let summary = format!(
                "Keep {} for members: estimated cost {} (Platform storage estimate).",
                plural_with(specs.len(), "branch", "branches"),
                cost_line(credits, ctx.usd_price())
            );
            if ctx.json {
                eprintln!("{summary}");
            } else {
                println!("{summary}");
            }
            let confirmed = confirm_keep(ctx, &keep_dir, confirm)?;
            let args = keep_push_args(&specs, confirmed);
            let pushed = git::git_dash(
                &keep_dir,
                &args.iter().map(String::as_str).collect::<Vec<_>>(),
                &env,
            )
            .map(|_| ())
            .context("keeping branches for members");
            let fresh = RepoService::new(&s.client, &s.identity, &s.bridge);
            let (confirmed, _) = member_tips(&fresh, public).await?;
            confirm_keep_push(&keep_dir, plan, pushed, &confirmed)
        })
        .await
    })
    .await
}

/// Pre-marker conversions without a boundary have no withheld interval to migrate.
async fn with_boundary<F, Fut>(cutoff: Option<u32>, work: F) -> Result<Vec<KeepPlan>>
where
    F: FnOnce(u32) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<KeepPlan>>>,
{
    match cutoff {
        Some(cutoff) => work(cutoff).await,
        None => Ok(Vec::new()),
    }
}

fn has_pushes(plan: &[KeepPlan]) -> bool {
    plan.iter().any(|p| matches!(p.keep, Keep::Push { .. }))
}

/// A push can reject some refs after others land. Confirm every target before deciding
/// whether the push failed globally or only individual branches were not kept.
fn confirm_keep_push(
    dir: &Path,
    mut plan: Vec<KeepPlan>,
    pushed: Result<()>,
    confirmed: &Refs,
) -> Result<Vec<KeepPlan>> {
    let mut any_confirmed = false;
    for row in &mut plan {
        if let Keep::Push { target } = &row.keep {
            if confirmed
                .get(target)
                .is_some_and(|t| t == &row.tip || git::is_ancestor(dir, &row.tip, t))
            {
                any_confirmed = true;
            } else {
                row.keep = Keep::NotKept {
                    reason: "the members-only ref could not be confirmed".into(),
                };
            }
        }
    }
    if !any_confirmed {
        pushed?;
    }
    Ok(plan)
}

/// Validate each branch independently. Price a full sealed pack and index per branch;
/// the helper can use thinner packs or external storage, so this is a conservative estimate.
fn prepare_push(dir: &Path, plan: &mut [KeepPlan]) -> (Vec<String>, u64) {
    let mut specs = Vec::new();
    let mut credits = 0_u64;
    for row in plan {
        if let Keep::Push { target } = &row.keep {
            let result = (|| -> Result<u64> {
                anyhow::ensure!(
                    target.len() <= 255,
                    "the members-only branch name is too long"
                );
                git::git(dir, &["check-ref-format", target], &[])
                    .context("the members-only branch name is invalid")?;
                anyhow::ensure!(
                    git::has_object(dir, &row.tip),
                    "code to keep for members could not be read"
                );
                let (pack_bytes, objects) = pack_size(dir, std::slice::from_ref(&row.tip))
                    .context("the branch history could not be read")?;
                Ok(push_fees::estimate_push(&PushShape {
                    pack_bytes,
                    objects,
                    index_objects: objects,
                    refs: 1,
                    external_targets: 0,
                    platform_bytes: true,
                    sealed: true,
                })
                .total())
            })();
            match result {
                Ok(cost) => {
                    credits = credits.saturating_add(cost);
                    specs.push(format!("{}:{target}", row.tip));
                }
                Err(e) => {
                    row.keep = Keep::NotKept {
                        reason: format!("{e:#}"),
                    }
                }
            }
        }
    }
    (specs, credits)
}

/// A scratch clone does not inherit the invoking clone's local consent settings. Carry the
/// user's mode and cap across so `refuse` is checked against the actual keep-push cost.
fn inherit_cost_consent(source: &Path, clone: &Path) -> Result<()> {
    for key in ["dash.confirm", "dash.costWarnThreshold"] {
        if let Some(value) = git::config_get(source, key) {
            git::git(clone, &["config", key, &value], &[])?;
        }
    }
    Ok(())
}

/// A keep-only resume has no typed publication confirmation. Respect explicit consent and
/// leave `refuse` to the helper's actual cost cap rather than overriding it.
fn confirm_keep(ctx: &Ctx, dir: &Path, needed: bool) -> Result<bool> {
    let mode = git::config_get(dir, "dash.confirm").unwrap_or_default();
    match mode.trim().to_ascii_lowercase().as_str() {
        // Preserve the helper's hard cap and its explicit per-push prompt, even with --yes.
        "refuse" | "always" | "true" | "yes" => Ok(false),
        "never" | "false" | "no" => Ok(true),
        "" | "auto" => {
            if needed {
                ctx.confirm_or_cancel("Keep these branches for members at the estimated cost?")?;
            }
            Ok(true)
        }
        _ => anyhow::bail!("dash.confirm must be auto, always, never or refuse"),
    }
}

fn keep_push_args(specs: &[String], confirmed: bool) -> Vec<String> {
    let mut args = Vec::new();
    if confirmed {
        args.extend(["-c".into(), "dash.confirm=never".into()]);
    }
    args.extend([
        "push".into(),
        "-o".into(),
        "members".into(),
        "origin".into(),
    ]);
    args.extend_from_slice(specs);
    args
}

fn keep_lock(dir: &Path) -> Result<std::fs::File> {
    private_dir(dir)?;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join(".keep.lock"))?;
    // A subprocess fork can briefly inherit an open descriptor until exec closes it.
    // Tolerate that short overlap, then refuse a genuinely concurrent keeper.
    for attempt in 0..20 {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(std::fs::TryLockError::WouldBlock) if attempt < 19 => {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(e) => {
                return Err(e).context("another keep step is using this conversion directory")
            }
        }
    }
    unreachable!("the final lock attempt returns")
}

/// Sweep interrupted plaintext clones, holding the same OS lock as a live keep step. The
/// lock is released by the OS on termination, so a killed run cannot leave a stale lock.
pub(crate) fn sweep_keep_dirs(dir: &Path) -> Result<()> {
    let _lock = keep_lock(dir)?;
    remove_keep_dirs(dir)
}

fn remove_keep_dirs(dir: &Path) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if !entry.file_name().to_string_lossy().starts_with("keep-") {
            continue;
        }
        if entry.file_type()?.is_dir() {
            std::fs::remove_dir_all(entry.path())?;
        } else {
            std::fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

/// The temporary plaintext copy is removed after success and after every returned error.
async fn with_keep_dir<T, F, Fut>(dir: &Path, work: F) -> Result<T>
where
    F: FnOnce(std::path::PathBuf) -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let _lock = keep_lock(dir)?;
    remove_keep_dirs(dir).context("removing interrupted copies of members-only code")?;
    let temp = tempfile::Builder::new().prefix("keep-").tempdir_in(dir)?;
    let result = work(temp.path().to_path_buf()).await;
    after_cleanup(result, temp.close())
}

fn after_cleanup<T>(result: Result<T>, cleanup: std::io::Result<()>) -> Result<T> {
    match (result, cleanup) {
        (Err(keep), Err(cleanup)) => Err(keep).with_context(|| {
            format!("also failed to remove the temporary copy of members-only code: {cleanup}")
        }),
        (Ok(_), Err(cleanup)) => {
            Err(cleanup).context("removing the temporary copy of members-only code")
        }
        (result, Ok(())) => result,
    }
}

pub(crate) struct KeepReport {
    pub plan: Option<Vec<KeepPlan>>,
    pub error: Option<String>,
    pub not_kept: usize,
}

/// A global keep failure leaves the run unfinished. Individual branch failures are reported
/// without stranding the conversion or its on-disk copy.
pub(crate) fn report(ctx: &Ctx, label: &str, result: Result<Vec<KeepPlan>>) -> KeepReport {
    match result {
        Ok(plan) => {
            if !ctx.json {
                for row in &plan {
                    let name = safe(short_ref(&row.name));
                    match &row.keep {
                        Keep::Push { target } if target == &row.name => {
                            println!("Kept for members: {name}.");
                        }
                        Keep::Push { target } => println!(
                            "Kept for members: {name}'s changes from the conversion, as {}.",
                            safe(short_ref(target))
                        ),
                        Keep::Tag => println!(
                            "Not kept: tag {name}. Tags follow the audience of their commits."
                        ),
                        Keep::NotKept { reason } => println!("Not kept: {name} ({})", safe(reason)),
                        Keep::Kept { .. } | Keep::Public => {}
                    }
                }
            }
            let not_kept = plan
                .iter()
                .filter(|p| matches!(p.keep, Keep::NotKept { .. }))
                .count();
            KeepReport {
                plan: Some(plan),
                error: None,
                not_kept,
            }
        }
        Err(e) => {
            let error = format!("{e:#}");
            eprintln!("Could not keep branches for members: {}", safe(&error));
            eprintln!("Not kept yet: run dg repo make-public {label} --resume");
            KeepReport {
                plan: None,
                error: Some(error),
                not_kept: 0,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_pre_marker_conversion_without_a_boundary_finishes_without_reads() {
        let plan = with_boundary(None, |_| async {
            panic!("no private ref or pack reads without a boundary")
        })
        .await
        .unwrap();
        assert!(plan.is_empty());
    }

    #[tokio::test]
    async fn an_interrupted_plaintext_clone_is_swept_before_the_next_keep() {
        let parent = tempfile::tempdir().unwrap();
        let stale = parent.path().join("keep-killed");
        std::fs::create_dir(&stale).unwrap();
        std::fs::write(stale.join("withheld.txt"), "private code").unwrap();
        let preserved = parent.path().join("work.git");
        std::fs::create_dir(&preserved).unwrap();
        with_keep_dir(parent.path(), |path| {
            assert!(!stale.exists());
            async move {
                std::fs::write(path.join("withheld.txt"), "private code")?;
                Ok(())
            }
        })
        .await
        .unwrap();
        assert!(preserved.exists());
        // The finished-conversion cleanup uses the same sweep, including after a no-op plan.
        std::fs::create_dir(&stale).unwrap();
        sweep_keep_dirs(parent.path()).unwrap();
        assert!(!stale.exists());
    }

    #[tokio::test]
    async fn sweeping_does_not_delete_another_running_keep() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path();
        with_keep_dir(root, |path| async move {
            std::fs::write(path.join("withheld.txt"), "private code")?;
            assert!(sweep_keep_dirs(root).is_err());
            assert!(path.join("withheld.txt").exists());
            Ok(())
        })
        .await
        .unwrap();
    }

    #[test]
    fn keep_errors_retain_the_cause_and_branch_failures_allow_completion() {
        let ctx = Ctx::scripted(true, true, false, None);
        let failure = report(
            &ctx,
            "owner/repo",
            Err(anyhow::anyhow!("storage unavailable").context("keeping branches")),
        );
        assert!(failure.plan.is_none());
        assert_eq!(
            failure.error.as_deref(),
            Some("keeping branches: storage unavailable")
        );
        let partial = report(
            &ctx,
            "owner/repo",
            Ok(vec![KeepPlan {
                name: "refs/heads/topic".into(),
                tip: "a".into(),
                keep: Keep::NotKept {
                    reason: "code to keep for members could not be read".into(),
                },
            }]),
        );
        assert!(partial.plan.is_some());
        assert!(partial.error.is_none());
        assert_eq!(partial.not_kept, 1);
        let json = serde_json::json!({"keptForMembers": partial.plan, "keptForMembersError": partial.error, "notKeptForMembers": partial.not_kept});
        assert_eq!(json["keptForMembers"][0]["name"], "refs/heads/topic");
        assert_eq!(json["keptForMembers"][0]["keep"]["status"], "notKept");
    }

    #[test]
    fn one_unreadable_or_unrepresentable_branch_does_not_block_other_branches() {
        let dir = tempfile::tempdir().unwrap();
        git::git(dir.path(), &["init", "--bare", "-q"], &[]).unwrap();
        let tree = git::git(dir.path(), &["mktree"], &[]).unwrap();
        let commit = dir.path().join("commit.txt");
        std::fs::write(&commit, format!("tree {tree}\nauthor Fixture <fixture@example.test> 0 +0000\ncommitter Fixture <fixture@example.test> 0 +0000\n\nfixture\n")).unwrap();
        let tip = git::git(
            dir.path(),
            &[
                "hash-object",
                "-t",
                "commit",
                "-w",
                commit.to_str().unwrap(),
            ],
            &[],
        )
        .unwrap();
        let mut plan: Vec<_> = [
            ("good", tip.clone(), "refs/heads/good".to_string()),
            ("unreadable", "f".repeat(40), "refs/heads/unreadable".into()),
            (
                "too-long",
                tip.clone(),
                format!("refs/heads/{}", "x".repeat(256)),
            ),
            ("invalid", tip.clone(), "refs/heads/invalid..name".into()),
        ]
        .into_iter()
        .map(|(name, tip, target)| KeepPlan {
            name: format!("refs/heads/{name}"),
            tip,
            keep: Keep::Push { target },
        })
        .collect();
        let (specs, credits) = prepare_push(dir.path(), &mut plan);
        assert_eq!(specs, vec![format!("{tip}:refs/heads/good")]);
        assert!(credits > 0);
        assert!(matches!(plan[0].keep, Keep::Push { .. }));
        assert!(plan[1..]
            .iter()
            .all(|p| matches!(p.keep, Keep::NotKept { .. })));
        let report = report(
            &Ctx::scripted(true, true, false, None),
            "owner/repo",
            Ok(plan),
        );
        assert!(report.plan.is_some());
        assert_eq!(report.not_kept, 3);
    }

    #[test]
    fn a_partially_rejected_keep_push_finishes_with_per_branch_results() {
        let dir = tempfile::tempdir().unwrap();
        let remote = tempfile::tempdir().unwrap();
        for repo in [dir.path(), remote.path()] {
            git::git(repo, &["init", "--bare", "-q"], &[]).unwrap();
        }
        let tree = git::git(dir.path(), &["mktree"], &[]).unwrap();
        let commit = dir.path().join("commit.txt");
        let mut tips = Vec::new();
        for message in ["withheld", "diverged"] {
            std::fs::write(&commit, format!("tree {tree}\nauthor Fixture <fixture@example.test> 0 +0000\ncommitter Fixture <fixture@example.test> 0 +0000\n\n{message}\n")).unwrap();
            tips.push(
                git::git(
                    dir.path(),
                    &[
                        "hash-object",
                        "-t",
                        "commit",
                        "-w",
                        commit.to_str().unwrap(),
                    ],
                    &[],
                )
                .unwrap(),
            );
        }
        let tip = &tips[0];
        let remote_path = remote.path().to_str().unwrap();
        git::git(
            dir.path(),
            &[
                "push",
                remote_path,
                &format!("{}:refs/heads/rejected", tips[1]),
            ],
            &[],
        )
        .unwrap();
        let mut plan: Vec<_> = ["good-one", "rejected", "good-two"]
            .into_iter()
            .map(|name| KeepPlan {
                name: format!("refs/heads/{name}"),
                tip: tip.clone(),
                keep: Keep::Push {
                    target: format!("refs/heads/{name}"),
                },
            })
            .collect();
        let (specs, _) = prepare_push(dir.path(), &mut plan);
        let args: Vec<_> = ["push", remote_path]
            .into_iter()
            .chain(specs.iter().map(String::as_str))
            .collect();
        let pushed = git::git(dir.path(), &args, &[]).map(|_| ());
        assert!(pushed.is_err(), "one non-fast-forward ref must be rejected");
        let confirmed = git::git(
            remote.path(),
            &["for-each-ref", "--format=%(refname) %(objectname)"],
            &[],
        )
        .unwrap()
        .lines()
        .map(|line| {
            let (name, tip) = line.split_once(' ').unwrap();
            (name.to_owned(), tip.to_owned())
        })
        .collect();
        let plan = confirm_keep_push(dir.path(), plan, pushed, &confirmed).unwrap();
        assert!(matches!(plan[0].keep, Keep::Push { .. }));
        assert!(matches!(&plan[1].keep, Keep::NotKept { reason } if !reason.is_empty()));
        assert!(matches!(plan[2].keep, Keep::Push { .. }));
        let report = report(
            &Ctx::scripted(true, true, false, None),
            "owner/repo",
            Ok(plan),
        );
        assert!(report.plan.is_some(), "partial failure permits completion");
        assert!(report.error.is_none());
        assert_eq!(report.not_kept, 1);
    }

    #[test]
    fn already_kept_rows_do_not_hide_a_totally_failed_keep_push() {
        let plan = vec![
            KeepPlan {
                name: "refs/heads/already".into(),
                tip: "a".into(),
                keep: Keep::Kept {
                    as_: "refs/heads/already".into(),
                },
            },
            KeepPlan {
                name: "refs/heads/rejected".into(),
                tip: "b".into(),
                keep: Keep::Push {
                    target: "refs/heads/rejected".into(),
                },
            },
        ];
        let error = confirm_keep_push(
            Path::new("."),
            plan,
            Err(anyhow::anyhow!("push rejected").context("keeping branches for members")),
            &BTreeMap::from([("refs/heads/already".into(), "a".into())]),
        )
        .unwrap_err();
        assert_eq!(
            format!("{error:#}"),
            "keeping branches for members: push rejected"
        );
    }

    #[test]
    fn keep_only_spending_needs_consent_and_preserves_the_refuse_cap() {
        let dir = tempfile::tempdir().unwrap();
        git::git(dir.path(), &["init", "-q"], &[]).unwrap();
        let ctx = Ctx::scripted(false, true, false, None);
        assert!(confirm_keep(&ctx, dir.path(), true).is_err());
        assert!(confirm_keep(&ctx, dir.path(), false).unwrap());
        assert!(confirm_keep(&Ctx::scripted(true, true, false, None), dir.path(), true).unwrap());
        git::git(dir.path(), &["config", "dash.confirm", "never"], &[]).unwrap();
        assert!(confirm_keep(&ctx, dir.path(), true).unwrap());
        git::git(dir.path(), &["config", "dash.confirm", "refuse"], &[]).unwrap();
        git::git(
            dir.path(),
            &["config", "dash.costWarnThreshold", "0.00001"],
            &[],
        )
        .unwrap();
        let clone = tempfile::tempdir().unwrap();
        git::git(clone.path(), &["init", "-q"], &[]).unwrap();
        inherit_cost_consent(dir.path(), clone.path()).unwrap();
        assert_eq!(
            git::config_get(clone.path(), "dash.confirm").as_deref(),
            Some("refuse")
        );
        assert_eq!(
            git::config_get(clone.path(), "dash.costWarnThreshold").as_deref(),
            Some("0.00001")
        );
        let confirmed = confirm_keep(&ctx, clone.path(), true).unwrap();
        assert!(!confirmed);
        assert!(!keep_push_args(&["a:refs/heads/good".into()], confirmed)
            .contains(&"dash.confirm=never".into()));
        let yes = Ctx::scripted(true, true, false, None);
        assert!(!confirm_keep(&yes, clone.path(), true).unwrap());
        assert!(!keep_push_args(
            &["a:refs/heads/good".into()],
            confirm_keep(&yes, clone.path(), true).unwrap()
        )
        .contains(&"dash.confirm=never".into()));
        for mode in ["always", "true", "yes"] {
            git::git(dir.path(), &["config", "dash.confirm", mode], &[]).unwrap();
            for needed in [false, true] {
                for ctx in [&ctx, &yes] {
                    let confirmed = confirm_keep(ctx, dir.path(), needed).unwrap();
                    assert!(!confirmed, "the helper must retain the always prompt");
                    assert!(!keep_push_args(&["a:refs/heads/good".into()], confirmed)
                        .contains(&"dash.confirm=never".into()));
                }
            }
        }
    }

    #[test]
    fn exact_already_kept_or_public_tips_need_no_clone_or_packs() {
        let all = BTreeMap::from([("refs/heads/late".into(), "a".into())]);
        for public in [true, false] {
            let empty = BTreeMap::new();
            let plan = plan_keep(
                &all,
                &empty,
                if public { &all } else { &empty },
                if public { &empty } else { &all },
                "refs/heads/main",
                |a, b| a == b,
                &BTreeSet::new(),
            );
            assert!(!has_pushes(&plan));
        }
    }

    #[tokio::test]
    async fn temporary_withheld_plaintext_is_removed_after_success_and_failure() {
        let parent = tempfile::tempdir().unwrap();
        for fail in [false, true] {
            let result = with_keep_dir(parent.path(), |path| async move {
                std::fs::write(path.join("withheld.txt"), "private code")?;
                anyhow::ensure!(!fail, "push failed");
                Ok(())
            })
            .await;
            assert_eq!(result.is_err(), fail);
            assert_eq!(
                std::fs::read_dir(parent.path())
                    .unwrap()
                    .filter(|e| e.as_ref().unwrap().file_name() != ".keep.lock")
                    .count(),
                0
            );
        }
    }

    #[test]
    fn cleanup_failure_retains_the_original_keep_error_and_its_cause() {
        let keep = anyhow::anyhow!("storage unavailable").context("keeping branches for members");
        let error = after_cleanup::<()>(Err(keep), Err(std::io::Error::other("directory is busy")))
            .unwrap_err();
        let message = format!("{error:#}");
        assert!(message.contains("keeping branches for members: storage unavailable"));
        assert!(message.contains(
            "also failed to remove the temporary copy of members-only code: directory is busy"
        ));
        assert_eq!(error.root_cause().to_string(), "storage unavailable");
        assert!(after_cleanup(Ok(()), Err(std::io::Error::other("directory is busy"))).is_err());
        assert!(after_cleanup::<()>(Err(anyhow::anyhow!("push failed")), Ok(())).is_err());
        assert!(after_cleanup(Ok(()), Ok(())).is_ok());
    }

    #[test]
    fn a_failed_keep_does_not_finish_and_a_successful_retry_does() {
        let ctx = Ctx::scripted(true, true, false, None);
        assert!(
            report(&ctx, "owner/repo", Err(anyhow::anyhow!("push failed")))
                .plan
                .is_none()
        );
        assert!(report(&ctx, "owner/repo", Ok(Vec::new())).plan.is_some());
    }

    #[test]
    fn alias_parent_conflicts_are_reported_instead_of_pushed() {
        let all = BTreeMap::from([("refs/heads/topic".into(), "b".into())]);
        let below = BTreeMap::from([("refs/heads/topic".into(), "a".into())]);
        let members = BTreeMap::from([("refs/heads/members".into(), "z".into())]);
        let plan = plan_keep(
            &all,
            &below,
            &below,
            &members,
            "refs/heads/main",
            |a, b| a == b,
            &BTreeSet::new(),
        );
        assert!(
            matches!(&plan[0].keep, Keep::NotKept { reason } if reason.contains("blocked by branch members"))
        );
    }

    #[test]
    fn shared_keep_plans() {
        let cases: serde_json::Value = serde_json::from_str(include_str!(
            "../../../forge-contracts/vectors/keep_for_members/plans.json"
        ))
        .unwrap();
        for v in cases.as_array().unwrap() {
            let refs = |key: &str| -> Refs { serde_json::from_value(v[key].clone()).unwrap() };
            let plan = plan_keep(
                &refs("allEra"),
                &refs("below"),
                &refs("public"),
                &refs("members"),
                v["defaultRef"].as_str().unwrap(),
                |a, b| {
                    a == b
                        || v["ancestors"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|p| p[0] == a && p[1] == b)
                },
                &serde_json::from_value(v["reserved"].clone()).unwrap(),
            );
            assert_eq!(serde_json::json!(plan), v["expected"], "{}", v["name"]);
        }
    }
}
