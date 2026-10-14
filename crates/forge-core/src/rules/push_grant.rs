//! Bot push grants (mixed-visibility DESIGN §4.9 "Pushing", D42; `docs/security/private-repos.md`
//! §24): which of a bot's `pushGrant` documents a client may push under, and how readers mark a
//! bot's push.
//!
//! A maintainer's `pushGrant` (forge-core, mainnet set only) names one Bot row of the repository
//! and either one **public ref prefix** (`prefix`, `refs/heads/bot/<bot name>/` by default; one
//! branch is granted as the prefix of its full name) or one **exact members-only ref** (`scope`,
//! its name hash under the branch key, phase 3F), with an `until` at most 90 days after it was
//! written. Consensus admits a bot's `refUpdate` (`r` 4) only under a grant it names (`pp` for a
//! prefix grant, `pg` for an exact one) that is live for this bot, this repo and this ref, whose
//! granter is still a maintainer (`grantor`), and an exact grant only for a sealed update.
//!
//! What consensus cannot say, clients and the runner do ([`usable`]): a grant written before the
//! bot's **current** member row does not count (a bot removed and added again does not get its
//! push back), and a grant whose granter is no longer a maintainer, or whose `until` passed, is
//! not offered. Readers mark a bot's push ([`mark`]) "outside the access @ci-bot was given" when
//! it named such an older grant, or when the access notice in force when it landed did not allow
//! pushing (a maintainer suspended it).
//!
//! Everything here is pure: callers read the grants, the member rows and the notices.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::platform::{self, FetchedDocument};

/// The forge-core document type.
pub const DOC_PUSH_GRANT: &str = "pushGrant";
/// The `refUpdate` property naming an exact grant.
pub const EXACT_GRANT: &str = "pg";
/// The `refUpdate` property naming a prefix grant.
pub const PREFIX_GRANT: &str = "pp";
/// The `refUpdate` property naming the grant's granter (whose maintainer row must still exist).
pub const GRANTOR: &str = "grantor";
/// The `r` a bot's push documents claim (its writer row's role).
pub const BOT_PUSH_ROLE: u64 = 4;
/// The case of the `bot_push__*` conformance vectors.
pub const VECTOR_CASE: &str = "bot_push";

const DAY_MS: u64 = 86_400_000;
/// A grant lasts at most this long after it is written (`ttl90`).
pub const MAX_TTL_MS: u64 = 90 * DAY_MS;
/// How long a grant lasts when the maintainer does not say.
pub const DEFAULT_TTL_MS: u64 = 30 * DAY_MS;
/// Clients offer "Renew" from this long before a grant ends.
pub const RENEW_WINDOW_MS: u64 = 14 * DAY_MS;
/// A grant's `until` is checked against the signer's clock before signing and the block's time
/// at consensus: a client asks for this much less than [`MAX_TTL_MS`] so the two never disagree.
pub const TTL_MARGIN_MS: u64 = 10 * 60_000;
/// Every branch prefix starts here: a grant never covers a tag or another namespace.
pub const BRANCHES: &str = "refs/heads/";
/// The longest prefix the contract stores (`maxBytes`).
pub const PREFIX_MAX: usize = 255;

/// One `pushGrant` document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushGrant {
    /// Its document id (base58).
    pub id: String,
    /// Its writer, the maintainer who gave the access (base58).
    pub granter: String,
    /// The bot (base58).
    pub bot: String,
    /// A public ref prefix, for a prefix grant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    /// The members-only ref's name hash (hex), for an exact grant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// When it ends (ms).
    pub until: u64,
    /// When it was written (`$createdAt`, ms).
    pub created_at: u64,
}

impl PushGrant {
    /// A fetched `pushGrant`, or `None` for one consensus would not have admitted (no bot, both
    /// or neither of `scope` and `prefix`, an `until` not after it was written).
    #[must_use]
    pub fn from_doc(d: &FetchedDocument) -> Option<Self> {
        let created_at = d.created_at?;
        let until = d.field_u64("until")?;
        let prefix = d.field_str("prefix");
        let scope = d.field_bytes32("scope").map(hex::encode);
        if prefix.is_some() == scope.is_some() || until <= created_at {
            return None;
        }
        Some(Self {
            id: d.id.clone(),
            granter: d.owner_id.clone(),
            bot: platform::encode_identifier(d.field_bytes32("botId")?),
            prefix,
            scope,
            until,
            created_at,
        })
    }

    /// Whether it lets the bot push `target`.
    #[must_use]
    pub fn covers(&self, target: &PushTarget<'_>) -> bool {
        match (target, &self.prefix, &self.scope) {
            (PushTarget::Public(name), Some(p), None) => name.starts_with(p.as_str()),
            (PushTarget::Exact(hash), None, Some(s)) => s.eq_ignore_ascii_case(hash),
            _ => false,
        }
    }

    /// Whether it is an exact (members-only) grant.
    #[must_use]
    pub fn is_exact(&self) -> bool {
        self.scope.is_some()
    }

    /// Whether clients offer "Renew" at `now`: it is live and ends within [`RENEW_WINDOW_MS`].
    #[must_use]
    pub fn renew_due(&self, now: u64) -> bool {
        now < self.until && self.until - now <= RENEW_WINDOW_MS
    }
}

/// What a bot pushes: a public ref by its full name, or a members-only ref by its name hash under
/// the branch key (hex).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushTarget<'a> {
    /// A public ref (`refs/heads/bot/ci-bot/fix`).
    Public(&'a str),
    /// A members-only ref's name hash (hex).
    Exact(&'a str),
}

/// Why a grant cannot be pushed under now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Unusable {
    /// Its `until` passed.
    Expired,
    /// Its granter is no longer a maintainer: the grant died with their row.
    GranterGone,
    /// The bot holds no Bot row in this repository now.
    NotABot,
    /// It was written before the bot's current member row: a bot removed and added again does
    /// not get its push back.
    OlderThanBotRow,
}

/// What [`usable`] judges a grant against.
#[derive(Debug, Clone, Copy)]
pub struct GrantContext<'a> {
    /// Now (ms).
    pub now: u64,
    /// When the bot's current Bot row was written; `None` when it holds none.
    pub bot_row_at: Option<u64>,
    /// The repository's current maintainers (the owner included), base58.
    pub maintainers: &'a BTreeSet<String>,
}

/// Whether grant `g` can be pushed under now: its bot holds a Bot row written no later than the
/// grant, its granter is a maintainer, and it has not ended. Checked in that order, so the
/// reason given is the one no renewal fixes first.
pub fn usable(g: &PushGrant, ctx: &GrantContext<'_>) -> Result<(), Unusable> {
    let row = ctx.bot_row_at.ok_or(Unusable::NotABot)?;
    if g.created_at < row {
        return Err(Unusable::OlderThanBotRow);
    }
    if !ctx.maintainers.contains(&g.granter) {
        return Err(Unusable::GranterGone);
    }
    if ctx.now >= g.until {
        return Err(Unusable::Expired);
    }
    Ok(())
}

/// Why no grant lets the bot push a ref.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "reason", content = "why")]
pub enum NoGrant {
    /// No grant covers it.
    NotCovered,
    /// Grants cover it, none usable: the newest one's reason.
    Unusable(Unusable),
}

/// The grant a bot pushes `target` under: of the usable grants that cover it, the one that ends
/// last (then the newest, then by id), so a renewal is used as soon as it exists.
pub fn pick<'g>(
    grants: &'g [PushGrant],
    target: &PushTarget<'_>,
    ctx: &GrantContext<'_>,
) -> Result<&'g PushGrant, NoGrant> {
    let covering: Vec<&PushGrant> = grants
        .iter()
        .filter(|g| platform::decode_identifier(&g.bot).is_ok() && g.covers(target))
        .collect();
    let best = covering
        .iter()
        .filter(|g| usable(g, ctx).is_ok())
        .max_by(|a, b| (a.until, a.created_at, &a.id).cmp(&(b.until, b.created_at, &b.id)));
    if let Some(g) = best {
        return Ok(g);
    }
    covering
        .iter()
        .max_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)))
        .map_or(Err(NoGrant::NotCovered), |g| {
            Err(NoGrant::Unusable(
                usable(g, ctx).expect_err("no covering grant is usable"),
            ))
        })
}

/// Why a branch pattern cannot be granted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PatternRefusal {
    /// Empty.
    Empty,
    /// Outside `refs/heads/`: a tag or another namespace.
    NotABranch,
    /// A glob that is not a trailing `*` (`*` or `?` or `[` elsewhere): only prefixes can be
    /// granted.
    NotAPrefix,
    /// Longer than [`PREFIX_MAX`] bytes, or with a control character, space, `..` or `\`.
    Malformed,
}

/// The prefix a branch pattern grants: `bot/ci-bot/*` and `bot/ci-bot/` grant everything under
/// `refs/heads/bot/ci-bot/`; `gh-pages` grants `refs/heads/gh-pages` (and every longer name that
/// starts with it, which the dialog says); a `refs/heads/…` spelling is taken as given. A glob
/// other than one trailing `*` is refused (consensus compares prefixes only), and so is anything
/// outside `refs/heads/`.
pub fn prefix_of(pattern: &str) -> Result<String, PatternRefusal> {
    let p = pattern.trim();
    if p.is_empty() || p == "*" {
        return Err(PatternRefusal::Empty);
    }
    let full = if p.starts_with("refs/") {
        if !p.starts_with(BRANCHES) {
            return Err(PatternRefusal::NotABranch);
        }
        p.to_owned()
    } else {
        format!("{BRANCHES}{p}")
    };
    let full = full.strip_suffix('*').unwrap_or(&full).to_owned();
    if full.contains(['*', '?', '[']) {
        return Err(PatternRefusal::NotAPrefix);
    }
    if full.len() <= BRANCHES.len()
        || full.len() > PREFIX_MAX
        || full.contains("..")
        || full.contains("//")
        || full
            .chars()
            .any(|c| c.is_control() || c == ' ' || c == '\\' || c == '~' || c == '^' || c == ':')
    {
        return Err(PatternRefusal::Malformed);
    }
    Ok(full)
}

/// The prefix the grant dialog offers a bot by default: `refs/heads/bot/<name>/`, its name
/// without a leading `@` (its id when it has no name).
#[must_use]
pub fn default_prefix(bot_name: &str) -> String {
    format!("{BRANCHES}bot/{}/", bot_name.trim_start_matches('@'))
}

/// A prefix as the product names it: the branch part (`bot/ci-bot/`).
#[must_use]
pub fn short_prefix(prefix: &str) -> &str {
    prefix.strip_prefix(BRANCHES).unwrap_or(prefix)
}

/// Why an `until` cannot be granted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UntilRefusal {
    /// Not after now.
    Past,
    /// More than 90 days ahead.
    TooFar,
}

/// The `until` a grant written at `now` asks for: `requested`, else [`DEFAULT_TTL_MS`] ahead;
/// refused when not after now or more than 90 days ahead. A request within [`TTL_MARGIN_MS`]
/// of the 90 days is brought in by that margin, so consensus (which judges against the block's
/// time) never refuses what the client accepted.
pub fn until_for(now: u64, requested: Option<u64>) -> Result<u64, UntilRefusal> {
    let latest = now + MAX_TTL_MS - TTL_MARGIN_MS;
    match requested {
        None => Ok(now + DEFAULT_TTL_MS),
        Some(u) if u <= now => Err(UntilRefusal::Past),
        Some(u) if u > now + MAX_TTL_MS => Err(UntilRefusal::TooFar),
        Some(u) => Ok(u.min(latest)),
    }
}

/// The grant a ref update names (`pp` or `pg`, base58), if any: a bot's push (`r` 4) names one.
#[must_use]
pub fn named_grant(d: &FetchedDocument) -> Option<String> {
    d.field_bytes32(PREFIX_GRANT)
        .or_else(|| d.field_bytes32(EXACT_GRANT))
        .map(platform::encode_identifier)
}

/// Whether a ref update is a bot's push: it claims `r` 4.
#[must_use]
pub fn is_bot_push(d: &FetchedDocument) -> bool {
    d.field_u64(crate::members::CLAIMED_ROLE) == Some(BOT_PUSH_ROLE)
}

/// How a reader marks a bot's push.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PushMark {
    /// Under a grant that counted, while its notice allowed pushing.
    Granted,
    /// "Outside the access @ci-bot was given": the grant it named was written before the bot's
    /// current member row, or the notice in force did not allow pushing.
    Outside,
}

/// How a reader marks a bot's push that landed at `at` naming grant `grant` (`None` when the
/// grant no longer reads: its granter deleted it later, which takes nothing back), given when the
/// bot's current Bot row was written and whether the notice in force at `at` allowed pushing
/// (`None`: no notice at all, which the grant alone then decides).
#[must_use]
pub fn mark(
    at: u64,
    grant: Option<&PushGrant>,
    bot_row_at: Option<u64>,
    notice_allows_push: Option<bool>,
) -> PushMark {
    let older = matches!((grant, bot_row_at), (Some(g), Some(row)) if g.created_at < row);
    let before_row = bot_row_at.is_some_and(|row| at < row);
    if older && !before_row || notice_allows_push == Some(false) {
        PushMark::Outside
    } else {
        PushMark::Granted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant(prefix: Option<&str>, scope: Option<&str>, until: u64, at: u64) -> PushGrant {
        PushGrant {
            id: format!("g{at}"),
            granter: "M".into(),
            bot: platform::encode_identifier([7; 32]),
            prefix: prefix.map(str::to_owned),
            scope: scope.map(str::to_owned),
            until,
            created_at: at,
        }
    }

    fn ctx(maintainers: &BTreeSet<String>) -> GrantContext<'_> {
        GrantContext {
            now: 100,
            bot_row_at: Some(10),
            maintainers,
        }
    }

    #[test]
    fn a_prefix_grant_covers_names_that_start_with_it() {
        let g = grant(Some("refs/heads/bot/ci-bot/"), None, 200, 20);
        assert!(g.covers(&PushTarget::Public("refs/heads/bot/ci-bot/fix")));
        assert!(!g.covers(&PushTarget::Public("refs/heads/bot/ci-bot2")));
        assert!(!g.covers(&PushTarget::Exact("aa")));
    }

    #[test]
    fn pick_takes_the_usable_grant_that_ends_last() {
        let m: BTreeSet<String> = ["M".to_string()].into();
        let a = grant(Some("refs/heads/x/"), None, 150, 20);
        let b = grant(Some("refs/heads/x/"), None, 300, 30);
        let gs = [a, b];
        let got = pick(&gs, &PushTarget::Public("refs/heads/x/1"), &ctx(&m)).unwrap();
        assert_eq!(got.until, 300);
        let old = [grant(Some("refs/heads/x/"), None, 300, 5)];
        assert_eq!(
            pick(&old, &PushTarget::Public("refs/heads/x/1"), &ctx(&m)),
            Err(NoGrant::Unusable(Unusable::OlderThanBotRow))
        );
        assert_eq!(
            pick(&old, &PushTarget::Public("refs/heads/y"), &ctx(&m)),
            Err(NoGrant::NotCovered)
        );
    }

    #[test]
    fn patterns_become_branch_prefixes() {
        assert_eq!(prefix_of("bot/ci-bot/*").unwrap(), "refs/heads/bot/ci-bot/");
        assert_eq!(prefix_of("gh-pages").unwrap(), "refs/heads/gh-pages");
        assert_eq!(prefix_of("refs/tags/v1"), Err(PatternRefusal::NotABranch));
        assert_eq!(prefix_of("bot/*/x"), Err(PatternRefusal::NotAPrefix));
        assert_eq!(prefix_of("refs/heads/"), Err(PatternRefusal::Malformed));
    }

    #[test]
    fn until_is_bounded() {
        assert_eq!(until_for(0, None), Ok(DEFAULT_TTL_MS));
        assert_eq!(until_for(10, Some(5)), Err(UntilRefusal::Past));
        assert_eq!(
            until_for(0, Some(MAX_TTL_MS + 1)),
            Err(UntilRefusal::TooFar)
        );
        assert_eq!(
            until_for(0, Some(MAX_TTL_MS)),
            Ok(MAX_TTL_MS - TTL_MARGIN_MS)
        );
    }

    #[test]
    fn readers_mark_an_older_grant_and_a_suspension() {
        let g = grant(Some("refs/heads/x/"), None, 300, 5);
        assert_eq!(mark(50, Some(&g), Some(10), Some(true)), PushMark::Outside);
        assert_eq!(mark(50, Some(&g), Some(1), Some(true)), PushMark::Granted);
        assert_eq!(mark(50, Some(&g), Some(1), Some(false)), PushMark::Outside);
        assert_eq!(mark(50, None, Some(1), None), PushMark::Granted);
    }
}
