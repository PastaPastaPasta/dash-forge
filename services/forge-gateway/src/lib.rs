//! forge-gateway: an optional, read-only git-over-HTTPS mirror of **public** Dash Forge
//! repositories, with badges, Atom feeds and link previews on the same binary.
//!
//! A gateway is a hint, never an authority (`docs/hosting/forge-gateway.md`):
//!
//! - **Optional.** `dash://` reads Platform and storage directly and never needs it; the
//!   survivability drill has a "gateway down" case.
//! - **Verifiable.** Git objects are content-addressed, so the only things a reader trusts a
//!   mirror for are which tips it serves and how fresh they are. Every repository publishes
//!   `forge-manifest.json` ([`forge_core::mirror::Manifest`]): the Platform height and time of
//!   its snapshot and, per ref, the `$id` of the `refUpdate` that set the tip, which anyone can
//!   re-read with proofs. `dg verify-mirror <url>` and the web clone box's "verify" check it.
//! - **Keyless.** It reads anonymously and holds no identity or repository key: a private
//!   repository is refused (`404`), never served.
//! - **Replaceable.** One image, the same configuration for a self-hoster as for dashhq.
//!
//! Mirrors are kept fresh by polling and, optionally, a forge-relay wake stream
//! ([`wake`]); objects come through the shipped `git-remote-dash` helper (the same proof-checked
//! fetch every client runs), refs and the manifest from a proof-verified snapshot read here
//! ([`upstream`]).

pub mod badge;
pub mod cache;
pub mod config;
pub mod feed;
pub mod git_http;
pub mod limits;
pub mod metrics;
pub mod mirror;
pub mod og;
pub mod server;
pub mod upstream;
pub mod wake;

pub use config::Config;
pub use server::{router, AppState};
