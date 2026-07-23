//! Remote-helper `option` handling — the pure, unit-testable core.
//!
//! git sends `option <name> <value>` lines and expects one of three replies: `ok`,
//! `unsupported`, or `error <message>` (per `gitremote-helpers(7)`). [`handle_option`]
//! folds the value into [`OptionState`] and returns the reply.
//!
//! ## Shallow is rejected loudly (S0.9)
//!
//! A fetch/push-capability helper has no channel to report shallow boundaries, so git
//! would *silently* produce a full clone for `--depth`. We refuse instead: a non-zero
//! `depth` (or any `deepen-*` bound) yields an `error` reply **and** latches
//! [`OptionState::fatal`], so even if git ignores the option error the next `fetch`/`list`
//! aborts the process with a clear message. `depth 0` / `deepen-relative` are the normal
//! non-shallow resets git always sends and are accepted.
//!
//! ## Partial clone is honored
//!
//! `option filter <spec>` + `option from-promisor 1` are accepted and recorded; the fetch
//! path builds a filtered pack and writes the `.promisor` marker (S0.9).

/// Accumulated protocol options for one helper session.
#[derive(Debug, Default, Clone)]
#[allow(clippy::struct_excessive_bools)] // these mirror independent git option flags
pub struct OptionState {
    /// Progress-reporting verbosity (`option verbosity <n>`).
    pub verbosity: i32,
    /// Whether git asked for progress output.
    pub progress: bool,
    /// Whether this invocation is a clone (`option cloning true`).
    pub cloning: bool,
    /// Whether this is a dry run (`option dry-run true`) — push computes but does not write.
    pub dry_run: bool,
    /// A partial-clone filter spec (`option filter blob:none`), if requested.
    pub filter: Option<String>,
    /// Whether git flagged this as a promisor fetch (`option from-promisor 1`).
    pub from_promisor: bool,
    /// A latched fatal condition (shallow requested) that must abort the next fetch/list.
    pub fatal: Option<String>,
}

/// The reply to emit for an `option` line.
#[derive(Debug, PartialEq, Eq)]
pub enum OptionReply {
    /// `ok` — option accepted.
    Ok,
    /// `unsupported` — git falls back / ignores.
    Unsupported,
    /// `error <message>` — the option value is refused.
    Error(String),
}

impl OptionReply {
    /// The exact wire line (without the trailing newline).
    pub fn wire(&self) -> String {
        match self {
            OptionReply::Ok => "ok".to_string(),
            OptionReply::Unsupported => "unsupported".to_string(),
            OptionReply::Error(msg) => format!("error {msg}"),
        }
    }
}

/// git sends option *values* as `1`/`0`/`true`/`false` — treat `1` and `true` as set.
fn truthy(value: &str) -> bool {
    matches!(value, "true" | "1")
}

const SHALLOW_UNSUPPORTED: &str =
    "shallow clone (--depth/--shallow-*) is not supported by dash://; use --filter=blob:none for a lightweight clone";

/// Fold one `option <name> <value>` line (the text after `option `) into `state`,
/// returning the reply git should receive.
pub fn handle_option(state: &mut OptionState, rest: &str) -> OptionReply {
    let mut it = rest.splitn(2, ' ');
    let name = it.next().unwrap_or_default();
    let value = it.next().unwrap_or_default();

    match name {
        "verbosity" => {
            state.verbosity = value.trim().parse().unwrap_or(state.verbosity);
            OptionReply::Ok
        }
        "progress" => {
            state.progress = truthy(value);
            OptionReply::Ok
        }
        "cloning" => {
            state.cloning = truthy(value);
            OptionReply::Ok
        }
        "dry-run" => {
            state.dry_run = truthy(value);
            OptionReply::Ok
        }
        // Harmless modifiers / capabilities git always probes. `deepen-relative` is only a
        // modifier for a real deepen; on its own it is inert.
        "followtags"
        | "check-connectivity"
        | "atomic"
        | "no-recurse-submodules"
        | "object-format"
        | "report-status"
        | "deepen-relative" => OptionReply::Ok,
        // Shallow: `depth 0` means "not shallow" (git sends it as a reset); any positive
        // depth is a real, unsupported shallow request → fail loudly.
        "depth" => {
            let depth: i64 = value.trim().parse().unwrap_or(0);
            if depth != 0 {
                state.fatal = Some(SHALLOW_UNSUPPORTED.to_string());
                OptionReply::Error(SHALLOW_UNSUPPORTED.to_string())
            } else {
                OptionReply::Ok
            }
        }
        "deepen-since" | "deepen-not" => {
            // Only sent for --shallow-since / --shallow-exclude, i.e. a real shallow bound.
            if value.trim().is_empty() {
                OptionReply::Ok
            } else {
                state.fatal = Some(SHALLOW_UNSUPPORTED.to_string());
                OptionReply::Error(SHALLOW_UNSUPPORTED.to_string())
            }
        }
        // Partial clone — honored (S0.9). Record and confirm.
        "filter" => {
            let spec = value.trim();
            state.filter = if spec.is_empty() {
                None
            } else {
                Some(spec.to_string())
            };
            OptionReply::Ok
        }
        "from-promisor" => {
            state.from_promisor = truthy(value);
            OptionReply::Ok
        }
        // Everything else: let git fall back.
        _ => OptionReply::Unsupported,
    }
}

#[cfg(test)]
mod tests {
    use super::{handle_option, OptionReply, OptionState};

    #[test]
    fn verbosity_and_flags_are_recorded() {
        let mut s = OptionState::default();
        assert_eq!(handle_option(&mut s, "verbosity 2"), OptionReply::Ok);
        assert_eq!(s.verbosity, 2);
        assert_eq!(handle_option(&mut s, "cloning true"), OptionReply::Ok);
        assert!(s.cloning);
        assert_eq!(handle_option(&mut s, "dry-run 1"), OptionReply::Ok);
        assert!(s.dry_run);
    }

    #[test]
    fn depth_zero_is_ok_but_positive_depth_fails_loudly() {
        let mut s = OptionState::default();
        assert_eq!(handle_option(&mut s, "depth 0"), OptionReply::Ok);
        assert!(s.fatal.is_none());

        let mut s = OptionState::default();
        match handle_option(&mut s, "depth 1") {
            OptionReply::Error(msg) => assert!(msg.contains("shallow")),
            other => panic!("expected error, got {other:?}"),
        }
        assert!(s.fatal.is_some(), "depth must latch a fatal condition");
    }

    #[test]
    fn deepen_bounds_fail_only_with_a_value() {
        let mut s = OptionState::default();
        assert_eq!(
            handle_option(&mut s, "deepen-relative false"),
            OptionReply::Ok
        );
        assert!(s.fatal.is_none());

        let mut s = OptionState::default();
        assert!(matches!(
            handle_option(&mut s, "deepen-since 1234567890"),
            OptionReply::Error(_)
        ));
        assert!(s.fatal.is_some());
    }

    #[test]
    fn filter_and_from_promisor_are_honored() {
        let mut s = OptionState::default();
        assert_eq!(handle_option(&mut s, "filter blob:none"), OptionReply::Ok);
        assert_eq!(s.filter.as_deref(), Some("blob:none"));
        assert_eq!(handle_option(&mut s, "from-promisor 1"), OptionReply::Ok);
        assert!(s.from_promisor);
    }

    #[test]
    fn unknown_option_is_unsupported() {
        let mut s = OptionState::default();
        assert_eq!(
            handle_option(&mut s, "totally-made-up 1"),
            OptionReply::Unsupported
        );
    }

    #[test]
    fn wire_format_is_exact() {
        assert_eq!(OptionReply::Ok.wire(), "ok");
        assert_eq!(OptionReply::Unsupported.wire(), "unsupported");
        assert_eq!(OptionReply::Error("nope".into()).wire(), "error nope");
    }
}
