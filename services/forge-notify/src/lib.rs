//! `forge-notify` — optional, multi-tenant email and Web Push notifications for Dash Forge.
//!
//! A subscriber proves control of a Forge identity with a signed request ([`auth`]; no account,
//! no password), confirms an address by mail (double opt-in), and chooses what they hear about
//! ([`store::Prefs`]). The service follows their watched, owned and member repositories on
//! Platform ([`index`]), polls the public ones with forge-relay's ingest ([`route`]), reads
//! review requests and assignments from the addressee index, and sends mail ([`mail`]) and Web
//! Push ([`push`]) through [`dispatch`].
//!
//! It is a hint, never an authority: every notice links to forge-web, which re-reads the chain
//! with proofs. Forge works the same with this service down. Addresses never go on chain and are
//! encrypted at rest ([`crypto`]); for private repositories the service reads public metadata
//! only and says "new activity", never a title.
//!
//! Module map:
//!  * [`config`] — flags and `FORGE_NOTIFY_*` environment variables.
//!  * [`server`] — wiring and the background loops.
//!  * [`api`] — the HTTP API and the confirm / unsubscribe pages.
//!  * [`auth`] — signed requests (`docs/design/service-auth.md`).
//!  * [`store`] — the SQLite store.
//!  * [`crypto`] — encryption at rest, the blind index, unsubscribe tokens.
//!  * [`chain`] — Platform reads (followed repos, addressed events, private-repo activity).
//!  * [`index`] — the follow index, the addressed and private pollers.
//!  * [`route`] — from relay events to subscribers (watchers, participants, mentions).
//!  * [`dispatch`] — instant mail and push, digests, quotas.
//!  * [`mail`], [`push`] — the channels.
//!  * [`limits`] — per-address rate limits.

pub mod api;
pub mod auth;
pub mod chain;
pub mod config;
pub mod crypto;
pub mod dispatch;
pub mod error;
pub mod index;
pub mod limits;
pub mod mail;
pub mod push;
pub mod route;
pub mod server;
pub mod store;
