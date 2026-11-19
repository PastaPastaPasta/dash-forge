# New-user pass on testnet, November 2026

A first-time user's walk through Dash Forge on testnet on 2026-11-19: the live web app at <https://forge.dashhq.org> (build `ac39b084`, master after #611) and `dg` / `git-remote-dash` built from the same commit.

- **Browser:** Playwright's headless Chromium 1248, four fresh profiles. Desktop is 1366×900; phone is 390×844 with touch. The passkey was a CDP virtual authenticator.
- **CLI:** a fresh `HOME` with no config, no keychain, and `gh` not signed in.
- **Identities:** two new identities funded from the testnet faucet. Neither is a nightly fixture.
  - `FRxiZ1SgLCn2NYgwTLTUUW3jMeKhn7WFFwcQMatPusgH` ran the main walk. It was funded with 1 tDASH, and the pass spent 0.0508 tDASH.
  - `3vyaPDqA4ZHfQvRjChxw4nYdsx87WXTfatTEiYDD2Pr3` ran the out-of-credits test. It was funded with the 0.02 tDASH minimum.
- **Repos created:** `nov-qa-web` (web), `nov-qa-cli` (`dg init`) and `prime-number-finder` (`dg import`), all owned by `FRxiZ1S…`.
- **Screenshots:** they are on the orphan branch [`evidence/new-user-pass-nov`](https://github.com/PastaPastaPasta/dash-forge/tree/evidence/new-user-pass-nov/new-user-pass-nov); the file names below refer to that folder.

## Verdict

**Not ready for a public testnet beta yet, but close.** The core loop works for a newcomer, and most of it works well:

- create an identity in the browser;
- create a repo, push with plain `git push`, clone and fetch;
- issues, labels, boards, PRs and a browser merge;
- error messages for bad remotes and wrong keys.

The new-identity flow took about 60 s from the faucet payment to being signed in, with one passkey prompt and no signing prompts.

What stands in the way:

1. Every issue and PR page shows an error in its Boards sidebar. This is fixed in this PR but not deployed yet.
2. `dg import` breaks halfway for anyone whose key is passphrase-sealed, which includes every Linux box without a keyring.
3. The first sign-in option on testnet, "Use my Dash wallet", cannot be completed with any wallet a user can install.
4. The merge box shows "Enforced by Dash Platform" for protected branches, which the October proof audit disputes.

### Top 5 fixes before a public beta

1. **Deploy this PR.** It fixes the Boards sidebar error on every issue and PR page (F1), plus the CLI and copy fixes below.
2. **Make `dg import` hand its unlocked key to its `git push`, as `dg init` does** (F2). Today it charges for the repo and then fails with E303 wrapped as E101.
3. **Make the wallet tile honest until a released wallet can answer on testnet** (F3). Move it below "Create a new identity" or say on the tile itself that it needs a development build. The v2 copy also contradicts itself on spending limits. This is an owner decision.
4. **Settle what the "Enforced by Dash Platform" chip claims for protected branches** (F4). Either narrow it to what consensus checks (the maintainer-only document) or switch it to "Forge apps enforce this". Owner and security decision.
5. **Have `dg init` check the balance before it creates the repo, and default its storage prompt to Platform for small repos** (F10, F11). A new user who presses Enter today lands in bucket setup, and an underfunded one pays for a repo whose first push then fails.

## Costs measured (testnet, tDASH)

| Action | Shown before | Charged |
|---|---|---|
| Identity creation (1 tDASH deposit, key included) | min 0.02 deposit | 0.001806 |
| Browser key from the recovery phrase (import) | 0.000265–0.00048 | 0.000275 |
| `dg auth login --mnemonic` (CLI key) | ~0.0005 | 0.000278 |
| Repo create (web) | ~0.001892 | 0.001672 |
| Label definition + first issue | ~0.000597 + ~0.001246 | 0.001709 together |
| Add label + comment + close | ~0.000927 + ~0.001681 | 0.002329 together |
| Board create (Kanban) | ~0.000806 | 0.000644 |
| Board quick-add (an issue and its card) | not shown | 0.001583 |
| `dg init` (create + first push of 349 B on Platform) | ~0.002 + "16 KiB ≈ 0.0074" | 0.00239 + 0.00792 |
| Plain `git push` of 377 B on Platform | est 0.0136 | 0.0079 |
| Branch push | — | 0.0040 |
| Open a PR (web) | ~0.001711 | 0.001421 |
| Comment-only review | ~0.000728 | 0.000666 |
| Merge (fast-forward, web) | ~0.004748 + storage ~0.003357 | 0.002377 |
| `dg import` of a 3 KiB MIT repo | ~0.019427 | reported 0.019427; the balance dropped 0.012033 |

## Approvals and prompts counted

- **Create a new identity (web):** reveal the words, "I wrote them down", a 3-word quiz, "Use a passkey" (**1 OS passkey prompt**), "Continue to funding", then pay. No signing prompt: the identity registers on its own when the deposit lands (about 60 s).
- **Import a recovery phrase (web):** one click, "Create this browser's key", after typing the phrase and a passphrase twice. About 19 s at phone width.
- **`dg auth login --mnemonic`:** the 12 words, one `[y/N]`, then a key-file passphrase twice (there was no OS keychain).
- **Each web write:** a "Sign & …" confirmation for repo create, label define, label add, close with comment, board create and review. Issue create, PR create, board quick-add, card moves and merge sign in place, with the cost shown inline (none for quick-add and card moves, F17).
- **App Connect (wallet):** the QR appears in about 8 s and nothing further can happen without a wallet (F3). The October iOS Simulator run with a patched wallet needed 8 approvals for the first login (#591).

## Findings

Severity: **blocker** stops a newcomer outright; **major** breaks a main path or misleads about safety; **minor** is a wrong or confusing step with a way through; **polish** is copy or layout.

### F1 — Major — Every issue and PR page says "This page couldn't read the boards" — fixed here

- **Steps:** open any issue, for example `/FRxiZ1SgLCn2NYgwTLTUUW3jMeKhn7WFFwcQMatPusgH/nov-qa-web/issues/1`, and scroll to the sidebar's **Boards** section. **Try again** fails the same way.
- **Cause:** `readItemCards` (and the CLI's `item_boards`) queried `card.onItem` with `item ==` and `repoId in [...]`.
  - Drive accepts an `in` clause only on an index's last two properties (`rs-dpp` `matches_over_components`). `repoId` is the second of `onItem`'s four properties.
  - Testnet answers `where clause on non indexed property`.
  - The bug came in with 6631c1e2 in #611. Its unit test's mock never checked index rules.
- **Fix in this PR:** read the item's own repo with `repoId ==`. Then, only when the owner has other public repos, read with `item ==` alone (bounded) and keep only theirs. Both query shapes were checked live against testnet with the SDK.
- **Screenshot:** `21-issue-boards-sidebar.png`.

### F2 — Major — `dg import` fails halfway when the key is passphrase-sealed — not fixed (bigger than copy)

- **Steps:**
  1. On a machine without an OS keychain, run `dg auth login --mnemonic`.
  2. Run `gh auth login` (or set `GH_TOKEN`).
  3. Run `dg import https://github.com/PastaPastaPasta/prime-number-finder --repo prime-number-finder --max-spend 0.05`.
- **Result:**
  - `dg` asks for the passphrase and creates the repo (0.002 tDASH charged).
  - Then its own `git push` fails with "your key is sealed with a passphrase, and there is no terminal to ask for it on [E303]".
  - That is reported as **E101 "the command failed … report it"**.
- **Cause:** `forge-import`'s `GitSync::run` sets `GIT_TERMINAL_PROMPT=0` and passes only the key path. It never hands the helper the key `dg` already unlocked (`key_handoff::attach`, which `dg init` uses).
- **Workaround:** set `DASH_FORGE_PASSPHRASE`. With it, the same import wrote 1 ref, 1 pack and 9 labels.
- **Also:** the summary reports "spent: 0.019427", the estimate, while the balance fell 0.012033.
- **Cost of the failed run:** 0.002 tDASH.

### F3 — Major — Wallet sign-in can't be completed, and it is the first option on testnet — not fixed (owner decision)

- **Steps:** open a fresh profile, click **Sign in**, then **Use my Dash wallet**.
- **Result:**
  - The v2 QR says "Needs a Dash Wallet build that supports App Connect v2, which may be a development build."
  - The older code says "Needs a testnet development build … No build has that yet."
  - Yet the tile is listed first on testnet (`walletSignInSupported('testnet')`) and promises "approve once for all of Forge".
  - The v2 screen says the approval spends "up to 0.05 DASH … until Feb 17, 2027", while the warning under it says the key has "no spending limit or expiry unless your wallet sets one; today's wallets don't".
  - DashConnect has since shipped in released wallets (Android v11.9.1+, iOS v9.1.1+), but #591 (the PV13 pin) and the protocol-14 testnet mean none can answer here today. This was not tested on a device.
- **Screenshots:** `w01-wallet-connect.png`, `w02-older-code.png`.

### F4 — Major — "Enforced by Dash Platform" on a protected branch — not fixed (owner/security decision)

- **Steps:** open PR #3 on `nov-qa-web` and look at the merge box: "main is protected. Only maintainers can merge into it. **Enforced by Dash Platform.** Dash Platform refuses any change that breaks this rule, whichever app sends it."
- **Why it matters:**
  - The 2026-10-27 proof audit found protected branches were enforced by clients only.
  - `collaborating.md` says protected refs move only through a maintainer-only document type, which consensus does gate, and that a plain update to a protected ref "is ignored by every reader", which is enforcement in readers.
  - The chip claims more than the second half delivers.
- **Screenshot:** `w14-pr-opened.png`.

### F5 — Minor — `/<owner>/<repo>/boards` showed "Nothing here" — fixed here

- **Steps:** open `https://forge.dashhq.org/FRxiZ1SgLCn2NYgwTLTUUW3jMeKhn7WFFwcQMatPusgH/nov-qa-web/boards`. `/issues`, `/pulls`, `/labels` and `/settings` all work.
- **Fix:** the short-URL shim and its TypeScript twin now map `/boards` and `/boards/<key>`.
- **Screenshot:** `23-boards-empty.png`.

### F6 — Minor — An empty repo tells a browser-made identity to run `dg auth login <identity file>` — fixed here

- **Problem:** an identity created in the browser has 12 words and no identity file. The empty-repo page and the mirror wizard both printed the file form, although `dg auth login --mnemonic` exists.
- **Fix:** both now print `dg auth login --mnemonic --network testnet`, and the page says it asks for the 12 words and that an identity file works too.
- **Screenshot:** `10-repo-page.png`.

### F7 — Minor — `dg import` without a signed-in `gh` was E101 "report it" — fixed here

- **Steps:** with a fresh `HOME`, run `dg import https://github.com/octocat/Hello-World --dry-run`.
- **Result:** E101 with the fix "run it again with RUST_LOG=debug … report it". The wrapped text did contain gh's own "please run: gh auth login".
- **Fix:** E204 with "sign the GitHub CLI in with `gh auth login`, or set GH_TOKEN" and a link to install `gh`. `docs/errors.md` documents it.

### F8 — Minor — The out-of-credits hint said the faucet "funds an identity" — fixed here

- **Steps:** with an identity holding 0.0179 tDASH, `dg init` a repo containing a 100 KB random file on Platform storage.
- **Result:** a clear E401 ("estimated at 0.0499 … the identity has 0.0152 … nothing was stored or paid for"). But one fix line read "on testnet the faucet at https://faucet.thepasta.org funds an identity". The faucet pays Core addresses only.
- **Fix:** the line now points to the web app's **Top up credits** sheet (click the balance, enter the 12 words, pay the address it shows from the faucet). `docs/errors.md` E401 is updated to match.
- **Screenshot:** `p03-topup-sheet.png`.

### F9 — Polish — Nested parentheses in the deposit step — fixed here

- **Was:** "Send at least 0.02 DASH (≈ $0.73 on mainnet) (0.05 suggested (≈ $1.82 on mainnet)) to this address…"
- **Now:** the suggested amount has its own clause.
- **Screenshot:** `06-fund.png`.

### F10 — Minor — `dg init`'s storage prompt defaults to "set up new storage" — not fixed (behaviour change)

- **Steps:** with no storage configured, run `dg init`.
- **Result:** the choices are `1) set up new storage now (dg storage add)` and `2) platform …`, and the default is `[1]`. A newcomer who presses Enter starts S3 or bucket setup.
- **Contrast:** the web treats Platform as the default ("No storage configured: pushes will be stored on Platform").

### F11 — Minor — `dg init` creates and charges for the repo even when its own estimate says the push can't be paid

- **Steps:** same as F8.
- **Result:**
  - The plan showed "112.0 KiB ≈ 0.0433 DASH" against a 0.0179 balance.
  - `dg init` asked to proceed, created the repo (about 0.003 tDASH) and only then stopped the push with E401.
  - It leaves an empty repo behind.

### F12 — Minor — A fresh `dash://` clone of a 377-byte repo took 24 s

- **Steps:** with a fresh `HOME`, run `git clone -c dash.network=testnet dash://FRxiZ1SgLCn2NYgwTLTUUW3jMeKhn7WFFwcQMatPusgH/nov-qa-web`.
- **Times:** 24 s. The no-op `git fetch` afterwards took 1.0 s, and a clone through the HTTPS gateway took 11.4 s.
- **Caveat:** the host was heavily loaded during the pass (see F21), so treat these timings as an upper bound.

### F13 — Minor — A second payment to the new-identity deposit address is silently left behind

- **Steps:** during **Create a new identity**, pay the deposit address twice (I sent 1 tDASH twice by mistake).
- **Result:** the identity registers from one payment. The other 1 tDASH stays on the address, and the UI never mentions it. Only the 12 words can recover it, with tools outside Forge.
- **Note:** the discard path does warn about funds left on the address. The success path doesn't.

### F14 — Polish — Sign-up ends on the home page with no next step, and with a second "passkey" banner

- **Problem:**
  - After the identity registers, the dialog closes onto the landing page; nothing suggests creating a repo.
  - A banner offers "Set up a passkey" right after the user protected the key with one. The first passkey seals this browser's key; the banner is the cross-device passkey vault.
  - Two features with one name read as a bug. On a phone the banner wraps to five lines.
- **Screenshots:** `07-after-fund.png`, `m02-after-import.png`.

### F15 — Polish — The landing page's "Recent repos" is empty, or shows test fixtures

- **Problem:**
  - Before anything was pushed that week it read "No new repos with a description and a push this week".
  - Afterwards it was dominated by the nightly's fixtures (`e2e-cli`, `e2e-settings-4419343-7695`, `e2e-cli-fork-e2e-cli`).
  - A visitor's first impression is either an empty or a test-data forge.
- **Screenshot:** `01-landing-desktop.png`.

### F16 — Polish — The board page shows two view switchers, and the filter box looks pre-filled

- **Problem:**
  - "Board / Table / Roadmap" appears as tabs and again as a segmented control a few pixels lower.
  - The filter's placeholder (`status:"In progress" assignee:@me priority:P0`) is dark enough to read as a typed query.
- **Screenshot:** `28-add-item.png`.

### F17 — Polish — Board quick-add and card moves are paid writes with no cost shown

- **Problem:** pressing Enter in **Add item** creates a real issue (about 0.0013 tDASH) plus a card. A drag is a card write. Every other write shows its price first.
- **Screenshots:** `28-add-item.png`, `30-card-moved.png`.

### F18 — Minor — `dg import --limit 5` doesn't bound what a newcomer expects

- **Steps:** run `dg import https://github.com/octocat/Hello-World --limit 5 --max-spend 0.05 --dry-run`.
- **Result:**
  - The plan was "1389 ref updates · 2 packs (14.5 MiB) · 5 PRs · 2599 comments · 1628 reviews", about 10.997 DASH.
  - `--max-spend` correctly stopped it before writing.
  - It isn't clear from the output whether the comments and reviews belong to the 5 PRs; this needs a closer look.

### F19 — Polish — Wording left over from file sign-in

- **Problem:** `dg auth login --mnemonic` ends with "the identity file is no longer needed here; keep it (or the words) offline", although no file was used.

### F20 — Polish — Cost ranges disagree with each other

- **Problem:** the landing page and the sign-in dialog say a push costs "0.004–0.011 DASH" with packs on Platform. The helper's estimate for a 377-byte push was 0.0136, and it charged 0.0079.

### F21 — Observation — "Couldn't read the keys stored in this browser" under heavy CPU load

- **What happened:**
  - About 70 minutes in, the desktop profile appeared signed out. The sign-in dialog said: "This browser's storage (IndexedDB) did not open within 10 s…"
  - It happened again on a brand-new profile. Even `indexedDB.databases()` on `/robots.txt` hung.
- **Cause:** both times the host's load average was about 110 on 28 cores, from builds by this pass and by other jobs. Once the load fell, a new profile worked normally.
- **Assessment:** probably environmental. But on a slow or busy machine the 10 s budget turns into an apparent sign-out, and the advice to "close other tabs or reload" doesn't help.
- **Screenshot:** `41-signin-again.png`.

### F22 — Polish (known, owner item) — The Cloudflare beacon still breaks the CSP

- **Result:** every page logs two CSP violations for `static.cloudflareinsights.com/beacon.min.js`. Tracked as an owner item (see #618).

## What worked well

- **Errors:**
  - A wrong recovery phrase says "No identity on testnet uses these words' master key".
  - A bad checksum explains misspelt or swapped words.
  - The right phrase with the wrong identity id names the right identity.
  - A bad `dash://` owner or name gets E102 with `dg repo list` and `dg doctor` hints.
  - Out of credits is E401 with "nothing was stored or paid for".
  - Screenshots: `w11-*.png`.
- **`dg doctor` on a fresh `HOME`:** it explains every missing piece and how to fix it.
- **Plain `git push` and the remote helper:** clear progress, estimates and receipts, with the remaining balance.
- **Issues, labels and close-with-comment:** each is one confirmation, and the cost is shown up front.
- **Boards:** create (Kanban template), quick-add, keyboard move, and the move persists across a reload.
- **PR:** opened in the web, a comment-only review (self-approval is correctly refused), and a browser fast-forward merge. The merge closed the linked issue (#2) and deleted the branch.
- **Phone width (390 px):** no horizontal overflow on the landing, repo, issue list, issue, board, new-repo, settings, explore, mirror or profile pages.

## Not covered

- **App Connect on a real phone:** no wallet can answer on testnet today (F3).
- **Bring-your-own storage (S3 or IPFS):** this pass used the default, Platform storage.
- **Draining the web app's balance to zero:** the 0.0179 identity was stopped by the CLI's E401. The web top-up sheet said the remaining balance "covers about 11" issues.
- **The web mirror wizard beyond its first step.** The CLI import above covers the same ground.
