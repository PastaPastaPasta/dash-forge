//! Single-use pairing codes. Only their hashes are persisted.
use anyhow::Result;
use rand::RngCore as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq as _;

use super::{config, Node};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pair {
    sha256_hex: String,
    expires_at: u64,
    attempts: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub link: String,
    pub code: String,
    pub expires_at: u64,
}

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn hash(code: &str) -> [u8; 32] {
    Sha256::digest(
        code.chars()
            .filter(|c| *c != '-')
            .collect::<String>()
            .to_ascii_uppercase()
            .as_bytes(),
    )
    .into()
}

pub fn create(node: &Node) -> Result<Connection> {
    let _lock = config::lock(&node.dir, "pair.lock")?;
    let mut random = [0; 12];
    rand::rngs::OsRng.fill_bytes(&mut random);
    let alphabet = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let raw: String = random
        .iter()
        .map(|b| char::from(alphabet[usize::from(b & 31)]))
        .collect();
    let code = format!("{}-{}-{}", &raw[..4], &raw[4..8], &raw[8..]);
    let expires_at = now() + 600;
    let pair = Pair {
        sha256_hex: hex::encode(hash(&raw)),
        expires_at,
        attempts: 0,
    };
    config::write_private(&node.dir.join("pair.json"), &serde_json::to_vec(&pair)?)?;
    Ok(Connection {
        link: format!(
            "{}/settings/storage/#kubo={}.{}",
            node.config.origins[0], node.config.api_port, code
        ),
        code,
        expires_at,
    })
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Success,
    Wrong,
    Gone,
}

pub fn consume(node: &Node, code: &str, now: u64) -> Result<Verdict> {
    let _lock = config::lock(&node.dir, "pair.lock")?;
    let path = node.dir.join("pair.json");
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Verdict::Gone),
        Err(e) => return Err(e.into()),
    };
    let mut pair: Pair = serde_json::from_slice(&bytes)?;
    if pair.expires_at <= now || pair.attempts >= 5 {
        std::fs::remove_file(&path)?;
        return Ok(Verdict::Gone);
    }
    let expected = hex::decode(&pair.sha256_hex)?;
    if bool::from(expected.as_slice().ct_eq(&hash(code))) {
        std::fs::remove_file(&path)?;
        return Ok(Verdict::Success);
    }
    pair.attempts += 1;
    if pair.attempts >= 5 {
        std::fs::remove_file(&path)?;
    } else {
        config::write_private(&path, &serde_json::to_vec(&pair)?)?;
    }
    Ok(Verdict::Wrong)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pairing_is_normalized_single_use_expiring_and_attempt_limited() {
        let temp = tempfile::tempdir().unwrap();
        let node = Node {
            dir: temp.path().into(),
            config: config::NodeConfig::default(),
        };
        let c = create(&node).unwrap();
        let persisted = std::fs::read_to_string(node.dir.join("pair.json")).unwrap();
        assert!(!persisted.contains(&c.code));
        assert_eq!(
            consume(&node, &c.code.replace('-', "").to_ascii_lowercase(), now()).unwrap(),
            Verdict::Success
        );
        assert_eq!(consume(&node, &c.code, now()).unwrap(), Verdict::Gone);
        let c = create(&node).unwrap();
        assert_eq!(
            consume(&node, &c.code, c.expires_at).unwrap(),
            Verdict::Gone
        );
        create(&node).unwrap();
        for _ in 0..5 {
            assert_eq!(consume(&node, "wrong", now()).unwrap(), Verdict::Wrong);
        }
        assert_eq!(consume(&node, "wrong", now()).unwrap(), Verdict::Gone);
    }
}
