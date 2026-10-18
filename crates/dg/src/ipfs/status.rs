//! Owner-only RPC calls bypass the browser proxy.
use super::{config::Tokens, follow, service, Node};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::net::IpAddr;
use std::time::Duration;

pub async fn admin_rpc(node: &Node, tokens: &Tokens, path: &str) -> Result<Value> {
    let response = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(8))
        .build()?
        .post(format!("{}/api/v0/{path}", node.internal_api()))
        .bearer_auth(&tokens.admin)
        .send()
        .await
        .map_err(|_| super::node_error("cannot connect to the IPFS node", "start it: dg ipfs up"))?
        .error_for_status()
        .map_err(|_| {
            super::node_error("the IPFS node refused the request", "start it: dg ipfs up")
        })?;
    Ok(response.json().await?)
}

fn public_address(address: &str) -> bool {
    let mut components = address.split('/');
    while let Some(kind) = components.next() {
        if matches!(kind, "ip4" | "ip6") {
            let Some(ip) = components.next().and_then(|s| s.parse::<IpAddr>().ok()) else {
                return false;
            };
            return match ip {
                IpAddr::V4(ip) => {
                    let [a, b, _, _] = ip.octets();
                    !ip.is_private()
                        && !ip.is_loopback()
                        && !ip.is_link_local()
                        && !ip.is_unspecified()
                        && !ip.is_multicast()
                        && !ip.is_broadcast()
                        && !ip.is_documentation()
                        && a != 0
                        && a < 240
                        && !(a == 100 && (64..128).contains(&b))
                        && !(a == 198 && (18..20).contains(&b))
                }
                IpAddr::V6(ip) => {
                    (ip.segments()[0] & 0xe000) == 0x2000
                        && !(ip.segments()[0] == 0x2001 && ip.segments()[1] == 0x0db8)
                }
            };
        }
    }
    false
}

pub async fn collect(node: &Node) -> Result<Value> {
    let tokens = Tokens::load(node)?;
    let (id, version, repo, pins, listen) = tokio::try_join!(
        admin_rpc(node, &tokens, "id"),
        admin_rpc(node, &tokens, "version"),
        admin_rpc(node, &tokens, "repo/stat"),
        admin_rpc(node, &tokens, "pin/ls?type=recursive"),
        admin_rpc(node, &tokens, "swarm/addrs/listen"),
    )?;
    let public = id["Addresses"].as_array().is_some_and(|addresses| {
        addresses
            .iter()
            .any(|a| a.as_str().is_some_and(public_address))
    });
    Ok(json!({
        "kuboVersion":version["Version"], "peerId":id["ID"], "api":node.api(), "gateway":node.gateway(),
        "repoBytes":repo["RepoSize"].as_u64().context("kubo repo size is missing")?,
        "recursivePins":pins["Keys"].as_object().map_or(0, serde_json::Map::len),
        "listenAddresses":listen["Strings"], "reachability":if public {"public addresses (reachability unverified)"} else {"private-only"},
        "fix":if public {None} else {Some("forward TCP+UDP 4001 to this machine")},
        "service":service::state(node).await, "origins":node.config.origins, "followed":follow::followed(node)?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_addresses_do_not_include_private_loopback_or_carrier_nat() {
        for a in [
            "/ip4/127.0.0.1/tcp/4001",
            "/ip4/10.2.3.4/udp/4001",
            "/ip4/100.64.1.2/tcp/4001",
            "/ip6/::1/tcp/4001",
            "/ip6/fd00::1/tcp/4001",
            "/ip6/2001:db8::1/tcp/4001",
        ] {
            assert!(!public_address(a));
        }
        assert!(public_address("/ip4/8.8.8.8/tcp/4001"));
        assert!(public_address("/ip6/2606:4700::1111/tcp/4001"));
    }
}
