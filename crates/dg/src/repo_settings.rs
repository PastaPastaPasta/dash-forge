//! `dg repo edit / protect / policy / archive / unarchive` — a repository's settings after
//! creation (QA D-503: until now nothing but the fixture seeder wrote `config` after a repo
//! was created).
//!
//! - The default branch, the protected patterns and the archived flag live in forge-core's
//!   append-only `config` (maintainers only at consensus; newest wins). Each change appends a
//!   new config carrying every other field over. A private repository's config is sealed:
//!   `RepoService::update_config` re-seals it under the current write epoch.
//! - The description and topics live on the `repo` document, which only its owner can edit
//!   (a document replace; `name`, `visibility` and `forkOf` are immutable).
//! - The branch policy is forge-community's `policy` (maintainers only, newest wins). It is a
//!   client rule: every Forge client applies it to its merge controls, a maintainer can
//!   override it, and nothing at consensus requires approvals.
//! - Protection itself is consensus-backed: a ref matching a protected pattern is updated
//!   through `protectedRefUpdate`, which only a maintainer can write, and a plain `refUpdate`
//!   naming it is inert for every reader (`forge-v2.md` §5).
//!
//! Every write shows its estimate and asks first; a change that already holds signs nothing.

use anyhow::Result;
use serde_json::{json, Value};

use forge_core::repo::{check_patterns, ConfigChange, CurrentConfig, RepoEdit, RepoService};
use forge_core::rules::review::Policy;
use forge_core::rules::v2::Role;
use forge_core::user_error::{codes, UserError};

use crate::common::{Reader, Session};
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, dash_usd_price, safe};
use crate::{RepoEditArgs, RepoPolicyCommand, RepoPolicySetArgs, RepoProtectCommand};

/// Estimate of one `config` write, in credits: the measured base of a config document plus
/// the storage of its text (forge-web `BASE_CREDITS.config` + `CREDITS_PER_TEXT_BYTE`).
const CONFIG_BASE_CREDITS: u64 = 34_000_000;
/// Estimate of one `policy` write (measured on moutai, 2026-09-27: 33.9M).
const POLICY_CREDITS: u64 = 34_000_000;
/// Estimate of a document replace: the fixed part plus every changed byte (forge-web
/// `previewReplace`, measured on moutai 2026-09-27).
const REPLACE_BASE_CREDITS: u64 = 17_000_000;
/// The marginal credits of one stored text byte (storage plus the processing it adds).
const CREDITS_PER_TEXT_BYTE: u64 = 27_500;

/// The estimate of appending `config` (its text is what grows the document).
fn config_estimate(c: &CurrentConfig) -> u64 {
    let text: usize = c.default_branch.len()
        + c.protected_patterns.iter().map(String::len).sum::<usize>()
        + c.backend_uris.iter().map(String::len).sum::<usize>();
    CONFIG_BASE_CREDITS + CREDITS_PER_TEXT_BYTE * text as u64
}

/// `main` → `refs/heads/main`; a pattern already naming `refs/…` is kept as it is. What
/// consensus routing matches is the full ref name, so a bare branch would protect nothing.
fn full_pattern(p: &str) -> String {
    if p.starts_with("refs/") {
        p.to_string()
    } else {
        format!("refs/heads/{p}")
    }
}

// ---------------------------------------------------------------------------------------
// dg repo edit
// ---------------------------------------------------------------------------------------

/// `dg repo edit`: default branch (a config write), description and topics (a repo replace).
pub async fn edit(ctx: &Ctx, args: &RepoEditArgs) -> Result<()> {
    if args.default_branch.is_none() && args.description.is_none() && args.topics.is_none() {
        return Err(crate::errors::usage(
            "nothing to change: pass --default-branch, --description and/or --topics",
        ));
    }
    let repo_edit = RepoEdit {
        description: args.description.clone(),
        topics: args.topics.as_deref().map(parse_topics),
    };
    repo_edit.validate()?;
    let change = ConfigChange {
        default_branch: args.default_branch.clone(),
        ..ConfigChange::default()
    };
    change.validate()?;

    let s = Session::open(ctx, &args.repo).await?;
    let svc = RepoService::new(&s.client, &s.identity, &s.bridge);
    let price = dash_usd_price();
    let is_owner = s.repo.owner_id() == s.identity.id();
    let doc_changes = repo_edit.description.is_some() || repo_edit.topics.is_some();
    if doc_changes && !is_owner {
        return Err(owner_only(&s.repo.display()));
    }
    let current = if change.default_branch.is_some() {
        s.collab()
            .require_role(&s.repo, Role::Maintainer, "change the default branch")
            .await?;
        Some(svc.current_config(&s.repo).await?)
    } else {
        None
    };
    let next = current.as_ref().map(|c| c.apply(&change));
    let config_changes = matches!((&current, &next), (Some(c), Some(n)) if c != n);

    let estimate = edit_plan(
        ctx,
        &s.repo.display(),
        current
            .as_ref()
            .zip(next.as_ref())
            .filter(|_| config_changes),
        &repo_edit,
        price,
    );
    if estimate > 0 {
        ctx.confirm_or_cancel(&format!("Edit {}?", s.repo.display()))?;
    }
    // Measured per write: a balance read right after two writes can show only the first.
    let mut spent = 0;
    let mut config_id = None;
    if config_changes {
        let before = s.balance().await;
        config_id = svc.update_config(&s.repo, &change).await?;
        if config_id.is_some() {
            spent += s.spent_since(before).await;
        }
    }
    let mut edited = false;
    if doc_changes {
        let before = s.balance().await;
        edited = svc.edit_repo(&s.repo, &repo_edit).await?;
        // The `topic` documents Explore counts follow the list (also repairs a lagging set).
        if let Some(t) = &repo_edit.topics {
            edited |= s.collab().reconcile_topic_docs(&s.repo, t).await?;
        }
        if edited {
            spent += s.spent_since(before).await;
        }
    }
    let default_branch = next.as_ref().map(|n| n.default_branch.clone());
    ctx.emit(
        json!({
            "status": if config_id.is_some() || edited { "edited" } else { "unchanged" },
            "repo": s.repo.display(),
            "defaultBranch": default_branch,
            "description": repo_edit.description,
            "topics": repo_edit.topics,
            "configDocumentId": config_id,
            "repoEdited": edited,
            "cost": cost_json(spent, price),
        }),
        || {
            if config_id.is_none() && !edited {
                println!("✓ nothing to change; nothing was written");
                return;
            }
            if let (Some(id), Some(n)) = (&config_id, &next) {
                println!(
                    "✓ default branch is now {} (config {id})",
                    safe(&n.default_branch)
                );
            }
            if edited {
                println!("✓ repo document updated");
            }
            println!("  cost: {}", cost_line(spent, price));
        },
    );
    Ok(())
}

/// Print what `dg repo edit` will write (human mode) and return its estimate in credits:
/// the config append when the default branch changes, the repo replace when its text does.
fn edit_plan(
    ctx: &Ctx,
    repo: &str,
    branch: Option<(&CurrentConfig, &CurrentConfig)>,
    edit: &RepoEdit,
    price: f64,
) -> u64 {
    let text_bytes = edit.description.as_deref().map_or(0, str::len)
        + edit
            .topics
            .as_ref()
            .map_or(0, |t| t.iter().map(String::len).sum());
    let mut estimate = branch.map_or(0, |(_, n)| config_estimate(n));
    if edit.description.is_some() || edit.topics.is_some() {
        estimate += REPLACE_BASE_CREDITS + CREDITS_PER_TEXT_BYTE * text_bytes as u64;
    }
    if !ctx.json {
        println!("Editing {repo} on {}", ctx.network_label());
        if let Some((c, n)) = branch {
            println!(
                "  default branch: {} → {}",
                safe(&c.default_branch),
                safe(&n.default_branch)
            );
        }
        if let Some(d) = &edit.description {
            println!("  description:    {:?}", safe(d));
        }
        if let Some(t) = &edit.topics {
            println!("  topics:         {}", t.join(", "));
        }
        println!("  cost:           {}", cost_line(estimate, price));
    }
    estimate
}

/// `a, b,c` → `["a", "b", "c"]`; `""` → `[]`.
fn parse_topics(s: &str) -> Vec<String> {
    s.split(',')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

/// E601 before anything is signed: only the owner can replace the `repo` document.
fn owner_only(repo: &str) -> anyhow::Error {
    crate::errors::reported(
        UserError::new(
            codes::NOT_A_WRITER,
            "repository not edited: only its owner can change the description and topics",
        )
        .cause(format!(
            "the description and topics live on {repo}'s repo document, which only its owner may edit"
        ))
        .fix("ask the owner to run `dg repo edit` (maintainers can change the default branch)")
        .note("checked before anything was signed; nothing was written or paid"),
        json!({ "status": "refused", "repo": repo }),
    )
}

// ---------------------------------------------------------------------------------------
// dg repo protect
// ---------------------------------------------------------------------------------------

/// `dg repo protect list | add | remove`.
pub async fn protect(ctx: &Ctx, cmd: &RepoProtectCommand) -> Result<()> {
    match cmd {
        RepoProtectCommand::List { repo } => {
            let s = Reader::open(ctx, repo).await?;
            let cfg = s.service().current_config(&s.repo).await?;
            ctx.emit(
                json!({
                    "repo": s.repo.display(),
                    "protectedPatterns": cfg.protected_patterns,
                    "defaultBranch": cfg.default_branch,
                }),
                || {
                    if cfg.protected_patterns.is_empty() {
                        println!("no protected patterns: every member can update every ref");
                    }
                    for p in &cfg.protected_patterns {
                        println!("{}", safe(p));
                    }
                },
            );
            Ok(())
        }
        RepoProtectCommand::Add { repo, pattern } => {
            change_protection(ctx, repo, &full_pattern(pattern), true).await
        }
        RepoProtectCommand::Remove { repo, pattern } => {
            change_protection(ctx, repo, pattern, false).await
        }
    }
}

async fn change_protection(ctx: &Ctx, repo: &str, pattern: &str, add: bool) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    let verb = if add { "protect" } else { "unprotect" };
    s.collab()
        .require_role(&s.repo, Role::Maintainer, &format!("{verb} branches"))
        .await?;
    let svc = RepoService::new(&s.client, &s.identity, &s.bridge);
    let current = svc.current_config(&s.repo).await?;
    let mut patterns = current.protected_patterns.clone();
    if add {
        if !patterns.iter().any(|p| p == pattern) {
            patterns.push(pattern.to_string());
        }
    } else {
        // `remove main` finds `refs/heads/main` too.
        let full = full_pattern(pattern);
        let before = patterns.len();
        patterns.retain(|p| p != pattern && *p != full);
        if patterns.len() == before {
            return Err(crate::errors::usage(format!(
                "{pattern:?} is not a protected pattern of {} (see `dg repo protect list {repo}`)",
                s.repo.display()
            )));
        }
    }
    check_patterns(&patterns)?;
    let change = ConfigChange {
        protected_patterns: Some(patterns),
        ..ConfigChange::default()
    };
    let next = current.apply(&change);
    let price = dash_usd_price();
    let estimate = if next == current {
        0
    } else {
        config_estimate(&next)
    };
    if !ctx.json {
        println!(
            "{} {} in {} on {}",
            if add { "Protecting" } else { "Unprotecting" },
            safe(pattern),
            s.repo.display(),
            ctx.network_label()
        );
        println!(
            "  patterns: {}",
            if next.protected_patterns.is_empty() {
                "(none)".to_string()
            } else {
                next.protected_patterns.join(", ")
            }
        );
        println!("  cost:     {}", cost_line(estimate, price));
    }
    if estimate > 0 {
        ctx.confirm_or_cancel(&format!(
            "Write a new config for {}? (maintainers only)",
            s.repo.display()
        ))?;
    }
    let before = s.balance().await;
    let id = svc.update_config(&s.repo, &change).await?;
    let spent = if id.is_some() {
        s.spent_since(before).await
    } else {
        0
    };
    ctx.emit(
        json!({
            "status": match (&id, add) {
                (None, _) => "unchanged",
                (Some(_), true) => "protected",
                (Some(_), false) => "unprotected",
            },
            "repo": s.repo.display(),
            "pattern": pattern,
            "protectedPatterns": next.protected_patterns,
            "configDocumentId": id,
            "cost": cost_json(spent, price),
        }),
        || match &id {
            None => println!("✓ nothing to change; nothing was written"),
            Some(id) => {
                println!("✓ {verb}ed {} (config {id})", safe(pattern));
                if add {
                    println!(
                        "  only maintainers can update matching refs now; a writer's push is refused"
                    );
                }
                println!("  cost: {}", cost_line(spent, price));
            }
        },
    );
    Ok(())
}

// ---------------------------------------------------------------------------------------
// dg repo policy
// ---------------------------------------------------------------------------------------

/// Merge-method bits (review-parity spec §3.6): 1 ff, 2 merge commit, 4 squash, 8 rebase.
const METHODS: [(&str, u8); 4] = [("ff", 1), ("merge", 2), ("squash", 4), ("rebase", 8)];

/// `ff,squash` → 5; `any` or `""` → 0.
fn parse_methods(s: &str) -> Result<u8> {
    let mut mask = 0;
    for part in s.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        if part == "any" {
            return Ok(0);
        }
        let Some((_, bit)) = METHODS.iter().find(|(n, _)| *n == part) else {
            return Err(crate::errors::usage(format!(
                "unknown merge method {part:?}: use ff, merge, squash, rebase or any"
            )));
        };
        mask |= bit;
    }
    Ok(mask)
}

/// 5 → `["ff", "squash"]`; 0 → `["any"]`.
fn method_names(mask: u8) -> Vec<&'static str> {
    if mask == 0 {
        return vec!["any"];
    }
    METHODS
        .iter()
        .filter(|(_, b)| mask & b != 0)
        .map(|(n, _)| *n)
        .collect()
}

fn policy_json(p: &Policy) -> Value {
    json!({
        "requiredApprovals": p.required_approvals,
        "maintainersOnly": p.approver_role == 1,
        "requireChecks": p.require_checks,
        "mergeMethods": method_names(p.merge_methods),
        "requiredChecks": p.required_checks,
        "requiredCheckSources": p.required_check_sources,
    })
}

/// The policy line every surface prints next to it.
const POLICY_NOTE: &str = "a client rule: Forge clients apply it to their merge controls and a maintainer can override it; nothing at consensus requires approvals";

/// `dg repo policy show | set`.
pub async fn policy(ctx: &Ctx, cmd: &RepoPolicyCommand) -> Result<()> {
    match cmd {
        RepoPolicyCommand::Show { repo } => {
            let s = Reader::open(ctx, repo).await?;
            let p = s.collab().policy(&s.repo).await?;
            ctx.emit(
                json!({
                    "repo": s.repo.display(),
                    "policy": p.as_ref().map(policy_json),
                    "note": POLICY_NOTE,
                }),
                || match &p {
                    None => println!("no branch policy: merges need no approvals"),
                    Some(p) => {
                        println!(
                            "required approvals: {}{}",
                            p.required_approvals,
                            if p.approver_role == 1 {
                                " (maintainers only)"
                            } else {
                                " (any member)"
                            }
                        );
                        println!("require checks:     {}", p.require_checks);
                        println!(
                            "merge methods:      {}",
                            method_names(p.merge_methods).join(", ")
                        );
                        for (i, name) in p.required_checks.iter().enumerate() {
                            let from = p
                                .required_check_sources
                                .get(i)
                                .map_or(String::new(), |s| format!(" (runs by {s} only)"));
                            println!("required check:     {}{from}", crate::fmt::safe(name));
                        }
                        println!("note: {POLICY_NOTE}");
                    }
                },
            );
            Ok(())
        }
        RepoPolicyCommand::Set(args) => set_policy(ctx, args).await,
    }
}

/// Refuse, before signing, a policy whose check sources are no longer a runner or maintainer of
/// the repo: forge-community admits each source only while one of those documents exists
/// (`requiredCheckSources` `refersTo`), so the write would be refused on chain.
async fn refuse_stale_sources(
    s: &Session,
    collab: &forge_core::collab::v2::Collab<'_>,
    policy: &Policy,
) -> Result<()> {
    if policy.required_check_sources.is_empty() {
        return Ok(());
    }
    let oracle = collab.member_oracle(&s.repo).await?;
    let runners: std::collections::BTreeSet<String> = forge_core::ci::RunnerReader::new(&s.client)
        .list(&s.repo)
        .await?
        .into_iter()
        .map(|r| r.identity_id)
        .collect();
    let stale: Vec<&str> = policy
        .required_check_sources
        .iter()
        .filter(|id| oracle.current_role(id) != Some(Role::Maintainer) && !runners.contains(*id))
        .map(String::as_str)
        .collect();
    if stale.is_empty() {
        return Ok(());
    }
    Err(UserError::new(
        codes::REJECTED,
        format!(
            "the policy's required checks are pinned to {}, no longer a runner or maintainer of {}",
            stale.join(", "),
            s.repo.display()
        ),
    )
    .cause("forge-community accepts a check source only while it is a runner or maintainer of the repository")
    .fix("re-enrol it (`dg ci runner add`), or pass --clear-required-checks to drop the required checks and their sources")
    .note("checked before anything was signed; nothing was written or paid")
    .into())
}

async fn set_policy(ctx: &Ctx, args: &RepoPolicySetArgs) -> Result<()> {
    let methods = args
        .merge_methods
        .as_deref()
        .map(parse_methods)
        .transpose()?;
    if args.required_approvals.is_some_and(|n| n > 10) {
        return Err(crate::errors::usage("--required-approvals takes 0-10"));
    }
    let s = Session::open(ctx, &args.repo).await?;
    let collab = s.collab();
    collab
        .require_role(&s.repo, Role::Maintainer, "set the branch policy")
        .await?;
    let current = collab.policy(&s.repo).await?;
    // What this command does not set (the required checks and their sources) is carried
    // forward: a policy is append-only and the newest wins. `--clear-required-checks` drops
    // them.
    let mut base = current.clone().unwrap_or_default();
    if args.clear_required_checks {
        base.required_checks.clear();
        base.required_check_sources.clear();
    }
    let next = Policy {
        required_approvals: args.required_approvals.unwrap_or(base.required_approvals),
        approver_role: args.maintainers_only.map_or(base.approver_role, u8::from),
        require_checks: args.require_checks.unwrap_or(base.require_checks),
        merge_methods: methods.unwrap_or(base.merge_methods),
        ..base
    };
    refuse_stale_sources(&s, &collab, &next).await?;
    let price = dash_usd_price();
    if current.as_ref() == Some(&next) {
        ctx.emit(
            json!({ "status": "unchanged", "repo": s.repo.display(), "policy": policy_json(&next), "note": POLICY_NOTE }),
            || println!("✓ the policy already says that; nothing was written"),
        );
        return Ok(());
    }
    if !ctx.json {
        println!("Setting the branch policy of {}", s.repo.display());
        println!(
            "  {}",
            serde_json::to_string(&policy_json(&next)).unwrap_or_default()
        );
        println!("  note: {POLICY_NOTE}");
        println!("  cost: {}", cost_line(POLICY_CREDITS, price));
    }
    ctx.confirm_or_cancel(&format!(
        "Write a policy for {}? (maintainers only)",
        s.repo.display()
    ))?;
    let before = s.balance().await;
    let id = collab.set_policy(&s.repo, &next).await?;
    let spent = s.spent_since(before).await;
    ctx.emit(
        json!({
            "status": "set",
            "repo": s.repo.display(),
            "policy": policy_json(&next),
            "documentId": id,
            "id": id,
            "note": POLICY_NOTE,
            "cost": cost_json(spent, price),
        }),
        || {
            println!("✓ branch policy set (policy {id})");
            println!("  cost: {}", cost_line(spent, price));
        },
    );
    Ok(())
}

// ---------------------------------------------------------------------------------------
// dg repo archive / unarchive
// ---------------------------------------------------------------------------------------

/// `dg repo archive` / `dg repo unarchive`: the config's `archived` flag.
pub async fn archive(ctx: &Ctx, repo: &str, on: bool) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    let verb = if on { "archive" } else { "unarchive" };
    s.collab()
        .require_role(&s.repo, Role::Maintainer, &format!("{verb} the repository"))
        .await?;
    let svc = RepoService::new(&s.client, &s.identity, &s.bridge);
    let current = svc.current_config(&s.repo).await?;
    let change = ConfigChange {
        archived: Some(on),
        ..ConfigChange::default()
    };
    let next = current.apply(&change);
    let price = dash_usd_price();
    if next == current {
        ctx.emit(
            json!({ "status": "unchanged", "repo": s.repo.display(), "archived": on }),
            || {
                println!(
                    "✓ {} is already {verb}d; nothing was written",
                    s.repo.display()
                );
            },
        );
        return Ok(());
    }
    let estimate = config_estimate(&next);
    if !ctx.json {
        println!(
            "{} {} on {}",
            if on { "Archiving" } else { "Unarchiving" },
            s.repo.display(),
            ctx.network_label()
        );
        if on {
            println!("  Forge clients will refuse pushes, issues and PRs; reads keep working.");
            println!("  A client rule: consensus still admits a member's writes.");
        }
        println!("  cost: {}", cost_line(estimate, price));
    }
    ctx.confirm_or_cancel(&format!("{} {}?", capitalize(verb), s.repo.display()))?;
    let before = s.balance().await;
    let id = svc.update_config(&s.repo, &change).await?;
    let spent = s.spent_since(before).await;
    ctx.emit(
        json!({
            "status": format!("{verb}d"),
            "repo": s.repo.display(),
            "archived": on,
            "configDocumentId": id,
            "cost": cost_json(spent, price),
        }),
        || {
            println!("✓ {verb}d {}", s.repo.display());
            println!("  cost: {}", cost_line(spent, price));
        },
    );
    Ok(())
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    c.next()
        .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{full_pattern, method_names, parse_methods, parse_topics};

    #[test]
    fn bare_branches_become_full_ref_patterns() {
        assert_eq!(full_pattern("main"), "refs/heads/main");
        assert_eq!(full_pattern("release/*"), "refs/heads/release/*");
        assert_eq!(full_pattern("refs/tags/v*"), "refs/tags/v*");
    }

    #[test]
    fn merge_methods_round_trip_through_the_bitmask() {
        assert_eq!(parse_methods("ff,squash").unwrap(), 5);
        assert_eq!(parse_methods("merge, rebase").unwrap(), 10);
        assert_eq!(parse_methods("any").unwrap(), 0);
        assert_eq!(parse_methods("").unwrap(), 0);
        assert!(parse_methods("octopus").is_err());
        assert_eq!(method_names(5), vec!["ff", "squash"]);
        assert_eq!(method_names(0), vec!["any"]);
        assert_eq!(method_names(15), vec!["ff", "merge", "squash", "rebase"]);
    }

    #[test]
    fn topics_split_on_commas_and_empty_clears() {
        assert_eq!(parse_topics("a, b,c"), vec!["a", "b", "c"]);
        assert!(parse_topics("").is_empty());
        assert!(parse_topics(" , ").is_empty());
    }
}
