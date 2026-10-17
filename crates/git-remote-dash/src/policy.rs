//! The push-side storage policy: read from git config, shown to the user before anything
//! is paid for, and guarded by an optional cost threshold.
//!
//! git config keys (all optional; per-remote `remote.<name>.dash<Key>` wins over `dash.<key>`):
//!
//! | key | meaning |
//! |---|---|
//! | `dash.storage` | comma-separated profile names from `storage.toml` (`platform` is built in). Unset = Platform only. |
//! | `dash.replicas` | N: the push fails unless N targets confirm. Default: every listed target. |
//! | `dash.platformFallback` | store on Platform when the external targets cannot confirm N. |
//! | `dash.costWarnThreshold` | DASH; a push estimated above it asks for confirmation. Default 0.05; `off` turns the threshold off. |
//! | `dash.confirm` | `auto` (default: ask above the threshold, and before storing over 1 MiB of packs on Platform when `dash.storage` is unset), `always`, `never`, `refuse` (never ask: above the threshold, fail; for unattended callers such as forge-import). |
//! | `dash.allowPrivateUri` | record a profile's non-public read address (loopback, LAN, plain http, a temporary tunnel) anyway; `git push -o allow-private-uri` does the same for one push. |
//!
//! The helper's stdin/stdout belong to git, so confirmation is read from `/dev/tty`. With
//! no terminal (CI, a GUI client) a push that needs confirmation fails with a message
//! naming the two settings that resolve it — it never guesses "yes".

use std::io::{BufRead as _, Write as _};

use anyhow::{anyhow, bail, Result};
use forge_core::repo::credits_to_dash;
use forge_core::storage::policy::{
    parse_cost_warn_threshold, parse_git_bool, pick_scoped, DEFAULT_COST_WARN_THRESHOLD_DASH,
    UNCONFIGURED_PLATFORM_ASK_BYTES,
};
use forge_core::storage::publish::{
    refuse_unpublishable, ALLOW_PRIVATE_URI_GIT_KEY, ALLOW_PRIVATE_URI_PUSH_OPTION,
};
use forge_core::storage::{human_bytes, ResolvedPolicy, StoragePolicy, StorageProfiles};
use forge_core::user_error::{codes, dash, UserError};

use crate::git::LocalRepo;
use crate::options::OptionState;

/// How to treat a cost above the threshold.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ConfirmMode {
    /// Ask only when the estimate exceeds `dash.costWarnThreshold`.
    #[default]
    Auto,
    /// Ask before every paid push.
    Always,
    /// Never ask (print the estimate and proceed).
    Never,
    /// Never ask, even with a terminal: above the threshold the push fails (E801). For
    /// unattended callers that set the threshold as a hard cap (forge-import, the Mirror
    /// Action), where a prompt would either block or let a "y" spend past the cap.
    Refuse,
}

impl ConfirmMode {
    fn parse(v: &str) -> Result<Self> {
        match v.trim().to_ascii_lowercase().as_str() {
            "" | "auto" => Ok(Self::Auto),
            "always" | "true" | "yes" => Ok(Self::Always),
            "never" | "false" | "no" => Ok(Self::Never),
            "refuse" => Ok(Self::Refuse),
            other => bail!("dash.confirm must be auto, always, never or refuse (got {other:?})"),
        }
    }
}

/// Everything the push needs to know about where bytes go and what it may spend.
#[derive(Debug)]
pub struct PushPolicy {
    /// The resolved targets (each external one carries its profile).
    pub resolved: ResolvedPolicy,
    /// `dash.costWarnThreshold`, in DASH: 0.05 when unset, `None` when set to `off`.
    pub cost_warn_threshold: Option<f64>,
    /// Whether `dash.storage` (or the remote's `dashStorage`) is set. Unset means packs go to
    /// Platform because nobody chose it, so a large one asks first.
    pub storage_configured: bool,
    /// `dash.confirm`.
    pub confirm: ConfirmMode,
    /// `dash.allowPrivateUri`.
    pub allow_private_uri: bool,
}

/// The effective value of a setting that exists both per remote
/// (`remote.<remote>.<remote_key>`) and repo-wide (`dash.<key>`), by the scope rule of
/// [`pick_scoped`].
pub(crate) fn config_value(remote: Option<&str>, remote_key: &str, key: &str) -> Option<String> {
    let per_remote =
        remote.and_then(|r| LocalRepo::config_get_scoped(&format!("remote.{r}.{remote_key}")));
    let repo_wide = LocalRepo::config_get_scoped(&format!("dash.{key}"));
    pick_scoped(per_remote, repo_wide)
}

impl PushPolicy {
    /// Load the policy for a push through `remote` (the git remote name, when named).
    pub fn load(remote: Option<&str>) -> Result<Self> {
        let storage = config_value(remote, "dashStorage", "storage");
        let raw = StoragePolicy::from_git_values(
            storage.as_deref(),
            config_value(remote, "dashReplicas", "replicas").as_deref(),
            config_value(remote, "dashPlatformFallback", "platformFallback").as_deref(),
        )?;
        // Profiles are only needed when the policy names one; a Platform-only push must
        // keep working even if storage.toml is broken or absent.
        let profiles = if raw.is_platform_only() {
            StorageProfiles::load().unwrap_or_default()
        } else {
            StorageProfiles::load()?
        };
        let resolved = raw.resolve(&profiles)?;
        let cost_warn_threshold =
            match config_value(remote, "dashCostWarnThreshold", "costWarnThreshold") {
                Some(v) => parse_cost_warn_threshold(&v)?,
                None => Some(DEFAULT_COST_WARN_THRESHOLD_DASH),
            };
        let storage_configured = storage.is_some_and(|v| !v.trim().is_empty());
        let confirm = config_value(remote, "dashConfirm", "confirm")
            .map(|v| ConfirmMode::parse(&v))
            .transpose()?
            .unwrap_or_default();
        let allow_private_uri = config_value(remote, "dashAllowPrivateUri", "allowPrivateUri")
            .map(|v| parse_git_bool(ALLOW_PRIVATE_URI_GIT_KEY, &v))
            .transpose()?
            .unwrap_or(false);
        Ok(Self {
            resolved,
            cost_warn_threshold,
            storage_configured,
            confirm,
            allow_private_uri,
        })
    }

    /// [`Self::load`], then refuse (E501) when a target would record a read address that
    /// is not public https — before anything is built, uploaded or paid for — unless the
    /// push option `allow-private-uri`, `dash.allowPrivateUri` or the profile's
    /// `allow_private_uri` allows it.
    pub fn load_for_push(remote: Option<&str>, options: &OptionState) -> Result<Self> {
        let policy = Self::load(remote)?;
        policy.check_publishable(options.has_push_option(ALLOW_PRIVATE_URI_PUSH_OPTION))?;
        Ok(policy)
    }

    // A refusal happens at most once per push; boxing it buys nothing.
    #[allow(clippy::result_large_err)]
    fn check_publishable(&self, push_option: bool) -> std::result::Result<(), UserError> {
        refuse_unpublishable(
            self.resolved.external.iter().map(|(n, p)| (n.as_str(), p)),
            push_option || self.allow_private_uri,
            "push not started",
            Some(&format!("git push -o {ALLOW_PRIVATE_URI_PUSH_OPTION} …")),
        )
    }
}

/// The cost-guard refusal note when nothing at all has been stored yet.
pub const NOTE_NOTHING_STORED: &str = "nothing was stored or paid for";

/// The note when a later pack of the same push is stopped: an earlier one is already stored
/// and paid for (a push with a public pack and members-only packs uploads them in turn).
pub const NOTE_EARLIER_PACK_STORED: &str =
    "an earlier pack of this push is already stored and paid for; nothing further was written";

/// The note when the guard stops the Platform fallback: the external copies that confirmed
/// are already stored (and kept), but Platform was not paid.
pub const NOTE_NOTHING_PAID_ON_PLATFORM: &str =
    "nothing was paid for on Platform; the copies your storage confirmed are kept";

/// What the cost guard decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Guard {
    /// Go ahead.
    Proceed,
    /// Ask the user on the terminal.
    Ask(String),
    /// Refuse: no terminal to ask on. Carries the cause (one line) and why it needed a yes.
    Refuse(String, Why),
}

/// Why the guard needed a yes: the fix differs (raising the threshold does not help a push
/// that is stopped for storing permanently on Platform).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Why {
    /// The estimate is above `dash.costWarnThreshold`.
    Threshold,
    /// More than 1 MiB of packs would go to Platform with `dash.storage` unset.
    UnchosenStorage,
    /// `dash.confirm = always`.
    Always,
}

/// Decide whether a push estimated at `credits` may proceed. `unchosen_platform_bytes`: the
/// pack bytes this push stores on Platform although `dash.storage` is unset (0 when storage is
/// chosen, or the push stores no pack); over [`UNCONFIGURED_PLATFORM_ASK_BYTES`] it asks even
/// under the threshold, in `auto` mode only: `refuse` is a hard cap set by the caller (its
/// threshold), and `never` accepts any price.
pub fn guard(
    credits: u64,
    threshold_dash: Option<f64>,
    mode: ConfirmMode,
    have_tty: bool,
    unchosen_platform_bytes: u64,
) -> Guard {
    let est = credits_to_dash(credits);
    let over = threshold_dash.is_some_and(|t| est > t);
    let unchosen = mode == ConfirmMode::Auto
        && credits > 0
        && unchosen_platform_bytes > UNCONFIGURED_PLATFORM_ASK_BYTES;
    let must_ask = match mode {
        ConfirmMode::Never => false,
        ConfirmMode::Always => credits > 0,
        ConfirmMode::Auto | ConfirmMode::Refuse => over || unchosen,
    };
    if !must_ask {
        return Guard::Proceed;
    }
    if have_tty && mode != ConfirmMode::Refuse {
        Guard::Ask(match threshold_dash {
            Some(t) if over => format!(
                "This push costs about {} DASH, above dash.costWarnThreshold ({t}).",
                dash(credits)
            ),
            _ if unchosen => format!(
                "This push stores {} on Platform (about {} DASH), permanently: Platform packs \
                 cannot be deleted, and dash.storage is not set.",
                human_bytes(unchosen_platform_bytes),
                dash(credits)
            ),
            _ => format!("This push costs about {} DASH.", dash(credits)),
        })
    } else {
        match threshold_dash {
            Some(t) if over => Guard::Refuse(
                format!(
                    "this push would cost ~{} DASH, above dash.costWarnThreshold ({t})",
                    dash(credits)
                ),
                Why::Threshold,
            ),
            _ if unchosen => Guard::Refuse(
                format!(
                    "this push would store {} on Platform (~{} DASH), permanently, and dash.storage is not set",
                    human_bytes(unchosen_platform_bytes),
                    dash(credits)
                ),
                Why::UnchosenStorage,
            ),
            _ => Guard::Refuse(
                format!(
                    "this push would cost ~{} DASH and dash.confirm = always",
                    dash(credits)
                ),
                Why::Always,
            ),
        }
    }
}

fn open_tty() -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
}

/// Ask `question` on `/dev/tty`; `Ok(true)` only for an explicit yes.
pub fn ask_on_tty(question: &str) -> Result<bool> {
    let mut tty = open_tty().map_err(|e| anyhow!("opening /dev/tty: {e}"))?;
    write!(tty, "{question} Proceed? [y/N] ")?;
    tty.flush()?;
    let mut line = String::new();
    std::io::BufReader::new(&tty).read_line(&mut line)?;
    Ok(matches!(
        line.trim().to_ascii_lowercase().as_str(),
        "y" | "yes"
    ))
}

/// Whether a controlling terminal is available.
pub fn have_tty() -> bool {
    open_tty().is_ok()
}

/// Run the guard end to end: `Ok(())` to proceed, the user-facing refusal otherwise.
/// `platform_bytes`: whether this push stores the pack itself on Platform (the expensive
/// case, where adding your own storage is the fix).
// A refusal happens at most once per push; boxing it buys nothing.
#[allow(clippy::result_large_err)]
pub fn enforce(
    credits: u64,
    policy: &PushPolicy,
    platform_bytes: bool,
    note: &'static str,
) -> std::result::Result<(), UserError> {
    enforce_pack(credits, 0, policy, platform_bytes, note)
}

/// [`enforce`] for a push that stores a `pack_bytes`-byte pack (sealed length): with no
/// `dash.storage`, a pack over 1 MiB headed for Platform asks even under the threshold.
// A refusal happens at most once per push; boxing it buys nothing.
#[allow(clippy::result_large_err)]
pub fn enforce_pack(
    credits: u64,
    pack_bytes: u64,
    policy: &PushPolicy,
    platform_bytes: bool,
    note: &'static str,
) -> std::result::Result<(), UserError> {
    let unchosen_platform_bytes = if platform_bytes && !policy.storage_configured {
        pack_bytes
    } else {
        0
    };
    // Only look for a terminal when the guard could actually ask (no /dev/tty open on a
    // push that is under the threshold, or has `dash.confirm` never/refuse).
    let could_ask = match policy.confirm {
        ConfirmMode::Never | ConfirmMode::Refuse => false,
        ConfirmMode::Always => credits > 0,
        ConfirmMode::Auto => {
            policy.cost_warn_threshold.is_some()
                || unchosen_platform_bytes > UNCONFIGURED_PLATFORM_ASK_BYTES
        }
    };
    let tty = could_ask && have_tty();
    match guard(
        credits,
        policy.cost_warn_threshold,
        policy.confirm,
        tty,
        unchosen_platform_bytes,
    ) {
        Guard::Proceed => Ok(()),
        Guard::Refuse(cause, why) => Err(refusal(&cause, why, platform_bytes).note(note)),
        Guard::Ask(q) => match ask_on_tty(&q) {
            Ok(true) => Ok(()),
            Ok(false) => Err(UserError::new(
                codes::CANCELLED,
                "push cancelled at the cost confirmation",
            )
            .note(note)),
            Err(e) => Err(UserError::new(
                codes::CONFIRMATION_REQUIRED,
                "push stopped: could not confirm its cost",
            )
            .cause(format!(
                "{q} Reading the answer on the terminal failed: {e}"
            ))
            .fix("run `git -c dash.confirm=never push …` to accept the price")
            .note(note)),
        },
    }
}

/// The pre-flight affordability check (ECON-04): refuse, before any upload, a push whose
/// estimate (an upper bound) exceeds the identity's balance (E401) or the signing key's
/// remaining budget (E402). `None` means that figure could not be read, or does not apply
/// (a key without a budget): it never blocks. Pure, so the decision is testable offline.
// A refusal happens at most once per push; boxing it buys nothing.
#[allow(clippy::result_large_err)]
pub fn check_affordable(
    est_credits: u64,
    balance: Option<u64>,
    budget_left: Option<u64>,
    testnet: bool,
    note: &str,
) -> std::result::Result<(), UserError> {
    if let Some(have) = balance.filter(|b| est_credits > *b) {
        let u = UserError::new(
            codes::INSUFFICIENT_CREDITS,
            "push stopped: not enough credits",
        )
        .cause(format!(
            "this push is estimated at {} DASH (an upper bound); the identity has {} DASH",
            dash(est_credits),
            dash(have)
        ))
        .fix(format!(
            "top up the identity from any Dash wallet at {} (`dg auth balance` shows the balance)",
            forge_core::user_error::TOP_UP_URL
        ));
        let u = if testnet {
            u.fix("on testnet the faucets at https://faucet.testnet.networks.dash.org and https://faucet.thepasta.org fund an identity")
        } else {
            u
        };
        return Err(u
            .fix("or push a smaller change, or store packs on your own storage (`dg storage add`)")
            .fix("the estimate is an upper bound: a balance only just above the real cost can still be refused, and a small top-up fixes it")
            .note(note));
    }
    if let Some(left) = budget_left.filter(|b| est_credits > *b) {
        return Err(UserError::new(
            codes::KEY_BUDGET_SPENT,
            "push stopped: this key's budget is too low",
        )
        .cause(format!(
            "this push is estimated at {} DASH (an upper bound); the signing key has {} DASH of budget left",
            dash(est_credits),
            dash(left)
        ))
        .fix(format!(
            "register a key with a bigger budget (uses your master key once): `dg auth keys add --budget {}`",
            budget_suggestion(est_credits)
        ))
        .fix("the estimate is an upper bound: a budget only just above the real cost can still be refused, and a bigger key budget fixes it")
        .note(format!("{note}; the identity's balance is untouched")));
    }
    Ok(())
}

/// A whole-DASH `--budget` that covers `est_credits` (a limited key's budget is a DASH amount).
fn budget_suggestion(est_credits: u64) -> String {
    format!("{}", credits_to_dash(est_credits).ceil().max(1.0))
}

/// E801: the cost guard needed a yes and had no terminal to ask on (spec §7.3 example 3).
/// The fix follows `why`: a threshold can be raised, but a push stopped for storing on
/// Platform with no `dash.storage` is fixed by choosing storage (or accepting Platform).
pub fn refusal(cause: &str, why: Why, platform_bytes: bool) -> UserError {
    let u = UserError::new(codes::COST_GUARD, "push stopped by the cost guard")
        .cause(format!("{cause}; no terminal to confirm on"));
    let u = match why {
        Why::UnchosenStorage => u
            .fix("add storage (`dg storage add`, then `dg storage use`) so packs go to your bucket")
            .fix("or say Platform is what you want: `git config dash.storage platform`")
            .fix("or accept the price for this push: `git -c dash.confirm=never push`"),
        Why::Threshold | Why::Always => {
            let u = if platform_bytes {
                u.fix("add storage (`dg storage add`, then `dg storage use`) so packs go to your bucket, or run `git -c dash.confirm=never push` to accept the price")
            } else {
                u.fix("run `git -c dash.confirm=never push` to accept the price")
            };
            if why == Why::Threshold {
                u.fix("raise `git config dash.costWarnThreshold` (DASH), or set it to `off`")
            } else {
                u
            }
        }
    };
    u.note(NOTE_NOTHING_STORED)
}

/// Whether `credits` is above this push's `dash.costWarnThreshold` in a mode that weighs it:
/// the one case where a cheaper plan (the history-index delta) can change the answer.
pub fn over_threshold(credits: u64, policy: &PushPolicy) -> bool {
    matches!(policy.confirm, ConfirmMode::Auto | ConfirmMode::Refuse)
        && policy
            .cost_warn_threshold
            .is_some_and(|t| credits_to_dash(credits) > t)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g(credits: u64, threshold: Option<f64>, mode: ConfirmMode, tty: bool) -> Guard {
        guard(credits, threshold, mode, tty, 0)
    }

    #[test]
    fn guard_decisions() {
        let one_dash = forge_core::cost::CREDITS_PER_DASH;
        // The threshold turned off (`dash.costWarnThreshold = off`), auto → proceed silently.
        assert_eq!(g(one_dash, None, ConfirmMode::Auto, false), Guard::Proceed);
        // Under the threshold → proceed.
        assert_eq!(
            g(one_dash / 100, Some(0.1), ConfirmMode::Auto, false),
            Guard::Proceed
        );
        // Over, with a terminal → ask.
        assert!(matches!(
            g(one_dash, Some(0.1), ConfirmMode::Auto, true),
            Guard::Ask(_)
        ));
        // Refuse never asks, even with a terminal; under the threshold it proceeds.
        assert!(matches!(
            g(one_dash, Some(0.1), ConfirmMode::Refuse, true),
            Guard::Refuse(..)
        ));
        assert_eq!(
            g(one_dash / 100, Some(0.1), ConfirmMode::Refuse, true),
            Guard::Proceed
        );
        // Over, no terminal → refuse with the fix.
        let Guard::Refuse(cause, why) = g(one_dash, Some(0.1), ConfirmMode::Auto, false) else {
            panic!("expected refuse");
        };
        assert!(
            cause.contains("above dash.costWarnThreshold (0.1)"),
            "{cause}"
        );
        let u = refusal(&cause, why, true);
        assert_eq!((u.code, u.exit_code()), ("E801", 8));
        let text = u.render("dash: ", false);
        assert!(
            text.contains("dash.confirm=never") && text.contains("costWarnThreshold"),
            "{text}"
        );
        assert!(text.contains("no terminal to confirm on"), "{text}");
        assert!(text.contains("dg storage add"), "{text}");
        assert_eq!(why, Why::Threshold);
        assert!(!refusal(&cause, why, false).fix[0].contains("dg storage add"));
        // never → proceed regardless; always → ask even when cheap.
        assert_eq!(
            g(one_dash, Some(0.1), ConfirmMode::Never, false),
            Guard::Proceed
        );
        assert!(matches!(
            g(10, None, ConfirmMode::Always, true),
            Guard::Ask(_)
        ));
    }

    #[test]
    fn more_specific_scope_wins_then_per_remote() {
        let s = |scope: &str, v: &str| Some((scope.to_string(), v.to_string()));
        // Repo-local dash.storage beats a global per-remote key.
        assert_eq!(
            pick_scoped(s("global", "remote"), s("local", "repo")).as_deref(),
            Some("repo")
        );
        // Same scope: the per-remote key wins.
        assert_eq!(
            pick_scoped(s("local", "remote"), s("local", "repo")).as_deref(),
            Some("remote")
        );
        // `git -c` beats everything.
        assert_eq!(
            pick_scoped(s("local", "remote"), s("command", "cli")).as_deref(),
            Some("cli")
        );
        assert_eq!(pick_scoped(None, s("global", "g")).as_deref(), Some("g"));
        assert_eq!(pick_scoped(None, None), None);
    }

    #[test]
    fn a_non_public_read_address_is_refused_unless_allowed() {
        let profiles = StorageProfiles::parse(
            "[profiles.loop]\nkind = \"s3\"\nendpoint = \"http://127.0.0.1:9000\"\nbucket = \"b\"\n\
             public_url = \"http://127.0.0.1:9000/b\"\n\
             [profiles.pub]\nkind = \"s3\"\nendpoint = \"https://a.r2.cloudflarestorage.com\"\n\
             bucket = \"b\"\npublic_url = \"https://files.example.org\"\n",
        )
        .unwrap();
        let policy = |targets: &str, allow: bool| PushPolicy {
            resolved: StoragePolicy::from_git_values(Some(targets), Some("1"), None)
                .unwrap()
                .resolve(&profiles)
                .unwrap(),
            cost_warn_threshold: None,
            storage_configured: true,
            confirm: ConfirmMode::Auto,
            allow_private_uri: allow,
        };
        let err = policy("pub,loop", false)
            .check_publishable(false)
            .unwrap_err();
        assert_eq!(err.code, "E501");
        let text = err.render("dash: ", false);
        assert!(text.contains("push not started"), "{text}");
        assert!(text.contains("-o allow-private-uri"), "{text}");
        // The push option, and git config, each allow it.
        assert!(policy("pub,loop", false).check_publishable(true).is_ok());
        assert!(policy("pub,loop", true).check_publishable(false).is_ok());
        assert!(policy("pub", false).check_publishable(false).is_ok());
    }

    #[test]
    fn an_unchosen_platform_pack_over_a_mebibyte_asks_even_under_the_threshold() {
        let cheap = forge_core::cost::CREDITS_PER_DASH / 1000;
        let mib = UNCONFIGURED_PLATFORM_ASK_BYTES;
        let big = |mode, tty, bytes| guard(cheap, Some(1.0), mode, tty, bytes);
        // Up to 1 MiB (or storage chosen: the caller passes 0) → no extra ask.
        assert_eq!(big(ConfirmMode::Auto, true, mib), Guard::Proceed);
        assert_eq!(big(ConfirmMode::Auto, true, 0), Guard::Proceed);
        // Over it, with a terminal → ask, naming the permanence and the size.
        let Guard::Ask(q) = big(ConfirmMode::Auto, true, mib + 1) else {
            panic!("expected ask");
        };
        assert!(q.contains("permanently") && q.contains("1.0 MiB"), "{q}");
        assert!(q.contains("dash.storage is not set"), "{q}");
        // No terminal → refuse (E801) with the storage fix.
        let Guard::Refuse(cause, why) = big(ConfirmMode::Auto, false, 3 * mib) else {
            panic!("expected refuse");
        };
        assert!(cause.contains("3.0 MiB on Platform"), "{cause}");
        let u = refusal(&cause, why, true);
        assert_eq!((u.code, u.exit_code()), ("E801", 8));
        assert_eq!(why, Why::UnchosenStorage);
        let text = u.render("dash: ", false);
        // The fix is storage (or Platform on purpose, or accepting the price), never the threshold.
        for want in [
            "dg storage add",
            "dash.storage platform",
            "dash.confirm=never",
        ] {
            assert!(text.contains(want), "{want}: {text}");
        }
        assert!(!text.contains("costWarnThreshold"), "{text}");
        // `refuse` is the caller's hard cap (its threshold) and `never` accepts any price: no extra ask.
        assert_eq!(big(ConfirmMode::Never, false, 3 * mib), Guard::Proceed);
        assert_eq!(big(ConfirmMode::Refuse, false, 3 * mib), Guard::Proceed);
        // Nothing to pay, nothing to ask.
        assert_eq!(
            guard(0, Some(1.0), ConfirmMode::Auto, true, 3 * mib),
            Guard::Proceed
        );
    }

    #[test]
    fn enforce_pack_counts_platform_bytes_only_when_storage_is_unset() {
        let policy = |configured: bool| PushPolicy {
            resolved: StoragePolicy::platform_only()
                .resolve(&StorageProfiles::default())
                .unwrap(),
            cost_warn_threshold: Some(1.0),
            storage_configured: configured,
            confirm: ConfirmMode::Auto,
            allow_private_uri: false,
        };
        let cheap = forge_core::cost::CREDITS_PER_DASH / 1000;
        let big = 5 * UNCONFIGURED_PLATFORM_ASK_BYTES;
        // Without a terminal the unchosen big pack is refused (a test run with a controlling
        // terminal would prompt instead, so that half is asserted only when there is none) ...
        if !have_tty() {
            let e =
                enforce_pack(cheap, big, &policy(false), true, NOTE_NOTHING_STORED).unwrap_err();
            assert_eq!(e.code, "E801");
        }
        // ... unless storage was chosen (even `platform`), the pack goes elsewhere, or is small.
        assert!(enforce_pack(cheap, big, &policy(true), true, NOTE_NOTHING_STORED).is_ok());
        assert!(enforce_pack(cheap, big, &policy(false), false, NOTE_NOTHING_STORED).is_ok());
        assert!(enforce_pack(cheap, 1000, &policy(false), true, NOTE_NOTHING_STORED).is_ok());
    }

    #[test]
    fn only_a_priced_out_push_may_fall_back_to_the_cheaper_history_delta() {
        let policy = |confirm, threshold| PushPolicy {
            resolved: StoragePolicy::platform_only()
                .resolve(&StorageProfiles::default())
                .unwrap(),
            cost_warn_threshold: threshold,
            storage_configured: false,
            confirm,
            allow_private_uri: false,
        };
        let one = forge_core::cost::CREDITS_PER_DASH;
        assert!(over_threshold(one, &policy(ConfirmMode::Auto, Some(0.1))));
        assert!(over_threshold(one, &policy(ConfirmMode::Refuse, Some(0.1))));
        // Under the threshold (the storage rule declined), no threshold, `always`, `never`.
        assert!(!over_threshold(
            one / 100,
            &policy(ConfirmMode::Auto, Some(0.1))
        ));
        assert!(!over_threshold(one, &policy(ConfirmMode::Auto, None)));
        assert!(!over_threshold(
            one,
            &policy(ConfirmMode::Always, Some(0.1))
        ));
        assert!(!over_threshold(one, &policy(ConfirmMode::Never, Some(0.1))));
    }

    #[test]
    fn the_default_threshold_applies_when_unset() {
        let one_dash = forge_core::cost::CREDITS_PER_DASH;
        let t = Some(DEFAULT_COST_WARN_THRESHOLD_DASH);
        assert!(matches!(
            g(one_dash, t, ConfirmMode::Auto, true),
            Guard::Ask(_)
        ));
        assert_eq!(
            g(one_dash / 100, t, ConfirmMode::Auto, true),
            Guard::Proceed
        );
    }

    #[test]
    fn a_push_the_identity_or_key_cannot_afford_is_refused_before_it_uploads() {
        let dash1 = forge_core::cost::CREDITS_PER_DASH;
        let est = dash1 / 2;
        // Affordable on both counts, or nothing readable / no budget: proceed.
        assert!(
            check_affordable(est, Some(dash1), Some(dash1), false, NOTE_NOTHING_STORED).is_ok()
        );
        assert!(check_affordable(est, Some(est), Some(est), false, NOTE_NOTHING_STORED).is_ok());
        assert!(check_affordable(est, None, None, false, NOTE_NOTHING_STORED).is_ok());
        assert!(check_affordable(est, Some(dash1), None, true, NOTE_NOTHING_STORED).is_ok());
        // The balance is short: E401, with the top-up (and the faucet on testnet).
        let u = check_affordable(est, Some(est - 1), Some(dash1), true, NOTE_NOTHING_STORED)
            .unwrap_err();
        assert!(u.render("dash: ", false).contains("upper bound"));
        // A later pack of a push whose first pack is paid does not claim nothing was paid.
        let later =
            check_affordable(est, Some(0), None, false, NOTE_EARLIER_PACK_STORED).unwrap_err();
        let text = later.render("dash: ", false);
        assert!(!text.contains("nothing was stored or paid for"), "{text}");
        assert!(text.contains("already stored and paid for"), "{text}");
        assert_eq!((u.code, u.exit_code()), ("E401", 4));
        let text = u.render("dash: ", false);
        assert!(text.contains("estimated at 0.5000 DASH"), "{text}");
        assert!(text.contains("faucet.testnet.networks.dash.org"), "{text}");
        assert!(text.contains("faucet.thepasta.org"), "{text}");
        assert!(text.contains(NOTE_NOTHING_STORED), "{text}");
        let mainnet = check_affordable(est, Some(0), None, false, NOTE_NOTHING_STORED).unwrap_err();
        assert!(!mainnet.render("dash: ", false).contains("faucet"));
        // The key's budget is short: E402, naming `dg auth keys add --budget`.
        let u = check_affordable(est, Some(dash1), Some(est - 1), false, NOTE_NOTHING_STORED)
            .unwrap_err();
        assert_eq!(u.code, "E402");
        let text = u.render("dash: ", false);
        assert!(text.contains("dg auth keys add --budget 1"), "{text}");
        // Both short: the balance is the more basic problem.
        let u = check_affordable(est, Some(0), Some(0), false, NOTE_NOTHING_STORED).unwrap_err();
        assert_eq!(u.code, "E401");
        // A spent budget (Some(0)) refuses any paid push.
        assert_eq!(
            check_affordable(1, Some(dash1), Some(0), false, NOTE_NOTHING_STORED)
                .unwrap_err()
                .code,
            "E402"
        );
    }

    #[test]
    fn confirm_mode_parsing() {
        assert_eq!(ConfirmMode::parse("").unwrap(), ConfirmMode::Auto);
        assert_eq!(ConfirmMode::parse("Never").unwrap(), ConfirmMode::Never);
        assert_eq!(ConfirmMode::parse("always").unwrap(), ConfirmMode::Always);
        assert!(ConfirmMode::parse("sometimes").is_err());
    }
}
