//! `forge-import`: GitHub → forge-v2 mirroring (PRD 06, ux-dx-spec §8). A library so
//! `dg import` calls it directly; the
//! `forge-import` binary is a thin CLI over it (the GitHub Mirror Action runs that).
//!
//! * [`importer`] — mirror a GitHub repository, once or incrementally.
//! * [`sink`] — diff the desired collaboration state against the chain and write only the
//!   difference, every write charged to the [`budget`] before it is signed.
//! * [`gitsync`] — git data through the ordinary `git-remote-dash` push.
//! * [`summary`] — the run summary (table and `--summary-json`).

pub mod budget;
pub mod claim;
pub mod dest;
pub mod github;
pub mod gitsync;
pub mod importer;
pub mod model;
pub mod sink;
pub mod source_github;
pub mod state;
pub mod summary;
