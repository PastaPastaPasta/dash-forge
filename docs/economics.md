# Dash Forge — Storage Economics & Fee Minimization

How bytes are compressed before they ever hit Platform, what each byte costs, and which data can be deleted and refunded. The fee constants are Platform's `FEE_VERSION3` (`rs-platform-version/src/version/fee/v3.rs`, in use from protocol 14); the per-write figures are the ones measured on devnets and used by the cost engines (`forge_core::cost::push_fees` in `crates/forge-core/src/cost.rs`, and `forge-web/lib/sdk/cost.ts`). **Every measured figure here is from a devnet and is to be re-measured on testnet (Platform 5.0.0-rc.4)**, which uses the same fee schedule. The on-chain model is forge-v2 ([contracts/forge-v2.md](contracts/forge-v2.md)). [guides/costs.md](guides/costs.md) is the one table of what Forge costs, and wins if the two ever disagree.

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
| Aggressive repack (`git repack -F --window=250 --depth=100` equivalent) | typically 10–30% over default packing | `dg repack` always uses max-effort settings — CPU is free, bytes cost ~27.7k credits each |
| Per-push browse-index fragment | *mandatory* for git packs (36 B per object **in that push** — an incremental push indexes a handful of objects) | it is the only random-access path to objects newer than the last repack; skipping it would break fresh-push browsing |
| Browse artifacts (`objectLocator` ~34–36 B/object, `flatIndex` O(files): ~471 KB @ 10k files, ~4.5 MB @ 100k — S0.5) | *cost*, not saving: ~3.5 MB locator + ~4.5 MB flatIndex ≈ **~8 MB deposit** for a 100k-object repo on platform backend (negligible external) | supersedable, but on the Platform tier a superseded artifact's chunks stay (non-deletable), so each republish adds to the permanent deposit; the locator is published as per-push fragments and folded every 16, so a push pays for its own objects rather than republishing the whole index; flatIndex batched on hyperactive repos (20 pushes / 24 h) |
| zstd-wrapping chunks | marginal (~3–8%, pack is already deflated) | evaluated in S0.2; only adopted if measured gain beats the added format complexity |

## 2. What a byte costs (credits; 1 DASH = 10¹¹ credits)

| Component | Credits | Refundable? | Source |
|---|---|---|---|
| Storage (prepaid, ~50-year horizon) | **27,000 per byte** | **Yes, for deletable types** (see §3) | `fee/storage/v1.rs` (`FEE_VERSION3`) |
| Storage processing | 400 per byte | No | same |
| A `chunk` document, per byte of its signed transition | **27,700** (measured 27,450–27,650) | No: chunks are permanent | `push_fees::CHUNK_PER_BYTE` |
| Per-document fixed cost, on top of the bytes | see below | No | `push_fees`, `costs.md` |

The fixed cost per document is **not small**. A document pays for its index entries, whatever its size, and it dominates every small write. Measured on devnets (credits):

| Document | Fixed cost beyond its bytes | Where measured |
|---|---|---|
| `chunk` | measured 69M (the network's first chunks, a shallow tree), 98M (the dashpay/dash import, 6,438 chunks in the tree), up to a fitted 110–115M at 2^16 chunks. It grows by about 7M per level of the network-wide chunk tree. The quote allows **140M**, an estimator allowance, not a measured minimum | beta.6 showcase imports; `CHUNK_FLAT` |
| `packManifest` | first 129.46M, later 81.07–81.77M (quoted 140M / 90M) | testnet, Platform 5.0.0-rc.4, 2026-10-17 |
| `refUpdate` | first 88–90M, later 57–67M (quoted 92M) | same |
| issue, comment, review, event | roughly 35–100M, which is 0.0004–0.001 DASH as a whole write | [guides/costs.md](guides/costs.md#what-each-action-costs) |

Headline numbers:

- **A retained byte costs ~27,700 credits**, so **1 MiB of pack on Platform costs 0.33–0.36 DASH measured** (the bytes alone are 0.29 DASH; the rest is each chunk's fixed cost), and `dg` and `git push` quote up to 0.39 DASH/MiB. The CLIs show the fiat equivalent using live mainnet rates when available; test-network costs label that equivalent “on mainnet”, and testnet balances have no cash value.
- **Pack bytes on the Platform tier are permanent.** `chunk` and `packManifest` are non-deletable on forge-v2 (owner decision 2026-09-25: an unbreakable repository outweighs the refund), so their deposit is a one-time cost, never refunded. A byte in a *deletable* document (comment, review, label, ...) that is later deleted permanently costs only the **non-refundable ~1.5%** (≈ 412 credits + the elapsed-epoch share of storage, §3).

This is why chunk geometry maximizes fill (3 × 4,900 B fields → ~14.4 KiB/doc): the fixed cost per chunk amortizes over as many bytes as fit, and why external backends exist: a manifest-only push is a few hundred bytes of payload (about 0.004–0.0055 DASH in all, measured on bonsia), and bulky pack bytes in a bucket the user controls can be garbage-collected there.

Writing requires a `maintainer` or `writer` membership document, which consensus checks on create; membership carries no per-write charge. The money on a push is the storage deposit plus the non-refundable processing burn and the per-document fixed costs above.

## 3. Refunds: how deletion gives money back

Mechanics (verified: `fee/epoch/distribution.rs::calculate_storage_fee_refund_amount_and_leftovers`, `drive/document/delete`):

- The 27,000/byte deposit is **spread across 2,000 epochs** (50 eras × 40 epochs) per a fixed distribution table (`FEE_DISTRIBUTION_TABLE`). On mainnet an epoch is 788,400 s, or 9.125 days (`default_epoch_time_length_s` in `rs-drive-abci/src/config.rs`), so 2,000 epochs last about 50 years; on testnet an epoch is 1 hour, so the schedule lasts about 83 days.
- On document deletion, **every epoch share from `current_epoch + 1` onward is refunded** to the identity that paid (the document owner). Only the share already consumed by elapsed epochs — plus rounding leftovers — is kept.
- On mainnet, delete within weeks-to-months of writing → recover the overwhelming majority of the deposit (the elapsed slice of a 50-year schedule). On testnet the same schedule runs in about 83 days (a delete after 1 day gets back about 97 %, after 7 days about 80 %, after 30 days about 36 %, after about 83 days nothing), so UI copy says "refunds about X if deleted soon; less as it ages". X approximates an immediate deletion, not an upper or lower bound. The refund lands as identity credits, immediately spendable on the next push.
- Processing fees (the ~412 credits/byte + bases) are never refunded — that's the true "cost of churn."

Constraints:

- **Only the document's owner can delete it** — refunds are per-writer. A delete is never reference-checked, so this holds even after the writer's membership is revoked.
- **Non-deletable types forgo refunds deliberately** ([forge-v2.md §4](contracts/forge-v2.md#4-non-deletable-audit-types)): `refUpdate`, `protectedRefUpdate`, `config`, `packManifest`, `chunk`, `release` (unpublishing is a new revision, RC1 O-04), `event`, `authorEvent`, `transition`, `issue`, `patch`, `repo`, `repoKey`. Deleting any of them would let a writer rewind a branch, rewrite a thread, or pull pack bytes out from under refs that other people's history points into. Still deletable, and so refundable to their author: `comment`, `review`, `label`, `checkRun`, `webhook`, `profile`, `star`, `follow`, and the membership documents.
- Honesty about aggregates: the audit trail **grows unbounded with activity and is never reclaimed**. One ref update costs 0.0006–0.0009 DASH ([guides/costs.md](guides/costs.md#refunds)), so **~0.6–0.9 DASH per 1,000 pushes** in ref updates alone, and a monorepo with 50k historical pushes has ~30–45 DASH permanently locked in its reflog. A checkpoint/compaction scheme for ancient reflog is a named open design question.

## 4. Old, no-longer-relevant data

Git never deletes eagerly and neither does Forge — objects become *unreachable* (force-push, branch delete, PR closed unmerged). What happens to them depends on where the packs live.

**Platform tier: repack only consolidates.**

1. **`dg repack`** builds one consolidated max-compression pack of all *currently reachable* objects and uploads it.
2. The new `packManifest` lists `supersedes: [old packHashes]` — readers prefer it and read fewer packs.
3. Nothing is deleted: the superseded `chunk`/`packManifest` documents are non-deletable, stay readable as a fallback, and keep their deposit. The consolidated pack is an *additional* deposit.

So on the Platform tier **a repo's locked deposit is its cumulative push history plus any repacks**, not its current size. Repack there for read performance, not for cost.

**External tier (S3-compatible, IPFS): garbage collection is the user's.** Only the `packManifest` (a few hundred bytes) is on Platform; the pack bytes are in storage the user controls. After a repack writes a superseding pack, the old objects in the bucket can be deleted to stop paying the provider. This is the tier to use for large or fast-churning repositories.

## 5. Per-scenario cost sketch

All in DASH, **measured on devnets** (to be re-measured on testnet); fiat figures in the CLIs use live mainnet rates when available. Historical dollar examples below are illustrative; testnet balances have no cash value.

| Scenario | Platform backend | External backend |
|---|---|---|
| Create a public repository (`repo` + owner's `maintainer` + first `config`), members-only content on (the default) | **~0.0027 DASH** one-time: ~0.0016 for the three documents plus ~0.0011 for the members-only key (measured on Platform v4.2 and v5 devnets); not refundable, all are kept | same |
| Create a private repository | ~0.0020 DASH (adds the key and the first anchor) | same |
| Fork a repo | ~0.01 DASH for a small repository and 0.03 for a 36-pack one: one small manifest per pack and one ref update per branch; the parent's packs are referenced, never re-uploaded | same |
| Push 100 KiB source delta (~30 KiB packed) | about 0.015–0.02 DASH (~$0.45–0.60): 0.33–0.36 DASH/MiB for the packed bytes plus ~0.004–0.011 for the manifests, ref update and history index. Permanent | ~0.004–0.0055 DASH (~$0.12–0.17): manifests and the ref update only |
| 1,000 issues + 5,000 comments over a year | **~3.1–4.5 DASH** (~$95–135) for short bodies (issues 0.0006–0.001 each, comments 0.0005–0.0007 each; more with long bodies). Issues are permanent, comments refundable on delete | same (always on Platform) |
| Remove one member from a 50-member repository with members-only content | ~0.035 DASH: the key is changed for the 49 who remain ([guides/costs.md](guides/costs.md#members-only-and-private-content)) | same |
| Force-push away 10 MiB of history, then repack | nothing recovered; the repack adds a deposit for the consolidated pack | delete the old objects in your bucket |
| Deployer: register the production set (once per network) | **~1.86 DASH for the four contracts** (0.5968 + 0.3963 + 0.5063 + 0.3636), measured on a Platform v5 devnet, and 1.873 DASH on testnet (2026-10-26); ~1.73 DASH for the three-contract devnet set ([Deploying Forge to a network](deploying-to-a-network.md#4-what-it-costs), [forge-v2.md §7](contracts/forge-v2.md#7-measured-size-and-cost)) | same |

## 6. Fee-minimization checklist (encoded in defaults)

1. External or mixed backend for anything bulky (the biggest lever by 100×).
2. Store the smaller of the two locator-quality push-pack candidates (`build_pack`); max-effort compression at repack.
3. Fill chunks to ~14.4 KiB. Each push also publishes its **browse-index fragment** — a locator over just that pack, 36 B per object the push added. It is the only random-access path to objects newer than the last repack, and it replaces the per-pack offset index (`manifestPart`) the design originally called for: same role, but it is the same artifact and the same reader as the repack-time index, rather than a second format. RC1 removed `manifestPart` and `packManifest.offsetIndexParts` from the contract (R-09), so the format version a history index (kind 3) kept there (0 = v1, 2 = with per-path version lists) moves into the artifact's own header (the client follow-up to #168).
4. Repack on the external tier and garbage-collect the bucket; on the Platform tier repack only for read performance (it adds a deposit and refunds nothing).
5. Keep social docs lean (5 KiB body cap already enforces this); `documentsKeepHistory` means every edit re-deposits the doc — the UI shows edit cost like any write.
6. Cost engine displays deposit vs burn separately (DASH primary).
