//! Errors, and how each one answers an HTTP request.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

/// A `Result` with [`NotifyError`].
pub type Result<T, E = NotifyError> = std::result::Result<T, E>;

/// What can go wrong. Messages never carry an address, an endpoint, a token or a key.
#[derive(Debug, thiserror::Error)]
pub enum NotifyError {
    /// The configuration is unusable (startup only).
    #[error("config: {0}")]
    Config(String),
    /// The request is malformed or not allowed as asked.
    #[error("{0}")]
    BadRequest(String),
    /// The signature, key, time or nonce of a signed request does not check out.
    #[error("not authorized: {0}")]
    Unauthorized(String),
    /// Nothing there (an expired or unknown token).
    #[error("not found")]
    NotFound,
    /// Too many requests from this address or identity, or a quota is used up.
    #[error("too many requests: {0}")]
    RateLimited(String),
    /// A dependency (Platform, the store) is not answering.
    #[error("unavailable: {0}")]
    Unavailable(String),
    /// The store failed.
    #[error("store: {0}")]
    Store(String),
    /// Anything else.
    #[error("internal: {0}")]
    Internal(String),
}

impl From<rusqlite::Error> for NotifyError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Store(e.to_string())
    }
}

impl From<forge_core::error::Error> for NotifyError {
    fn from(e: forge_core::error::Error) -> Self {
        Self::Unavailable(format!("platform: {e}"))
    }
}

impl NotifyError {
    /// The HTTP status this answers with.
    pub fn status(&self) -> StatusCode {
        match self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::RateLimited(_) => StatusCode::TOO_MANY_REQUESTS,
            Self::Unavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::Config(_) | Self::Store(_) | Self::Internal(_) => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
        }
    }
}

impl IntoResponse for NotifyError {
    fn into_response(self) -> Response {
        let status = self.status();
        // A server-side failure is logged here and answered without its detail.
        let message = if status.is_server_error() {
            tracing::error!(error = %self, "request failed");
            "the notification service failed; try again later".to_string()
        } else {
            self.to_string()
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}
