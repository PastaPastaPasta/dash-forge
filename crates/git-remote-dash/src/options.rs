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
    /// `git push -o <value>` values (`option push-option <value>`), in order.
    pub push_options: Vec<String>,
    /// `git push --force-with-lease` expectations (`option cas <ref>:<oid>`): each ref and
    /// the tip it must still have for the push to overwrite it; `""` (or a null oid) means the
    /// ref must not exist.
    pub leases: Vec<(String, String)>,
}

impl OptionState {
    /// The `--force-with-lease` expectation for `dst`, when one was given: the tip it must
    /// still have, or `""` when it must not exist (git sends a null oid or nothing for that).
    pub fn lease(&self, dst: &str) -> Option<&str> {
        self.leases
            .iter()
            .rev()
            .find(|(r, _)| r == dst)
            .map(|(_, oid)| {
                if oid.bytes().all(|b| b == b'0') {
                    ""
                } else {
                    oid.as_str()
                }
            })
    }

    /// Whether `git push -o <name>` was given.
    pub fn has_push_option(&self, name: &str) -> bool {
        self.push_options.iter().any(|o| o == name)
    }
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

/// `git push --atomic` cannot be honoured: Platform takes one write per state transition, so
/// each ref is its own write and some can land when another fails (git then reports each).
pub const ATOMIC_UNSUPPORTED: &str = "dash:// cannot push atomically: each branch and tag is a separate Platform write, so some can land while another fails. Push without --atomic: git reports each ref, and a failed one can be pushed again";

/// Undo git's C-style quoting of an option value (`quote_c_style`): only applied when the value
/// holds a character that needs it.
fn unquote(value: &str) -> String {
    let Some(inner) = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')) else {
        return value.to_string();
    };
    let bytes = inner.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'\\' || i + 1 >= bytes.len() {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        let octal = bytes
            .get(i + 1..i + 4)
            .filter(|d| d.iter().all(|b| (b'0'..=b'7').contains(b)));
        if let Some(d) = octal {
            out.push((d[0] - b'0') * 64 + (d[1] - b'0') * 8 + (d[2] - b'0'));
            i += 4;
            continue;
        }
        out.push(match bytes[i + 1] {
            b'n' => b'\n',
            b't' => b'\t',
            b'a' => 0x07,
            b'b' => 0x08,
            b'f' => 0x0c,
            b'r' => b'\r',
            b'v' => 0x0b,
            other => other,
        });
        i += 2;
    }
    String::from_utf8_lossy(&out).into_owned()
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
        "atomic" => {
            if truthy(value) {
                OptionReply::Error(ATOMIC_UNSUPPORTED.to_string())
            } else {
                OptionReply::Ok
            }
        }
        // `git push --force-with-lease`: `<ref>:<expected oid>` (empty: must not exist). The
        // push plan overwrites the ref only while it still points there (`plan_pushes`).
        "cas" => {
            let value = unquote(value);
            match value.split_once(':') {
                Some((r, oid))
                    if r.starts_with("refs/")
                        && (oid.is_empty()
                            || (matches!(oid.len(), 40 | 64)
                                && oid.bytes().all(|b| b.is_ascii_hexdigit()))) =>
                {
                    state.leases.push((r.to_string(), oid.to_ascii_lowercase()));
                    OptionReply::Ok
                }
                _ => OptionReply::Error(format!(
                    "--force-with-lease expects <ref>:<full commit id>, got {value:?}"
                )),
            }
        }
        "followtags"
        | "check-connectivity"
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
        // `git push -o <string>`: one line per option. git C-quotes the value
        // (`quote_c_style` in transport-helper.c `set_helper_option`) only when it holds a
        // character that needs it; the options this helper knows never do, so a quoted value
        // is kept as it came and simply matches nothing. Answering `ok` is required: git dies
        // with "helper … does not support 'push-option'" on anything else.
        "push-option" => {
            state.push_options.push(value.to_string());
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
    fn atomic_is_refused_with_a_reason() {
        let mut s = OptionState::default();
        match handle_option(&mut s, "atomic true") {
            OptionReply::Error(msg) => assert!(msg.contains("cannot push atomically")),
            other => panic!("expected error, got {other:?}"),
        }
        assert_eq!(handle_option(&mut s, "atomic false"), OptionReply::Ok);
        assert!(s.fatal.is_none(), "a refused --atomic stops only that push");
    }

    #[test]
    fn leases_are_recorded_quoted_or_not() {
        let mut s = OptionState::default();
        let oid = "a".repeat(40);
        assert_eq!(
            handle_option(&mut s, &format!("cas refs/heads/main:{oid}")),
            OptionReply::Ok
        );
        assert_eq!(
            handle_option(&mut s, "cas \"refs/heads/new:\""),
            OptionReply::Ok
        );
        assert_eq!(s.lease("refs/heads/main"), Some(oid.as_str()));
        assert_eq!(s.lease("refs/heads/new"), Some(""));
        assert_eq!(s.lease("refs/heads/other"), None);
        // git's C quoting writes non-ASCII bytes as octal escapes.
        assert_eq!(
            handle_option(&mut s, &format!("cas \"refs/heads/na\\303\\257ve:{oid}\"")),
            OptionReply::Ok
        );
        assert_eq!(s.lease("refs/heads/naïve"), Some(oid.as_str()));
        assert!(matches!(
            handle_option(&mut s, "cas refs/heads/main:abc"),
            OptionReply::Error(_)
        ));
    }

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
    fn push_options_are_accepted_and_recorded() {
        let mut s = OptionState::default();
        assert_eq!(
            handle_option(&mut s, "push-option allow-private-uri"),
            OptionReply::Ok
        );
        assert_eq!(
            handle_option(&mut s, "push-option ci.skip"),
            OptionReply::Ok
        );
        assert!(s.has_push_option("allow-private-uri"));
        assert!(!s.has_push_option("allow"));
        assert_eq!(s.push_options, ["allow-private-uri", "ci.skip"]);
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
