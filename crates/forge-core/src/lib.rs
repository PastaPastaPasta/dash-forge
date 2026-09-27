//! `forge-core` — the shared substance behind every Dash Forge binary.
//!
//! Module map (mirrors `docs/design/style-guide.md` §B repo layout):
//!
//! - [`network`] — the network model (testnet / mainnet / named devnet) and per-network
//!   contract ids from the embedded `forge-contracts/deployments/*.json`.
//! - [`platform`] — `PlatformClient` (rs-sdk wrapper, live testnet/mainnet/devnet) and the
//!   `WriteEngine` document create/delete lifecycle + idempotent-retry journal types.
//! - [`repo`] — `RepoService`: the repo-lifecycle API (`create_repo` / `resolve_repo` /
//!   ref + pack-manifest + chunk read/write) `git-remote-dash` calls.
//! - [`refs`] — complete ref-update reads (keyset scan + completeness fallback) shared by
//!   ref listing and PR base-tip resolution.
//! - [`members`] — repository membership: `maintainer` / `writer` documents.
//! - [`collab`] — issues, PRs, reviews, releases, labels, stars and follows on forge-collab,
//!   folding state through [`rules`].
//! - [`pack`] — chunk geometry and the pure split/join chunker.
//! - [`backends`] — the `PackBackend` trait (`platform | ipfs | s3 | https`).
//! - [`storage`] — bring-your-own storage: user profiles, a repo's replication policy,
//!   the push-side `StorageTarget` fan-out, and the gateway-racing reader.
//! - [`rules`] — `FORGE_RULES_V2`: ref resolution, event folds, protected-pattern matching,
//!   membership, numbering, approvals and the pack reader rule.
//! - [`cost`] — fee constants and the storage-cost estimator.
//! - [`keystore`] — bridge-format identity JSON parsing with redacted secrets.
//! - [`envelope`] — the `encryptedFor` scheme (`ecdh-secp256k1-aes256-cbc`), matching Platform.
//! - [`webhooks`] — forge-v2 `webhook` documents: create/list/remove, newest-wins, secrets.
//! - [`error`] — the `thiserror` taxonomy mirroring the product error classes.
//! - [`user_error`] — [`user_error::UserError`]: stable code + cause + fix, the exit-code
//!   table, and the mapping from [`Error`] / SDK messages that `dg` and the helper render.
//!
//! The async rs-sdk integration is confined to [`platform`] (style guide §B: the SDK
//! is touched in exactly one module); every other module is synchronous and SDK-free.

pub mod backends;
pub mod collab;
pub mod cost;
pub mod create;
pub mod envelope;
pub mod error;
pub mod fork;
pub mod funding;
pub mod keychain;
pub mod keystore;
pub mod members;
pub mod network;
pub mod pack;
pub mod platform;
pub mod private;
pub mod refs;
pub mod repo;
pub mod resolve;
pub mod rules;
pub mod scope;
pub mod sealed;
pub mod storage;
pub mod user_error;
pub mod webhooks;

pub use error::{Error, Result};
pub use user_error::UserError;
