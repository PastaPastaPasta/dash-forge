//! Human output only; import JSON remains in credits.

use std::sync::atomic::{AtomicBool, Ordering};

static MAINNET: AtomicBool = AtomicBool::new(false);

pub fn set_network(network: &forge_core::network::Network) {
    MAINNET.store(
        matches!(network, forge_core::network::Network::Mainnet),
        Ordering::Relaxed,
    );
}

pub fn is_mainnet() -> bool {
    MAINNET.load(Ordering::Relaxed)
}

fn price() -> Option<forge_core::fiat::Price> {
    if cfg!(test) {
        None
    } else {
        Some(forge_core::fiat::Price::new(
            MAINNET.load(Ordering::Relaxed),
        ))
    }
}

pub fn note(credits: u64) -> String {
    dash_note(forge_core::repo::credits_to_dash(credits))
}

pub fn dash_note(dash: f64) -> String {
    price().map_or_else(String::new, |p| p.note(dash))
}

pub fn balance_note(credits: u64, mainnet: bool) -> String {
    if !mainnet {
        return " · test DASH, no cash value".into();
    }
    price().map_or_else(String::new, |p| {
        p.balance_note(forge_core::repo::credits_to_dash(credits))
    })
}
