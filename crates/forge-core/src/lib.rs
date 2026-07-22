//! `forge-core` — the shared substance behind every Dash Forge binary.
//!
//! Module map (mirrors `docs/design/style-guide.md` §B repo layout):
//!
//! - [`platform`] — `PlatformClient` (rs-sdk wrapper, Stage 2) and the `WriteEngine`
//!   idempotent state-transition lifecycle + journal types.
//! - [`pack`] — chunk geometry and the pure split/join chunker.
//! - [`backends`] — the `PackBackend` trait (`platform | ipfs | s3 | https`).
//! - [`rules`] — `FORGE_RULES_V1`: ref resolution, event folds, protected-pattern matching.
//! - [`cost`] — fee constants and the storage-cost estimator.
//! - [`keystore`] — bridge-format identity JSON parsing with redacted secrets.
//! - [`error`] — the `thiserror` taxonomy mirroring the product error classes.
//!
//! This crate is deliberately synchronous and SDK-free for now; the async rs-sdk
//! integration is confined to [`platform`] and arrives in Stage 2.

pub mod backends;
pub mod cost;
pub mod error;
pub mod keystore;
pub mod pack;
pub mod platform;
pub mod rules;

pub use error::{Error, Result};
