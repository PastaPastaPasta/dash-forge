//! `forge-import`: GitHub → forge-v2 mirroring (PRD 06, ux-dx-spec §8) and forge-v1 →
//! forge-v2 migration. A library so `dg import` / `dg migrate` call it directly; the
//! `forge-import` binary is a thin CLI over it (the GitHub Mirror Action runs that).
//!
//! * [`importer`] — mirror a GitHub repository, once or incrementally.
//! * [`migrate`] — copy a forge-v1 repository into forge-v2.
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
pub mod migrate;
pub mod model;
pub mod sink;
pub mod source_github;
pub mod source_v1;
pub mod state;
pub mod summary;
