//! R2 replaces this hook with followed-repository refreshes.
use super::Node;
use anyhow::Result;

#[allow(clippy::unused_async)] // R2 fills in the asynchronous refresh implementation.
pub async fn follow_tick(node: &Node) -> Result<()> {
    let _ = followed(node)?;
    Ok(())
}

pub fn followed(node: &Node) -> Result<serde_json::Value> {
    match std::fs::read_to_string(node.dir.join("follow.toml")) {
        Ok(text) if !text.trim().is_empty() => {
            Ok(serde_json::to_value(toml::from_str::<toml::Value>(&text)?)?)
        }
        Ok(_) => Ok(serde_json::json!({})),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(e) => Err(e.into()),
    }
}
