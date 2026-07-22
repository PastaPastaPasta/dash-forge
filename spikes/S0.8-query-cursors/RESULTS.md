# S0.8 — Query-Cursor Semantics (in-batch starvation + skip-scan seek cost)

**Status: both questions definitively answered on testnet (protocol v12, evo-sdk 4.x).**

Two load-bearing behaviours in `data-contracts.md` were validated empirically against a real
`refUpdate`-shaped contract with a deliberately skewed dataset:

- **(A)** Does one hot key in an `in`-batch **starve** its sibling keys (return zero rows for them)? — affects ref-tip batch lookups **and** issue/PR `event` folds.
- **(B)** Is a `limit 1` skip-scan hop on `(refNameHash, $createdAt)` a **flat O(log n) seek** regardless of duplicate-hash row count? — ref/branch enumeration correctness depends on this.

Headline: **(A) starvation is real and can be total (100% of siblings) — the completeness fallback is REQUIRED. (B) the skip-scan seek is flat — enumeration is O(refs), not O(total pushes), exactly as designed.**

---

## Setup

- **Contract** `DcSeVwdaPPyA6MQWjHxNheavfKhuetEqH4rntBBa5MpJ` (owner = DEPLOYER). One doc type `refUpdate` (`refNameHash` byteArray 32, `refName` string, `newOid` byteArray), no token gating (open-creation; owner created all docs). Indices: `refState = (refNameHash asc, $createdAt asc)` and `reflog = ($createdAt asc)` — exactly the design's ref indices.
- **Dataset (skew):** 10 distinct `refNameHash` values. **1 hot key** (`refs/heads/release/v1`, chosen because its sha256 sorts *smallest* → visited first under `orderBy refNameHash asc`, the worst case) populated to **150 rows**; the other **9 cold keys** hold **1–3 rows each** (18 rows total). **168 docs total.**
- **Operand encoding (finding):** for a `byteArray: true` query operand, only **base64-string** works. `Uint8Array` operands are rejected (`invalid type: byte array, expected any valid JSON value`); base64 returns rows. (Identifier fields use base58; plain byteArray fields use base64. Note for `FORGE_RULES` query-encoding helper.)

---

## Experiment A — `in`-batch starvation

Query: `where refNameHash in [all 10 hashes]`, `orderBy (refNameHash, $createdAt)`, `limit 100`, both directions.

| orderBy | rows returned | hot key got | cold keys with 0 rows (starved) | fallback recovered |
|---|---|---|---|---|
| **asc, asc** (hot sorts first) | 100 | **100** | **9 / 9** (ALL siblings) | **9 / 9** ✅ |
| **desc, desc** (hot sorts last) | 100 | 82 | **0 / 9** | n/a |

### What this proves

1. **`in` does NOT round-robin across keys.** It fans out to one subtree per key **in `orderBy` traversal order** and draws down a **single global `limit` budget** in that order. The first key(s) encountered can consume the entire budget.
2. **Starvation is total in the worst case.** With the hot key sorting first (`asc`), it took all 100 slots and **every one of the 9 cold keys returned zero rows** — even though each cold key's tip is a single cheap row. A tip-batch or event-fold that trusted this result would show 9 branches / 9 issues as *empty*.
3. **It is traversal-order-dependent, so you cannot dodge it by picking a direction.** The *same* dataset starved 9 keys under `asc` and 0 under `desc` — purely because the single hot key flipped from first to last. Real datasets have **random hash positions and possibly several hot keys**, so any key that sorts *after* a budget-exhausting key (in the active direction) starves. There is no direction that is safe in general; `desc` looked clean here only because there was exactly one hot key and it happened to sort last.
4. **The completeness fallback works and is cheap.** Re-querying each zero-row key individually (`where refNameHash == key`, `limit 1`) recovered **all 9 tips, 9/9**, at **~427 ms/key** (3.85 s for 9 keys, serial). Batching those fallbacks in parallel would cut wall-time substantially.

### Verdict on the design

- **`data-contracts.md §3` "in-batch caveat" and the mandated completeness check are CORRECT and REQUIRED — keep them.** The behaviour is exactly as the caveat describes, with one sharpening below.
- **Fallback firing frequency:** the fallback fires whenever any batched key's rows would land *after* an earlier key's rows push the running total past `limit`. With `k` keys and per-page `limit = 100`, it is effectively **guaranteed to fire on any repo that has even one hyperactive ref/issue** whose row count approaches the page limit while sitting early in traversal order. It is not a rare edge — treat it as the **normal path**, not an exception.

---

## Experiment B — skip-scan distinct-ref seek cost

Enumerate distinct `refNameHash` via `where refNameHash > <last>`, `orderBy refNameHash asc`, `limit 1`, hopping until empty. Run once when the hot key had **3 rows** and again at **150 rows** (50× more duplicates at that key). Per-hop latency = best of 3 repeats (network-jitter filtered).

| Run | hot-key rows | distinct enumerated | total hops | hop landing **on** hot key | hop advancing **past** hot key | cold-hop avg (min–max) |
|---|---|---|---|---|---|---|
| early | 3 | **10** | 11 (10 + terminator) | 627 ms | 349 ms | 434 ms (152–785) |
| late | **150** | **10** | 11 (10 + terminator) | **431 ms** | **264 ms** | 237 ms (97–403) |

### What this proves

1. **The seek is flat — O(log n), not O(rows).** Growing the hot key **50×** (3 → 150 rows) did **not** raise the cost of the hop that lands on it or the hop that seeks past it. In fact both were *lower* in the 150-row run (431/264 ms) than the 3-row run (627/349 ms) — the difference is pure network jitter, and the hot hops sit **within the cold-hop range** in both runs. The index seeks straight to the `refNameHash > last` boundary; it never walks the hot key's duplicate rows.
2. **Enumeration is O(refs), not O(total pushes).** Both runs enumerated all **10 distinct names in exactly 10 hops + 1 empty terminator**, regardless of the 150-row skew. A `limit 100` page here would instead have returned *rows* and dragged the hot key's 150 duplicates through pagination — the design's stated failure mode, correctly avoided by `limit 1`.
3. **`orderBy refNameHash` alone suffices** for the skip hop (the bare leading index component is accepted; no need to append `$createdAt`).

### Verdict on the design

- **`data-contracts.md §2.3` skip-scan enumeration (`refNameHash > last` orderBy `refNameHash` **limit 1**) is CORRECT — keep it verbatim.** The "one hyperactive ref would make a `limit 100` page O(total pushes)" rationale is validated, and the `limit 1` hop is confirmed flat. The line "Cursor-seek behavior verified in S0.8" can be marked ✅ done.

---

## Corrections / notes for the contracts + FORGE_RULES_V1

1. **§3 in-batch caveat — sharpen the wording (behaviour confirmed, not "may"):** replace "*can* exhaust the limit and starve every other key" with the measured mechanic: **"an `in` batch draws down a single global `limit` in `orderBy` traversal order and does not round-robin; any key whose rows fall after an earlier budget-exhausting key returns zero. In the worst case (a hot key sorting first) 100% of sibling keys starve."** Add: **the completeness fallback is the normal path on active repos, not an edge case** — size batches and budget the extra round-trips accordingly, and **parallelise the per-key `limit 1` refetches** (measured ~427 ms/key serial).
2. **§2.3 skip-scan — no change needed**; mark "verified in S0.8" ✅. Flat-seek numbers above can be cited.
3. **NEW — query operand encoding (belongs in FORGE_RULES_V1 query helper):** `byteArray: true` query operands (e.g. `refNameHash`) must be passed as **base64 strings**, not `Uint8Array` (which the query path rejects) and not base58 (that is the identifier-field convention). Returned `refNameHash` values also come back base64. This is load-bearing for every ref/tip query and was not previously documented.
4. **NEW — bulk-write nonce look-ahead cap (~24):** the identity-contract nonce rejects transitions more than ~24 ahead of the current landed nonce ("nonce too far in future"). Pipelined push/import/GC must **chunk broadcasts (~18) and poll each chunk to land before the next** — a single wide fan-out of all pending writes fails. (Complements S0.1's throughput findings; relevant to push resume and bulk import in PRD 02/06.)
5. **NEW — `broadcastAndWait` unusable under Node/wasm:** it panics `time not implemented on this platform` in the wait path (same class as S0.1's `waitForResponse` note). Contract/doc writes must **broadcast-only + poll** (identity nonce for contract create; identity-contract nonce for doc ops). Confirmed here for `DataContractCreate` and document create/delete.

---

## Cost / cleanup

- 168 docs created + 168 deleted. **All docs deleted; 0 remain on-chain** (verified by index walk).
- **Storage refund on deletion: 3,436,280,076 credits ≈ 0.0344 tDASH** (~20.5 M credits/doc, ~0.0002 tDASH/doc refunded), confirming the refundable-storage model for the ~300-byte ref docs. Net spend was the non-refundable processing fees only. Well within budget; the throwaway contract itself is permanent (no contract-delete transition exists — consistent with §5.8).

## Reproduce

```
node 01-register.mjs                 # publish throwaway refUpdate contract (writes state.json)
HOT_TARGET=3   node 02-populate.mjs  # 9 cold keys (18 rows) + 3 hot rows
LABEL=early    node 03-exp-b.mjs     # skip-scan seek, hot=3
HOT_TARGET=150 node 02-populate.mjs  # top hot key to 150 rows (chunked)
LABEL=late     node 03-exp-b.mjs     # skip-scan seek, hot=150  -> compare: flat
               node 04-exp-a.mjs     # in-batch starvation asc/desc + completeness fallback
               node 05-delete.mjs    # delete all (chunked), confirm refund; re-run to clear stragglers
```
All raw per-hop / per-key numbers are persisted in `state.json` (`expA`, `expB`).
