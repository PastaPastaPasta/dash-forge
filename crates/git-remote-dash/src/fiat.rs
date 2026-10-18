//! Pushes only read rates already available; the startup refresh is detached.

use std::sync::atomic::{AtomicBool, Ordering};

static MAINNET: AtomicBool = AtomicBool::new(false);

pub fn start(network: &forge_core::network::Network) {
    MAINNET.store(
        matches!(network, forge_core::network::Network::Mainnet),
        Ordering::Relaxed,
    );
    if !cfg!(test) {
        forge_core::fiat::start_background();
    }
}

pub fn note(credits: u64) -> String {
    dash_note(forge_core::repo::credits_to_dash(credits), false)
}

pub fn balance_note(credits: u64) -> String {
    dash_note(forge_core::repo::credits_to_dash(credits), true)
}

pub fn dash_note(dash: f64, balance: bool) -> String {
    if cfg!(test) || matches!(std::env::var("GIT_DASH_JSON").as_deref(), Ok("1" | "true")) {
        return String::new();
    }
    forge_core::fiat::Price::new(MAINNET.load(Ordering::Relaxed)).ready_note(dash, balance)
}
