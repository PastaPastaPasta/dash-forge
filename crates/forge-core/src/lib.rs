//! `forge-core` — the shared substance behind every Dash Forge binary.
//!
//! Module map (mirrors `docs/design/style-guide.md` §B repo layout):
//!
//! - [`platform`] — `PlatformClient` (rs-sdk wrapper, live testnet/mainnet) and the
//!   `WriteEngine` document create/delete lifecycle + idempotent-retry journal types.
//! - [`repo`] — `RepoService`: the repo-lifecycle API (`create_repo` / `resolve_repo` /
//!   ref + pack-manifest + chunk read/write) `git-remote-dash` calls.
//! - [`tokens`] — `TokenService`: the collaborator ACL (grant/suspend/revoke = token
//!   mint/freeze/destroy; balances = the on-chain collaborator list).
//! - [`collab`] — issue / PR / review / release / label services + the registry social
//!   graph (stars / follows), folding state through [`rules`].
//! - [`pack`] — chunk geometry and the pure split/join chunker.
//! - [`backends`] — the `PackBackend` trait (`platform | ipfs | s3 | https`).
//! - [`rules`] — `FORGE_RULES_V1`: ref resolution, event folds, protected-pattern matching.
//! - [`cost`] — fee constants and the storage-cost estimator.
//! - [`keystore`] — bridge-format identity JSON parsing with redacted secrets.
//! - [`error`] — the `thiserror` taxonomy mirroring the product error classes.
//!
//! The async rs-sdk integration is confined to [`platform`] (style guide §B: the SDK
//! is touched in exactly one module); every other module is synchronous and SDK-free.

pub mod backends;
pub mod collab;
pub mod cost;
pub mod error;
pub mod keystore;
pub mod pack;
pub mod platform;
pub mod repo;
pub mod rules;
pub mod tokens;

pub use error::{Error, Result};
