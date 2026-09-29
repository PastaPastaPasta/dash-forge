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

Every byte you store on Platform costs about **27,700 credits**. On top of that, every document pays a fixed fee of about **0.0006–0.0009 DASH** for its index entries, whatever its size. Most of a large write is a **deposit**:

| Part | Credits | Comes back? |
|---|---|---|
| Storage deposit | 27,000 per byte | **Yes**, mostly, if the document is deleted (see [Refunds](#refunds)) |
| Processing | ~400–700 per byte | No, it is burned |
| Per document (its index entries) | ~58,000,000–92,000,000 | No |

The per-document fee is why a small write costs about 0.001 DASH, not the few hundred thousand credits its bytes alone would cost.

Rule of thumb for packs on Platform: **1 MiB ≈ 0.33–0.36 DASH** measured, about 0.0046–0.0050 DASH for each 14.7 KB chunk document; `dg` and `git push` quote ~0.39 DASH/MiB, an upper bound. About 75–85% of it is the deposit.

A chunk costs a little more the more chunks the whole network holds: every chunk of every repository sits in one tree, and adding one rewrites the chunks on its path to the root (about 7M credits per level, ~1.4% of a chunk). The quote allows for a network of up to about 65,000 chunks (~1 GB of packs on Platform). The dashpay/dash import on moutai (19,107 chunks, 2026-09-28) paid about 98M credits per chunk beyond its bytes, where the old quote allowed 94M, so its estimate came in 0.6% under the charge. The quote now allows 140M.

```sh
dg cost estimate --bytes 1048576
```

```
Estimate for 1048576 bytes (platform tier):
  total:      ~0.39384827 DASH ≈ $11.82
  storage:    ~0.28311552 DASH ≈ $8.49 (deposit; Platform packs are permanent, not refunded)
  fees:       ~0.11073275 DASH ≈ $3.32 (per-document and processing)
```

This is the price `git push` quotes: an upper bound, never below the charge. On the 15 first imports of the beta.6 showcase (a whole repository each: the repository, its pack, its refs, releases and labels), the estimate was 1.08–1.16x the charge for a pack of 5 MiB or more (dashpay/dash, 259 MiB: 1.08x), and 1.08–1.27x for a 1–3 MiB one, where the per-document fees weigh more.

A deposit only comes back when the document is deleted. Some documents can never be deleted, by design (see [Refunds](#refunds)). For those, the deposit is effectively a one-time cost.

---

## What each action costs

This is the one table of what Forge costs; the other guides link here. Measured on devnet moutai as the signing identity's balance change: Platform 4.2.0-beta.5, protocol 14, on **2026-09-27**, except the rows marked †, measured on the same network before the beta.5 reset (2026-09-24 to 2026-09-26). Mainnet uses the same fee formula.

A write that is the first of its kind somewhere (a repository's first push or first issue, a ref's first update) creates index entries and costs more than the same write later. The ranges below go from later to first.

| Action | Cost |
|---|---|
| Create a repository | **~0.0013 DASH**: three small documents (`repo`, your `maintainer` membership, the first `config`). A private one: ~0.0020 DASH (it adds your key and the first anchor) |
| Push to **your own bucket** | **~0.002–0.003 DASH**: two pack manifests (the pack's and its browse index's) and one ref update. Measured: 0.0028 DASH for the first push to a repository, 0.0021 DASH after |
| Push with packs **on Platform** | **~0.004–0.005 DASH** for a tiny push (0.0046 first, 0.0040 after), plus **~0.33 DASH per MiB** of packed data; the storage is permanent. Measured: 200 KiB 0.070 DASH, 1.5 MiB 0.50 DASH |
| Push to a **private** repository, packs on Platform | 20 KiB: 0.0112 DASH (first push); a tiny follow-up: 0.0022 DASH; three new branches at once: 0.0078 DASH. The packs are sealed, so they are a little larger |
| Each extra branch or tag in a push | ~0.0006–0.0009 DASH (one ref update; the same for a protected branch, public or private). A push that only adds a branch at a commit already stored measured 0.00066 DASH |
| Each extra storage target (a second bucket) | ~0.00014 DASH a push: the two manifests carry its URIs |
| Issue | ~0.0006 DASH with a short body in a busy repository, ~0.001 DASH for a repository's first; ~0.0017 DASH with a 4 KB body |
| Comment | ~0.0005 DASH short, ~0.0007 DASH as a thread's first, ~0.0016 DASH at 4 KB |
| Pull request | ~0.0007–0.0013 DASH |
| Close, reopen, label, merge event | ~0.0004–0.0006 DASH (a close measured 0.00059 DASH) |
| Review | ~0.00035–0.0004 DASH |
| Release (the document; assets go to your storage) | ~0.0007 DASH |
| Add a member / remove one | ~0.0004 DASH / refunds ~0.0002 DASH |
| Star / unstar | **~0.00018 DASH** (a repo's first star ~0.00036) / refunds ~0.00012 DASH (the repo's last star ~0.00023) |
| Counting a star toward **Trending** (on by default) | **~0.00015 DASH** more for a new star (~0.00022 for your first): one small `starBeat` document. It is not refunded and unstarring does not remove it; starring the same repo again adds nothing. Turn it off in **Settings → Stars**, with `dg repo star --no-trending`, or `trending = false` in `config.toml` |
| Webhook † | ~0.0008 DASH; removing it refunds all but ~0.00008 DASH |
| Fork a repository † | **~0.01 DASH** for a small repository (8 packs, 5 branches: 0.0095 DASH), 0.03 DASH for 36 packs: one small manifest per pack and one ref update per branch. The parent's packs are referenced, never re-uploaded |
| Mirror a GitHub repository, first run † | depends on its size; the Mirror Action's first live run of a small repository (`dash-faucet`, packs on Platform) cost **~0.078 DASH**, and a repository with 2 PRs, 15 comments and 7 reviews cost 0.112 DASH. A re-run with nothing new costs **0** |
| Top up a browser key's budget † | ~0.00002 DASH |
| Clone, fetch, browse, read issues, download a zip | **free** |

**How Trending counts.** Trending on Explore ranks repositories by their **new stargazers in the last week** (or today), read with a proof from the `starBeat` documents' weekly window index. A beat's window entries expire on their own after a week (the index's own time-to-live), so the network keeps no permanent record for them; the one small permanent entry per starrer and repository is what stops a second beat. Measured on devnet moutai on 2026-09-28 (platform-parity-spec §4.4): a star costs 17.7 M credits in steady state (+2 % for the ranked "most starred" index), a beat 14.4–15.3 M.

Where the numbers come from: the per-write balance changes recorded by the push calibration (P-6, PR #127, 2026-09-27/28; its figures are the constants in `forge_core::cost::push_fees`), the web app's measured model (`forge-web/lib/sdk/cost.ts`), the live measurements in the pull requests that built each feature and in [e2e/README.md](../../e2e/README.md), and the contract costs in [forge-v2.md §7](../contracts/forge-v2.md#7-measured-size-and-cost).

```sh
dg cost audit
```

```
Per-operation cost reference (no live spend tracking yet):
  repo create                ~0.002 DASH ≈ $0.06
  ref update                 ~0.00092 DASH ≈ $0.03
  pack manifest              ~0.00112 DASH ≈ $0.03
  pack chunk (14.7 KB)       ~0.00550791 DASH ≈ $0.17
  issue (~500 B)             ~0.00108658 DASH ≈ $0.03
  comment (~500 B)           ~0.00070658 DASH ≈ $0.02
```

These are upper bounds, the prices `dg` and `git push` quote before they sign, not measurements: each is at or above the most the table above measured for that write.

**Why a repository is cheap.** Every repository lives in one shared pair of contracts, forge-core and forge-collab, registered once per network (for about 1.16 DASH, paid by the deployer, not by you). A new repository is then just three documents. The first version of Forge gave each repository its own contract, and contract registration fees made that cost about 1.18 DASH per repository; it was removed on 2026-09-26.

Packs are git packfiles: delta-compressed and deflated, typically 20–35% of the size of a checkout. Forge never stores raw files.

---

## Platform or your own bucket

Pack bytes are almost all of a repository's size, so where you keep them decides the cost:

| Where packs live | You pay | For a 50 MiB repository with 10 pushes a month |
|---|---|---|
| **Your bucket** (R2, B2, S3, MinIO) or IPFS | Platform: manifests + refs per push. Provider: storage and egress, at their prices. | ~0.02–0.03 DASH a month on Platform, plus cents to your provider (R2 has no egress fees) |
| **Dash Platform** | ~0.33 DASH per MiB pushed, plus ~0.004 DASH per push | ~17 DASH for the first upload, then ~0.33 DASH per MiB pushed |

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

The audit trail grows forever: each ref update costs about 0.0006–0.0009 DASH and never comes back, about 0.6–0.9 DASH per 1,000 pushes. That is the price of a history nobody can rewind.

---

## Seeing costs before you pay

- **`dg` asks first.** Every command that writes asks before it writes (`[y/N]`; `dg init` and `dg repo create` ask `Proceed? [Y/n]` after showing the price) unless you pass `--yes`. `dg repo create`, `dg repack` and `dg repo reindex` show their price before the question. For other commands, use `dg cost estimate` and `dg cost audit`. With `--json` or no terminal, `dg` refuses to write without `--yes` ([`E802`](../errors.md#e802)).
- **`git push` prints its estimate** before it writes to Platform, and what Platform actually charged when it is done. The estimate prices every write as the first of its kind, so it is an upper bound: 1.08–1.27x the charge on a first import of 1 MiB or more, up to about 1.4x on a tiny first push and 1.7x on a small later one. To make it ask:
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
