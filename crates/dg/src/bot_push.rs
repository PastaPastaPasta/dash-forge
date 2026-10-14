//! A bot's push access (phase 4E; mixed-visibility DESIGN §4.9 "Pushing", D42, §10 "Bots and
//! runners"; `docs/security/private-repos.md` §24): `dg bot allow --push`, `renew`, `suspend`,
//! `resume` and `revoke --push`, and what `dg bot list` says about it.
//!
//! A maintainer gives a bot push access with a **push grant** (forge-core `pushGrant`, the
//! mainnet contract only): one public branch prefix, or one members-only branch shared with the
//! bot, for at most 90 days. Consensus holds the bot to it. The bot's access notice lists the
//! grants it was given and the runner's push rules; a newer notice without `push` (any
//! maintainer) suspends every push. Only a grant's writer deletes it, and the owner removes a
//! granter or the bot; a bot removed and added again does not get its push back.

use anyhow::Result;
use serde_json::{json, Value};

use forge_core::collab::v2::{BotPushAccess, GrantRequest, GrantableBranch};
use forge_core::platform::decode_identifier;
use forge_core::private::access_notice::{
    self, date_words, AccessNotice, PushEntry, PushPolicy, PushScope,
};
use forge_core::repo::{GrantScope, RepoService};
use forge_core::rules::push_grant::{
    self, PatternRefusal, PushGrant, Unusable, MAX_TTL_MS, RENEW_WINDOW_MS,
};
use forge_core::user_error::{codes, UserError};

use crate::bot::{handle, parse_until, write_notice, AllowArgs};
use crate::common::{resolve_identity, Session};
use crate::context::Ctx;
use crate::fmt::{cost_line, safe};

const DAY_MS: u64 = 86_400_000;

/// "Bots can't push to this repo yet." (DESIGN §10): the contract has no push grants.
fn not_yet(repo: &str) -> anyhow::Error {
    UserError::new(
        codes::UNSUPPORTED,
        format!("Bots can't push to {repo} yet."),
    )
    .cause("this network's contract has no push access for bots: a bot pushes to its own fork and opens a pull request")
    .note("nothing was written")
    .into()
}

/// Push access is for a Bot member of the repository.
fn not_a_bot(name: &str, repo: &str) -> anyhow::Error {
    UserError::new(
        codes::USAGE,
        format!(
            "{} isn't a bot of {repo}: push access is for bots",
            safe(name)
        ),
    )
    .fix(format!(
        "add it as a bot first: `dg collab add {repo} {} --role bot`",
        safe(name)
    ))
    .note("nothing was written")
    .into()
}

/// When push access asked for at `now` ends: `--push-until`, else 30 days ahead or the access's
/// own end when sooner; never more than 90 days ahead.
fn push_until(explicit: Option<&str>, access_until: Option<u64>, now: u64) -> Result<u64> {
    let requested = match explicit {
        Some(d) => {
            let u = parse_until(d)?;
            // the last ms of the 90th day is a day past the bound: brought in, not refused
            if u > now + MAX_TTL_MS + DAY_MS {
                return Err(crate::errors::usage(format!(
                    "--push-until {d}: push access lasts at most 90 days"
                )));
            }
            Some(u.min(now + MAX_TTL_MS))
        }
        None => access_until.filter(|u| *u < now + push_grant::DEFAULT_TTL_MS),
    };
    push_grant::until_for(now, requested).map_err(|_| {
        crate::errors::usage("push access must end in the future, at most 90 days ahead")
    })
}

/// The grants `patterns` ask for (`""` is the default prefix `bot/<name>/`): a members-only
/// branch shared with the bot when one is named, else a public prefix.
fn requests(
    patterns: &[String],
    bot: &str,
    name: &str,
    branches: &[GrantableBranch],
) -> Result<Vec<GrantRequest>> {
    let mut out: Vec<GrantRequest> = Vec::new();
    for p in patterns {
        let p = p.trim();
        let full = if p.starts_with("refs/") {
            p.to_owned()
        } else {
            format!("{}{p}", push_grant::BRANCHES)
        };
        if let Some(b) = branches.iter().find(|b| b.name == full) {
            let short = forge_core::keyring::short_branch(&b.name).to_owned();
            if !b.audience_now.contains(bot) {
                return Err(UserError::new(
                    codes::USAGE,
                    format!(
                        "{} isn't among the people {} is for, so it can't push to it",
                        safe(name),
                        safe(&short)
                    ),
                )
                .fix(format!(
                    "add it to the branch first: `dg branch audience {} --to <who it is for>,{}`",
                    safe(&short),
                    safe(name)
                ))
                .note("nothing was written")
                .into());
            }
            out.push(GrantRequest {
                scope: GrantScope::Exact(b.current),
                label: short,
            });
            continue;
        }
        let pattern = if p.is_empty() {
            push_grant::default_prefix(name)
        } else {
            p.to_owned()
        };
        let prefix = push_grant::prefix_of(&pattern).map_err(|why| {
            crate::errors::usage(format!(
                "--push {pattern}: {}",
                match why {
                    PatternRefusal::Empty => "name a branch or a branch prefix".to_owned(),
                    PatternRefusal::NotABranch =>
                        "bots push to branches only (refs/heads/…)".into(),
                    PatternRefusal::NotAPrefix =>
                        "only a prefix can be given (`bot/ci-bot/` or `bot/ci-bot/*`)".into(),
                    PatternRefusal::Malformed => "that isn't a branch name".into(),
                }
            ))
        })?;
        out.push(GrantRequest {
            label: push_grant::short_prefix(&prefix).to_owned(),
            scope: GrantScope::Prefix(prefix),
        });
    }
    out.dedup_by(|a, b| a.scope == b.scope);
    Ok(out)
}

/// What the maintainer reads before signing a grant (DESIGN §10, "Push").
fn grant_line(name: &str, r: &GrantRequest, until: u64) -> String {
    let date = date_words(until);
    match &r.scope {
        GrantScope::Exact(_) => format!(
            "{} can push to {}, a branch shared with it, until {date}. It never gets the key to other members-only content.",
            safe(name),
            safe(&r.label)
        ),
        GrantScope::Prefix(p) if p.ends_with('/') => format!(
            "{} will be able to push to branches starting with {} until {date}. It can't push to protected branches. Everything it pushes to a public branch is public.",
            safe(name),
            safe(&r.label)
        ),
        GrantScope::Prefix(_) => format!(
            "{} will be able to push to {} (and any branch whose name starts with {}) until {date}. It can't push to protected branches. Everything it pushes to a public branch is public.",
            safe(name),
            safe(&r.label),
            safe(&r.label)
        ),
    }
}

/// The notice's entry for grant `id` over `scope`.
fn entry(id: &str, scope: &GrantScope) -> Result<PushEntry> {
    Ok(PushEntry {
        grant: decode_identifier(id)?,
        target: match scope {
            GrantScope::Prefix(p) => PushScope::Prefix(p.clone()),
            GrantScope::Exact(h) => PushScope::Members(*h),
        },
    })
}

/// A grant's scope as written.
fn scope_of(g: &PushGrant) -> Option<GrantScope> {
    match (&g.prefix, &g.scope) {
        (Some(p), None) => Some(GrantScope::Prefix(p.clone())),
        (None, Some(h)) => hex::decode(h)
            .ok()
            .and_then(|b| b.try_into().ok())
            .map(GrantScope::Exact),
        _ => None,
    }
}

/// The entries of the grants in `access` that can be pushed under now.
fn live_entries(access: &BotPushAccess) -> Vec<PushEntry> {
    access
        .live()
        .filter_map(|g| entry(&g.id, &scope_of(g)?).ok())
        .collect()
}

/// `dg bot allow --push`: check, show and confirm the grants, write them, and list them in
/// `notice` (written next by the caller, which asks nothing more).
pub(crate) async fn allow_push(
    ctx: &Ctx,
    s: &Session,
    bot: &str,
    name: &str,
    a: &AllowArgs,
    notice: &mut AccessNotice,
    prompt: &str,
) -> Result<()> {
    let collab = s.collab();
    let repo = s.repo.display();
    let access = collab.bot_push_access(&s.repo, bot).await?;
    if !access.supported {
        return Err(not_yet(&repo));
    }
    if access.bot_row_at.is_none() {
        return Err(not_a_bot(name, &repo));
    }
    let now = access.now;
    let until = push_until(a.push_until.as_deref(), notice.until, now)?;
    let named = a.push.iter().any(|p| !p.is_empty());
    let branches = if named {
        collab.grantable_branches(&s.repo).await.unwrap_or_default()
    } else {
        Vec::new()
    };
    let reqs = requests(&a.push, bot, name, &branches)?;
    let svc = RepoService::new(&s.client, &s.identity, &s.bridge);
    if !ctx.json {
        for r in &reqs {
            eprintln!("{}", grant_line(name, r, until));
        }
        let default = svc
            .read_default_branch(&s.repo)
            .await
            .ok()
            .flatten()
            .unwrap_or_else(|| "main".into());
        let patterns = svc.protected_patterns(&s.repo).await.unwrap_or_default();
        if reqs
            .iter()
            .any(|r| matches!(r.scope, GrantScope::Prefix(_)))
            && !forge_core::rules::matches_protected(&format!("refs/heads/{default}"), &patterns)
        {
            eprintln!(
                "note: the default branch {} isn't protected, so access that covers it lets {} push to it (`dg repo protect defaults {repo}`)",
                safe(&default),
                safe(name)
            );
        }
        eprintln!(
            "  Push access: about {}",
            cost_line(
                forge_core::cost::push_fees::estimate_ref_updates(reqs.len() as u64),
                ctx.usd_price()
            )
        );
    }
    ctx.confirm_or_cancel(prompt)?;
    let mut entries: Vec<PushEntry> = notice
        .push_entries()
        .unwrap_or_default()
        .into_iter()
        .filter(|e| {
            access
                .live()
                .any(|g| decode_identifier(&g.id).ok() == Some(e.grant))
        })
        .collect();
    for r in &reqs {
        let id = svc.write_push_grant(&s.repo, bot, &r.scope, until).await?;
        entries.push(entry(&id, &r.scope)?);
    }
    let policy = PushPolicy {
        fast_forward_only: !a.allow_force,
        delete_own_only: !a.allow_force,
        open_pr_not_push: a.open_pr_only,
    };
    notice.set_push(entries, policy);
    Ok(())
}

/// Read what a push command needs: the session, the bot, its name, its access and notice.
async fn open(
    ctx: &Ctx,
    repo: &str,
    bot: &str,
) -> Result<(Session, String, String, BotPushAccess)> {
    let s = Session::open_for_write(ctx, repo, "access not changed").await?;
    let bot = resolve_identity(&s.client, bot, "bot").await?;
    let name = handle(&s.client, &bot).await;
    s.collab().require_notice_writer(&s.repo).await?;
    let access = s.collab().bot_push_access(&s.repo, &bot).await?;
    if !access.supported {
        return Err(not_yet(&s.repo.display()));
    }
    Ok((s, bot, name, access))
}

/// The bot's current notice to build on (or one allowing nothing), revoking it.
fn next_notice(access: &BotPushAccess, bot: &str) -> Result<AccessNotice> {
    Ok(match &access.notice {
        Some(e) => AccessNotice {
            revokes: vec![e.pack_hash],
            ..e.notice.clone()
        },
        None => AccessNotice::empty(decode_identifier(bot)?),
    })
}

/// The people who gave the bot's live push access, as the copy names them.
async fn granters(s: &Session, access: &BotPushAccess) -> Vec<String> {
    let mut ids: Vec<&str> = access.live().map(|g| g.granter.as_str()).collect();
    ids.sort_unstable();
    ids.dedup();
    let mut out = Vec::new();
    for id in ids {
        out.push(handle(&s.client, id).await);
    }
    out
}

/// `dg bot suspend` (`suspend`) and `dg bot resume`.
pub(crate) async fn suspend(ctx: &Ctx, repo: &str, bot: &str, suspend: bool) -> Result<()> {
    let (s, bot, name, access) = open(ctx, repo, bot).await?;
    let mut notice = next_notice(&access, &bot)?;
    let policy = notice.push_policy();
    if suspend {
        if access.suspended() || access.live().next().is_none() {
            return Err(UserError::new(
                codes::USAGE,
                format!("{} doesn't push to {} now", safe(&name), s.repo.display()),
            )
            .note("nothing was written")
            .into());
        }
        let who = granters(&s, &access).await.join(", ");
        if !ctx.json {
            eprintln!(
                "{} stops pushing at once. Only {}, who gave this access, or the owner can remove it.",
                safe(&name),
                safe(&who)
            );
        }
        notice.set_push(Vec::new(), policy);
        let prompt = format!("Suspend {}'s pushes?", safe(&name));
        return write_notice(ctx, &s, &notice, &name, "suspended", Some(&prompt)).await;
    }
    let entries = live_entries(&access);
    if entries.is_empty() {
        return Err(UserError::new(
            codes::USAGE,
            format!(
                "{} has no push access to {} to resume",
                safe(&name),
                s.repo.display()
            ),
        )
        .fix(format!(
            "give it some: `dg bot allow {} {} --push`",
            s.repo.display(),
            safe(&name)
        ))
        .note("nothing was written")
        .into());
    }
    notice.set_push(entries, policy);
    let prompt = format!("Let {} push again?", safe(&name));
    write_notice(ctx, &s, &notice, &name, "resumed", Some(&prompt)).await
}

/// Delete every grant this signer wrote for `bot` (only a grant's writer can). Reports what it
/// removed; returns how many.
pub(crate) async fn delete_own_grants(ctx: &Ctx, s: &Session, bot: &str) -> Result<usize> {
    let svc = RepoService::new(&s.client, &s.identity, &s.bridge);
    if !svc.push_grants_supported(&s.repo).await? {
        return Ok(0);
    }
    let me = s.identity.id();
    let mine: Vec<PushGrant> = svc
        .read_push_grants(&s.repo, Some(bot))
        .await?
        .into_iter()
        .filter(|g| g.granter == me && g.until > forge_core::cache::now_ms())
        .collect();
    for g in &mine {
        svc.delete_push_grant(&s.repo, &g.id).await?;
    }
    if !mine.is_empty() && !ctx.json {
        eprintln!(
            "Removed {} push {} you gave.",
            mine.len(),
            if mine.len() == 1 {
                "access"
            } else {
                "accesses"
            }
        );
    }
    Ok(mine.len())
}

/// `dg bot revoke --push`: delete the push access this maintainer gave the bot, then list what
/// others gave in its notice (or no push at all).
pub(crate) async fn revoke_push(ctx: &Ctx, s: &Session, bot: &str, name: &str) -> Result<()> {
    let access = s.collab().bot_push_access(&s.repo, bot).await?;
    if !access.supported {
        return Err(not_yet(&s.repo.display()));
    }
    let me = s.identity.id();
    let mine = access.grants.iter().filter(|g| g.granter == me).count();
    if mine == 0 {
        return Err(UserError::new(
            codes::NOT_FOUND,
            format!(
                "you gave {} no push access to {}",
                safe(name),
                s.repo.display()
            ),
        )
        .fix(format!(
            "to stop it pushing at once whoever gave the access: `dg bot suspend {} {}`",
            s.repo.display(),
            safe(name)
        ))
        .note("nothing was written")
        .into());
    }
    let mut notice = next_notice(&access, bot)?;
    let policy = notice.push_policy();
    let rest: Vec<PushEntry> = access
        .live()
        .filter(|g| g.granter != me)
        .filter_map(|g| entry(&g.id, &scope_of(g)?).ok())
        .collect();
    if !ctx.json {
        eprintln!(
            "{} can no longer push under the access you gave it. What it pushed stays.",
            safe(name)
        );
    }
    ctx.confirm_or_cancel(&format!("Remove {}'s push access?", safe(name)))?;
    delete_own_grants(ctx, s, bot).await?;
    if notice.may(access_notice::MAY_PUSH) || !rest.is_empty() {
        notice.set_push(rest, policy);
        write_notice(ctx, s, &notice, name, "pushRevoked", None).await?;
    }
    Ok(())
}

/// `dg bot renew`: every branch the bot may push to (or could until its access ended or its
/// branch got a new key) gets a new grant until `until`; the grants this maintainer wrote before
/// are deleted, and the notice lists the new ones.
pub(crate) async fn renew(ctx: &Ctx, repo: &str, bot: &str, until: Option<&str>) -> Result<()> {
    let (s, bot, name, access) = open(ctx, repo, bot).await?;
    if access.bot_row_at.is_none() {
        return Err(not_a_bot(&name, &s.repo.display()));
    }
    let now = access.now;
    let until = push_until(until, None, now)?;
    let branches = s
        .collab()
        .grantable_branches(&s.repo)
        .await
        .unwrap_or_default();
    // per scope, the newest grant that a renewal brings back (not one older than the bot's row:
    // that access doesn't come back; give it again)
    let mut todo: Vec<(GrantRequest, Vec<&PushGrant>)> = Vec::new();
    for g in access.grants.iter().rev() {
        if matches!(
            access.usable(g),
            Err(Unusable::OlderThanBotRow | Unusable::NotABot)
        ) {
            continue;
        }
        let Some(scope) = scope_of(g) else { continue };
        // a members-only branch's grant names its hash under the key it had: the current one
        let req = match &scope {
            GrantScope::Prefix(p) => GrantRequest {
                label: push_grant::short_prefix(p).to_owned(),
                scope,
            },
            GrantScope::Exact(h) => {
                let Some(b) = branches
                    .iter()
                    .find(|b| b.current == *h || b.earlier.contains(h))
                else {
                    continue;
                };
                if !b.audience_now.contains(&bot) {
                    continue;
                }
                GrantRequest {
                    label: forge_core::keyring::short_branch(&b.name).to_owned(),
                    scope: GrantScope::Exact(b.current),
                }
            }
        };
        match todo.iter_mut().find(|(r, _)| r.scope == req.scope) {
            Some((_, old)) => old.push(g),
            None => todo.push((req, vec![g])),
        }
    }
    if todo.is_empty() {
        return Err(UserError::new(
            codes::USAGE,
            format!(
                "{} has no push access to {} to renew",
                safe(&name),
                s.repo.display()
            ),
        )
        .fix(format!(
            "give it some: `dg bot allow {} {} --push`",
            s.repo.display(),
            safe(&name)
        ))
        .note("nothing was written")
        .into());
    }
    if !ctx.json {
        for (r, _) in &todo {
            eprintln!("{}", grant_line(&name, r, until));
        }
    }
    ctx.confirm_or_cancel(&format!("Renew {}'s push access?", safe(&name)))?;
    let svc = RepoService::new(&s.client, &s.identity, &s.bridge);
    let me = s.identity.id();
    let mut notice = next_notice(&access, &bot)?;
    let policy = notice.push_policy();
    let replaced: Vec<[u8; 32]> = todo
        .iter()
        .flat_map(|(_, old)| old.iter().filter_map(|g| decode_identifier(&g.id).ok()))
        .collect();
    let mut entries: Vec<PushEntry> = live_entries(&access)
        .into_iter()
        .filter(|e| !replaced.contains(&e.grant))
        .collect();
    let mut renewed = Vec::new();
    for (r, old) in &todo {
        let id = svc.write_push_grant(&s.repo, &bot, &r.scope, until).await?;
        entries.push(entry(&id, &r.scope)?);
        renewed.push(json!({ "grant": id, "branch": r.label, "until": until }));
        for g in old.iter().filter(|g| g.granter == me) {
            // best effort: the old grant ends anyway
            let _ = svc.delete_push_grant(&s.repo, &g.id).await;
        }
    }
    // a suspended bot stays suspended: renewing gives time, not the push back
    if access.suspended() {
        if !ctx.json {
            eprintln!(
                "{}'s pushes stay suspended: `dg bot resume {} {}` lets it push again.",
                safe(&name),
                s.repo.display(),
                safe(&name)
            );
        }
        ctx.emit(
            json!({ "status": "renewed", "renewed": renewed, "suspended": true }),
            || {
                println!("✓ renewed {} push access", renewed.len());
            },
        );
        return Ok(());
    }
    notice.set_push(entries, policy);
    write_notice(ctx, &s, &notice, &name, "renewed", None).await
}

/// What `dg bot list` shows of a bot's push access: JSON and the lines (DESIGN §10).
pub(crate) async fn describe(
    client: &forge_core::platform::PlatformClient,
    collab: &forge_core::collab::v2::Collab<'_>,
    repo: &forge_core::scope::RepoRef,
    access: &BotPushAccess,
    name: &str,
) -> (Value, Vec<String>) {
    if !access.supported {
        return (Value::Null, Vec::new());
    }
    let now = access.now;
    let branches = collab.grantable_branches(repo).await.unwrap_or_default();
    let bots: Vec<String> = forge_core::members::MemberReader::new(client)
        .list(repo)
        .await
        .map(|m| forge_core::bot_keys::bots_of(&m, &[]))
        .unwrap_or_default();
    let listed: Vec<[u8; 32]> = access
        .notice
        .as_ref()
        .and_then(|n| n.notice.push_entries())
        .unwrap_or_default()
        .iter()
        .map(|e| e.grant)
        .collect();
    let mut lines = Vec::new();
    let mut grants = Vec::new();
    let mut prefixes: Vec<(String, u64)> = Vec::new();
    let mut members = 0usize;
    for g in &access.grants {
        let status = access.usable(g);
        // a grant replaced by a newer one over the same branches says nothing more
        let superseded = access
            .grants
            .iter()
            .any(|o| o.created_at > g.created_at && o.prefix == g.prefix && o.scope == g.scope);
        // an exact grant's branch, when this reader holds its key (the bot does: it is shared
        // with it)
        let branch = g.scope.as_ref().and_then(|h| {
            branches.iter().find(|b| {
                hex::encode(b.current) == *h || b.earlier.iter().any(|e| hex::encode(e) == *h)
            })
        });
        let what = match (&g.prefix, branch) {
            (Some(p), _) => push_grant::short_prefix(p).to_owned(),
            (None, Some(b)) => forge_core::keyring::short_branch(&b.name).to_owned(),
            (None, None) => "a members-only branch".to_owned(),
        };
        let granter = handle(client, &g.granter).await;
        let in_notice = decode_identifier(&g.id).is_ok_and(|id| listed.contains(&id));
        grants.push(json!({
            "grant": g.id,
            "prefix": g.prefix,
            "scope": g.scope,
            "until": g.until,
            "by": g.granter,
            "at": g.created_at,
            "status": match status { Ok(()) => json!("usable"), Err(u) => json!(u) },
            "inNotice": in_notice,
            "renewDue": g.renew_due(now),
            // the runner pushes an exact grant's branch only under its current key
            "branchRef": branch
                .filter(|b| g.scope.as_deref() == Some(hex::encode(b.current).as_str()))
                .map(|b| &b.name),
            "people": branch.map(|b| {
                b.audience_now.iter().filter(|p| !bots.contains(p)).collect::<Vec<_>>()
            }),
        }));
        if superseded {
            continue;
        }
        match status {
            Ok(()) => {
                if g.is_exact() {
                    members += 1;
                } else {
                    prefixes.push((g.prefix.clone().unwrap_or_default(), g.until));
                }
                if g.renew_due(now) {
                    let days = (g.until - now).div_ceil(DAY_MS).min(RENEW_WINDOW_MS / DAY_MS);
                    lines.push(format!(
                        "{}'s push access to {} ends in {days} day{}. Renew: dg bot renew {} {}",
                        safe(name),
                        safe(&what),
                        if days == 1 { "" } else { "s" },
                        repo.display(),
                        safe(name)
                    ));
                }
                if !in_notice && access.notice.is_some() {
                    lines.push(format!(
                        "{} let {} push here; this isn't in {}'s access settings.",
                        safe(&granter),
                        safe(name),
                        safe(name)
                    ));
                }
            }
            Err(Unusable::Expired) => lines.push(format!(
                "{}'s push access ended on {}. Renew: dg bot renew {} {}",
                safe(name),
                date_words(g.until),
                repo.display(),
                safe(name)
            )),
            Err(Unusable::GranterGone) => lines.push(format!(
                "{} can no longer push to {}: {} is no longer a maintainer. Give access again: dg bot allow {} {} --push {}",
                safe(name),
                safe(&what),
                safe(&granter),
                repo.display(),
                safe(name),
                safe(&what)
            )),
            Err(Unusable::OlderThanBotRow) => lines.push(format!(
                "{} had push access to {} before it was removed. It won't come back; give it again if you want.",
                safe(name),
                safe(&what)
            )),
            Err(Unusable::NotABot) => {}
        }
    }
    let refs: Vec<(&str, u64)> = prefixes.iter().map(|(p, u)| (p.as_str(), *u)).collect();
    let mut head = Vec::new();
    if access.suspended() && (!refs.is_empty() || members > 0) {
        head.push(format!(
            "{}'s pushes are suspended. dg bot resume {} {}",
            safe(name),
            repo.display(),
            safe(name)
        ));
    } else if let Some(line) = access_notice::push_line(&refs, members) {
        head.push(line);
    }
    head.extend(lines);
    (
        json!({
            "suspended": access.suspended(),
            "policy": access.notice.as_ref().map(|n| n.notice.push_policy()),
            "grants": grants,
        }),
        head,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_become_grants_and_the_default_is_the_bots_prefix() {
        let r = requests(&[String::new(), "gh-pages".into()], "B", "@ci-bot", &[]).unwrap();
        assert_eq!(
            r[0].scope,
            GrantScope::Prefix("refs/heads/bot/ci-bot/".into())
        );
        assert_eq!(r[1].label, "gh-pages");
        assert!(requests(&["refs/tags/v1".into()], "B", "@b", &[]).is_err());
        assert!(grant_line("@ci-bot", &r[1], 1_794_009_600_000)
            .contains("(and any branch whose name starts with gh-pages) until 7 Nov 2026"));
    }

    #[test]
    fn push_access_lasts_30_days_or_until_the_access_ends() {
        let now = 1_000_000;
        assert_eq!(
            push_until(None, None, now).unwrap(),
            now + push_grant::DEFAULT_TTL_MS
        );
        assert_eq!(push_until(None, Some(now + 5), now).unwrap(), now + 5);
        let now_2026 = 1_790_000_000_000;
        assert!(push_until(Some("2020-01-01"), None, now_2026).is_err());
        assert!(push_until(Some("2027-01-01"), None, now_2026).is_err());
        // the last day of the 90 is brought in, not refused
        let ninety = push_until(Some("2026-11-13"), None, 1_786_800_000_000).unwrap();
        assert!(ninety <= 1_786_800_000_000 + MAX_TTL_MS);
    }
}
