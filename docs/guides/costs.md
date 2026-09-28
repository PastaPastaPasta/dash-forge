# What things cost

Forge charges nothing. Nobody runs it, so nobody takes a cut. What you pay goes to two places: **Dash Platform fees**, paid from your identity's credits, and **your own storage provider's bill**, if you use one. Reading, cloning and browsing cost nothing on Platform. If a repository's packs are in a bucket, its owner's provider may bill the owner for the download traffic (egress); R2 has none.

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

You get credits by locking Dash into your identity from any Dash wallet: when you create the identity, or later with a top-up (the bridge's **Top Up Existing Identity**). Forge does not sponsor identities, and mainnet has no faucet. Devnet moutai Dash is free, from the [moutai faucet](https://faucet.moutai.networks.dash.org).

```sh
dg auth balance
```

```
Identity: 8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB
Balance:  0.4821 DASH (48210000000 credits)
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
  storage:    ~0.28311552 DASH ≈ $8.49 (deposit; Platform packs are permanent, not refunded)
  processing: ~0.00432031 DASH ≈ $0.13
```

A deposit only comes back when the document is deleted. Some documents can never be deleted, by design (see [Refunds](#refunds)). For those, the deposit is effectively a one-time cost.

---

## What each action costs

Measured on devnet moutai (Platform protocol 14) as the signing identity's balance change. Mainnet uses the same fee formula.

| Action | Cost |
|---|---|
| Create a repository | **~0.0013 DASH**: three small documents (`repo`, your `maintainer` membership, the first `config`) |
| Push to **your own bucket** | **~0.0003–0.004 DASH**: the pack manifest, the ref updates and the browse index. A one-commit push is at the low end (the helper quotes ~0.0003–0.0004 DASH for one manifest and one ref update); the measured first push of a small project to a bucket by `dg init` came to 0.0028 DASH |
| Push with packs **on Platform** | **~0.28–0.30 DASH per MiB** of packed data, plus the above; the storage is permanent. A tiny push stored on Platform measured 0.0034 DASH |
| Issue | ~0.0006 DASH with a short body, ~0.0017 DASH with a 4 KB body |
| Comment | ~0.0005 DASH short, ~0.0016 DASH at 4 KB |
| Pull request | ~0.0007–0.001 DASH |
| Close, reopen, label, merge event | ~0.0004–0.0006 DASH |
| Review | ~0.00035 DASH |
| Release (the document; assets go to your storage) | ~0.0007 DASH |
| Add a member / remove one | ~0.0004 DASH / refunds ~0.0002 DASH |
| Star / unstar | **~0.00018 DASH** (a repo's first star ~0.00036) / refunds ~0.00012 DASH (the repo's last star ~0.00023) |
| Counting a star toward **Trending** (on by default) | **~0.00015 DASH** more for a new star (~0.00022 for your first): one small `starBeat` document. It is not refunded and unstarring does not remove it; starring the same repo again adds nothing. Turn it off in **Settings → Stars**, with `dg repo star --no-trending`, or `trending = false` in `config.toml` |
| Webhook | ~0.0008 DASH; removing it refunds all but ~0.00008 DASH |
| Fork a repository | **~0.01 DASH** for a small repository (8 packs, 5 branches: 0.0095 DASH), 0.03 DASH for 36 packs: one small manifest per pack and one ref update per branch. The parent's packs are referenced, never re-uploaded |
| Mirror a GitHub repository, first run | depends on its size; the Mirror Action's first live run of a small repository (`dash-faucet`, packs on Platform) cost **~0.078 DASH**, and a repository with 2 PRs, 15 comments and 7 reviews cost 0.112 DASH. A re-run with nothing new costs **0** |
| Top up a browser key's budget | ~0.00002 DASH |
| Clone, fetch, browse, read issues, download a zip | **free** |

**How Trending counts.** Trending on Explore ranks repositories by their **new stargazers in the last week** (or today), read with a proof from the `starBeat` documents' weekly window index. A beat's window entries expire on their own after a week (the index's own time-to-live), so the network keeps no permanent record for them; the one small permanent entry per starrer and repository is what stops a second beat. Measured on devnet moutai on 2026-09-28 (platform-parity-spec §4.4): a star costs 17.7 M credits in steady state (+2 % for the ranked "most starred" index), a beat 14.4–15.3 M.

Where the numbers come from: the live measurements recorded in the pull requests that built each feature and in [e2e/README.md](../../e2e/README.md), `dg cost audit` (the per-operation reference below), [economics.md](../economics.md), and the contract costs in [forge-v2.md §7](../contracts/forge-v2.md#7-measured-size-and-cost).

```sh
dg cost audit
```

```
Per-operation cost reference (no live spend tracking yet):
  repo create                ~0.002 DASH ≈ $0.06
  ref update (~200 B doc)    ~0.000055 DASH ≈ $0.00
  pack chunk (~4900 B)       ~0.00134337 DASH ≈ $0.04
  issue / comment (~500 B)   ~0.00013724 DASH ≈ $0.00
```

These are static references, not measurements: the `repo create` line is the upper bound `dg` quotes before it signs (the measured cost is ~0.0013 DASH), and the issue line counts storage only, so a real issue costs more (see the table above).

**Why a repository is cheap.** Every repository lives in one shared pair of contracts, forge-core and forge-collab, registered once per network (for about 1.16 DASH, paid by the deployer, not by you). A new repository is then just three documents. The first version of Forge gave each repository its own contract, and contract registration fees made that cost about 1.18 DASH per repository; it was removed on 2026-09-26.

Packs are git packfiles: delta-compressed and deflated, typically 20–35% of the size of a checkout. Forge never stores raw files.

---

## Platform or your own bucket

Pack bytes are almost all of a repository's size, so where you keep them decides the cost:

| Where packs live | You pay | For a 50 MiB repository with 10 pushes a month |
|---|---|---|
| **Your bucket** (R2, B2, S3, MinIO) or IPFS | Platform: manifest + refs per push. Provider: storage and egress, at their prices. | ~0.003–0.04 DASH a month on Platform, plus cents to your provider (R2 has no egress fees) |
| **Dash Platform** | ~0.28 DASH per MiB pushed | ~14 DASH for the first upload, then ~0.28 DASH per MiB pushed |

Platform storage buys you something: it is stored by the network, and it can never be deleted, even by you. Your bucket is cheap, but it is only as available as your account with the provider. You can have both: `dg storage use r2-main,platform` keeps a copy in each place. See [Bring your own storage](bring-your-own-storage.md).

If you set nothing, **packs go to Platform**. That is fine for small repositories, and expensive for large ones.

---

## Refunds

When a document is deleted, Platform refunds the part of its storage deposit that has not been used yet. The deposit is spread over about 50 years, so a document deleted within weeks or months gets back nearly all of its deposit. The burned part never comes back. Only the identity that paid can get the refund, and only by deleting its own documents.

**What can be deleted, and so refunded:**

| | Deletable? |
|---|---|
| Pack chunks and manifests | **No.** Platform-tier storage is permanent, so that nobody can break a repository by deleting what others depend on. `dg repack` consolidates into a new pack and deletes nothing on Platform. |
| Issues, PRs | **No**, so that threads cannot be rewritten |
| Ref updates, config, events | No, never (they are the audit trail) |
| The `repo` document | No |
| Membership documents (`writer`, `maintainer`) | Yes, by the owner (that is how a collaborator is removed) |
| Comments, reviews, releases, labels, webhooks, stars, follows | Yes, by the author |

There is no `dg repo delete`: a repository cannot be deleted.

The audit trail grows forever: about 0.08 DASH per 1,000 pushes stays locked in ref updates. That is the price of a history nobody can rewind.

---

## Seeing costs before you pay

- **`dg` asks first.** Every command that writes asks before it writes (`[y/N]`; `dg init` and `dg repo create` ask `Proceed? [Y/n]` after showing the price) unless you pass `--yes`. `dg repo create` and `dg repack` show their price before the question. For other commands, use `dg cost estimate` and `dg cost audit`. With `--json` or no terminal, `dg` refuses to write without `--yes` ([`E802`](../errors.md#e802)).
- **`git push` prints its estimate** before it writes to Platform, and what Platform actually charged when it is done. To make it ask:
  ```sh
  git config --global dash.costWarnThreshold 0.01   # ask above 0.01 DASH
  git config --global dash.confirm auto             # auto | always | never | refuse
  ```
  Without a terminal (CI), a push over the threshold stops with [`E801`](../errors.md#e801) rather than spending.
- **`forge-import --dry-run`** estimates a whole GitHub import, and `--max-spend` caps it.
- **`dg init` and `dg repo create`** stop before creating anything when no storage is chosen, and quote what Platform storage would cost for this repository ([E508](../errors.md#e508)).
- **The web app** shows the price on every button that signs (repository, issue, comment, state change, review, member, star, release, key top-up), with refunds for deletes. After each write a toast shows the actual balance change. **Settings → Spend** keeps a local ledger in this browser: month and all-time totals by repository, and estimates that missed by more than 25 %.
- **Limited keys cap spending.** A browser key can spend at most its budget (0.05 DASH by default), and a CI runner key its own (0.5 DASH). Platform enforces the budget at consensus, whatever the software does. See [Identity and keys](identity-and-keys.md#limited-keys).
- **The Mirror Action** has a per-run `cost-cap` (0.05 DASH by default) and reports what each run spent in the job summary.

**Coming soon:** `dg cost audit` month and all-time totals from a local ledger on the CLI side.
