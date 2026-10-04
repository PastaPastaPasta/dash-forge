//! `forge-import`: GitHub and GitLab → forge-v2 mirroring (PRD 06, ux-dx-spec §8). A library so
//! `dg import` calls it directly; the
//! `forge-import` binary is a thin CLI over it (the GitHub Mirror Action runs that).
//!
//! * [`importer`] — mirror a GitHub repository or GitLab project, once or incrementally.
//! * [`sink`] — diff the desired collaboration state against the chain and write only the
//!   difference, every write charged to the [`budget`] before it is signed.
//! * [`sealed_release`] — releases into a private destination, sealed (private-repos.md §16).
//! * [`pipeline`] — the write phase's schedule: creates in order, each item's other writes in
//!   parallel lanes.
//! * [`chain`] — what the sink reads from and writes to the destination.
//! * [`gitsync`] — git data through the ordinary `git-remote-dash` push.
//! * [`summary`] — the run summary (table and `--summary-json`).
//! * [`snapshot`] — the source read, kept beside `--state` so a restarted run resumes writing.

pub mod assets;
pub mod budget;
pub mod chain;
pub mod claim;
pub mod dest;
pub mod github;
pub mod gitlab;
pub mod gitsync;
pub mod hunk;
pub mod importer;
pub mod long_body;
pub mod model;
pub mod pipeline;
pub mod sealed_release;
pub mod sink;
pub mod snapshot;
pub mod source;
pub mod source_github;
pub mod source_gitlab;
pub mod state;
pub mod summary;

#[cfg(test)]
mod sink_tests;
