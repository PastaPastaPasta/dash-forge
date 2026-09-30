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

/// A repo's page in the web app.
pub fn web_url(owner_id: &str, name: &str) -> String {
    web_page_url("repo", owner_id, name)
}

/// A page of a repo in the web app (`repo`, `repo/commit/`, …), addressed by owner and name.
pub fn web_page_url(page: &str, owner_id: &str, name: &str) -> String {
    use crate::backends::sigv4::uri_encode;
    format!(
        "{WEB_ORIGIN}/{page}?owner={}&name={}",
        uri_encode(owner_id, false),
        uri_encode(name, false)
    )
}

/// Where to top up an identity's credits from any Dash wallet.
pub const TOP_UP_URL: &str = "https://bridge.thepasta.org";

/// E502's note when Platform chunks were (or may have been) uploaded before the policy
/// failed.
pub const NOTE_PLATFORM_CHUNKS_JOURNALED: &str = "Platform chunks that uploaded are journaled and reused by the next push; no packManifest and no ref was written";

/// `code` as its `'static` catalogue entry, when it is one (a code another binary reported).
pub fn catalogued(code: &str) -> Option<&'static str> {
    CATALOGUE.iter().find(|(c, _)| *c == code).map(|(c, _)| *c)
}

/// The stable code catalogue: `(code, one-line title)`. `docs/errors.md` has one section per
/// entry, in this order.
pub const CATALOGUE: &[(&str, &str)] = &[
    (codes::UNEXPECTED, "unexpected error"),
    (codes::NOT_FOUND, "not found"),
    (codes::NOT_IMPLEMENTED, "not implemented yet"),
    (codes::CHECKS_FAILED, "checks failed"),
    (codes::MERGE_CONFLICT, "merge has conflicts"),
    (codes::PARTIAL, "partially completed"),
    (codes::SUGGESTION, "suggestion not applicable"),
    (codes::USAGE, "invalid arguments"),
    (codes::INVALID_REPO_NAME, "invalid repository name"),
    (
        codes::INVALID_REPO_REF,
        "invalid repository reference or dash:// URL",
    ),
    (codes::INVALID_CONFIG, "invalid configuration"),
    (codes::UNSUPPORTED, "unsupported git operation"),
    (codes::GIT_REPO, "git repository not usable"),
    (
        codes::PRIVATE_UNSUPPORTED,
        "not supported for a private repository",
    ),
    (codes::NO_IDENTITY, "no identity configured"),
    (codes::KEY_CANNOT_SIGN, "this key can't sign that"),
    (codes::IDENTITY_UNREADABLE, "identity file unreadable"),
    (
        codes::IDENTITY_NOT_FOUND,
        "identity not found on this network",
    ),
    (codes::KEY_EXPIRED, "this key expired or was disabled"),
    (
        codes::NO_ENCRYPTION_KEY,
        "no encryption key for private repositories",
    ),
    (
        codes::NOT_A_KEY_HOLDER,
        "no key for this private repository",
    ),
    (codes::KEY_MISMATCH, "a maintainer gave you the wrong key"),
    (
        codes::KEY_CHAIN_BROKEN,
        "the repository's key chain is broken",
    ),
    (codes::ROTATION_PENDING, "key rotation or repair pending"),
    (codes::INSUFFICIENT_CREDITS, "not enough credits"),
    (codes::KEY_BUDGET_SPENT, "this key's budget is used up"),
    (codes::STORAGE_CONFIG, "storage not configured correctly"),
    (codes::STORAGE_POLICY, "storage policy not met"),
    (codes::PACKS_UNREADABLE, "packs unreadable"),
    (codes::INTEGRITY, "integrity check failed"),
    (codes::STORAGE_SECRET, "storage credentials unavailable"),
    (codes::STORAGE_TEST, "storage profile failed its checks"),
    (codes::RECORDED_COPY_LOST, "recorded pack copy unreachable"),
    (codes::NO_STORAGE, "no storage configured"),
    (codes::SEALED_PACK_CORRUPT, "sealed pack corrupt"),
    (codes::LATE_CONTENT, "written after the key was rotated"),
    (
        codes::OBJECT_REFUSED,
        "git refused an object in the history",
    ),
    (codes::NOT_A_WRITER, "not a writer of this repository"),
    (codes::ALREADY_EXISTS, "already exists"),
    (codes::REJECTED, "rejected by Platform"),
    (codes::ARCHIVED, "repository archived"),
    (codes::EDIT_CONFLICT, "edited by someone else meanwhile"),
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
    (codes::POLICY_NOT_MET, "branch policy not met"),
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
    /// `dg pr merge` cannot merge without a person: the head and base conflict.
    pub const MERGE_CONFLICT: &str = "E105";
    /// `dg import` finished, but skipped some items; a re-run retries them.
    pub const PARTIAL: &str = "E106";
    /// A review suggestion cannot be applied: overlapping ranges, an older head, the old side,
    /// or lines that no longer exist.
    pub const SUGGESTION: &str = "E107";
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
    /// `dg init` / `dg repo create --push` cannot use the local git repository: not inside
    /// one, or the remote name is taken by another URL; or `dg pr checkout` would drop local
    /// commits on `pr/<n>`.
    pub const GIT_REPO: &str = "E206";
    /// An operation a private repository does not support (a release, a fork, a webhook):
    /// refused before anything is written.
    pub const PRIVATE_UNSUPPORTED: &str = "E207";
    /// No identity file configured.
    pub const NO_IDENTITY: &str = "E301";
    /// The identity has no key of the level this operation needs.
    pub const KEY_CANNOT_SIGN: &str = "E302";
    /// The identity file is missing or malformed.
    pub const IDENTITY_UNREADABLE: &str = "E303";
    /// The identity does not exist on the selected network.
    pub const IDENTITY_NOT_FOUND: &str = "E304";
    /// The signing key is past its expiry or disabled (protocol-14 limited keys).
    pub const KEY_EXPIRED: &str = "E305";
    /// A private repository needs an `ENCRYPTION` key the identity file holds.
    pub const NO_ENCRYPTION_KEY: &str = "E306";
    /// No accepted `repoKey` wrap opens this private repository for the identity.
    pub const NOT_A_KEY_HOLDER: &str = "E307";
    /// A current maintainer's wrap holds a key that is not the epoch's (§5.4 KeyMismatch).
    pub const KEY_MISMATCH: &str = "E308";
    /// The `prevEpochKey` chain stops before an epoch the content needs (ChainBroken).
    pub const KEY_CHAIN_BROKEN: &str = "E309";
    /// The current epoch cannot be written under yet: a rotation or a repair is pending.
    pub const ROTATION_PENDING: &str = "E310";
    /// The identity's balance cannot pay for the write.
    pub const INSUFFICIENT_CREDITS: &str = "E401";
    /// The signing key has spent its whole budget (protocol-14 limited keys).
    pub const KEY_BUDGET_SPENT: &str = "E402";
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
    /// A new repository has no storage profile to push to; stopped before any spend.
    pub const NO_STORAGE: &str = "E508";
    /// A sealed (private-repository) artifact failed its checks after its hash verified.
    pub const SEALED_PACK_CORRUPT: &str = "E509";
    /// Content under a superseded key epoch, written after the rotation by a non-member.
    pub const LATE_CONTENT: &str = "E510";
    /// git's object checks refused an object (a `.git` look-alike, a hostile `.gitmodules`, a
    /// corrupt tree or commit): in a fetched pack, before any ref points at it; or in a push's
    /// (or an import's) pack, before anything is stored or paid for.
    pub const OBJECT_REFUSED: &str = "E511";
    /// Consensus refused a write: no `writer`/`maintainer` document (40120).
    pub const NOT_A_WRITER: &str = "E601";
    // E602 (token suspended) is retired with forge-v1 and stays reserved.
    /// A unique index collision (a name or number already taken).
    pub const ALREADY_EXISTS: &str = "E603";
    /// Any other consensus rejection.
    pub const REJECTED: &str = "E604";
    // E605 (v1 repository is read only) is retired with forge-v1 and stays reserved.
    /// The repository is archived (a client rule: the tools refuse writes unless overridden).
    pub const ARCHIVED: &str = "E606";
    /// An edit made against a revision another edit has since replaced (nothing written).
    pub const EDIT_CONFLICT: &str = "E607";
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
    /// The repository's branch `policy` (a client rule) is not met by this merge.
    pub const POLICY_NOT_MET: &str = "E804";
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
            if i == 0 {
                line("fix", "1;32", f);
            } else {
                // The label says "or" already: a fix written "or …" must not read "or: or …".
                line("or", "1;32", f.strip_prefix("or ").unwrap_or(f));
            }
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
    /// The error comes from `git-remote-dash` under a plain `git` command, which takes no
    /// `dg` flags: a fix names git config or the environment instead.
    pub via_git: bool,
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
    // A phrased error raised inside forge-core (`Error::User`): kept as raised, but the
    // context layers wrapped around it (what had already happened, what to do next) are
    // carried as its note rather than dropped.
    if let Some(i) = layers
        .iter()
        .position(|l| matches!(l.downcast_ref::<CoreError>(), Some(CoreError::User(_))))
    {
        let Some(CoreError::User(u)) = layers[i].downcast_ref::<CoreError>() else {
            unreachable!("matched above")
        };
        let mut u = (**u).clone();
        let outer: Vec<String> = layers[..i].iter().map(ToString::to_string).collect();
        if !outer.is_empty() {
            let mut note = outer.join(": ");
            if let Some(n) = &u.note {
                note = format!("{n}; {note}");
            }
            u = u.note(note);
        }
        return u;
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
        CoreError::NotAMember {
            document_type,
            detail,
        } if MAINTAINER_ONLY.contains(&document_type.as_str()) => {
            needs_maintainer(ctx, document_type, detail)
        }
        CoreError::NotAMember { detail, .. } if detail.ends_with("for path asMember") => {
            as_member_refused(ctx, detail)
        }
        CoreError::NotAMember { detail, .. } => not_a_writer(ctx, detail),
        CoreError::ReferenceNotFound {
            document_type,
            path,
            detail,
        } => missing_reference(ctx, Some(document_type), path, detail),
        CoreError::NotPermitted {
            action,
            reason,
            needs,
        } => not_permitted(ctx, action, reason, needs),
        // 10422: a `propertyConstraints` rule of the type does not hold (forge-v2: a state move
        // the target's transitions do not allow, an author's merge, a stale dense number).
        CoreError::RuleRefused {
            document_type,
            rule,
            detail,
        } => rule_refused(ctx, document_type, rule, detail),
        CoreError::V2NotDeployed { network } => not_deployed(ctx, network),
        CoreError::ContractsMissing { network, detail } => contracts_missing(ctx, network, detail),
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
        CoreError::IdentityNotFound {
            identity_id,
            network,
            key_network,
        } => identity_not_found(ctx, identity_id, network, key_network.as_deref()),
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
        CoreError::Platform(msg) => return from_platform_text(msg, ctx),
        CoreError::User(u) => (**u).clone(),
        _ => return None,
    })
}

/// E601 for a write the client refused before signing: the signer holds no role (or is
/// not the author) that consensus would admit.
fn not_permitted(ctx: &ErrorContext<'_>, action: &str, reason: &str, needs: &str) -> UserError {
    let repo = ctx.repo_or("<owner>/<repo>");
    let u = UserError::new(
        codes::NOT_A_WRITER,
        ctx.rejected_headline(&format!("you cannot {action}")),
    )
    .cause(reason)
    .note("checked before anything was signed; nothing was written or paid");
    if needs == "author" {
        u.fix("ask the author or a member of the repository to do it")
    } else if needs == "owner" && action.starts_with("delete ") {
        // A delete: consensus admits it from the document's owner only, maintainers included.
        u.fix("only the author can delete it; ask them to")
    } else if needs == "owner" {
        // An edit: consensus admits a document replace from its owner only, members included.
        u.fix("only the author can edit it; comment instead, or ask them to make the change")
    } else if matches!(needs, "writer" | "maintainer") {
        u.fix(join_fix(&repo, "<your identity id>", needs))
    } else {
        // Not a role a member can be given (the repository's owner, …).
        u.fix(format!("ask {needs} to do it"))
    }
}

/// How a member stores a key source that can open private repositories: the limited key
/// `dg auth login` and `dg auth new` store is a signing key only, so the full identity is kept
/// instead, from its file or from the recovery words (QW-040).
pub const FIX_FULL_KEY_LOGIN: &str = "`dg auth login --full-key <identity file>`, or `dg auth login --mnemonic --full-key` with your 12 recovery words";

/// The E601 way in: the owner's add, and before it, for someone not a member yet, their own
/// consent (`member_consent`: a `member` document naming the add is refused without it, E604;
/// QW-039). `who` is the member's id as the reader should type it.
pub fn join_fix(repo: &str, who: &str, role: &str) -> String {
    format!(
        "not a member yet? run `dg collab accept {repo}` first (your consent, as the web's Accept; the add is refused without it), then ask the owner to run `dg collab add {repo} {who} --role {role}`"
    )
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
    // Protocol-14 key limits (PublicKeyBudgetExhaustedError / PublicKeyExpiredError), before
    // the balance rule: a spent key is not an empty identity.
    // … or IdentityPublicKeyBudgetExceededError: some budget left, but less than this costs.
    if m.contains("has spent its whole budget") || m.contains("credits of budget left") {
        return Some(
            UserError::new(codes::KEY_BUDGET_SPENT, ctx.headline("this key's budget is used up"))
                .cause(one_line(msg))
                .fix("register a fresh limited key (uses your master key once): `dg auth login <identity file>` or `dg auth login --mnemonic`")
                .note("the identity's balance is untouched; only this key can no longer sign"),
        );
    }
    if m.contains("can no longer sign") && m.contains("expired") {
        return Some(
            UserError::new(codes::KEY_EXPIRED, ctx.headline("this key has expired"))
                .cause(one_line(msg))
                .fix("register a fresh limited key (uses your master key once): `dg auth login <identity file>` or `dg auth login --mnemonic`"),
        );
    }
    // A contract-bound key used outside its bounds: ContractBoundedKeyOutOfBoundsError (20014),
    // or ContractBoundedKeyNonBatchError for a transition that is not a document batch. rs-dpp
    // checks both before signing too, so nothing is broadcast. A CI runner's key is bound to
    // `checkRun` only.
    if m.contains("outside the contract bounds of key")
        || m.contains("cannot sign a non-batch transition")
    {
        return Some(
            UserError::new(codes::KEY_CANNOT_SIGN, ctx.headline("this key can't sign that"))
                .cause(format!(
                    "the key is bound to one contract or document type, and this write is outside it: {}",
                    one_line(msg)
                ))
                .fix("sign this with a key whose bounds cover it: your own limited key (`dg auth login`), not a key bound to another contract or document type")
                .note("a CI runner key (`dg ci runner new`) can only write check runs"),
        );
    }
    // PublicKeyIsDisabledError ("Identity key N is disabled"), or the same caught before signing.
    if m.contains("is disabled")
        && (m.contains("identity key") || m.contains("identity public key"))
    {
        return Some(
            UserError::new(codes::KEY_EXPIRED, ctx.headline("this key was disabled"))
                .cause(one_line(msg))
                .fix("sign in again with a live key: `dg auth login <identity file>` registers a new one; `dg auth keys list` shows which are live"),
        );
    }
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
    // 40120 ReferencedEntityNotFound. On path `$ownerId` it is forge-v2's writer gate
    // (`ownerRefersTo`), and on `asMember` RC1's membership proof: no current
    // `writer`/`maintainer` document for the signer. On any other path a referenced document,
    // contract or identity is missing — a rejection, but not about membership.
    if let Some(path) = referenced_path(msg) {
        if path == "$ownerId" {
            return Some(not_a_writer(
                ctx,
                "40120: no writer/maintainer document for your identity",
            ));
        }
        if path == "asMember" {
            return Some(as_member_refused(
                ctx,
                "40120: no writer/maintainer document for your identity, which asMember claims",
            ));
        }
        return Some(missing_reference(
            ctx,
            None,
            path,
            &format!("40120: {}", one_line(msg)),
        ));
    }
    // 10422 DocumentPropertyConstraintViolated, as text: the same rendering as the typed error.
    if let Some((document_type, rule)) = violated_rule(msg) {
        return Some(rule_refused(ctx, &document_type, &rule, &one_line(msg)));
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

/// E304 for a signing identity that `network` does not have (QW-032: it named no network).
/// When the key records another network, the fix selects that one, in the form the failing
/// tool takes (`dg` flags, or the git config and environment the helper reads).
fn identity_not_found(
    ctx: &ErrorContext<'_>,
    identity_id: &str,
    network: &str,
    key_network: Option<&str>,
) -> UserError {
    let u = UserError::new(
        codes::IDENTITY_NOT_FOUND,
        ctx.headline(&format!("your identity does not exist on {network}")),
    );
    let Some(there) = key_network
        .filter(|k| *k != network)
        .map(crate::platform::Network::from_key)
    else {
        return u
            .cause(format!("Platform ({network}) has no identity {identity_id}"))
            .fix(if ctx.via_git {
                "select the network the identity was created on: `git config dash.network <net>` (and `dash.devnetName` on a devnet), or DASH_FORGE_NETWORK for one command"
            } else {
                "select the network the identity was created on: `--network testnet|mainnet`, or `--network devnet --devnet-name <name>`; `dg auth status` shows the network in use"
            });
    };
    let u = u.cause(format!(
        "your key is for {there}, and Platform ({network}) has no identity {identity_id}"
    ));
    if ctx.via_git {
        u.fix(format!(
            "use the key's network in this repository: `{}`",
            there.git_config_command("")
        ))
        .fix(format!(
            "for one command: `{} git …`",
            there.env_assignments()
        ))
    } else {
        u.fix(format!(
            "use the key's network: `{}` (`dg auth login` records it as the default)",
            there.dg_flags()
        ))
    }
}

fn not_found(chain: &str, ctx: &ErrorContext<'_>) -> UserError {
    if chain.contains("fetching the signing identity") || chain.contains("fetching identity") {
        return UserError::new(
            codes::IDENTITY_NOT_FOUND,
            ctx.headline("your identity does not exist on this network"),
        )
        .cause("Platform has no identity with the id in your identity file")
        .fix("select the network the identity was created on (`--network`, or sign in there: `dg auth login <file> --network <net>`); `dg auth status` shows both");
    }
    let repo = ctx.repo_or("the repository");
    if chain.contains("resolving") || chain.contains("fetching contract") {
        return UserError::new(codes::NOT_FOUND, ctx.headline(&format!("{repo} was not found")))
            .cause("there is no repository with that owner and name on this network")
            .fix("check the owner id and name: `dg repo list --owner <owner identity id>` lists an owner's repositories")
            .fix("check the network: `dg doctor` shows which network and contracts are in use");
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

/// The document types only a `maintainer` may create: their `ownerRefersTo` gate admits a
/// maintainer document alone (RC1 contracts; checked against them in the tests).
const MAINTAINER_ONLY: [&str; 6] = [
    "protectedRefUpdate",
    "config",
    "release",
    "repoKey",
    "policy",
    "webhook",
];

/// E601 for a maintainer-only write by someone who is not a maintainer (possibly a writer).
fn needs_maintainer(ctx: &ErrorContext<'_>, document_type: &str, why: &str) -> UserError {
    let repo = ctx.repo_or("<owner>/<repo>");
    let what = match document_type {
        "protectedRefUpdate" => "a protected ref",
        "config" => "the repository's configuration",
        "release" => "its releases",
        "repoKey" => "who holds its keys",
        "policy" => "its merge policy",
        "webhook" => "its webhooks",
        _ => "this",
    };
    let u = UserError::new(
        codes::NOT_A_WRITER,
        ctx.rejected_headline(&format!(
            "only maintainers of {} can change {what}",
            ctx.repo_or("this repo")
        )),
    )
    .cause(format!(
        "Platform refused the {document_type} at consensus ({why})"
    ))
    .fix(join_fix(&repo, "<your identity id>", "maintainer"));
    if document_type == "protectedRefUpdate" {
        u.fix("push to a branch that is not protected")
    } else {
        u
    }
}

/// E601 for a write whose `asMember` proof found no maintainer/writer document. Membership is
/// read once per command, so the likeliest cause is a revocation since: run again, the command
/// writes as a non-member, which an issue, a comment or a comment review needs no proof for.
fn as_member_refused(ctx: &ErrorContext<'_>, why: &str) -> UserError {
    let u = not_a_writer(ctx, why);
    let mut fix = vec![
        "if you were a member when the command started, your membership was revoked since: run it again, and it writes as a non-member (an import or an approval still needs membership)".to_string(),
    ];
    fix.extend(u.fix.iter().cloned());
    UserError { fix, ..u }
}

/// A 40120 on a property (not the membership gates): what it refers to does not exist.
/// `document_type` is known for a typed error; from text, a `memberId` referring to a
/// maintainer/writer document can only be a `repoKey`'s.
fn missing_reference(
    ctx: &ErrorContext<'_>,
    document_type: Option<&str>,
    path: &str,
    detail: &str,
) -> UserError {
    let wraps_to_member = path == "memberId"
        && match document_type {
            Some(t) => t == "repoKey",
            // From text the type is unknown: only a repoKey's memberId refers to a member document.
            None => {
                detail.contains("document type maintainer")
                    || detail.contains("document type writer")
            }
        };
    if wraps_to_member {
        // RC1: a `repoKey` may only wrap to a current maintainer or writer.
        return UserError::new(
            codes::REJECTED,
            ctx.rejected_headline("a key wrap names someone who is not (or no longer) a member"),
        )
        .cause(detail)
        .fix("run the command again: it re-reads the members and plans the wraps afresh")
        .note("the wrap's recipient holds no maintainer or writer document (revoked after the wraps were planned, or never enrolled); nothing was written");
    }
    if path == "consentBy" {
        // RC1: a maintainer/writer enrolled by the owner names the member's own `consent`.
        return UserError::new(
            codes::REJECTED,
            ctx.rejected_headline("the member has not accepted the invitation yet"),
        )
        .cause(detail)
        .fix("ask them to accept it (they write a consent document for the repository), then run the command again")
        .note("nothing was written");
    }
    UserError::new(
        codes::REJECTED,
        ctx.rejected_headline(&format!("a document it refers to at {path} does not exist")),
    )
    .cause(detail)
    .fix("check the id you passed for that field; the cause names the missing entity")
}

/// E604 for a 10422: the document breaks `rule` of its type's `propertyConstraints`. The
/// headline names the rule; the cause says what it asks for when the rule does not hold and
/// this build knows it. A fault evaluating the rule (an overflow, a division by zero, a value
/// that is not an integer) is the node's words alone: it is not about what the rule asks.
fn rule_refused(
    ctx: &ErrorContext<'_>,
    document_type: &str,
    rule: &str,
    detail: &str,
) -> UserError {
    let u = UserError::new(
        codes::REJECTED,
        ctx.headline(&format!("consensus refused it by the rule {rule:?}")),
    );
    let not_met = detail.contains("it does not hold");
    match rule_explanation(document_type, rule).filter(|_| not_met) {
        Some(why) => u
            .cause(format!("{why} (10422: {document_type} rule {rule})"))
            .note(format!(
                "refused before execution: nothing was written. Platform said: {detail}"
            )),
        None => u
            .cause(detail)
            .note("refused before execution: nothing was written"),
    }
}

/// `(document type, rule)` of a 10422 message: `A document of type "issue" breaks its
/// propertyConstraints rule "dense": …`, quotes plain or escaped (a `Debug`-printed error).
fn violated_rule(msg: &str) -> Option<(String, String)> {
    let msg = msg.replace("\\\"", "\"");
    let quoted = |after: &str| -> Option<String> {
        let rest = &msg[msg.find(after)? + after.len()..];
        Some(rest[..rest.find('"')?].to_string())
    };
    let rule = quoted("breaks its propertyConstraints rule \"")?;
    Some((quoted("document of type \"").unwrap_or_default(), rule))
}

/// What each RC1 `propertyConstraints` rule asks for, in a user's words, by rule name (the keys
/// of the generated contracts; the tests keep this table and the contracts equal). Where a rule
/// of the same name asks something else on one type, [`RULE_EXPLANATIONS_BY_TYPE`] says it.
const RULE_EXPLANATIONS: &[(&str, &str)] = &[
    // forge-core
    ("forkIsPublic", "a fork must be public"),
    ("privateNoBranch", "a private repository does not store its default branch in plaintext"),
    ("nameNotDotGit", "a repository name may not end in .git"),
    ("ownerOrConsented", "only the owner may enrol itself; anyone else is enrolled once they have accepted (consentBy names the member)"),
    ("noPlain", "a private or sealed document may not also carry its content in plaintext"),
    ("hasName", "a ref update needs its ref name (sealed in a private repository)"),
    ("noLock", "a ref name may not end in .lock"),
    ("oidWidth", "a commit id is 20 bytes (SHA-1) or 32 bytes (SHA-256)"),
    ("encV2", "a sealed config needs at least 61 bytes (the v2 sealing format)"),
    ("platformChunks", "not every chunk of the pack is on Platform yet (their count and sequence numbers must match chunkCount); run the push again to upload the rest"),
    ("storageShape", "the pack size does not fit its chunks (at most 14,700 bytes a chunk on Platform, and no chunks for external storage)"),
    ("kindShape", "a pack's supersedes list holds whole 32-byte hashes, and a tips pack (kind 3) carries 20, 32, 40 or 64 bytes of tips"),
    ("sizeNonNeg", "a pack size is between 0 and 1 TiB"),
    ("oneLive", "a tag has at most one live release: publish (+1) only when none is live, and unpublish (-1), edit or yank (0) only a live one; a sealed release always carries 0. Re-read the releases and run it again"),
    ("atMost20", "a repository has at most 20 topics; remove one first"),
    // forge-collab
    ("hasTitle", "an issue or pull request needs a title (sealed in a private repository)"),
    ("dense", "the number was taken by another issue or pull request created at the same time; run it again for the next number"),
    ("p_sealedIfPrivate", "a private repository's issues, pull requests and comments are sealed (encrypted)"),
    ("m_self", "asMember must name the signer itself"),
    ("i_provenance", "an imported item (imported or upstreamNumber) is written by a maintainer or writer, with asMember set"),
    ("a_kindOfTarget", "the state change does not fit its target (issue kinds on an issue, pull request kinds on a pull request)"),
    ("b1_closeDelta", "a close carries delta +1"),
    ("b2_reopenDelta", "a reopen carries delta -1"),
    ("b3_otherDelta", "a merge carries delta +2, a draft +8 and ready -8"),
    ("c1_closedAfter", "it was not open when the close landed (another state change came first); re-read it and run the command again"),
    ("c2_openAfter", "it was not closed (or not a draft) when this landed (another state change came first); re-read it and run the command again"),
    ("c3_mergedAfter", "the pull request was not open and ready when the merge landed (another state change came first); re-read it and run the command again"),
    ("c4_draftAfter", "the pull request was not in the state this moves from when it landed (another state change came first); re-read it and run the command again"),
    ("c5_draftClosedAfter", "the pull request was not an open draft when the close landed (another state change came first); re-read it and run the command again"),
    ("e_mergeOid", "a merge names its merge commit (oid)"),
    ("f_authorNoMerge", "a pull request's author cannot merge it unless they are a maintainer or writer"),
    ("b4_lockDelta", "a lock carries delta +16 and an unlock -16"),
    ("c6_lockedAfter", "the thread was already locked (or already unlocked) when this landed; re-read it and run the command again"),
    ("g_memberLock", "only a maintainer or writer can lock or unlock a thread"),
    ("hasBody", "a comment needs a body (sealed in a private repository)"),
    ("noParentSet", "noParent is reserved and is never set"),
    ("rangeOrder", "a range comment needs a line, and its start line may not follow it"),
    ("lockGate", "the thread is locked: only maintainers and writers (writing with asMember) can post"),
    ("memberVerdict", "approve and request changes (verdicts 1 and 2) are a member's and need asMember; a non-member's are verdicts 4 and 5, without asMember"),
    // forge-community
    ("publicOnly", "webhooks are for public repositories only"),
    ("conclusionIfDone", "a completed check run needs a conclusion"),
    ("doneIfConclusion", "only a completed check run has a conclusion"),
    ("startedIfRunning", "a check run past queued needs its start time (startedAt)"),
    ("runningIfStarted", "a queued check run has no start time (startedAt)"),
    ("completedAtIfDone", "a completed check run needs its completion time (completedAt)"),
    ("doneIfCompletedAt", "only a completed check run has a completion time (completedAt)"),
    ("doneAfterStart", "a check run cannot complete before it started"),
    ("msEpoch", "check-run times are in milliseconds since 1970"),
    ("notFuture", "a check-run time is more than an hour past the block time; check the reporting machine's clock"),
    ("outcomeOf", "outcome must match the run: 0 while pending, 1 for success, neutral or skipped, 2 for any other conclusion"),
    ("privateNoText", "a private repository's check runs carry no summary, links, log, artifacts or external id"),
    ("sourcesMatchNames", "requiredCheckSources lists one source per required check (or none)"),
    ("needValue", "this event needs a value (a label, a retarget base or a milestone)"),
    ("needAssignee", "an assign or unassign event names the assignee as both value and refId"),
    ("needRefId", "this event needs refId (a thread, a reviewer or a review)"),
    ("needOid", "a head update names the new head commit (oid)"),
    ("noState", "a state change (draft, ready, lock, unlock) is a transition, not an event"),
];

/// The rules whose meaning on one document type differs from [`RULE_EXPLANATIONS`]' entry.
const RULE_EXPLANATIONS_BY_TYPE: &[(&str, &str, &str)] = &[
    (
        "review",
        "p_sealedIfPrivate",
        "a private repository's review carries no plaintext body or import details (seal them)",
    ),
    (
        "comment",
        "i_provenance",
        "an imported comment is written by a maintainer or writer, with asMember set",
    ),
    (
        "authorEvent",
        "needRefId",
        "this event needs refId (a thread or a reviewer)",
    ),
];

/// What `rule` asks of a `document_type`: its entry in [`RULE_EXPLANATIONS_BY_TYPE`], else in
/// [`RULE_EXPLANATIONS`].
fn rule_explanation(document_type: &str, rule: &str) -> Option<&'static str> {
    RULE_EXPLANATIONS_BY_TYPE
        .iter()
        .find_map(|(t, name, why)| (*t == document_type && *name == rule).then_some(*why))
        .or_else(|| {
            RULE_EXPLANATIONS
                .iter()
                .find_map(|(name, why)| (*name == rule).then_some(*why))
        })
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
        .fix(join_fix(&repo, "<your identity id>", "writer|maintainer"));
    }
    UserError::new(
        codes::NOT_A_WRITER,
        ctx.rejected_headline(&format!(
            "you are not a writer of {}",
            ctx.repo_or("this repo")
        )),
    )
    .cause(format!("Platform refused the write at consensus ({why})"))
    .fix(join_fix(&repo, "<your identity id>", "writer"))
    .fix("push to a repo of your own: `dg repo create <name>`, then `git push dash://<you>/<name> <branch>`")
}

/// E702: no forge-v2 on `network`. The fix names a network that has it, in the form the
/// failing tool takes: `dg` flags, or (under `git`, which passes no flags to the helper) the
/// git config and environment the helper reads.
fn not_deployed(ctx: &ErrorContext<'_>, network: &str) -> UserError {
    let u = UserError::new(
        codes::NOT_DEPLOYED,
        ctx.headline(&format!("forge-v2 isn't deployed on {network} yet")),
    )
    .cause(format!(
        "forge-contracts/deployments/{network}.json records no forge-v2 contracts"
    ));
    let Some(there) = crate::network::suggested_v2_network() else {
        return u.note("no network has a forge-v2 deployment in this build");
    };
    if !ctx.via_git {
        return u.fix(format!("use a network where it is: `{}`", there.dg_flags()));
    }
    u.fix(format!(
        "use a network where it is: `{}`, then run the git command again",
        there.git_config_command("--global ")
    ))
    .fix(format!(
        "for one command: `{} git …`",
        there.env_assignments()
    ))
}

/// E702 as well: this build records forge-v2 contracts for `network`, but the network does not
/// have them. On a devnet that means it was reset and Forge is not deployed again yet; anywhere
/// else, that the embedded deployment record is wrong. Running it again cannot help.
fn contracts_missing(ctx: &ErrorContext<'_>, network: &str, detail: &str) -> UserError {
    let (note, fix) = if network.starts_with("devnet ") {
        (
            "a devnet is reset from time to time, which removes every contract on it; retrying will not help",
            "the network may have been reset: update dg and git-remote-dash to a release made after Forge was deployed on it again",
        )
    } else {
        (
            "this build's deployment record names contracts the network does not have; retrying will not help",
            "update dg and git-remote-dash: this build's contract ids are wrong for this network",
        )
    };
    let u = UserError::new(
        codes::NOT_DEPLOYED,
        ctx.headline(&format!("forge contracts not found on {network}")),
    )
    .cause(detail)
    .note(note)
    .fix(fix)
    .fix("`dg doctor` shows the network and contract ids in use");
    if ctx.via_git {
        u.fix("check the network the helper uses: `git config --get dash.network` and `git config --get dash.devnetName` (DASH_FORGE_NETWORK overrides them)")
    } else {
        u.fix("check it is the network you meant: `--network <testnet|mainnet|devnet> [--devnet-name <name>]`")
    }
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

/// E301 for a read of private `repo` (its `owner/name`) with no identity: its content is
/// encrypted to members' keys. Public repositories are read without one.
pub fn private_needs_identity(repo: &str) -> UserError {
    UserError::new(
        codes::NO_IDENTITY,
        format!("{repo} is private: reading it needs your identity"),
    )
    .cause("its issues, pull requests and comments are encrypted to its members' ENCRYPTION keys")
    .fix(format!("sign in as a member with a key source that holds your ENCRYPTION key: {FIX_FULL_KEY_LOGIN}"))
    .fix("for one command: --identity <identity file>, or DASH_FORGE_KEY=<identity file>")
    .note("public repositories are read without an identity")
}

fn identity_unreadable(msg: &str) -> UserError {
    // A sealed key that cannot be asked for (QW-034): the way out is the passphrase, not a
    // new sign-in, which costs a key registration.
    if msg.contains("needs a passphrase") {
        return UserError::new(
            codes::IDENTITY_UNREADABLE,
            "your key is sealed with a passphrase, and it could not be asked for",
        )
        .cause(msg)
        .fix("run the same command in a terminal: it asks for the passphrase once")
        .fix("scripts and CI: set DASH_FORGE_PASSPHRASE, or DASH_FORGE_KEY to a `dg auth export --format dfk1` key")
        .note("reads of public repositories, `dg auth status` and `dg auth balance` do not need the key opened");
    }
    UserError::new(
        codes::IDENTITY_UNREADABLE,
        "could not load your identity file",
    )
    .cause(msg)
    .fix("`dg auth status` shows which key source is in use; `dg auth login <file>` (or `--mnemonic`) stores a key again")
    .fix("pass `--identity <file>` / set DASH_FORGE_KEY for one command (the helper reads DASH_FORGE_KEY)")
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
/// values, the WIF of a `dfk1:` key string, WIF-shaped and 64-hex private keys (bare or after
/// `=`), and recovery phrases (a run of [`PHRASE_WORDS`] or more BIP39 words).
/// The primary defence is that secrets never enter error text (they live in
/// [`crate::keystore::Secret`]); this is the last line.
///
/// Works on `char`s throughout (never slices inside a multi-byte character) and matches keys
/// only at a word boundary, so prose ("a basic idea", "monkey=…") is left alone.
pub fn redact(s: &str) -> String {
    // Phrases first: a `key=` in front of the first word would otherwise be redacted with that
    // word alone, leaving the other eleven.
    let s = redact_phrases(s);
    let s = redact_userinfo(&s);
    let s = redact_key_values(&s);
    let s = redact_authorization(&s);
    redact_tokens(&s)
}

/// The shortest recovery phrase (12 words; 24 is the other common length).
const PHRASE_WORDS: usize = 12;

/// What an alphanumeric run is to [`redact_phrases`]: a BIP39 word, a number (which neither
/// counts nor breaks a run), or anything else (which breaks it).
#[derive(Clone, Copy, PartialEq)]
enum PhraseToken {
    Word,
    Number,
    Other,
}

fn kind_of(tok: &str) -> PhraseToken {
    if tok.bytes().all(|b| b.is_ascii_digit()) {
        PhraseToken::Number
    } else if tok.len() >= 3
        && tok.bytes().all(|b| b.is_ascii_alphabetic())
        && bip39::Language::English
            .find_word(&tok.to_ascii_lowercase())
            .is_some()
    {
        PhraseToken::Word
    } else {
        PhraseToken::Other
    }
}

/// A run of [`PHRASE_WORDS`] or more BIP39 English words becomes one `[redacted]`. Words are
/// runs of ASCII letters and digits, so whatever sits between them (spaces, quotes, `=`,
/// `Some("`, a Debug-escaped `\n`) does not break a run, and neither do numbers (a numbered
/// list, `1. abandon 2. ability …`). Prose never has twelve in a row: the list has no "the",
/// "a", "to", "of" or "is".
fn redact_phrases(s: &str) -> String {
    // Each alphanumeric run as a byte span, and its kind.
    let mut tokens: Vec<(usize, usize, PhraseToken)> = Vec::new();
    let mut start = None;
    let mut chars = s.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        // `\n`, `\t`, `\r` as Debug output escapes them: a separator, like the whitespace.
        let escape = c == '\\' && matches!(chars.peek(), Some((_, 'n' | 't' | 'r')));
        if c.is_ascii_alphanumeric() {
            start.get_or_insert(i);
            continue;
        }
        if let Some(st) = start.take() {
            tokens.push((st, i, kind_of(&s[st..i])));
        }
        if escape {
            chars.next();
        }
    }
    if let Some(st) = start {
        tokens.push((st, s.len(), kind_of(&s[st..])));
    }
    let mut out = String::with_capacity(s.len());
    let mut copied = 0;
    let mut i = 0;
    while i < tokens.len() {
        if tokens[i].2 != PhraseToken::Word {
            i += 1;
            continue;
        }
        // Words and numbers from here; the span ends at the last word.
        let len = tokens[i..]
            .iter()
            .take_while(|t| t.2 != PhraseToken::Other)
            .count();
        let run = &tokens[i..i + len];
        let words = run.iter().filter(|t| t.2 == PhraseToken::Word).count();
        if words >= PHRASE_WORDS {
            let last = run
                .iter()
                .rev()
                .find(|t| t.2 == PhraseToken::Word)
                .map_or(0, |t| t.1);
            out.push_str(&s[copied..tokens[i].0]);
            out.push_str(REDACTED);
            copied = last;
        }
        i += len;
    }
    out.push_str(&s[copied..]);
    out
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

/// Whether `value` (followed by `next`) is a `<placeholder>` in a fix line: `<`, one or more
/// lowercase letters, `-` or `_`, then `>` or a space (`<file>`, `<identity file | …>`).
fn is_placeholder(value: &[char], next: Option<&char>) -> bool {
    matches!(value.split_first(), Some(('<', word)) if !word.is_empty()
        && word.iter().all(|c| c.is_ascii_lowercase() || matches!(c, '-' | '_')))
        && matches!(next, Some('>' | ' '))
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
            // `DASH_FORGE_KEY=<identity file>` in a fix line is a placeholder, not a value: `<`,
            // lowercase words only, then `>` or a space. A bracketed credential (`<cVt4…>`,
            // `<ghp_x1>`) has digits or capitals and is still redacted.
            let placeholder = is_placeholder(&chars[val_start..i], chars.get(i));
            if i > val_start && is_secret_key(&key) && !dfk1 && !placeholder {
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
            let body = &rest["dfk1:".len()..];
            let parts: Vec<&str> = body.splitn(4, ':').collect();
            // A fix line's template (`dfk1:…`, `dfk1:<network>:<identityId>:<keyId>:<wif>`)
            // is shown as written: only a WIF that is itself a placeholder is kept.
            let wif = parts.get(3).copied().unwrap_or(body);
            let template = wif.trim_end_matches('>') == "…"
                || (wif.starts_with('<')
                    && wif.ends_with('>')
                    && wif[1..wif.len() - 1]
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || matches!(c, '-' | '_')));
            if template {
                return t.to_string();
            }
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
    // A raw 32-byte private key in hex (optionally `0x`-prefixed).
    let hex = core.strip_prefix("0x").unwrap_or(core);
    if hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return format!("{REDACTED}{}", &t[core.len()..]);
    }
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
    fn a_phrased_core_error_keeps_the_context_around_it() {
        #[derive(Debug)]
        struct Ctx(String, CoreError);
        impl fmt::Display for Ctx {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
        impl StdError for Ctx {
            fn source(&self) -> Option<&(dyn StdError + 'static)> {
                Some(&self.1)
            }
        }
        let inner: CoreError =
            UserError::new(codes::NO_ENCRYPTION_KEY, "bob has no encryption key")
                .fix("dg auth keys add --encryption")
                .into();
        let outer = Ctx("the membership stands; re-run dg collab add".into(), inner);
        let chain: Vec<&(dyn StdError + 'static)> = vec![&outer, &outer.1];
        let u = classify(chain, &ErrorContext::default());
        assert_eq!(u.code, codes::NO_ENCRYPTION_KEY);
        assert_eq!(
            u.note.as_deref(),
            Some("the membership stands; re-run dg collab add")
        );
    }

    #[test]
    fn key_limit_rejections_have_their_own_codes() {
        let ctx = ErrorContext {
            goal: Some("push rejected"),
            ..ErrorContext::default()
        };
        for (text, code) in [
            (
                "Identity public key 7 has spent its whole budget and can no longer sign",
                codes::KEY_BUDGET_SPENT,
            ),
            (
                "Identity public key 7 expired at 1700000000000 ms and can no longer sign (block time 1800000000000 ms)",
                codes::KEY_EXPIRED,
            ),
            ("Identity key 7 is disabled", codes::KEY_EXPIRED),
            (
                "Identity 5Dtb public key 7 has 1000 credits of budget left, the state transition requires 5000",
                codes::KEY_BUDGET_SPENT,
            ),
            (
                "Identity public key 7 is disabled and can no longer sign",
                codes::KEY_EXPIRED,
            ),
        ] {
            let u = from_platform_text(text, &ctx).expect(text);
            assert_eq!(u.code, code, "{text}");
            assert!(u.fix.iter().any(|f| f.contains("dg auth login")), "{text}");
        }
    }

    #[test]
    fn a_bound_key_outside_its_bounds_is_e302_not_a_generic_rejection() {
        let ctx = ErrorContext::default();
        for text in [
            "Batch member is outside the contract bounds of key 6",
            "Contract-bound authentication key 6 cannot sign a non-batch transition",
        ] {
            let u = from_platform_text(text, &ctx).expect(text);
            assert_eq!(u.code, codes::KEY_CANNOT_SIGN, "{text}");
            assert!(
                u.note
                    .as_deref()
                    .is_some_and(|n| n.contains("dg ci runner new")),
                "{text}"
            );
        }
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
        // …and documents nothing that is not in the catalogue, except retired codes, whose
        // numbers stay reserved and must not come back.
        for line in docs.lines().filter(|l| l.starts_with("## E")) {
            let heading = line.trim_start_matches("## ").trim();
            match heading.strip_suffix(" (retired)") {
                Some(code) => assert!(!seen.contains(code), "retired {code} is in the catalogue"),
                None => assert!(
                    seen.contains(heading),
                    "docs/errors.md documents unknown {heading}"
                ),
            }
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
        via_git: false,
    };

    /// The SDK's text for a forge-v2 writer-gate refusal: `ReferencedEntityNotFoundError`'s
    /// Display (`referenced {entity_type} {entity_id} not found for path {path}`), with the
    /// `ownerRefersTo` gate reported on path `$ownerId`, inside the broadcast error.
    const V2_GATE_40120: &str = "state transition broadcast error: referenced deletable document (own contract, document type writer, found through unique index byRepoAndMember) 5DtbWjpyYyNtMd3FBwyXGr3NTZzGUBGHnPHM3gs6ndmQ not found for path $ownerId";

    #[test]
    fn a_typed_40120_on_a_maintainer_only_type_asks_for_maintainer() {
        // A writer pushing a protected ref: `protectedRefUpdate` is maintainer-only, so
        // "you are not a writer" would be false and `--role writer` would not help.
        let u = core_chain(
            CoreError::NotAMember {
                document_type: "protectedRefUpdate".into(),
                detail: "40120: …".into(),
            },
            &PUSH,
        );
        assert_eq!(u.code, "E601");
        assert_eq!(
            u.message,
            "push rejected: only maintainers of alice/project can change a protected ref"
        );
        assert!(u.fix[0].contains("--role maintainer"), "{u:?}");

        // Any other gated type: not a member at all.
        let u = core_chain(
            CoreError::NotAMember {
                document_type: "refUpdate".into(),
                detail: "40120: …".into(),
            },
            &PUSH,
        );
        assert_eq!(
            u.message,
            "push rejected: you are not a writer of alice/project"
        );
        assert!(u.fix[0].contains("--role writer"), "{u:?}");
    }

    #[test]
    fn a_client_side_refusal_is_e601_and_says_nothing_was_paid() {
        let ctx = ErrorContext {
            goal: Some("issue not closed"),
            repo: Some("alice/project"),
            ..ErrorContext::default()
        };
        let u = core_chain(
            CoreError::NotPermitted {
                action: "close issue #3".into(),
                reason: "you are neither a member of alice/project nor the issue's author".into(),
                needs: "writer".into(),
            },
            &ctx,
        );
        assert_eq!((u.code, u.exit_code()), ("E601", 6));
        assert_eq!(u.message, "issue not closed: you cannot close issue #3");
        assert!(u.fix[0].contains("dg collab add alice/project"), "{u:?}");
        assert!(u.note.as_deref().unwrap().contains("nothing was written"));
    }

    #[test]
    fn an_edit_by_a_non_author_does_not_suggest_membership() {
        let ctx = ErrorContext {
            goal: Some("issue not edited"),
            repo: Some("alice/project"),
            ..ErrorContext::default()
        };
        let u = core_chain(
            CoreError::NotPermitted {
                action: "edit issue #3".into(),
                reason: "you are not its author".into(),
                needs: "owner".into(),
            },
            &ctx,
        );
        assert_eq!(u.code, "E601");
        assert!(u.fix[0].contains("only the author can edit it"), "{u:?}");
        assert!(!u.fix[0].contains("collab add"), "{u:?}");
        // A comment delete (QW-016) says delete, not edit.
        let u = core_chain(
            CoreError::NotPermitted {
                action: "delete this comment".into(),
                reason: "you are not its author".into(),
                needs: "owner".into(),
            },
            &ctx,
        );
        assert!(u.fix[0].contains("only the author can delete it"), "{u:?}");
    }

    #[test]
    fn undeployed_v2_has_its_own_code() {
        let u = core_chain(
            CoreError::V2NotDeployed {
                network: "testnet".into(),
            },
            &PUSH,
        );
        assert_eq!(u.code, "E702");
        assert!(u.fix[0].contains("--devnet-name bonsia"), "{u:?}");
    }

    /// Moutai after its reset to beta.6 (2026-09-28): the build's forge contracts are gone.
    const RESET_DEVNET_CAUSE: &str = "contract 6DJ3px1ZDGpx9kvLEMDuLdLtHo4WYirWzyJ2GVWegGux: Dapi client error: transport error: grpc error: code: 'Client specified an invalid argument', message: \"contract not found error: contract not found when querying from value with contract info\"";

    #[test]
    fn forge_contracts_missing_is_e702_with_a_next_step_not_a_transport_error() {
        let missing = || CoreError::ContractsMissing {
            network: "devnet moutai".into(),
            detail: RESET_DEVNET_CAUSE.into(),
        };
        let u = core_chain(missing(), &PUSH);
        assert_eq!(u.code, "E702");
        assert_eq!(u.exit_code(), 7);
        assert_eq!(
            u.message,
            "push failed: forge contracts not found on devnet moutai"
        );
        assert_eq!(u.cause.as_deref(), Some(RESET_DEVNET_CAUSE));
        assert!(
            u.fix[0].starts_with("the network may have been reset: update dg"),
            "{u:?}"
        );
        assert!(u.fix.iter().any(|f| f.contains("dg doctor")), "{u:?}");
        assert!(
            u.note
                .as_deref()
                .unwrap_or("")
                .contains("retrying will not help"),
            "{u:?}"
        );
        // Under git, the network check names what the helper reads, never dg flags.
        let git = core_chain(
            missing(),
            &ErrorContext {
                via_git: true,
                ..PUSH
            },
        );
        assert_eq!(git.code, "E702");
        assert!(
            git.fix
                .iter()
                .any(|f| f.contains("git config --get dash.network")),
            "{git:?}"
        );
        assert!(!git.fix.iter().any(|f| f.contains("--network")), "{git:?}");
        // Mainnet: a misconfigured build, not a reset.
        let main = core_chain(
            CoreError::ContractsMissing {
                network: "mainnet".into(),
                detail: "contract X: Platform proved it absent".into(),
            },
            &ErrorContext::default(),
        );
        assert_eq!(main.message, "forge contracts not found on mainnet");
        assert!(!main.fix[0].contains("reset"), "{main:?}");
    }

    #[test]
    fn undeployed_v2_under_git_names_git_config_not_dg_flags() {
        // L-03: git takes no `--network`; the fix has to be something git's helper reads.
        let ctx = ErrorContext {
            via_git: true,
            ..PUSH
        };
        let u = core_chain(
            CoreError::V2NotDeployed {
                network: "testnet".into(),
            },
            &ctx,
        );
        assert_eq!(u.code, "E702");
        assert_eq!(
            u.fix[0],
            "use a network where it is: `git config --global dash.network devnet && git config --global dash.devnetName bonsia`, then run the git command again"
        );
        assert!(
            u.fix[1].contains("DASH_FORGE_DEVNET_NAME=bonsia git"),
            "{u:?}"
        );
        assert!(u.fix.iter().all(|f| !f.contains("--network ")), "{u:?}");
    }

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

    /// The RC1 contracts' document schemas, by type.
    fn rc1_schemas() -> Vec<(String, serde_json::Value)> {
        let root = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../forge-contracts/contracts"
        );
        ["forge-core", "forge-collab", "forge-community"]
            .iter()
            .flat_map(|name| {
                let text = std::fs::read_to_string(format!("{root}/{name}.json")).unwrap();
                let json: serde_json::Value = serde_json::from_str(&text).unwrap();
                json["documentSchemas"]
                    .as_object()
                    .unwrap()
                    .clone()
                    .into_iter()
            })
            .collect()
    }

    /// Every `propertyConstraints` rule of the RC1 contracts, on every type, has an explanation,
    /// and every explanation (by name, and by type and name) names a rule the contracts have.
    #[test]
    fn every_rc1_rule_has_an_explanation() {
        let mut names = std::collections::BTreeSet::new();
        let mut pairs = std::collections::BTreeSet::new();
        for (ty, schema) in rc1_schemas() {
            for rule in schema["propertyConstraints"]
                .as_object()
                .into_iter()
                .flat_map(serde_json::Map::keys)
            {
                assert!(
                    rule_explanation(&ty, rule).is_some(),
                    "{ty}: rule {rule} has no entry in RULE_EXPLANATIONS"
                );
                names.insert(rule.clone());
                pairs.insert((ty.clone(), rule.clone()));
            }
        }
        let listed: std::collections::BTreeSet<String> = RULE_EXPLANATIONS
            .iter()
            .map(|(r, _)| (*r).to_string())
            .collect();
        assert_eq!(
            listed.len(),
            RULE_EXPLANATIONS.len(),
            "a rule is listed twice"
        );
        assert_eq!(listed, names);
        for (ty, rule, _) in RULE_EXPLANATIONS_BY_TYPE {
            assert!(
                pairs.contains(&((*ty).to_string(), (*rule).to_string())),
                "{ty} has no rule {rule}"
            );
        }
    }

    #[test]
    fn an_explanation_follows_the_type_where_the_rule_differs() {
        let issue = rule_explanation("issue", "p_sealedIfPrivate").unwrap();
        let review = rule_explanation("review", "p_sealedIfPrivate").unwrap();
        assert!(
            issue.contains("sealed") && !issue.contains("review"),
            "{issue}"
        );
        assert!(review.contains("no plaintext body"), "{review}");
        assert!(!rule_explanation("comment", "i_provenance")
            .unwrap()
            .contains("upstreamNumber"));
        assert!(rule_explanation("issue", "i_provenance")
            .unwrap()
            .contains("upstreamNumber"));
    }

    /// MAINTAINER_ONLY is exactly the types whose `ownerRefersTo` admits a maintainer alone.
    #[test]
    fn maintainer_only_matches_the_rc1_gates() {
        let mut gated: Vec<String> = rc1_schemas()
            .into_iter()
            .filter(|(_, s)| s["ownerRefersTo"]["documentType"] == "maintainer")
            .map(|(ty, _)| ty)
            .collect();
        gated.sort_unstable();
        let mut listed: Vec<&str> = MAINTAINER_ONLY.to_vec();
        listed.sort_unstable();
        assert_eq!(gated, listed);
    }

    const ISSUE: ErrorContext<'static> = ErrorContext {
        goal: Some("issue not created"),
        rejected: None,
        repo: Some("alice/project"),
        retry_is_idempotent: false,
        via_git: false,
    };

    #[test]
    fn a_10422_names_the_rule_and_explains_it() {
        let detail = "A document of type \"issue\" breaks its propertyConstraints rule \"i_provenance\": it does not hold";
        let u = core_chain(
            CoreError::RuleRefused {
                document_type: "issue".into(),
                rule: "i_provenance".into(),
                detail: detail.into(),
            },
            &ISSUE,
        );
        assert_eq!(u.code, "E604");
        assert_eq!(
            u.message,
            "issue not created: consensus refused it by the rule \"i_provenance\""
        );
        let cause = u.cause.as_deref().unwrap();
        assert!(cause.starts_with("an imported item"), "{cause}");
        assert!(
            cause.ends_with("(10422: issue rule i_provenance)"),
            "{cause}"
        );
        assert!(u.note.as_deref().unwrap().contains(detail), "{u:?}");

        // The same refusal as text (a broadcast error printed with escaped quotes) reads alike.
        let text = format!(
            "state transition broadcast error: {}",
            detail.replace('"', "\\\"")
        );
        let t = core_chain(CoreError::Platform(text), &ISSUE);
        assert_eq!((t.code, &t.message), (u.code, &u.message));
        assert_eq!(t.cause, u.cause);

        // A rule this build does not know keeps the node's words.
        let u = core_chain(
            CoreError::RuleRefused {
                document_type: "issue".into(),
                rule: "newRule".into(),
                detail: "breaks newRule".into(),
            },
            &ISSUE,
        );
        assert_eq!(u.cause.as_deref(), Some("breaks newRule"));

        // A fault evaluating a known rule is not what the rule asks: the node's words stay.
        let fault = "A document of type \"issue\" breaks its propertyConstraints rule \"dense\": a value it reads or computes does not fit a 128-bit signed integer";
        let u = core_chain(
            CoreError::RuleRefused {
                document_type: "issue".into(),
                rule: "dense".into(),
                detail: fault.into(),
            },
            &ISSUE,
        );
        assert_eq!(u.cause.as_deref(), Some(fault));
    }

    /// A 40120 broadcast error as rs-dpp prints it: a document of `document_type` (a
    /// deletable one, as the membership documents are), or else an identity, missing for `path`.
    fn broadcast_40120(document_type: Option<&str>, path: &str) -> String {
        use dash_sdk::dpp::consensus::state::document::referenced_entity_not_found_error::ReferencedEntityNotFoundError;
        use dash_sdk::dpp::data_contract::document_type::DocumentPropertyReferenceTarget;
        let target = match document_type {
            Some(t) => DocumentPropertyReferenceTarget::DeletableDocument {
                contract_id: Some([5; 32].into()),
                document_type_name: t.into(),
                property_agreement: std::collections::BTreeMap::new(),
            },
            None => DocumentPropertyReferenceTarget::Identity,
        };
        let err = ReferencedEntityNotFoundError::new([9; 32].into(), target, path.into());
        format!("state transition broadcast error: {err}")
    }

    #[test]
    fn violated_rule_reads_the_type_and_rule() {
        assert_eq!(
            violated_rule("A document of type \"review\" breaks its propertyConstraints rule \"memberVerdict\": it does not hold"),
            Some(("review".into(), "memberVerdict".into()))
        );
        assert_eq!(
            violated_rule("referenced identity x not found for path y"),
            None
        );
    }

    #[test]
    fn a_40120_on_as_member_is_not_a_member() {
        let text = broadcast_40120(Some("writer"), "asMember");
        let u = core_chain(CoreError::Platform(text.clone()), &ISSUE);
        assert_eq!(u.code, "E601");
        assert!(u.fix[0].contains("revoked since: run it again"), "{u:?}");
        // Typed (platform classifies asMember as NotAMember), it reads the same.
        let bare = text.trim_start_matches("state transition broadcast error: ");
        let typed = core_chain(
            CoreError::NotAMember {
                document_type: "comment".into(),
                detail: format!("40120: {bare}"),
            },
            &ISSUE,
        );
        assert_eq!((typed.code, &typed.message), (u.code, &u.message));
        assert_eq!(typed.fix, u.fix);
        // The writer gate on `$ownerId` does not suggest it.
        let gate = broadcast_40120(Some("writer"), "$ownerId");
        let owner = core_chain(CoreError::Platform(gate), &ISSUE);
        assert!(!owner.fix[0].contains("revoked since"), "{owner:?}");
    }

    #[test]
    fn a_40120_on_a_repo_key_member_asks_to_replan_the_wrap() {
        let ctx = ErrorContext {
            goal: Some("member not added"),
            repo: Some("alice/project"),
            ..Default::default()
        };
        let typed = core_chain(
            CoreError::ReferenceNotFound {
                document_type: "repoKey".into(),
                path: "memberId".into(),
                detail: "40120: …".into(),
            },
            &ctx,
        );
        assert_eq!(typed.code, "E604");
        assert_eq!(
            typed.message,
            "member not added: a key wrap names someone who is not (or no longer) a member"
        );
        assert!(typed.fix[0].contains("plans the wraps afresh"), "{typed:?}");

        for member_type in ["maintainer", "writer"] {
            let u = core_chain(
                CoreError::Platform(broadcast_40120(Some(member_type), "memberId")),
                &ctx,
            );
            assert_eq!(u.message, typed.message);
        }

        // A runner's memberId refers to an identity: a missing identity, not a stale wrap.
        let u = core_chain(CoreError::Platform(broadcast_40120(None, "memberId")), &ctx);
        assert_eq!(
            u.message,
            "member not added: a document it refers to at memberId does not exist"
        );
    }

    #[test]
    fn a_40120_on_consent_by_says_the_member_has_not_accepted() {
        let u = core_chain(
            CoreError::ReferenceNotFound {
                document_type: "writer".into(),
                path: "consentBy".into(),
                detail: "40120: …".into(),
            },
            &ISSUE,
        );
        assert_eq!(u.code, "E604");
        assert!(u
            .message
            .ends_with("the member has not accepted the invitation yet"));
    }

    #[test]
    fn maintainer_only_rc1_types_ask_for_maintainer() {
        for (ty, what) in [("policy", "its merge policy"), ("webhook", "its webhooks")] {
            let u = core_chain(
                CoreError::NotAMember {
                    document_type: ty.into(),
                    detail: "40120: …".into(),
                },
                &PUSH,
            );
            assert_eq!(
                u.message,
                format!("push rejected: only maintainers of alice/project can change {what}")
            );
        }
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
            CoreError::V2NotDeployed {
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
            CoreError::Config("no HIGH or CRITICAL AUTHENTICATION key in identity file".into()),
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

    /// QW-034: a sealed key with no terminal says how to give the passphrase, not to sign in
    /// again (a new key registration) or to run a command that fails the same way.
    #[test]
    fn a_sealed_key_without_a_terminal_names_the_passphrase_ways() {
        let io = CoreError::Io(
            "/h/.config/dash-forge/identities/x.key needs a passphrase and there is no terminal to ask on (os error 6); set DASH_FORGE_PASSPHRASE".into(),
        );
        let outer = Ctx("loading identity from /h/x.key", Box::new(io));
        let u = classify(
            [&outer as &(dyn StdError + 'static), outer.source().unwrap()],
            &ErrorContext::default(),
        );
        assert_eq!(u.code, "E303");
        assert!(
            u.message.contains("sealed with a passphrase"),
            "{}",
            u.message
        );
        assert!(
            u.fix.iter().any(|f| f.contains("DASH_FORGE_PASSPHRASE")),
            "{:?}",
            u.fix
        );
        assert!(
            !u.fix.iter().any(|f| f.contains("dg auth login")),
            "{:?}",
            u.fix
        );
    }

    /// QW-032: E304 names the network searched, and the key's own network when it records
    /// another, in the form the failing tool takes.
    #[test]
    fn a_missing_identity_names_both_networks() {
        let err = CoreError::IdentityNotFound {
            identity_id: "4UF1".into(),
            network: "testnet".into(),
            key_network: Some("devnet-bonsia".into()),
        };
        let ctx = ErrorContext {
            goal: Some("check run not reported"),
            ..Default::default()
        };
        let u = classify([&err as &(dyn StdError + 'static)], &ctx);
        assert_eq!(u.code, "E304");
        assert_eq!(
            u.message,
            "check run not reported: your identity does not exist on testnet"
        );
        assert!(u
            .cause
            .as_deref()
            .unwrap()
            .contains("your key is for devnet-bonsia"));
        assert!(
            u.fix[0].contains("--network devnet --devnet-name bonsia"),
            "{:?}",
            u.fix
        );
        let git = ErrorContext {
            via_git: true,
            ..Default::default()
        };
        let u = classify([&err as &(dyn StdError + 'static)], &git);
        assert!(
            u.fix[0].contains("git config dash.network devnet"),
            "{:?}",
            u.fix
        );
        assert!(
            u.fix[1].contains("DASH_FORGE_NETWORK=devnet"),
            "{:?}",
            u.fix
        );
        // A key that records no network (or the same one): the generic network fix.
        let same = CoreError::IdentityNotFound {
            identity_id: "4UF1".into(),
            network: "devnet-bonsia".into(),
            key_network: Some("devnet-bonsia".into()),
        };
        let u = classify(
            [&same as &(dyn StdError + 'static)],
            &ErrorContext::default(),
        );
        assert!(u
            .cause
            .as_deref()
            .unwrap()
            .contains("Platform (devnet-bonsia) has no identity 4UF1"));
        assert!(u.fix[0].contains("--network"), "{:?}", u.fix);
    }

    /// QW-082: an alternative fix written "or …" renders under the `or:` label once, not
    /// "or: or …".
    #[test]
    fn an_or_fix_does_not_say_or_twice() {
        let out = UserError::new(codes::USAGE, "x")
            .fix("a")
            .fix("or pass --identity <file>")
            .render("", false);
        assert!(out.contains("  or:    pass --identity <file>"), "{out}");
        assert!(!out.contains("or: or"), "{out}");
    }

    /// QW-039 / QW-040: the E601 way in names the member's consent first, and a private
    /// repository's E301 points at a key source that can open it (not a limited key, which
    /// would be E306 next).
    #[test]
    fn e601_and_private_e301_name_the_step_that_works() {
        let ctx = ErrorContext {
            rejected: Some("push rejected"),
            repo: Some("alice/project"),
            ..Default::default()
        };
        let u = not_a_writer(&ctx, "40120");
        assert!(
            u.fix[0].starts_with("not a member yet? run `dg collab accept alice/project` first")
                && u.fix[0]
                    .contains("dg collab add alice/project <your identity id> --role writer"),
            "{:?}",
            u.fix
        );
        let u = private_needs_identity("alice/secret");
        assert!(u.fix[0].contains("--full-key"), "{:?}", u.fix);
        assert!(u.fix[0].contains("--mnemonic --full-key"), "{:?}", u.fix);
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
    fn redaction_scrubs_recovery_phrases() {
        let twelve =
            "abandon ability able about above absent absorb abstract absurd abuse access accident";
        assert_eq!(
            redact(&format!("at x7: \"{twelve}\": not found")),
            "at x7: \"[redacted]\": not found"
        );
        let upper = twelve.to_uppercase();
        assert_eq!(redact(&format!("x {upper}, y")), "x [redacted], y");
        assert_eq!(redact(&format!("{twelve} {twelve}\n")), "[redacted]\n");
        // Glued to what comes before it: `KEY=…`, a Debug `Some("…")`, a `--flag=…`.
        for glued in [
            format!("DASH_FORGE_KEY={twelve}"),
            format!("password={twelve}"),
            format!("mnemonic: Some(\"{twelve}\")"),
            format!("--mnemonic={twelve}"),
            format!("é{twelve}é"),
        ] {
            let out = redact(&glued);
            for w in ["ability", "absurd", "accident"] {
                assert!(!out.contains(w), "{glued} → {out}");
            }
        }
        assert_eq!(redact(&format!("é {twelve} é")), "é [redacted] é");
        // Debug-escaped separators, and a numbered list.
        let escaped = format!("{:?}", twelve.replace(' ', "\n"));
        assert_eq!(redact(&escaped), "\"[redacted]\"");
        let numbered: Vec<String> = twelve
            .split(' ')
            .enumerate()
            .map(|(i, w)| format!("{}. {w}", i + 1))
            .collect();
        assert_eq!(redact(&numbered.join(" ")), "1. [redacted]");
        assert_eq!(redact("a\\nb 12 cd"), "a\\nb 12 cd");
        // Eleven words, or twelve broken by a word off the list, are left alone.
        let eleven = twelve.rsplit_once(' ').unwrap().0;
        assert_eq!(redact(eleven), eleven);
        let broken = twelve.replace("absurd", "the");
        assert_eq!(redact(&broken), broken);
        let prose = "the pack upload to kubo failed after 3 tries; check the gateway and try again";
        assert_eq!(redact(prose), prose);
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
        // Identity/contract ids (43–44 chars) and 40-hex object ids are left alone; 64 hex
        // digits may be a raw private key, so they are not.
        let id = "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB";
        assert_eq!(redact(id), id);
        let sha1 = "9c4e".repeat(10);
        assert_eq!(redact(&sha1), sha1);
        let h = "9c4e".repeat(16);
        assert_eq!(redact(&format!("key {h}.")), "key [redacted].");
        assert_eq!(redact(&format!("key=0x{h}")), "key=[redacted]");
        assert_eq!(redact(&format!("({h})")), "([redacted])");
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
        // L-12: a `<placeholder>` in a fix line is shown as written, not as `[redacted]>`.
        for fix in [
            "or pass --identity <file>, or set DASH_FORGE_KEY=<file>",
            "export DASH_FORGE_KEY=<identity file | keychain:… | dfk1:…>",
            "set token=<your token>",
            "an inline dfk1:<network>:<identityId>:<keyId>:<wif> key",
        ] {
            assert_eq!(redact(fix), fix);
        }
        // …but a credential in brackets, or behind a placeholder field, is still scrubbed.
        let wif = "cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy";
        for leak in [
            format!("DASH_FORGE_KEY=<{wif}>"),
            "token=<ghp_abc123>".to_string(),
            "password=<hunter2".to_string(),
            format!("dfk1:<testnet>:8hJm:3:{wif}"),
            format!("dfk1:…:{wif}"),
        ] {
            let out = redact(&leak);
            assert!(
                !out.contains(wif) && !out.contains("abc123") && !out.contains("hunter2"),
                "{leak} → {out}"
            );
        }
        // Rendering applies it.
        let u = UserError::new(codes::UNEXPECTED, "x").cause("https://a:b@h/");
        assert!(!u.render("", false).contains("a:b"));
        assert!(!u.to_json().to_string().contains("a:b"));
    }
}
