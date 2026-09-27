//! The CLIs' stderr logging: `RUST_LOG` (default `warn`), minus the Platform SDK's reports
//! of failures that forge-core recovers from.
//!
//! The SDK logs a broadcast refused because another write by the same identity took its
//! nonce at ERROR (`rs_dapi_client`) and WARN (`dash_sdk`), and each transport retry at
//! WARN. forge-core then re-prepares the write, or finds it already landed, and the run
//! succeeds, but the user has read "ERROR … InvalidIdentityNonceError" and assumes it
//! failed. Those events are hidden unless `RUST_LOG` asks for debug output.
//!
//! Nothing that matters is lost. Every SDK error reaches forge-core as a `Result`: a write
//! it cannot recover fails with its own error, which the CLI prints. Any SDK event not
//! recognised here (a node that is down, a refused transition, an unknown error) is still
//! shown.

use tracing::field::{Field, Visit};
use tracing::{Event, Metadata};
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

/// Whether an event from `target` with `message` and `error` is the SDK reporting
/// something forge-core recovers from.
pub fn is_recovered_sdk_noise(target: &str, message: &str, error: &str) -> bool {
    let recovered = || RECOVERED.iter().any(|m| error.contains(m));
    if target.starts_with("rs_dapi_client") {
        // A retry the client makes itself; if they run out, the error reaches forge-core.
        return message.starts_with("retrying error")
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

/// Drops [`is_recovered_sdk_noise`] events unless `show` (debug logging was asked for).
struct QuietRecovered {
    show: bool,
}

impl<S> Filter<S> for QuietRecovered {
    fn enabled(&self, _meta: &Metadata<'_>, _cx: &Context<'_, S>) -> bool {
        true
    }

    fn event_enabled(&self, event: &Event<'_>, _cx: &Context<'_, S>) -> bool {
        if self.show {
            return true;
        }
        let target = event.metadata().target();
        if !(target.starts_with("rs_dapi_client") || target.starts_with("dash_sdk")) {
            return true;
        }
        let mut f = Fields::default();
        event.record(&mut f);
        !is_recovered_sdk_noise(target, &f.message, &f.error)
    }
}

/// The filter for `spec` (a `RUST_LOG` value, `None` for the default `warn`) and whether it
/// asks for debug output anywhere.
fn env_filter(spec: Option<&str>) -> (EnvFilter, bool) {
    let filter = spec
        .and_then(|s| EnvFilter::try_new(s).ok())
        .unwrap_or_else(|| EnvFilter::new("warn"));
    let debug = filter
        .max_level_hint()
        .is_some_and(|l| l >= tracing::level_filters::LevelFilter::DEBUG);
    (filter, debug)
}

/// A stderr-style fmt layer writing to `writer`, filtered by `spec` and [`QuietRecovered`].
fn layer<S, W>(spec: Option<&str>, writer: W) -> impl tracing_subscriber::Layer<S>
where
    S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>,
    W: for<'w> tracing_subscriber::fmt::MakeWriter<'w> + Send + Sync + 'static,
{
    let (filter, show) = env_filter(spec);
    tracing_subscriber::fmt::layer()
        .with_writer(writer)
        .with_filter(filter)
        .with_filter(QuietRecovered { show })
}

/// Install the CLI logger on stderr: `RUST_LOG`, default `warn`, recovered SDK noise
/// hidden below debug.
pub fn init_cli() {
    let spec = std::env::var("RUST_LOG").ok();
    tracing_subscriber::registry()
        .with(layer(spec.as_deref(), std::io::stderr))
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

    fn run(spec: Option<&str>) -> String {
        let buf = Buf::default();
        let sub = tracing_subscriber::registry().with(layer(spec, buf.clone()));
        tracing::subscriber::with_default(sub, || {
            tracing::error!(target: "rs_dapi_client::dapi_client", error = NONCE_DAPI, "request failed");
            tracing::warn!(target: "dash_sdk::platform::transition::broadcast", error = NONCE_SDK, "broadcast: request failed");
            tracing::warn!(target: "dash_sdk::platform::transition::broadcast", error = NONCE_SDK, "broadcast: failed after retries");
            tracing::warn!(target: "rs_dapi_client::dapi_client", error = UNAVAILABLE, "retrying error with sleeping 0.01 secs");
            tracing::error!(target: "rs_dapi_client::dapi_client", error = NOT_A_MEMBER, "request failed");
            tracing::error!(target: "rs_dapi_client::dapi_client", error = UNAVAILABLE, "request failed");
            tracing::warn!(target: "forge_import", "a warning of our own");
        });
        let out = buf.0.lock().unwrap().clone();
        String::from_utf8(out).unwrap()
    }

    /// F-12: a recovered nonce race and transport retries are not shown by default; real
    /// errors, and our own warnings, still are.
    #[test]
    fn recovered_sdk_noise_is_hidden_and_real_errors_are_kept() {
        let out = run(None);
        assert!(!out.contains("40204"), "{out}");
        assert!(!out.contains("InvalidIdentityNonceError"), "{out}");
        assert!(!out.contains("retrying error"), "{out}");
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
        assert_eq!(out.lines().count(), 7, "{out}");
        // A bad RUST_LOG falls back to warn, as before.
        assert_eq!(run(Some("=[")).lines().count(), 3);
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
