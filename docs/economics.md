# Dash Forge — Storage Economics & Fee Minimization

How bytes are compressed before they ever hit Platform, what each byte costs, and which data can be deleted and refunded. Constants verified in `../platform` (protocol v12 era). The on-chain model is forge-v2 ([contracts/forge-v2.md](contracts/forge-v2.md)); the user-facing summary is [guides/costs.md](guides/costs.md).

## 1. Compression: blobs are never stored raw

Forge stores **git packfiles**, not loose blobs, at every layer (push transport, `chunk` docs, external backends). A packfile applies two compression stages:

1. **Delta compression** — similar objects (successive versions of a file, similar trees) stored as diffs against a base.
2. **zlib deflate** — every object/delta individually compressed.

Typical source repos pack to **20–35% of checkout size**. A push stores the compressed change as one self-contained pack: `git pack-objects --revs --delta-base-offset` over `want ^have`, with every delta base inside the pack.

> **Corrected (was: store the `index-pack --fix-thin` pack; "0.9–4.4% premium").** The stored pack must be **locator-quality**, not merely self-contained: `--fix-thin` appends the materialized delta bases at the END of the pack, after the deltas that reference them, leaving `REF_DELTA` and non-contiguous objects that the `objectLocator` must refuse. A pack in that shape can be stored but never browsed without a whole-repo client-side clone — which is what every repo the shipped tooling produced was stuck with.
>
> Re-emitting the same object set non-thin fixes the order for **0.995–1.000** of the completed pack's size, so the index is essentially free. What is NOT free either way is the choice of object set, and neither option dominates: packing the delta non-thin avoids materializing any base, but forfeits the cheap deltas against what the remote already has. Stored bytes ÷ the old completed pack — **1.000** first push, **0.849 / 0.879 / 0.882** for 1 / 5 / 20 sequential commits of this repo, but **1.373** for one push of 20 branch tips off a shared base. So `build_pack` builds both candidates and stores the smaller.
>
> The published "0.9–4.4% premium" (S0.5 §1) is `(fixed − thin) / thin` — a ratio against the thin pack, which is never stored. On that spike's 2.85 GiB corpus the thin baseline is 0.16–5.3 MB against only 2–234 materialized bases, so the appended bytes read small; the same formula on this repo's pushes is 150–440%. It was never a measurement of the completed pack against the alternative that would otherwise be stored.

Additional levers on top:

| Lever | Gain | When |
|---|---|---|
| Aggressive repack (`git repack -F --window=250 --depth=100` equivalent) | typically 10–30% over default packing | `dg repack` always uses max-effort settings — CPU is free, bytes cost 27k credits each |
| Per-push browse-index fragment | *mandatory* for git packs (36 B per object **in that push** — an incremental push indexes a handful of objects) | it is the only random-access path to objects newer than the last repack; skipping it would break fresh-push browsing |
| Browse artifacts (`objectLocator` ~34–36 B/object, `flatIndex` O(files): ~471 KB @ 10k files, ~4.5 MB @ 100k — S0.5) | *cost*, not saving: ~3.5 MB locator + ~4.5 MB flatIndex ≈ **~8 MB deposit** for a 100k-object repo on platform backend (negligible external) | supersedable, but on the Platform tier a superseded artifact's chunks stay (non-deletable), so each republish adds to the permanent deposit; the locator is published as per-push fragments and folded every 16, so a push pays for its own objects rather than republishing the whole index; flatIndex batched on hyperactive repos (20 pushes / 24 h) |
| zstd-wrapping chunks | marginal (~3–8%, pack is already deflated) | evaluated in S0.2; only adopted if measured gain beats the added format complexity |

## 2. What a byte costs (credits; 1 DASH = 10¹¹ credits)

| Component | Credits/byte | Refundable? | Source |
|---|---|---|---|
| Storage (prepaid, ~50-year horizon) | **27,000** | **Yes, for deletable types** (see §3) | `fee/storage/v1.rs` |
| Storage processing | 400 | No | same |
| ST processing | 12 | No | `default_costs/constants.rs` |
| Per-document bases (write 6,000 + seek 2,000 + ST base 10,000) | ~18k/doc (~1.2 credits/byte at 15 KiB fill) | No | same |

Two headline numbers fall out:

- **A retained byte costs ~27,400 credits** (~$9.30/MiB @ $34/DASH) — almost all of it a storage deposit.
- **Pack bytes on the Platform tier are permanent.** `chunk` and `packManifest` are non-deletable on forge-v2 (owner decision 2026-09-25: an unbreakable repository outweighs the refund), so their deposit is a one-time cost, never refunded. A byte in a *deletable* document (comment, review, label, ...) that is later deleted permanently costs only the **non-refundable ~1.5%** (≈ 412 credits + the elapsed-epoch share of storage, §3).

This is why chunk geometry maximizes fill (3 × 4,900 B fields → ~14.4 KiB/doc): per-doc base fees amortize to noise, and why external backends exist: a manifest-only push is a few hundred bytes total, and bulky pack bytes in a bucket the user controls can be garbage-collected there.

Writing requires a `maintainer` or `writer` membership document, which consensus checks on create; membership carries no per-write charge. The only money on a push is the storage deposit plus the small non-refundable processing burn above.

## 3. Refunds: how deletion gives money back

Mechanics (verified: `fee/epoch/distribution.rs::calculate_storage_fee_refund_amount_and_leftovers`, `drive/document/delete`):

- The 27,000/byte deposit is **spread across 2,000 epochs** (50 eras × 40 epochs; 1 epoch ≈ 18 days) per a fixed distribution table.
- On document deletion, **every epoch share from `current_epoch + 1` onward is refunded** to the identity that paid (the document owner). Only the share already consumed by elapsed epochs — plus rounding leftovers — is kept.
- Delete within weeks-to-months of writing → recover the overwhelming majority of the deposit (the elapsed slice of a 50-year schedule). The refund lands as identity credits, immediately spendable on the next push.
- Processing fees (the ~412 credits/byte + bases) are never refunded — that's the true "cost of churn."

Constraints:

- **Only the document's owner can delete it** — refunds are per-writer. A delete is never reference-checked, so this holds even after the writer's membership is revoked.
- **Non-deletable types forgo refunds deliberately** ([forge-v2.md §4](contracts/forge-v2.md#4-non-deletable-audit-types)): `refUpdate`, `protectedRefUpdate`, `config`, `packManifest`, `chunk`, `release` (unpublishing is a new revision, RC1 O-04), `event`, `authorEvent`, `transition`, `issue`, `patch`, `repo`, `repoKey`. Deleting any of them would let a writer rewind a branch, rewrite a thread, or pull pack bytes out from under refs that other people's history points into. Still deletable, and so refundable to their author: `comment`, `review`, `label`, `checkRun`, `webhook`, `profile`, `star`, `follow`, and the membership documents.
- Honesty about aggregates: the audit trail **grows unbounded with activity and is never reclaimed** — ~0.08 DASH per 1,000 pushes in ref updates alone, so a monorepo with 50k historical pushes has ~4 DASH (~$135) permanently locked in reflog. A checkpoint/compaction scheme for ancient reflog is a named open design question.

## 4. Old, no-longer-relevant data

Git never deletes eagerly and neither does Forge — objects become *unreachable* (force-push, branch delete, PR closed unmerged). What happens to them depends on where the packs live.

**Platform tier: repack only consolidates.**

1. **`dg repack`** builds one consolidated max-compression pack of all *currently reachable* objects and uploads it.
2. The new `packManifest` lists `supersedes: [old packHashes]` — readers prefer it and read fewer packs.
3. Nothing is deleted: the superseded `chunk`/`packManifest` documents are non-deletable, stay readable as a fallback, and keep their deposit. The consolidated pack is an *additional* deposit.

So on the Platform tier **a repo's locked deposit is its cumulative push history plus any repacks**, not its current size. Repack there for read performance, not for cost.

**External tier (S3-compatible, IPFS): garbage collection is the user's.** Only the `packManifest` (a few hundred bytes) is on Platform; the pack bytes are in storage the user controls. After a repack writes a superseding pack, the old objects in the bucket can be deleted to stop paying the provider. This is the tier to use for large or fast-churning repositories.

## 5. Per-scenario cost sketch (@ $34/DASH)

| Scenario | Platform backend | External backend |
|---|---|---|
| Create repo (`repo` + owner's `maintainer` + first `config`) | **~0.001 DASH** one-time (estimate from the storage rate; not refundable, all three are kept). The v1 per-repo contract cost ~1.18 DASH. | same |
| Fork a repo | ~0.001 DASH plus one small manifest per pack and one ref update per branch (measured on moutai: 0.03 DASH for a 36-pack repo); the parent's packs are referenced, never re-uploaded | same |
| Push 100 KiB source delta (~30 KiB packed) | ~$0.28 deposit (permanent) + ~$0.005 burn | ~$0.01 (manifest + refUpdate only) |
| 1,000 issues + 5,000 comments over a year | ~$25–60 deposit; issues are permanent, comments refundable on delete | same (always on Platform) |
| Force-push away 10 MiB of history, then repack | nothing recovered; the repack adds a deposit for the consolidated pack | delete the old objects in your bucket |
| Deployer: register forge-v2 (once per network) | forge-core 0.60 + forge-collab 0.55 DASH in fees, 1.161234 DASH measured on moutai including storage ([forge-v2.md §7](contracts/forge-v2.md#7-measured-size-and-cost)) | same |

## 6. Fee-minimization checklist (encoded in defaults)

1. External or mixed backend for anything bulky (the biggest lever by 100×).
2. Store the smaller of the two locator-quality push-pack candidates (`build_pack`); max-effort compression at repack.
3. Fill chunks to ~14.4 KiB. Each push also publishes its **browse-index fragment** — a locator over just that pack, 36 B per object the push added. It is the only random-access path to objects newer than the last repack, and it replaces the per-pack offset index (`manifestPart`) the design originally called for: same role, but it is the same artifact and the same reader as the repack-time index, rather than a second format. RC1 removed `manifestPart` and `packManifest.offsetIndexParts` from the contract (R-09), so the format version a history index (kind 3) kept there (0 = v1, 2 = with per-path version lists) moves into the artifact's own header (the client follow-up to #168).
4. Repack on the external tier and garbage-collect the bucket; on the Platform tier repack only for read performance (it adds a deposit and refunds nothing).
5. Keep social docs lean (5 KiB body cap already enforces this); `documentsKeepHistory` means every edit re-deposits the doc — the UI shows edit cost like any write.
6. Cost engine displays deposit vs burn separately (DASH primary).
