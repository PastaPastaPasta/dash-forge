//! List a repository's pack manifests (kind, storage, size, uris), signer-free:
//! `cargo run -p forge-import --example show_packs -- <owner>/<name>|<id>`.

use anyhow::{Context, Result};
use forge_core::network::NetworkSettings;
use forge_core::platform::PlatformClient;
use forge_core::repo::RepoReader;

#[tokio::main]
async fn main() -> Result<()> {
    let spec = std::env::args()
        .nth(1)
        .context("usage: show_packs <owner>/<name>|<id>")?;
    let client = PlatformClient::connect(NetworkSettings::from_env().resolve()?).await?;
    let repo = match spec.split_once('/') {
        Some((o, n)) => forge_core::resolve::resolve_named(&client, o, n).await?,
        None => forge_core::resolve::resolve_id(&client, &spec).await?,
    };
    for m in RepoReader::new(&client).read_pack_manifests(&repo).await? {
        println!(
            "{} kind={} storage={} size={} owner={} uris={:?}",
            &hex::encode(m.pack_hash)[..12],
            m.kind,
            m.storage,
            m.size_bytes,
            &m.owner_id[..8],
            m.uris
        );
    }
    Ok(())
}
