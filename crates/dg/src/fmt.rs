//! Cost/DASH formatting and JSON-output helpers.
//!
//! These are the pure, side-effect-free building blocks the command handlers use to
//! render both human output (DASH primary, USD secondary — style guide §A.2) and the
//! `--json` structs. Keeping them pure keeps them unit-testable without a network.

use forge_core::cost::CREDITS_PER_DASH;
use serde_json::{json, Value};

/// The fallback DASH/USD price used for the *secondary* USD display when no live price
/// feed is configured. The price feed is optional and offline-safe (style guide §C.6):
/// USD is a convenience only — the integer credit / DASH values are the source of truth.
/// Override with the `DASH_USD` environment variable.
pub const FALLBACK_DASH_USD: f64 = 30.0;

/// The measured repo-v1 instantiation cost, in credits, used for the *pre-write* estimate
/// shown before `dg repo create` signs (the economics docs reconcile ~1.18 DASH). The
/// actual measured cost is reported after the create lands.
pub const REPO_CREATE_ESTIMATE_CREDITS: u64 = 118_000_000_000;

/// The DASH/USD price to use: `DASH_USD` env override, else the offline fallback.
pub fn dash_usd_price() -> f64 {
    std::env::var("DASH_USD")
        .ok()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|p| *p > 0.0)
        .unwrap_or(FALLBACK_DASH_USD)
}

/// Convert credits to DASH (1 DASH = 1e11 credits).
#[allow(clippy::cast_precision_loss)]
pub fn credits_to_dash(credits: u64) -> f64 {
    credits as f64 / CREDITS_PER_DASH as f64
}

/// Format a DASH amount with trailing zeros trimmed (but always a leading `0`), e.g.
/// `1.18`, `0.0003`, `0`.
pub fn dash_amount(dash: f64) -> String {
    let s = format!("{dash:.8}");
    let trimmed = s.trim_end_matches('0').trim_end_matches('.');
    if trimmed.is_empty() {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

/// A one-line cost display: DASH primary, USD secondary, e.g.
/// `~0.0003 DASH ≈ $0.01`.
pub fn cost_line(credits: u64, price_usd: f64) -> String {
    let dash = credits_to_dash(credits);
    let usd = dash * price_usd;
    format!("~{} DASH ≈ ${:.2}", dash_amount(dash), usd)
}

/// A refund display (destructive-delete estimate; green in the UI), e.g.
/// `+0.0003 DASH ≈ $0.01 refund`.
pub fn refund_line(credits: u64, price_usd: f64) -> String {
    let dash = credits_to_dash(credits);
    let usd = dash * price_usd;
    format!("+{} DASH ≈ ${:.2} refund", dash_amount(dash), usd)
}

/// The `--json` block for a cost quote (shared by `cost estimate` and the write previews).
pub fn cost_json(credits: u64, price_usd: f64) -> Value {
    let dash = credits_to_dash(credits);
    json!({
        "credits": credits,
        "dash": dash,
        "usd": (dash * price_usd),
        "usdPrice": price_usd,
    })
}

/// The `--json` block for `auth balance`.
pub fn balance_json(identity_id: &str, credits: u64, network: &str) -> Value {
    let dash = credits_to_dash(credits);
    json!({
        "identityId": identity_id,
        "network": network,
        "balanceCredits": credits,
        "balanceDash": dash,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dash_amount_trims_trailing_zeros() {
        assert_eq!(dash_amount(1.18), "1.18");
        assert_eq!(dash_amount(0.000_3), "0.0003");
        assert_eq!(dash_amount(0.0), "0");
        assert_eq!(dash_amount(2.0), "2");
    }

    #[test]
    fn credits_convert_to_dash() {
        assert!((credits_to_dash(CREDITS_PER_DASH) - 1.0).abs() < 1e-12);
        assert!((credits_to_dash(118_000_000_000) - 1.18).abs() < 1e-9);
    }

    #[test]
    fn cost_line_shows_dash_primary_usd_secondary() {
        // 1 MiB storage deposit ≈ 0.283 DASH.
        let line = cost_line(REPO_CREATE_ESTIMATE_CREDITS, 30.0);
        assert!(line.starts_with("~1.18 DASH"), "line was {line}");
        assert!(line.contains("$35.40"), "line was {line}");
    }

    #[test]
    fn refund_line_is_positive_and_labeled() {
        let line = refund_line(27_000_000, 30.0);
        assert!(line.starts_with('+'));
        assert!(line.ends_with("refund"));
    }

    #[test]
    fn cost_json_shape_has_credits_dash_usd() {
        let v = cost_json(118_000_000_000, 30.0);
        assert_eq!(v["credits"], 118_000_000_000_u64);
        assert!((v["dash"].as_f64().unwrap() - 1.18).abs() < 1e-9);
        assert!((v["usd"].as_f64().unwrap() - 35.4).abs() < 1e-6);
    }

    #[test]
    fn balance_json_shape() {
        let v = balance_json("abc123", 250_000_000_000, "testnet");
        assert_eq!(v["identityId"], "abc123");
        assert_eq!(v["network"], "testnet");
        assert_eq!(v["balanceCredits"], 250_000_000_000_u64);
        assert!((v["balanceDash"].as_f64().unwrap() - 2.5).abs() < 1e-9);
    }

    #[test]
    fn price_env_override_is_respected() {
        std::env::set_var("DASH_USD", "42.5");
        assert!((dash_usd_price() - 42.5).abs() < 1e-9);
        std::env::remove_var("DASH_USD");
        assert!((dash_usd_price() - FALLBACK_DASH_USD).abs() < 1e-9);
    }
}
