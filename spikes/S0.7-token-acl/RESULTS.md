# S0.7 — Token-Cost ACL @ Consensus — RESULTS

**Goal:** prove, at real testnet consensus (not client-side), the token-cost ACL that Dash Forge's
authorization model rests on: (1) a `tokenCost` document type forces the actor to spend a token to
create it; (2) **freezing** an identity's token balance blocks that identity from **creating AND
deleting** such documents *at consensus*; (3) tokens can be minted (grant) / frozen (suspend) /
destroyed-frozen (revoke) by the authority; (4) `baseSupply` credits the owner at contract creation;
(5) past holdings are reconstructable from the TokenHistory system contract (for as-of-time
event-fold authorization).

**Network:** Dash Platform **testnet**, protocol/platform **version 12**, `@dashevo/evo-sdk`
(wasm-sdk), `EvoSDK.testnetTrusted`. Every result below is a **real DAPI `broadcastAndWait`
accept/reject** — the whole point of the spike is consensus enforcement, so no result is simulated.

## Deployed artifacts (live on testnet)

| Thing | Value |
|---|---|
| Token contract id | `JAmSJJZgW3qesagg1T9GZtUYZ3h2YaX3oLRwvWrVx6m5` |
| WRITE token id (pos 0) | `6S3HidF4DJQhRxMXwFB6aCt5n6jH8GoQZzSgkLbZfmuE` |
| Owner / mint-freeze-destroy authority | DEPLOYER `8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB` |
| Collaborator (granted → frozen → revoked) | COLLAB `CmGHMP2VqWZng8gtF7Nr9pPXKzmFoKpJQs4mYrCHkyVw` |
| No-token actor | CONTRIB `6acfxhgD2c8siYVmJrHgzTE3HF5DcyU3599T4r1vPTr1` |
| TokenHistory system contract (queried) | `43gujrzZgXqcKBiScLa4T8XTDnRhenR9BLx8GWVHjPxF` |

**Contract shape (minimal, per task):** one token at position 0 (`write`/`writes`, WRITE), `baseSupply
1_000_000_000`, `maxSupply: null`, all control rules (mint/burn/**freeze**/unfreeze/**destroyFrozenFunds**/
emergency/conventions/distribution) routed to **`ContractOwner`** (no control group;
`mintingAllowChoosingDestination: true`), full `keepsHistory: true`. One document type `refUpdate`
with `tokenCost.create = {tokenPosition:0, amount:1}` **and** `tokenCost.delete = {tokenPosition:0,
amount:1}`, made **deletable** so the freeze-blocks-delete case is exercisable (in the production
template `refUpdate` is non-deletable; the delete-gating validated here is the `packManifest`/`chunk`
delete-gating pattern of data-contracts.md §2.2). Token config reused verbatim from the S0.6
validated template except authority = ContractOwner instead of MainGroup.

Scripts: `01-register.mjs` … `07-token-history.mjs`, shared `lib.mjs`, results snapshot `state.json`.

---

## Per-experiment consensus results

### 1. Register contract + `baseSupply` auto-credit — **ACCEPT**
`DataContractCreate` from DEPLOYER broadcast OK. Immediately after (no separate mint step):

```
DEPLOYER WRITE-token balance = 1000000000   (== baseSupply 10^9)
WRITE token total supply      = 1000000000
```

**baseSupply is credited to the contract owner atomically at `DataContractCreate`** — confirmed. The
"repo owner can never be locked out of their own gated types" assumption (data-contracts.md §2.1) holds.

Cost: **24,092,685,990 credits ≈ 0.2409 DASH** for this *minimal 1-token* contract (see Deviation D5 —
this is a large, design-relevant number).

### 2. Grant: DEPLOYER mints WRITE → COLLAB — **ACCEPT** (with SDK caveat D1)
`tokens.mint({recipientId: COLLAB, amount, identityKey: DEPLOYER CRITICAL})`. The mint **lands at
consensus** and credits COLLAB, but the evo-sdk call **throws on result parsing** for a history-keeping
token (Deviation D1). Verified by query, not by return value. (During bring-up the mint was retried, so
COLLAB accumulated **15** WRITE across 3 landed grants of 5 — harmless; the grant mechanism is what's
proven.) TokenHistory later shows all three mints (exp 7).

### 3. COLLAB creates a `tokenCost.create` doc — **ACCEPT**, balance decremented
`documents.create(refUpdate, tokenPaymentInfo:{tokenContractPosition:0, maximumTokenCost:1})`:

```
COLLAB WRITE balance: 15 → 14     (spent exactly 1 WRITE)
create ACCEPTED at consensus
```

Consensus **charges the acting identity 1 WRITE** to create the doc. Document id
`GKz77XKFwvLnxc2KpsBKoXpuGagSYtnrSERWfyJN6gLD`.

### 4. CONTRIB (0 tokens) attempts the same create — **REJECT at consensus**
Real DAPI error:

```
code=40700  StateTransitionBroadcastError
Identity 6acfxhgD2c8siYVmJrHgzTE3HF5DcyU3599T4r1vPTr1 does not have enough balance
for token 6S3HidF4DJQhRxMXwFB6aCt5n6jH8GoQZzSgkLbZfmuE: required 1, actual 0,
action: Document create token payment
```

Insufficient token balance ⇒ the gated create is **rejected by the network**, not by any client rule.
This is the core "existence of the doc ⇒ was authorized" guarantee, proven at consensus.

### 5. THE KEY FINDING — freeze blocks BOTH create and delete — **BOTH REJECT at consensus**
DEPLOYER `tokens.freeze(frozenIdentityId: COLLAB)` lands. Query confirms `isFrozen = true`, and COLLAB's
14 WRITE are **still present, just frozen**. Then, signing as COLLAB:

**(a) new create while frozen → REJECT**
```
code=40702  Identity CmGH…kyVw account is frozen for token 6S3H…fmuE.
Action attempted: Document create token payment
```

**(b) delete of COLLAB's own earlier doc while frozen → REJECT**
```
code=40702  Identity CmGH…kyVw account is frozen for token 6S3H…fmuE.
Action attempted: Document delete token payment
```

```
SUMMARY: frozen=true   create-blocked=true   delete-blocked=true
```

**A frozen identity can neither spend-to-create nor spend-to-delete a token-gated document.** This is
consensus-enforced (code `40702` from the network), not client-side. It directly validates:
- data-contracts.md §2.1 "a *frozen* identity cannot delete what it previously uploaded — revocation
  consensus-protects both future writes *and* past availability";
- §4 enforcement matrix "Collaborator revoke → freeze blocks all gated creates **and gated deletes**".

It also **answers the open question** carried in init-reconciliation.md ("can a frozen collaborator still
delete-for-refund their own docs? Should they?"): **empirically, no — freeze blocks token-gated deletes at
consensus.** The design's availability-protection argument stands; no design change needed on this point.

### 6. Revoke: DEPLOYER destroys COLLAB's frozen funds — **ACCEPT**, balance zeroed
`tokens.destroyFrozen(frozenIdentityId: COLLAB)` lands:

```
COLLAB WRITE balance: 14 → 0
total supply: 1000000015 → 1000000001   (14 destroyed)
```

`destroyFrozenFunds` **exists and works**, removes the frozen balance, and reduces total supply.

### 7. TokenHistory reconstruction — **CONFIRMED, with consensus timestamps**
Queried the TokenHistory system contract (`43gujrzZgXqcKBiScLa4T8XTDnRhenR9BLx8GWVHjPxF`) for our token.
byteArray where-values accepted as **base58 strings**. All admin events are recorded with both
`$createdAt` (consensus block time, ms) **and** `$createdAtBlockHeight`:

| type | count | block height(s) | amount | subject |
|---|---|---|---|---|
| `mint` | 3 | 443588, 443591, 443661 | 5 each | recipient = COLLAB |
| `freeze` | 1 | 443718 | — | frozenIdentityId = COLLAB |
| `destroyFrozenFunds` | 1 | 443723 | 14 | frozenIdentityId = COLLAB |

The chronology (grants @ ≤443661 → freeze @443718 → destroy @443723) means **holdings and frozen-status
are reconstructable as-of any block height/time**: e.g. as-of block 443700 COLLAB held 14 WRITE and was
unfrozen; as-of 443720 frozen; as-of 443725 zero. This is exactly the input the §4 rule needs —
"Actor authorization is evaluated **as-of the event's `$createdAt`**, reconstructed deterministically from
the system token-history contract (mint/freeze/destroy records)". **Confirmed viable.** (`transfer`,
`unfreeze`, `burn`, `configUpdate`, etc. are separate document types in the same contract, same index
shape — `[tokenId, …, $createdAt]` — so the same reconstruction extends to them.)

---

## Deviations / findings for the **Platform-core review** the docs call for

**D1 (SDK bug — flag upstream; does NOT affect consensus).** `tokens.mint()` on a token with
`keepsHistory`/`keepsMintingHistory: true` **throws client-side AFTER the transition is already accepted
at consensus**: `InvalidArgument: 'platformVersion' string value '' is not a valid u32`. Root cause is in
`platform/packages/wasm-sdk/src/state_transitions/token.rs` — `document_to_wasm()` (≈L155) constructs the
returned HistoricalDocument with `DocumentWasm::new(doc, contract_id, name, None)`, passing **`None`** for
the platform version, which downstream parses as `''`. The on-chain mint is correct; only the JS result
wrapper fails. **Impact on Dash Forge:** the "grant" path (mint) can't trust the SDK return value on a
history-keeping token — callers must treat a landed mint as success and confirm via balance/history query
(this spike's `tokenOp()` helper does exactly that). `freeze` and `destroyFrozenFunds` did **not** trip
the bug (their result mapping returns the IdentityInfo variant, not a document). Recommend filing against
wasm-sdk: thread the SDK platform version into `document_to_wasm`. Since the design *requires*
`keepsHistory` for as-of-time auth (exp 7), this bug is on the critical path for the relay/CLI grant flow.

**D2 (auth-key level — reconcile helper/docs).** Token admin transitions (mint/freeze/unfreeze/
destroyFrozenFunds) **require a `CRITICAL` security-level AUTHENTICATION key** — signing with `HIGH`
is rejected pre-broadcast: `Invalid public key security level HIGH. The state transition requires one of
CRITICAL`. Document create/delete (incl. the token *payment* they carry) work fine with a **`HIGH`** key.
So: grant/suspend/revoke ⇒ CRITICAL; push/delete ⇒ HIGH. The helper/relay must select keys accordingly.

**D3 (tokenCost payment destination — economics note, not a blocker).** The 1 WRITE COLLAB spent on its
create (exp 3) did **not** get burned — it **landed in the contract owner (DEPLOYER):** DEPLOYER's WRITE
balance went 1_000_000_000 → **1_000_000_001**, and total supply held steady across the create (only mint
and destroy moved supply). So **token-gated action costs recirculate to the repo owner.** Consequence for
the grant model: a collaborator's WRITE balance is *consumed* per gated action and flows back to the owner,
who can re-grant it — a fixed mint can recirculate rather than being permanently drained. economics.md
should state this explicitly (and whether `gasFeesPaidBy`/a recipient override is ever desired).

**D4 (build tooling — reconciles with S0.6).** The `DataContract` **wasm constructor** (`new DataContract(
{…, tokens})`) requires `tokens` to be **`TokenConfiguration` instances**, not plain JSON — it rejects
plain objects with `JS object constructor name mismatch. Expected TokenConfiguration`. Token-bearing
contracts must be built via **`DataContract.fromJSON(fullJson, fullValidation, 12)`** (the S0.6 path).
Contract id = `hash(ownerId, identityNonce)` and is **independent of schemas/tokens**, so deriving the id
from a schemas-only probe and rebuilding via `fromJSON` is a safe pattern (used in `01-register.mjs`).

**D5 (economics — material, flag prominently).** A **minimal one-token** contract create cost
**≈0.24 DASH** on testnet. data-contracts.md §5.1 estimates repo creation ("publish repo contract →
config → repoListing", **3 STs**) at **"< 0.02 DASH"** — off by **~12×** for the contract-create ST alone,
and the production `repo-v1` template carries **2 tokens + 15 doc types** (S0.6: 11,713 serialized bytes)
so its create will cost **more**, not less. Token configuration + contract size dominate this one-time
cost. **The <0.02 DASH repo-creation figure in economics.md / data-contracts.md §5.1 must be revised**
against a real `repo-v1` create measurement (a natural S0.6/economics follow-up). Not a correctness
blocker, but a UX/pricing one — repo creation is the first thing every user does.

**D6 (scope note — group-held authority not exercised on-chain).** Per the task's "owner as authority",
this spike routed all token control to **`ContractOwner`**, so the *design's* org-repo assumption that a
**control group** holds mint/freeze/destroy (data-contracts.md §2.1) was **not exercised at consensus
here.** It is *construction-valid* (S0.6 flag-checks validated the MainGroup config) and the SDK token ops
accept a `groupInfo` (`GroupStateTransitionInfoStatus.proposer()/otherSigner()`) for group-managed flows.
**Recommend a focused follow-up** (freeze via a 2-of-N group) before relying on group-held revocation
authority for org repos — it's the one §2.1 token claim still unproven on-chain.

## What held up (no design change needed)
- `tokenCost.create` charges the **acting** identity at consensus (exp 3); zero balance ⇒ hard reject (exp 4).
- **Freeze blocks create *and* delete at consensus** (exp 5) — the central availability-protection claim,
  and the answer to the long-standing frozen-delete open question: **frozen ⇒ cannot delete.**
- `baseSupply` auto-credits the owner at `DataContractCreate` (exp 1) — no self-mint bootstrap step.
- mint / freeze / destroyFrozenFunds all exist and work per-identity via the owner authority (exp 2/5/6).
- TokenHistory gives **timestamped, block-height-anchored, as-of-reconstructable** mint/freeze/destroy
  records (exp 7) — the event-fold authorization input is real.

## Budget
DEPLOYER 0.3287 → **0.0838 DASH** (contract create 0.241 + ~6 token ops + queries). COLLAB/CONTRIB DASH
untouched (~0.0487 each). One document persists on-chain (COLLAB's exp-3 refUpdate; now un-deletable by
COLLAB — frozen then zeroed); every other write was either rejected or is a tiny history record.
