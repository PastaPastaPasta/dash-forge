//! `forge_core::logging::init_cli` in a process of its own: the global max level it leaves
//! must be `RUST_LOG`'s (default warn), not TRACE, or every trace site of the Platform SDK,
//! tonic and h2 is evaluated in every CLI.

use tracing::level_filters::LevelFilter;

#[test]
fn init_cli_keeps_the_global_max_level_at_rust_log() {
    // This binary has one test, so nothing else touches RUST_LOG or the global dispatcher.
    std::env::remove_var("RUST_LOG");
    forge_core::logging::init_cli();
    assert_eq!(LevelFilter::current(), LevelFilter::WARN);
    assert!(!tracing::enabled!(target: "h2::codec", tracing::Level::TRACE));
    assert!(!tracing::enabled!(target: "dash_sdk", tracing::Level::DEBUG));
    assert!(tracing::enabled!(target: "dash_sdk", tracing::Level::WARN));
}
