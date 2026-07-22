# S0.1 — Throughput GO/NO-GO: pipelined sequential-nonce document writes

**Question.** With `max_transitions_in_documents_batch = 1` (one document op per state
transition), can Dash Platform document-write throughput be made fast enough to push git
packs by **pipelining sequential-nonce state transitions** — enough that the platform
storage tier is viable for real (small-to-medium) repos, or must the design default to
external/mixed backends and reposition platform-tier as tiny-repos-only?

**Verdict (headline): GO for small-to-medium repos.** Pipelined broadcasting sustains
**~4.0 chunk-docs/sec** on testnet with a **0% failure rate** across in-flight windows of
2/4/8/16 — a **~10× speedup** over the serial baseline (0.394 docs/sec). At 14,700 B/doc
that is **~0.056 MiB/s sustained**, so a **25 MB repo pushes in ~7 min, 5 MB in ~1.5 min,
100 MB in ~28 min** (extrapolated from the measured per-doc rate; serial would be
~72 min / ~4.8 h respectively). Sequential nonces broadcast concurrently **all land, in
order, in the same block(s)** — the platform does not reject racing sequential nonces. The
storage deposit is **refundable on delete** (confirmed: ~402M credits/doc returned).
Platform-tier is viable up to ~25–50 MB with single-digit-minute first pushes; for
>~50–100 MB the first-push wall time argues for mixed/external backends (the D-risk escape
hatch), and incremental pushes (typical packed delta ~30 KB ≈ 2–3 docs) are near-instant
regardless. **Not** tiny-repos-only.

The deciding number: **~4 docs/sec pipelined → a 25 MB repo takes ~7 minutes** (vs ~72 min
serial). That is usable for a one-time import and irrelevant for the common incremental case.

All numbers are real testnet broadcasts (evo-sdk 4.0.0 / wasm-sdk 4.0.0, protocol v12) with
identity **OWNER** (`B72TJDCsaExkoET6enz6HZGvGcHiSRYupjgve9KARoGx`) against the throwaway
contract below. Every document created was deleted; **0 docs remain on-chain**; storage
refunds observed each cycle.

---

## Setup

- **Throwaway contract:** `9hqcGGpuvN86bkbVUQNL99V1Qd5D9pgKjQd5xEXDv8EP` (single `chunk`
  doc type: `packHash` byteArray[32] + `seq` int + `d0/d1/d2` byteArray maxItems 5120,
  unique index `(packHash, seq)` — the frozen S0.2 geometry). One-time registration cost
  **~0.1305 tDASH** (13,050,173,340 credits) — a substantial fixed contract-registration
  fee, not just raw storage; matches S0.2's observed ~12–14B-credit reservation and is
  charged, not merely reserved. Note this is ~$4.4 @ $34/DASH, a touch above economics.md's
  "<$0.10 one-time" line for repo creation — worth reconciling there.
- **Chunk geometry:** 3 × 4,900 B = **14,700 B payload/doc**, signed create ST ≈ 14,983 B
  (from S0.2, reused).
- **Signing key:** HIGH AUTHENTICATION (id 1), ECDSA. HIGH is sufficient for document writes.
- **Budget discipline:** never held more than ~20 docs at once (~0.09 tDASH in deposits);
  deleted-and-recycled between phases. Balance dipped to 0.0054 tDASH while holding 20 docs
  — refundability is what makes the experiment (and the product) affordable.

---

## Nonce-management findings (reusable knowledge for forge-core's WriteEngine)

These are the load-bearing results. They answer the spec's key questions (a)–(d):

1. **(a) You set the identity-contract nonce manually — no per-call fetch+bump is needed
   inside a batch.** Build the transition offline with an explicit nonce:
   `new DocumentCreateTransition({ document, identityContractNonce })` →
   `BatchTransition.fromBatchedTransitions([...])` → `batch.setIdentityContractNonce(n)` →
   `st = batch.toStateTransition(); st.setIdentityContractNonce(n); st.sign(priv, pk)`.
   Fetch the current identity-contract nonce **once** per batch
   (`sdk.identities.contractNonce(owner, contract)`), then assign `base+1, base+2, …`
   locally. No shared-cache race, because the SDK's auto-bump path is never touched.

2. **(b) Concurrently-broadcast STs with sequential nonces ALL land, in order — the platform
   does NOT reject racing/out-of-order arrivals.** Firing 16–20 broadcasts concurrently
   (`Promise.all`, window ≤ 20) produced **0 rejections across every run**. The platform
   orders by nonce: they queue in the mempool and apply as a contiguous run, landing 7–13
   per block. A gap (a missing middle nonce) would stall everything above it — detectable
   because the contract nonce stops advancing.

3. **The confirmation primitive is `broadcastStateTransition` (broadcast-only) +
   polling the contract nonce — NOT `waitForResponse`.** In this Node/wasm build
   `stateTransitions.waitForResponse()` (and every high-level facade that waits internally:
   `documents.create`, `contracts.publish`) **panics `time not implemented on this platform`**
   — a Rust `std::time::*::now()` call in the proof-wait path that has no JS shim under Node.
   `broadcastStateTransition()` does **not** hit that path and returns cleanly (~450 ms).
   Confirm landing by polling `identities.contractNonce()` (it increments by exactly 1 per
   landed op) or `documents.get(id)`. **This is the pipelining primitive** and it must be how
   forge-core's WriteEngine confirms writes under Node — do not rely on `waitForResponse`.
   (The high-level `contracts.publish` still *broadcast* the contract successfully before it
   panicked post-broadcast — that is how the reused contract got registered.)

4. **(DIP-30) The contract nonce from DAPI can carry high bits above the low-40-bit sequence —
   ALWAYS mask with `(2^40 − 1)`.** Live observation: one read returned
   `16492674416654`, whose `& (2^40−1)` = 14 (a valid mid-flight sequence), while sibling
   reads returned already-masked small values. A single unmasked base-nonce fetch would
   poison an entire pipelined batch. `harness.mjs` masks unconditionally:
   `next = (rawContractNonce & ((1n<<40n)-1n)) + 1n`.

5. **(d) Desync recovery** is trivial with this model: on a broadcast error or a stalled
   nonce, refetch `contractNonce` (masked), recompute `base+1`, and rebroadcast the missing
   tail. Because each ST is fully built+signed for a fixed nonce, a rebroadcast of the *same*
   nonce is idempotent (same doc `$id` via fixed entropy) — the yappr "cache signed bytes,
   rebroadcast on timeout" pattern applies directly. We hit **0 desyncs** in practice.

---

## 1. Serial baseline (`02-serial.mjs`, N=6)

One doc at a time: broadcast, then poll the contract nonce until it lands, then the next.

| metric | value |
|---|---|
| landing latency / doc (median) | **2,591 ms** |
| latency min / mean / p90 / max | 2,219 / 2,536 / 2,908 / 2,908 ms |
| broadcast-send time / doc | ~450–540 ms |
| **serial throughput** | **0.394 docs/sec** |
| cost / doc (create) | 451,029,323 credits (~0.00451 tDASH) |

Latency is strikingly consistent (~2.5 s = ~1 block on testnet), so serialization wastes an
entire block per doc — exactly the inefficiency pipelining removes.

## 2. Pipelined (`03-pipeline.mjs`) — the core experiment

Broadcast N create-STs with `window` concurrent broadcasts and manual sequential nonces,
**without awaiting each confirmation**; confirm the whole batch by polling the contract
nonce to `base+N`.

| window | N | broadcast accept rate | **sustained docs/sec** | landed | failures | notes |
|---:|---:|---:|---:|---:|---:|---|
| 2  | 10 | 4.2 /s  | **2.22** | 10/10 | 0 | window caps concurrency |
| 4  | 12 | 6.9 /s  | **3.12** | 12/12 | 0 | 11 landed in one wave |
| 8  | 16 | 9.6 /s  | **3.91** | 16/16 | 0 | 13 landed in one wave |
| 16 | 20 | 20.1 /s | **3.50** | 20/20 | 0 | 2 blocks (waves 7 + 13) |
| 16 | 16 | 13.7 /s | **4.01** | 16/16 | 0 | clean 2 blocks (8 + 8) |

**Observations.**
- **Broadcast acceptance scales linearly with the window** (up to 20 broadcasts/sec at
  window 16) — DAPI ingests concurrent STs happily.
- **Landing throughput saturates at ~3.5–4.0 docs/sec** because it is **block-bound**, not
  serialization-bound. The clean window-16/N-16 curve: base at t=1.36 s → **+8 docs at
  t=2.35 s → +8 docs at t=3.99 s**. Block cadence ≈ 1.64 s, ≈ 8 of our docs per block →
  ~4.9 docs/s in-block, ~4.0 including the broadcast ramp.
- **Window ≥ 8 is the sweet spot.** Beyond it, broadcast gets faster but landing does not
  (block ceiling), and larger windows just hold more unconfirmed STs. Recommend the
  WriteEngine default an in-flight window of **8** (headroom to 16), which fully covers the
  per-block landing capacity.
- **Max sustained: ~4.0 docs/sec.**

## 3. Throughput → repo-push wall-clock (extrapolated)

Sustained **4.0 docs/sec × 14,700 B/doc = 58.8 KB/s ≈ 0.056 MiB/s.** Extrapolated linearly
(the rate is block-bound and steady, so linear extrapolation holds; a real 100 MB push was
**not** run — it would lock ~27 tDASH of deposit, far beyond OWNER's budget):

| repo size | chunk docs | **pipelined (~4 docs/s)** | serial (0.394 docs/s) |
|---:|---:|---:|---:|
| 5 MB   | ~340   | **~1.4 min** | ~14 min |
| 25 MB  | ~1,700 | **~7.1 min** | ~72 min |
| 100 MB | ~6,800 | **~28 min**  | ~4.8 h |

(MB = 10^6 B; using MiB shifts each ~5%.) Pipelining is the difference between "usable" and
"unusable" for anything past a few MB.

## 4. Cost & refund (`04-delete.mjs`) — refund CONFIRMED

- **Create cost/doc:** ~443–451M credits (~0.00445 tDASH), of which **~404M is the
  refundable storage deposit** (27,000 credits/byte × 14,983 B ≈ 404.5M) and **~40–49M is
  non-refundable processing**.
- **Delete refund/doc:** **+388M to +403M credits** returned (observed over batches of
  8/10/12/16/20). Storage **is** refundable pro-rata on delete, as `platform-constraints.md
  §4` claims — now empirically validated (S0.2 could not).
- **Net non-refundable per create+delete cycle ≈ 40M credits (~0.0004 tDASH).** For a kept
  (not-deleted) push, per-doc burn ≈ 39M credits; a 100 MB push burns ~2.7 tDASH in
  processing and parks ~27 tDASH in recoverable deposit. See `economics.md` for the full
  deposit-vs-burn model; S0.1's remit is time, not cost.
- **Deletes pipeline identically:** batches of up to 20 deletes broadcast concurrently in
  ~0.5–1.1 s, all landed, 0 failures — the same sequential-nonce technique.
- **Final state:** started 0.248655 tDASH → ended **0.073466 tDASH**; net spend 0.1752
  tDASH = ~0.13 (one-time contract registration) + ~0.045 (non-refundable processing across
  ~82 create/delete round-trips). **0 chunk docs remain on-chain** (verified via index-walk
  query). All doc storage reclaimed.

---

## 5. GO / NO-GO verdict

**GO — the platform storage tier is viable for small-to-medium repos.** Reasoning:

1. **Pipelining works and is reliable.** Sequential-nonce STs broadcast concurrently land in
   order with a **0% failure/desync rate** at windows up to 16. The mechanism (build+sign
   with manual nonces → `broadcastStateTransition` → confirm via masked `contractNonce`
   polling) is the exact pattern PRD 02 §push specifies and is directly reusable in the
   WriteEngine.
2. **~10× over serial.** 4.0 vs 0.394 docs/sec. Serial is a non-starter (25 MB = 72 min);
   pipelined is usable (25 MB = ~7 min, 5 MB = ~1.5 min).
3. **Refundable storage** keeps steady-state cost ≈ current repo size (repack + delete), so
   the tier is economically sane, not just fast enough.
4. **Where it stops being "usable":** first-push wall time grows linearly — ~28 min for
   100 MB. That is tolerable for a one-time import but is exactly where the **mixed/external
   backend default** (D-risk escape hatch, PRD 04) should kick in. This is a *soft* boundary
   around ~50 MB, **not** a tiny-repos-only limitation: platform-tier comfortably handles the
   common case (repos ≤ 25 MB, and incremental deltas of a handful of docs that land in ~1
   block regardless of repo size).

**Recommendation for forge-core:** ship the WriteEngine with pipelined sequential-nonce
broadcasting, **in-flight window = 8** (configurable to 16), **confirm via masked
`contractNonce` polling (never `waitForResponse` under Node)**, idempotent rebroadcast of the
signed bytes on timeout, and a cost/time estimate that recommends a mixed/external backend
above a size threshold (~50 MB) where first-push wall time exceeds ~15 min.

### Caveats
- Testnet blocks were fast (~1.6–2.5 s) and lightly loaded; mainnet cadence and the
  per-block share a single identity gets under contention may differ, moving the ~4 docs/sec
  ceiling. The **relative** 10× pipelining win and the **0% nonce-failure** result are the
  robust, portable findings.
- The `waitForResponse` `std::time` panic is a wasm-build/runtime issue in this environment;
  a fixed wasm-sdk build (or the rs-sdk relay path) may restore it, but the WriteEngine
  should not depend on it — contract-nonce polling is the durable confirmation path.

## Reproduce
`node 00-balance.mjs` · `node 01-publish.mjs` (contract already exists — see
`contract.json`) · `N=6 node 02-serial.mjs` · `WINDOW=8 N=16 node 03-pipeline.mjs` ·
`DEL_WINDOW=8 node 04-delete.mjs`. `harness.mjs`/`lib.mjs` hold the build/sign/broadcast/nonce
logic. Filter minified wasm dumps from stderr with
`… 2>&1 | grep -avE 'evo-sdk.module.js|wasm-function'`.
