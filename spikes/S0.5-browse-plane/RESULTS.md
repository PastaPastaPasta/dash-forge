# S0.5 — Browse plane (size-independent web browsing) — empirical spike

**Date:** 2026-07-22 · **git:** 2.52.0 · **python:** 3 · backends: MinIO S3 (`:9000`), kubo IPFS 0.42 gateway (`:8081`), nginx static-http (`:8082`)

De-risks the **browse plane** in architecture §5–6.3 and data-contracts §2.3: that the
`objectLocator` + `flatIndex` artifacts plus **fix-thin'd self-contained packs** enable
**O(view)** browsing of an arbitrarily large repo through **ranged reads** on real external
storage backends.

**Test subject:** the local Dash Platform monorepo (`/Users/pasta/workspace/platform`),
mirror-cloned to `/tmp/plat-mirror` and `git repack -adf --window=50`'d into **one
self-contained pack: 3,060,337,590 B (2.85 GiB), 297,188 objects** (deduped from 412,872
across 44 pre-existing packs), idx 8.5 MB. HEAD = `25e6c1b…`, 10,336 files at tip, no
submodules (a synthetic gitlink was injected to exercise the mode-160000 path). All numbers
below are measured, not estimated. Scripts in `scripts/`, artifacts in `artifacts/`.

---

## TL;DR verdicts

| Question | Verdict |
|---|---|
| Raw thin pack has unresolved cross-pack bases → fails standalone `index-pack` | ✅ **Confirmed** — 77 unresolved deltas for a 30-commit thin pack |
| `index-pack --fix-thin` makes the stored pack self-contained | ✅ **Confirmed** — completed pack passes standalone `index-pack` |
| Fix-thin byte premium | **0.9–4.4 %** for normal pushes (1–30 commits); **~17 %** for a 100-commit batch; reclaimed at next repack |
| After `repack -adf`, **every delta is OFS_DELTA with its base earlier in the same pack** | ✅ **Confirmed** — REF_DELTA count = **0**; 100 % of OFS bases at lower offset |
| `deltaChainSpan` single contiguous ranged read yields a verifiable blob | ✅ **for blobs** (README = one 6,173 B read → 11,875 B blob, git-OID verified) |
| …but the single-span read is O(blob)? | ⚠️ **Only for blobs.** For high-churn **trees it is catastrophic** — root tree span = **1.1 MB for 5.2 KB useful (212×)** |
| `deltaChainSpan` fits the data-contracts **2-byte** field | ❌ **No** — **87,144 / 297,188 (29 %)** of objects overflow 64 KB; max span **107 MB** |
| objectLocator lookup = fanout header + one 1/256 slice | ✅ **Confirmed** — 40,329 B fetched vs 10.4 MB full locator (**0.39 %**) |
| HTTP Range works on **MinIO (S3)** | ✅ 206, verified reconstruct |
| HTTP Range works on **kubo IPFS gateway** | ✅ **YES** — 206 at a 156 MB offset into a 3 GB DAG, verified reconstruct |
| HTTP Range works on **nginx static-http** | ✅ 206 |
| Cold repo-home < 500 KB / < 3 s **at any size** | ⚠️ **Depends on the path** — **FAIL (526 KB)** if home eagerly loads the full flatIndex; **PASS (101 KB)** with the root-tree model |
| Staleness overlay cheaper than re-fetching flatIndex | ✅ **~36 KB vs 471 KB (~13×)** — *but only if trees use per-base reads* (single-span overlay = 24.75 MB) |

**Net:** the artifact formats and ranged-read mechanics work on all three real backends and
deliver true O(view) blob browsing. Two design assertions in data-contracts §2.3 need
correction: the **2-byte `deltaChainSpan` field is undersized**, and the **single-contiguous-
read model must not be applied to trees** (per-base chain-walk required). One architecture
§6.3 assertion needs correction: the **cold-home path must not eagerly fetch the full
flatIndex** — it is O(files), already 471 KB at 10k files.

---

## 1. Fix-thin premium (self-contained-pack mandate)

Thin packs built with `git pack-objects --thin --revs` (objects in HEAD not in HEAD~N), then
completed with `git index-pack --fix-thin --stdin` against the odb holding the bases.

| Push (HEAD~N) | Thin pack | Fixed pack | Premium | Unresolved deltas standalone |
|---|---|---|---|---|
| 1 commit | 159,356 B | 160,804 B | +1,448 B (**0.91 %**) | 2 |
| 5 commits | 227,428 B | 234,546 B | +7,118 B (**3.13 %**) | 11 |
| 30 commits | 2,049,850 B | 2,140,084 B | +90,234 B (**4.40 %**) | 77 |
| 100 commits | 5,298,015 B | 6,182,714 B | +884,699 B (**16.70 %**) | 234 |

- **Standalone `git index-pack` on the raw thin pack fails** ("pack has N unresolved deltas")
  — empirically confirms data-contracts §2.3's claim that raw thin packs cannot serve random
  access. The **fixed pack passes standalone `index-pack`** (self-contained).
- Premium grows with push size (more distinct cross-referenced bases get materialized).
  Normal interactive pushes pay **~1–4 %**; large history-import batches pay **~15 %+**.
  Reclaimed at the next `repack -adf`.
- **No correction needed** to the fix-thin mandate — it is sound and cheap for real pushes.

## 2. deltaChainSpan — the "one ranged read" crux

Parsed the 3 GB pack directly (`scripts/build_locator.py`, `analyze_span.py`): read every
object header, classified OFS_DELTA/REF_DELTA, followed each OFS base chain, computed
`span = obj.end − root_base.offset` (the single contiguous range covering the object + its
whole delta window).

**Contiguity — CONFIRMED (this is the crux):**
- **REF_DELTA count = 0** in the repacked pack; all **203,031** delta objects are OFS_DELTA.
- **100 % of OFS bases sit at a lower offset in the same pack** → a single range
  `[root_base.offset, obj.end)` always contains the object and its entire base chain.
- Max delta depth = 47; 23,317 objects sit past the 2 GB mark (need the idx 64-bit offset
  table — a 3 GB pack exercises this).

**But the single-span read is only O(blob) for blobs (`analyze_span.json`):**

| Object class | span median | span p95 | span p99 | over-fetch (span/useful) median · p95 · p99 · max |
|---|---|---|---|---|
| blobs (124,152) | 3,803 B | 125,786 B | 1,673,785 B | **1.21× · 6.68× · 15.03× · 76.77×** |

- **README.md** (the canonical browse target): offset 156 MB into the pack, on-disk 496 B,
  chain depth 2, **span 6,173 B, useful 6,059 B (1.02× over-fetch)** → one small read
  reconstructs the 11,875 B file. Ideal.
- **Root tree** (`ebd6bb6…`, needed by *every* repo-home render): chain depth 28,
  **span 1,110,159 B but useful only 5,223 B → 212.6× over-fetch.** High-churn trees are
  revised on nearly every commit, so their bases are scattered the length of the pack.
- The `git diff-tree` set for a 5-commit overlay: 47 trees, single-span total **24.75 MB**
  vs per-base useful **27 KB** (~900×).

**Per-base alternative (`scripts/perbase_read.py`):** fetch each chain member's own bytes via
individual Range reads. Root tree = **29 reads, 5,223 B, OID verified** (vs 1.1 MB single-
span). Trades bytes for round-trips (bytes-vs-RTT). On a warm/local backend the extra RTTs
are cheap; on a high-latency gateway 29 sequential reads (~29×100 ms ≈ 2.9 s) approach the
3 s budget — so the reader should **cap the single-span read at a threshold and fall back to
per-base chain-walk above it**, or parallelize member fetches.

**Field-width overflows vs data-contracts §2.3 estimate (oid 20 + packRef 2 + offset 5 +
length 3 + span 2 = 32 B):**

| Field | Est. width | Objects overflowing | Verdict |
|---|---|---|---|
| offset | 5 B (1 TB) | 0 | ✅ correct (needs > 4 B: 23,317 objects past 2 GB) |
| length | 3 B (16 MB) | **40** | ❌ widen to 4 B (max on-disk object = 107 MB) |
| **deltaChainSpan** | **2 B (64 KB)** | **87,144 (29 %)** | ❌ **badly undersized**; max span 107 MB |

## 3. objectLocator & flatIndex sizes (real repo vs estimates)

**objectLocator** (`artifacts/objectLocator.bin`, `scripts/build_locator.py`), 297,188 objects:

| | bytes | B/object |
|---|---|---|
| data-contracts spec widths (32 B/row) | 9,511,040 | **32.0** (estimate is accurate for the layout) |
| widened (offset 5 + length 4 + span 4 = 35 B/row) | 10,402,604 | 35.0 |

- The **~32 B/object estimate holds** for the field layout — but only after fixing the span
  field (§2). Type histogram: 13,140 commits · 58,017 trees · 23,000 base blobs · 203,031
  OFS deltas.
- Lookup cost is what matters, and it is **O(1/256)**: header (1,024 B) + one fanout slice
  (39,305 B, 1,123 rows for this repo) = **40,329 B = 0.39 % of the full locator**, returning
  the correct `(offset, length, span)` (`scripts/locator_lookup.py`, verified over MinIO
  *and* the IPFS gateway). Slice size scales as objects/256 (~13 KB at 100k objects — matches
  the §2.3 "~12 KB per fanout slice" figure).

**flatIndex** (`artifacts/flatIndex.bin*`, `scripts/build_flatindex.py`), 14,178 rows
(10,336 blobs + 3,841 trees + 1 injected gitlink mode 160000):

| Encoding | bytes | B/row | B/file |
|---|---|---|---|
| raw | 1,439,795 | 101.6 | — |
| **gzip -9** | **482,173** | 34.0 | **46.6** |
| zstd -19 | 453,520 | 32.0 | 43.8 |

- The **gitlink (mode 160000) path works** — injected `vendor/libsubmodule` renders as a
  `commit`-type row with its pinned OID.
- vs the **~30 B/file** estimate: measured **46.6 B/file gzipped** — the estimate is
  **optimistic**; a deep monorepo has long paths (Rust crate trees), and per-file compressed
  cost is ~47 B, not 30. Extrapolated: **~471 KB at 10k files, ~4.5 MB at 100k files.** This
  is the pivot for the cold-load budget (§5).

## 4. Ranged reads per backend

| Backend | Upload/add | HEAD Accept-Ranges | README blob (span 6,173 B of a 3 GB pack) | OID verified |
|---|---|---|---|---|
| **MinIO S3** | 3.06 GB in 8.8 s (347 MB/s) | ✅ | 206, 6,173 B, **18.8 ms** | ✅ |
| **kubo IPFS gateway** | 3.06 GB add in 4.3 s | ✅ | 206 **at 156 MB offset in the DAG**, 6,173 B, **9.3 ms** | ✅ |
| **nginx static-http** | (existing fixture) | ✅ | 206 (small-fixture probe) | n/a |

- **All three backends honour HTTP Range (206 Partial Content).**
- **IPFS gateway Range = YES** — the decisive answer for the design. Kubo walks the UnixFS
  DAG and serves the exact byte range; internally it fetches only the ~1–2 touched 256 KB
  blocks, so client transfer is O(range). A 6 KB read out of a 3 GB DAG returned in 9 ms.
- The reconstruction (OFS delta application + git-OID check) is implemented in
  `scripts/ranged_read.py` and passes for blobs *and* trees.

## 5. Cold repo-home budget (< 500 KB / < 3 s at any size)

`scripts/cold_load.py`, real requests. refs+config+manifest reads stubbed at 10 KB
(proof-verified single-doc DAPI reads, per architecture).

| Scenario | Path | Bytes | Time | Budget |
|---|---|---|---|---|
| **A** — architecture §6.3 literal | refs/config + **full flatIndex.gz** + README via locator | **538,675 B (526 KB)** | 32 ms (MinIO) | ❌ **FAIL** |
| **B** — root-tree model | refs/config + **root tree** (per-base) + README, both via locator; flatIndex deferred | **103,069 B (101 KB)** | 7 ms MinIO / 24 ms IPFS | ✅ **PASS** |

- **Scenario A fails at only 10k files** — the full flatIndex (471 KB gz) alone nearly
  exhausts the 500 KB budget, and it grows O(files) (~4.5 MB at 100k files). The
  "< 500 KB **at any size**" promise is **false** if the home page eagerly fetches the full
  flatIndex.
- **Scenario B passes and is size-independent** — the home page needs only the **root
  directory listing** (root tree object) + README, both O(view) ranged reads. The full
  flatIndex belongs to the `/tree` explorer and filename-search views, fetched lazily (where
  its O(files) size is acceptable behind a spinner).
- Time is not the constraint (all views ≤ tens of ms locally; ~5–6 sequential requests ≈
  0.5–1 s on a ~100 ms-RTT remote). The only latency risk is the **per-base root-tree walk
  (29 RTTs)** — handled by the span-threshold fallback in §2.

## 6. Staleness overlay

Indexed tip = HEAD~5; reconstruct the current tree by walking the 5 later commits' tree diffs
via locator, **without re-downloading the flatIndex**. Churn: 43 changed files, **47 changed
trees**, 7 commits (rev-list includes merge parents).

| Overlay cost (transfer to rebuild current tree structure) | bytes |
|---|---|
| 47 changed trees — **per-base** reads | 27,379 B |
| 7 commit objects (depth 0) | 6,170 B |
| recent per-pack offset index to locate ~95 objects (~30 B/obj) | ~2,850 B |
| **overlay total** | **~36 KB** |
| — vs full flatIndex re-download | 471 KB (**~13× cheaper**) |
| — vs same 47 trees via **single-span** reads | **24,751,565 B (24.75 MB) — unusable** |

- The overlay is **~13× cheaper than re-fetching the flatIndex**, confirming the design's
  "never fall back to a full walk" claim — **but only via per-base tree reads.** The
  single-span path would be 50× *more* expensive than just re-downloading flatIndex.
- Overlay objects are the **newest** objects, located via the small **per-pack offset
  indexes of recent pushes** (the mandated `offsetIndexParts ≥ 1` for kind-0 packs), *not*
  via 40 KB merged-locator slices — the offset-index mandate is what keeps the overlay cheap.
- The design's 20-push / 24 h batching bound keeps this cost bounded; at 20 commits the
  changed-tree set is ~4× this and still well under a flatIndex re-fetch.

---

## 7. Required corrections to the design

**data-contracts §2.3 — objectLocator row layout:**
1. **`deltaChainSpan` must not be a 2-byte field.** 29 % of objects overflow 64 KB (max
   107 MB). Use **4 bytes** (covers the observed 107 MB max) or a varint. Row size becomes
   ~34–35 B/object (the "~32 B/object" headline stays roughly right).
2. **`length` should be 4 bytes, not 3** (40 objects exceed 16 MB on-disk; max 107 MB).
   `offset` at 5 bytes is correct and necessary.
3. **Add a delta hint the reader can act on without fetching the whole span** — store the
   chain **depth** (1 byte) and/or the OFS base back-pointer. `deltaChainSpan` alone cannot
   tell a reader whether a single-span read (great for blobs) or a per-base walk (mandatory
   for trees) is cheaper. Normative reader rule: **use the single-span read when
   `span ≤ threshold` (≈ 64 KB), else per-base chain-walk.** Blobs almost always take the
   fast path (median 1.21× over-fetch); trees almost always take the walk.

**architecture §6.3 — cold-load path & flatIndex sizing:**
4. **flatIndex is O(files), not "tens of KB."** Measured 471 KB gz at 10k files (~4.5 MB at
   100k). The line "flatIndex (tens of KB)" holds only for small repos.
5. **The cold repo-home path must not eagerly fetch the full flatIndex.** Rewrite the cold-
   load path as: refs + config → **root tree via locator** (top-level listing) → README blob
   via locator = **~100 KB, size-independent, < 500 KB / < 3 s**. flatIndex loads lazily for
   the tree-explorer and filename-search views. As written (flatIndex in the home path) the
   budget fails at ~10k files.
6. (nice-to-have) flatIndex breaks ranged access because it is gzip'd whole. A **path-prefix
   fanout with per-slice compression** would let the `/tree` view fetch only a subtree —
   worth considering if lazy-whole-file load proves too heavy for very large repos.

**Confirmed as-is (no change):** fix-thin self-contained-pack mandate; OFS_DELTA intra-pack
contiguity; mandatory per-pack offset index (it is exactly what makes the staleness overlay
cheap); objectLocator fanout O(1/256) lookup; ~32 B/object locator headline; IPFS/S3/HTTP
external-backend ranged reads; gitlink (mode 160000) handling in flatIndex.

## 8. Reproduce

```
# repack subject into one self-contained pack
git clone --mirror --local /Users/pasta/workspace/platform /tmp/plat-mirror
git -C /tmp/plat-mirror repack -adf --window=50
IDX=$(ls /tmp/plat-mirror/objects/pack/pack-*.idx); PACK=${IDX%.idx}.pack
# build artifacts
python3 scripts/build_locator.py   "$IDX" "$PACK" artifacts/objectLocator.bin
python3 scripts/analyze_span.py    "$IDX" "$PACK" 0335eceed4fef419b45101e0fd171a609fd2bc73
python3 scripts/build_flatindex.py /tmp/plat-mirror 25e6c1b… artifacts/flatIndex.bin
# ranged-read verify (per backend URL)
python3 scripts/ranged_read.py  "$IDX" "$PACK" <oid> <pack-url> <label>   # single-span
python3 scripts/perbase_read.py "$IDX" "$PACK" <oid> <pack-url> <label>   # per-base
python3 scripts/locator_lookup.py <locator-url> <oid>                     # fanout slice
python3 scripts/cold_load.py    <backend-base-url>                        # cold-home budget
```

Artifacts + machine-readable stats: `artifacts/{objectLocator.bin,flatIndex.bin*,
span_analysis.json,*.stats.json}`. On-backend copies: MinIO `forge-packs/s0.5/*`,
IPFS pack CID `bafybeicfuoyxew5v2lweobndaxy57mvhte4beblwlvgh75ktzwf5qltp2a`.
