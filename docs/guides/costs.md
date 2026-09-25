# What things cost

Forge charges nothing. Nobody runs it, so nobody takes a cut. What you pay goes to two places: **Dash Platform fees**, paid from your identity's credits, and **your own storage provider's bill**, if you use one. Reading, cloning and browsing are free.

Amounts are in **DASH**. Dollar figures are examples at **$30/DASH**, the same fallback price `dg` uses (set `DASH_USD` to change it).

1. [Credits](#credits)
2. [Deposits and burns](#deposits-and-burns)
3. [What each action costs](#what-each-action-costs)
4. [Platform or your own bucket](#platform-or-your-own-bucket)
5. [Refunds](#refunds)
6. [Seeing costs before you pay](#seeing-costs-before-you-pay)

---

## Credits

Platform fees are paid in **credits**, from your identity's balance. **1 DASH = 100,000,000,000 credits.**

You get credits by locking Dash into your identity from any Dash wallet: when you create the identity, or later with a top-up (the bridge's **Top Up Existing Identity**). Forge does not sponsor identities, and mainnet has no faucet. Testnet Dash is free, from the faucet.

```sh
dg auth balance
```

```
Identity: 8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB
Balance:  48210000000 credits  (~0.482100 DASH)
```

When the balance runs out, writes fail with [`E401`](../errors.md#e401). Reads keep working, and nothing you stored is lost.

---

## Deposits and burns

Every byte you store on Platform costs about **27,400 credits**. Almost all of that is a **deposit**:

| Part | Credits per byte | Comes back? |
|---|---|---|
| Storage deposit | 27,000 | **Yes**, mostly, if the document is deleted (see [Refunds](#refunds)) |
| Processing | ~412 | No, it is burned |
| Per document | ~18,000 flat | No |

Rule of thumb: **1 KiB on Platform ≈ 0.00028 DASH. 1 MiB ≈ 0.28 DASH.** About 98.5% of that is a deposit.

```sh
dg cost estimate --bytes 1048576
```

```
Estimate for 1048576 bytes (platform tier):
  total:      ~0.28743583 DASH ≈ $8.62
  refundable: ~0.28311552 DASH ≈ $8.49 (storage deposit, reclaimable on delete)
  burned:     ~0.00432031 DASH ≈ $0.13 (non-refundable processing)
```

A deposit only comes back when the document is deleted. Some documents can never be deleted, by design (see [Refunds](#refunds)). For those, the deposit is effectively a one-time cost.

---

## What each action costs

| Action | v1 (testnet today) | forge-v2 (planned: devnet moutai once client support lands; mainnet after protocol 14) |
|---|---|---|
| Create a repository | **~1.18 DASH**, not refundable | **~0.001 DASH** (three small documents; estimated, still being measured) |
| Fork a repository | same as create (`dg repo fork` is not built yet) | ~0.001 DASH, sharing the parent's packs |
| Push to **your own bucket** | ~0.0002–0.0004 DASH: manifest + ref update | same |
| Push with packs **on Platform** | ~0.28 DASH per MiB of packed data, plus the above | same, and the storage is permanent |
| Issue or comment (~500 bytes) | ~0.00014 DASH | same |
| Ref update (~200 bytes) | ~0.000055 DASH | same |
| Add or remove a collaborator | a token mint or freeze, small | one small document |
| Clone, fetch, browse, read issues | **free** | **free** |

Where the numbers come from: `dg cost audit` (the per-operation reference below), [economics.md](../economics.md), and the measured forge-v2 contract costs in [forge-v2.md §7](../contracts/forge-v2.md#7-measured-size-and-cost).

```sh
dg cost audit
```

```
Per-operation cost reference (no live spend tracking yet):
  repo create                ~1.18 DASH ≈ $35.40
  ref update (~200 B doc)    ~0.000055 DASH ≈ $0.00
  pack chunk (~4900 B)       ~0.00134337 DASH ≈ $0.04
  issue / comment (~500 B)   ~0.00013724 DASH ≈ $0.00
```

**Why v1 repositories are expensive.** A v1 repository is its own Platform data contract, and Platform charges contract registration by the number of document types, indexes and tokens. That is about 0.88 DASH in fees for a v1 repository, before storage. forge-v2 puts every repository into one shared pair of contracts, which were registered once (for about 1.16 DASH, paid by the deployer, not by you). A new repository is then just three documents.

Packs are git packfiles: delta-compressed and deflated, typically 20–35% of the size of a checkout. Forge never stores raw files.

---

## Platform or your own bucket

Pack bytes are almost all of a repository's size, so where you keep them decides the cost:

| Where packs live | You pay | For a 50 MiB repository with 10 pushes a month |
|---|---|---|
| **Your bucket** (R2, B2, S3, MinIO) or IPFS | Platform: manifest + refs per push. Provider: storage and egress, at their prices. | ~0.003 DASH a month on Platform, plus cents to your provider (R2 has no egress fees) |
| **Dash Platform** | ~0.28 DASH per MiB pushed | ~14 DASH for the first upload, then ~0.28 DASH per MiB pushed |

Platform storage buys you something: it is stored by the network, and on forge-v2 it can never be deleted, even by you. Your bucket is cheap, but it is only as available as your account with the provider. You can have both: `dg storage use r2-main,platform` keeps a copy in each place. See [Bring your own storage](bring-your-own-storage.md).

If you set nothing, **packs go to Platform**. That is fine for small repositories, and expensive for large ones.

---

## Refunds

When a document is deleted, Platform refunds the part of its storage deposit that has not been used yet. The deposit is spread over about 50 years, so a document deleted within weeks or months gets back nearly all of its deposit. The burned part never comes back. Only the identity that paid can get the refund, and only by deleting its own documents.

**What can be deleted, and so refunded:**

| | v1 (testnet today) | forge-v2 |
|---|---|---|
| Pack chunks and manifests | Yes: `dg repack` consolidates and deletes superseded ones; `dg repo delete` deletes all of them | **No.** Platform-tier storage is permanent, so that nobody can break a repository by deleting what others depend on. |
| Issues, PRs | Yes, by the author | **No**, so that threads cannot be rewritten |
| Ref updates, config, events | No, never (they are the audit trail) | No, never |
| Comments, reviews, releases, labels, stars, follows | Yes, by the author | Yes, by the author |
| The repository contract (v1) or `repo` document (v2) | No | No |

On v1, `dg repo delete` deletes the repository's chunks and manifests, removes its listing, and prints the estimated refund. The contract itself stays, because contracts cannot be deleted.

The audit trail grows forever: about 0.08 DASH per 1,000 pushes stays locked in ref updates. That is the price of a history nobody can rewind.

---

## Seeing costs before you pay

- **`dg` asks first.** Every command that writes asks `[y/N]` unless you pass `--yes`. `dg repo create` and `dg repack` show their price in the question, and `dg repo delete` its refund. For other commands, use `dg cost estimate` and `dg cost audit`. With `--json` or no terminal, `dg` refuses to write without `--yes` ([`E802`](../errors.md#e802)).
- **`git push` prints its estimate** before it writes to Platform, and what Platform actually charged when it is done. To make it ask:
  ```sh
  git config --global dash.costWarnThreshold 0.01   # ask above 0.01 DASH
  git config --global dash.confirm auto             # auto | always | never
  ```
  Without a terminal (CI), a push over the threshold stops with [`E801`](../errors.md#e801) rather than spending.
- **`forge-import --dry-run`** estimates a whole GitHub import, and `--max-spend` caps it.
- **The web app** shows a cost preview before it creates a repository, files an issue or comment, changes an issue or PR's state, or changes collaborators. Starring and following do not show one yet.

**Coming soon:** a local spend ledger with `dg cost audit` month and all-time totals by repository, actual-versus-estimate in the web app's toasts, and a budget on each key (with protocol 14's limited keys).
