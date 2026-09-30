//! Surviving a quorum rotation.
//!
//! A proof is verified against a quorum's public key, which the trusted context provider serves
//! from its cache and, on a miss, refetches from the network's quorum service. When a quorum
//! rotates, that service lags the network by a few minutes, so for those minutes every proof
//! signed by the new quorum fails with a context-provider error. The SDK counts each such
//! failure against the node that sent the proof and bans it, until every node is banned and a
//! request ends in "no available addresses". Nothing is wrong with the nodes.
//!
//! [`is_quorum_miss`] recognises that failure (also inside the SDK's "no available addresses"
//! wrapper). The read and write loops then wait for the service instead of giving up after
//! their ordinary 2/4/8 s backoff: [`QUORUM_WAITS`] (about 4 minutes in all), unbanning every
//! node before each retry ([`unban_all`]) and saying so on stderr. A write keeps its nonce-spent
//! probe between waits, so it can never land twice.

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use dash_sdk::dapi_client::AddressList;
use dash_sdk::error::ContextProviderError;

/// The pauses before each retry after a quorum miss: 225 s in all, longer than the quorum
/// service takes to catch up with a rotation (a few minutes on bonsia).
pub(super) const QUORUM_WAITS: [Duration; 5] = [
    Duration::from_secs(15),
    Duration::from_secs(30),
    Duration::from_secs(60),
    Duration::from_secs(60),
    Duration::from_secs(60),
];

/// The address lists of this process's SDKs, whose bans a quorum miss clears. An
/// [`AddressList`] clone shares its state with the SDK's own.
static ADDRESS_LISTS: OnceLock<Mutex<Vec<AddressList>>> = OnceLock::new();

/// Remember an SDK's address list, so a quorum miss can unban its nodes.
pub(super) fn register(list: &AddressList) {
    ADDRESS_LISTS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .push(list.clone());
}

/// Clear every node's ban: the proofs they sent failed for want of the quorum's key, not
/// through any fault of theirs.
pub(super) fn unban_all() {
    let Some(lists) = ADDRESS_LISTS.get() else {
        return;
    };
    for list in lists
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .iter()
    {
        for info in list.ban_info().into_iter().filter(|i| i.ban_count > 0) {
            if let Ok(address) = info.uri.parse() {
                list.unban(&address);
            }
        }
    }
}

/// Whether `e` is a proof the context provider could not verify for want of the quorum's key
/// (a rotation its quorum service has not caught up with), directly, inside a proof error, or
/// as the last failure before the SDK ran out of unbanned nodes.
pub(super) fn is_quorum_miss(e: &dash_sdk::Error) -> bool {
    match e {
        dash_sdk::Error::ContextProviderError(c) => is_quorum_context_error(c),
        dash_sdk::Error::Proof(drive_proof_verifier::Error::ContextProviderError(c)) => {
            is_quorum_context_error(c)
        }
        dash_sdk::Error::NoAvailableAddressesToRetry(inner) => is_quorum_miss(inner),
        _ => false,
    }
}

/// A context-provider error about a quorum: an unknown quorum, or a refetch that did not find
/// it (the provider reports that as a generic "Failed to find quorum: Quorum not found …").
/// Not a missing contract or token configuration, which no wait fixes.
fn is_quorum_context_error(c: &ContextProviderError) -> bool {
    match c {
        ContextProviderError::InvalidQuorum(_) => true,
        ContextProviderError::Generic(text) => text.to_ascii_lowercase().contains("quorum"),
        _ => false,
    }
}

/// Before retry number `n` (0-based) after a quorum miss in `label`: say so, unban every node,
/// and wait `pause`.
pub(super) async fn wait_for_quorum(label: &str, n: usize, pause: Duration) {
    let waited: Duration = QUORUM_WAITS.iter().take(n).sum();
    eprintln!(
        "dash: waiting for the network's new quorum (the quorum service lags a rotation); \
         retrying in {} s ({} s so far, {label})",
        pause.as_secs(),
        waited.as_secs()
    );
    tracing::warn!(
        op = label,
        retry = n + 1,
        wait_ms = pause.as_millis(),
        "quorum not found for a proof; unbanning nodes and waiting for the quorum service"
    );
    unban_all();
    tokio::time::sleep(pause).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(c: ContextProviderError) -> dash_sdk::Error {
        dash_sdk::Error::Proof(drive_proof_verifier::Error::ContextProviderError(c))
    }

    #[test]
    fn a_missing_quorum_is_recognised_in_every_wrapper() {
        let refetch_failed = || {
            provider(ContextProviderError::Generic(
                "Failed to find quorum: Quorum not found for type 107 and hash 1e852f2a".into(),
            ))
        };
        assert!(is_quorum_miss(&refetch_failed()));
        assert!(is_quorum_miss(&provider(
            ContextProviderError::InvalidQuorum("Quorum not found in cache for hash: 1e85".into())
        )));
        assert!(is_quorum_miss(&dash_sdk::Error::ContextProviderError(
            ContextProviderError::InvalidQuorum("x".into())
        )));
        // The SDK banned every node on it and gave up.
        assert!(is_quorum_miss(
            &dash_sdk::Error::NoAvailableAddressesToRetry(Box::new(refetch_failed()))
        ));
        // Not a quorum: no wait helps.
        assert!(!is_quorum_miss(&provider(
            ContextProviderError::DataContractFailure("contract not found".into())
        )));
        assert!(!is_quorum_miss(
            &dash_sdk::Error::NoAvailableAddressesToRetry(Box::new(dash_sdk::Error::Generic(
                "down".into()
            )))
        ));
        assert!(!is_quorum_miss(&dash_sdk::Error::Generic("quorum".into())));
    }

    #[test]
    fn the_waits_last_about_four_minutes() {
        let total: Duration = QUORUM_WAITS.iter().sum();
        assert!((200..=270).contains(&total.as_secs()), "{total:?}");
    }

    #[test]
    fn unbanning_clears_every_registered_nodes_ban() {
        let mut list = AddressList::new();
        let a: dash_sdk::dapi_client::Address = "https://127.0.0.1:1443".parse().unwrap();
        let b: dash_sdk::dapi_client::Address = "https://127.0.0.2:1443".parse().unwrap();
        list.add(a.clone());
        list.add(b.clone());
        list.ban(&a);
        list.ban(&b);
        assert!(list.get_live_address().is_none());
        register(&list);
        unban_all();
        assert_eq!(list.get_live_addresses().len(), 2);
    }
}
