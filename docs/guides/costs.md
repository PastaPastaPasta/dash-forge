# What things cost

Forge charges nothing. Nobody runs it, so nobody takes a cut. What you pay goes to two places: **Dash Platform fees**, paid from your identity's credits, and **your own storage provider's bill**, if you use one. Reading, cloning and browsing cost nothing on Platform. If a repository's packs are in a bucket, its owner's provider may bill the owner for the download traffic (egress); R2 has none.

Amounts are in **DASH**. The CLIs and web app show an optional fiat equivalent beside costs using live mainnet rates. Costs, quotes and budgets on testnet and devnets say **on mainnet**; balances there remain **test DASH, no cash value**, with no fiat equivalent. With no usable rate, amounts stay in DASH alone. The dollar amounts in the examples below are illustrative; live rates vary.

`dg --fiat EUR cost estimate` chooses a currency for one invocation. The CLIs resolve `--fiat <CODE|off>` (dg only), then `DASH_FORGE_FIAT`, then `fiat = "EUR"` in `~/.config/dash-forge/config.toml`, then USD. The 34 supported fiat codes and `off` are case-insensitive; empty values are unset. **`off` at any level wins**: use `dg --fiat off …`, `DASH_FORGE_FIAT=off`, or `fiat = "off"` to disable prices and their requests. An unknown flag value is a usage error; an unknown environment or config code warns once and falls back to USD for that setting.

Rates come from [CTX](https://rates.ctx.com/rates?source=ctx), with [CoinGecko](https://www.coingecko.com/) as the fallback (data provided by CoinGecko). Requests do not vary with your selected currency. The **providers see your IP address**. No account data or cookies are sent. The cache refreshes after 10 minutes, remains usable for up to 24 hours, and waits 10 minutes after a failure before retrying. A CLI invocation has a total two-second fetch budget; `git-remote-dash` starts its background refresh only when it receives a push command, and a push never waits for prices. Fetch and clone do not start a rate request. Costs on test networks also use these providers; their balances have no fiat equivalent. The cache is `fiat-rates.json` under the usual Forge cache directory (`DASH_FORGE_CACHE_DIR` overrides it; `DASH_FORGE_NO_CACHE=1` disables disk caching).

`DASH_USD=<n>` supplies a fixed positive USD rate and skips both providers. It supplies only USD, so another selected currency has no fiat figure. In `dg --json`, the existing `usd` and `usdPrice` fields remain USD-only and mainnet-only, and are `null` when no rate is available or prices are off. An optional `fiat` object carries `{currency, amount, rate, source, fetchedAt}` when the selected currency has a rate. `source` is `ctx`, `coingecko`, or `DASH_USD`. `fetchedAt` is the local fetch time in Unix milliseconds (or the invocation time for `DASH_USD`); these are current price equivalents, not historical quotes.

1. [Credits](#credits)
2. [Deposits and burns](#deposits-and-burns)
3. [What each action costs](#what-each-action-costs)
4. [Platform or your own bucket](#platform-or-your-own-bucket)
5. [Refunds](#refunds)
6. [Seeing costs before you pay](#seeing-costs-before-you-pay)

---

## Credits

Platform fees are paid in **credits**, from your identity's balance. **1 DASH = 100,000,000,000 credits.**

You get credits by locking Dash into your identity from any Dash wallet: when you create the identity, or later with a top-up (the bridge's **Top Up Existing Identity**). Forge does not sponsor identities, and mainnet has no faucet. Testnet Dash, where Forge runs today, is free test money, from the [Dash testnet faucet](https://faucet.testnet.networks.dash.org) or [faucet.thepasta.org](https://faucet.thepasta.org); the web app links both. Code stored on Platform adds about 0.39 DASH per MiB (permanent), so before a first push either add your own storage or deposit about 0.4 DASH per MiB.

```sh
dg auth balance
```

```
Identity: ExampLeidentityExampLeidentityExampLeidentEx
Balance:  0.4821 DASH (48210000000 credits)
```

When the balance runs out, writes fail with [`E401`](../errors.md#e401). Reads keep working, and nothing you stored is lost.

---

## Deposits and burns

Every byte you store on Platform costs about **27,700 credits**. On top of that, a document's fixed index overhead varies by type and by which index trees already exist: small testnet writes cost about **0.0002–0.0015 DASH** before adding large text or binary payloads. Most of a large write is a **deposit**:

| Part | Credits | Comes back? |
|---|---|---|
| Storage deposit | 27,000 per byte | **Yes**, mostly, if the document is deleted (see [Refunds](#refunds)) |
| Processing | ~400–700 per byte | No, it is burned |
| Per document (its index entries) | Varies by type and first-write subtrees | The refundable portion of deleted index storage can come back |

The per-document fee is why a small write costs about 0.001 DASH, not the few hundred thousand credits its bytes alone would cost.

Historical rule of thumb for packs on Platform †: **1 MiB ≈ 0.33–0.36 DASH** measured on devnet moutai, about 0.0046–0.0050 DASH for each 14.7 KB chunk document; `dg` and `git push` quote ~0.39 DASH/MiB, an upper bound. About 75–85% of it is the deposit.

A chunk costs a little more the more chunks the whole network holds: every chunk of every repository sits in one tree, and adding one rewrites the chunks on its path to the root (about 7M credits per level, ~1.4% of a chunk). The quote allows for a network of up to about 65,000 chunks (~1 GB of packs on Platform). The dashpay/dash import on moutai (19,107 chunks, 2026-09-28) paid about 98M credits per chunk beyond its bytes, where the old quote allowed 94M, so its estimate came in 0.6% under the charge. The quote now allows 140M.

`dg cost estimate` prices a first push the way `git push` prices it: the pack and its browse index, their two manifests, one ref update, and the history index a push to the default branch publishes. Run in a repository (or with `--path <repository>`), it builds the pack a push of `HEAD` would upload and computes the history index, as the push does, and prices them on the storage that repository's `git push` would use (its forge remote's `dashStorage`, else `dash.storage`, else Platform). `--backend` prices another, and `--private` prices a private repository, whose pack and indexes are stored sealed (a local clone cannot tell its visibility). In a shallow clone, where a push publishes no history index, the quote leaves it out and says why:

```sh
dg cost estimate                  # the repository in the current directory, on its own storage
dg cost estimate --backend s3     # the same repository, packs in your own bucket
```

```
Estimate for a first push of the repository at /home/me/qw-cost-plat (HEAD: 336 B, 5 objects) to platform:
  total:       ~0.01359089 DASH (≈ $0.41 on mainnet); an upper bound; `git push` shows it rounded; later pushes pay less
  metadata:    ~0.00732 DASH (≈ $0.22 on mainnet)  4 manifests + 1 ref update, on Platform
  chunks:      ~0.00627089 DASH (≈ $0.19 on mainnet)  pack + browse index + history index on Platform; ~0.00051354 DASH (≈ $0.02 on mainnet) of it is the storage deposit, never refunded (Platform packs are permanent)
```

```
Estimate for a first push of the repository at /home/me/qw-cost-s3 (HEAD: 334 B, 5 objects) to s3:
  total:       ~0.00768 DASH (≈ $0.23 on mainnet); an upper bound; `git push` shows it rounded; later pushes pay less
  metadata:    ~0.00768 DASH (≈ $0.23 on mainnet)  4 manifests + 1 ref update, on Platform
  pack bytes:  on your own storage (s3), billed by your provider, not by Platform
```

On devnet bonsia (Platform 4.2.0-beta.7, 2026-09-30) these two first pushes were charged 0.0104 DASH and 0.0052 DASH. With `--backend s3`, `ipfs` or `https` the quote is the same whatever the size: Platform bills the manifests and the ref update, never the bytes. `--backend mixed` keeps a copy in each place and pays for both.

`--bytes <N>` prices a pack of that size without a repository. It assumes one object per 512 bytes for the browse index, and on Platform it leaves out the history index's chunks, whose size depends on the repository (it says so):

```sh
dg cost estimate --bytes 1048576
```

```
Estimate for a first push of 1.0 MiB (~2048 objects assumed) to platform:
  total:       ~0.43051169 DASH (≈ $12.92 on mainnet); not counting the history index's chunks; later pushes pay less
  metadata:    ~0.00732 DASH (≈ $0.22 on mainnet)  4 manifests + 1 ref update, on Platform
  chunks:      ~0.42319169 DASH (≈ $12.70 on mainnet)  pack + browse index on Platform; ~0.30331908 DASH (≈ $9.10 on mainnet) of it is the storage deposit, never refunded (Platform packs are permanent)
  not priced:  the history index's chunks: their size depends on the repository; `dg cost estimate --path <repository>` prices them
```

The price `git push` quotes is an upper bound, never below the charge. On the 15 first imports of the beta.6 showcase (a whole repository each: the repository, its pack, its refs, releases and labels), the estimate was 1.08–1.16x the charge for a pack of 5 MiB or more (dashpay/dash, 259 MiB: 1.08x), and 1.08–1.27x for a 1–3 MiB one, where the per-document fees weigh more.

A deposit only comes back when the document is deleted. Some documents can never be deleted, by design (see [Refunds](#refunds)). For those, the deposit is effectively a one-time cost.

---

## What each action costs

This is the one table of what Forge costs; the other guides link here. Measured on **testnet, Platform 5.0.0-rc.4** (`dash-testnet-51`, protocol 14, SDK 5.0.0-rc.3), on **2026-10-17**, against isolated contracts with the release schemas. Each amount is the signing identity's stable proved balance change. The ECON-05 measurements and sample counts are recorded in `dash-forge-qa/evidence/testnet-rehearsal/econ/CALIBRATION.md` and `measurements.jsonl`.

A first write can create repository, author, target or identity-contract index state and cost more. The ranges below distinguish later writes from the measured first. **† means a historical devnet benchmark, not rerun on testnet**; large packs, imports, forks, external-storage pushes and key updates retain their named older provenance.

| Action | Cost |
|---|---|
| Create a public repository, members-only off | **~0.00139 DASH later, 0.00168 first**: repo, owner membership and config (three documents, no branch protection) |
| Create a public repository, members-only on (default) | **~0.00236 DASH** for the first measured bundle; later-owner bundles ~0.00229 DASH. Includes the initial anchor and owner key share |
| Create a private repository | **~0.00199 DASH** for the first measured bundle; later-owner bundles ~0.00200 DASH. Includes the owner membership, key share and anchor |
| Push with packs on Platform | **~0.00714–0.00742 DASH later, 0.00893 first** for four tiny public pushes with browse/history indexes. Exact 128-byte chunks cost 0.00058–0.00093, one manifest 0.00081–0.00129, one existing-name ref update 0.00058–0.00089. Larger packs: **~0.33–0.36 DASH per MiB measured historically†**, quoted at about 0.39; permanent storage |
| Push to your own bucket † | ~0.0040 DASH later, 0.0052 first on bonsia (2026-09-30); manifests, history index and ref, without Platform pack bytes |
| Push to a private repository, packs on Platform † | 20 KiB: 0.0112 DASH first; tiny follow-up 0.0022; three new branches 0.0078. Packs are sealed and slightly larger |
| History index † | Extra manifests and, on Platform, delta chunks; historical upper bounds ~0.0026–0.006 DASH for a typical push, occasional full index ~0.28 on dashpay/dash. See [History index](#history-index) |
| Each extra new branch or tag | **~0.00066–0.00067 DASH** (one ref update, commit already stored); protected existing-name ref updates ~0.00058–0.00089 |
| Each extra storage target † | ~0.00014 DASH per push (URI fields in manifests) |
| Issue | **~0.00070 DASH later, 0.00118 first** with a short body; a 1,000-byte body ~0.00097 DASH and 4,000-byte body ~0.00180 DASH |
| Comment | **~0.00052 DASH later, 0.00072 first** with a short body; a reply to an existing root ~0.00061 later, 0.00071 first. Immediate deletion refunded ~0.00039–0.00040; preview about 0.00038 DASH if deleted soon, less as it ages |
| Body, comment or release notes over 5,120 bytes | The document plus an artifact: quoted upper bounds ~0.010 DASH at 20 KB, ~0.021 at 50 KB on Platform, or a manifest with your own storage. Historical artifact estimates; see [forge-v2.md §6.3](../contracts/forge-v2.md#63-long-bodies-a-text-longer-than-its-field-client-convention-p1-9) |
| Pull request | **~0.00081 DASH later, 0.00149 first** for a patch alone in an empty repository. CLI `--draft` writes an extra transition: 0.00147–0.00204 for the bundle |
| Close, reopen, draft, ready or event-only merge | **~0.00046–0.00056 DASH later, up to 0.00073 first**. A merge that pushes code additionally pays its push |
| Label or pin event | ~0.00051–0.00057 DASH later; first label event ~0.00076 |
| Review | ~0.00040 DASH later on the same PR; ~0.00066 for each new PR's first, ~0.00075 including the author's first contract write. Anchored comments ~0.00053 later on the same thread, ~0.00073 first |
| Label / milestone definition | ~0.00034 DASH later, ~0.00050 first |
| Release document | ~0.00062 DASH later, ~0.00073 first; assets use your storage |
| Consent / add a writer | Consent ~0.00031 later, ~0.00043 first; writer grant ~0.00042 later, ~0.00049 first. Removing a writer without sealed content refunds part of the deposit |
| Star / unstar | **~0.00024–0.00025 DASH** for an established author's star in a populated repo; ~0.00057–0.00059 for an empty repo's first; ~0.00066 including the author's first write. Unstar immediately refunded ~0.00033; the preview says about 0.00032 DASH if deleted soon, less as it ages |
| Counting a star toward Trending | Included in the fused star's price. No separate starBeat document is written by the current contracts |
| Follow / unfollow | ~0.00019 DASH with both trees populated; ~0.00038 for a new target, ~0.00056 first. Unfollow immediately refunded ~0.00012 with another follower, ~0.00023 for the target's last |
| Watch / unwatch | ~0.00038 DASH later, ~0.00048 for a repo's first; unwatch immediately refunded ~0.00033; preview about 0.00032 DASH if deleted soon, less as it ages |
| Profile | ~0.00032 DASH create with a short name as the identity's first meta write (~0.00023 after prior meta writes), ~0.000028 same-size edit (three repeats) |
| Webhook | ~0.00077 DASH later, ~0.00101 first; removal immediately refunded ~0.00067 |
| Topic | ~0.00066 DASH later; ~0.00078 DASH first (CLI includes a config replacement). Raw documents with reused global names cost ~0.00048 DASH later; fresh names ~0.00062 |
| Pack mirror | ~0.00048 DASH later, ~0.00064 first with a short URI |
| Runner registration | ~0.00040 DASH later, ~0.00047 first |
| Policy / ban | Policy ~0.00027 DASH later, ~0.00035 first; ban ~0.00040 |
| CI check run | ~0.00072 DASH later, ~0.00122 first (queued check) |
| Bot push grant | ~0.00028 DASH later, ~0.00044 first. The CLI bot-allow aggregate cost ~0.00218, including its additional artifact writes |
| Fork a repository † | ~0.01 DASH for 8 packs / 5 branches, ~0.03 for 36 packs on moutai; parent packs referenced, not uploaded |
| Mirror a GitHub repository, first run † | Historical moutai examples: 0.078 DASH (`dash-faucet`) and 0.112 for a repository with 2 PRs, 15 comments and 7 reviews. No-new-content rerun: 0 |
| Top up a browser key's budget † | ~0.00002 DASH on moutai |
| Clone, fetch, browse, read issues, download a zip | **free** |

### Members-only and private content

New public repositories turn members-only content on, and a private repository is encrypted from the start, so these rows are the ones most repositories pay. Each is **per key share**: the key is wrapped to every member who holds it, one document each. The per-key figures below remain historical measurements on a Platform v5 devnet (October 2026) (`forge-web/lib/view/audience.ts` `ENABLE_ANCHOR_CREDITS` and `ENABLE_WRAP_CREDITS`; `dg`'s `keys::enable_estimate`).

| Action | Cost |
|---|---|
| Turn members-only content on (in a new repository, while you are the only member) | **~0.0011 DASH**: one anchor (~0.0004) and your key share (~0.0007) |
| Turn it on in an existing repository | ~0.0004 DASH plus ~0.0007 DASH per member who gets the key (~0.004 DASH for 5 members) |
| Add a member | the membership write (~0.0004 DASH) plus ~0.0007 DASH to share the key |
| **Remove a member** | the delete, plus a **key change**: ~0.0007 DASH per **remaining** member and ~0.0006 DASH more. It does not refund: removing one member from a 50-member repository (49 remain) costs ~0.035 DASH |
| Change a member between Write, Triage and Read | the membership write only; the key stays |
| Post a members-only issue, comment or review | 0 to 8 % more than the same thing in public |
| Post one to specific people | ~8 % more than a members-only one for 2 people, and a little more for each extra person |
| Make a post public (a maintainer's bundle) | ~0.0022 DASH per write |
| A publication date for a fix (an embargo record) | ~0.0007 DASH |
| Save an environment change | ~0.0025 DASH |
| Give a bot access, or change it | a few thousandths of a DASH: a manifest and one small chunk (twice that in a private repository, which also writes the bot its own copy). The dialog quotes it |

Removal is the one that surprises organisations: its cost grows with the number of members, and every removal pays it again. Add people in batches, and remove them only when you must. [Who can read what](../security/audiences.md#what-it-costs) explains what each step does.

**How Trending counts.** Trending on Explore ranks repositories by their **new stargazers in the last week** (or today, which is the UTC day so far: the windows start at 00:00 UTC), read with a proof from the star's weekly window index. Every new star counts. An unstar is refunded, but the star keeps counting in the windows it was in until they pass; starring the same repository again inside one of them counts once. Explore leaves private repositories and an owner's star of their own repository out of Trending when it reads the ranking. No index gives a star's time back, so it can only take the owner's star out of a repository created inside the window (less than a week old): an owner's star of an older repository may count, by one.

Where the historical numbers come from: the per-write balance changes recorded by the push calibration (2026-09-27/28; its figures are the constants in `forge_core::cost::push_fees`), the web app's measured model (`forge-web/lib/sdk/cost.ts`), the live measurements in the pull requests that built each feature and in [e2e/README.md](../../e2e/README.md), and the contract costs in [forge-v2.md §7](../contracts/forge-v2.md#7-measured-size-and-cost).

```sh
dg cost prices
```

```
Per-operation cost reference (upper bounds; see `dg cost audit` for what you've spent):
  (test DASH, no cash value on testnet)
  repo create                ~0.002 DASH (≈ $0.06 on mainnet)
  ref update                 ~0.00092 DASH (≈ $0.03 on mainnet)
  pack manifest              ~0.0014 DASH (≈ $0.04 on mainnet)
  pack chunk (14.7 KB)       ~0.00550791 DASH (≈ $0.17 on mainnet)
  issue (~500 B)             ~0.00168658 DASH (≈ $0.05 on mainnet)
  comment (~500 B)           ~0.00098658 DASH (≈ $0.03 on mainnet)
```

These are the upper bounds `dg` and `git push` quote before signing: each is priced as the first of its kind (a repository's first issue, a thread's first comment), at or above the most the table above measured for that write.

**Measured on devnet bonsia** (Platform 4.2.0-beta.7, 2026-09-30), where some writes cost more than on moutai: a repository's first issue 0.0012 DASH and a later one 0.0008; a first push to your own bucket 0.0052 DASH and a later one ~0.0040, the history index's manifests included; a limited key for `dg auth login` ~0.00027 DASH and a CI runner key 0.00043 (quoted 0.0005, one identity update); a CI check run 0.00082–0.00122 DASH (see [CI](ci.md#what-it-costs)).

**What you've actually spent.** `dg cost audit` estimates one identity's total Forge spend — with no repository argument, every document it has created across the network, totalled by type and by repository; give it a repository (`dg cost audit owner/name`) for that repository's live pack-storage tally instead: its packs on Platform and the deposit their chunks lock, and apart from them the packs kept off Platform (a bucket, IPFS, or a fork's parent), which lock none. forge-v2 keeps no on-chain spend ledger, so the identity audit is `(proved document count) × (that type's typical create cost, measured on devnet bonsia)`, with each pack's chunks priced by its size as `git push` prices them, the same figure shape as the web app's **Settings → Spend** ledger — but the two are not expected to agree: the web ledger is a per-browser history of actual balance changes (so it sees refunds, and misses writes made from any other browser or from `dg` itself), while this audit is a network-wide estimate at each type's flat rate (so it misses a first-of-its-kind write's or an unusually large write's true cost — see the table above). Treat both as estimates, and see [above](#what-each-action-costs) for where they can diverge. `--owner` takes an identity id or a DPNS name and defaults to the signing identity; `--since` takes a duration (`24h`, `7d`, `2w`, `1y`) or an absolute date (`2026-01-01`); neither combines with the repository argument. Its repository scope has one gap: a membership revoked with no other trace left in that repo (no issue/patch filed, no still-registered CI runner, and — in a public repo — no `repoKey`) cannot be found by any proved query; the command's own output says so. `chunk` counts also come from each owned pack's own `packManifest` rather than being queried directly, so a chunk uploaded by a push that never finished with a manifest (interrupted, or a mid-push membership revocation) is not counted either — the output notes this gap too. On a network with RC2's fused star (the three-contract devnet set) there is no `starBeat` to count (it isn't queried), and each star is priced at the fused star's ~46 M credits (a registration fee probe, not yet a measured charge).

```sh
dg cost audit --since 30d
```

```
Spend estimate for ExampLeidentityExampLeidentityExampLeidentEx:
  since:  2026-08-30 14:22:07 UTC
  total:  ~0.02585 DASH (≈ $0.78 on mainnet) across 38 document(s)

  by document type:
    comment                14  ~0.00728 DASH (≈ $0.22 on mainnet)
    issue                  11  ~0.00649 DASH (≈ $0.19 on mainnet)
    patch                   9  ~0.00648 DASH (≈ $0.19 on mainnet)
    chunk                   4  ~0.0056 DASH (≈ $0.17 on mainnet)

  by repository:
    9cBMULwtQUMtxhBkgaTKb4tJtoczd8TEQ8gmiroDWf4F     38  ~0.02585 DASH (≈ $0.78 on mainnet)

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

**Measured (v1):** backfilling dashpay/dash's v1 index with `dg repo reindex` on devnet moutai (Platform 4.2.0-beta.6, 2026-09-29) cost **0.02479 DASH** for 66,965 B (quoted 0.02455 before a repository's first-index margin was added; the quote now includes it and stays above the charge). That index was computed in a shallow clone, so its counts (33,553 / 7,979) were short; a shallow clone is now refused. The v2 backfill of the dash mirror waits for its re-import on testnet. Computing dash's full v2 index takes about 1.5 s on the pusher's machine.

`dg repo reindex <repo>`, run inside a clone that has the default branch's tip, publishes the index for a repository pushed before it existed, or a v2 index over a v1 one, and quotes its price before asking. A push that stores no new pack, such as a retry of a recorded one, publishes none; `dg repo reindex` fills that in.

**Why a repository is cheap.** Every repository lives in a few shared contracts (forge-core, forge-collab, forge-community and, on the production set, forge-meta), registered once per network by the deployer, not by you: 1.873 DASH for the four on testnet (2026-10-26) ([Deploying Forge to a network](../deploying-to-a-network.md#4-what-it-costs)). A new repository is then just three documents. The first version of Forge gave each repository its own contract, and contract registration fees made that cost about 1.18 DASH per repository; it was removed on 2026-09-26.

Packs are git packfiles: delta-compressed and deflated, typically 20–35% of the size of a checkout. Forge never stores raw files.

---

### Passkeys for other devices

A passkey's entry is one small stored item, written with this browser's key (so it comes out of that key's budget, like any write). Measured on testnet with the live test (`lib/auth/passkey-vault.live.test.ts`), which prints what each step costs.

| Action | About | Notes |
|---|---|---|
| First passkey on an identity | 0.0005 DASH | builds the identity's passkey list, so it costs more than the next ones |
| Each later passkey | 0.0003 DASH | |
| Update a passkey after a key change | 0.00003 DASH | a replace of its entry |
| Remove a passkey | refunds about 0.0003–0.0004 DASH | deleting returns the deposit |
| Sign in with a passkey | free | reads only |

At most 10 passkeys per identity. An entry is always the same size, whatever keys it holds.

### Boards

A board's definition is one document per member who edits it, and a card one document per member, item and board, replaced in place by every later change ([boards design](../design/boards.md#7-costs)). Measured on a testnet scratch set (2026-10-27, the same contract the live set gets) with the live test (`lib/repo/boards.live.test.ts`), which prints what each write costs.

| Action | About | Notes |
|---|---|---|
| Create a board | 0.00064 DASH, 0.00055 for a repository's later boards | with the Kanban template's 738 bytes of name and definition; a longer definition costs more |
| Edit, close, reopen or delete a board | 0.00004–0.00005 DASH | a replace of your revision |
| Put an item on a board, or move a sourced item for the first time | 0.00071 DASH for the item's first card, 0.00089 for the board's first, 0.00043 when another member already has a card for it | your first card for the item |
| Move a card, set its fields, archive or remove it | 0.00005 DASH | a replace of your card |

## Platform or your own bucket

Pack bytes are almost all of a repository's size, so where you keep them decides the cost:

| Where packs live | You pay | For a 50 MiB repository with 10 pushes a month |
|---|---|---|
| **Your bucket** (R2, B2, S3, MinIO) or IPFS | Platform: manifests + refs per push. Provider: storage and egress, at their prices. | ~0.04 DASH a month on Platform (~0.004 DASH a push to the default branch on bonsia, its history index included), plus cents to your provider (R2 has no egress fees) |
| **Dash Platform** | ~0.33 DASH per MiB pushed (quoted up to 0.39), plus ~0.004–0.011 DASH per push | ~17 DASH for the first upload, then ~0.33 DASH per MiB pushed |

Platform storage buys you something: it is stored by the network, and it can never be deleted, even by you. Your bucket is cheap, but it is only as available as your account with the provider. You can have both: `dg storage use r2-main,platform` keeps a copy in each place. See [Bring your own storage](bring-your-own-storage.md).

If you set nothing, **packs go to Platform**. That is fine for small repositories, and expensive for large ones.

---

## Refunds

When a document is deleted, Platform refunds the part of its storage deposit that has not been used yet. Platform spreads the deposit over 2,000 epochs, so how long a refund lasts depends on the network's epoch length (table below). The burned part never comes back. Only the identity that paid can get the refund, and only by deleting its own documents.

| Network | Epoch | The deposit is spread over | Delete a document after… | …and get back about |
|---|---|---|---|---|
| Mainnet | about 9 days | about 50 years | weeks or months | nearly all of the deposit |
| Testnet | 1 hour | **about 83 days** | 1 day / 7 days / 14 days / 30 days / 60 days | 97 % / 80 % / 64 % / 36 % / 7 % (nothing after about 83 days) |
| Devnets | set per devnet | 2,000 of its epochs | depends on the devnet | depends on the devnet |

On testnet, a document deleted after a few weeks returns only part of its deposit, and after about 83 days none. The web app says "refunds **about** X if deleted soon; less as it ages": X is a conservative approximation from immediate-delete measurements, not an upper or lower bound. An older document may refund zero. The percentages come from Platform's fee distribution table (`FEE_DISTRIBUTION_TABLE` in rs-dpp), not from a Forge measurement.

**What can be deleted, and so refunded:**

| | Deletable? |
|---|---|
| Pack chunks and manifests | **No.** Platform-tier storage is permanent, so that nobody can break a repository by deleting what others depend on. `dg repack` consolidates into a new pack and deletes nothing on Platform. |
| Issues, PRs | **No**, so that threads cannot be rewritten |
| Ref updates, config, events | No, never (they are the audit trail) |
| The `repo` document | No |
| Membership documents (`writer`, `maintainer`) | Yes, by the owner (that is how a collaborator is removed) |
| Comments, reviews, labels, webhooks, stars, follows, your profile | Yes, by the author |
| Release revisions | No. Release revisions are permanent; unpublish appends another revision |

There is no `dg repo delete`: a repository cannot be deleted.

The audit trail grows forever: each ref update costs about 0.0006–0.0009 DASH and never comes back, about 0.6–0.9 DASH per 1,000 pushes. That is the price of a history nobody can rewind.

---

## Seeing costs before you pay

- **`dg` asks first.** Every command that writes asks before it writes (`[y/N]`; `dg init` and `dg repo create` ask `Proceed? [Y/n]` after showing the price) unless you pass `--yes`. `dg repo create`, `dg repack` and `dg repo reindex` show their price before the question. For other commands, use `dg cost estimate` before you write (in a repository it quotes a first push of it to `--backend platform`, `s3`, `ipfs`, `https` or `mixed`) and `dg cost prices` / `dg cost audit` to see the reference table or what you've already spent. With `--json` or no terminal, `dg` refuses to write without `--yes` ([`E802`](../errors.md#e802)).
- **`git push` prints its estimate** before it writes to Platform, and what Platform actually charged when it is done. The estimate prices every write as the first of its kind, so it is an upper bound: 1.08–1.27x the charge on a first import of 1 MiB or more, up to about 1.6x on a tiny first push and 1.85x on a small later one. It asks before spending more than 0.05 DASH by default, and before storing more than 1 MiB on Platform when `dash.storage` is unset (Platform packs are permanent). To change that:
  ```sh
  git config --global dash.costWarnThreshold 0.1    # ask above 0.1 DASH (default 0.05; `off` disables the threshold)
  git config --global dash.confirm auto             # auto | always | never | refuse
  ```
  Without a terminal (CI), a push over the threshold stops with [`E801`](../errors.md#e801) rather than spending. Before it uploads anything, a push also checks that your balance and your key's remaining budget cover the estimate ([`E401`](../errors.md#e401) / [`E402`](../errors.md#e402)); a push resumed after an interruption quotes only the chunks left.
- **`forge-import --dry-run`** estimates a whole GitHub import, and `--max-spend` caps it. Without `--max-spend`, a run is capped at the estimate it shows you.
- **`dg init` and `dg repo create`** stop before creating anything when no storage is chosen, and quote what Platform storage would cost for this repository ([E508](../errors.md#e508)).
- **The web app** shows the price on every button that signs (repository, issue, comment, state change, review, member, star, release, key top-up), with refunds for deletes. After each write a toast shows the actual balance change. **Settings → Spend** keeps a local ledger in this browser: month and all-time totals by repository, and estimates that missed by more than 25 %.
- **Limited keys cap spending.** A browser key can spend at most its budget (0.05 DASH by default), and a CI runner key its own (0.5 DASH). Platform enforces the budget at consensus, whatever the software does. See [Identity and keys](identity-and-keys.md#limited-keys).
- **The Mirror Action** has a per-run `cost-cap` (0.05 DASH by default) and reports what each run spent in the job summary.
- **`dg cost audit`** totals what an identity has spent on Forge, from proved document counts (not a local ledger — see [above](#what-each-action-costs)); `--since` narrows the window, `--json` for scripting.

## Prices in the web app

**Settings → Prices** chooses the currency shown beside DASH costs and can turn prices off.
Rates come from [CTX](https://ctx.com/) (`rates.ctx.com`), with [CoinGecko](https://www.coingecko.com/)
(`api.coingecko.com`) as a fallback.
The app caches rates for 10 minutes and can use them for up to 24 hours while offline; without
an available rate it shows DASH alone. Providers see your IP address, standard browser headers
and that the request comes from this site. Turning prices off stops rate requests. On test
networks, costs say “on mainnet”; free test balances have no cash value and get no fiat figure.
Settings → Spend values use today's price, rather than the price when the write happened.

The CLIs use the same live mainnet rates, with the settings, cache and opt-out described above.
Rates have no refresh timer: an idle page rechecks expiry when rendered or made visible again;
the “updated” age changes on render.
