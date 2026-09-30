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

You get credits by locking Dash into your identity from any Dash wallet: when you create the identity, or later with a top-up (the bridge's **Top Up Existing Identity**). Forge does not sponsor identities, and mainnet has no faucet. Devnet bonsia Dash is free, from the [bonsia faucet](https://faucet.bonsia.networks.dash.org).

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

`dg cost estimate` prices a first push the way `git push` prices it: the pack and its browse index, their two manifests, one ref update, and the history index a push to the default branch publishes. Run in a repository (or with `--path <repository>`), it builds the pack a push of `HEAD` would upload and computes the history index, as the push does, and prices them on the storage that repository's `git push` would use (its forge remote's `dashStorage`, else `dash.storage`, else Platform). `--backend` prices another, and `--private` prices a private repository, whose pack and indexes are stored sealed (a local clone cannot tell its visibility). In a shallow clone, where a push publishes no history index, the quote leaves it out and says why:

```sh
dg cost estimate                  # the repository in the current directory, on its own storage
dg cost estimate --backend s3     # the same repository, packs in your own bucket
```

```
Estimate for a first push of the repository at /home/me/qw-cost-plat (HEAD: 336 B, 5 objects) to platform:
  total:       ~0.01247089 DASH ≈ $0.37  (an upper bound, as `git push` quotes it; later pushes pay less)
  metadata:    ~0.0062 DASH ≈ $0.19  4 manifests + 1 ref update, on Platform
  chunks:      ~0.00627089 DASH ≈ $0.19  pack + browse index + history index on Platform; ~0.00051354 DASH ≈ $0.02 of it is the storage deposit, never refunded (Platform packs are permanent)
```

```
Estimate for a first push of the repository at /home/me/qw-cost-s3 (HEAD: 334 B, 5 objects) to s3:
  total:       ~0.00656 DASH ≈ $0.20  (an upper bound, as `git push` quotes it; later pushes pay less)
  metadata:    ~0.00656 DASH ≈ $0.20  4 manifests + 1 ref update, on Platform
  pack bytes:  on your own storage (s3), billed by your provider, not by Platform
```

On devnet bonsia (Platform 4.2.0-beta.7, 2026-09-30) these two first pushes were charged 0.0104 DASH and 0.0052 DASH. With `--backend s3`, `ipfs` or `https` the quote is the same whatever the size: Platform bills the manifests and the ref update, never the bytes. `--backend mixed` keeps a copy in each place and pays for both.

`--bytes <N>` prices a pack of that size without a repository. It assumes one object per 512 bytes for the browse index, and on Platform it leaves out the history index's chunks, whose size depends on the repository (it says so):

```sh
dg cost estimate --bytes 1048576
```

```
Estimate for a first push of 1.0 MiB (~2048 objects assumed) to platform:
  total:       ~0.42939169 DASH ≈ $12.88  (not counting the history index's chunks; later pushes pay less)
  metadata:    ~0.0062 DASH ≈ $0.19  4 manifests + 1 ref update, on Platform
  chunks:      ~0.42319169 DASH ≈ $12.70  pack + browse index on Platform; ~0.30331908 DASH ≈ $9.10 of it is the storage deposit, never refunded (Platform packs are permanent)
  not priced:  the history index's chunks: their size depends on the repository; `dg cost estimate --path <repository>` prices them
```

The price `git push` quotes is an upper bound, never below the charge. On the 15 first imports of the beta.6 showcase (a whole repository each: the repository, its pack, its refs, releases and labels), the estimate was 1.08–1.16x the charge for a pack of 5 MiB or more (dashpay/dash, 259 MiB: 1.08x), and 1.08–1.27x for a 1–3 MiB one, where the per-document fees weigh more.

A deposit only comes back when the document is deleted. Some documents can never be deleted, by design (see [Refunds](#refunds)). For those, the deposit is effectively a one-time cost.

---

## What each action costs

This is the one table of what Forge costs; the other guides link here. Measured on devnet moutai as the signing identity's balance change: Platform 4.2.0-beta.5, protocol 14, on **2026-09-27**, except the rows marked †, measured on the same network before the beta.5 reset (2026-09-24 to 2026-09-26). Mainnet uses the same fee formula.

A write that is the first of its kind somewhere (a repository's first push or first issue, a ref's first update) creates index entries and costs more than the same write later. The ranges below go from later to first.

| Action | Cost |
|---|---|
| Create a repository | **~0.0013 DASH**: three small documents (`repo`, your `maintainer` membership, the first `config`). A private one: ~0.0020 DASH (it adds your key and the first anchor) |
| Push to **your own bucket** | **~0.004–0.005 DASH** on bonsia: the pack's and its browse index's manifests, the history index's, and one ref update. Measured on bonsia (2026-09-30): 0.0052 DASH for the first push to a repository, ~0.0040 after. (On moutai: 0.0028 and 0.0021) |
| Push with packs **on Platform** | **~0.004–0.010 DASH** for a tiny push on bonsia: 0.0040 for a tag and 0.0052 for a branch, 0.0102 (first) and 0.0088 when it moves the default branch, whose history index is stored as a chunk too (quoted up to 0.012). Plus **~0.33 DASH per MiB** of packed data (`git push` quotes up to 0.39); the storage is permanent. Measured on moutai: 200 KiB 0.070 DASH, 1.5 MiB 0.50 DASH |
| Push to a **private** repository, packs on Platform | 20 KiB: 0.0112 DASH (first push); a tiny follow-up: 0.0022 DASH; three new branches at once: 0.0078 DASH. The packs are sealed, so they are a little larger |
| History index (a push that moves the **default branch**) | **one more manifest and, on Platform, a small delta**: ~0.0026–0.006 DASH on Platform for a typical push, and now and then a full index (~0.28 DASH on dashpay/dash; about every 80 pushes there, ~0.009 DASH a push on average). ~0.0016 DASH with your own storage. All upper bounds. See [History index](#history-index) |
| Each extra branch or tag in a push | ~0.0006–0.0009 DASH (one ref update; the same for a protected branch, public or private). A push that only adds a branch at a commit already stored measured 0.00066 DASH |
| Each extra storage target (a second bucket) | ~0.00014 DASH a push: the two manifests carry its URIs |
| Issue | ~0.0006 DASH with a short body in a busy repository, ~0.001 DASH for a repository's first; ~0.0017 DASH with a 4 KB body |
| Comment | ~0.0005 DASH short, ~0.0007 DASH as a thread's first, ~0.0016 DASH at 4 KB |
| Pull request | ~0.0007–0.0013 DASH |
| Close, reopen, label, merge event | ~0.0004–0.0006 DASH (a close measured 0.00059 DASH; a merge event 0.00058 DASH on beta.6) |
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
dg cost prices
```

```
Per-operation cost reference (upper bounds; see `dg cost audit` for what you've spent):
  repo create                ~0.002 DASH ≈ $0.06
  ref update                 ~0.00092 DASH ≈ $0.03
  pack manifest              ~0.00112 DASH ≈ $0.03
  pack chunk (14.7 KB)       ~0.00550791 DASH ≈ $0.17
  issue (~500 B)             ~0.00158658 DASH ≈ $0.05
  comment (~500 B)           ~0.00122658 DASH ≈ $0.04
```

These are upper bounds, the prices `dg` and `git push` quote before they sign, not measurements: each is priced as the first of its kind (a repository's first issue, a thread's first comment), at or above the most the table above measured for that write.

**Measured on devnet bonsia** (Platform 4.2.0-beta.7, 2026-09-30), where some writes cost more than on moutai: a repository's first issue 0.0012 DASH and a later one 0.0008; a first push to your own bucket 0.0052 DASH and a later one ~0.0040, the history index's manifests included; a limited key for `dg auth login` ~0.00027 DASH and a CI runner key 0.00043 (quoted 0.0005, one identity update); a CI check run 0.00082–0.00122 DASH (see [CI](ci.md#what-it-costs)).

**What you've actually spent.** `dg cost audit` estimates one identity's total Forge spend — with no repository argument, every document it has created across the network, totalled by type and by repository; give it a repository (`dg cost audit owner/name`) for that repository's live pack-storage tally instead. forge-v2 keeps no on-chain spend ledger, so this is `(proved document count) × (that type's flat create cost)`, the same figure shape as the web app's **Settings → Spend** ledger — but the two are not expected to agree: the web ledger is a per-browser history of actual balance changes (so it sees refunds, and misses writes made from any other browser or from `dg` itself), while this audit is a network-wide estimate at each type's flat rate (so it misses a first-of-its-kind write's or an unusually large write's true cost — see the table above). Treat both as estimates, and see [above](#what-each-action-costs) for where they can diverge. `--owner` takes an identity id or a DPNS name and defaults to the signing identity; `--since` takes a duration (`24h`, `7d`, `2w`, `1y`) or an absolute date (`2026-01-01`); neither combines with the repository argument. Its repository scope has one gap: a membership revoked with no other trace left in that repo (no issue/patch filed, no still-registered CI runner, and — in a public repo — no `repoKey`) cannot be found by any proved query; the command's own output says so. `chunk` counts also come from each owned pack's own `packManifest` rather than being queried directly, so a chunk uploaded by a push that never finished with a manifest (interrupted, or a mid-push membership revocation) is not counted either — the output notes this gap too.

```sh
dg cost audit --since 30d
```

```
Spend estimate for 8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB:
  since:  2026-08-30 14:22:07 UTC
  total:  ~0.02585 DASH ≈ $0.78 across 38 document(s)

  by document type:
    comment                14  ~0.00728 DASH ≈ $0.22
    issue                  11  ~0.00649 DASH ≈ $0.19
    patch                   9  ~0.00648 DASH ≈ $0.19
    chunk                   4  ~0.0056 DASH ≈ $0.17

  by repository:
    9cBMULwtQUMtxhBkgaTKb4tJtoczd8TEQ8gmiroDWf4F     38  ~0.02585 DASH ≈ $0.78

  note: excludes review (no proved query can attribute them to their author)
  note: covers every repo owned, filed an issue/patch to, or still a maintainer/writer/CI-runner/private-repo-key-holder of; a membership revoked with no other trace in that repo cannot be found by any proved query
  note: chunk counts come from each owned pack's own manifest; chunks uploaded by a push that never finished with a manifest are not counted
```

`review` documents are left out: their only index (`patch [patchId, $createdAt]`) carries neither `repoId` nor `$ownerId`, so no proved query can find "every review this identity wrote" without reading every patch on the network. A review you wrote really is missing from the total (there is no other line item that recovers its cost) — the `note` above says so rather than let the total quietly undercount.

### History index

The file list's last-commit column, the exact `n commits` count, and the file versions Blame and a file's History read come from a **history index** the push publishes with the default branch ([design](../design/history-index.md)). Without one, the web walks history in your browser: 400 commits at a time for the column, and every commit back to a file's first version for Blame. The first index is a full one. Later pushes publish a small **delta** over it. Each delta covers every change since the full index, so each push pays for all of them again. Once the deltas over a full index have cost as much as the full index itself, the next push publishes a full one again. A delta is never over half the full index.

Since v2, the index lists each path's newest 256 first-parent versions: the commit, author and blob of each. Blame of dashpay/dash's `src/clientversion.h` then needs 16 chunk queries instead of 357 (the offline replay in the [design](../design/history-index.md#measured-size-and-cost)). The lists make the index about ten times larger than v1.

Sizes and fees below were computed with `forge-core`'s own code from a full clone (`measure_a_real_repository`, `measure_a_real_delta`). The fees are the upper bound `git push` and `dg repo reindex` quote (`push_fees::history_index`), not balance changes:

| dashpay/dash `develop` @ 3ba0805c (5,117 paths, 34,001 / 8,363 commits) | Size | Chunks | On Platform | With your own storage |
|---|---|---|---|---|
| Full index (v2) | 752,738 B | 52 | **~0.284 DASH** (~0.285 for a repository's first) | ~0.0016 DASH |
| Delta, 1 commit later | 236 B | 1 | ~0.0026 DASH | ~0.0016 DASH |
| Delta, 10 commits later | 1,926 B | 1 | ~0.0031 DASH | ~0.0016 DASH |
| Delta, 50 commits later | 12,301 B | 1 | ~0.0060 DASH | ~0.0016 DASH |
| Delta, 200 commits later | 47,685 B | 4 | ~0.020 DASH | ~0.0016 DASH |

**Per push, on average.** Deltas on dash grow by about 240 bytes per first-parent commit. With one commit per push, the deltas over a full index reach its cost after about 80 pushes. Then one push publishes a full index (~0.28 DASH). Over that cycle a push pays about **0.009 DASH** on average for its history index on Platform. That figure is an estimate from the quote formula and the measured delta sizes. Pushes of several commits reach the full index sooner, in pushes but not in commits. With your own storage, only the manifest is on chain: ~0.0016 DASH a push, whatever the size.

| Other repositories (v1 index, before version lists) | Paths | Commits (all / first-parent) | Full index | On Platform | With your own storage |
|---|---|---|---|---|---|
| junegunn/fzf (`master`) | 178 | 3,746 / 3,488 | 6,925 B, 1 chunk | ~0.0044 DASH | ~0.0016 DASH |
| dtolnay/anyhow (`master`) | 62 | 931 / 668 | 2,490 B, 1 chunk | ~0.0032 DASH | ~0.0016 DASH |

**Measured (v1):** backfilling dashpay/dash's v1 index with `dg repo reindex` on devnet moutai (Platform 4.2.0-beta.6, 2026-09-29) cost **0.02479 DASH** for 66,965 B (quoted 0.02455 before a repository's first-index margin was added; the quote now includes it and stays above the charge). That index was computed in a shallow clone, so its counts (33,553 / 7,979) were short; a shallow clone is now refused. The v2 backfill of the dash mirror waits for its re-import on devnet bonsia. Computing dash's full v2 index takes about 1.5 s on the pusher's machine.

`dg repo reindex <repo>`, run inside a clone that has the default branch's tip, publishes the index for a repository pushed before it existed, or a v2 index over a v1 one, and quotes its price before asking. A push that stores no new pack, such as a retry of a recorded one, publishes none; `dg repo reindex` fills that in.

**Why a repository is cheap.** Every repository lives in one shared pair of contracts, forge-core and forge-collab, registered once per network (for about 1.16 DASH, paid by the deployer, not by you). A new repository is then just three documents. The first version of Forge gave each repository its own contract, and contract registration fees made that cost about 1.18 DASH per repository; it was removed on 2026-09-26.

Packs are git packfiles: delta-compressed and deflated, typically 20–35% of the size of a checkout. Forge never stores raw files.

---

## Platform or your own bucket

Pack bytes are almost all of a repository's size, so where you keep them decides the cost:

| Where packs live | You pay | For a 50 MiB repository with 10 pushes a month |
|---|---|---|
| **Your bucket** (R2, B2, S3, MinIO) or IPFS | Platform: manifests + refs per push. Provider: storage and egress, at their prices. | ~0.04 DASH a month on Platform (~0.004 DASH a push to the default branch on bonsia, its history index included), plus cents to your provider (R2 has no egress fees) |
| **Dash Platform** | ~0.33 DASH per MiB pushed (quoted up to 0.39), plus ~0.004–0.010 DASH per push | ~17 DASH for the first upload, then ~0.33 DASH per MiB pushed |

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

- **`dg` asks first.** Every command that writes asks before it writes (`[y/N]`; `dg init` and `dg repo create` ask `Proceed? [Y/n]` after showing the price) unless you pass `--yes`. `dg repo create`, `dg repack` and `dg repo reindex` show their price before the question. For other commands, use `dg cost estimate` before you write (in a repository it quotes a first push of it to `--backend platform`, `s3`, `ipfs`, `https` or `mixed`) and `dg cost prices` / `dg cost audit` to see the reference table or what you've already spent. With `--json` or no terminal, `dg` refuses to write without `--yes` ([`E802`](../errors.md#e802)).
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
- **`dg cost audit`** totals what an identity has spent on Forge, from proved document counts (not a local ledger — see [above](#what-each-action-costs)); `--since` narrows the window, `--json` for scripting.
