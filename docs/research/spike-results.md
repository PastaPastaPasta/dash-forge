# Dash Forge — Spike Results (Stage 1) & Design Freeze #1

All nine Phase-0 spikes executed against live testnet / real backends. Per-spike detail lives in `spikes/S0.*/RESULTS.md`; this is the consolidated record and the input to Design Freeze #1. **Headline: GO.** Every load-bearing assumption held or was corrected without a structural redesign.

## Results at a glance

| Spike | Verdict | Key number / finding |
|---|---|---|
| S0.1 throughput | **GO** | Pipelined **~4 docs/sec** (10× serial, 0% fail, window=8) → 25 MB repo ~7 min |
| S0.2 chunk geometry | **CONFIRMED** | 3×4,900 B = 14,700 payload → 14,983 B signed ST, 27% headroom; binding cap is 5,120 B/field |
| S0.3 proof mode | **DECIDED** | Only `testnetTrusted()` works in WASM; proofs always on, ~0% per-query overhead → default proof-verified |
| S0.5 browse plane | **CONFIRMED + corrections** | O(blob) ranged reads work; IPFS gateway honors Range; locator field widths + cold-load path need fixes |
| S0.6 contracts | **PASS** | Both contracts validate; single repo template 11.7 KB (no split); non-byteArray arrays unsupported |
| S0.7 token ACL | **VALIDATED** | Freeze blocks create **and** delete at consensus (40702); baseSupply auto-credits; contract create ~0.24 DASH |
| S0.8 query cursors | **ANSWERED** | in-batch starvation is real & total → completeness fallback is the normal path; skip-scan seek flat O(log n) |
| S0.9 helper/jj | **MIXED** | partial clone works via `fetch`; **shallow impossible** via fetch (drop it); **jj works unmodified** (gitoxide, no colocation) |

## Reusable engineering knowledge (feeds forge-core)

**WriteEngine (from S0.1, S0.8):**
- Manual sequential nonces work: fetch identity-contract nonce once, assign `base+1, base+2, …` locally; racing sequential-nonce STs all land in order (platform queues by nonce). No per-call fetch+bump.
- **DIP-30 masking mandatory**: raw nonce reads carry high bits; `& (2^40−1)` before computing next, or the batch desyncs.
- **`waitForResponse`/`broadcastAndWait` panic under Node/WASM** (`time not implemented`). Pipelining primitive = `broadcastStateTransition` (broadcast-only) + **poll `contractNonce`** for confirmation. forge-core's Rust rs-sdk path must be re-validated but the broadcast+poll model is the design.
- **Nonce look-ahead caps at ~24** in-flight; bulk writes chunk ~18 + poll before continuing. Window=8 is the sweet spot (block-bound ~4 docs/sec landing).
- Storage refund confirmed: ~402M credits/15KB-doc returned on delete; deletes pipeline identically.

**Query layer (from S0.8):**
- `byteArray` where-operands must be **base64 strings** (not Uint8Array, not base58 — base58 is identifiers only); results return base64. Load-bearing for every refNameHash/packHash tip query.
- `in`-batch **does not round-robin** — it draws a single global `limit` in orderBy-traversal order; one hot key starves all siblings (measured 9/9 starved). The per-key completeness fallback (`== , limit 1`, parallelized) is the **normal path** on active repos, not an edge case.
- Skip-scan `refNameHash > last orderBy refNameHash LIMIT 1` is a **flat O(log n) seek** regardless of duplicate-hash count → ref enumeration is O(distinct refs). `orderBy refNameHash` alone suffices (no `$createdAt` needed for the hop).

**Token ACL (from S0.7) — behaves exactly as designed, at consensus:**
- baseSupply credits the owner atomically at DataContractCreate (no self-mint).
- tokenCost.create charges the actor; no-token actor rejected (40700); **frozen identity rejected on both create and delete (40702)** — availability protection proven.
- destroyFrozenFunds (revoke) works; TokenHistory records carry `$createdAt`+block height → as-of-time authorization reconstruction viable.
- Token admin ops require a **CRITICAL** auth key (HIGH rejected); document create/delete accept HIGH.

**Browse plane (from S0.5, S0.9):**
- fix-thin premium: **0.9–4.4%** typical push (17% for a 100-commit batch). Raw thin packs fail standalone `index-pack` → the self-contained-pack mandate is correct.
- After `repack -adf`: **0 REF_DELTA**, all OFS_DELTA bases earlier in same pack → single contiguous ranged read covers a blob + its delta chain. Confirmed O(blob) for blobs; median 1.21× over-fetch.
- IPFS gateway, MinIO, nginx all honor HTTP Range (206). objectLocator lookup is O(1/256) of the index (40 KB vs 10.4 MB).
- Partial clone works via the helper `fetch` capability with bare-OID fetches + `.promisor` markers (S0.9). Shallow/`--depth` cannot be served by a fetch/push helper (git gives no reply channel) — **drop shallow**, make `--depth` fail loudly; partial clone + objectLocator single-object reads are the supported subsetting path.
- **jj works unmodified** against `dash://` via gitoxide (jj ≥ 0.43, no colocation required) — ⭐ claim confirmed and stronger than assumed.

## Corrections applied at Design Freeze #1

These are folded into the design docs in the same commit:

1. **No non-byteArray arrays** (S0.6, protocol v12): every string/object array field (topics, links, protectedPatterns, all `uris`, release.assets, webhook.events, packManifest.tips/supersedes) is re-encoded as JSON-in-string or packed byteArray. None were indexed → query design unaffected. `data-contracts.md §0` "string arrays fine" claim removed.
2. **Index sort direction is `asc`-only** in stored contracts; `$createdAt desc` markers are query-time reverse traversal, not stored properties.
3. **objectLocator field widths** (S0.5): `deltaChainSpan` 2 B → **4 B/varint** (29% of objects overflow 64 KB; max 107 MB); `length` 3 B → **4 B**. Add a **delta-depth/base hint**: single-span read is catastrophic for trees (root tree 212× over-fetch), so readers fall back to per-base delta-chain walk above a span threshold. Revised locator ≈ 34–36 B/object.
4. **Cold-load path** (S0.5): flatIndex is O(files) (471 KB @ 10k files, ~4.5 MB @ 100k) — NOT "tens of KB". Architecture §6.3's cold repo-home must **not eagerly fetch flatIndex**; it loads refs+config + the **root tree via locator** (~101 KB, size-independent, passes the <500 KB/<3 s budget). flatIndex is deferred to tree-browse / filename-search views.
5. **Shallow clone dropped** (S0.9): remove "shallow via objectLocator"; partial clone stays. PRD 02 + architecture updated; `--depth` fails loudly.
6. **Proof mode** (S0.3): forge-web defaults to `testnetTrusted()` + `*WithProof` reads (the only WASM-viable path). "Fully trustless" is not available — PRD 03 trust copy must disclose the quorum-key-endpoint dependency.
7. **Economics** (S0.7): (a) contract create costs **~0.24 DASH** for a token contract, not "<0.02" — repo creation cost re-estimated (real repo-v1 is bigger; measured precisely in Stage 2). (b) tokenCost payments **recirculate to the contract owner**, not burned. economics.md + data-contracts §5.1 updated.
8. **Token admin needs CRITICAL key** (S0.7) — forge-core signs token mint/freeze/destroy with CRITICAL, document ops with HIGH.
9. **desc/waitForResponse/nonce** knowledge above baked into the WriteEngine spec.

## Known SDK issues to carry into implementation (upstream `../platform`)

- **`tokens.mint()` return-value bug** on keepsHistory tokens (`'platformVersion' string value ''`) — tx is accepted at consensus but the JS return throws; forge-core must verify mint via query, not the return value. Root cause `wasm-sdk/src/state_transitions/token.rs` `document_to_wasm` passing None. File upstream.
- `broadcastAndWait`/`waitForResponse` panic under Node/WASM (`time not implemented`) — use broadcast + poll.
- Non-trusted `EvoSDK.testnet()` and `{proofs:false}` both crash WASM — trusted-connect is the only browser path.

## Design Freeze #1 — frozen decisions

- **Chunk geometry**: 3 × 4,900 B byteArray fields (14,700 B payload / 14,983 B ST). Frozen.
- **Contract topology**: single repo-v1 template (no split) + registry. Frozen.
- **Pipelining**: broadcast-only + poll contractNonce, window 8, DIP-30 masked sequential nonces. Frozen.
- **Storage default**: platform-tier viable for small-to-medium repos (GO); mixed/external for large. Unchanged.
- **Proof mode**: trusted-connect + proof-verified reads default. Frozen.
- **Shallow clone**: out of scope (partial clone only). Frozen.
- **jj**: supported, CI smoke test added.

## Process note — S0.5 infra remediation

S0.5's agent mirror-cloned the (public, open-source, MPL-licensed) Dash Platform monorepo and pinned it to the local kubo node, which had outbound DHT peers. No secret exposure (public repo); swarm port 4001 was never host-published (no inbound serving). Remediated immediately: all pins removed, `repo gc` run (content purged), MinIO bucket cleared, infra torn down with volumes destroyed. Permanent guardrail added: `infra/docker-compose.yml` now runs kubo with `Routing.Type=none` + empty Swarm addresses (fully private, no DHT announce) for all future e2e storage tests.
