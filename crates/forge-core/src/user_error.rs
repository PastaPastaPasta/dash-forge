//! User-facing errors: a stable code, one line saying what did not happen, the cause, and
//! the fix — rendered the same way by `dg` and `git-remote-dash` (UX spec §7.3).
//!
//! ```text
//! error: push rejected: you are not a writer of alice/project            [E601]
//!   cause: Platform refused the write at consensus (40120: no writer/maintainer document …)
//!   fix:   ask a maintainer of alice/project to add you as a writer
//!   more:  https://github.com/PastaPastaPasta/dash-forge/blob/master/docs/errors.md#e601
//! ```
//!
//! Codes are `E<class><nn>`; the class digit IS the process exit code (spec §7.3):
//!
//! | class | exit | meaning |
//! |---|---|---|
//! | `E1xx` | 1 | generic / unexpected |
//! | `E2xx` | 2 | usage: bad arguments, names, configuration values |
//! | `E3xx` | 3 | auth / key: no identity, wrong key, unreadable identity file |
//! | `E4xx` | 4 | funds / budget |
//! | `E5xx` | 5 | storage |
//! | `E6xx` | 6 | consensus rejection |
//! | `E7xx` | 7 | network |
//! | `E8xx` | 8 | policy (cost guard, confirmation) |
//!
//! Every code has a section in `docs/errors.md` (checked by a test), and codes never change
//! meaning once shipped: scripts match on them.
//!
//! Two ways in: construct a [`UserError`] where the failure is understood (the helper's
//! storage policy, the cost guard), or let [`classify`] map an error chain — typed
//! [`crate::Error`] variants first, then the SDK's consensus messages, which are only
//! available as text at this boundary (the SDK stays confined to [`crate::platform`]).
//!
//! Nothing rendered here may carry a secret: every string passes through [`redact`] on its
//! way out.

use std::error::Error as StdError;
use std::fmt::{self, Write as _};
use std::io::IsTerminal as _;

use serde_json::{json, Value};

use crate::error::Error as CoreError;
use crate::storage::ReplicationError;

/// Where each code's page lives. Codes link to `<DOCS_URL>#<code lowercased>`.
pub const DOCS_URL: &str =
    "https://github.com/PastaPastaPasta/dash-forge/blob/master/docs/errors.md";

/// The web app origin (repo pages are `…/repo?owner=<id>&name=<name>`).
pub const WEB_ORIGIN: &str = crate::storage::cors::PROBE_ORIGIN;

/// Where to top up an identity's credits from any Dash wallet.
pub const TOP_UP_URL: &str = "https://bridge.thepasta.org";

/// E502's note when Platform chunks were (or may have been) uploaded before the policy
/// failed.
pub const NOTE_PLATFORM_CHUNKS_JOURNALED: &str = "Platform chunks that uploaded are journaled and reused by the next push; no packManifest and no ref was written";

/// The stable code catalogue: `(code, one-line title)`. `docs/errors.md` has one section per
/// entry, in this order.
pub const CATALOGUE: &[(&str, &str)] = &[
    (codes::UNEXPECTED, "unexpected error"),
    (codes::NOT_FOUND, "not found"),
    (codes::NOT_IMPLEMENTED, "not implemented yet"),
    (codes::CHECKS_FAILED, "checks failed"),
    (codes::USAGE, "invalid arguments"),
    (codes::INVALID_REPO_NAME, "invalid repository name"),
    (
        codes::INVALID_REPO_REF,
        "invalid repository reference or dash:// URL",
    ),
    (codes::INVALID_CONFIG, "invalid configuration"),
    (codes::UNSUPPORTED, "unsupported git operation"),
    (codes::NO_IDENTITY, "no identity configured"),
    (codes::KEY_CANNOT_SIGN, "this key can't sign that"),
    (codes::IDENTITY_UNREADABLE, "identity file unreadable"),
    (
        codes::IDENTITY_NOT_FOUND,
        "identity not found on this network",
    ),
    (codes::INSUFFICIENT_CREDITS, "not enough credits"),
    (codes::STORAGE_CONFIG, "storage not configured correctly"),
    (codes::STORAGE_POLICY, "storage policy not met"),
    (codes::PACKS_UNREADABLE, "packs unreadable"),
    (codes::INTEGRITY, "integrity check failed"),
    (codes::STORAGE_SECRET, "storage credentials unavailable"),
    (codes::STORAGE_TEST, "storage profile failed its checks"),
    (codes::RECORDED_COPY_LOST, "recorded pack copy unreachable"),
    (codes::NOT_A_WRITER, "not a writer of this repository"),
    (codes::SUSPENDED, "write access suspended"),
    (codes::ALREADY_EXISTS, "already exists"),
    (codes::REJECTED, "rejected by Platform"),
    (codes::READ_ONLY, "v1 repository is read only"),
    (codes::UNREACHABLE, "Dash Platform unreachable"),
    (
        codes::NOT_DEPLOYED,
        "Dash Forge not deployed on this network",
    ),
    (codes::INCOMPLETE_READ, "incomplete read"),
    (codes::TIMED_OUT, "timed out; may still land"),
    (codes::COST_GUARD, "stopped by the cost guard"),
    (codes::CONFIRMATION_REQUIRED, "confirmation required"),
    (codes::CANCELLED, "cancelled at the confirmation prompt"),
];

/// The stable codes. The first digit is the exit code.
pub mod codes {
    /// An error no rule below recognizes.
    pub const UNEXPECTED: &str = "E101";
    /// A repo, issue, PR, release, contract or document does not exist.
    pub const NOT_FOUND: &str = "E102";
    /// The command exists but is not wired yet.
    pub const NOT_IMPLEMENTED: &str = "E103";
    /// A diagnostic (`dg doctor`) found failing checks.
    pub const CHECKS_FAILED: &str = "E104";
    /// Arguments that do not make sense together.
    pub const USAGE: &str = "E201";
    /// A repository name outside `^[a-z0-9][a-z0-9._-]{0,62}$`.
    pub const INVALID_REPO_NAME: &str = "E202";
    /// An `owner/name` or `dash://` URL that cannot be parsed.
    pub const INVALID_REPO_REF: &str = "E203";
    /// A bad value in config.toml, git config `dash.*`, a network name or DAPI address.
    pub const INVALID_CONFIG: &str = "E204";
    /// A git operation dash:// does not support (shallow clone).
    pub const UNSUPPORTED: &str = "E205";
    /// No identity file configured.
    pub const NO_IDENTITY: &str = "E301";
    /// The identity has no key of the level this operation needs.
    pub const KEY_CANNOT_SIGN: &str = "E302";
    /// The identity file is missing or malformed.
    pub const IDENTITY_UNREADABLE: &str = "E303";
    /// The identity does not exist on the selected network.
    pub const IDENTITY_NOT_FOUND: &str = "E304";
    /// The identity's balance cannot pay for the write.
    pub const INSUFFICIENT_CREDITS: &str = "E401";
    /// `dash.storage` names an unknown profile, or storage.toml is invalid.
    pub const STORAGE_CONFIG: &str = "E501";
    /// Fewer than `dash.replicas` targets confirmed the pack.
    pub const STORAGE_POLICY: &str = "E502";
    /// A clone/fetch could not read every pack it needs.
    pub const PACKS_UNREADABLE: &str = "E503";
    /// Bytes did not hash to what the manifest records.
    pub const INTEGRITY: &str = "E504";
    /// A storage secret reference (`env:` / `keychain:`) does not resolve.
    pub const STORAGE_SECRET: &str = "E505";
    /// `dg storage test` failed (upload, public read or browser CORS).
    pub const STORAGE_TEST: &str = "E506";
    /// A re-push found the pack already recorded, with no copy readable.
    pub const RECORDED_COPY_LOST: &str = "E507";
    /// Consensus refused a write: no WRITE token (v1) / no writer document (v2, 40120).
    pub const NOT_A_WRITER: &str = "E601";
    /// Consensus refused a write: the WRITE/MAINTAIN token is frozen (40702).
    pub const SUSPENDED: &str = "E602";
    /// A unique index collision (a name or number already taken).
    pub const ALREADY_EXISTS: &str = "E603";
    /// Any other consensus rejection.
    pub const REJECTED: &str = "E604";
    /// A write to a forge-v1 repository, which is read only.
    pub const READ_ONLY: &str = "E605";
    /// DAPI / the quorum service could not be reached.
    pub const UNREACHABLE: &str = "E701";
    /// The selected network has no Dash Forge deployment.
    pub const NOT_DEPLOYED: &str = "E702";
    /// A read that must be complete could not be proven complete.
    pub const INCOMPLETE_READ: &str = "E703";
    /// A broadcast timed out; the transition may still land.
    pub const TIMED_OUT: &str = "E704";
    /// The push cost guard refused (no terminal to confirm on).
    pub const COST_GUARD: &str = "E801";
    /// A cost-bearing `dg` command needs `--yes` (JSON mode / no terminal).
    pub const CONFIRMATION_REQUIRED: &str = "E802";
    /// The user answered no at a confirmation prompt.
    pub const CANCELLED: &str = "E803";
}

/// An error a person can act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserError {
    /// Stable code (`E601`); see [`CATALOGUE`].
    pub code: &'static str,
    /// One line: what did not happen, in terms of the user's goal ("push rejected: …").
    pub message: String,
    /// The underlying reason, once, one line, no stack.
    pub cause: Option<String>,
    /// Concrete actions, most direct first. Commands are copy-pasteable.
    pub fix: Vec<String>,
    /// Reassurance or side facts ("nothing was written to Platform").
    pub note: Option<String>,
    /// The code's documentation page.
    pub docs_url: Option<String>,
}

impl fmt::Display for UserError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)?;
        if let Some(c) = &self.cause {
            write!(f, ": {c}")?;
        }
        Ok(())
    }
}

impl StdError for UserError {}

impl UserError {
    /// A new error with `code` and `message`, linking to the code's docs section.
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: one_line(&message.into()),
            cause: None,
            fix: Vec::new(),
            note: None,
            docs_url: Some(docs_url(code)),
        }
    }

    /// Set the cause (collapsed to one line).
    #[must_use]
    pub fn cause(mut self, cause: impl Into<String>) -> Self {
        let c = one_line(&cause.into());
        self.cause = (!c.is_empty()).then_some(c);
        self
    }

    /// Add a fix (they render in the order added).
    #[must_use]
    pub fn fix(mut self, fix: impl Into<String>) -> Self {
        self.fix.push(one_line(&fix.into()));
        self
    }

    /// Set the note.
    #[must_use]
    pub fn note(mut self, note: impl Into<String>) -> Self {
        self.note = Some(one_line(&note.into()));
        self
    }

    /// Drop the docs link (for output that must match a fixed layout).
    #[must_use]
    pub fn without_docs(mut self) -> Self {
        self.docs_url = None;
        self
    }

    /// The process exit code: the code's class digit (`E601` → 6), 1 if malformed.
    pub fn exit_code(&self) -> i32 {
        exit_code_of(self.code)
    }

    /// A copy with every field passed through [`redact`].
    #[must_use]
    pub fn redacted(&self) -> Self {
        Self {
            code: self.code,
            message: redact(&self.message),
            cause: self.cause.as_deref().map(redact),
            fix: self.fix.iter().map(|f| redact(f)).collect(),
            note: self.note.as_deref().map(redact),
            docs_url: self.docs_url.clone(),
        }
    }

    /// The human rendering (spec §7.3), one `\n`-terminated line per field, every line
    /// starting with `prefix` (`""` for dg, `"dash: "` for the helper, whose stderr git
    /// shows verbatim). `color` adds ANSI styling to the labels only.
    pub fn render(&self, prefix: &str, color: bool) -> String {
        let e = self.redacted();
        let paint = |s: &str, sgr: &str| {
            if color {
                format!("\x1b[{sgr}m{s}\x1b[0m")
            } else {
                s.to_string()
            }
        };
        // The code sits in column 73, as in the spec's examples: pad the plain head, then style it.
        let head_plain = format!("error: {}", e.message);
        let pad = 71usize.saturating_sub(head_plain.chars().count());
        let mut out = format!(
            "{prefix}{}{}{} {}\n",
            paint("error:", "1;31"),
            &head_plain["error:".len()..],
            " ".repeat(pad),
            paint(&format!("[{}]", e.code), "2"),
        );
        let mut line = |label: &str, sgr: &str, text: &str| {
            // `label:` padded to 6 columns so the texts line up ("fix:   ", "cause: ").
            let lbl = format!("{label}:");
            let _ = writeln!(
                out,
                "{prefix}  {}{} {text}",
                paint(&lbl, sgr),
                " ".repeat(6usize.saturating_sub(lbl.len()))
            );
        };
        if let Some(c) = &e.cause {
            line("cause", "33", c);
        }
        for (i, f) in e.fix.iter().enumerate() {
            line(if i == 0 { "fix" } else { "or" }, "1;32", f);
        }
        if let Some(n) = &e.note {
            line("note", "36", n);
        }
        if let Some(u) = &e.docs_url {
            line("more", "2", u);
        }
        out
    }

    /// Print the human block to stderr, every line prefixed with `prefix`, coloured by
    /// [`stderr_color`].
    pub fn eprint(&self, prefix: &str) {
        eprint!("{}", self.render(prefix, stderr_color()));
    }

    /// The `--json` shape: `{"error": {"code", "message", "cause", "fix", "note", "docs"}}`.
    pub fn to_json(&self) -> Value {
        let e = self.redacted();
        json!({
            "error": {
                "code": e.code,
                "message": e.message,
                "cause": e.cause,
                "fix": e.fix,
                "note": e.note,
                "docs": e.docs_url,
                "exitCode": self.exit_code(),
            }
        })
    }

    /// E502 from a replication shortfall. `platform_fallback` says whether the fallback was
    /// armed (and so already tried).
    pub fn storage_policy_not_met(
        err: &ReplicationError,
        goal: &str,
        platform_fallback: bool,
    ) -> Self {
        let total = err.confirmed.len() + err.failures.len() + err.skipped.len();
        let mut parts: Vec<String> = err
            .failures
            .iter()
            .map(|f| format!("{}: {}", f.target, f.reason))
            .collect();
        parts.extend(err.confirmed.iter().map(|r| format!("{}: ok", r.target)));
        parts.extend(
            err.skipped
                .iter()
                .map(|s| format!("{s}: skipped (could no longer change the outcome)")),
        );
        let mut u = Self::new(
            codes::STORAGE_POLICY,
            format!(
                "{goal}: storage policy not met ({} of {} targets confirmed{})",
                err.confirmed.len(),
                total.max(err.required),
                if err.required < total {
                    format!(", {} required", err.required)
                } else {
                    String::new()
                }
            ),
        )
        .cause(parts.join("; "));
        let failed = err
            .failures
            .iter()
            .map(|f| f.target.as_str())
            .find(|t| *t != "policy" && *t != crate::storage::PLATFORM_PROFILE);
        let kept = err
            .confirmed
            .iter()
            .map(|r| r.target.as_str())
            .collect::<Vec<_>>();
        let kept_note = if kept.is_empty() {
            String::new()
        } else {
            format!(
                " — {}'s copy is kept and not re-uploaded",
                kept.join(" and ")
            )
        };
        u = match failed {
            Some(t) => u.fix(format!("`dg storage test {t}`, then push again{kept_note}")),
            None => u.fix(format!(
                "fix the failing target(s), then push again{kept_note}"
            )),
        };
        u = u.fix("lower `git config dash.replicas` to the number of targets that work");
        if !platform_fallback {
            u = u.fix("`git config dash.platformFallback true` to store on Platform (costed) when your storage fails");
        }
        let platform_tried = err.confirmed.iter().any(|r| r.platform)
            || err
                .failures
                .iter()
                .any(|f| f.target == crate::storage::PLATFORM_PROFILE);
        u.note(if platform_tried {
            NOTE_PLATFORM_CHUNKS_JOURNALED
        } else {
            "nothing was written to Platform: no packManifest and no ref"
        })
    }
}

/// Whether to colour stderr: only on a terminal, and never with `NO_COLOR` set
/// (no-color.org) or `TERM=dumb`.
pub fn stderr_color() -> bool {
    color_allowed(
        std::io::stderr().is_terminal(),
        std::env::var_os("NO_COLOR").as_deref(),
        std::env::var_os("TERM").as_deref(),
    )
}

/// [`stderr_color`]'s rule, pure.
pub fn color_allowed(
    tty: bool,
    no_color: Option<&std::ffi::OsStr>,
    term: Option<&std::ffi::OsStr>,
) -> bool {
    tty && no_color.is_none_or(std::ffi::OsStr::is_empty) && term.is_none_or(|t| t != "dumb")
}

/// The docs link for `code`.
pub fn docs_url(code: &str) -> String {
    format!("{DOCS_URL}#{}", code.to_ascii_lowercase())
}

/// The exit code for `code` (its class digit), 1 for anything malformed.
pub fn exit_code_of(code: &str) -> i32 {
    code.strip_prefix('E')
        .and_then(|rest| rest.chars().next())
        .and_then(|c| c.to_digit(10))
        .filter(|d| (1..=8).contains(d))
        .map_or(1, |d| i32::try_from(d).unwrap_or(1))
}

/// What the failing command was for — drives the headline and which fixes apply.
#[derive(Debug, Clone, Copy, Default)]
pub struct ErrorContext<'a> {
    /// The failed goal as the headline's lead ("push failed", "issue not created").
    pub goal: Option<&'a str>,
    /// The lead for a consensus rejection (E6xx), when it reads better than `goal`
    /// ("push rejected: you are not a writer of …").
    pub rejected: Option<&'a str>,
    /// The repository involved (`owner/name`), when known.
    pub repo: Option<&'a str>,
    /// Whether re-running the same command is safe after an ambiguous timeout (a push is:
    /// chunks are journaled and ref updates idempotent; creating an issue is not).
    pub retry_is_idempotent: bool,
}

impl ErrorContext<'_> {
    fn headline(&self, what: &str) -> String {
        lead(self.goal, what)
    }

    fn rejected_headline(&self, what: &str) -> String {
        lead(self.rejected.or(self.goal), what)
    }

    fn repo_or(&self, fallback: &'static str) -> String {
        self.repo.unwrap_or(fallback).to_string()
    }
}

/// `"<lead>: <what>"`, or just `what` without a lead.
fn lead(lead: Option<&str>, what: &str) -> String {
    match lead {
        Some(g) => format!("{g}: {what}"),
        None => what.to_string(),
    }
}

/// Map an error chain (outermost first, e.g. `anyhow::Error::chain()`) to a [`UserError`].
///
/// A [`UserError`] anywhere in the chain wins as-is; then a [`ReplicationError`]; then the
/// innermost [`crate::Error`], read together with the chain's text (the context layers say
/// *which* thing was not found). Consensus and network text is only interpreted when it
/// came from Platform ([`crate::Error::Platform`], or a `connecting to Dash Platform`
/// context): a storage timeout is not "could not reach Dash Platform". Anything else is E101
/// with the whole chain as the cause — never silently dropped.
pub fn classify<'e>(
    chain: impl IntoIterator<Item = &'e (dyn StdError + 'static)>,
    ctx: &ErrorContext<'_>,
) -> UserError {
    let layers: Vec<&(dyn StdError + 'static)> = chain.into_iter().collect();
    if let Some(u) = layers.iter().find_map(|l| l.downcast_ref::<UserError>()) {
        return u.clone();
    }
    let text = layers
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(": ");
    let lower = text.to_ascii_lowercase();
    if let Some(r) = layers
        .iter()
        .find_map(|l| l.downcast_ref::<ReplicationError>())
    {
        return UserError::storage_policy_not_met(r, ctx.goal.unwrap_or("push failed"), false);
    }
    if let Some(core) = layers
        .iter()
        .rev()
        .find_map(|l| l.downcast_ref::<CoreError>())
    {
        if let Some(u) = from_core(core, &lower, ctx) {
            return u;
        }
    }
    if lower.contains("connecting to dash platform") {
        return unreachable(ctx, &text);
    }
    UserError::new(
        codes::UNEXPECTED,
        ctx.goal.unwrap_or("the command failed").to_string(),
    )
    .cause(text)
    .fix("run it again with RUST_LOG=debug for detail; if it persists, report it with that output at https://github.com/PastaPastaPasta/dash-forge/issues")
}

fn from_core(core: &CoreError, chain: &str, ctx: &ErrorContext<'_>) -> Option<UserError> {
    Some(match core {
        CoreError::InsufficientCredits { needed, available } => insufficient(
            ctx,
            &format!(
                "insufficient credits: needs {} DASH, balance {} DASH",
                dash(*needed),
                dash(*available)
            ),
        ),
        CoreError::TokenFrozen => suspended(ctx, &format!("40702 {core}")),
        CoreError::NotAMember(detail) => not_a_writer(ctx, detail),
        CoreError::V1ReadOnly { repo } => UserError::new(
            codes::READ_ONLY,
            ctx.headline(&format!("{repo} is a v1 repository, which is read only")),
        )
        .cause("forge-v1 repositories (one contract each) can still be cloned and viewed, but no longer written")
        .fix("create a forge-v2 repository (`dg repo create <name>`) and push there")
        .note("`dg migrate` (moving a v1 repo to forge-v2) is coming soon"),
        CoreError::V2NotDeployed { network } => UserError::new(
            codes::NOT_DEPLOYED,
            ctx.headline(&format!("forge-v2 isn't deployed on {network} yet")),
        )
        .cause(format!(
            "forge-contracts/deployments/{network}.json records no forge-v2 contracts"
        ))
        .fix("use a network where it is: `--network devnet --devnet-name moutai`")
        .note("existing v1 repositories on this network stay readable"),
        CoreError::Unauthorized => not_a_writer(ctx, &format!("40700/40701 {core}")),
        CoreError::Timeout { retryable } => timed_out(ctx, *retryable),
        CoreError::IncompleteRead {
            document_type,
            fetched,
            reason,
        } => UserError::new(
            codes::INCOMPLETE_READ,
            ctx.headline(&format!("could not read every {document_type} document")),
        )
        .cause(format!("stopped after {fetched}: {reason}"))
        .fix("try again in a minute: a node served an incomplete page, and another node will be asked")
        .note("nothing partial was used: an incomplete history is refused rather than folded"),
        CoreError::NotFound => not_found(chain, ctx),
        CoreError::DuplicateUniqueIndex(what) => UserError::new(
            codes::ALREADY_EXISTS,
            ctx.headline("it already exists"),
        )
        .cause(format!("Platform refused a duplicate: {what}"))
        .fix("pick another name (or number) and run the command again"),
        CoreError::Integrity => UserError::new(
            codes::INTEGRITY,
            ctx.headline("downloaded bytes did not match their recorded hash"),
        )
        .cause("a storage copy (or a cache in front of it) served different content")
        .fix("run it again: other copies are tried first; `dg storage status <owner>/<repo>` shows which copies verify"),
        CoreError::Nonce => UserError::new(
            codes::UNEXPECTED,
            ctx.headline("the identity's nonce is out of sync"),
        )
        .cause("another write from this identity landed at the same time")
        .fix("run the command again"),
        CoreError::Serde(e) if mentions_identity(chain) => identity_unreadable(&e.to_string()),
        CoreError::Io(msg) if msg.contains("no external copy verified") => UserError::new(
            codes::PACKS_UNREADABLE,
            ctx.headline("a pack is unreadable"),
        )
        .cause(msg)
        .fix(format!(
            "ask a member who has the objects to run `dg reseed {} --from-local` inside their clone",
            ctx.repo_or("<owner>/<repo>")
        ))
        .fix("if you know another IPFS gateway with the pack, add it to `[read] ipfs_gateways` in storage.toml and retry"),
        CoreError::Io(msg) if mentions_identity(chain) => identity_unreadable(msg),
        CoreError::Config(msg) => from_config(msg, chain, ctx),
        CoreError::NotDeployed { network } => UserError::new(
            codes::NOT_DEPLOYED,
            ctx.headline(&format!("Dash Forge is not deployed on {network}")),
        )
        .cause(format!(
            "forge-contracts/deployments/{network}.json records no registry contract"
        ))
        .fix("use a network with a deployment: `--network testnet`")
        .fix("point FORGE_REGISTRY_CONTRACT_ID (dg: `registry_contract_id` in config.toml) at a registry you deployed; `dg doctor` shows what is configured"),
        CoreError::Platform(msg) => return from_platform_text(msg, ctx),
        _ => return None,
    })
}

fn from_config(msg: &str, chain: &str, ctx: &ErrorContext<'_>) -> UserError {
    let m = msg.to_ascii_lowercase();
    if m.contains("invalid repo name") {
        return UserError::new(codes::INVALID_REPO_NAME, ctx.headline("invalid repository name"))
            .cause(msg)
            .fix("use 1–63 lowercase letters, digits, `.`, `_` or `-`, starting with a letter or digit (e.g. `my-project`)");
    }
    if m.contains("authentication key") {
        return key_cannot_sign(msg);
    }
    if m.starts_with("secret ") && (m.contains("is not set") || m.contains("keychain")) {
        return UserError::new(
            codes::STORAGE_SECRET,
            ctx.headline("storage credentials are not available"),
        )
        .cause(msg)
        .fix("export the variable in the environment git and dg run in, or re-add the profile with a keychain reference: `dg storage add <name> … --secret-access-key keychain:dash-forge/<name>`")
        .fix("`dg storage list` shows which references resolve");
    }
    if m.contains("dash.storage")
        || m.contains("dash.replicas")
        || m.contains("platformfallback")
        || m.contains("storage profile")
        || m.contains("storage.toml")
        || m.contains("profile ")
    {
        return UserError::new(
            codes::STORAGE_CONFIG,
            ctx.headline("storage is not configured correctly"),
        )
        .cause(msg)
        .fix("`dg storage list` shows your profiles; `dg storage use <profiles>` sets dash.storage for this repo");
    }
    if mentions_identity(chain) {
        return identity_unreadable(msg);
    }
    UserError::new(codes::INVALID_CONFIG, ctx.headline("invalid configuration"))
        .cause(msg)
        .fix("`dg doctor` checks the network, contracts, identity and storage configuration")
}

/// Map the SDK's text (a flattened `dash_sdk::Error`) — consensus codes are only available
/// as their messages at this boundary.
fn from_platform_text(msg: &str, ctx: &ErrorContext<'_>) -> Option<UserError> {
    let m = msg.to_ascii_lowercase();
    // 40210 IdentityInsufficientBalance / 30000 BalanceIsNotEnough.
    if m.contains("insufficient identity") || m.contains("is not enough to pay") {
        let detail = balance_numbers(&m).map_or_else(
            || format!("insufficient credits: {}", one_line(msg)),
            |(bal, need)| {
                format!(
                    "insufficient credits: needs {} DASH, balance {} DASH",
                    dash(need),
                    dash(bal)
                )
            },
        );
        return Some(insufficient(ctx, &detail));
    }
    // 40702 IdentityTokenAccountFrozen.
    if m.contains("account is frozen for token") || m.contains("token frozen") {
        return Some(suspended(ctx, &format!("40702: {}", one_line(msg))));
    }
    // 40700 IdentityDoesNotHaveEnoughTokenBalance / 40701 UnauthorizedTokenAction.
    if m.contains("does not have enough balance for token")
        || m.contains("is not authorized to perform action")
    {
        return Some(not_a_writer(
            ctx,
            &format!("40700/40701: no WRITE token: {}", one_line(msg)),
        ));
    }
    // 40120 ReferencedEntityNotFound. On path `$ownerId` it is forge-v2's writer gate
    // (`ownerRefersTo`): no current `writer`/`maintainer` document for the signer. On any
    // other path a referenced document, contract or identity is missing — a rejection,
    // but not about membership.
    if let Some(path) = referenced_path(msg) {
        if path == "$ownerId" {
            return Some(not_a_writer(
                ctx,
                "40120: no writer/maintainer document for your identity",
            ));
        }
        return Some(
            UserError::new(
                codes::REJECTED,
                ctx.rejected_headline(&format!("a document it refers to at {path} does not exist")),
            )
            .cause(format!("40120: {}", one_line(msg)))
            .fix("check the id you passed for that field; the cause names the missing entity"),
        );
    }
    if is_network_text(&m) {
        return Some(unreachable(ctx, msg));
    }
    if m.contains("state transition broadcast error") || m.contains("consensus") {
        return Some(
            UserError::new(codes::REJECTED, ctx.rejected_headline("Platform rejected the write"))
                .cause(msg)
                .fix("the cause names the rule that refused it; if it looks wrong, report it at https://github.com/PastaPastaPasta/dash-forge/issues"),
        );
    }
    None
}

fn not_found(chain: &str, ctx: &ErrorContext<'_>) -> UserError {
    if chain.contains("fetching the signing identity") || chain.contains("fetching identity") {
        return UserError::new(
            codes::IDENTITY_NOT_FOUND,
            ctx.headline("your identity does not exist on this network"),
        )
        .cause("Platform has no identity with the id in your identity file")
        .fix("select the network the identity was created on (`--network`, or `dg auth login --identity <file> --network <net>`); `dg auth status` shows both");
    }
    let repo = ctx.repo_or("the repository");
    if chain.contains("resolving") || chain.contains("fetching contract") {
        return UserError::new(codes::NOT_FOUND, ctx.headline(&format!("{repo} was not found")))
            .cause("the registry has no repository with that owner and name on this network")
            .fix("check the owner id and name: `dg repo list --owner <owner identity id>` lists an owner's repositories")
            .fix("check the network: `dg doctor` shows which network and registry are in use");
    }
    UserError::new(codes::NOT_FOUND, ctx.headline("not found"))
        .cause("Platform returned a proof that it does not exist")
        .fix("check the name or number you passed")
}

fn insufficient(ctx: &ErrorContext<'_>, detail: &str) -> UserError {
    UserError::new(
        codes::INSUFFICIENT_CREDITS,
        ctx.headline("not enough credits"),
    )
    .cause(detail)
    .fix(format!(
        "top up the identity from any Dash wallet at {TOP_UP_URL} (`dg auth balance` shows the balance)"
    ))
    .note("reads, clones and browsing are free and unaffected")
}

fn suspended(ctx: &ErrorContext<'_>, why: &str) -> UserError {
    let repo = ctx.repo_or("<owner>/<repo>");
    UserError::new(
        codes::SUSPENDED,
        ctx.rejected_headline(&format!(
            "your write access to {} is suspended",
            ctx.repo_or("this repo")
        )),
    )
    .cause(format!("Platform refused the write at consensus ({why})"))
    .fix(format!(
        "ask a maintainer to run `dg collab unsuspend {repo} <your identity id>`"
    ))
}

fn not_a_writer(ctx: &ErrorContext<'_>, why: &str) -> UserError {
    let repo = ctx.repo_or("<owner>/<repo>");
    // "Not a writer" is what a refused push means. Other writes (collab admin, releases,
    // repo config) need a different role, so say what is known: not authorized.
    if ctx.rejected.is_none() {
        return UserError::new(
            codes::NOT_A_WRITER,
            ctx.headline(&format!(
                "your identity is not authorized for this action on {}",
                ctx.repo_or("this repo")
            )),
        )
        .cause(format!("Platform refused the write at consensus ({why})"))
        .fix(format!(
            "ask a maintainer of {repo} to grant you the role this needs (`dg collab add {repo} <your identity id> --role write|maintain`)"
        ));
    }
    UserError::new(
        codes::NOT_A_WRITER,
        ctx.rejected_headline(&format!(
            "you are not a writer of {}",
            ctx.repo_or("this repo")
        )),
    )
    .cause(format!("Platform refused the write at consensus ({why})"))
    .fix(format!(
        "ask the owner to run `dg collab add {repo} <your identity id> --role write`"
    ))
    .fix(format!(
        "push to a repo of your own and open a pull request: `dg pr create {repo} --title <t> --source-contract <your repo contract id> --head-oid <oid>`"
    ))
}

fn timed_out(ctx: &ErrorContext<'_>, retryable: bool) -> UserError {
    let u = UserError::new(
        codes::TIMED_OUT,
        ctx.headline("timed out waiting for Platform"),
    )
    .cause(if retryable {
        "the signed transition was broadcast but not confirmed in time; it may still land"
    } else {
        "the operation did not complete in time"
    });
    if ctx.retry_is_idempotent {
        u.fix("run it again: confirmed chunks are journaled and ref updates are idempotent, so nothing is paid twice")
    } else {
        u.fix("check whether it landed first (e.g. `dg issue list <repo>` / `dg repo view <repo>`), then run it again if it did not")
    }
}

fn unreachable(ctx: &ErrorContext<'_>, detail: &str) -> UserError {
    UserError::new(
        codes::UNREACHABLE,
        ctx.headline("could not reach Dash Platform"),
    )
    .cause(detail)
    .fix("check the connection and run it again (nodes that failed are skipped for a minute)")
    .fix("`dg doctor` tests DAPI reachability; on a devnet check `--dapi-addresses` / git config dash.dapiAddresses")
}

fn identity_unreadable(msg: &str) -> UserError {
    UserError::new(
        codes::IDENTITY_UNREADABLE,
        "could not load your identity file",
    )
    .cause(msg)
    .fix("pass the bridge identity export with `--identity <file>` (the helper reads DASH_FORGE_KEY); `dg auth status` shows which file is in use")
}

/// E302 — the identity file has no key at the level an operation needs.
pub fn key_cannot_sign(msg: &str) -> UserError {
    UserError::new(codes::KEY_CANNOT_SIGN, "this key can't sign that")
        .cause(msg)
        .fix("use the identity export that includes the key (the bridge export carries HIGH and CRITICAL AUTHENTICATION keys): `--identity <file>`")
}

fn mentions_identity(chain: &str) -> bool {
    chain.contains("loading identity") || chain.contains("identity file")
}

fn is_network_text(m: &str) -> bool {
    [
        "transport error",
        "status: unavailable",
        "no available addresses",
        "dns error",
        "connection refused",
        "connection reset",
        "tcp connect",
        "error trying to connect",
        "prefetch quorums",
        "deadline exceeded",
        "timed out",
        "timeout",
    ]
    .iter()
    .any(|p| m.contains(p))
}

/// The `path` of a 40120 `referenced … not found for path <path>` message.
fn referenced_path(msg: &str) -> Option<&str> {
    const MARK: &str = " not found for path ";
    let at = msg.find(MARK)?;
    if !msg[..at].contains("referenced ") {
        return None;
    }
    msg[at + MARK.len()..].split_whitespace().next()
}

/// `(balance, required)` credits from the two insufficient-balance consensus messages.
fn balance_numbers(m: &str) -> Option<(u64, u64)> {
    let num_after = |key: &str| -> Option<u64> {
        let rest = &m[m.find(key)? + key.len()..];
        let digits: String = rest
            .trim_start()
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        digits.parse().ok()
    };
    if m.contains("insufficient identity") {
        return Some((num_after(" balance ")?, num_after(" required ")?));
    }
    Some((num_after("credits balance ")?, num_after(" to pay ")?))
}

/// Credits as a short DASH amount: four decimals from 0.001 DASH up, and three significant
/// digits below that, so a small fee never rounds to `0` (`0.00031`, `0.000000123`).
pub fn dash(credits: u64) -> String {
    let d = crate::repo::credits_to_dash(credits);
    if credits == 0 {
        return "0".into();
    }
    if d >= 0.001 {
        return format!("{d:.4}");
    }
    // Decimals so that three significant digits show: 0.000373 needs 6, 1.23e-9 needs 11.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let decimals = (2.0 - d.log10().floor()) as usize;
    let s = format!("{d:.decimals$}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// Collapse whitespace (newlines included) to single spaces.
pub fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

const REDACTED: &str = "[redacted]";

/// `key=value` keys whose values are credentials (matched case-insensitively, whole key or
/// `_`/`-`-separated suffix: `api_key`, `x-auth-token`).
const SECRET_KEYS: &[&str] = &[
    "token",
    "secret",
    "signature",
    "sig",
    "password",
    "passwd",
    "auth",
    "credential",
    "key",
    "access_token",
    "apikey",
];

/// Scrub credentials from a message before it is shown: URL userinfo, credential-looking
/// `key=value` pairs (`?token=`, `X-Amz-Signature=`, `password=`), `Authorization:` header
/// values, the WIF of a `dfk1:` key string, and WIF-shaped private keys (bare or after `=`).
/// The primary defence is that secrets never enter error text (they live in
/// [`crate::keystore::Secret`]); this is the last line.
///
/// Works on `char`s throughout (never slices inside a multi-byte character) and matches keys
/// only at a word boundary, so prose ("a basic idea", "monkey=…") is left alone.
pub fn redact(s: &str) -> String {
    let s = redact_userinfo(s);
    let s = redact_key_values(&s);
    let s = redact_authorization(&s);
    redact_tokens(&s)
}

fn redact_userinfo(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find("://") {
        let (before, after) = rest.split_at(i + 3);
        out.push_str(before);
        let end = after
            .find(|c: char| c == '/' || c.is_whitespace() || matches!(c, '"' | '\'' | ')' | '>'))
            .unwrap_or(after.len());
        let authority = &after[..end];
        match authority.rfind('@') {
            Some(at) => {
                out.push_str(REDACTED);
                out.push_str(&authority[at..]);
            }
            None => out.push_str(authority),
        }
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

fn is_key_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')
}

fn is_secret_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    (k.starts_with("x-amz-") && k != "x-amz-date" && k != "x-amz-expires")
        || SECRET_KEYS
            .iter()
            .any(|w| k == *w || k.ends_with(&format!("_{w}")) || k.ends_with(&format!("-{w}")))
}

fn ends_value(c: char) -> bool {
    c.is_whitespace() || matches!(c, '&' | '"' | '\'' | ')' | '>' | ';' | ',' | '`')
}

/// `key=value` where `key` starts at a word boundary and names a credential.
fn redact_key_values(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        let boundary = i == 0 || !is_key_char(chars[i - 1]);
        if !(boundary && is_key_char(chars[i])) {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let key_start = i;
        while i < chars.len() && is_key_char(chars[i]) {
            i += 1;
        }
        let key: String = chars[key_start..i].iter().collect();
        out.push_str(&key);
        if i < chars.len() && chars[i] == '=' {
            out.push('=');
            i += 1;
            let val_start = i;
            while i < chars.len() && !ends_value(chars[i]) {
                i += 1;
            }
            // A `dfk1:` value is left to `redact_tokens`, which keeps its non-secret
            // network/identity/key-id prefix and drops only the WIF.
            let dfk1 = chars[val_start..i].starts_with(&['d', 'f', 'k', '1', ':']);
            if i > val_start && is_secret_key(&key) && !dfk1 {
                out.push_str(REDACTED);
            } else {
                out.extend(&chars[val_start..i]);
            }
        }
    }
    out
}

/// `Authorization: <scheme> <credentials>` / `Authorization=<credentials>` (header dumps,
/// debug output): the scheme word (`Bearer`, `Basic`, …) is kept, the credential is not.
fn redact_authorization(s: &str) -> String {
    const HEADER: &str = "authorization";
    let chars: Vec<char> = s.chars().collect();
    let lower: Vec<char> = chars.iter().map(char::to_ascii_lowercase).collect();
    let header: Vec<char> = HEADER.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        let at_header = lower[i..].starts_with(&header)
            && (i == 0 || !is_key_char(chars[i - 1]))
            && lower.get(i + header.len()).is_none_or(|c| !is_key_char(*c));
        if !at_header {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let mut j = i + header.len();
        while j < chars.len() && chars[j] == ' ' {
            j += 1;
        }
        if !matches!(chars.get(j), Some(':' | '=')) {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        j += 1;
        while j < chars.len() && chars[j] == ' ' {
            j += 1;
        }
        out.extend(&chars[i..j]);
        // An optional scheme word followed by a space, then the credential.
        let word_end = (j..chars.len())
            .find(|&k| ends_value(chars[k]))
            .unwrap_or(chars.len());
        let mut cred_start = j;
        if chars.get(word_end) == Some(&' ') && word_end > j {
            let word: String = chars[j..word_end]
                .iter()
                .collect::<String>()
                .to_ascii_lowercase();
            if matches!(
                word.as_str(),
                "bearer" | "basic" | "token" | "digest" | "aws4-hmac-sha256"
            ) {
                out.extend(&chars[j..=word_end]);
                cred_start = word_end + 1;
            }
        }
        let cred_end = (cred_start..chars.len())
            .find(|&k| ends_value(chars[k]))
            .unwrap_or(chars.len());
        if cred_end > cred_start {
            out.push_str(REDACTED);
        }
        i = cred_end;
    }
    out
}

/// Tokens that are private keys: `dfk1:<net>:<id>:<keyId>:<wif>` keeps everything but the
/// WIF; a WIF-shaped base58 token (51–52 characters), bare or as the value after `=`, is
/// dropped.
fn redact_tokens(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut token = String::new();
    for c in s.chars() {
        if c.is_whitespace() || matches!(c, '"' | '\'' | '`' | ',' | '(' | ')') {
            out.push_str(&redact_token(&token));
            token.clear();
            out.push(c);
        } else {
            token.push(c);
        }
    }
    out.push_str(&redact_token(&token));
    out
}

fn redact_token(t: &str) -> String {
    // `…=value`: judge the value on its own (`KEY=<wif>`).
    if let Some(eq) = t.rfind('=') {
        let (head, value) = t.split_at(eq + 1);
        if !value.is_empty() && !head.ends_with("dfk1:=") {
            return format!("{head}{}", redact_token(value));
        }
    }
    if let Some(pos) = t.find("dfk1:") {
        let (lead, rest) = t.split_at(pos);
        if lead
            .chars()
            .last()
            .is_none_or(|c| !c.is_ascii_alphanumeric())
        {
            let parts: Vec<&str> = rest["dfk1:".len()..].splitn(4, ':').collect();
            if parts.len() == 4 {
                return format!(
                    "{lead}dfk1:{}:{}:{}:{REDACTED}",
                    parts[0], parts[1], parts[2]
                );
            }
            return format!("{lead}dfk1:{REDACTED}");
        }
    }
    let core = t.trim_end_matches(['.', ':', ';']);
    let is_base58 = |s: &str| {
        s.chars()
            .all(|c| c.is_ascii_alphanumeric() && !matches!(c, '0' | 'O' | 'I' | 'l'))
    };
    if (51..=52).contains(&core.len())
        && is_base58(core)
        && matches!(core.chars().next(), Some('5' | 'K' | 'L' | 'c' | '9'))
    {
        return format!("{REDACTED}{}", &t[core.len()..]);
    }
    t.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{Replica, TargetFailure};

    fn render(u: &UserError) -> String {
        u.render("", false)
    }

    /// The six worked examples of UX spec §7.3, byte for byte (layout contract: code in
    /// column 73, `cause:`/`fix:`/`note:` two-space indented and aligned). The examples'
    /// fixes name planned commands, so these pin the renderer; the mapping tests below pin
    /// what the classifier produces from real errors today.
    // The spec's example 1 has its code one column left of the other five; the renderer
    // uses the five's column for every message, so this expectation has one more space.
    #[test]
    fn spec_example_1_not_a_writer() {
        let u = UserError::new(codes::NOT_A_WRITER, "push rejected: you are not a writer of alice/project")
            .cause("Platform refused refUpdate at consensus (40120: no writer/maintainer document for your identity)")
            .fix("ask alice to run `dg collab add alice/project bob --role writer`, or push to your fork: `git push dash://bob/project`")
            .without_docs();
        assert_eq!(
            render(&u),
            "error: push rejected: you are not a writer of alice/project             [E601]\n  cause: Platform refused refUpdate at consensus (40120: no writer/maintainer document for your identity)\n  fix:   ask alice to run `dg collab add alice/project bob --role writer`, or push to your fork: `git push dash://bob/project`\n"
        );
    }

    #[test]
    fn spec_example_2_not_enough_credits() {
        let u = UserError::new(
            codes::INSUFFICIENT_CREDITS,
            "issue not created: not enough credits",
        )
        .cause("estimate 0.00042 DASH, balance 0.00011 DASH")
        .fix("top up from any Dash wallet: `dg auth balance --topup` shows the QR")
        .without_docs();
        assert_eq!(
            render(&u),
            "error: issue not created: not enough credits                            [E401]\n  cause: estimate 0.00042 DASH, balance 0.00011 DASH\n  fix:   top up from any Dash wallet: `dg auth balance --topup` shows the QR\n"
        );
    }

    #[test]
    fn spec_example_3_cost_guard() {
        let u = UserError::new(codes::COST_GUARD, "push stopped by the cost guard")
            .cause("this push would store 3.4 MiB on Platform (~0.95 DASH ≈ $32); no terminal to confirm on")
            .fix("add storage (`dg storage add`) so packs go to your bucket, or run `git -c dash.confirm=never push` to accept the price")
            .without_docs();
        assert_eq!(
            render(&u),
            "error: push stopped by the cost guard                                   [E801]\n  cause: this push would store 3.4 MiB on Platform (~0.95 DASH ≈ $32); no terminal to confirm on\n  fix:   add storage (`dg storage add`) so packs go to your bucket, or run `git -c dash.confirm=never push` to accept the price\n"
        );
    }

    #[test]
    fn spec_example_4_storage_policy() {
        let u = UserError::new(
            codes::STORAGE_POLICY,
            "push failed: storage policy not met (1 of 2 targets confirmed)",
        )
        .cause("r2-main: PUT 403 access denied (check the key, and that region is `auto` for R2); kubo: ok")
        .fix("`dg storage test r2-main`, then push again — kubo's copy is kept and not re-uploaded")
        .note("nothing was written to Platform")
        .without_docs();
        assert_eq!(
            render(&u),
            "error: push failed: storage policy not met (1 of 2 targets confirmed)   [E502]\n  cause: r2-main: PUT 403 access denied (check the key, and that region is `auto` for R2); kubo: ok\n  fix:   `dg storage test r2-main`, then push again — kubo's copy is kept and not re-uploaded\n  note:  nothing was written to Platform\n"
        );
    }

    #[test]
    fn spec_example_5_key_cannot_sign() {
        let u = UserError::new(codes::KEY_CANNOT_SIGN, "this browser key can't sign that")
            .cause("key #7 is bound to the dash-forge contracts; registering a DPNS name needs the master key")
            .fix("`dg auth name register alice --identity ~/alice.identity.json` (used once, not stored)")
            .without_docs();
        assert_eq!(
            render(&u),
            "error: this browser key can't sign that                                 [E302]\n  cause: key #7 is bound to the dash-forge contracts; registering a DPNS name needs the master key\n  fix:   `dg auth name register alice --identity ~/alice.identity.json` (used once, not stored)\n"
        );
    }

    #[test]
    fn spec_example_6_clone_incomplete() {
        let u = UserError::new(codes::PACKS_UNREADABLE, "clone incomplete: 2 packs unreadable")
            .cause("pack 9c4e… recorded at pub-9a1.r2.dev (404) and ipfs://bafy… (3 gateways: not found); no Platform copy")
            .fix("ask a member to run `dg reseed alice/project --from-local`; you can retry with `--gateway https://…` if you know another mirror")
            .without_docs();
        assert_eq!(
            render(&u),
            "error: clone incomplete: 2 packs unreadable                             [E503]\n  cause: pack 9c4e… recorded at pub-9a1.r2.dev (404) and ipfs://bafy… (3 gateways: not found); no Platform copy\n  fix:   ask a member to run `dg reseed alice/project --from-local`; you can retry with `--gateway https://…` if you know another mirror\n"
        );
    }

    #[test]
    fn more_line_extra_fixes_prefix_and_color() {
        let u = UserError::new(codes::NOT_FOUND, "x").fix("a").fix("b");
        let out = u.render("dash: ", false);
        let lines: Vec<&str> = out.lines().collect();
        assert!(lines.iter().all(|l| l.starts_with("dash: ")), "{out}");
        assert_eq!(lines[1], "dash:   fix:   a");
        assert_eq!(lines[2], "dash:   or:    b");
        assert_eq!(lines[3], format!("dash:   more:  {DOCS_URL}#e102"));
        let colored = u.render("", true);
        assert!(
            colored.starts_with("\x1b[1;31merror:\x1b[0m x"),
            "{colored:?}"
        );
        // Colour never changes where the code lands in the plain text.
        let strip = |s: &str| {
            let mut o = String::new();
            let mut esc = false;
            for c in s.chars() {
                match (esc, c) {
                    (_, '\x1b') => esc = true,
                    (true, 'm') => esc = false,
                    (true, _) => {}
                    (false, c) => o.push(c),
                }
            }
            o
        };
        assert_eq!(strip(&colored), u.render("", false));
    }

    #[test]
    fn exit_codes_follow_the_class_digit() {
        for (code, _) in CATALOGUE {
            let want = i32::from(code.as_bytes()[1] - b'0');
            assert_eq!(exit_code_of(code), want, "{code}");
            assert!((1..=8).contains(&want));
        }
        assert_eq!(exit_code_of("bogus"), 1);
        assert_eq!(exit_code_of("E999"), 1);
    }

    #[test]
    fn catalogue_codes_are_unique_and_documented() {
        let docs = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/errors.md"));
        let mut seen = std::collections::HashSet::new();
        for (code, title) in CATALOGUE {
            assert!(seen.insert(*code), "duplicate {code}");
            assert!(
                docs.contains(&format!("\n## {code}\n")),
                "docs/errors.md has no `## {code}` section ({title})"
            );
        }
        // …and documents nothing that is not in the catalogue.
        for line in docs.lines().filter(|l| l.starts_with("## E")) {
            let code = line.trim_start_matches("## ").trim();
            assert!(
                seen.contains(code),
                "docs/errors.md documents unknown {code}"
            );
        }
    }

    #[test]
    fn color_rules() {
        use std::ffi::OsStr;
        assert!(color_allowed(true, None, Some(OsStr::new("xterm"))));
        assert!(!color_allowed(false, None, None), "not a tty");
        assert!(
            !color_allowed(true, Some(OsStr::new("1")), None),
            "NO_COLOR"
        );
        assert!(
            color_allowed(true, Some(OsStr::new("")), None),
            "empty NO_COLOR is unset"
        );
        assert!(!color_allowed(true, None, Some(OsStr::new("dumb"))));
    }

    #[test]
    fn json_shape() {
        let v = UserError::new(codes::STORAGE_POLICY, "m")
            .cause("c")
            .fix("f")
            .to_json();
        assert_eq!(v["error"]["code"], "E502");
        assert_eq!(v["error"]["message"], "m");
        assert_eq!(v["error"]["cause"], "c");
        assert_eq!(v["error"]["fix"][0], "f");
        assert_eq!(v["error"]["exitCode"], 5);
        assert!(v["error"]["docs"].as_str().unwrap().ends_with("#e502"));
    }

    fn core_chain(e: CoreError, ctx: &ErrorContext<'_>) -> UserError {
        let e = Box::new(e);
        classify([e.as_ref() as &(dyn StdError + 'static)], ctx)
    }

    const PUSH: ErrorContext<'static> = ErrorContext {
        goal: Some("push failed"),
        rejected: Some("push rejected"),
        repo: Some("alice/project"),
        retry_is_idempotent: true,
    };

    /// The SDK's text for a forge-v2 writer-gate refusal: `ReferencedEntityNotFoundError`'s
    /// Display (`referenced {entity_type} {entity_id} not found for path {path}`), with the
    /// `ownerRefersTo` gate reported on path `$ownerId`, inside the broadcast error.
    const V2_GATE_40120: &str = "state transition broadcast error: referenced deletable document (own contract, document type writer, found through unique index byRepoAndMember) 5DtbWjpyYyNtMd3FBwyXGr3NTZzGUBGHnPHM3gs6ndmQ not found for path $ownerId";

    #[test]
    fn maps_v2_writer_gate_40120_to_e601() {
        let u = core_chain(CoreError::Platform(V2_GATE_40120.into()), &PUSH);
        assert_eq!(u.code, "E601");
        assert_eq!(
            u.message,
            "push rejected: you are not a writer of alice/project"
        );
        assert!(u.cause.as_deref().unwrap().contains("40120"), "{u:?}");
        assert!(u.fix[0].contains("dg collab add alice/project"));
        assert_eq!(u.exit_code(), 6);

        // Outside a push, the same refusal does not claim the user wanted to write refs.
        let issue = ErrorContext {
            goal: Some("release not created"),
            repo: Some("alice/project"),
            ..Default::default()
        };
        let u = core_chain(CoreError::Platform(V2_GATE_40120.into()), &issue);
        assert_eq!(u.code, "E601");
        assert_eq!(
            u.message,
            "release not created: your identity is not authorized for this action on alice/project"
        );

        // 40120 on another path is a missing referenced entity, not membership.
        let other = "state transition broadcast error: referenced identity 5DtbWjpyYyNtMd3FBwyXGr3NTZzGUBGHnPHM3gs6ndmQ not found for path assignee";
        let u = core_chain(CoreError::Platform(other.into()), &PUSH);
        assert_eq!(u.code, "E604");
        assert_eq!(
            u.message,
            "push rejected: a document it refers to at assignee does not exist"
        );
        assert!(u.cause.unwrap().starts_with("40120: "));
    }

    #[test]
    fn maps_v1_token_errors() {
        assert_eq!(core_chain(CoreError::Unauthorized, &PUSH).code, "E601");
        assert_eq!(core_chain(CoreError::TokenFrozen, &PUSH).code, "E602");
        let frozen = core_chain(
            CoreError::Platform("token freeze failed: Identity X account is frozen for token Y. Action attempted: Document create token payment".into()),
            &PUSH,
        );
        assert_eq!(frozen.code, "E602");
        assert!(frozen.fix[0].contains("dg collab unsuspend alice/project"));
        // The e2e suite recognizes a consensus freeze by these words; a local pre-check by
        // "token on this repo is frozen", which must NOT appear here.
        let typed = core_chain(CoreError::TokenFrozen, &PUSH);
        let text = typed.render("", false);
        assert!(
            text.contains("token frozen") && text.contains("access has been suspended"),
            "{text}"
        );
        assert!(!text.contains("on this repo is frozen"), "{text}");
        let unauthorized = core_chain(CoreError::Unauthorized, &PUSH).render("", false);
        assert!(
            unauthorized.contains("WRITE or MAINTAIN token"),
            "{unauthorized}"
        );
        assert!(
            !unauthorized.contains("no WRITE token on this repo"),
            "{unauthorized}"
        );
        let no_token = core_chain(
            CoreError::Platform("Identity X does not have enough balance for token Y: required 1, actual 0, action: Document create token payment".into()),
            &PUSH,
        );
        assert_eq!(no_token.code, "E601");
    }

    #[test]
    fn maps_insufficient_balance_with_amounts() {
        let ctx = ErrorContext {
            goal: Some("issue not created"),
            ..Default::default()
        };
        let u = core_chain(
            CoreError::Platform("state transition broadcast error: Insufficient identity 5Dtb balance 11000000 required 42000000".into()),
            &ctx,
        );
        assert_eq!(u.code, "E401");
        assert_eq!(u.message, "issue not created: not enough credits");
        assert_eq!(
            u.cause.as_deref(),
            Some("insufficient credits: needs 0.00042 DASH, balance 0.00011 DASH")
        );
        assert_eq!(u.exit_code(), 4);
        let u = core_chain(
            CoreError::Platform("Current credits balance 5 is not enough to pay 900 fee".into()),
            &ctx,
        );
        assert_eq!(u.code, "E401");
        let u = core_chain(
            CoreError::InsufficientCredits {
                needed: 42_000_000,
                available: 11_000_000,
            },
            &ctx,
        );
        assert_eq!(
            u.cause.as_deref(),
            Some("insufficient credits: needs 0.00042 DASH, balance 0.00011 DASH")
        );
    }

    #[test]
    fn dash_amounts_never_round_small_fees_away() {
        assert_eq!(dash(0), "0");
        assert_eq!(dash(31_000_000), "0.00031");
        assert_eq!(dash(37_300_000), "0.000373");
        assert_eq!(dash(12), "0.00000000012");
        assert_eq!(dash(48_090_000_000), "0.4809");
        assert_eq!(dash(100_000_000_000), "1.0000");
    }

    #[test]
    fn storage_timeouts_are_not_platform_outages() {
        // A storage error that mentions a timeout must not become "could not reach Dash
        // Platform" (E701): network text is only read from Platform errors.
        let e = CoreError::Io("S3 GET https://h/b/k timed out after 30 s".into());
        let u = core_chain(e, &PUSH);
        assert_eq!(u.code, "E101", "{u:?}");
        // Nor does the word "unavailable" in a Platform message on its own.
        let u = core_chain(
            CoreError::Platform(
                "the requested document type is unavailable in this contract".into(),
            ),
            &PUSH,
        );
        assert_ne!(u.code, "E701", "{u:?}");
        // The gRPC status text still is.
        let u = core_chain(
            CoreError::Platform(
                "Dapi client error: status: Unavailable, message: \"tcp connect error\"".into(),
            ),
            &PUSH,
        );
        assert_eq!(u.code, "E701");
        // …and the whole cause is kept, however long.
        let long = format!("Dapi client error: transport error: {}", "x".repeat(2000));
        let u = core_chain(CoreError::Platform(long.clone()), &PUSH);
        assert_eq!(u.cause.as_deref(), Some(long.as_str()));
    }

    #[test]
    fn maps_network_not_deployed_and_config() {
        let u = core_chain(
            CoreError::Platform("fetching identity X: Dapi client error: transport error: tcp connect error: Connection refused".into()),
            &ErrorContext::default(),
        );
        assert_eq!(u.code, "E701");
        assert_eq!(u.exit_code(), 7);
        let pushed = core_chain(
            CoreError::Platform("Dapi client error: transport error".into()),
            &PUSH,
        );
        assert_eq!(pushed.message, "push failed: could not reach Dash Platform");
        let u = core_chain(
            CoreError::NotDeployed {
                network: "mainnet".into(),
            },
            &ErrorContext::default(),
        );
        assert_eq!(u.code, "E702");
        let u = core_chain(
            CoreError::Config("invalid repo name 'Bad Name': must match ^[a-z0-9][a-z0-9._-]{0,62}$ after lowercasing".into()),
            &ErrorContext::default(),
        );
        assert_eq!(u.code, "E202");
        assert_eq!(u.exit_code(), 2);
        let u = core_chain(
            CoreError::Config(
                "no CRITICAL AUTHENTICATION key in identity file (required for token admin)".into(),
            ),
            &ErrorContext::default(),
        );
        assert_eq!(u.code, "E302");
        let u = core_chain(
            CoreError::Config("secret env:R2_SECRET is not set (export R2_SECRET=… in the environment git and dg run in)".into()),
            &ErrorContext::default(),
        );
        assert_eq!(u.code, "E505");
        let u = core_chain(
            CoreError::Config("dash.storage names unknown profile \"r3\"".into()),
            &ErrorContext::default(),
        );
        assert_eq!(u.code, "E501");
        let u = core_chain(
            CoreError::Config("invalid devnet name \"-x\"".into()),
            &ErrorContext::default(),
        );
        assert_eq!(u.code, "E204");
    }

    #[derive(Debug)]
    struct Ctx(&'static str, Box<dyn StdError + 'static>);
    impl fmt::Display for Ctx {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str(self.0)
        }
    }
    impl StdError for Ctx {
        fn source(&self) -> Option<&(dyn StdError + 'static)> {
            Some(self.1.as_ref())
        }
    }

    #[test]
    fn not_found_is_told_apart_by_the_context_chain() {
        let identity = Ctx(
            "fetching the signing identity",
            Box::new(CoreError::NotFound),
        );
        let u = classify(
            [
                &identity as &(dyn StdError + 'static),
                identity.source().unwrap(),
            ],
            &ErrorContext::default(),
        );
        assert_eq!(u.code, "E304");
        let repo = Ctx("resolving alice/project", Box::new(CoreError::NotFound));
        let ctx = ErrorContext {
            goal: Some("could not show the repo"),
            repo: Some("alice/project"),
            ..Default::default()
        };
        let u = classify(
            [&repo as &(dyn StdError + 'static), repo.source().unwrap()],
            &ctx,
        );
        assert_eq!(u.code, "E102");
        assert_eq!(
            u.message,
            "could not show the repo: alice/project was not found"
        );
    }

    #[test]
    fn a_user_error_in_the_chain_wins() {
        let inner = UserError::new(codes::COST_GUARD, "push stopped by the cost guard");
        let wrapped = Ctx("push refs", Box::new(inner.clone()));
        let u = classify(
            [
                &wrapped as &(dyn StdError + 'static),
                wrapped.source().unwrap(),
            ],
            &PUSH,
        );
        assert_eq!(u, inner);
        assert_eq!(u.exit_code(), 8);
    }

    #[test]
    fn unknown_errors_keep_the_whole_chain_as_cause() {
        let e = Ctx(
            "reading the thing",
            Box::new(std::io::Error::other("disk on fire")),
        );
        let u = classify(
            [&e as &(dyn StdError + 'static), e.source().unwrap()],
            &ErrorContext {
                goal: Some("repo not created"),
                ..Default::default()
            },
        );
        assert_eq!(u.code, "E101");
        assert_eq!(u.message, "repo not created");
        assert_eq!(u.cause.as_deref(), Some("reading the thing: disk on fire"));
        assert_eq!(u.exit_code(), 1);
    }

    #[test]
    fn timeout_fix_depends_on_retry_safety() {
        let push = core_chain(CoreError::Timeout { retryable: true }, &PUSH);
        assert_eq!(push.code, "E704");
        assert!(push.fix[0].starts_with("run it again"));
        let issue = core_chain(
            CoreError::Timeout { retryable: true },
            &ErrorContext {
                goal: Some("issue not created"),
                ..Default::default()
            },
        );
        assert!(issue.fix[0].starts_with("check whether it landed"));
    }

    #[test]
    fn replication_error_becomes_e502_with_honest_note() {
        let err = ReplicationError {
            confirmed: vec![Replica {
                target: "kubo".into(),
                uris: vec![],
                platform: false,
            }],
            required: 2,
            failures: vec![TargetFailure {
                target: "r2-main".into(),
                reason: "S3 PUT failed with status 403 Forbidden".into(),
            }],
            skipped: vec![],
        };
        let u = UserError::storage_policy_not_met(&err, "push failed", false);
        assert_eq!(u.code, "E502");
        assert_eq!(
            u.message,
            "push failed: storage policy not met (1 of 2 targets confirmed)"
        );
        assert_eq!(
            u.cause.as_deref(),
            Some("r2-main: S3 PUT failed with status 403 Forbidden; kubo: ok")
        );
        assert_eq!(
            u.fix[0],
            "`dg storage test r2-main`, then push again — kubo's copy is kept and not re-uploaded"
        );
        assert!(u.fix.iter().any(|f| f.contains("dash.platformFallback")));
        assert_eq!(
            u.note.as_deref(),
            Some("nothing was written to Platform: no packManifest and no ref")
        );
        // With a Platform copy paid for, the note must not claim nothing was written.
        let mut paid = err;
        paid.confirmed[0].platform = true;
        let u = UserError::storage_policy_not_met(&paid, "push failed", true);
        assert!(u
            .note
            .unwrap()
            .starts_with("Platform chunks that uploaded are journaled"));
        assert!(!u.fix.iter().any(|f| f.contains("dash.platformFallback")));
    }

    #[test]
    fn redaction_is_char_boundary_safe() {
        // Multi-byte text around and inside every matcher: no panic, text unchanged or
        // scrubbed only where a credential is.
        for s in [
            "é",
            "Bearer é",
            "Bearer",
            "Authorization: Bearer ñ…",
            "Authorization:",
            "token=日本語 rest",
            "clé=valeur",
            "https://ü:ß@h/…",
            "dfk1:ü",
            "…dfk1:a:b:c:d",
            "→ r2-main, kubo (need 2 of 2) · Platform stores manifest + refs only",
        ] {
            let _ = redact(s);
        }
        assert_eq!(redact("token=日本語 rest"), "token=[redacted] rest");
        assert_eq!(redact("clé=valeur"), "clé=valeur");
        assert_eq!(redact("https://ü:ß@h/…"), "https://[redacted]@h/…");
        let arrow = "dash: storage      → r2-main, kubo (need 2 of 2) · est 0.00037 DASH";
        assert_eq!(redact(arrow), arrow);
    }

    #[test]
    fn redaction_scrubs_credentials() {
        assert_eq!(
            redact("GET https://user:hunter2@r2.example.com/b/k failed"),
            "GET https://[redacted]@r2.example.com/b/k failed"
        );
        assert_eq!(
            redact("https://h/p?X-Amz-Signature=abc123&X-Amz-Date=20260101&token=zz&n=1"),
            "https://h/p?X-Amz-Signature=[redacted]&X-Amz-Date=20260101&token=[redacted]&n=1"
        );
        assert_eq!(
            redact("Authorization: Bearer eyJhbGci.x.y"),
            "Authorization: Bearer [redacted]"
        );
        assert_eq!(
            redact("DASH_FORGE_KEY=dfk1:testnet:8hJm:3:cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy"),
            "DASH_FORGE_KEY=dfk1:testnet:8hJm:3:[redacted]"
        );
        // A bare WIF (testnet, compressed: 52 chars starting with c).
        assert_eq!(
            redact("key cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy."),
            "key [redacted]."
        );
        // Identity/contract ids (43–44 chars) and hex hashes are left alone.
        let id = "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB";
        assert_eq!(redact(id), id);
        let h = "9c4e".repeat(16);
        assert_eq!(redact(&h), h);
        assert_eq!(redact("dash://alice/project"), "dash://alice/project");
        // Word boundaries and contexts: prose keeps its words.
        assert_eq!(
            redact("a basic idea, a Bearer of news"),
            "a basic idea, a Bearer of news"
        );
        assert_eq!(
            redact("monkey=banana apikey=s3cr3t"),
            "monkey=banana apikey=[redacted]"
        );
        assert_eq!(
            redact("Authorization: Basic dXNlcjpwYXNz; next"),
            "Authorization: Basic [redacted]; next"
        );
        assert_eq!(
            redact("authorization=abc123 ok"),
            "authorization=[redacted] ok"
        );
        // A bare WIF after `=`.
        assert_eq!(
            redact("WIF=cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy"),
            "WIF=[redacted]"
        );
        // Rendering applies it.
        let u = UserError::new(codes::UNEXPECTED, "x").cause("https://a:b@h/");
        assert!(!u.render("", false).contains("a:b"));
        assert!(!u.to_json().to_string().contains("a:b"));
    }
}
