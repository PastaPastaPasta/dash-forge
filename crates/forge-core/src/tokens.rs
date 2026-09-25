//! [`TokenService`] — the collaborator list of a **forge-v1** repository, read only.
//!
//! A v1 repo's two tokens were its access-control list: position **0 = WRITE** (push,
//! upload), position **1 = MAINTAIN** (protected refs, releases, config). v1 is read only
//! now, so this module only reads: [`TokenService::list_collaborators`] /
//! [`TokenService::holdings`] (balances + frozen status) and
//! [`TokenService::token_history`] (mint/freeze/unfreeze/destroy records with consensus
//! `$createdAt`, fed to [`crate::rules::holdings_as_of`] for as-of-time event authorization
//! when folding a v1 repo's issues and PRs).
//!
//! forge-v2 membership is documents: see [`crate::members`].

use std::collections::BTreeSet;

use crate::error::Result;
use crate::platform::{self, FieldValue, PlatformClient, QueryFilter, QueryOrder};
use crate::rules::{TokenKind, TokenOp, TokenRecord};

/// WRITE token position (push / upload / CI).
pub const WRITE_POSITION: u16 = 0;
/// MAINTAIN token position (protected refs / releases / labels / config).
pub const MAINTAIN_POSITION: u16 = 1;

/// The system **TokenHistory** contract holding the `mint` / `freeze` /
/// `unfreeze` / `destroyFrozenFunds` audit documents with consensus `$createdAt`
/// (S0.7 experiment 7). A Platform system contract: its id is fixed by rs-dpp
/// (`token_history_contract::ID_BYTES`) and identical on every network, so it is not a
/// per-network deployment value.
pub const TOKEN_HISTORY_CONTRACT_ID: &str = "43gujrzZgXqcKBiScLa4T8XTDnRhenR9BLx8GWVHjPxF";

// TokenHistory document types.
const TH_MINT: &str = "mint";
const TH_FREEZE: &str = "freeze";
const TH_UNFREEZE: &str = "unfreeze";
const TH_DESTROY: &str = "destroyFrozenFunds";

/// A collaborator role, mapped to its token position.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// WRITE (position 0).
    Write,
    /// MAINTAIN (position 1).
    Maintain,
}

impl Role {
    /// The token position this role grants.
    pub fn position(self) -> u16 {
        match self {
            Role::Write => WRITE_POSITION,
            Role::Maintain => MAINTAIN_POSITION,
        }
    }

    /// The [`crate::rules::TokenKind`] this role corresponds to.
    fn kind(self) -> TokenKind {
        match self {
            Role::Write => TokenKind::Write,
            Role::Maintain => TokenKind::Maintain,
        }
    }
}

/// An identity's **current** spendable holdings (from live balance + frozen queries).
///
/// Two token axes (WRITE / MAINTAIN) each with a held + frozen flag — four booleans that
/// model distinct on-chain facts, not a state enum.
#[allow(clippy::struct_excessive_bools)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HoldingStatus {
    /// Holds a WRITE balance.
    pub write: bool,
    /// The WRITE balance is frozen (suspended).
    pub write_frozen: bool,
    /// Holds a MAINTAIN balance.
    pub maintain: bool,
    /// The MAINTAIN balance is frozen (suspended).
    pub maintain_frozen: bool,
}

impl HoldingStatus {
    /// Whether the identity holds either token (a collaborator at all).
    pub fn is_collaborator(self) -> bool {
        self.write || self.maintain
    }
}

/// One on-chain collaborator: an identity and the tokens it currently holds.
#[derive(Debug, Clone)]
pub struct Collaborator {
    /// The collaborator's base58 identity id.
    pub identity_id: String,
    /// Which tokens it holds, and whether they are frozen.
    pub holdings: HoldingStatus,
}

/// Read access to a v1 repository's token ACL.
pub struct TokenService<'a> {
    client: &'a PlatformClient,
}

impl<'a> TokenService<'a> {
    /// A reader over `client`.
    pub fn new(client: &'a PlatformClient) -> Self {
        Self { client }
    }

    /// The **on-chain collaborator list**: every identity that currently holds either
    /// token, with its frozen status. Candidate identities are discovered from the token
    /// mint history (no all-holders query exists on Platform); the repo owner (auto-credited
    /// via `baseSupply`) is always included. Only positive balances are returned.
    pub async fn list_collaborators(&self, repo_contract_id: &str) -> Result<Vec<Collaborator>> {
        let contract = self.client.fetch_contract(repo_contract_id).await?;
        let write_token = self.client.token_id(&contract, WRITE_POSITION);
        let maintain_token = self.client.token_id(&contract, MAINTAIN_POSITION);

        // Candidates: everyone ever minted to (from history) + the owner (baseSupply).
        let history = self.token_history(repo_contract_id).await?;
        let mut candidates: BTreeSet<String> = history.into_iter().map(|r| r.identity).collect();
        candidates.insert(contract.owner_id());
        let candidates: Vec<String> = candidates.into_iter().collect();

        let write_bal = self
            .client
            .token_balances(&write_token, &candidates)
            .await?;
        let maintain_bal = self
            .client
            .token_balances(&maintain_token, &candidates)
            .await?;
        let write_frozen = self.client.token_frozen(&write_token, &candidates).await?;
        let maintain_frozen = self
            .client
            .token_frozen(&maintain_token, &candidates)
            .await?;

        let mut out = Vec::new();
        for id in candidates {
            let holdings = HoldingStatus {
                write: write_bal.get(&id).copied().unwrap_or(0) > 0,
                write_frozen: write_frozen.get(&id).copied().unwrap_or(false),
                maintain: maintain_bal.get(&id).copied().unwrap_or(0) > 0,
                maintain_frozen: maintain_frozen.get(&id).copied().unwrap_or(false),
            };
            if holdings.is_collaborator() {
                out.push(Collaborator {
                    identity_id: id,
                    holdings,
                });
            }
        }
        Ok(out)
    }

    /// The current [`HoldingStatus`] of one identity (both tokens + frozen state).
    pub async fn holdings(&self, repo_contract_id: &str, member_id: &str) -> Result<HoldingStatus> {
        let contract = self.client.fetch_contract(repo_contract_id).await?;
        let write_token = self.client.token_id(&contract, WRITE_POSITION);
        let maintain_token = self.client.token_id(&contract, MAINTAIN_POSITION);
        let member = [member_id.to_string()];

        let write_bal = self.client.token_balances(&write_token, &member).await?;
        let maintain_bal = self.client.token_balances(&maintain_token, &member).await?;
        let write_frozen = self.client.token_frozen(&write_token, &member).await?;
        let maintain_frozen = self.client.token_frozen(&maintain_token, &member).await?;

        Ok(HoldingStatus {
            write: write_bal.get(member_id).copied().unwrap_or(0) > 0,
            write_frozen: write_frozen.get(member_id).copied().unwrap_or(false),
            maintain: maintain_bal.get(member_id).copied().unwrap_or(0) > 0,
            maintain_frozen: maintain_frozen.get(member_id).copied().unwrap_or(false),
        })
    }

    /// The repo's full token history as [`crate::rules::TokenRecord`]s (both tokens),
    /// ready to feed [`crate::rules::holdings_as_of`] / [`crate::rules::AuthzResolver`] for
    /// as-of-time event authorization (§4). Mints are enumerated by token; freeze /
    /// unfreeze / destroy records are then fetched per affected identity (the byte index
    /// on the TokenHistory contract is keyed by `frozenIdentityId`).
    pub async fn token_history(&self, repo_contract_id: &str) -> Result<Vec<TokenRecord>> {
        let repo_contract = self.client.fetch_contract(repo_contract_id).await?;
        let history_contract = self
            .client
            .fetch_contract(TOKEN_HISTORY_CONTRACT_ID)
            .await?;

        let mut records = Vec::new();

        // The repo owner is auto-credited both tokens' `baseSupply` at contract creation,
        // which does NOT emit a `mint` history document — so token-history reconstruction
        // alone would (wrongly) treat the owner as a non-holder and invalidate its
        // legitimate past actions. Synthesize an as-of-genesis (`created_at = 0`) mint for
        // the owner on both tokens so [`crate::rules::holdings_as_of`] sees it as a holder
        // from the start (data-contracts §2.1 reconciliation).
        let owner = repo_contract.owner_id();
        for role in [Role::Write, Role::Maintain] {
            records.push(TokenRecord {
                id: format!("baseSupply:{}:{}", owner, role.position()),
                identity: owner.clone(),
                token: role.kind(),
                op: TokenOp::Mint,
                created_at: 0,
            });
        }

        for role in [Role::Write, Role::Maintain] {
            let token_b58 = self.client.token_id(&repo_contract, role.position());
            let token_bytes = platform::decode_identifier(&token_b58)?;
            let kind = role.kind();

            // Mints (byDate index: tokenId, $createdAt). Paginated to exhaustion — a repo
            // with >100 grants would otherwise drop late collaborators from BOTH the
            // collaborator list AND the AuthzResolver (their legitimate events would then
            // fold as unauthorized).
            let mints = self
                .client
                .query_all_documents(
                    &history_contract,
                    TH_MINT,
                    &[QueryFilter::eq("tokenId", FieldValue::bytes32(token_bytes))],
                    &[QueryOrder::asc("$createdAt")],
                )
                .await?;

            // Always include the repo owner: they hold `baseSupply` (no mint doc) but CAN
            // be frozen/destroyed under the org joint-ownership pattern, and that freeze
            // history must be reconstructed or the owner reads as perpetually unfrozen.
            let mut affected: BTreeSet<String> = BTreeSet::new();
            affected.insert(owner.clone());
            for m in &mints {
                let Some(recipient) = m
                    .field_bytes32("recipientId")
                    .map(platform::encode_identifier)
                else {
                    continue;
                };
                affected.insert(recipient.clone());
                records.push(TokenRecord {
                    id: m.id.clone(),
                    identity: recipient,
                    token: kind,
                    op: TokenOp::Mint,
                    created_at: m.created_at.unwrap_or(0),
                });
            }

            // Freeze / unfreeze / destroy per affected identity (byFrozenIdentityId index).
            for identity in affected {
                let identity_bytes = platform::decode_identifier(&identity)?;
                for (doc_type, op) in [
                    (TH_FREEZE, TokenOp::Freeze),
                    (TH_UNFREEZE, TokenOp::Unfreeze),
                    (TH_DESTROY, TokenOp::Destroy),
                ] {
                    let docs = self
                        .client
                        .query_all_documents(
                            &history_contract,
                            doc_type,
                            &[
                                QueryFilter::eq("tokenId", FieldValue::bytes32(token_bytes)),
                                QueryFilter::eq(
                                    "frozenIdentityId",
                                    FieldValue::bytes32(identity_bytes),
                                ),
                            ],
                            &[QueryOrder::asc("$createdAt")],
                        )
                        .await?;
                    for d in &docs {
                        records.push(TokenRecord {
                            id: d.id.clone(),
                            identity: identity.clone(),
                            token: kind,
                            op,
                            created_at: d.created_at.unwrap_or(0),
                        });
                    }
                }
            }
        }
        Ok(records)
    }
}

#[cfg(test)]
mod tests {
    use super::{HoldingStatus, Role, MAINTAIN_POSITION, WRITE_POSITION};
    use crate::rules::TokenKind;

    #[test]
    fn role_maps_to_position_and_kind() {
        assert_eq!(Role::Write.position(), WRITE_POSITION);
        assert_eq!(Role::Maintain.position(), MAINTAIN_POSITION);
        assert_eq!(Role::Write.kind(), TokenKind::Write);
        assert_eq!(Role::Maintain.kind(), TokenKind::Maintain);
    }

    #[test]
    fn holding_status_collaborator_predicate() {
        assert!(!HoldingStatus::default().is_collaborator());
        assert!(HoldingStatus {
            write: true,
            ..Default::default()
        }
        .is_collaborator());
        assert!(HoldingStatus {
            maintain: true,
            ..Default::default()
        }
        .is_collaborator());
    }
}
