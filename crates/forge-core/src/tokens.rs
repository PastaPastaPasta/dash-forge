//! [`TokenService`] — the on-chain collaborator ACL over a repo contract's tokens.
//!
//! A repo's two tokens **are** its access-control list (data-contracts §2.1):
//!
//! * position **0 = WRITE** — push / upload / CI (gates every `refUpdate` / `chunk` /
//!   `packManifest` create + refund-delete).
//! * position **1 = MAINTAIN** — protected refs / releases / labels / webhooks / config.
//!
//! Collaborator management is therefore token administration, not document writes:
//!
//! * [`TokenService::grant`] — **mint** `10⁹` of the token to a member (they can now
//!   spend the gated actions).
//! * [`TokenService::suspend`] — **freeze** the member's balance (kept, but unspendable →
//!   every gated create *and* delete fails at consensus, S0.7).
//! * [`TokenService::revoke`] — **freeze + destroyFrozenFunds** (balance zeroed, removed
//!   from the collaborator set).
//! * [`TokenService::list_collaborators`] / [`TokenService::holdings`] — read the balances
//!   (with frozen status) back: the balances are the ACL.
//! * [`TokenService::token_history`] — the mint/freeze/unfreeze/destroy records with
//!   consensus `$createdAt`, fed to [`crate::rules::holdings_as_of`] for as-of-time event
//!   authorization (§4).
//!
//! Every mutating op signs with the owner's **CRITICAL** key (S0.7: HIGH is rejected for
//! token admin) and — because of the keepsHistory `mint()` return-value bug (S0.7) —
//! **verifies success via a balance/frozen query afterwards, never the return value**.
//! All SDK contact goes through [`crate::platform`]; this module names no rs-sdk type.

use std::collections::BTreeSet;

use crate::error::{Error, Result};
use crate::keystore::BridgeIdentity;
use crate::platform::{self, FieldValue, LoadedIdentity, PlatformClient, QueryFilter, QueryOrder};
use crate::rules::{TokenKind, TokenOp, TokenRecord};

/// WRITE token position (push / upload / CI).
pub const WRITE_POSITION: u16 = 0;
/// MAINTAIN token position (protected refs / releases / labels / config).
pub const MAINTAIN_POSITION: u16 = 1;

/// The amount minted per grant (`10⁹`), matching the `baseSupply` the owner is
/// auto-credited (data-contracts §2.1) — plenty for a collaborator's per-action
/// `tokenCost` spends over the repo's lifetime.
pub const GRANT_AMOUNT: u64 = 1_000_000_000;

/// The system **TokenHistory** contract (testnet) holding the `mint` / `freeze` /
/// `unfreeze` / `destroyFrozenFunds` audit documents with consensus `$createdAt`
/// (S0.7 experiment 7).
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

/// The token-administration service, bound to the repo **owner** identity (the token
/// authority for a solo-owner repo) and its keys.
pub struct TokenService<'a> {
    client: &'a PlatformClient,
    identity: &'a LoadedIdentity,
    bridge: &'a BridgeIdentity,
}

impl<'a> TokenService<'a> {
    /// Bind the service to `client`, the owner `identity`, and its `bridge` key material
    /// (the CRITICAL key is required for every mint/freeze/destroy).
    pub fn new(
        client: &'a PlatformClient,
        identity: &'a LoadedIdentity,
        bridge: &'a BridgeIdentity,
    ) -> Self {
        Self {
            client,
            identity,
            bridge,
        }
    }

    /// The base58 token id for `position` (0 = WRITE, 1 = MAINTAIN) of a repo contract.
    pub async fn token_id(&self, repo_contract_id: &str, position: u16) -> Result<String> {
        let contract = self.client.fetch_contract(repo_contract_id).await?;
        Ok(self.client.token_id(&contract, position))
    }

    /// **Grant** `role` to `member_id` (base58): mint `10⁹` of the role's token to it.
    /// Idempotent — if the member already holds a positive balance, the mint is skipped
    /// (no double-mint on retry). Verified via a balance query (S0.7 mint-return bug).
    pub async fn grant(&self, repo_contract_id: &str, member_id: &str, role: Role) -> Result<()> {
        let contract = self.client.fetch_contract(repo_contract_id).await?;
        let token = self.client.token_id(&contract, role.position());

        if self.balance_of(&token, member_id).await? > 0 {
            // Already a holder → skip the mint (no double-mint on retry). If the member is
            // *frozen*, grant is the wrong tool — the balance is present but suspended, and
            // minting more would not restore access; direct the caller to `unsuspend`.
            let frozen = self.frozen_of(&token, member_id).await?;
            if frozen {
                tracing::warn!(
                    member = member_id,
                    role = ?role,
                    "member already holds the token but is FROZEN; skipping mint — use \
                     `unsuspend` to restore a frozen member, not `grant`"
                );
            } else {
                tracing::warn!(
                    member = member_id,
                    role = ?role,
                    "member already holds the token; skipping mint (idempotent)"
                );
            }
            return Ok(());
        }

        let key = self.bridge.token_admin_key()?;
        self.client
            .token_mint(
                &contract,
                self.identity,
                key,
                role.position(),
                GRANT_AMOUNT,
                member_id,
            )
            .await?;

        // Verify via query — the keepsHistory mint() return value is not trusted.
        if self.balance_of(&token, member_id).await? == 0 {
            return Err(Error::Platform(
                "grant broadcast but the member's balance did not increase".into(),
            ));
        }
        Ok(())
    }

    /// **Suspend** `role` for `member_id`: freeze its balance. Verified via a frozen-status
    /// query.
    pub async fn suspend(&self, repo_contract_id: &str, member_id: &str, role: Role) -> Result<()> {
        let contract = self.client.fetch_contract(repo_contract_id).await?;
        let token = self.client.token_id(&contract, role.position());
        let key = self.bridge.token_admin_key()?;

        self.client
            .token_freeze(&contract, self.identity, key, role.position(), member_id)
            .await?;

        if !self.frozen_of(&token, member_id).await? {
            return Err(Error::Platform(
                "suspend broadcast but the member's token is not frozen".into(),
            ));
        }
        Ok(())
    }

    /// **Unsuspend** `role` for `member_id`: lift a freeze so the member can spend again
    /// (the inverse of [`TokenService::suspend`]). Verified via a frozen-status query.
    pub async fn unsuspend(
        &self,
        repo_contract_id: &str,
        member_id: &str,
        role: Role,
    ) -> Result<()> {
        let contract = self.client.fetch_contract(repo_contract_id).await?;
        let token = self.client.token_id(&contract, role.position());
        let key = self.bridge.token_admin_key()?;

        self.client
            .token_unfreeze(&contract, self.identity, key, role.position(), member_id)
            .await?;

        if self.frozen_of(&token, member_id).await? {
            return Err(Error::Platform(
                "unsuspend broadcast but the member's token is still frozen".into(),
            ));
        }
        Ok(())
    }

    /// **Revoke** `role` from `member_id`: freeze (if not already) then destroy the frozen
    /// balance. Verified by a zero-balance query.
    pub async fn revoke(&self, repo_contract_id: &str, member_id: &str, role: Role) -> Result<()> {
        let contract = self.client.fetch_contract(repo_contract_id).await?;
        let token = self.client.token_id(&contract, role.position());
        let key = self.bridge.token_admin_key()?;

        // destroyFrozenFunds requires the balance to be frozen first.
        if !self.frozen_of(&token, member_id).await? {
            self.client
                .token_freeze(&contract, self.identity, key, role.position(), member_id)
                .await?;
        }
        self.client
            .token_destroy_frozen(&contract, self.identity, key, role.position(), member_id)
            .await?;

        if self.balance_of(&token, member_id).await? != 0 {
            return Err(Error::Platform(
                "revoke broadcast but the member's balance is not zero".into(),
            ));
        }
        Ok(())
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
        candidates.insert(self.identity.id());
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
                    .field_bytes("recipientId")
                    .and_then(|b| <[u8; 32]>::try_from(b).ok())
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

    // --- internal query helpers ---

    async fn balance_of(&self, token_id_b58: &str, identity: &str) -> Result<u64> {
        let bal = self
            .client
            .token_balances(token_id_b58, &[identity.to_string()])
            .await?;
        Ok(bal.get(identity).copied().unwrap_or(0))
    }

    async fn frozen_of(&self, token_id_b58: &str, identity: &str) -> Result<bool> {
        let frozen = self
            .client
            .token_frozen(token_id_b58, &[identity.to_string()])
            .await?;
        Ok(frozen.get(identity).copied().unwrap_or(false))
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
