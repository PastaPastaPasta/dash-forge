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
//! | `dash.costWarnThreshold` | DASH; a push estimated above it asks for confirmation. |
//! | `dash.confirm` | `auto` (default: ask only above the threshold), `always`, `never`. |
//!
//! The helper's stdin/stdout belong to git, so confirmation is read from `/dev/tty`. With
//! no terminal (CI, a GUI client) a push that needs confirmation fails with a message
//! naming the two settings that resolve it — it never guesses "yes".

use std::io::{BufRead as _, Write as _};

use anyhow::{anyhow, bail, Result};
use forge_core::cost::estimate;
use forge_core::repo::credits_to_dash;
use forge_core::storage::policy::pick_scoped;
use forge_core::storage::{human_bytes, ResolvedPolicy, StoragePolicy, StorageProfiles};

use crate::git::LocalRepo;

/// Serialized size assumed for a `packManifest` document before its `uris` field.
const MANIFEST_BASE_BYTES: u64 = 220;
/// Serialized size assumed for a `refUpdate` document.
const REF_UPDATE_BYTES: u64 = 200;
/// Per-object row size of a browse-index fragment (36-byte rows + fanout overhead).
const LOCATOR_ROW_BYTES: u64 = 36;
/// Fixed browse-index header (256-entry u32 fanout + header).
const LOCATOR_HEADER_BYTES: u64 = 1_100;
/// Per-`chunk` document overhead on top of its payload.
const CHUNK_DOC_OVERHEAD: u64 = 120;

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
}

impl ConfirmMode {
    fn parse(v: &str) -> Result<Self> {
        match v.trim().to_ascii_lowercase().as_str() {
            "" | "auto" => Ok(Self::Auto),
            "always" | "true" | "yes" => Ok(Self::Always),
            "never" | "false" | "no" => Ok(Self::Never),
            other => bail!("dash.confirm must be auto, always or never (got {other:?})"),
        }
    }
}

/// Everything the push needs to know about where bytes go and what it may spend.
#[derive(Debug)]
pub struct PushPolicy {
    /// The resolved targets (each external one carries its profile).
    pub resolved: ResolvedPolicy,
    /// `dash.costWarnThreshold`, in DASH.
    pub cost_warn_threshold: Option<f64>,
    /// `dash.confirm`.
    pub confirm: ConfirmMode,
}

/// The effective value of a setting that exists both per remote
/// (`remote.<remote>.<remote_key>`) and repo-wide (`dash.<key>`), by the scope rule of
/// [`pick_scoped`].
fn config_value(remote: Option<&str>, remote_key: &str, key: &str) -> Option<String> {
    let per_remote =
        remote.and_then(|r| LocalRepo::config_get_scoped(&format!("remote.{r}.{remote_key}")));
    let repo_wide = LocalRepo::config_get_scoped(&format!("dash.{key}"));
    pick_scoped(per_remote, repo_wide)
}

impl PushPolicy {
    /// Load the policy for a push through `remote` (the git remote name, when named).
    pub fn load(remote: Option<&str>) -> Result<Self> {
        let raw = StoragePolicy::from_git_values(
            config_value(remote, "dashStorage", "storage").as_deref(),
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
            config_value(remote, "dashCostWarnThreshold", "costWarnThreshold")
                .map(|v| {
                    v.trim()
                .parse::<f64>()
                .ok()
                .filter(|x| x.is_finite() && *x >= 0.0)
                .ok_or_else(|| {
                    anyhow!("dash.costWarnThreshold must be a DASH amount like 0.01 (got {v:?})")
                })
                })
                .transpose()?;
        let confirm = config_value(remote, "dashConfirm", "confirm")
            .map(|v| ConfirmMode::parse(&v))
            .transpose()?
            .unwrap_or_default();
        Ok(Self {
            resolved,
            cost_warn_threshold,
            confirm,
        })
    }
}

/// A push's pre-flight cost estimate, split by what is written on-chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PushEstimate {
    /// Manifests + ref updates (always on Platform).
    pub metadata_credits: u64,
    /// Pack + browse-index `chunk` documents (only when Platform stores bytes).
    pub chunk_credits: u64,
}

impl PushEstimate {
    /// Total credits.
    pub fn total(&self) -> u64 {
        self.metadata_credits + self.chunk_credits
    }
}

fn chunk_credits(len: u64) -> u64 {
    let len = usize::try_from(len).unwrap_or(usize::MAX);
    let full = len / forge_core::pack::DOC_PAYLOAD_MAX;
    let rest = len % forge_core::pack::DOC_PAYLOAD_MAX;
    let full_doc = estimate(forge_core::pack::DOC_PAYLOAD_MAX as u64 + CHUNK_DOC_OVERHEAD).total();
    let mut total = full_doc.saturating_mul(full as u64);
    if rest > 0 {
        total += estimate(rest as u64 + CHUNK_DOC_OVERHEAD).total();
    }
    total
}

/// Estimate what a push writes on-chain: two manifests (pack + browse-index fragment), a
/// ref update per ref, and — only when Platform stores bytes — the chunk documents.
pub fn estimate_push(
    pack_bytes: u64,
    object_count: u64,
    ref_count: usize,
    uris_json_len: u64,
    platform_bytes: bool,
) -> PushEstimate {
    let manifest = estimate(MANIFEST_BASE_BYTES + uris_json_len).total();
    let refs = estimate(REF_UPDATE_BYTES).total() * ref_count as u64;
    let locator_len = LOCATOR_HEADER_BYTES + LOCATOR_ROW_BYTES * object_count;
    PushEstimate {
        metadata_credits: manifest * 2 + refs,
        chunk_credits: if platform_bytes {
            chunk_credits(pack_bytes) + chunk_credits(locator_len)
        } else {
            0
        },
    }
}

/// Format a DASH amount with enough precision for small pushes.
pub fn dash(credits: u64) -> String {
    let d = credits_to_dash(credits);
    if d == 0.0 {
        "0".into()
    } else if d < 0.001 {
        format!("{d:.6}")
    } else {
        format!("{d:.4}")
    }
}

/// The one-line "what goes where" summary printed before a push pays for anything.
pub fn plan_line(policy: &ResolvedPolicy, pack_bytes: u64, est: &PushEstimate) -> String {
    let external: Vec<String> = policy.external.iter().map(|(n, _)| n.clone()).collect();
    let size = human_bytes(pack_bytes);
    let destination = if external.is_empty() {
        "Platform chunks".to_string()
    } else if policy.platform {
        format!("{}, platform", external.join(", "))
    } else {
        external.join(", ")
    };
    let need = if policy.total() > 1 {
        format!(" (need {} of {})", policy.replicas, policy.total())
    } else {
        String::new()
    };
    let chain = if policy.platform {
        format!(
            "Platform: pack + manifest + refs, est. {} DASH",
            dash(est.total())
        )
    } else {
        format!(
            "Platform: manifest + refs only, est. {} DASH{}",
            dash(est.metadata_credits),
            if policy.platform_fallback {
                " (Platform fallback armed)"
            } else {
                ""
            }
        )
    };
    format!("dash: pack {size} → {destination}{need}; {chain}")
}

/// What the cost guard decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Guard {
    /// Go ahead.
    Proceed,
    /// Ask the user on the terminal.
    Ask(String),
    /// Refuse, with the message git should show.
    Refuse(String),
}

/// Decide whether a push estimated at `credits` may proceed.
pub fn guard(
    credits: u64,
    threshold_dash: Option<f64>,
    mode: ConfirmMode,
    have_tty: bool,
) -> Guard {
    let est = credits_to_dash(credits);
    let over = threshold_dash.is_some_and(|t| est > t);
    let must_ask = match mode {
        ConfirmMode::Never => false,
        ConfirmMode::Always => credits > 0,
        ConfirmMode::Auto => over,
    };
    if !must_ask {
        return Guard::Proceed;
    }
    let question = match threshold_dash {
        Some(t) if over => format!(
            "This push costs about {} DASH, above dash.costWarnThreshold ({t}).",
            dash(credits)
        ),
        _ => format!("This push costs about {} DASH.", dash(credits)),
    };
    if have_tty {
        Guard::Ask(question)
    } else {
        Guard::Refuse(format!(
            "{question} No terminal to confirm on — re-run with `git -c dash.confirm=never push …`, \
             or raise dash.costWarnThreshold"
        ))
    }
}

/// Ask `question` on `/dev/tty`; `Ok(true)` only for an explicit yes.
pub fn ask_on_tty(question: &str) -> Result<bool> {
    let mut tty = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .map_err(|e| anyhow!("opening /dev/tty: {e}"))?;
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
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .is_ok()
}

/// Run the guard end to end: `Ok(())` to proceed, `Err(reason)` (one line) to refuse.
pub fn enforce(credits: u64, policy: &PushPolicy) -> std::result::Result<(), String> {
    // Only look for a terminal when the guard could actually ask (no /dev/tty open on a
    // push that has no threshold and `dash.confirm` auto/never).
    let could_ask = match policy.confirm {
        ConfirmMode::Never => false,
        ConfirmMode::Always => credits > 0,
        ConfirmMode::Auto => policy.cost_warn_threshold.is_some(),
    };
    let tty = could_ask && have_tty();
    match guard(credits, policy.cost_warn_threshold, policy.confirm, tty) {
        Guard::Proceed => Ok(()),
        Guard::Refuse(msg) => Err(msg),
        Guard::Ask(q) => match ask_on_tty(&q) {
            Ok(true) => Ok(()),
            Ok(false) => Err("push cancelled at the cost confirmation".into()),
            Err(e) => Err(format!(
                "{q} Could not confirm on the terminal ({e}); set dash.confirm=never to skip"
            )),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(storage: Option<&str>, profiles: &str) -> ResolvedPolicy {
        StoragePolicy::from_git_values(storage, None, None)
            .unwrap()
            .resolve(&StorageProfiles::parse(profiles).unwrap())
            .unwrap()
    }

    const PROFILES: &str = "[profiles.r2-main]\nkind = \"s3\"\nendpoint = \"https://a.r2.cloudflarestorage.com\"\nbucket = \"b\"\n[profiles.kubo]\nkind = \"ipfs-kubo\"\napi = \"http://127.0.0.1:5001\"\n";

    #[test]
    fn external_policy_bills_metadata_only() {
        let ext = estimate_push(1_258_291, 300, 1, 200, false);
        assert_eq!(ext.chunk_credits, 0);
        let chain = estimate_push(1_258_291, 300, 1, 0, true);
        assert!(
            chain.chunk_credits > 100 * ext.metadata_credits,
            "{chain:?} vs {ext:?}"
        );
        // ~1.2 MiB of chunks is ~0.35 DASH (0.283 DASH/MiB deposit + burn).
        let d = credits_to_dash(chain.total());
        assert!((0.3..0.45).contains(&d), "{d}");
    }

    #[test]
    fn plan_line_says_what_goes_where() {
        let p = policy(Some("r2-main,kubo"), PROFILES);
        let est = estimate_push(1_258_291, 300, 1, 300, false);
        let line = plan_line(&p, 1_258_291, &est);
        assert!(
            line.starts_with("dash: pack 1.2 MiB → r2-main, kubo (need 2 of 2)"),
            "{line}"
        );
        assert!(
            line.contains("Platform: manifest + refs only, est. 0.00"),
            "{line}"
        );

        let p = policy(None, PROFILES);
        let est = estimate_push(4096, 3, 1, 0, true);
        let line = plan_line(&p, 4096, &est);
        assert!(
            line.starts_with("dash: pack 4.0 KiB → Platform chunks;"),
            "{line}"
        );
        assert!(line.contains("pack + manifest + refs"), "{line}");
    }

    #[test]
    fn guard_decisions() {
        let one_dash = forge_core::cost::CREDITS_PER_DASH;
        // No threshold, auto → proceed silently (today's behaviour).
        assert_eq!(
            guard(one_dash, None, ConfirmMode::Auto, false),
            Guard::Proceed
        );
        // Under the threshold → proceed.
        assert_eq!(
            guard(one_dash / 100, Some(0.1), ConfirmMode::Auto, false),
            Guard::Proceed
        );
        // Over, with a terminal → ask.
        assert!(matches!(
            guard(one_dash, Some(0.1), ConfirmMode::Auto, true),
            Guard::Ask(_)
        ));
        // Over, no terminal → refuse with the fix.
        let Guard::Refuse(msg) = guard(one_dash, Some(0.1), ConfirmMode::Auto, false) else {
            panic!("expected refuse");
        };
        assert!(
            msg.contains("dash.confirm=never") && msg.contains("costWarnThreshold"),
            "{msg}"
        );
        assert!(!msg.contains('\n'));
        // never → proceed regardless; always → ask even when cheap.
        assert_eq!(
            guard(one_dash, Some(0.1), ConfirmMode::Never, false),
            Guard::Proceed
        );
        assert!(matches!(
            guard(10, None, ConfirmMode::Always, true),
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
    fn confirm_mode_parsing() {
        assert_eq!(ConfirmMode::parse("").unwrap(), ConfirmMode::Auto);
        assert_eq!(ConfirmMode::parse("Never").unwrap(), ConfirmMode::Never);
        assert_eq!(ConfirmMode::parse("always").unwrap(), ConfirmMode::Always);
        assert!(ConfirmMode::parse("sometimes").is_err());
    }
}
