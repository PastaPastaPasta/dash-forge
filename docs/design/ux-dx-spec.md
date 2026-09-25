# Dash Forge — UX / DX Specification (forge-v2, PV14)

Status: proposed, 2026-09-25. Companion to `roadmap.md`, `contracts/forge-v2.md`, `design/style-guide.md`; where an older PRD disagrees, this spec wins.

**Thesis for every screen:** *We host nothing. You bring an identity and a bucket; the chain proves the rest.* Every flow is judged by four questions: needs a Forge-run server (never), shows cost before spending (always), claims more than was verified (never), changes the git workflow (never).

Numbers: 1 DASH = 10¹¹ credits; storage = 27,000 credits/byte, so **1 KiB ≈ 0.00028 DASH, 1 MiB ≈ 0.28 DASH**. Repo creation ≈ 0.0005–0.001 DASH; a push to the user's own bucket ≈ 0.0002–0.0004 DASH (manifest + refs). Fiat examples assume $34/DASH.

---

## 1. First-run journeys

| Journey | Time-to-value target | Measured from → to |
|---|---|---|
| (a) Visitor opens a repo link | README readable **< 3 s**, first file **< 2 s** more | URL load → text on screen (cold, warm gateway) |
| (b) Maintainer sets up an unkillable mirror | **< 10 min**, no local install | lands on `/mirror` → first green Action run |
| (c) Developer creates a repo and pushes | **< 5 min** after install, **< 90 s** with funded identity | `dg auth new` → `git push` succeeds |
| (d) Contributor files an issue / opens a PR | issue **< 2 min** with identity; PR from an existing branch **< 3 min** | click "New issue" → issue visible |
| (e) Team creates a private repo | **< 10 min** for owner + 2 members | "New repo" → member clones and decrypts |

### (a) Visitor from a link
URL: `forge.dashhq.org/alice/project` (short form; §5.2). No sign-in, wallet prompt or cookie banner. Repo home paints README + file list from the browse plane. The Verification card starts as **"Checking…"** and settles within a second; never green before the proof arrives. Unreachable storage shows the state in §6.3 while refs and issues keep working.

### (b) GitHub maintainer: unkillable mirror in < 10 minutes
Entry: `forge.dashhq.org/mirror` (hero link **"Mirror a GitHub repo"**). A 5-step wizard, resumable (IndexedDB), with a rail showing running cost and what each step writes on-chain.

1. **Identity** (§2). Tiles: *Use my Dash wallet*, *Create a new identity*, *I have an identity file*. Ends with a limited key in the browser vault.
2. **Repository** — name prefilled from the GitHub URL, description. `~0.0006 DASH ≈ $0.02 · one-time`. **Create repository**.
3. **Storage** — the bucket wizard (§3), ending with passing CORS + public-read checks. Platform-only is offered last, priced.
4. **Runner key** — a second limited key: budget **0.5 DASH**, expiry **365 days**, bound to the `dash-forge` group. Copy: *"The Action signs with its own key. If it leaks, an attacker can spend at most 0.5 DASH, only on Forge, only until <date>. Disable it any time."* Shown once in a copy box labelled **`DASH_FORGE_KEY`** with an **"Add to GitHub secrets"** deep link; the page won't advance until "I saved it" is ticked.
5. **Workflow file** — the YAML from §8, prefilled, with **"Create this file on GitHub"** (`github.com/<o>/<r>/new/main?filename=.github/workflows/forge-mirror.yml&value=…`). Final: *"Push anything to GitHub. Your mirror updates within a minute. Verify at `forge.dashhq.org/alice/project`."*

### (c) Developer: repo + push via CLI
```
$ curl -fsSL https://forge.dashhq.org/install.sh | sh     # verifies sha256 + minisign against the GitHub Release
$ dg auth new                                              # §2.3; prints QR, waits for funds, saves to keychain
$ cd my-project && dg repo create --push                  # creates on-chain, adds remote 'origin', pushes HEAD
```
`dg repo create --push` output:
```
Creating alice/my-project on mainnet
  repo + maintainer + config     0.00058 DASH  ≈ $0.02
  packs → r2-main (1 of 1 must confirm); Platform: manifest + refs only
Proceed? [Y/n] y
✓ created  https://forge.dashhq.org/alice/my-project
✓ remote 'origin' → dash://alice/my-project
pushing 1.2 MiB (312 objects)
  r2-main   ████████████████████ 1.2 MiB  verified sha256
  platform  manifest 1 · refs 1          0.00031 DASH
✓ main → 8f3e2a1   total this push 0.00031 DASH ≈ $0.01 · balance 0.4812 DASH
```
With no storage profile the command stops before creating anything: *"No storage profile. Packs would go to Platform at ~0.28 DASH/MiB (1.2 MiB ≈ 0.34 DASH). Run `dg storage add` first, or pass `--storage platform` to accept that price."*

### (d) Contributor: issue and PR from the browser
- **Issue**: `Issues → New issue`: title, Markdown body with preview, `~0.0004 DASH`. Signed-out click opens the sign-in sheet with the draft preserved. On a duplicate-number race the client retries once, then says *"Someone claimed #42 a moment ago; retrying as #43."*
- **PR from an existing branch**: source picker lists branches the user can write plus the user's forks of this repo (`forkOf` query); base defaults to the repo default; the diff renders before submit; `~0.0005 DASH`. Nothing is pushed here. Copy: *"Need to push a branch first? `git push dash://you/project HEAD:my-fix`."*
- **Fork** button: `repo` with `forkOf` + owner `maintainer` + `config` pointing at the parent's packs, no re-upload, `~0.0006 DASH`. P0, because outsider PRs depend on it. **Suggest a change** (edit → fork → push → PR) is P1.

### (e) Team: private repo
`New repo → Visibility: Private`, with: *"Contents are encrypted in the browser and CLI with a key only members hold. File, branch, issue and comment names are encrypted too. Anyone can still see that the repo exists, its size, and when it changes."* After creation the Members panel (§9) prompts to add members and explains the encryption-key requirement.

---

## 2. Identity and authentication

### 2.1 Principles
- The **master key never lives in the browser**, unencrypted on disk, or in CI. It appears only in one-time ceremonies: registering limited keys, a DPNS name, an encryption key.
- Daily use runs on **PV14 limited keys**: AUTHENTICATION, level HIGH, bound to the `dash-forge` contract group, with budget and expiry. Defaults: browser **0.05 DASH / 90 days**, CLI **0.25 DASH / 180 days**, CI runner **0.5 DASH / 365 days**, all editable at creation.
- Nothing is sponsored; mainnet and testnet never show a faucet. Dev builds (`NEXT_PUBLIC_FORGE_DEV=1`, `dg --network devnet`) do.

### 2.2 Browser: getting an identity
Sign-in sheet (replaces `login-modal.tsx`): three tiles plus an "Advanced" disclosure.

1. **Use my Dash wallet** (app-connect, PV14; first when the contract exists on the active network). App creates an ephemeral keypair → QR / deep link with the request (group `dash-forge`; one AUTHENTICATION HIGH key, budget 0.05 DASH, expiry 90 days; ENCRYPTION optional for private repos) → polls `loginKeyResponse` by `appEphemeralPubKeyHash` → decrypts the grant → **verifies on-chain** that the key is live on the responder with the requested bounds, budget and expiry → vault. Waiting copy: *"Approve in your wallet. Forge gets a key that can spend at most 0.05 DASH, only here, until <date>."* After 3 min: *"No response yet. Keep this tab open, or choose another method."* If no wallet supports it yet the tile says so — *"needs a wallet with Platform login (list)"*.
2. **Create a new identity** (funds from any Dash wallet). (i) 12-word mnemonic generated in-browser; the user confirms three words before continuing; (ii) deposit QR with amount (default 0.05 DASH, min 0.02; *"This becomes your Platform credits. ~0.0005 DASH per issue or push."*); (iii) watch the address, build and broadcast the asset lock, wait for InstantSend, register the identity **with the limited key inside the IdentityCreate** so no second signature is needed; (iv) the master key exists only in memory during this step. Note under the QR: *"To see your deposit this page asks a Dash block explorer (`insight.dash.org`, changeable in Settings). It can delay you but cannot take funds or keys."*
3. **Import an identity file** (bridge JSON, `dg auth export`, or mnemonic): the master key signs one `IdentityUpdate` registering a limited key and is discarded. *"Your master key is used once, right now, to create a limited key for this browser. It is not stored."*

**Advanced**: paste a raw key (developer path; red warning; tab-scoped unless opted into the vault).

### 2.3 The browser vault
- Holds limited key(s), storage credentials (§3), the local spend ledger. Never the master key.
- AES-256-GCM under **passkey PRF** when available, else **Argon2id(passphrase)** (m=64 MiB, t=3); both can be enrolled. Auto-lock after 12 h or sign-out.
- Header pill: DPNS name (or 8-char id), balance, and a thin **key budget bar**. Tooltip: *"This browser's key: 0.031 of 0.05 DASH left · expires 24 Dec."*
- Budget < 20 % or expiry < 7 days: amber pill + banner *"This browser's key is nearly used up. Renew (uses your master key once)."* Renewal = a new limited key via any of the three routes; `IdentityKeyLimitsUpdate` top-up when a master key was imported anyway.

### 2.4 CLI auth
```
dg auth new        [--amount 0.05] [--name alice]    # mnemonic → QR asset lock → identity + keychain entry
dg auth login      [<file> | --mnemonic]             # import; registers a limited key by default (--full-key to keep the master key in the keychain)
dg auth status                                       # identity, name, key id, budget left, expiry, balance, where the key is stored
dg auth balance
dg auth keys list | add [--budget 0.25 --expires 180d --bound dash-forge] | disable <id>
dg auth name register <label>                        # DPNS; needs the master key (prompts for file/mnemonic)
dg auth export --reveal-secrets                      # writes a bridge-format file, 0600
dg auth logout
```
Storage: OS keychain (macOS Keychain, Secret Service, Credential Manager), service `dash-forge`, account `<network>/<identityId>`. No keychain (headless Linux): `~/.config/dash-forge/identities/<network>-<id>.key`, **passphrase-encrypted** (scrypt); `--insecure-plaintext` is required for an unencrypted file and warns on every read. CI: `DASH_FORGE_KEY=dfk1:<network>:<identityId>:<keyId>:<wif>`, one pasteable value. `dg auth new` prints the deposit QR in the terminal with the address beneath it.

### 2.5 Backup and recovery, honestly
- Forge-created identities: **the 12 words are the identity.** Lose them and the master key and nobody can recover it. Verbatim on the backup card and in `dg auth new`.
- Limited keys are disposable: losing a browser or laptop costs nothing; register a new one from the mnemonic or file and disable the old (`dg auth keys disable`, or Settings → Keys; needs the master key).
- Wallet-created identities: recovery is the wallet's; Forge holds only a limited key.
- Shown once: *"Keep the 12 words offline. Do everything else with limited keys."*

### 2.6 DPNS usernames
Offered right after the identity exists (web: "Pick a username (optional, ~0.02 DASH)"; CLI: `dg auth name register`), with live availability and a one-sentence explanation of contested names. Names render as `alice` everywhere, falling back to `5Dtb9k4w…` with copy-on-click; URLs accept both; cached 24 h, re-verified by proof.

---

## 3. Storage onboarding

### 3.1 Web wizard (`/settings/storage`, and step 3 of `/mirror`)
1. **Provider tiles**: Cloudflare R2 (*"recommended: free egress"*), Backblaze B2, AWS S3, MinIO / other S3, IPFS (kubo), IPFS pinning service, **Dash Platform** last (*"permanent, ~0.28 DASH per MiB"*).
2. **Per-provider form** with the guide's fields, each with a "where to find this" hint linking to the console page. Secrets carry a lock icon and *"Stored encrypted in this browser only. Never sent to Forge (there is no Forge server) and never written on-chain."*
3. **Test** runs live rows: `signed PUT` → `signed GET` → `anonymous GET via public URL` → `CORS preflight (GET, Range)` → `CORS preflight (PUT) for browser pushes` → `delete probe`. A red CORS row expands into a **copy-paste fix** (R2/S3 JSON, `b2 bucket update`, `mc`, or `ipfs config` lines) prefilled with the bucket and app origin, and a **Re-test** button. The web template allows `PUT` and `x-amz-*` from `https://forge.dashhq.org` (plus the user's own IPFS origin if given) so browser pushes and merges work.
4. **Replication** radio: *"one place"* (default) / *"N places, push fails unless all confirm"* / *"Platform as fallback if my storage fails (costed, asks first)"*.
5. **Cost comparison card**, always visible:

| Where | One-time (Platform fees) | Monthly | For a 50 MiB repo, 10 pushes/month |
|---|---|---|---|
| Your R2 bucket | manifest + refs ≈ 0.0003 DASH / push | ≈ $0.001 | ≈ 0.003 DASH ≈ $0.10 + $0.00 |
| Your B2 / S3 bucket | same | ≈ $0.0003 / $0.001 | ≈ 0.003 DASH + < $0.01 |
| Dash Platform | 0.28 DASH / MiB, permanent | 0 | ≈ 14 DASH ≈ $480 for the first upload, then 0.28 DASH per pushed MiB |

Fiat appears only when a price source is enabled (web default on, source and age in a tooltip; Settings can turn it off).

### 3.2 CLI: `dg storage add` interactive
With no flags, a prompt flow whose answers map 1:1 to the existing flags, so the printed equivalent can be re-run non-interactively.
```
$ dg storage add
? Profile name › r2-main
? Kind › S3-compatible (R2, B2, S3, MinIO) / IPFS kubo / IPFS pinning service
? Provider preset › Cloudflare R2   (fills region=auto, path-style, endpoint template)
? Account id › 7c1…
? Bucket › forge
? Public URL (r2.dev or custom domain) › https://pub-9a1.r2.dev
? Access key id › ****
? Secret access key — how do you want to store it? › macOS Keychain (recommended) / env var / paste for keychain
Testing r2-main …
  signed PUT      ok   112 ms
  signed GET      ok   verified sha256
  public GET      ok   https://pub-9a1.r2.dev
  CORS Range      FAIL missing Access-Control-Allow-Headers: Range
  → paste this into R2 → Settings → CORS policy, then run `dg storage test r2-main`:
    [ { "AllowedOrigins": ["*"], "AllowedMethods": ["GET","HEAD"], "AllowedHeaders": ["Range"], ... } ]
Saved ~/.config/dash-forge/storage.toml (secret stored as keychain:dash-forge/r2-main)
Equivalent: dg storage add r2-main --kind s3 --endpoint … --secret-access-key keychain:dash-forge/r2-main
Use it in a repo: dg storage use r2-main
```
The CLI proceeds past a CORS failure (CLI reads work without CORS) but says the web app will not.

---

## 4. Cost UX

Rules (all surfaces):
1. **Cost before the click.** Every signing button shows `~0.0004 DASH ≈ $0.01` inline (`CostPreview`), split into *stored* and *fee* on hover. Free actions show nothing.
2. **Cost after the click.** Toasts show actuals: `Issue #43 created · 0.00038 DASH`. A > 25 % miss against the estimate is flagged in Settings → Spend, which is how estimate drift gets noticed.
3. **Running spend.** A local ledger (IndexedDB; CLI `~/.local/state/dash-forge/spend.jsonl`) records estimate, actual, repo and kind per broadcast. Settings → Spend and `dg cost audit [repo]` show month / all-time by repo with a reconciliation line: *"Ledger 0.0142 DASH · balance change 0.0146 DASH · 0.0004 unexplained (other apps or keys)."*
4. **Push cost guard** (helper): plan line on every push; asks on `/dev/tty` above `dash.costWarnThreshold` (default **0.01 DASH**); `dash.confirm = auto|always|never`; without a tty the push fails with the fix (§7.3 example 3).
5. **Two budgets, separately.** Identity *balance* and *this key's budget*. The preview says which one blocks: *"Costs 0.0004 DASH · key budget left 0.0002 — renew key"*.

Low-balance states:
| State | Trigger | UI |
|---|---|---|
| Comfortable | balance ≥ 0.01 DASH and key ≥ 20 % | normal pill |
| Low | balance < 0.01 DASH **or** key < 20 % / < 7 days | amber pill; one dismissible banner per session with the specific fix (top up / renew key) |
| Empty | balance = 0 **or** key spent/expired | red pill; every write button is disabled with tooltip *"Balance is 0 — reading still works."*; a **Top up** sheet shows the identity's asset-lock top-up QR (any wallet) and *"or ask anyone to transfer credits to `<identityId>`"*; dev builds add the faucet |
| Insufficient for this write | estimate > balance or > key remaining | button enabled, click opens the same Top up sheet with the shortfall |

At 0: reads, clones and browsing are unaffected (free); drafts stay local; nothing is lost and nothing expires except limited keys.

---

## 5. Repository UX

### 5.1 Parity with GitHub at launch
**In (P0):** repo home + README, tree/blob with highlighting, commits + commit diff, branches/tags, clone box, empty state, issues (create/comment/close/reopen/labels/assignees), PRs (open from a branch or fork, diff, inline comments, approve/request changes, browser merge for FF/clean merges), forks, releases (list/view, hashed assets from the owner's storage), stars, follows, DPNS profiles, local notifications inbox, in-repo search (filenames always; content ≤ 100 MB), Explore (recent, my issues/PRs/stars), settings (members, storage, protected branches, default branch, archive), private repos.
**In (P1):** single-file web edit → commit → push, blame, history beyond 1,000 commits, web release creation, check-run display, "Suggest a change", milestones.
**Out for launch, and said so in the UI:** Actions/CI, wiki (use `docs/`), Discussions, Projects, code owners, consensus-enforced required reviews (client "policy" only), repo transfer (fork-and-archive), global search/trending (needs an indexer nobody runs), email, https `git clone` (no server; §5.4), shallow clones.

### 5.2 Information architecture and URLs
- Canonical routes stay query-param (`/repo?owner=alice&name=project&ref=main&path=src`) so one static build works on Pages and IPFS. A `404.html` shim rewrites **short URLs** `/alice/project[/tree/main/src | /issues/42 | /pull/7 | /releases/v1.2]`; the app renders and copies short URLs everywhere.
- Repo tabs: **Code · Issues (n) · Pull requests (n) · Releases · Settings** (Settings for maintainers; writers see Members read-only). Commits live under Code via the ref bar — five tabs.
- Header: wordmark · network badge (non-mainnet) · jump box (`owner/name`, `@name`, `#issue`) · New ▾ (Repository, Mirror) · identity pill.
- Owner page `/alice`: profile, repos, stars, follower counts (countable indexes), cross-repo activity (`$ownerId` indexes).

### 5.3 Repo home
Left: ref bar (branch switcher, `n commits`, `Go to file`), file list (36 px rows: name · last commit subject · time; the commit column loads lazily and never blocks the list), README. Rail (296 px): **Verification** (§6), **Clone**, **About** (description, default branch, branches, tags, stars, storage badge `⛓ platform` / `🌐 r2.dev + ipfs`), **Members**, **Latest release**.

### 5.4 Clone box
```
Clone                                  🌐 r2.dev · ⛓ manifests
┌ dash://alice/project              ⧉ ┐
└──────────────────────────────────────┘
git clone dash://alice/project        (needs git-remote-dash — install)
dg repo clone alice/project
Download .zip of main (12 MiB)        · Open in browser terminal (fallback clone)
```
No https clone URL, deliberately: it would need a git server Forge does not run. The zip is built in a worker for refs ≤ 100 MB (else *"too large for a browser zip; clone instead"*). "Install" opens a sheet with the paths in §7.6.

### 5.5 Empty repository state
Shown when the repo has no refs:
```
alice/project is empty.

Push an existing repository
  git remote add origin dash://alice/project
  git push -u origin main

Or start from scratch
  dg repo clone alice/project && cd project

Storage: packs go to r2-main (set by the owner) · Platform: manifest + refs only, ~0.0003 DASH per push
No git-remote-dash yet? Install →
```
With no storage configured the box adds, in amber: *"No storage configured: pushes will be stored on Platform at ~0.28 DASH/MiB. Configure storage →"*.

### 5.6 Code browsing and README
README through the sanitized GFM pipeline (tables, task lists, footnotes; relative links and images via the browse plane; mermaid P2). Blob view: lazy Shiki, `#L10-L20` anchors, raw/copy/download, size and 7-char OID with the per-object hash state (§6). > 2 MiB: *"Large file — view raw"*; binaries get a download row and image preview.

### 5.7 Pull requests
- Tabs: Conversation · Commits · Files changed (n). Side-by-side ≥ 1024 px, unified below; whitespace toggle; color-blind palette from Settings.
- **Inline comments**: `comment` docs with optional `path`, `line`, `side` (0 old / 1 new), `commitOid`. Needs a **contract update adding optional properties to `comment`** (allowed by PV14 update rules); until then anchors travel in a `<!-- forge-anchor -->` block at the top of `body` and readers accept both. Outdated anchors collapse under *"n comments on an older version"*.
- **Verdict**: one `review` per submit (`approve | request changes | comment`, `commitOid` = head). The header shows the v2 fold exactly: *"Approved by 2 maintainers on 8f3e2a1"*, *"Changes requested by bob"*, stale approvals grayed *"stale — new commits since"*, self-approval labelled *"author approval (counted)"*.
- **Merge**: shown **only** to `writer`/`maintainer` holders, and the button says what it does: `Merge (fast-forward)`; `Create merge commit and merge` (clean 3-way in the worker via isomorphic-git, authored with the merger's Settings name/email); disabled `Can't merge in the browser — conflicts` with a `dg pr checkout 7` copy row; disabled `Protected branch — maintainers only` for writers. The click runs a visible step list: fetch base+head → merge → build pack → upload to the merger's storage profile (browser SigV4), or if none ask *"Store the merge pack (48 KiB) on Platform for ~0.013 DASH?"* → `packManifest` → `refUpdate`/`protectedRefUpdate` → `merge` event. A failure after upload names exactly which documents exist (*"Pack stored and manifest written; the ref update failed: <reason>. Retry ref update."*). No "merged" label until the fold says so. Squash/rebase: P2 (the CLI does them).

### 5.8 Issues
Filters (state/label/assignee/author) client-side over paged proof-verified reads; tab counts from the countable index. Issue page: title, body, labels, assignees, timeline folded from `event` + `authorEvent` + comments. Author: close/reopen (`authorEvent`); members: label, assign, close/reopen. Drafts autosave locally. `#12` and `alice/other#3` link; backlinks are computed client-side within the repo.

### 5.9 Releases
Newest `release` per tag. Assets are URLs into the owner's storage with `sha256`, streamed-hashed on download; a mismatch turns the row red and blocks the save. *"Published by <maintainer>"* is always shown, because a revoked maintainer can delete their releases; a superseded release for the tag is listed as *"previous"*.

### 5.10 Notifications (local-only)
`/notifications` + header badge. Subscriptions are local: repos you own or belong to, issues/PRs you authored or commented on, starred repos (opt-in). Polls the `(repoId, $createdAt)` feeds and comment indexes every 60 s while open, keyed by last-seen `$createdAt`. Empty-state copy: *"Notifications are computed in this browser from the chain. Nothing is sent to you; nothing leaves your device."* No email, push or cross-device sync, by design.

### 5.11 Search
- Jump box: `owner/name`, `@name`, `#n` in repo context.
- In-repo: filenames from `flatIndex` (fetched on first use, size shown); content search materializes ≤ 100 MB in a worker after *"Index 38 MiB for search? Stays in this browser."*; above that: *"Content search is only available for repos under 100 MB; clone and grep."*
- Issues/PRs: MiniSearch over the fetched list.
- `/explore`: Recent repos, Recently released; signed in: My repos, My issues, My PRs, Starred. No trending: *"Trending needs an indexer. Forge doesn't run one; you can (docs)."*

---

## 6. Trust UX

### 6.1 Words
Drop "assay" from UI copy (keep it in code). The card is **Verification**. Five states: **Verified** (green: the check ran and passed), **Partly verified** (amber), **Not checked yet** (neutral), **Couldn't verify** (amber: the check couldn't run, e.g. offline), **Failed** (red: the check ran and the data was wrong). Collapsed: `Verified · refs by proof · 214 files by hash · from r2.dev`.

### 6.2 The panel, expanded
Four plain-sentence rows, each with a state:
1. **Chain data** — *"Refs, issues and members were proven against Dash mainnet."* Small type: *"Proofs are checked against quorum keys fetched from `quorums.mainnet…` and `<second endpoint>`; both agreed."* One endpoint only: Partly verified, *"only one key source answered."*
2. **Branch tip** — *"`main` = `8f3e2a1`, latest signed update by alice, 2 h ago."* Diverged pushes: amber with both candidates.
3. **File contents** — *"214 of 214 objects on this page matched their git hash."* A mismatch turns the row red and the file view shows *"This file's bytes did not match its hash; not shown."*
4. **Where the bytes came from** — *"r2.dev (owner's bucket). Also recorded: ipfs (not tried)."* or *"Dash Platform (permanent)."*
Footer, always: *"This app is served by GitHub Pages. If you don't trust that, pin the IPFS build (hash `bafy…`, recorded on-chain) or use the CLI, which needs no website."*

### 6.3 Degraded states
- **Storage unreachable** (refs fine, no pack readable): a card, not a spinner: *"Code unavailable right now. The places this repo stores its files didn't answer: `pub-9a1.r2.dev` (timed out), `ipfs` (not found on 3 gateways). Branches, issues and pull requests are unaffected."* Buttons **Try again** · **Add a gateway**; for members: *"Have a clone? `dg reseed alice/project --from-local` restores it."* Rail row 4 reads *Failed* with the same list.
- **Partial data**: show what arrived plus a sticky footer *"Showing 340 of 512 — Platform answered slowly. Loading the rest…"*; totals come from countable indexes so they stay honest.
- **Network not deployed** (mainnet before PV14): read-only chrome and one card: *"Dash Forge isn't on mainnet yet (waiting for Platform v14). Browse testnet → · Follow progress →"*. No "New repo" button exists in that state.
- **Private repo, non-member**: name, owner, size, last activity, member count, and *"Private: contents are encrypted for members. You're not one."* No decrypted string ever renders, titles included.

---

## 7. CLI and developer experience

### 7.1 Command tree (gh parity map)
| `gh` | `dg` | Notes |
|---|---|---|
| `auth login/status/logout/token` | `auth new/login/status/logout/balance/keys/name/export` | §2.4 |
| `repo create/clone/fork/view/list/delete/edit/archive` | `repo create [--push] [--private] [--storage p1,p2] / clone / fork / view / list / archive / edit` | `delete` removed: v2 repos cannot be deleted; `archive` sets config. `dg init` = `repo create --push` for the cwd |
| `issue list/view/create/comment/close/reopen/edit` | same, plus `label`, `assign` | |
| `pr create/list/view/checkout/diff/review/merge/ready/close` | same; `pr create` infers `--head` from the current branch and the fork's `sourceRepoId` | `merge` does the git merge locally, pushes, then posts the event; `--event-only` keeps today's behavior |
| `release create/list/view/download/delete` | `release create --tag v1 --asset ./dist/x.tar.gz` uploads assets to the repo's storage profile with sha256 | |
| `gh api` | `dg api query <type> --where …` | proof-verified raw reads for scripts |
| — | `collab add/remove/list` (`--role writer|maintainer`) | `suspend/unsuspend` removed: v2 has no freeze; document it as remove + re-add |
| — | `storage add/test/list/remove/use/advertise/status` | §3.2 |
| — | `cost estimate/audit`, `repack`, `reseed`, `import`, `doctor`, `completion`, `config get/set` | |
| `gh --json` | `--json` on everything; `--jq` passthrough via `jaq` | |

Prompts appear only when stdin is a tty and neither `--yes` nor `--json` is set; every prompt prints its flag equivalent afterwards. `--json` shapes are stable per command (`dg <cmd> --json --schema`).

### 7.2 `dg repo create` / `dg init`
`dg repo create [name] [--push] [--private] [--storage <profiles>] [--replicas n] [--description s] [--default-branch main] [--from-github <url>]`. `name` defaults to the normalized cwd basename; `--push` adds `origin` and pushes the current branch with `-u`; storage defaults to global `dash.storage` and asks if unset (§1c); `--from-github` hands off to the importer.

### 7.3 Error message style guide
Format (stderr, human mode):
```
error: <one line, what did not happen>            [code E<nnn>]
  cause: <the underlying reason, once, no stack>
  fix:   <one concrete command or action>
  more:  https://forge.dashhq.org/docs/errors#E<nnn>   (only when a page exists)
```
Rules: the first line names the user's goal ("push rejected"), not the internal step; never print secrets or a base58 id when a name resolves; one imperative `fix:` line; exit codes 1 generic, 2 usage, 3 auth/key, 4 funds/budget, 5 storage, 6 consensus rejection, 7 network, 8 policy (cost guard). `--json`: `{ "error": { "code": "E504", "message", "cause", "fix" } }`.

Six concrete examples:
1. ```
   error: push rejected: you are not a writer of alice/project            [E601]
     cause: Platform refused refUpdate at consensus (40120: no writer/maintainer document for your identity)
     fix:   ask alice to run `dg collab add alice/project bob --role writer`, or push to your fork: `git push dash://bob/project`
   ```
2. ```
   error: issue not created: not enough credits                            [E401]
     cause: estimate 0.00042 DASH, balance 0.00011 DASH
     fix:   top up from any Dash wallet: `dg auth balance --topup` shows the QR
   ```
3. ```
   error: push stopped by the cost guard                                   [E801]
     cause: this push would store 3.4 MiB on Platform (~0.95 DASH ≈ $32); no terminal to confirm on
     fix:   add storage (`dg storage add`) so packs go to your bucket, or run `git -c dash.confirm=never push` to accept the price
   ```
4. ```
   error: push failed: storage policy not met (1 of 2 targets confirmed)   [E502]
     cause: r2-main: PUT 403 access denied (check the key, and that region is `auto` for R2); kubo: ok
     fix:   `dg storage test r2-main`, then push again — kubo's copy is kept and not re-uploaded
     note:  nothing was written to Platform
   ```
5. ```
   error: this browser key can't sign that                                 [E302]
     cause: key #7 is bound to the dash-forge contracts; registering a DPNS name needs the master key
     fix:   `dg auth name register alice --identity ~/alice.identity.json` (used once, not stored)
   ```
6. ```
   error: clone incomplete: 2 packs unreadable                             [E503]
     cause: pack 9c4e… recorded at pub-9a1.r2.dev (404) and ipfs://bafy… (3 gateways: not found); no Platform copy
     fix:   ask a member to run `dg reseed alice/project --from-local`; you can retry with `--gateway https://…` if you know another mirror
   ```

### 7.4 Push progress output
Helper stderr at default verbosity, one line per target, sizes and costs always present, summary with actuals:
```
dash: alice/project ← main (8f3e2a1, 312 objects, 1.2 MiB)
dash: r2-main      ████████████████ 1.2 MiB  verified   0.4 s
dash: platform     manifest 1 · refUpdate 1     est 0.00031 DASH
dash: done · Platform charged 0.00029 DASH ≈ $0.01 · balance 0.4809 DASH · https://forge.dashhq.org/alice/project
```
`--dry-run` prints the first three lines and stops. In `--json` mode (`GIT_DASH_JSON=1`) each line is a JSON event.

### 7.5 `dg doctor`
Rows `[ ok ]/[warn]/[FAIL] name  detail → fix`, grouped: **binaries** (git, git-remote-dash on PATH, versions match), **network** (target, both quorum endpoints agree, DAPI reachable, protocol ≥ 14 where required), **contracts** (ids from `deployments/<network>.json`, group verified on chain), **identity** (keychain entry, balance, key kind, budget left, expiry, encryption key), **storage** (per profile: last test, secret resolvable), **repo** (remote resolves, `dash.storage` profiles exist, cost guard), **web** (CORS from the browser's point of view). `--fix` applies safe fixes (completions, missing git config).

### 7.6 Install, completions, config
- `curl -fsSL https://forge.dashhq.org/install.sh | sh`: a static file on Pages that fetches the GitHub Release tarball, verifies `SHA256SUMS` and its minisign signature (key embedded and printed in the docs), installs `dg` + `git-remote-dash` into `~/.local/bin`, prints the PATH line if needed. Also `cargo binstall dg-cli`; Homebrew tap and scoop after launch; Windows zip on the Release page.
- `dg completion bash|zsh|fish|powershell`; `install.sh` offers to install them.
- Files: `~/.config/dash-forge/config.toml` (network, default identity, price source, fiat), `storage.toml` (profiles, secret references only), `~/.local/state/dash-forge/` (spend ledger, journals), `~/.cache/dash-forge/` (contracts, DPNS, quorum keys). `$XDG_*` respected; `%APPDATA%\dash-forge` on Windows.
- Git config: `dash.identity`, `dash.network`, `dash.storage`, `dash.replicas`, `dash.platformFallback`, `dash.costWarnThreshold`, `dash.confirm`, `dash.gateways`, `remote.<name>.dash*` overrides. `dg config set` writes them; `dg config get --explain` shows the source file of each value.
- **jj** works unmodified (≥ 0.43, no colocation). `docs/guides/jj.md` covers `jj git remote add origin dash://alice/project`, bookmarks pushing as branches, the helper prompting on `/dev/tty`, and `dg pr checkout` creating a bookmark in a jj workspace.

---

## 8. The GitHub Mirror Action

`uses: dashpay/forge-mirror-action@v1` (composite action downloading the pinned `dg` release by checksum; no Forge service involved).

**Inputs**: `repo` (required, `dash://alice/project` or `alice/project`), `network` (`mainnet` default), `sync` (default `code,releases`; also `issues,prs`), `storage-kind` (`s3` | `ipfs-pinning` | `platform`), `s3-endpoint`, `s3-region`, `s3-bucket`, `s3-public-url`, `s3-prefix`, `replicas` (default 1), `cost-cap` (DASH per run, default `0.05`; the run fails before spending beyond it), `dry-run`.
**Secrets** (via `env`): `DASH_FORGE_KEY` (the `dfk1:` limited runner key), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (or `PINNING_TOKEN`), and `GITHUB_TOKEN` (read-only, for issues/PRs/releases).

```yaml
name: Forge mirror
on:
  push: { branches: ['**'], tags: ['**'] }
  issues: { types: [opened, edited, closed, reopened, labeled, unlabeled] }
  pull_request_target: { types: [opened, edited, closed, reopened, synchronize] }
  release: { types: [published, edited] }
  schedule: [{ cron: '17 3 * * *' }]     # daily reconcile
  workflow_dispatch:
concurrency: { group: forge-mirror, cancel-in-progress: false }
jobs:
  mirror:
    runs-on: ubuntu-latest
    permissions: { contents: read, issues: read, pull-requests: read }
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: dashpay/forge-mirror-action@v1
        with:
          repo: dash://alice/project
          sync: code,releases,issues,prs
          storage-kind: s3
          s3-endpoint: https://<account>.r2.cloudflarestorage.com
          s3-region: auto
          s3-bucket: forge
          s3-public-url: https://pub-9a1.r2.dev
          cost-cap: '0.05'
        env:
          DASH_FORGE_KEY: ${{ secrets.DASH_FORGE_KEY }}
          S3_ACCESS_KEY_ID: ${{ secrets.S3_ACCESS_KEY_ID }}
          S3_SECRET_ACCESS_KEY: ${{ secrets.S3_SECRET_ACCESS_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**What it syncs**: all branches and tags (force-pushes mirrored as such, recorded in the on-chain reflog); releases (notes + assets re-uploaded to the bucket, sha256 recorded); issues, PRs and comments authored by the runner identity with the header *"Mirrored from github.com/alice/project#123 by @bob"*; state changes as events. PRs become `patch` docs whose head lives at `refs/mirror/pull/<n>/head` in the mirror itself (`sourceRepoId` = the mirror), so they are checkoutable.

**Idempotency**: packs are content-addressed; refs are written only when the tip differs; the GitHub number is kept in an `<!-- forge-mirror: gh#123 -->` body marker and cached in `actions/cache`, re-derived from the `(repoId, number)` index on a miss; replaces only when the rendered body differs. Re-running any event costs 0.

**Output**: a job summary — *ref updates n · packs n (MiB) · issues · PRs · releases · Platform charged x DASH (≈ $y) · runner key budget left z DASH, expires <date>* — with a warning annotation when the key budget < 20 % or expiry < 30 days: *"Renew at forge.dashhq.org/alice/project/settings/mirror."* `dry-run: true` prints the same table as an estimate.

---

## 9. Private repositories

- **Create**: visibility is set at creation only (immutable). The confirmation states four facts: contents encrypted; metadata visible (existence, name, owner, sizes, timing, member count); members keep what they could read; no recovery if every member loses their keys.
- **Add member** (Settings → Members): DPNS name or id, role writer/maintainer. The app looks up the identity's ENCRYPTION key; if none: *"bob has no encryption key yet. Send them this: `dg auth keys add --encryption`, or Settings → Keys → Enable private repos (one master-key signature)."* Add stays disabled until it exists. On add: membership doc + `repoKey` wrap for the current epoch, `~0.0006 DASH`.
- **Remove member**, verbatim: *"Removing bob rotates the repo key. New pushes, issues and comments will be unreadable to bob. Everything bob could already read stays readable to bob — encryption can't take back what was shared."* On confirm: delete membership → epoch n+1 wraps for remaining members (cost = members × wrap, shown) → the next push encrypts under n+1. Members list shows *"key epoch 3 · rotated 2 d ago by alice"*.
- **Reading**: lock chip *"Private · decrypted with your key (epoch 3)"*. Undecryptable or malformed (plaintext) docs are hidden; maintainers see *"n documents ignored (not encrypted for this repo)"* with a note that anyone can post plaintext into the namespace.
- **Outsiders** see §6.3's private state; issue/PR buttons are hidden for non-members.
- **CLI** is transparent: `git clone dash://alice/secret` decrypts with the keychain identity's encryption key; without one: `error: private repo: your identity has no encryption key [E303] · fix: dg auth keys add --encryption`.

---

## 10. Accessibility, performance, mobile

- **A11y**: WCAG 2.1 AA, axe 0 serious; every state color paired with an icon and a word; `forge-400` focus ring; Radix dialogs with focus trap and Escape; blue/orange diff palette; `prefers-reduced-motion` disables motion; QR codes carry the address as text; CLI honors `NO_COLOR` and never relies on color alone.
- **Performance budgets** (CI: Lighthouse + request interception): bundle < 1.5 MiB gz before WASM; WASM after first paint; cold repo home < 3 s and < 500 KB at any size (`flatIndex` never on home); warm reload < 1.5 s; **100 MB repo: README < 3 s, first blob < 2 s, deep tree < 4 s** (flatIndex ≈ 470 KB at 10k files, cached in IndexedDB); issues first page < 2 s; PR diff ≤ 50 files < 3 s; 100 MB search index ≤ 60 s in a worker with progress. Zero requests to origins other than DAPI, the repo's storage, and user-configured, off-able helpers (price source, block explorer).
- **Mobile** (≥ 360 px): read everything, write the small things. Tabs scroll; the rail collapses under content with Verification first; the commit column hides; diffs unified; issue/comment composer works; merge and storage wizards say *"Use a desktop browser for this step"*. Clone box shows only the `dash://` URL and zip. Wallet sign-in (QR → deep link) is primary.

---

## 11. Implementation backlog

Areas: `core` = `crates/forge-core`, `helper` = `crates/git-remote-dash`, `dg` = `crates/dg`, `web` = `forge-web`, `contracts` = `forge-contracts`, `action` = new `forge-mirror-action` repo, `import` = `crates/forge-import`, `docs`.

### P0 — launch-blocking
1. Limited-key login: vault (passkey PRF / Argon2id), import-file ceremony, app-connect with on-chain grant verification, budget/expiry pill, renew flow — `web`
2. In-browser identity creation (QR asset lock, forced mnemonic backup, configurable explorer) — `web`
3. `dg auth new/login/status/keys/name/export` on keychain with encrypted fallback; `dfk1:` env format — `dg`, `core`
4. `dg storage add` interactive + CORS fix blocks; web storage wizard with browser-side tests and PUT CORS template; credential vault — `dg`, `web`, `core`
5. `git push` honors `dash.storage`; plan/progress/summary lines; cost guard tty prompt and non-tty failure — `helper`, `core`
6. `dg repo create --push` / `dg init`, storage-missing stop, URL on success — `dg`
7. `forge-core::error::UserError { code, message, cause, fix }` + exit-code table + `--json` shape; the six examples as tests — `core`, `dg`, `helper`
8. v2 cost previews on every web write, post-write actuals, local spend ledger, `dg cost audit` — `web`, `core`, `dg`
9. Low/empty balance and key-budget states, top-up sheet with QR, writes disabled at 0 — `web`
10. Verification card rewrite: plain-language states, two quorum endpoints cross-checked, degraded/partial/not-deployed/private states — `web` (`lib/view/trust.ts`, `components/ui/trust-panel.tsx`)
11. Repo home, empty state, clone box (§5.3–5.5); short-URL 404 shim; five-tab IA — `web`
12. PR: open from branch/fork, side-by-side diff, inline comments (anchor block now, contract update queued), verdicts, honest fold display — `web`, `contracts`
13. Browser merge (FF + clean 3-way) to the user's storage or costed Platform, with stepwise partial-failure reporting — `web`
14. Forks as v2 docs (`dg repo fork`, web Fork) — `core`, `dg`, `web`
15. Private repos: create, members panel with encryption-key check, add/remove with rotation, CLI decrypt paths — `core`, `dg`, `web` (gated on the Phase 3 security review)
16. Mirror Action v1 (code + releases, then issues/PRs), cost cap, summary, `/mirror` wizard — `action`, `web`, `import`
17. Release pipeline: signed checksums, `install.sh`, `cargo binstall`, completions — CI, `docs`
18. Local notifications inbox; Explore with cross-repo "my" queries — `web`
19. `dg doctor` sections incl. web-CORS and `--fix` — `dg`
20. Docs: quick start, mirror guide, key backup/recovery, "how to check Forge isn't lying", error-code pages — `docs`

### P1
- Single-file web edit → commit → push; "Suggest a change" PRs — `web`
- `comment` anchor properties via contract update; retire the body-block fallback after a deprecation window — `contracts`, `web`, `dg`
- Blame; history beyond 1,000 commits; content-search worker — `web`
- Web release creation with asset upload; `dg release create --asset` — `web`, `dg`
- Check-run rendering; `dg api query` — `web`, `dg`
- jj guide + CI smoke; `dg pr checkout` bookmarks — `docs`, `dg`
- Client-side zip of a ref ≤ 100 MB — `web`
- Milestones, label/assignee UI polish, saved filters — `web`
- Fiat toggle + price-source picker — `web`, `dg`
- `IdentityKeyLimitsUpdate` top-up when a master key is present — `web`, `dg`

### P2
- Squash/rebase browser merges; required-review "policy" display — `web`
- Mermaid; image diffs — `web`
- Homebrew tap, scoop, relay Docker image — CI
- Organizations (jointly held owner identity guide) — `docs`, `contracts`
- Optional user-run indexer for global search/trending — new component
- Opt-in cross-device notification state via an encrypted `profile` blob — `web`, `contracts`
