//! What kind of owner an identity is (organizations design §3): an organization that declared
//! itself in its profile, a multisig that did not, or a person.

use serde::Serialize;

use crate::error::Result;
use crate::network::ForgeIds;
use crate::platform::{IdentityKeyInfo, PlatformClient};

/// The multisig app's origin, as a declared profile link names it.
pub const MULTISIG_ORIGIN: &str = "https://multisig.dashhq.org";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum OwnerKind {
    Person,
    /// All-BLS keys and a profile link `…/?network=<network>#org=<N>of<M>`.
    Org {
        threshold: u32,
        size: u32,
    },
    /// All-BLS keys, no declaration.
    Multisig,
}

/// The profile link an organization declares itself with.
pub fn declared_org_link(network: &str, threshold: u32, size: u32) -> String {
    format!("{MULTISIG_ORIGIN}/?network={network}#org={threshold}of{size}")
}

/// `(N, M)` from a declared link for `network`, if `link` is exactly one.
pub fn parse_declared_org(link: &str, network: &str) -> Option<(u32, u32)> {
    let rest = link
        .trim()
        .strip_prefix(MULTISIG_ORIGIN)?
        .strip_prefix("/?network=")?;
    let (net, counts) = rest.split_once("#org=")?;
    if net.is_empty() || net.contains(['&', '#']) || percent_decode(net)? != network {
        return None;
    }
    let (n, m) = counts.split_once("of")?;
    let num = |s: &str| {
        (!s.is_empty() && s.len() <= 2 && s.bytes().all(|b| b.is_ascii_digit()))
            .then(|| s.parse::<u32>().ok())
            .flatten()
    };
    let (threshold, size) = (num(n)?, num(m)?);
    (threshold >= 2 && threshold <= size && size <= 64).then_some((threshold, size))
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let h = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(h, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Whether every enabled authentication key is BLS12-381 (and there is at least one).
pub fn all_bls_auth_keys(keys: &[IdentityKeyInfo]) -> bool {
    let mut live = keys
        .iter()
        .filter(|k| k.purpose == "AUTHENTICATION" && !k.disabled)
        .peekable();
    live.peek().is_some() && live.all(|k| k.key_type == "BLS12_381")
}

/// Classify from the identity's keys and its profile links: a declaration counts only on an
/// all-BLS identity.
pub fn classify(keys: &[IdentityKeyInfo], links: &[String], network: &str) -> OwnerKind {
    if !all_bls_auth_keys(keys) {
        return OwnerKind::Person;
    }
    links
        .iter()
        .find_map(|l| parse_declared_org(l, network))
        .map_or(OwnerKind::Multisig, |(threshold, size)| OwnerKind::Org {
            threshold,
            size,
        })
}

/// What kind of owner `identity_id` is (its profile is read only for an all-BLS identity).
pub async fn owner_kind(
    client: &PlatformClient,
    forge: &ForgeIds,
    identity_id: &str,
) -> Result<OwnerKind> {
    let keys = client.fetch_identity(identity_id).await?.public_keys();
    if !all_bls_auth_keys(&keys) {
        return Ok(OwnerKind::Person);
    }
    let links = crate::profile::read_profile(client, forge, identity_id)
        .await
        .ok()
        .flatten()
        .and_then(|p| p.fields.links)
        .unwrap_or_default();
    Ok(classify(&keys, &links, &client.network().key()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(purpose: &str, key_type: &str, disabled: bool) -> IdentityKeyInfo {
        IdentityKeyInfo {
            id: 0,
            purpose: purpose.into(),
            security_level: "HIGH".into(),
            key_type: key_type.into(),
            public_key: Vec::new(),
            disabled,
            expires_at: None,
            bound_to: None,
            bounds: None,
        }
    }

    #[test]
    fn a_declared_link_parses_only_for_its_network_and_sane_counts() {
        let l = declared_org_link("testnet", 2, 3);
        assert_eq!(l, "https://multisig.dashhq.org/?network=testnet#org=2of3");
        assert_eq!(parse_declared_org(&l, "testnet"), Some((2, 3)));
        assert_eq!(
            parse_declared_org(&format!(" {l} "), "testnet"),
            Some((2, 3))
        );
        assert_eq!(parse_declared_org(&l, "mainnet"), None);
        for bad in [
            "https://multisig.dashhq.org/?network=testnet#org=1of3",
            "https://multisig.dashhq.org/?network=testnet#org=4of3",
            "https://multisig.dashhq.org/?network=testnet#org=2of65",
            "https://multisig.dashhq.org/?network=testnet#org=2of3x",
            "https://multisig.dashhq.org/?network=testnet&x=1#org=2of3",
            "http://multisig.dashhq.org/?network=testnet#org=2of3",
            "https://evil.example/?network=testnet#org=2of3",
        ] {
            assert_eq!(parse_declared_org(bad, "testnet"), None, "{bad}");
        }
        assert_eq!(
            parse_declared_org(
                "https://multisig.dashhq.org/?network=devnet%2Dx#org=2of2",
                "devnet-x"
            ),
            Some((2, 2))
        );
    }

    #[test]
    fn a_declaration_counts_only_on_an_all_bls_identity() {
        let links = vec![declared_org_link("testnet", 2, 3)];
        let bls = vec![
            key("AUTHENTICATION", "BLS12_381", false),
            key("AUTHENTICATION", "ECDSA_SECP256K1", true),
            key("TRANSFER", "ECDSA_SECP256K1", false),
        ];
        assert_eq!(
            classify(&bls, &links, "testnet"),
            OwnerKind::Org {
                threshold: 2,
                size: 3
            }
        );
        assert_eq!(classify(&bls, &[], "testnet"), OwnerKind::Multisig);
        let mixed = vec![
            key("AUTHENTICATION", "BLS12_381", false),
            key("AUTHENTICATION", "ECDSA_SECP256K1", false),
        ];
        assert_eq!(classify(&mixed, &links, "testnet"), OwnerKind::Person);
        assert_eq!(classify(&[], &links, "testnet"), OwnerKind::Person);
    }
}
