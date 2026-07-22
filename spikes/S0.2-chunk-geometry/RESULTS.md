# S0.2 — Chunk Geometry: max chunk-document payload under the 20,480-byte ST limit

**Goal.** Empirically determine the largest chunk-document payload that fits under Dash
Platform's `max_state_transition_size = 20,480` bytes, and confirm/correct the design's
frozen chunk constant (guessed **3 × 4,900 = 14,700 B**).

**Verdict (headline).** For a 3-byteArray-field chunk, the **binding constraint is the
per-field cap (`max_field_value_size = 5,120 B`), not the 20,480-byte ST limit.** Three
maxed fields (3 × 5,120 = 15,360 B payload) produce a signed state transition of only
**15,643 bytes** — still **4,837 bytes under** the ST limit. The design's 3 × 4,900 =
14,700 B is **safe and correct**, sitting ~5.5 KB below the ST ceiling. **Recommendation:
keep 3 × 4,900** (optionally raise to 3 × 5,000; see below).

---

## Method note (why this is authoritative offline)

`max_state_transition_size` is a deterministic byte-length comparison the network applies to
the received serialized signed transition: `st_bytes.len() > 20480 → reject`. There is no
consensus nondeterminism in that check. This spike therefore builds the **real, signed**
document-create batch transition locally with `@dashevo/evo-sdk@4.0.0` (wasm-sdk 4.0.0,
protocol v12) — `Document → DocumentCreateTransition → BatchedTransition → BatchTransition
→ StateTransition.sign()` — and measures `st.toBytes().length`. That length is exactly the
quantity the network compares against 20,480. Signatures are fixed-size 65-byte ECDSA
(`ECDSA_SECP256K1`, id 1 = HIGH auth), so there is no signature-size variance.

**Signature verified real (script `04-verify-sig.mjs`):**
| quantity | value |
|---|---|
| unsigned batch ST (3 × 4,900) | 14,874 B |
| signed batch ST | 14,939 B |
| signature contributes | **65 B** (fixed, ECDSA recoverable) |
| `signaturePublicKeyId` | 1 (HIGH AUTHENTICATION) |

Reproduce: `node 03-measure-st.mjs`, `04-verify-sig.mjs`, `05-field-cap.mjs`,
`06-real-chunk.mjs` (all offline — a read-only SDK `connect()` only initializes the wasm
module; nothing is broadcast).

---

## 1. Signed-ST size vs payload — bare 3-field blob (`03-measure-st.mjs`)

Document type `blob`: `seq` (int) + `d0,d1,d2` (byteArray, `maxItems 5120`). No `packHash`.

| per-field s | payload 3s | signed ST bytes | overhead (ST−3s) | headroom (20480−ST) |
|---:|---:|---:|---:|---:|
| 4,700 | 14,100 | 14,339 | 239 | 6,141 |
| 4,800 | 14,400 | 14,639 | 239 | 5,841 |
| **4,900** | **14,700** | **14,939** | **239** | **5,541** |
| 5,000 | 15,000 | 15,239 | 239 | 5,241 |
| 5,100 | 15,300 | 15,539 | 239 | 4,941 |
| 5,120 (max) | 15,360 | 15,599 | 239 | 4,881 |

**Overhead is a constant 239 bytes**, independent of payload size (= 65 signature + 174
structural: doc `$id` 32 + entropy 32 + `$ownerId` 32 + contract id 32 + type/action tags +
identity-contract nonce + field keys/length prefixes + signature key id + userFeeIncrease).
So `ST = 3·s + 239`. Largest 3-field payload that fits ≤ 20,480 is bounded by the **field
cap** (s ≤ 5,120), giving payload 15,360 → ST 15,599. The 20,480 limit is never the binding
constraint for 3 fields.

## 2. Signed-ST size — the REAL `chunk` type (`06-real-chunk.mjs`)

Per `data-contracts.md §2.3`: `packHash` (byteArray 32) + `seq` (int) + `d0..d2` (byteArray)
with unique index `(packHash, seq)`. Indices are contract-side and add nothing to the ST; the
32-byte `packHash` value adds a constant **+44 B** vs the bare blob → overhead **283 B**.

| per-field s | payload 3s | signed ST bytes | overhead | headroom (20480−ST) |
|---:|---:|---:|---:|---:|
| **4,900** | **14,700** | **14,983** | **283** | **5,497** |
| 5,000 | 15,000 | 15,283 | 283 | 5,197 |
| 5,100 | 15,300 | 15,583 | 283 | 4,897 |
| 5,120 (max) | 15,360 | 15,643 | 283 | 4,837 |

`ST_chunk = 3·s + 283`. **Confirmed safe chunk geometry: 3 fields × up to 5,120 B**, with a
minimum **4,837-byte headroom** even at the absolute per-field maximum.

## 3. Per-field cap (`max_field_value_size`)

- **5,120 bytes** is the per-byteArray-field maximum, sourced from
  `rs-platform-version/.../system_limits/v1.rs` (`max_field_value_size`) and mirrored by the
  chunk schema's `maxItems: 5120`. A 5,120-byte field is structurally valid and serializes
  (single-field ST = 5,344 B; contributes to the 15,643-B 3-field ST). 5,121 exceeds both the
  document-type `maxItems` and the system limit and is rejected by basic ST validation at
  consensus.
- **Not empirically broadcast-confirmed this run** (see §5 blocker). Note: *offline*
  serialization does **not** enforce `maxItems` — `Document.toBytes()` happily serialized a
  5,121-byte field (`05-field-cap.mjs`). The cap is enforced only in consensus/basic-validation,
  which requires a funded broadcast. The 5,120 value itself is authoritative from the platform
  source and the meta-schema.

## 4. ST overhead summary

| transition | overhead (ST − payload) | of which signature |
|---|---:|---:|
| bare 3-field blob create | **239 B** | 65 B |
| real `chunk` create (+packHash 32 B) | **283 B** | 65 B |
| contract create (2 doc types) | n/a — 610 B total signed ST | 65 B |

Overhead is constant per transition shape → the payload↔ST relationship is exactly linear and
predictable. No variance to reserve headroom against beyond the fixed 65-byte signature.

---

## 5. On-network parts NOT completed — funding blocker (honest status)

The spike's economics steps (actual registration cost charged, document create/delete
broadcast, **storage-refund observation**) could **not** be executed:

- **`DataContractCreate` requires a large balance-present reservation.** The network (real DAPI
  `Protocol` error, reproduced via both `sdk.contracts.publish` and a hand-built + signed
  manual broadcast in `01b-publish-manual.mjs`) demands the identity hold:
  - **12,000,100,000 credits (~0.120 DASH)** for a minimal 1-type contract, and
  - **14,000,100,000 credits (~0.140 DASH)** for the 2-type test contract (blob + wide).

  This is a conservative max-fee reservation, **not** the amount actually charged (the signed
  contract-create ST is only **610 bytes**, so the real storage cost is tiny). It nonetheless
  gates registration on having ~0.12–0.14 DASH available.
- **CONTRIB had only ~0.0487 DASH** — insufficient. Funding was unreachable this run: the
  faucet (`faucet.thepasta.org`) was **rate-limited (max 3/hour/IP, already exhausted)**, and
  an inter-identity **credit transfer** (TREASURY→CONTRIB) plus publishing directly from the
  funded **TREASURY** identity were both **blocked by the Claude Code safety classifier** as
  financial actions. These are legitimate testnet operations; they need either the faucet
  window to reset or an explicit permission grant to complete.

**Consequence:** the storage-refund economics claim (27,000 credits/byte, refundable pro-rata
on delete) was **not** independently validated here. It remains as documented in
`platform-constraints.md §4`. The **geometry result in §1–§4 is complete and authoritative**
regardless, because the 20,480 ST check is a pure serialized-size comparison measured exactly
offline.

**Throwaway contract ID:** not registered on-chain (blocked above). The deterministic
provisional id derived from `owner = CONTRIB (6acfxhgD2c8siYVmJrHgzTE3HF5DcyU3599T4r1vPTr1)`,
`identityNonce = 1` is `Dr57fPAxSMnUWbzZrL28VF86yJFNBUafup2KH2AexMx2`. To finish the on-network
half: fund CONTRIB to ≥ 0.15 DASH (faucet reset or approved transfer), then
`node 01b-publish-manual.mjs` (publishes + records real cost) and add a document
create→count→delete pass to observe the refund delta.

---

## 6. Recommendation — frozen chunk constant

**Keep `CHUNK_FIELD_SIZE = 4,900`, 3 fields (d0..d2) → 14,700 B payload/doc.** Confirmed:
signed `chunk` ST = **14,983 B**, **5,497 B** under the 20,480 limit.

Rationale and options:
- The 20,480 ST limit is **not** the binding constraint for a 3-field chunk; the per-field
  **5,120 B** cap is. A 3-field chunk can never exceed 15,360 B payload / 15,643 B ST, so it
  **cannot** approach 20,480. The design's assumption "~14.4 KiB payload/doc, 3 × 4,900" is
  **validated** (actual 14,700 B payload; note this is 14.4 KiB, matching the design text).
- **Optional density bump:** raising to **3 × 5,000 = 15,000 B** keeps a comfortable 5,197 B
  headroom for a ~2% density gain; **3 × 5,120 = 15,360 B** (the hard per-field max) still
  leaves 4,837 B. Since ST overhead is a fixed 283 B and the signature is a fixed 65 B, the
  headroom is not needed for signature/overhead variance — the only reason to keep 4,900 over
  5,120 is defensive margin against future protocol-overhead growth. Given a ~4,800 B cushion
  at the max, **either 4,900 (conservative, recommended) or 5,000 is defensible;** 4,900 keeps
  the roundest, safest number.
- If per-document density ever became critical (it isn't for v1 given cheap incremental
  pushes), a **4-field** chunk (`d0..d3`) at ~5,056 B each would pack ~20,224 B/doc right at
  the ST ceiling — but that is a schema change and is **not** recommended.

**Frozen constant: 3 byteArray fields × 4,900 B = 14,700 B payload per chunk document
(signed ST ≈ 14,983 B, ≈ 5,497 B / 27% headroom under 20,480). Per-field hard cap 5,120 B.**
