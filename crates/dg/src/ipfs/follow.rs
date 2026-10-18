//! The followed repositories, as `dg ipfs status` shows them (`dg ipfs pin --follow` writes the
//! file, and `dg ipfs serve` refreshes them through `crate::ipfs_pin::follow_tick`).
use super::Node;
use anyhow::Result;

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
