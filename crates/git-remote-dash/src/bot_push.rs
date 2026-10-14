//! A bot's push (phase 4E; mixed-visibility DESIGN §4.9 "Pushing", D42;
//! `docs/security/private-repos.md` §24): before anything is built, the grant each ref is pushed
//! under, and a refusal (E814) for the refs no usable grant covers. Consensus is the authority
//! (a bot's `refUpdate` needs a live grant from a current maintainer); this check says why
//! before a pack is stored and paid for, and adds what consensus cannot hold: a grant older than
//! the bot's current member row does not count, and a maintainer's notice without `push`
//! suspends every push.

use std::collections::BTreeMap;

use forge_core::collab::v2::BotPushAccess;
use forge_core::repo::BotPush;
use forge_core::rules::push_grant::{self, NoGrant, PushTarget, Unusable};
use forge_core::user_error::{codes, UserError};

use crate::helper::PushSpec;

/// What a bot's push may do, decided before anything is built.
#[derive(Debug, Default)]
pub struct BotPlan {
    /// The grant each accepted ref is pushed under.
    pub push: BotPush,
    /// The refused refs, with git's short reason.
    pub refused: Vec<(String, String)>,
    /// The block printed once for the refusals (the first refusal's).
    pub error: Option<UserError>,
}

/// The note on every bot refusal.
const NOTE: &str = "checked before building or paying for anything: nothing was stored";

/// Plan a bot's push of `specs` to `repo_label` under `access`. `exact_hash(dst)` is a members-
/// only branch's name hash under the branch key this bot holds (a narrower branch shared with
/// it), `None` for a public ref; `protected(dst)` whether the ref is protected now. With
/// `enforce` off (`DASH_FORGE_SKIP_WRITE_PRECHECK`, which shows what consensus does) nothing is
/// refused here: a ref with no grant is written naming none.
pub fn plan(
    access: &BotPushAccess,
    specs: &[PushSpec],
    repo_label: &str,
    exact_hash: impl Fn(&str) -> Option<String>,
    protected: impl Fn(&str) -> bool,
    enforce: bool,
) -> BotPlan {
    fn refuse(dst: &str, wire: &str, e: UserError, out: &mut BotPlan) {
        out.refused.push((dst.to_owned(), wire.to_owned()));
        out.error.get_or_insert(e);
    }
    let mut out = BotPlan::default();
    let mut grants = BTreeMap::new();
    for s in specs {
        let dst = s.dst.as_str();
        if !access.supported {
            if enforce {
                refuse(
                    dst,
                    "bots can't push here yet",
                    not_supported(repo_label),
                    &mut out,
                );
            }
            continue;
        }
        if enforce && access.suspended() {
            refuse(dst, "bot pushes suspended", suspended(repo_label), &mut out);
            continue;
        }
        if enforce && protected(dst) {
            refuse(
                dst,
                "protected branch",
                protected_ref(dst, repo_label),
                &mut out,
            );
            continue;
        }
        let hash = exact_hash(dst);
        let target = hash
            .as_deref()
            .map_or(PushTarget::Public(dst), PushTarget::Exact);
        match access.pick(&target) {
            Ok(g) => {
                grants.insert(dst.to_owned(), g.clone());
            }
            Err(why) if enforce => {
                let covering = access.grants.iter().rev().find(|g| g.covers(&target));
                refuse(
                    dst,
                    "no push access",
                    no_grant(dst, repo_label, why, covering, access),
                    &mut out,
                );
            }
            Err(_) => {}
        }
    }
    out.push = BotPush { grants };
    out
}

fn e814(message: String) -> UserError {
    UserError::new(codes::BOT_PUSH_NOT_ALLOWED, message).note(NOTE)
}

/// The contract has no push grants (sakura's live set): a bot is not a member there.
pub fn not_supported(repo: &str) -> UserError {
    e814(format!("push rejected: bots can't push to {repo} yet"))
        .cause("this network's contract has no push access for bots")
        .fix("push to a repo of your own and open a pull request")
}

fn suspended(repo: &str) -> UserError {
    e814(format!(
        "push rejected: a maintainer suspended your pushes to {repo}"
    ))
    .cause("your current access in this repository doesn't allow pushing")
    .fix(format!(
        "ask a maintainer to resume them: `dg bot resume {repo} <you>`"
    ))
}

fn protected_ref(dst: &str, repo: &str) -> UserError {
    e814(format!(
        "push rejected: {dst} is a protected branch of {repo}"
    ))
    .cause("a bot never updates a protected branch")
    .fix("push to a branch you may push to and open a pull request")
}

/// What is short about a bot's push of `dst`.
fn no_grant(
    dst: &str,
    repo: &str,
    why: NoGrant,
    covering: Option<&push_grant::PushGrant>,
    access: &BotPushAccess,
) -> UserError {
    let what = covering.and_then(|g| g.prefix.as_deref()).map_or_else(
        || dst.to_owned(),
        |p| push_grant::short_prefix(p).to_owned(),
    );
    match why {
        NoGrant::NotCovered => e814(format!(
            "push rejected: you have no push access to {dst} in {repo}"
        ))
        .cause(format!(
            "a maintainer gives a bot push access to a branch or a branch prefix (`dg bot allow {repo} <bot> --push bot/<bot>/`)"
        ))
        .fix(format!(
            "push to a branch you may push to: `dg bot list {repo}` shows them"
        )),
        NoGrant::Unusable(Unusable::Expired) => e814(format!(
            "push rejected: your push access to {what} ended on {}",
            forge_core::private::access_notice::date_words(
                covering.map_or(access.now, |g| g.until)
            )
        ))
        .fix(format!("ask a maintainer to renew it: `dg bot renew {repo} <bot>`")),
        NoGrant::Unusable(Unusable::GranterGone) => e814(format!(
            "push rejected: you can no longer push to {what}: the maintainer who gave the access is no longer a maintainer"
        ))
        .fix(format!(
            "ask a maintainer to give it again: `dg bot allow {repo} <bot> --push …`"
        )),
        NoGrant::Unusable(Unusable::OlderThanBotRow) => e814(format!(
            "push rejected: you had push access to {what} before you were removed from {repo}; it doesn't come back"
        ))
        .fix(format!(
            "ask a maintainer to give it again: `dg bot allow {repo} <bot> --push …`"
        )),
        NoGrant::Unusable(Unusable::NotABot) => e814(format!(
            "push rejected: you are not a bot of {repo}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::rules::push_grant::PushGrant;
    use std::collections::BTreeSet;

    fn access(grants: Vec<PushGrant>) -> BotPushAccess {
        BotPushAccess {
            bot: "B".into(),
            supported: true,
            grants,
            bot_row_at: Some(10),
            maintainers: BTreeSet::from(["M".to_string()]),
            notice: None,
            now: 100,
        }
    }

    fn grant(prefix: &str, at: u64) -> PushGrant {
        PushGrant {
            id: forge_core::platform::encode_identifier([at as u8; 32]),
            granter: "M".into(),
            bot: forge_core::platform::encode_identifier([9; 32]),
            prefix: Some(prefix.into()),
            scope: None,
            until: 1000,
            created_at: at,
        }
    }

    fn spec(dst: &str) -> PushSpec {
        PushSpec {
            force: false,
            src: "abc".into(),
            dst: dst.into(),
        }
    }

    #[test]
    fn a_bot_pushes_only_under_a_grant_that_counts() {
        let a = access(vec![
            grant("refs/heads/bot/b/", 20),
            grant("refs/heads/old/", 5),
        ]);
        let specs = [
            spec("refs/heads/bot/b/x"),
            spec("refs/heads/main"),
            spec("refs/heads/old/y"),
            spec("refs/heads/bot/b/p"),
        ];
        let p = plan(&a, &specs, "o/r", |_| None, |d| d.ends_with("/p"), true);
        assert_eq!(p.push.grants.len(), 1);
        assert!(p.push.grants.contains_key("refs/heads/bot/b/x"));
        let refused: Vec<&str> = p.refused.iter().map(|(d, _)| d.as_str()).collect();
        assert_eq!(
            refused,
            ["refs/heads/main", "refs/heads/old/y", "refs/heads/bot/b/p"]
        );
        // without the precheck nothing is refused here: consensus decides
        let p = plan(&a, &specs, "o/r", |_| None, |_| true, false);
        assert!(p.refused.is_empty());
        assert_eq!(p.push.grants.len(), 2);
    }
}
