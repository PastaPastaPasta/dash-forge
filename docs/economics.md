# Dash Forge — Storage Economics & Fee Minimization

How bytes are compressed before they ever hit Platform, what each byte costs, and how obsolete data is deleted and refunded. Constants verified in `../platform` (protocol v12 era).

## 1. Compression: blobs are never stored raw

Forge stores **git packfiles**, not loose blobs, at every layer (push transport, `chunk` docs, external backends). A packfile applies two compression stages:

1. **Delta compression** — similar objects (successive versions of a file, similar trees) stored as diffs against a base.
2. **zlib deflate** — every object/delta individually compressed.

Typical source repos pack to **20–35% of checkout size**; pushes are *thin packs* (deltas against objects the remote already has), so an incremental push costs roughly the compressed size of the change, not the file.

Additional levers on top:

| Lever | Gain | When |
|---|---|---|
| Aggressive repack (`git repack -F --window=250 --depth=100` equivalent) | typically 10–30% over default packing | `dg repack` always uses max-effort settings — CPU is free, bytes cost 27k credits each |
| Skipping the per-object offset index | saves `manifestPart` bytes (~24 B/object) | `offsetIndexParts: 0` default — the merged `objectLocator` is the primary random-access path; per-pack indexes only bridge pushes between repacks |
| Browse artifacts (`objectLocator` ~26 B/object, `flatIndex` ~30 B/file compressed) | *cost*, not saving: ~0.5–3 MB deposit for a 100k-object repo on platform backend (negligible external) | supersedable — steady-state deposit is one copy; churn burn ~1.5% per republish. What they buy: size-independent browsing (see architecture §6.3) |
| zstd-wrapping chunks | marginal (~3–8%, pack is already deflated) | evaluated in S0.2; only adopted if measured gain beats the added format complexity |

## 2. What a byte costs (credits; 1 DASH = 10¹¹ credits)

| Component | Credits/byte | Refundable? | Source |
|---|---|---|---|
| Storage (prepaid, ~50-year horizon) | **27,000** | **Yes** (see §3) | `fee/storage/v1.rs` |
| Storage processing | 400 | No | same |
| ST processing | 12 | No | `default_costs/constants.rs` |
| Per-document bases (write 6,000 + seek 2,000 + ST base 10,000) | ~18k/doc (~1.2 credits/byte at 15 KiB fill) | No | same |

Two headline numbers fall out:

- **A retained byte costs ~27,400 credits** (~$9.30/MiB @ $34/DASH) — almost all of it a refundable deposit.
- **A churned byte** (stored, then deleted after a repack) permanently costs only the **non-refundable ~1.5%** (≈ 412 credits + the elapsed-epoch share of storage, §3) ≈ **~$0.15–0.30/MiB**.

This is why chunk geometry maximizes fill (3 × 4,900 B fields → ~14.4 KiB/doc): per-doc base fees amortize to noise, and why external backends exist: a manifest-only push is a few hundred bytes total.

## 3. Refunds: how deletion gives money back

Mechanics (verified: `fee/epoch/distribution.rs::calculate_storage_fee_refund_amount_and_leftovers`, `drive/document/delete`):

- The 27,000/byte deposit is **spread across 2,000 epochs** (50 eras × 40 epochs; 1 epoch ≈ 18 days) per a fixed distribution table.
- On document deletion, **every epoch share from `current_epoch + 1` onward is refunded** to the identity that paid (the document owner). Only the share already consumed by elapsed epochs — plus rounding leftovers — is kept.
- Delete within weeks-to-months of writing → recover the overwhelming majority of the deposit (the elapsed slice of a 50-year schedule). The refund lands as identity credits, immediately spendable on the next push.
- Processing fees (the ~412 credits/byte + bases) are never refunded — that's the true "cost of churn."

Constraints that shape the GC design:

- **Only the document's owner can delete it** — refunds are per-uploader. Each collaborator prunes (and recoups) their own docs.
- **Frozen identities can't pay `tokenCost.delete`** — a revoked collaborator's chunks stay put (availability protected); their deposit stays locked with the docs. The repo can re-store those objects in a new pack and simply carry the orphan cost.
- **Non-deletable audit types** (`refUpdate`, `protectedRefUpdate`, `event`, `config`) forgo refunds deliberately — at 200–400 bytes each (~0.00008 DASH) the deposit is negligible and the rewind-proof audit trail is worth more.

## 4. How old, no-longer-relevant data actually gets deleted

Git never deletes eagerly and neither does Forge — objects become *unreachable* (force-push, branch delete, PR closed unmerged) and are collected at repack:

1. **`dg repack`** builds one consolidated max-compression pack of all *currently reachable* objects and uploads it (platform chunks or external).
2. New `packManifest` lists `supersedes: [old packHashes]` — readers immediately prefer it.
3. The repacker **deletes their own superseded `chunk`/`packManifest`/`manifestPart` docs** (WRITE-gated deletes) → storage refund flows back to them.
4. Unreachable objects simply aren't in the new pack — their bytes are gone from Platform and their deposit refunded. Reachable objects were re-stored in step 1 before anything was deleted (no availability gap).

Steady-state result (the INIT.md promise): **a long-lived repo's locked deposit ≈ its current packed size, not its cumulative push history**; the permanent spend is ~1.5% of bytes ever churned plus retained-byte deposits.

Suggested cadence (`dg doctor` nags): repack when superseded-but-undeleted bytes exceed ~2× current pack size, or before a large history rewrite lands. `dg cost audit` reports: locked deposit, reclaimable-now amount, lifetime non-refundable spend.

## 5. Per-scenario cost sketch (@ $34/DASH)

| Scenario | Platform backend | External backend |
|---|---|---|
| Create repo (contract + config + listing) | < $0.10 one-time | same |
| Push 100 KiB source delta (~30 KiB packed) | ~$0.28 deposit + ~$0.005 burn | ~$0.01 (manifest + refUpdate only) |
| 1,000 issues + 5,000 comments over a year | ~$25–60 deposit (refundable on delete) | same (always on Platform) |
| Force-push away 10 MiB of history, then repack | recover ~$90 deposit; ~$1.50–3 burned | n/a (bytes were external) |
| Delete whole repo | recover ~all chunk/manifest deposits; audit docs' dust + parked contract remain | recover listing/manifest dust |

## 6. Fee-minimization checklist (encoded in defaults)

1. External or mixed backend for anything bulky (the biggest lever by 100×).
2. Thin packs always; max-effort compression at repack.
3. Fill chunks to ~14.4 KiB; skip the offset index unless partial clone is wanted.
4. Repack regularly — refunds fund future pushes; surface reclaimable credits in `dg cost audit`.
5. Keep social docs lean (5 KiB body cap already enforces this); `documentsKeepHistory` means every edit re-deposits the doc — the UI shows edit cost like any write.
6. Cost engine displays deposit vs burn separately (DASH primary), so users learn that most of a platform push is a *recoverable deposit*, not a fee.
