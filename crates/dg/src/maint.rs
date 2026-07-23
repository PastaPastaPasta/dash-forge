//! `dg repack` / `dg reseed` / `dg import` — maintenance commands.
//!
//! These depend on pipelines that live in `git-remote-dash` (the pack push/repack
//! pipeline) and `forge-import` (the GitHub importer), which are not yet wired into a
//! reusable `forge-core` entry point. They are stubbed here with a clear "not yet wired"
//! status and a TODO rather than silently no-op'ing.

// The stubs are intentionally infallible today (they only print a status); the `Result`
// return keeps a stable signature for when the pipelines they front get wired.
#![allow(clippy::unnecessary_wraps)]

use anyhow::Result;
use serde_json::json;

use crate::context::Ctx;
use crate::Backend;

/// `dg repack` — optimized repack + upload + delete-superseded refund. Needs the pack
/// build/push pipeline (`git-remote-dash`'s `PackPipeline`), not yet exposed via
/// `forge-core`.
pub fn repack(ctx: &Ctx, repo: Option<&str>) -> Result<()> {
    ctx.emit(
        json!({
            "status": "not_implemented",
            "command": "repack",
            "repo": repo,
            "todo": "build an optimized pack (system git), upload via the push pipeline, write the new manifest, then delete superseded chunks/manifests for the storage refund — the pack pipeline is owned by git-remote-dash and not yet exposed as a forge-core entry point",
        }),
        || {
            eprintln!("dg repack: not yet wired");
            eprintln!("  TODO: reuse the git-remote-dash pack pipeline to repack + upload + refund superseded storage.");
            eprintln!("  Today, refunding a repo's deletable storage is available via `dg repo delete`.");
        },
    );
    Ok(())
}

/// `dg reseed` — re-upload packs to another backend and append mirror URIs. Needs pack-byte
/// read + external-backend write + a manifest-URI rewrite, not yet exposed via `forge-core`.
pub fn reseed(ctx: &Ctx, repo: Option<&str>, to: Option<Backend>) -> Result<()> {
    ctx.emit(
        json!({
            "status": "not_implemented",
            "command": "reseed",
            "repo": repo,
            "to": to.map(Backend::label),
            "todo": "read each pack's bytes (RepoService::get_pack), PUT them to the target backend, and append the returned mirror URIs to the packManifest — appending URIs requires a manifest-rewrite path not yet exposed by forge-core",
        }),
        || {
            eprintln!("dg reseed: not yet wired");
            if let Some(b) = to {
                eprintln!("  requested target backend: {}", b.label());
            }
            eprintln!("  TODO: get_pack → backend.put → append mirror URIs to the manifest.");
        },
    );
    Ok(())
}

/// `dg import <github-url>` — thin wrapper over `forge-import` (PRD 06), not yet wired.
pub fn import(ctx: &Ctx, url: &str) -> Result<()> {
    ctx.emit(
        json!({
            "status": "not_implemented",
            "command": "import",
            "url": url,
            "todo": "delegate to the forge-import crate (Forgejo-semantics mapping, PRD 06); the importer is not yet exposed as a callable entry point",
        }),
        || {
            eprintln!("dg import: not yet wired");
            eprintln!("  TODO: delegate {url} to forge-import (PRD 06).");
        },
    );
    Ok(())
}
