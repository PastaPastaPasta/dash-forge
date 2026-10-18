//! Optional mainnet fiat equivalents for CLI output. Failures never fail a command.

use std::collections::BTreeMap;
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::cache;

const MAX_BODY: usize = 512 * 1024;
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
    let value = value.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("off") {
        Ok(value.to_ascii_lowercase())
    } else if currencies().contains_key(&value.to_ascii_uppercase()) {
        Ok(value.to_ascii_uppercase())
    } else {
        Err("expected a supported fiat currency code (such as USD or EUR), or off".into())
    }
}

/// Resolve settings without IO. Empty layers are unset; `off` in any layer wins.
fn resolve_setting(
    flag: Option<&str>,
    env: Option<&str>,
    config: Option<&str>,
) -> (String, Option<&'static str>) {
    let layers = [
        (flag, "--fiat"),
        (env, "DASH_FORGE_FIAT"),
        (config, "config.toml fiat"),
    ];
    if layers
        .iter()
        .any(|(v, _)| v.is_some_and(|v| v.trim().eq_ignore_ascii_case("off")))
    {
        return ("off".into(), None);
    }
    for (value, layer) in layers {
        if let Some(value) = value.filter(|v| !v.trim().is_empty()) {
            return match parse_setting(value) {
                Ok(value) => (value, None),
                Err(_) => ("USD".into(), Some(layer)),
            };
        }
    }
    ("USD".into(), None)
}

/// Foreground CLIs may wait for one bounded refresh. Remote helpers only read ready rates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Wait,
    Ready,
}

struct Settings {
    currency: String,
    mainnet: bool,
    mode: Mode,
    quiet: bool,
}

static SETTINGS: OnceLock<Settings> = OnceLock::new();

/// Initialize from a binary's entry point. Until then prices are off, including in tests.
/// This reads settings only: fetching remains lazy (or explicitly started for a push).
pub fn initialize(network: &crate::network::Network, flag: Option<&str>, mode: Mode) {
    SETTINGS.get_or_init(|| {
        let config = crate::config_file::dg_config_path()
            .and_then(|p| crate::config_file::read_config_toml(&p).ok().flatten());
        let config_value = config.as_ref().and_then(|v| v.get("fiat"));
        // A non-string value is invalid rather than silently unset.
        let config = config_setting(config_value);
        let env = std::env::var("DASH_FORGE_FIAT").ok();
        let (currency, warning) = resolve_setting(flag, env.as_deref(), config);
        if let Some(layer) = warning {
            eprintln!("warning: unsupported fiat currency in {layer}; using USD");
        }
        Settings {
            currency,
            mainnet: matches!(network, crate::network::Network::Mainnet),
            mode,
            quiet: mode == Mode::Ready
                && matches!(std::env::var("GIT_DASH_JSON").as_deref(), Ok("1" | "true")),
        }
    });
}

fn config_setting(value: Option<&toml::Value>) -> Option<&str> {
    value.map(|v| v.as_str().unwrap_or("<non-string>"))
}

/// The resolved currency or `off`, also forwarded to helpers started by dg.
pub fn setting() -> &'static str {
    SETTINGS.get().map_or("off", |s| s.currency.as_str())
}

/// Shared network context for note helpers; constructing it never fetches.
pub fn price() -> Price {
    Price::new(SETTINGS.get().is_some_and(|s| s.mainnet))
}

pub fn dash_note(dash: f64) -> String {
    price().note(dash)
}

pub fn note_credits(credits: u64) -> String {
    dash_note(crate::repo::credits_to_dash(credits))
}

/// Test-network balances never carry fiat or add copy to their surrounding sentence.
pub fn balance_note_credits(credits: u64) -> String {
    price().balance_note(crate::repo::credits_to_dash(credits))
}

/// Retained only at dg's original balance and cost-table sites.
pub const NO_CASH_VALUE: &str = "test DASH, no cash value";

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
    started: OnceLock<Option<Refresh>>,
    fixed: bool,
}

struct Refresh {
    deadline: Instant,
    completed: Mutex<mpsc::Receiver<()>>,
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
        .user_agent("dash-forge")
        .connect_timeout(Duration::from_secs(1))
        .redirect(reqwest::redirect::Policy::none());
    // Loopback fixtures must not go through a developer's HTTP proxy.
    let builder = if providers
        .iter()
        .all(|(url, _)| safe_rate_url(url).is_some())
    {
        builder.no_proxy()
    } else {
        builder
    };
    let client = builder.build().ok()?;
    // The outer timeout covers response bodies and both providers together.
    tokio::time::timeout(Duration::from_secs(2), async {
        for (url, source) in providers {
            let Ok(mut response) = client.get(url).send().await else {
                continue;
            };
            if !response.status().is_success() {
                continue;
            }
            if response
                .content_length()
                .is_some_and(|len| len > MAX_BODY as u64)
            {
                continue;
            }
            let mut bytes = Vec::new();
            let mut complete = false;
            while let Ok(chunk) = response.chunk().await {
                let Some(chunk) = chunk else {
                    complete = true;
                    break;
                };
                if chunk.len() > MAX_BODY - bytes.len() {
                    break;
                }
                bytes.extend_from_slice(&chunk);
            }
            if !complete {
                continue;
            }
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
        .and_then(|rt| {
            let fetched = rt.block_on(fetch_providers(&providers));
            // DNS uses spawn_blocking; dropping the runtime could otherwise wait on it.
            rt.shutdown_background();
            fetched
        });
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

impl Refresh {
    fn spawn(work: impl FnOnce() + Send + 'static) -> Option<Self> {
        let deadline = Instant::now() + Duration::from_secs(2);
        let (tx, rx) = mpsc::channel();
        // Dropping the handle detaches the worker, including if DNS or cache IO stalls.
        let _thread = std::thread::Builder::new()
            .name("fiat-rates".into())
            .spawn(move || {
                work();
                let _ = tx.send(());
            })
            .ok()?;
        Some(Self {
            deadline,
            completed: Mutex::new(rx),
        })
    }

    fn wait(&self) {
        if let Ok(completed) = self.completed.try_lock() {
            let _ = completed.recv_timeout(self.deadline.saturating_duration_since(Instant::now()));
        }
    }
}

fn start(wait: bool) {
    if setting() == "off" {
        return;
    }
    let state = state();
    let refresh = state.started.get_or_init(|| {
        if state.fixed
            || !state
                .snapshot
                .try_lock()
                .is_ok_and(|s| s.needs_refresh(cache::now_ms()))
        {
            return None;
        }
        // A separate runtime keeps synchronous formatting safe inside a CLI's async runtime.
        Refresh::spawn(refresh)
    });
    if let (true, Some(refresh)) = (wait, refresh) {
        refresh.wait();
    }
}

/// Start a refresh for a push only. It never waits, including under the JSON helper mode.
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
    pub const fn new(mainnet: bool) -> Self {
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

    fn snapshot(self) -> Option<Snapshot> {
        if let Some(rate) = self.fixed_usd.filter(|r| valid_rate(*r)) {
            return Some(Snapshot {
                v: 1,
                source: "DASH_USD".into(),
                fetched_at: 0,
                rates: BTreeMap::from([("USD".into(), rate)]),
                failed_at: None,
            });
        }
        if setting() == "off" || SETTINGS.get().is_some_and(|s| s.quiet) {
            return None;
        }
        if SETTINGS.get().is_some_and(|s| s.mode == Mode::Wait) {
            start(true);
        }
        let snapshot = state().snapshot.try_lock().ok()?.clone();
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
        self.snapshot()?
            .rates
            .get("USD")
            .copied()
            .filter(|r| valid_rate(*r))
    }

    pub fn json(self, dash: f64) -> Option<Value> {
        let snapshot = self.snapshot()?;
        let currency = self.currency();
        let rate = *snapshot.rates.get(currency).filter(|r| valid_rate(**r))?;
        let amount = (dash * rate * 1e6).round() / 1e6;
        amount.is_finite().then(|| json!({ "currency": currency, "amount": amount, "rate": rate, "source": snapshot.source, "fetchedAt": snapshot.fetched_at }))
    }

    pub fn note(self, dash: f64) -> String {
        self.text(dash)
            .map_or_else(String::new, |text| format!(" ({text})"))
    }

    pub fn balance_note(self, dash: f64) -> String {
        if self.mainnet {
            self.note(dash)
        } else {
            String::new()
        }
    }

    /// Bare fiat text for an explicit slot inside a sentence or parentheses.
    pub fn text(self, dash: f64) -> Option<String> {
        let snapshot = self.snapshot()?;
        format_fiat(
            dash,
            *snapshot.rates.get(self.currency())?,
            self.currency(),
            Kind::Estimate,
            None,
            self.mainnet,
        )
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
        let raw = std::fs::read_to_string(path).unwrap();
        assert_eq!(
            currencies(),
            &serde_json::from_str::<BTreeMap<String, u8>>(&raw).unwrap()
        );
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
        let eur = parse_coingecko(&json!({"dash":{"usd":40,"eur":36}})).unwrap()["EUR"];
        assert!((eur - 36.0).abs() < 1e-9);
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
    fn case_empty_invalid_and_overridden_settings() {
        for off in ["off", "OFF", "Off", " off "] {
            assert_eq!(parse_setting(off).unwrap(), "off");
            for layers in [
                (Some(off), None, None),
                (Some("EUR"), Some(off), None),
                (Some("EUR"), None, Some(off)),
            ] {
                assert_eq!(
                    resolve_setting(layers.0, layers.1, layers.2),
                    ("off".into(), None)
                );
            }
        }
        assert_eq!(parse_setting(" eur ").unwrap(), "EUR");
        assert_eq!(parse_setting("").unwrap(), "");
        assert_eq!(
            resolve_setting(Some(""), Some(" "), Some("eur")),
            ("EUR".into(), None)
        );
        assert_eq!(resolve_setting(None, Some(""), None), ("USD".into(), None));
        assert_eq!(
            resolve_setting(Some("eur"), Some("BTC"), Some("XAU")),
            ("EUR".into(), None)
        );
        assert_eq!(
            resolve_setting(None, Some("BTC"), Some("eur")),
            ("USD".into(), Some("DASH_FORGE_FIAT"))
        );
        let config: toml::Value = toml::from_str("fiat = 5").unwrap();
        let setting = config_setting(config.get("fiat"));
        assert_eq!(
            resolve_setting(None, None, setting),
            ("USD".into(), Some("config.toml fiat"))
        );
        assert_eq!(
            resolve_setting(Some("eur"), None, setting),
            ("EUR".into(), None)
        );
    }

    #[test]
    fn fiat_json_rounds_like_legacy_usd() {
        let price = Price::fixed_usd(42.5, true);
        let value = price.json(0.000_511_943_294_117_647_1).unwrap();
        assert_eq!(value["amount"], json!(0.021_758));
        assert!(price.json(f64::INFINITY).is_none());
        assert!(Price::fixed_usd(42.5, false).balance_note(1.0).is_empty());
    }

    #[test]
    fn refresh_wait_has_one_deadline_even_when_worker_stalls() {
        let (release, blocked) = mpsc::channel();
        let refresh = Refresh::spawn(move || {
            let _ = blocked.recv();
        })
        .unwrap();
        let started = Instant::now();
        refresh.wait();
        let elapsed = started.elapsed();
        // Release before assertions so a failed assertion cannot leave a parked worker.
        release.send(()).unwrap();
        assert!(elapsed < Duration::from_millis(2500), "{elapsed:?}");
        let started = Instant::now();
        refresh.wait();
        assert!(started.elapsed() < Duration::from_millis(100));
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
            Reply::new(200, vec![b' '; 512 * 1024 + 1]),
        ] {
            let (url, seen) = serve(move |_| Reply::new(primary.status, primary.body.clone()));
            let (fallback, fallback_seen) =
                serve(|_| Reply::new(200, r#"{"dash":{"usd":40,"eur":36}}"#));
            let s = fetch_providers(&[(url, "ctx"), (fallback, "coingecko")])
                .await
                .unwrap();
            assert_eq!(s.source, "coingecko");
            assert!((s.rates["USD"] - 40.0).abs() < 1e-9);
            assert_eq!(seen.lock().unwrap().len(), 1);
            let requests = fallback_seen.lock().unwrap();
            assert_eq!(requests.len(), 1);
            assert!(requests[0].header("cookie").is_none());
            assert_eq!(requests[0].header("user-agent"), Some("dash-forge"));
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
