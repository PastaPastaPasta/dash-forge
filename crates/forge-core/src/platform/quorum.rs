//! Surviving a quorum rotation.
//!
//! A proof is verified against a quorum's public key, which the trusted context provider serves
//! from its cache and, on a miss, refetches from the network's quorum service. When a quorum
//! rotates, that service lags the network by a few minutes, so for those minutes every proof
//! signed by the new quorum fails with a context-provider error. The SDK counts each such
//! failure against the node that sent the proof and bans it (the ban's reason is the error's
//! text), until every node is banned and any request, a broadcast too, ends in "no available
//! addresses". Nothing is wrong with the nodes.
//!
//! [`is_quorum_miss`] recognises that failure: the proof error itself, or "no available
//! addresses" while nodes are banned over a quorum. The read and write loops then wait for the
//! quorum service instead of giving up after their ordinary 2/4/8 s backoff, pacing their
//! retries by [`QUORUM_WAITS`] within one process-wide budget ([`QUORUM_BUDGET`], counted from
//! the first miss of a rotation), so concurrent and nested waits (a write's nonce probe is a
//! read) still end about 4 minutes after the rotation was noticed. Before and after each pause
//! the nodes banned over a quorum are unbanned (not those banned for a rate limit), and the
//! wait says so on stderr. A quorum service that cannot be reached at all is not a lag: the
//! first wait checks it and gives up at once when it does not answer. A write keeps its
//! nonce-spent probe before every re-send, so it cannot land twice.

use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use dash_sdk::dapi_client::{AddressList, DapiClientError};
use dash_sdk::error::ContextProviderError;
use rs_sdk_trusted_context_provider::TrustedHttpContextProvider;

/// The pauses between one loop's retries after a quorum miss: its pacing, within
/// [`QUORUM_BUDGET`].
pub(super) const QUORUM_WAITS: [Duration; 5] = [
    Duration::from_secs(15),
    Duration::from_secs(30),
    Duration::from_secs(60),
    Duration::from_secs(60),
    Duration::from_secs(60),
];

/// How long this process waits for a rotated quorum, from the first miss of the rotation:
/// longer than the quorum service takes to catch up (a few minutes on bonsia).
const QUORUM_BUDGET: Duration = Duration::from_secs(240);

/// A miss this long after the last rotation's first one starts a new rotation (a new budget).
const NEW_ROTATION_AFTER: Duration = Duration::from_secs(600);

/// SDKs this process keeps unbanning at once (a long-running process reconnects rarely; older
/// entries are dropped).
const MAX_REGISTERED: usize = 8;

/// What a quorum wait needs of this process's SDKs: their address lists (a clone shares the
/// SDK's own state) and their context providers (which fetch from the quorum service).
struct Registered {
    lists: Vec<AddressList>,
    providers: Vec<TrustedHttpContextProvider>,
}

static REGISTERED: OnceLock<Mutex<Registered>> = OnceLock::new();

/// When the current rotation's first miss was seen.
static ROTATION: Mutex<Option<Instant>> = Mutex::new(None);

fn registered() -> std::sync::MutexGuard<'static, Registered> {
    REGISTERED
        .get_or_init(|| {
            Mutex::new(Registered {
                lists: Vec::new(),
                providers: Vec::new(),
            })
        })
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// Remember an SDK's address list and context provider for the quorum waits.
pub(super) fn register(list: &AddressList, provider: &TrustedHttpContextProvider) {
    let mut r = registered();
    r.lists.push(list.clone());
    r.providers.push(provider.clone());
    let excess = r.lists.len().saturating_sub(MAX_REGISTERED);
    r.lists.drain(..excess);
    let excess = r.providers.len().saturating_sub(MAX_REGISTERED);
    r.providers.drain(..excess);
}

/// A ban the SDK gave a node over a proof it could not verify for want of a quorum's key.
fn is_quorum_ban(reason: Option<&str>) -> bool {
    reason.is_some_and(|r| r.to_ascii_lowercase().contains("quorum"))
}

/// Whether some node of `lists` is banned right now over a quorum.
fn quorum_bans_in(lists: &[AddressList]) -> bool {
    lists.iter().any(|list| {
        list.ban_info()
            .iter()
            .any(|i| i.banned && is_quorum_ban(i.reason.as_deref()))
    })
}

/// Clear the bans the SDK gave this process's nodes over a quorum: the proofs they sent failed
/// for want of the quorum's key, not through any fault of theirs. A rate-limit ban stands.
fn unban_quorum_bans() {
    unban_quorum_bans_in(&registered().lists);
}

/// [`unban_quorum_bans`] over `lists`.
fn unban_quorum_bans_in(lists: &[AddressList]) {
    for list in lists {
        for info in list.ban_info() {
            if info.ban_count > 0 && is_quorum_ban(info.reason.as_deref()) {
                if let Ok(address) = info.uri.parse() {
                    list.unban(&address);
                }
            }
        }
    }
}

/// Whether `e` is a proof the context provider could not verify for want of the quorum's key
/// (a rotation its quorum service has not caught up with): directly, inside a proof error, as
/// the last failure before the SDK ran out of unbanned nodes, or a bare "no available
/// addresses" while nodes are banned over a quorum (a broadcast, or a read that started after
/// the bans).
pub(super) fn is_quorum_miss(e: &dash_sdk::Error) -> bool {
    is_quorum_miss_given(e, &|| quorum_bans_in(&registered().lists))
}

/// [`is_quorum_miss`], with `bans_present` saying whether nodes are banned over a quorum.
fn is_quorum_miss_given(e: &dash_sdk::Error, bans_present: &dyn Fn() -> bool) -> bool {
    match e {
        dash_sdk::Error::ContextProviderError(c) => is_quorum_context_error(c),
        dash_sdk::Error::Proof(drive_proof_verifier::Error::ContextProviderError(c)) => {
            is_quorum_context_error(c)
        }
        dash_sdk::Error::NoAvailableAddressesToRetry(inner) => {
            is_quorum_miss_given(inner, bans_present) || bans_present()
        }
        dash_sdk::Error::DapiClientError(
            DapiClientError::NoAvailableAddresses | DapiClientError::NoAvailableAddressesToRetry(_),
        ) => bans_present(),
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

/// The pause before a loop's quorum retry `n` (0-based), paced by `waits`, cut to what is left
/// of the rotation's budget. `None` past the loop's pacing or the budget, whose start
/// `rotation` is set at the first miss (or when the last one is [`NEW_ROTATION_AFTER`] old).
fn pause_within(
    rotation: &mut Option<Instant>,
    now: Instant,
    waits: &[Duration],
    n: usize,
) -> Option<Duration> {
    let pause = *waits.get(n)?;
    let start = match *rotation {
        Some(start) if now.duration_since(start) < NEW_ROTATION_AFTER => start,
        _ => *rotation.insert(now),
    };
    let left = QUORUM_BUDGET.saturating_sub(now.duration_since(start));
    (!left.is_zero()).then(|| pause.min(left))
}

/// Wait out a quorum miss before a loop's retry `n` (0-based), paced by `waits`: say so,
/// unban the nodes banned over a quorum, wait, refresh the providers' quorum caches, and unban
/// again (other requests in flight meanwhile banned them anew). `false` when the loop should
/// not wait: past its pacing or the rotation's budget, or, at a rotation's first wait, when the
/// quorum service does not answer at all (no lag: a wait would not help).
pub(super) async fn wait_for_quorum(label: &str, waits: &[Duration], n: usize) -> bool {
    let now = Instant::now();
    let (pause, waited) = {
        let mut rotation = ROTATION.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(pause) = pause_within(&mut rotation, now, waits, n) else {
            return false;
        };
        (
            pause,
            rotation.map_or(Duration::ZERO, |s| now.duration_since(s)),
        )
    };
    let providers = registered().providers.clone();
    if waited.is_zero() {
        for p in &providers {
            if let Err(e) = p.fetch_current_quorums().await {
                eprintln!(
                    "dash: a proof names a quorum this client cannot find, and the quorum \
                     service does not answer ({e}); not waiting for it"
                );
                return false;
            }
        }
    }
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
    unban_quorum_bans();
    tokio::time::sleep(pause).await;
    for p in &providers {
        // Best effort: a proof that still misses refetches on its own.
        let _ = p.refresh_quorum_caches().await;
    }
    unban_quorum_bans();
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(c: ContextProviderError) -> dash_sdk::Error {
        dash_sdk::Error::Proof(drive_proof_verifier::Error::ContextProviderError(c))
    }

    fn refetch_failed() -> dash_sdk::Error {
        provider(ContextProviderError::Generic(
            "Failed to find quorum: Quorum not found for type 107 and hash 1e852f2a".into(),
        ))
    }

    #[test]
    fn a_missing_quorum_is_recognised_in_every_wrapper() {
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
        assert!(!is_quorum_miss(&dash_sdk::Error::Generic("quorum".into())));
    }

    /// A list of its own (the process-wide one is unbanned by the write-loop tests running
    /// alongside).
    #[test]
    fn quorum_bans_are_recognised_and_only_they_are_cleared() {
        let mut list = AddressList::new();
        let a: dash_sdk::dapi_client::Address = "https://127.0.0.1:1443".parse().unwrap();
        let b: dash_sdk::dapi_client::Address = "https://127.0.0.2:1443".parse().unwrap();
        list.add(a.clone());
        list.add(b.clone());
        let lists = [list.clone()];
        let bans = || quorum_bans_in(&lists);
        let bare = dash_sdk::Error::DapiClientError(DapiClientError::NoAvailableAddresses);
        let gave_up = dash_sdk::Error::NoAvailableAddressesToRetry(Box::new(
            dash_sdk::Error::Generic("down".into()),
        ));
        // Banned for a rate limit: not a quorum, and the ban stands.
        list.ban_for(&b, Duration::from_secs(60), Some("rate limited".into()));
        assert!(!is_quorum_miss_given(&bare, &bans));
        assert!(!is_quorum_miss_given(&gave_up, &bans));
        // Banned over a quorum: a broadcast's bare "no available addresses" is a quorum miss.
        list.ban_with_reason(&a, Some(refetch_failed().to_string()));
        assert!(list.get_live_address().is_none());
        assert!(is_quorum_miss_given(&bare, &bans));
        assert!(is_quorum_miss_given(&gave_up, &bans));
        unban_quorum_bans_in(&lists);
        assert_eq!(list.get_live_addresses(), vec![a]);
        assert!(!is_quorum_miss_given(&bare, &bans));
    }

    #[test]
    fn the_waits_share_one_budget_from_the_rotations_first_miss() {
        let t0 = Instant::now();
        let mut rotation = None;
        let at = |s: u64| t0 + Duration::from_secs(s);
        assert_eq!(
            pause_within(&mut rotation, t0, &QUORUM_WAITS, 0),
            Some(Duration::from_secs(15))
        );
        assert_eq!(rotation, Some(t0));
        // Another loop's first wait, 200 s into the rotation: its pacing, then what is left.
        assert_eq!(
            pause_within(&mut rotation, at(200), &QUORUM_WAITS, 0),
            Some(Duration::from_secs(15))
        );
        assert_eq!(
            pause_within(&mut rotation, at(200), &QUORUM_WAITS, 2),
            Some(Duration::from_secs(40))
        );
        // Spent: no wait, even for a loop that has not waited yet.
        assert_eq!(pause_within(&mut rotation, at(240), &QUORUM_WAITS, 0), None);
        // Past its own pacing.
        assert_eq!(pause_within(&mut None, t0, &QUORUM_WAITS, 5), None);
        // Ten minutes on, a miss is a new rotation with a new budget.
        assert_eq!(
            pause_within(&mut rotation, at(700), &QUORUM_WAITS, 0),
            Some(Duration::from_secs(15))
        );
        assert_eq!(rotation, Some(at(700)));
        let total: Duration = QUORUM_WAITS.iter().sum();
        assert!(total + Duration::from_secs(20) >= QUORUM_BUDGET);
    }
}
