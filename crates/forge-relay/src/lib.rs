//! `forge-relay` — the availability-only webhook daemon (PRD 05), for forge-v2 repositories.
//!
//! A library as well as the `forge-relay` binary: `forge-notify` (services/forge-notify) drives
//! the same ingest through [`daemon::run_with`], with its own [`sinks::EventSink`] and watch set.
//!
//! A maintainer writes a forge-community `webhook` document (`dg webhook add`) naming a URL, the
//! events it wants, and a relay identity, with the HMAC secret encrypted to that relay's
//! encryption key. A relay started with that identity finds every hook addressed to it
//! (`relay` index), decrypts the secrets in memory, polls those repos' documents (Platform has
//! no document push subscriptions), and POSTs GitHub-shaped `push` / `issues` /
//! `pull_request` / `issue_comment` / `pull_request_review` / `release` / `check_run`
//! webhooks, signed with `X-Hub-Signature-256`. Relays are interchangeable: re-pointing a hook
//! at another relay is one document. Consumers re-fetch and verify from Platform, so a relay
//! is trusted for availability only.
//!
//! Module map:
//!  * [`config`] — TOML + CLI configuration.
//!  * [`subscriptions`] — discovery of the `webhook` documents addressed to this relay.
//!  * [`ingest`] — per-repo streams, cursors, and document → event translation.
//!  * [`payload`] — GitHub-shape payload construction (pure, unit-tested).
//!  * [`deliver`] — HMAC-SHA256 signing, retry/backoff, per-host bounds, dead-letter.
//!  * [`ssrf`] — delivery-target SSRF guard.
//!  * [`daemon`] — the discover → poll → translate → deliver loop.
//!  * [`health`] — the optional listener: liveness, and runner wake-ups.
//!  * [`wake`] — runner wake-ups: a signed long-poll that tells a runner to poll now.
//!  * [`sinks`] — chat, push and email sinks (Discord, Slack, Matrix, ntfy, SMTP) from the
//!    relay's private config, and the [`sinks::EventSink`] hook embedders use.

pub mod checkruns;
pub mod config;
pub mod daemon;
pub mod deliver;
pub mod error;
pub mod health;
pub mod ingest;
pub mod payload;
pub mod queue;
pub mod sinks;
pub mod ssrf;
pub mod subscriptions;
pub mod wake;
