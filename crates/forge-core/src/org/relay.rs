//! The `dti` relay's HTTP API: `GET /v1/rooms/<room>/messages?after=N` pages the room's
//! envelopes (`{messages:[{envelope}], next, more}`); `POST` to the same path adds one.

use serde_json::Value;

use super::ceremony::room_name_ok;
use super::OrgError;

pub const DEFAULT_RELAY: &str = "https://multisig.dashhq.org";
const MAX_PAGES: usize = 200;

#[derive(Debug, Clone)]
pub struct Relay {
    http: reqwest::Client,
    base: String,
}

/// A relay URL as given, normalized: https, or plain http to this computer only.
pub fn normalize_url(url: &str) -> Result<String, OrgError> {
    let url = url.trim().trim_end_matches('/');
    let parsed =
        reqwest::Url::parse(url).map_err(|_| OrgError::Relay(format!("{url} is not a URL")))?;
    let local = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    match parsed.scheme() {
        "https" => Ok(url.to_string()),
        "http" if local => Ok(url.to_string()),
        _ => Err(OrgError::Relay(format!(
            "{url}: a relay address must start with https://"
        ))),
    }
}

impl Relay {
    pub fn new(url: &str) -> Result<Self, OrgError> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .connect_timeout(std::time::Duration::from_secs(10))
            .user_agent(concat!("dash-forge/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| OrgError::Relay(e.to_string()))?;
        Ok(Self {
            http,
            base: normalize_url(url)?,
        })
    }

    pub fn url(&self) -> &str {
        &self.base
    }

    fn messages_url(&self, room: &str) -> Result<String, OrgError> {
        if !room_name_ok(room) {
            return Err(OrgError::Malformed(format!("{room} is not a group id")));
        }
        Ok(format!("{}/v1/rooms/{room}/messages", self.base))
    }

    /// Every envelope in `room`.
    pub async fn messages(&self, room: &str) -> Result<Vec<Value>, OrgError> {
        let url = self.messages_url(room)?;
        let mut out = Vec::new();
        let mut after: i64 = 0;
        for _ in 0..MAX_PAGES {
            let page: Value = self
                .http
                .get(&url)
                .query(&[("after", after)])
                .send()
                .await
                .and_then(reqwest::Response::error_for_status)
                .map_err(|e| self.failed(&e))?
                .json()
                .await
                .map_err(|e| self.failed(&e))?;
            if let Some(list) = page["messages"].as_array() {
                out.extend(list.iter().filter_map(|m| m.get("envelope").cloned()));
            }
            if page["more"].as_bool() != Some(true) {
                return Ok(out);
            }
            after = page["next"]
                .as_i64()
                .filter(|n| *n > after)
                .ok_or_else(|| self.incomplete())?;
        }
        Err(self.incomplete())
    }

    /// Add one envelope to `room`.
    pub async fn post(&self, room: &str, envelope: &Value) -> Result<(), OrgError> {
        let url = self.messages_url(room)?;
        let response = self
            .http
            .post(&url)
            .json(envelope)
            .send()
            .await
            .map_err(|e| self.failed(&e))?;
        if response.status().is_success() {
            return Ok(());
        }
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        Err(OrgError::Relay(format!(
            "the relay at {} refused the message ({status}): {}",
            self.base,
            text.chars().take(300).collect::<String>()
        )))
    }

    fn incomplete(&self) -> OrgError {
        OrgError::Relay(format!(
            "the relay at {} did not return the whole room; try again",
            self.base
        ))
    }

    fn failed(&self, e: &reqwest::Error) -> OrgError {
        OrgError::Relay(format!("could not reach the relay at {}: {e}", self.base))
    }
}
