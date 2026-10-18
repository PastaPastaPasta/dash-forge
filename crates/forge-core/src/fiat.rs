//! Optional mainnet fiat equivalents for CLI output. Failures never fail a command.

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::cache;

const FRESH_MS: u64 = 10 * 60 * 1000;
const USABLE_MS: u64 = 24 * 60 * 60 * 1000;
const CTX_URL: &str = "https://rates.ctx.com/rates?source=ctx";
const COINGECKO_URL: &str = "https://api.coingecko.com/api/v3/simple/price?ids=dash&vs_currencies=usd,eur,gbp,jpy,cad,aud,chf,cny,hkd,sgd,inr,krw,brl,mxn,ars,clp,zar,ngn,try,rub,uah,pln,czk,huf,sek,nok,dkk,ils,aed,sar,thb,idr,php,vnd";
type Rates = BTreeMap<String, f64>;

fn currencies() -> &'static BTreeMap<String, u8> {
    static TABLE: OnceLock<BTreeMap<String, u8>> = OnceLock::new();
    TABLE.get_or_init(|| {
        serde_json::from_str(include_str!("fiat/currencies.json")).expect("currency table")
    })
}

fn valid_rate(rate: f64) -> bool {
    rate.is_finite() && rate > 0.0
}

/// Clap-compatible validation: only the curated fiat codes and `off`.
pub fn parse_setting(value: &str) -> Result<String, String> {
    if value == "off" || currencies().contains_key(value) {
        Ok(value.to_string())
    } else {
        Err("expected a supported fiat currency code (such as USD or EUR), or off".into())
    }
}

/// Resolve settings without IO. `off` in any layer wins; invalid env/config use USD.
fn resolve_setting(
    flag: Option<&str>,
    env: Option<&str>,
    config: Option<&str>,
) -> (String, Option<&'static str>) {
    if [flag, env, config].contains(&Some("off")) {
        return ("off".into(), None);
    }
    let mut warning = None;
    for (value, layer) in [(env, "DASH_FORGE_FIAT"), (config, "config.toml fiat")] {
        if value.is_some_and(|v| parse_setting(v).is_err()) {
            warning = Some(layer);
            break;
        }
    }
    let selected = flag.or(env).or(config).unwrap_or("USD");
    (
        parse_setting(selected).unwrap_or_else(|_| "USD".into()),
        warning,
    )
}

static SETTING: OnceLock<String> = OnceLock::new();

/// Set dg's flag before any price is rendered. Other binaries resolve env/config lazily.
/// This performs no rate fetch.
pub fn initialize(flag: Option<&str>) {
    SETTING.get_or_init(|| {
        if cfg!(test) {
            return "off".into();
        }
        let config = crate::config_file::dg_config_path()
            .and_then(|p| crate::config_file::read_config_toml(&p).ok().flatten());
        let config = config
            .as_ref()
            .and_then(|v| v.get("fiat"))
            .and_then(toml::Value::as_str);
        let env = std::env::var("DASH_FORGE_FIAT").ok();
        let (setting, warning) = resolve_setting(flag, env.as_deref(), config);
        if let Some(layer) = warning {
            eprintln!("warning: unsupported fiat currency in {layer}; using USD for that setting");
        }
        setting
    });
}

/// The resolved currency or `off`, also forwarded to git helpers started by dg.
pub fn setting() -> &'static str {
    initialize(None);
    SETTING.get().map_or("off", String::as_str)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    v: u8,
    source: String,
    fetched_at: u64,
    rates: Rates,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    failed_at: Option<u64>,
}

impl Snapshot {
    fn usable(&self, now: u64) -> bool {
        self.v == 1
            && matches!(self.source.as_str(), "ctx" | "coingecko" | "DASH_USD")
            && self.fetched_at <= now
            && now - self.fetched_at < USABLE_MS
            && self.rates.get("USD").is_some_and(|r| valid_rate(*r))
    }

    fn needs_refresh(&self, now: u64) -> bool {
        let fresh = self.usable(now) && now - self.fetched_at < FRESH_MS;
        let failed_recently = self
            .failed_at
            .is_some_and(|t| t <= now && now - t < FRESH_MS);
        !fresh && !failed_recently
    }
}

struct State {
    snapshot: Mutex<Snapshot>,
    started: OnceLock<()>,
    fixed: bool,
}

fn empty_snapshot() -> Snapshot {
    Snapshot {
        v: 1,
        source: "ctx".into(),
        fetched_at: 0,
        rates: Rates::new(),
        failed_at: None,
    }
}

static STATE: OnceLock<State> = OnceLock::new();

fn state() -> &'static State {
    STATE.get_or_init(|| {
        let fixed = std::env::var("DASH_USD")
            .ok()
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|r| valid_rate(*r));
        let snapshot = if let Some(rate) = fixed {
            Snapshot {
                v: 1,
                source: "DASH_USD".into(),
                fetched_at: cache::now_ms(),
                rates: BTreeMap::from([("USD".into(), rate)]),
                failed_at: None,
            }
        } else {
            cache::dir()
                .and_then(|d| cache::read(&d.join("fiat-rates.json")))
                .and_then(|bytes| serde_json::from_slice::<Snapshot>(&bytes).ok())
                .filter(|s| s.v == 1 && matches!(s.source.as_str(), "ctx" | "coingecko"))
                .unwrap_or_else(empty_snapshot)
        };
        State {
            snapshot: Mutex::new(snapshot),
            started: OnceLock::new(),
            fixed: fixed.is_some(),
        }
    })
}

/// CTX quotes strings, and `retrieved` is deliberately ignored.
fn parse_ctx(value: &Value) -> Option<Rates> {
    let mut rates = Rates::new();
    for row in value.as_array()? {
        if row.get("baseCurrency").and_then(Value::as_str) != Some("DASH") {
            continue;
        }
        let Some(code) = row
            .get("quoteCurrency")
            .and_then(Value::as_str)
            .filter(|c| currencies().contains_key(*c))
        else {
            continue;
        };
        let Some(rate) = row
            .get("price")
            .and_then(Value::as_str)
            .and_then(|s| s.trim().parse::<f64>().ok())
            .filter(|r| valid_rate(*r))
        else {
            continue;
        };
        rates.insert(code.to_string(), rate);
    }
    rates.contains_key("USD").then_some(rates)
}

fn parse_coingecko(value: &Value) -> Option<Rates> {
    let dash = value.get("dash")?.as_object()?;
    let rates: Rates = currencies()
        .keys()
        .filter_map(|code| {
            let rate = dash
                .get(&code.to_lowercase())?
                .as_f64()
                .filter(|r| valid_rate(*r))?;
            Some((code.clone(), rate))
        })
        .collect();
    rates.contains_key("USD").then_some(rates)
}

fn safe_rate_url(value: &str) -> Option<reqwest::Url> {
    if value.trim() != value || value.contains(|c: char| c.is_whitespace() || c == '\\') {
        return None;
    }
    let url = reqwest::Url::parse(value).ok()?;
    (matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")))
    .then_some(url)
}

async fn fetch_providers(providers: &[(String, &str)]) -> Option<Snapshot> {
    let builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(1))
        .redirect(reqwest::redirect::Policy::none());
    // Loopback fixtures must not go through a developer's HTTP proxy.
    let builder = if cfg!(test) {
        builder.no_proxy()
    } else {
        builder
    };
    let client = builder.build().ok()?;
    // The outer timeout covers response bodies and both providers together.
    tokio::time::timeout(Duration::from_secs(2), async {
        for (url, source) in providers {
            let Ok(response) = client.get(url).send().await else {
                continue;
            };
            if !response.status().is_success() {
                continue;
            }
            let Ok(bytes) = response.bytes().await else {
                continue;
            };
            let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            let rates = if *source == "ctx" {
                parse_ctx(&value)
            } else {
                parse_coingecko(&value)
            };
            if let Some(rates) = rates {
                return Some(Snapshot {
                    v: 1,
                    source: (*source).into(),
                    fetched_at: cache::now_ms(),
                    rates,
                    failed_at: None,
                });
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
}

fn refresh() {
    let providers = std::env::var("DASH_FORGE_FIAT_RATE_URL")
        .ok()
        .and_then(|s| safe_rate_url(&s))
        .map_or_else(
            || vec![(CTX_URL.into(), "ctx"), (COINGECKO_URL.into(), "coingecko")],
            |url| vec![(url.to_string(), "ctx")],
        );
    let fetched = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()
        .and_then(|rt| rt.block_on(fetch_providers(&providers)));
    let Ok(mut snapshot) = state().snapshot.lock() else {
        return;
    };
    if let Some(fetched) = fetched {
        *snapshot = fetched;
    } else {
        snapshot.failed_at = Some(cache::now_ms());
    }
    let saved = snapshot.clone();
    drop(snapshot);
    if let (Some(dir), Ok(bytes)) = (cache::dir(), serde_json::to_vec(&saved)) {
        cache::write(&dir.join("fiat-rates.json"), &bytes);
    }
}

fn start(wait: bool) {
    if setting() == "off" {
        return;
    }
    let state = state();
    state.started.get_or_init(|| {
        if state.fixed
            || !state
                .snapshot
                .lock()
                .is_ok_and(|s| s.needs_refresh(cache::now_ms()))
        {
            return;
        }
        // A separate runtime keeps synchronous formatting safe inside dg's async runtime.
        let thread = std::thread::Builder::new()
            .name("fiat-rates".into())
            .spawn(refresh);
        if let (true, Ok(thread)) = (wait, thread) {
            let _ = thread.join();
        }
    });
}

/// Start a refresh only when prices are enabled and the cache is stale. Never joins it.
pub fn start_background() {
    start(false);
}

/// A copyable, lazy network context. Constructing it never fetches a price.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Price {
    mainnet: bool,
    fixed_usd: Option<f64>,
}

impl Price {
    pub fn new(mainnet: bool) -> Self {
        Self {
            mainnet,
            fixed_usd: None,
        }
    }

    /// Deterministic rates for callers' formatter tests, independent of env and cache.
    pub fn fixed_usd(rate: f64, mainnet: bool) -> Self {
        Self {
            mainnet,
            fixed_usd: Some(rate),
        }
    }

    fn snapshot(self, wait: bool) -> Option<Snapshot> {
        if let Some(rate) = self.fixed_usd.filter(|r| valid_rate(*r)) {
            return Some(Snapshot {
                v: 1,
                source: "DASH_USD".into(),
                fetched_at: 0,
                rates: BTreeMap::from([("USD".into(), rate)]),
                failed_at: None,
            });
        }
        if setting() == "off" {
            return None;
        }
        if wait {
            start(true);
        }
        let snapshot = if wait {
            state().snapshot.lock().ok()?.clone()
        } else {
            state().snapshot.try_lock().ok()?.clone()
        };
        snapshot.usable(cache::now_ms()).then_some(snapshot)
    }

    fn currency(self) -> &'static str {
        if self.fixed_usd.is_some() {
            "USD"
        } else {
            setting()
        }
    }

    /// USD-only, mainnet-only compatibility fields for dg JSON.
    pub fn usd_rate(self) -> Option<f64> {
        if !self.mainnet {
            return None;
        }
        self.snapshot(true)?
            .rates
            .get("USD")
            .copied()
            .filter(|r| valid_rate(*r))
    }

    pub fn json(self, dash: f64) -> Option<Value> {
        let snapshot = self.snapshot(true)?;
        let currency = self.currency();
        let rate = *snapshot.rates.get(currency).filter(|r| valid_rate(**r))?;
        let amount = dash * rate;
        amount.is_finite().then(|| json!({ "currency": currency, "amount": amount, "rate": rate, "source": snapshot.source, "fetchedAt": snapshot.fetched_at }))
    }

    pub fn note(self, dash: f64) -> String {
        self.note_inner(dash, false, true)
    }
    pub fn balance_note(self, dash: f64) -> String {
        self.note_inner(dash, true, true)
    }
    pub fn ready_note(self, dash: f64, balance: bool) -> String {
        self.note_inner(dash, balance, false)
    }

    fn note_inner(self, dash: f64, balance: bool, wait: bool) -> String {
        if balance && !self.mainnet {
            return " · test DASH, no cash value".into();
        }
        let Some(snapshot) = self.snapshot(wait) else {
            return String::new();
        };
        snapshot
            .rates
            .get(self.currency())
            .and_then(|rate| {
                format_fiat(
                    dash,
                    *rate,
                    self.currency(),
                    Kind::Estimate,
                    None,
                    self.mainnet,
                )
            })
            .map_or_else(String::new, |text| format!(" ({text})"))
    }
}

/// The same rounding and labels as the web formatter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Estimate,
    Bound,
    Exact,
}

// Round the shortest decimal representation, as Intl does. Scaling the binary float
// first would round 1.005 down to 1.00 instead of the web's 1.01.
fn rounded_decimal(amount: f64, digits: usize) -> String {
    let raw = amount.abs().to_string();
    let (whole, fraction) = raw.split_once('.').unwrap_or((raw.as_str(), ""));
    let mut rounded = whole.as_bytes().to_vec();
    rounded.extend(fraction.bytes().take(digits));
    rounded.resize(whole.len() + digits, b'0');
    if fraction.as_bytes().get(digits).is_some_and(|c| *c >= b'5') {
        let mut carry = true;
        for digit in rounded.iter_mut().rev() {
            if *digit < b'9' {
                *digit += 1;
                carry = false;
                break;
            }
            *digit = b'0';
        }
        if carry {
            rounded.insert(0, b'1');
        }
    }
    if digits > 0 {
        rounded.insert(rounded.len() - digits, b'.');
    }
    // All bytes come from a finite, nonnegative f64's decimal representation.
    String::from_utf8(rounded).expect("decimal digits")
}

fn money(amount: f64, currency: &str) -> Option<String> {
    if !amount.is_finite() {
        return None;
    }
    let digits = usize::from(*currencies().get(currency)?);
    let number = rounded_decimal(amount, digits);
    let (whole, fraction) = number
        .split_once('.')
        .map_or((number.as_str(), None), |(a, b)| (a, Some(b)));
    let mut grouped = String::new();
    for (i, c) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(c);
    }
    if let Some(fraction) = fraction {
        grouped.push('.');
        grouped.push_str(fraction);
    }
    let symbol = match currency {
        "USD" => "$",
        "EUR" => "€",
        "GBP" => "£",
        "JPY" => "¥",
        "CNY" => "CN¥",
        "CAD" => "CA$",
        "AUD" => "A$",
        "HKD" => "HK$",
        "SGD" => "SGD\u{a0}",
        "INR" => "₹",
        "KRW" => "₩",
        "BRL" => "R$",
        "MXN" => "MX$",
        "ILS" => "₪",
        "PHP" => "₱",
        "VND" => "₫",
        _ => "",
    };
    let prefix = if symbol.is_empty() {
        format!("{currency}\u{a0}")
    } else {
        symbol.into()
    };
    Some(format!(
        "{}{prefix}{grouped}",
        if amount.is_sign_negative() { "-" } else { "" }
    ))
}

pub fn format_fiat(
    dash: f64,
    rate: f64,
    currency: &str,
    kind: Kind,
    range: Option<f64>,
    mainnet: bool,
) -> Option<String> {
    if !dash.is_finite() || !valid_rate(rate) {
        return None;
    }
    let amount = dash * rate;
    let formatted = money(amount, currency)?;
    let unit = 10_f64.powi(-i32::from(*currencies().get(currency)?));
    let text = if let Some(low) = range {
        if !low.is_finite() || low < 0.0 || low > dash {
            return None;
        }
        let low_text = money(low * rate, currency)?;
        if low_text == formatted {
            return format_fiat(dash, rate, currency, kind, None, mainnet);
        }
        if low * rate < unit {
            if amount > 0.0 && amount < unit {
                format!("< {}", money(unit, currency)?)
            } else {
                format!("≤ {formatted}")
            }
        } else {
            format!(
                "{}{low_text}–{formatted}",
                if kind == Kind::Exact { "" } else { "≈ " }
            )
        }
    } else if amount > 0.0 && amount < unit {
        format!("< {}", money(unit, currency)?)
    } else if kind == Kind::Bound && amount != 0.0 {
        format!("≤ {formatted}")
    } else {
        format!(
            "{}{formatted}",
            if kind == Kind::Estimate && amount != 0.0 {
                "≈ "
            } else {
                ""
            }
        )
    };
    Some(format!(
        "{text}{}",
        if mainnet { "" } else { " on mainnet" }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_test_prices_never_initialize_rates() {
        start_background();
        let price = Price::new(true);
        assert!(price.note(1.0).is_empty());
        assert!(price.json(1.0).is_none());
        assert!(price.usd_rate().is_none());
        assert!(
            STATE.get().is_none(),
            "off must not read a cache or fetch rates"
        );
    }

    #[test]
    fn currency_table_matches_web() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../forge-web/lib/fiat/currencies.json");
        if let Ok(raw) = std::fs::read_to_string(path) {
            assert_eq!(
                currencies(),
                &serde_json::from_str::<BTreeMap<String, u8>>(&raw).unwrap()
            );
        }
    }

    #[test]
    fn web_golden_vectors() {
        let raw = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../forge-web/lib/fiat/vectors.json"),
        )
        .unwrap();
        let vectors: Vec<Value> = serde_json::from_str(&raw).unwrap();
        for v in vectors {
            let kind = match v["kind"].as_str().unwrap() {
                "bound" => Kind::Bound,
                "exact" => Kind::Exact,
                _ => Kind::Estimate,
            };
            let actual = format_fiat(
                v["amount"].as_f64().unwrap(),
                v["rate"].as_f64().unwrap(),
                v["currency"].as_str().unwrap(),
                kind,
                v["range"].as_f64(),
                v["network"] == "mainnet",
            );
            assert_eq!(actual.as_deref(), v["expected"].as_str(), "{v}");
        }
        assert!(format_fiat(f64::NAN, 40.0, "USD", Kind::Estimate, None, true).is_none());
        assert!(format_fiat(1.0, f64::INFINITY, "USD", Kind::Estimate, None, true).is_none());
    }

    #[test]
    fn zero_and_sub_minor_unit_bounds() {
        assert_eq!(
            format_fiat(0.0, 40.0, "USD", Kind::Bound, None, true).as_deref(),
            Some("$0.00")
        );
        assert_eq!(
            format_fiat(0.0, 40.0, "USD", Kind::Estimate, None, true).as_deref(),
            Some("$0.00")
        );
        assert_eq!(
            format_fiat(0.0, 40.0, "USD", Kind::Estimate, None, false).as_deref(),
            Some("$0.00 on mainnet")
        );
        assert_eq!(
            format_fiat(0.00001, 40.0, "USD", Kind::Bound, None, true).as_deref(),
            Some("< $0.01")
        );
        assert_eq!(
            format_fiat(0.01, 40.0, "JPY", Kind::Bound, None, true).as_deref(),
            Some("< ¥1")
        );
        assert_eq!(
            format_fiat(0.0002, 40.0, "USD", Kind::Bound, None, false).as_deref(),
            Some("< $0.01 on mainnet")
        );
        assert_eq!(
            format_fiat(0.0002, 40.0, "USD", Kind::Estimate, Some(0.00001), true).as_deref(),
            Some("< $0.01")
        );
    }

    #[test]
    fn provider_shapes_and_validation() {
        let rows = json!([
            {"baseCurrency":"DASH", "quoteCurrency":"USD", "price":"40", "retrieved":"not a date"},
            {"baseCurrency":"DASH", "quoteCurrency":"EUR", "price":"36"},
            {"baseCurrency":"BTC", "quoteCurrency":"USD", "price":"999"},
            {"baseCurrency":"DASH", "quoteCurrency":"XAU", "price":"1"},
            {"baseCurrency":"DASH", "quoteCurrency":"GBP", "price":30}
        ]);
        assert_eq!(
            parse_ctx(&rows).unwrap(),
            BTreeMap::from([("USD".into(), 40.0), ("EUR".into(), 36.0)])
        );
        for price in ["0", "-1", "NaN", "inf", ""] {
            assert!(parse_ctx(
                &json!([{"baseCurrency":"DASH","quoteCurrency":"USD","price":price}])
            )
            .is_none());
        }
        assert!(parse_ctx(&json!([])).is_none());
        assert!(parse_ctx(&json!({})).is_none());
        assert!(parse_coingecko(&json!({"dash":{"last_updated_at":123,"eur":36}})).is_none());
        assert!(parse_coingecko(&json!({"dash":{"usd":"40"}})).is_none());
        assert_eq!(
            parse_coingecko(&json!({"dash":{"usd":40,"eur":36}})).unwrap()["EUR"],
            36.0
        );
    }

    #[test]
    fn settings_and_loopback_only_override() {
        assert_eq!(
            resolve_setting(Some("EUR"), Some("GBP"), Some("JPY")).0,
            "EUR"
        );
        assert_eq!(resolve_setting(None, Some("GBP"), Some("JPY")).0, "GBP");
        assert_eq!(resolve_setting(None, None, Some("JPY")).0, "JPY");
        assert_eq!(resolve_setting(None, None, None).0, "USD");
        for layers in [
            (Some("off"), None, None),
            (Some("EUR"), Some("off"), None),
            (Some("EUR"), None, Some("off")),
        ] {
            assert_eq!(resolve_setting(layers.0, layers.1, layers.2).0, "off");
        }
        assert_eq!(resolve_setting(None, Some("BTC"), Some("EUR")).0, "USD");
        assert!(resolve_setting(None, None, Some("XAU")).1.is_some());
        assert!(parse_setting("BTC").is_err());
        for url in [
            "http://127.0.0.1:123/rates",
            "http://localhost/rates",
            "http://[::1]/rates",
        ] {
            assert!(safe_rate_url(url).is_some());
        }
        for url in [
            "https://example.com",
            "http://localhost.evil",
            "http://u@localhost/",
            " http://localhost/",
            "file:///tmp/rates",
        ] {
            assert!(safe_rate_url(url).is_none());
        }
    }

    #[test]
    fn cache_expiry_failure_backoff_and_atomic_write() {
        let now = USABLE_MS * 2;
        let mut s = Snapshot {
            v: 1,
            source: "ctx".into(),
            fetched_at: now - FRESH_MS + 1,
            rates: BTreeMap::from([("USD".into(), 40.0)]),
            failed_at: None,
        };
        assert!(s.usable(now));
        assert!(!s.needs_refresh(now));
        s.fetched_at -= 1;
        assert!(s.needs_refresh(now));
        s.failed_at = Some(now);
        assert!(!s.needs_refresh(now + FRESH_MS - 1));
        assert!(s.needs_refresh(now + FRESH_MS));
        s.fetched_at = now - USABLE_MS;
        assert!(!s.usable(now));
        s.fetched_at = now + 1;
        assert!(!s.usable(now));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fiat-rates.json");
        cache::write(&path, &serde_json::to_vec(&s).unwrap());
        let restored: Snapshot = serde_json::from_slice(&cache::read(&path).unwrap()).unwrap();
        assert_eq!(restored.failed_at, s.failed_at);
        assert!(cache::read(&dir.path().join("missing")).is_none());
    }

    #[tokio::test]
    async fn fetch_falls_back_without_external_network() {
        use crate::test_http::{serve, Reply};
        for primary in [
            Reply::new(503, "unavailable"),
            Reply::new(200, "not json"),
            Reply::new(200, "[]"),
        ] {
            let (url, seen) = serve(move |_| Reply::new(primary.status, primary.body.clone()));
            let (fallback, fallback_seen) =
                serve(|_| Reply::new(200, r#"{"dash":{"usd":40,"eur":36}}"#));
            let s = fetch_providers(&[(url, "ctx"), (fallback, "coingecko")])
                .await
                .unwrap();
            assert_eq!(s.source, "coingecko");
            assert_eq!(s.rates["USD"], 40.0);
            assert_eq!(seen.lock().unwrap().len(), 1);
            let requests = fallback_seen.lock().unwrap();
            assert_eq!(requests.len(), 1);
            assert!(requests[0].header("cookie").is_none());
        }
        let (url, _) = serve(|_| {
            Reply::new(
                200,
                r#"[{"baseCurrency":"DASH","quoteCurrency":"USD","price":"40"}]"#,
            )
        });
        let s = fetch_providers(&[(url, "ctx")]).await.unwrap();
        assert_eq!(s.source, "ctx");
    }

    #[test]
    fn decimal_half_expand_and_currency_symbols_match_intl() {
        assert_eq!(money(1.005, "USD").as_deref(), Some("$1.01"));
        assert_eq!(money(-1.005, "USD").as_deref(), Some("-$1.01"));
        assert_eq!(money(9.995, "USD").as_deref(), Some("$10.00"));
        assert_eq!(money(0.0, "USD").as_deref(), Some("$0.00"));
        assert_eq!(money(-0.0, "USD").as_deref(), Some("-$0.00"));
        assert_eq!(money(1234.5, "CNY").as_deref(), Some("CN¥1,234.50"));
        assert_eq!(money(1234.5, "PHP").as_deref(), Some("₱1,234.50"));
        assert_eq!(money(1234.5, "CHF").as_deref(), Some("CHF\u{a0}1,234.50"));
    }
}
