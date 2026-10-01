//! The CLIs' stderr logging: `RUST_LOG` (default `warn`), minus the Platform SDK's reports
//! of failures that forge-core recovers from.
//!
//! The SDK logs a broadcast refused because another write by the same identity took its
//! nonce at ERROR (`rs_dapi_client`) and WARN (`dash_sdk`), and each transport retry at
//! WARN. forge-core then re-prepares the write, or finds it already landed, and the run
//! succeeds, but the user has read "ERROR … InvalidIdentityNonceError" and assumes it
//! failed. The same goes for a write a node one block behind refused by a rule that reads
//! a total (a manifest's `platformChunks`): forge-core sends the same bytes again once the node
//! has caught up. Those events are hidden unless `RUST_LOG` asks for debug output.
//!
//! Nothing that matters is lost. Every SDK error reaches forge-core as a `Result`: a write
//! it cannot recover fails with its own error, which the CLI prints. Any SDK event not
//! recognised here (a node that is down, a refused transition, an unknown error) is still
//! shown when `RUST_LOG` is set.
//!
//! Without `RUST_LOG` (QW3-064), the SDK's own events (`dash_sdk`, `rs_dapi_client`, the
//! trusted context provider's "quorum refetch failed", any other dependency) are not shown at
//! all: they are Rust `Debug` dumps of errors that reach forge-core anyway, and a slow node,
//! a stale one or a quorum rotation printed a dozen of them around a command that then
//! succeeded. Dash Forge's own warnings are printed as one plain line each
//! (`dash: warning: …`), with no timestamp, and colour only on a terminal.

use std::io::IsTerminal as _;

use base64::Engine as _;
use tracing::field::{Field, Visit};
use tracing::{Event, Metadata};
use tracing_subscriber::fmt::format::Writer;
use tracing_subscriber::fmt::{FmtContext, FormatEvent, FormatFields};
use tracing_subscriber::layer::{Context, Filter, SubscriberExt as _};
use tracing_subscriber::util::SubscriberInitExt as _;
use tracing_subscriber::{EnvFilter, Layer as _};

/// Consensus outcomes forge-core's write path treats as expected (it re-prepares the
/// write, or counts it as landed, or allocates another number): identity nonce already
/// used (40204), document already present (40100), duplicate unique index (40105), and
/// the node already holding these exact bytes (gRPC `AlreadyExists`).
const RECOVERED: [&str; 7] = [
    "InvalidIdentityNonceError",
    "\"code\": \"40204\"",
    "DocumentAlreadyPresentError",
    "\"code\": \"40100\"",
    "DuplicateUniqueIndexError",
    "\"code\": \"40105\"",
    "code: AlreadyExists",
];

/// Whether `error` is a refusal by a `propertyConstraints` rule that reads a total
/// (`crate::platform::TOTAL_READING_RULES`): a node a block behind the writer's own writes
/// refuses a correct write, and forge-core sends the same bytes again once it has caught up
/// (D-5: a retried push printed the SDK's raw ERROR and WARN lines, base64 and all). A
/// refusal that outlasts the retries reaches forge-core as its own error. The SDK names the
/// rule in text (`dash_sdk`) or only in the serialized consensus error header
/// (`rs_dapi_client`).
fn is_lagging_total_refusal(error: &str) -> bool {
    let quoted_after = |key: &str| {
        let rest = &error[error.find(key)? + key.len()..];
        rest.find('"').map(|end| rest[..end].to_string())
    };
    if let (Some(doc), Some(rule)) = (
        quoted_after("document_type_name: \""),
        quoted_after("constraint: \""),
    ) {
        return crate::platform::reads_a_total(&doc, &rule);
    }
    let Some(serialized) = quoted_after("\"dash-serialized-consensus-error-bin\": \"") else {
        return false;
    };
    let engines = [
        base64::engine::general_purpose::STANDARD_NO_PAD,
        base64::engine::general_purpose::STANDARD,
    ];
    let Some(bytes) = engines.iter().find_map(|e| e.decode(&serialized).ok()) else {
        return false;
    };
    // The serialized error holds the type and the rule as length-prefixed strings.
    crate::platform::TOTAL_READING_RULES
        .iter()
        .any(|(doc, rule)| {
            let mut want = Vec::new();
            for s in [doc, rule] {
                want.push(u8::try_from(s.len()).unwrap_or(u8::MAX));
                want.extend_from_slice(s.as_bytes());
            }
            bytes.windows(want.len()).any(|w| w == want.as_slice())
        })
}

/// Whether an event from `target` with `message` and `error` is the SDK reporting
/// something forge-core recovers from.
pub fn is_recovered_sdk_noise(target: &str, message: &str, error: &str) -> bool {
    let recovered =
        || RECOVERED.iter().any(|m| error.contains(m)) || is_lagging_total_refusal(error);
    if target.starts_with("rs_dapi_client") {
        // A retry the client makes itself, and the node it failed on set aside for a while
        // ("ban address …": a rate limit, ResourceExhausted, or a transport error): the
        // request moves to another node, and if every node fails the error reaches
        // forge-core (L-32).
        return message.starts_with("retrying error")
            || message.starts_with("ban address ")
            || (message == "request failed" && recovered());
    }
    if target.starts_with("dash_sdk::platform::transition::broadcast") {
        return message.starts_with("broadcast: ") && recovered();
    }
    false
}

/// Collects an event's `message` and `error` fields as text.
#[derive(Default)]
struct Fields {
    message: String,
    error: String,
}

impl Visit for Fields {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        match field.name() {
            "message" => self.message = format!("{value:?}"),
            "error" => self.error = format!("{value:?}"),
            _ => {}
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        match field.name() {
            "message" => self.message = value.to_string(),
            "error" => self.error = value.to_string(),
            _ => {}
        }
    }
}

/// The crates whose events are Dash Forge's own: shown without `RUST_LOG`.
const OWN_TARGETS: [&str; 6] = [
    "forge_core",
    "dg",
    "git_remote_dash",
    "forge_runner",
    "forge_import",
    "forge_relay",
];

/// Whether an event from `target` is Dash Forge's own, not a dependency's.
fn is_own_target(target: &str) -> bool {
    OWN_TARGETS.iter().any(|own| {
        target
            .strip_prefix(own)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with("::"))
    })
}

/// Drops [`is_recovered_sdk_noise`] events unless `show` (debug logging was asked for), and
/// every dependency's event when `own_only` (no `RUST_LOG`).
struct QuietRecovered {
    show: bool,
    own_only: bool,
    /// The inner env filter's most verbose level, reported as this filter's own. Without
    /// it the outermost filter hints "anything" and the global max level becomes TRACE, so
    /// every SDK, tonic and h2 trace site is evaluated (and its spans built) for nothing.
    max_level: Option<tracing::level_filters::LevelFilter>,
}

impl<S> Filter<S> for QuietRecovered {
    fn enabled(&self, meta: &Metadata<'_>, _cx: &Context<'_, S>) -> bool {
        !self.own_only || is_own_target(meta.target())
    }

    fn max_level_hint(&self) -> Option<tracing::level_filters::LevelFilter> {
        self.max_level
    }

    fn event_enabled(&self, event: &Event<'_>, _cx: &Context<'_, S>) -> bool {
        let target = event.metadata().target();
        if self.own_only {
            return is_own_target(target);
        }
        if self.show {
            return true;
        }
        if !(target.starts_with("rs_dapi_client") || target.starts_with("dash_sdk")) {
            return true;
        }
        let mut f = Fields::default();
        event.record(&mut f);
        !is_recovered_sdk_noise(target, &f.message, &f.error)
    }
}

/// The filter for `spec` (a `RUST_LOG` value, `None` for the default `warn`), whether it
/// asks for debug output anywhere, and whether it was given (an empty value, or one that does
/// not parse, counts as not given).
fn env_filter(spec: Option<&str>) -> (EnvFilter, bool, bool) {
    let parsed = spec
        .filter(|s| !s.trim().is_empty())
        .and_then(|s| EnvFilter::try_new(s).ok());
    let given = parsed.is_some();
    let filter = parsed.unwrap_or_else(|| EnvFilter::new("warn"));
    let debug = filter
        .max_level_hint()
        .is_some_and(|l| l >= tracing::level_filters::LevelFilter::DEBUG);
    (filter, debug, given)
}

/// The fields of one event as a user reads them: the message, then the others as
/// `name=value` (strings unquoted).
#[derive(Default)]
struct PlainFields {
    message: String,
    rest: Vec<String>,
}

impl Visit for PlainFields {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.message = format!("{value:?}");
        } else {
            self.rest.push(format!("{}={value:?}", field.name()));
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_string();
        } else {
            self.rest.push(format!("{}={value}", field.name()));
        }
    }
}

/// One line per event, `<prefix>warning: <message> (<fields>)`: what the CLIs print without
/// `RUST_LOG`, in the shape of their own lines (`dash: ` for git-remote-dash, whose lines git
/// shows among its own; none for dg, which prints `warning: …`; `forge-import: ` and so on
/// for the others).
struct PlainFormat {
    prefix: String,
}

/// The prefix of [`PlainFormat`] lines for the binary named `argv0`.
fn plain_prefix(argv0: Option<&str>) -> String {
    let name = argv0
        .map(std::path::Path::new)
        .and_then(std::path::Path::file_stem)
        .and_then(std::ffi::OsStr::to_str)
        .unwrap_or("dash");
    match name {
        "dg" => String::new(),
        "git-remote-dash" => "dash: ".into(),
        other => format!("{other}: "),
    }
}

impl<S, N> FormatEvent<S, N> for PlainFormat
where
    S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>,
    N: for<'a> FormatFields<'a> + 'static,
{
    fn format_event(
        &self,
        _ctx: &FmtContext<'_, S, N>,
        mut writer: Writer<'_>,
        event: &Event<'_>,
    ) -> std::fmt::Result {
        let level = match *event.metadata().level() {
            tracing::Level::ERROR => "error",
            tracing::Level::WARN => "warning",
            tracing::Level::INFO => "note",
            _ => "debug",
        };
        let mut f = PlainFields::default();
        event.record(&mut f);
        write!(writer, "{}{level}: {}", self.prefix, f.message)?;
        if !f.rest.is_empty() {
            write!(writer, " ({})", f.rest.join(", "))?;
        }
        writeln!(writer)
    }
}

/// A stderr-style fmt layer writing to `writer`, filtered by `spec` and [`QuietRecovered`]:
/// the full tracing format (ANSI colour when `ansi`) when `RUST_LOG` was given, else
/// [`PlainFormat`] for Dash Forge's own events only.
fn layer<S, W>(
    spec: Option<&str>,
    writer: W,
    ansi: bool,
    prefix: &str,
) -> Box<dyn tracing_subscriber::Layer<S> + Send + Sync>
where
    S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>,
    W: for<'w> tracing_subscriber::fmt::MakeWriter<'w> + Send + Sync + 'static,
{
    let (filter, show, given) = env_filter(spec);
    let max_level = filter.max_level_hint();
    let quiet = QuietRecovered {
        show,
        own_only: !given,
        max_level,
    };
    let fmt = tracing_subscriber::fmt::layer()
        .with_writer(writer)
        .with_ansi(ansi);
    if given {
        Box::new(fmt.with_filter(filter).with_filter(quiet))
    } else {
        Box::new(
            fmt.event_format(PlainFormat {
                prefix: prefix.to_string(),
            })
            .with_filter(filter)
            .with_filter(quiet),
        )
    }
}

/// Whether stderr may carry ANSI colour: a terminal, and `NO_COLOR` unset.
fn stderr_ansi() -> bool {
    std::io::stderr().is_terminal() && std::env::var_os("NO_COLOR").is_none_or(|v| v.is_empty())
}

/// Install the CLI logger on stderr: `RUST_LOG` (default `warn`, Dash Forge's own events
/// only, one plain line each), recovered SDK noise hidden below debug, colour only on a
/// terminal.
pub fn init_cli() {
    let spec = std::env::var("RUST_LOG").ok();
    tracing_subscriber::registry()
        .with(layer(
            spec.as_deref(),
            std::io::stderr,
            stderr_ansi(),
            &plain_prefix(std::env::args().next().as_deref()),
        ))
        .init();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// Captures what the logger writes.
    #[derive(Clone, Default)]
    struct Buf(Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for Buf {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'w> tracing_subscriber::fmt::MakeWriter<'w> for Buf {
        type Writer = Buf;
        fn make_writer(&'w self) -> Buf {
            self.clone()
        }
    }

    /// The SDK's lines from a successful import (storage-migration-facts F-12), shortened.
    const NONCE_DAPI: &str = r#"ExecutionError { inner: Transport(Grpc(Status { code: InvalidArgument, message: "oWRkYXRh", metadata: MetadataMap { headers: {"code": "40204", "server": "envoy"} }, source: None })), retries: 0 }"#;
    const NONCE_SDK: &str = "ExecutionError { inner: Protocol(ConsensusError(StateError(InvalidIdentityNonceError(InvalidIdentityNonceError { current_identity_nonce: Some(48), setting_identity_nonce: 45, error: NonceAlreadyPresentInPast(3) })))), retries: 0 }";
    const NOT_A_MEMBER: &str = r#"ExecutionError { inner: Transport(Grpc(Status { code: InvalidArgument, metadata: MetadataMap { headers: {"code": "40120"} } })) }"#;
    const UNAVAILABLE: &str =
        "ExecutionError { inner: Transport(Grpc(Status { code: Unavailable, message: \"no healthy upstream\" })) }";
    /// L-32: the line `git push` and `dg pr merge` showed when a node rate-limited them.
    const RATE_LIMITED: &str = "status: ResourceExhausted, message: \"429\"";

    fn run(spec: Option<&str>) -> String {
        let buf = Buf::default();
        let sub = tracing_subscriber::registry().with(layer(spec, buf.clone(), false, "dash: "));
        tracing::subscriber::with_default(sub, || {
            tracing::error!(target: "rs_dapi_client::dapi_client", error = NONCE_DAPI, "request failed");
            tracing::warn!(target: "dash_sdk::platform::transition::broadcast", error = NONCE_SDK, "broadcast: request failed");
            tracing::warn!(target: "dash_sdk::platform::transition::broadcast", error = NONCE_SDK, "broadcast: failed after retries");
            tracing::warn!(target: "rs_dapi_client::dapi_client", error = UNAVAILABLE, "retrying error with sleeping 0.01 secs");
            tracing::warn!(target: "rs_dapi_client::dapi_client", address = "https://68.67.122.3:443", error = RATE_LIMITED, "ban address https://68.67.122.3:443 due to error: {RATE_LIMITED}");
            tracing::error!(target: "rs_dapi_client::dapi_client", error = NOT_A_MEMBER, "request failed");
            tracing::error!(target: "rs_dapi_client::dapi_client", error = UNAVAILABLE, "request failed");
            tracing::warn!(target: "forge_import", "a warning of our own");
        });
        let out = buf.0.lock().unwrap().clone();
        String::from_utf8(out).unwrap()
    }

    /// QW3-064: without `RUST_LOG` no dependency event is shown (the SDK's errors reach
    /// forge-core as results, which the CLI reports); ours are one plain line each, with no
    /// timestamp, target or ANSI escape.
    #[test]
    fn without_rust_log_only_our_own_events_show_as_plain_lines() {
        let out = run(None);
        assert_eq!(out, "dash: warning: a warning of our own\n");
        let buf = Buf::default();
        let sub = tracing_subscriber::registry().with(layer(None, buf.clone(), false, "dash: "));
        tracing::subscriber::with_default(sub, || {
            tracing::warn!(target: "rs_sdk_trusted_context_provider::provider", "quorum refetch failed: Quorum not found for type 107");
            tracing::warn!(target: "dash_sdk::sync", "retrying request");
            tracing::warn!(target: "forge_core::repo", pack = "ab12", error = %"bad bytes", "no readable copy; skipping");
            tracing::error!(target: "git_remote_dash::helper", "an error of ours");
            tracing::warn!(target: "dgx", "a lookalike crate is not ours");
        });
        let out = String::from_utf8(buf.0.lock().unwrap().clone()).unwrap();
        assert_eq!(
            out,
            "dash: warning: no readable copy; skipping (pack=ab12, error=bad bytes)\n\
             dash: error: an error of ours\n"
        );
        // A bad or empty RUST_LOG counts as none.
        assert_eq!(run(Some("=[")), "dash: warning: a warning of our own\n");
        assert_eq!(run(Some("")), "dash: warning: a warning of our own\n");
    }

    #[test]
    fn each_binary_prefixes_its_lines_as_its_own_output_does() {
        assert_eq!(
            plain_prefix(Some("/usr/local/bin/git-remote-dash")),
            "dash: "
        );
        assert_eq!(plain_prefix(Some("dg")), "");
        assert_eq!(plain_prefix(Some("/x/forge-import")), "forge-import: ");
        assert_eq!(plain_prefix(None), "dash: ");
    }

    /// With `RUST_LOG` set, the full format is kept, and colour follows `ansi`.
    #[test]
    fn rust_log_keeps_the_full_format_and_colour_only_when_asked() {
        let emit = |ansi: bool| {
            let buf = Buf::default();
            let sub = tracing_subscriber::registry().with(layer(
                Some("warn"),
                buf.clone(),
                ansi,
                "dash: ",
            ));
            tracing::subscriber::with_default(sub, || {
                tracing::warn!(target: "forge_core::platform", "a warning of our own");
            });
            let out = buf.0.lock().unwrap().clone();
            String::from_utf8(out).unwrap()
        };
        let plain = emit(false);
        assert!(
            plain.contains("WARN") && plain.contains("forge_core::platform"),
            "{plain}"
        );
        assert!(!plain.contains('\x1b'), "{plain}");
        assert!(emit(true).contains('\x1b'));
    }

    /// F-12: a recovered nonce race and transport retries are not shown under `RUST_LOG=warn`;
    /// real errors, and our own warnings, still are.
    #[test]
    fn recovered_sdk_noise_is_hidden_and_real_errors_are_kept() {
        let out = run(Some("warn"));
        assert!(!out.contains("40204"), "{out}");
        assert!(!out.contains("InvalidIdentityNonceError"), "{out}");
        assert!(!out.contains("retrying error"), "{out}");
        assert!(!out.contains("ban address"), "L-32: {out}");
        assert!(out.contains("40120"), "a real refusal must stay: {out}");
        assert!(
            out.contains("no healthy upstream"),
            "a dead node must stay: {out}"
        );
        assert!(out.contains("a warning of our own"), "{out}");
        assert_eq!(out.lines().count(), 3, "{out}");
    }

    #[test]
    fn debug_logging_shows_everything() {
        let out = run(Some("debug"));
        assert!(
            out.contains("InvalidIdentityNonceError") && out.contains("40204"),
            "{out}"
        );
        assert!(out.contains("ban address"), "{out}");
        assert_eq!(out.lines().count(), 8, "{out}");
    }

    /// The logger must not raise the max level past what `RUST_LOG` asks for: an outermost
    /// filter without a hint made it TRACE, so every trace site of the SDK, tonic and h2 was
    /// evaluated in every CLI. (`LevelFilter::current()` after [`init_cli`] is checked in
    /// tests/logging_init.rs, its own process: it is global, and other tests here set
    /// debug subscribers.)
    #[test]
    fn the_max_level_is_the_env_filters() {
        use tracing::level_filters::LevelFilter;
        use tracing::Subscriber as _;
        for (spec, want) in [
            (None, LevelFilter::WARN),
            (Some("info"), LevelFilter::INFO),
            (Some("warn,forge_import::cost=debug"), LevelFilter::DEBUG),
        ] {
            let sub =
                tracing_subscriber::registry().with(layer(spec, Buf::default(), false, "dash: "));
            assert_eq!(sub.max_level_hint(), Some(want), "{spec:?}");
        }
    }

    /// A debug event of our own (the forge-core nonce re-prepare, now at debug) shows only
    /// when `RUST_LOG` asks for debug.
    #[test]
    fn debug_events_show_only_under_debug() {
        let emit = |spec: Option<&str>| {
            let buf = Buf::default();
            let sub =
                tracing_subscriber::registry().with(layer(spec, buf.clone(), false, "dash: "));
            tracing::subscriber::with_default(sub, || {
                tracing::debug!(target: "forge_core::platform", "another write took the nonce");
            });
            let out = buf.0.lock().unwrap().clone();
            String::from_utf8(out).unwrap()
        };
        assert!(emit(None).is_empty());
        assert!(emit(Some("info")).is_empty());
        assert!(emit(Some("debug")).contains("another write took the nonce"));
        assert!(emit(Some("warn,forge_core=debug")).contains("another write took the nonce"));
    }

    /// D-5 (QW-082): a push whose manifest a lagging node refused by `platformChunks` printed
    /// the SDK's raw ERROR (the rule only in a base64 header) and WARN lines, although
    /// forge-core sends it again and it lands. A refusal by a rule that reads no total stays.
    #[test]
    fn a_lagging_total_refusal_is_recovered_noise() {
        // Captured on bonsia (collab/push-collab-feature.log), trimmed.
        let dapi = r#"ExecutionError { inner: Transport(Grpc(Status { code: InvalidArgument, message: "oWRk", metadata: MetadataMap { headers: {"content-type": "application/grpc", "code": "10422", "dash-serialized-consensus-error-bin": "AcYMcGFja01hbmlmZXN0DnBsYXRmb3JtQ2h1bmtzAA", "server": "envoy"} }, source: None })), retries: 0 }"#;
        let sdk = r#"ExecutionError { inner: Protocol(ConsensusError(BasicError(DocumentPropertyConstraintViolatedError(DocumentPropertyConstraintViolatedError { document_type_name: "packManifest", constraint: "platformChunks", violation: NotMet })))), retries: 0 }"#;
        assert!(is_recovered_sdk_noise(
            "rs_dapi_client::dapi_client",
            "request failed",
            dapi
        ));
        assert!(is_recovered_sdk_noise(
            "dash_sdk::platform::transition::broadcast",
            "broadcast: request failed",
            sdk
        ));
        let other = sdk.replace("platformChunks", "maxOneOpen");
        assert!(!is_recovered_sdk_noise(
            "dash_sdk::platform::transition::broadcast",
            "broadcast: request failed",
            &other
        ));
        let other_dapi = dapi.replace("AcYMcGFja01hbmlmZXN0DnBsYXRmb3JtQ2h1bmtzAA", "AAAA");
        assert!(!is_recovered_sdk_noise(
            "rs_dapi_client::dapi_client",
            "request failed",
            &other_dapi
        ));
    }

    #[test]
    fn only_the_sdk_targets_are_matched() {
        assert!(is_recovered_sdk_noise(
            "rs_dapi_client::dapi_client",
            "request failed",
            NONCE_DAPI
        ));
        assert!(!is_recovered_sdk_noise(
            "forge_import",
            "request failed",
            NONCE_DAPI
        ));
        assert!(!is_recovered_sdk_noise(
            "dash_sdk::platform::transition::broadcast",
            "broadcast: request failed",
            UNAVAILABLE
        ));
    }
}
