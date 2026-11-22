//! Candidate discovery (`poller.ts`). Answers live in the App Connect system contract
//! ([`super::APP_CONNECT_CONTRACT_ID`], `loginKeyResponse`), keyed by `appEphemeralPubKeyHash`
//! then `$ownerId`. Anyone can answer a request, so the app pages through every candidate and
//! verifies each one; nothing here decides who logged in.

use async_trait::async_trait;
use sha2::{Digest as _, Sha256};

use super::request::MAX_REQUEST_AGE_MS;
use super::verify::Candidate;
use super::Id;
use crate::Result;

/// Answers per page.
pub const PAGE_SIZE: u32 = 10;
/// Past this many candidates the app stops and asks the user to start again.
pub const MAX_CANDIDATES: usize = 20;
/// The poll interval for the first minute.
pub const FAST_POLL_MS: u64 = 2_000;
/// The poll interval after it.
pub const SLOW_POLL_MS: u64 = 4_000;
/// How long the fast interval lasts.
pub const FAST_POLL_WINDOW_MS: u64 = 60_000;

/// The answer reads.
#[async_trait]
pub trait ResponsePort: Send + Sync {
    /// Up to `limit` answers with `appEphemeralPubKeyHash == request_hash`, ordered by `$ownerId`
    /// ascending, after `start_after` when given, and only `$ownerId == hint` when a hint is
    /// given.
    async fn list_candidates(
        &self,
        request_hash: &[u8; 20],
        hint: Option<&Id>,
        start_after: Option<&Id>,
        limit: u32,
    ) -> Result<Vec<Candidate>>;
}

/// Every answer to a request, as far as the poller reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandidatePage {
    /// The answers, in `$ownerId` order.
    pub candidates: Vec<Candidate>,
    /// More than the maximum exist (spam): the caller should abandon the request.
    pub truncated: bool,
}

/// Page through every answer to a request; `page_size` and `max_candidates` are
/// [`PAGE_SIZE`] and [`MAX_CANDIDATES`] outside tests.
pub async fn list_candidates(
    port: &dyn ResponsePort,
    request_hash: &[u8; 20],
    hint: Option<&Id>,
    page_size: u32,
    max_candidates: usize,
) -> Result<CandidatePage> {
    let page_size = page_size.max(1);
    let mut candidates = Vec::new();
    let mut start_after: Option<Id> = None;
    let truncated = 'read: loop {
        let page = port
            .list_candidates(request_hash, hint, start_after.as_ref(), page_size)
            .await?;
        let full = page.len() >= usize::try_from(page_size).unwrap_or(usize::MAX);
        for candidate in page {
            // Defend against a port that ignores the cursor or the hint: anything not strictly
            // after the cursor would loop, anything else is not ours to see.
            if start_after.is_some_and(|after| candidate.owner_id <= after) {
                break 'read false;
            }
            start_after = Some(candidate.owner_id);
            if hint.is_some_and(|h| *h != candidate.owner_id) {
                continue;
            }
            if candidates.len() == max_candidates {
                break 'read true;
            }
            candidates.push(candidate);
        }
        if !full {
            break false;
        }
    };
    Ok(CandidatePage {
        candidates,
        truncated,
    })
}

/// The delay before the next poll: every 2 s for the first minute, then every 4 s, and `None`
/// once the request has expired (10 minutes).
pub fn poll_delay_ms(elapsed_ms: u64) -> Option<u64> {
    if elapsed_ms >= MAX_REQUEST_AGE_MS {
        None
    } else if elapsed_ms < FAST_POLL_WINDOW_MS {
        Some(FAST_POLL_MS)
    } else {
        Some(SLOW_POLL_MS)
    }
}

/// A candidate's exact contents, so a poll loop verifies each answer once and notices when an
/// identity republishes a different one.
pub fn candidate_key(candidate: &Candidate) -> (Id, [u8; 32]) {
    let mut h = Sha256::new();
    h.update(&candidate.wallet_ephemeral_pub_key);
    h.update(&candidate.encrypted_payload);
    (candidate.owner_id, h.finalize().into())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Ids with distinct leading bytes, so byte order is obvious.
    fn ids() -> Vec<Id> {
        (0u8..13)
            .map(|n| {
                let mut id = [7u8; 32];
                id[0] = n * 16;
                id
            })
            .collect()
    }

    fn candidate(owner_id: Id) -> Candidate {
        Candidate {
            owner_id,
            wallet_ephemeral_pub_key: vec![2; 33],
            encrypted_payload: vec![0; 60],
        }
    }

    type Call = (Option<Id>, Option<Id>, u32);

    /// A port over `owners` that honours the cursor, the hint and the limit like Platform does.
    struct Owners {
        owners: Vec<Id>,
        calls: Mutex<Vec<Call>>,
    }

    impl Owners {
        fn new(owners: &[Id]) -> Self {
            Self {
                owners: owners.to_vec(),
                calls: Mutex::new(vec![]),
            }
        }
    }

    #[async_trait]
    impl ResponsePort for Owners {
        async fn list_candidates(
            &self,
            _: &[u8; 20],
            hint: Option<&Id>,
            start_after: Option<&Id>,
            limit: u32,
        ) -> Result<Vec<Candidate>> {
            self.calls
                .lock()
                .unwrap()
                .push((hint.copied(), start_after.copied(), limit));
            let after =
                start_after.map_or(0, |a| self.owners.iter().position(|o| o == a).unwrap() + 1);
            Ok(self.owners[after..]
                .iter()
                .filter(|o| hint.is_none_or(|h| h == *o))
                .take(limit as usize)
                .copied()
                .map(candidate)
                .collect())
        }
    }

    /// A port that returns the same page whatever it is asked.
    struct Fixed(Vec<Id>, Mutex<usize>);

    #[async_trait]
    impl ResponsePort for Fixed {
        async fn list_candidates(
            &self,
            _: &[u8; 20],
            _: Option<&Id>,
            _: Option<&Id>,
            _: u32,
        ) -> Result<Vec<Candidate>> {
            *self.1.lock().unwrap() += 1;
            Ok(self.0.iter().copied().map(candidate).collect())
        }
    }

    fn owners(page: &CandidatePage) -> Vec<Id> {
        page.candidates.iter().map(|c| c.owner_id).collect()
    }

    #[tokio::test]
    async fn pages_with_the_last_owner_as_cursor_until_a_short_page() {
        let ids = ids();
        let p = Owners::new(&ids[..7]);
        let page = list_candidates(&p, &[0; 20], None, 3, MAX_CANDIDATES)
            .await
            .unwrap();
        assert_eq!(owners(&page), ids[..7]);
        assert!(!page.truncated);
        assert_eq!(
            *p.calls.lock().unwrap(),
            [
                (None, None, 3),
                (None, Some(ids[2]), 3),
                (None, Some(ids[5]), 3)
            ]
        );
    }

    #[tokio::test]
    async fn stops_at_max_candidates_and_reports_truncation() {
        let page = list_candidates(&Owners::new(&ids()), &[0; 20], None, 5, 8)
            .await
            .unwrap();
        assert_eq!(page.candidates.len(), 8);
        assert!(page.truncated);
    }

    #[tokio::test]
    async fn passes_the_hint_and_drops_anything_else_a_port_returns() {
        let ids = ids();
        let sloppy = Fixed(vec![ids[1], ids[2]], Mutex::new(0));
        let page = list_candidates(&sloppy, &[0; 20], Some(&ids[2]), PAGE_SIZE, MAX_CANDIDATES)
            .await
            .unwrap();
        assert_eq!(owners(&page), [ids[2]]);
        let p = Owners::new(&ids);
        list_candidates(&p, &[0; 20], Some(&ids[4]), PAGE_SIZE, MAX_CANDIDATES)
            .await
            .unwrap();
        assert_eq!(p.calls.lock().unwrap()[0].0, Some(ids[4]));
    }

    #[tokio::test]
    async fn stops_when_a_port_ignores_the_cursor_instead_of_looping() {
        let ids = ids();
        let stuck = Fixed(vec![ids[0], ids[1]], Mutex::new(0));
        let page = list_candidates(&stuck, &[0; 20], None, 2, MAX_CANDIDATES)
            .await
            .unwrap();
        assert_eq!(owners(&page), [ids[0], ids[1]]);
        assert_eq!(*stuck.1.lock().unwrap(), 2);
    }

    #[tokio::test]
    async fn orders_the_cursor_by_bytes() {
        let ids = ids();
        let page = list_candidates(&Owners::new(&ids[..4]), &[0; 20], None, 1, MAX_CANDIDATES)
            .await
            .unwrap();
        assert_eq!(owners(&page), ids[..4]);
    }

    #[test]
    fn polls_every_2s_for_a_minute_then_every_4s_and_stops_at_10_minutes() {
        assert_eq!(poll_delay_ms(0), Some(2000));
        assert_eq!(poll_delay_ms(59_999), Some(2000));
        assert_eq!(poll_delay_ms(60_000), Some(4000));
        assert_eq!(poll_delay_ms(10 * 60_000 - 1), Some(4000));
        assert_eq!(poll_delay_ms(10 * 60_000), None);
    }

    #[test]
    fn the_candidate_key_changes_when_an_answer_is_republished() {
        let ids = ids();
        let a = candidate(ids[1]);
        let mut b = a.clone();
        b.encrypted_payload[0] = 1;
        assert_eq!(candidate_key(&a), candidate_key(&candidate(ids[1])));
        assert_ne!(candidate_key(&a), candidate_key(&b));
        assert_eq!(candidate_key(&a).0, ids[1]);
    }
}
