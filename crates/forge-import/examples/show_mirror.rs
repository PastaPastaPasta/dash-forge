//! Print a forge-v2 repository's issues and pull requests with their folded state, via the
//! forge-v2 collab reads: `cargo run -p forge-import --example show_mirror -- <owner>/<name>`.
//! Network from `DASH_FORGE_NETWORK` / `DASH_FORGE_DEVNET_NAME`. Used to check an import.

use anyhow::{Context, Result};
use forge_core::collab::v2::Collab;
use forge_core::network::NetworkSettings;
use forge_core::platform::PlatformClient;

#[tokio::main]
async fn main() -> Result<()> {
    let spec = std::env::args()
        .nth(1)
        .context("usage: show_mirror <owner>/<name>")?;
    let (owner, name) = spec.split_once('/').context("expected owner/name")?;
    let target = NetworkSettings::from_env().resolve()?;
    let client = PlatformClient::connect(target).await?;
    let repo = forge_core::resolve::resolve_named(&client, owner, name).await?;
    let c = Collab::reader(&client);
    let issues = c.list_issues(&repo, 100).await?.rows;
    for i in issues.iter().rev() {
        let s = c.issue_state(&repo, i).await?;
        let comments = c.comments(&repo, &i.document_id).await?.len();
        println!(
            "issue #{} {:?} open={} labels={:?} comments={} imported={}",
            i.number,
            i.title,
            s.open,
            s.labels,
            comments,
            i.imported.as_ref().map_or("", |x| x.url.as_str())
        );
    }
    let patches = c.list_patches(&repo, 100).await?.rows;
    for p in patches.into_iter().rev() {
        let comments = c.comments(&repo, &p.document_id).await?.len();
        let reviews = c.reviews(&repo, &p.document_id).await?;
        let v = c.patch_view(&repo, p).await?;
        println!(
            "pr #{} {:?} open={} merged={} draft={} labels={:?} head={} base={} src={:?} comments={} reviews={:?}",
            v.patch.number,
            v.patch.title,
            v.state.open,
            v.state.merged,
            v.state.draft,
            v.state.labels,
            &v.patch.head_oid[..v.patch.head_oid.len().min(12)],
            v.patch.base_ref_name,
            v.patch.source_ref_name,
            comments,
            reviews.iter().map(|r| r.verdict.code()).collect::<Vec<_>>()
        );
    }
    let labels = c.labels(&repo).await?;
    println!(
        "labels: {}",
        labels
            .iter()
            .map(|l| l.name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    );
    let (releases, _) = c.releases(&repo).await?;
    println!(
        "releases: {}",
        releases
            .iter()
            .map(|r| r.tag_name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    );
    Ok(())
}
