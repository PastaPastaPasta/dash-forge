# Changelog

All notable changes to Dash Forge are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
What a version number promises before 1.0 is described in [docs/VERSIONING.md](docs/VERSIONING.md).

## [Unreleased]

### Added

- **`dg board`.** List, view (`--view`, `--json` with the fold), create (the web's templates or `--columns`), move (`--top`, `--before`, `--after`), set fields, add (or open a new issue with `--title`), archive, remove, move to the next iteration, close and delete boards from the command line, private repositories' sealed boards and cards included ([Boards guide](docs/guides/boards.md)). forge-core reads and writes boards and cards as the web does, and runs the `sealed_board` vectors.
- **Board contract types.** forge-meta gains `board` and `card` (UPDATE-3, [boards design](docs/design/boards.md) §3), written only by the home repository's members; testnet got them on 2026-10-27 by an in-place update of forge-meta to version 3 ([evidence](forge-contracts/evidence/testnet/README.md#forge-meta-update-to-version-3-boards-2026-10-27)).

### Fixed

- **InstantSend proofs on testnet.** Creating or topping up an identity, in the web app or with `dg auth new`, waited on `getislocks` at `trpc.digitalcash.dev`, which no longer follows testnet, so every lock fell back to a slower chain-lock proof. The InstantSend lock now comes off DAPI `subscribeToTransactionsWithProofs` feeds on three evonodes, opened before the asset lock is broadcast, as in govhub and mainnet-bridge. `--islock-rpc` and `islock_rpc` still add an RPC of your choice, but none is set by default.

### Changed

- **The web app asks only the Dash network's evonodes** for an identity deposit: the Insight fallback and the **Fallback block explorer** setting are gone. It watches the deposit on two nodes at once, and moves a feed that fails or goes silent to another node.

## [0.2.0] - TODO(owner): the tagging date

Dash Forge moves to **testnet**: its four contracts are registered there, and testnet is now the supported network for `dg`, `git-remote-dash`, the web app and the Actions. Devnet sakura, which v0.1.0 targeted, is down, and nothing on it was carried over. See the [release notes](docs/releases/v0.2.0.md) for networks, upgrading and known limitations.

Members-only content in public repositories, Environments and the secret scan. People using older Forge builds see fewer things until they update: they leave members-only items out, and they don't count a members-only review's approval, so they may refuse a merge an up-to-date build allows. **Update to see and count members-only reviews.** [Who can read what](docs/security/audiences.md) explains the audiences, what stays public and what can still leak.

### Added

- **Forge on testnet.** The production four-contract set (forge-core, forge-collab, forge-community and forge-meta) was registered on testnet (`dash-testnet-51`, Platform 5.0.0-rc.8, protocol 14) on 2026-10-26, in contract group `EXgzBMpwC7RMjSU4WQghLAnfboswsssMGiXRtiV1hmBC`, from the same JSON that will be registered on mainnet. The record is `forge-contracts/deployments/testnet.json`, with its evidence in `forge-contracts/evidence/testnet/`. Testnet is every tool's default network, so `dg auth new` needs no flags.
- **Members-only content in public repositories.** A maintainer turns it on once with `dg repo members enable` (it shows the cost first: about 0.004 DASH for 5 members), and `dg repo members status` shows who has the key. Members can then post issues, comments and reviews only members can read: maintainers, writers, triage members and readers, including members added later. Removed members keep what they could already read. CI runners are not members. Everyone can still see that something was posted, by whom, when and how large, and a review's verdict.
- **Members-only discussion from `dg`** in public repositories with members-only content turned on: `--members` on `dg issue create`, `dg issue comment`, `dg pr comment` and `dg pr review`. Members read it in `dg issue view/list` and `dg pr view/list`; everyone else sees "#3 · members-only issue by @alice · open" and "3 members-only comments hidden". Every item in `--json` carries `"audience"` and `"readable"`. A members-only text longer than its field is stored encrypted (by maintainers and writers), and a members-only pending review is kept encrypted on disk.
- **Readers on public repositories.** `dg collab add --role reader` works on public repositories: a reader follows the members-only discussion without pushing or merging.
- **Membership changes follow the members key.** On a repository with members-only content, `dg collab add` shares the key with the new member and `dg collab remove` changes it, as on a private repository. `dg repo keys status`, `repair` and `rotate` work there too. A member added by an older build sees E311 until a maintainer's repair shares the key.
- **A members-only review's approval counts for everyone**, member or not, so everyone sees the same merge button.
- **The web app** reads members-only issues, comments and reviews for members after one unlock per tab, keeps a reply in a members-only conversation members-only, offers the reader role on public repositories, and shares or changes the key when members are added or removed.
- **Members-only content in the web app.** A maintainer turns it on with **Turn on members-only content**, which shows the cost first. Every composer has an audience chip (Public or Members). Everyone else sees members-only rows, placeholders and a "#N · members-only" page, never the text. Members can check the public's view with **View as public**. The web asks before a public post that quotes members-only text, and keeps no members-only draft on disk. A removed member still reads what was written while they were a member.
- **Settings → Environments** in the web app shows a repository's environments to the people who can read them, with values hidden until you show one; others see only how many there are. Changes are made with `dg env`.
- **Environments** (`dg env`): configuration and secrets kept outside git, encrypted for a repository's **Maintainers** (the default for `production`, `prod*`, `staging` and `release*`) or its **Members**, changed by maintainers only, injected with `dg env run` or written to a git-ignored file with `dg env export -o .env`. Two changes at once fail closed (E608) until a maintainer keeps one. `dg collab remove` lists the values the removed member could read. See [Environments](docs/guides/environments.md).
- **Secrets in a public push.** `git push` to a public repository checks every file it publishes for the first time. It refuses a new `.env` file, a PEM private key, an AWS key pair or a GitHub or GitLab token with a valid checksum (E807), and warns about `.envrc` files, random-looking values and keys in test folders. `-o allow-secret=<fingerprint>` or `.forge/secret-scan-allow` lets a checked finding through. See [Secrets in a push](docs/guides/quick-start.md#secrets-in-a-push).
- **Wallet sign-in keeps your encryption key.** The web app stores the encryption key the Dash Wallet registers in the browser's vault, every one of them across approvals, so private repositories and members-only content open after one unlock per tab. When the identity's key came from somewhere else, it says "Your encryption key is held elsewhere. Import it under Settings → Private repos."
- **Wallet sign-in with App Connect v2: one approval for all of Forge.** Where the network runs protocol 14 and Forge is deployed (devnet sakura today), the wallet tile comes first and shows an App Connect v2 request: the wallet adds one key for this browser that works on every Forge contract, capped at 0.05 DASH of spending and expiring after 90 days (a wallet may offer other limits), so the extra approvals of the older exchange are not asked for. The phone link returns to a new `/connect/` page, and the sign-in checks the wallet again when the tab regains focus. A key a wallet granted is renewed in that wallet (**Renew in your wallet**, in the low-funds banner, the top-up sheet and Settings → This browser's key); the identity file or recovery phrase still works. If your wallet's build has no App Connect v2, **Show the older code** gives today's request. A v2 sign-in does not bring an encryption key: set up private and members-only content in Settings. We know of no released Dash Wallet that speaks App Connect v2 yet; the [wallet sign-in notes](docs/design/wallet-login.md#app-connect-v2-one-approval-for-all-of-forge) say what works today.
- **Passkeys for other devices (web app).** **Settings → Devices & keys → Passkeys for other devices** adds a passkey that holds this browser's key, encrypted to it, on Platform. On another device, **Sign in with a passkey** brings that sign-in over: the same key and budget, checked against your identity before it is used. A passkey moves a session, it doesn't recover an account: when the key expires or is disabled it stops working, and you renew with your identity file, recovery phrase or wallet (a session restored from a passkey offers both **Renew in your wallet** and **Renew with identity file**). Keys without a spending limit or an expiry stay on the device that holds them, because the encrypted copy is public on Platform for good. Your encryption key is included only if you tick it, with a warning that it can't be taken back. After signing in, the web app offers a passkey once (twice at most, never after **Not now**). Revoking or disabling a key offers to remove the passkeys that hold it. Adding one costs about 0.0005 DASH from the key's budget; signing in is free. It works at forge.dashhq.org only. The controls show only where forge-meta has the new `vaultEntry` type: on testnet since its forge-meta update to version 2 (2026-10-26). See [Passkeys: the threat model](docs/security/passkey-vault.md) and [identity and keys](docs/guides/identity-and-keys.md#passkeys-for-other-devices).

### Changed

- **Testnet is the supported network.** forge.dashhq.org, the IPFS release build, the guides, the Mirror Action, the check action and the GitLab CI template default to testnet, and their faucet links go to the Dash testnet faucet and faucet.thepasta.org. The Mirror Action's and the check action's `devnet-name` input now defaults to empty. A workflow that set `network: devnet` and `devnet-name: sakura` must drop both. [Dash Forge moved to testnet](docs/guides/devnet-move.md) says how to re-push from a clone.
- `dg repo view` counts git packs only: `packCount` and `packBytes` (and the `packs:` line) no longer include browse indexes, history indexes, release-asset lists or long bodies. `dg storage status` still lists every artifact.
- Notifications and `forge-relay` webhooks never carry members-only text: they say that something happened, by whom and where. An encrypted comment or review from someone who is not a member is not shown and notifies nobody.

### Fixed

- **`git push` asks before the whole push, not one pack at a time.** The cost guard weighs every pack (public and members-only), every index and every ref update together, once, before anything is paid. A push of tags or branches at commits already stored (`git push --tags`), and a push that only deletes, used to write its ref updates without a question: 300 tags is about 0.28 DASH.
- **`dg pr merge --yes` approves the price it shows, and no more.** The merge is built before the question and priced by a dry run of its push. The push is then capped at that price: a dearer push is refused (E801) before anything is paid. `dg pr revert --yes` and `--delete-branch` work the same way.
- **`dg pr merge --override-policy` fails (E106) when the merge landed but its policy-bypass record did not**, instead of printing "merged" and exiting 0. `--record-bypass` records the missing bypass.
- **`dg import` and `forge-import` without `--max-spend` stop at the estimate you confirmed** instead of running uncapped.
- **The Mirror Action's recommended workflow no longer runs on issue, comment and pull request events**, which anyone can trigger. Mirroring them is an opt-in that the README explains, with its risk. An identity file as `DASH_FORGE_KEY` (no key budget) is refused unless `allow-unlimited-key: 'true'`.
- **forge-runner retries a check's final report** with backoff. If the report still doesn't land, the runner keeps it and resends it on the next polls (up to 48), instead of marking the run done with the check left running. The jobs are not run again.
- **The web app prices an edit of a long issue, PR or comment with its long-body storage**, so the confirmation and its balance check show what the edit costs.
- **A push that merges every live head of a diverged branch settles it.** Before, a merge of both heads paid for its write, left the other head live and reported "lost concurrent race" on every later push until `--force`. If one of the settling updates fails, the push now says which head is still live instead of reporting nothing written.
- **A flood of reviews can no longer block a merge.** Approvals are counted from members' verdicts on the PR's head, read on their own index, instead of from the whole review list, which anyone could pad past the complete-read cap.
- **The web app runs only its own inline scripts in production.** Each exported page carries a second content policy that lists the SHA-256 of its inline scripts, so a script a host injects into the HTML (a CDN's analytics beacon, say) does not run beside the key vault.
- **A browser merge or Update branch checks the base before paying for the pack**, and stops with "nothing was written" when the branch moved or diverged, instead of uploading a pack nothing could use.
- **A partial clone's lazy blob fetch reads only the packs that hold the blobs** it needs, instead of downloading the whole repository again for each checkout, `git log -p` or blame.
- **Issue and PR lists say when the repository's label definitions were not read completely**, instead of presenting the first page as all of them.
- **A removed member's sealed author events on their own issues and PRs follow the late-content rule**, so they can no longer keep writing readable values under an old key.
- **Trending loads in a fresh tab on testnet.** A new connection learns the network's protocol version before the first page query. Before, the SDK started at protocol 13 and refused Trending's time-range read with "requires protocol version 14+" until you clicked Try again.

## [0.1.0] - 2026-10-04

The first release. It targets devnet sakura (Dash Platform v5.0.0-beta.1, protocol 14) only;
testnet and mainnet are not supported yet. See the [release notes](docs/releases/v0.1.0.md)
for networks, installation, verification and known limitations.

### Added

- **Git hosting over `dash://`**
  - `git-remote-dash`, a git remote helper: `git clone dash://<owner>/<name>`, `git push`, branches, tags, force-pushes and partial clones (`--filter=blob:none`); jj works too.
  - Refs and pack manifests are signed documents on Dash Platform; every push prints its cost before it pays, and a cost guard can make it ask.
  - DPNS usernames in place of identity ids (`dash://alice/project`), resolved with proof-checked reads.
- **The `dg` command-line interface**, shaped like `gh`
  - Repositories, forks and fork sync, stars, watches, issues, pull requests, reviews, merges, releases, labels, milestones, members, webhooks, check runs and public profiles.
  - `dg init` publishes an existing git repository in one step; `dg doctor` checks the setup.
  - Search within a repository (`dg search`), raw proof-checked queries (`dg api query`), and spend estimates and audits (`dg cost`).
  - Error codes with documented fixes ([docs/errors.md](docs/errors.md)), `--json` output, and shell completions for bash, zsh, fish and PowerShell.
- **Bring-your-own storage**
  - Packs go to an S3-compatible bucket (Cloudflare R2, Backblaze B2, AWS S3, Storj, MinIO, Garage, RustFS), an IPFS node or pinning service, or Platform itself, with N-of-M replication.
  - Set up with `dg storage add` or the web app's storage wizard; readers accept only bytes that match the SHA-256 recorded on chain and fall back to the next copy.
  - `dg reseed --from-local` restores a lost copy from any clone; `dg repack` consolidates packs.
- **Identities and limited keys**
  - `dg auth new` creates an identity from 12 recovery words and a deposit; `dg auth login` imports one from an identity file or the words.
  - Day-to-day signing uses limited keys: a budget, an expiry, and usable only on Forge's contracts, enforced by Platform. CLI keys live in the OS keychain (or a passphrase-sealed file); the master key is not stored by default.
  - Key management (`dg auth keys`), DPNS username registration, and `dfk1:` runner keys for CI.
- **Collaboration**
  - Members with reader, triage, writer and maintainer roles, enforced at consensus; adding a member needs their consent first.
  - Issues with labels, milestones, assignees, locking, pinning and maintainer hiding (nothing is deleted); comments editable and deletable by their author.
  - Pull requests from a branch or a fork, with inline review comments, suggestions, pending reviews, draft state, base retargeting and code owners (`CODEOWNERS`) asked for review.
  - Real merges from `dg pr merge`: fast-forward, merge commit, squash or rebase; protected branches enforced by Platform, and a branch policy (required approvals, allowed merge methods) with a recorded maintainer bypass.
  - Releases with hash-checked assets, yanking and unpublishing; maintainers and writers can post descriptions, comments and release notes over 5 KiB, stored as repository artifacts.
  - Archived repositories, repository topics, follows, and Verified badges for commits signed with a key published on the signer's profile (`dg verify-commit`).
- **Private repositories**
  - `dg repo create --private` (or the web app): code, branch names, issues, pull requests, comments, reviews and releases are encrypted to members' encryption keys; removing a member rotates the key.
  - What stays visible (the repository's existence, name, members, sizes, timing, commit ids, label definitions, check runs) is listed in the [collaborating guide](docs/guides/collaborating.md#private-repositories).
- **The web app** at [forge.dashhq.org](https://forge.dashhq.org), a static site with no backend
  - Browse code, commits, branches, tags, blame, history and diffs; download a branch as a zip; search a repository's code in the browser.
  - File and triage issues; open, review and merge pull requests; fork and sync repositories; create and delete branches; publish releases; manage members, settings, storage, labels and milestones; issue and PR templates.
  - Explore, trending, a local notifications inbox, public profiles, and a spend ledger. Every write shows its price before you sign.
  - A Verification card on every repository page that reports what was proven, including a cross-check of the quorum keys against a second source.
  - Sign in by creating an identity in the browser, importing one, or scanning a QR code with Dash Wallet (no released wallet answers it yet; see [Known limitations](docs/releases/v0.1.0.md#known-limitations)). Keys are kept in an encrypted vault unlocked by a passkey or passphrase.
- **Mirroring**
  - `forge-import` (and `dg import`) copies a GitHub repository's code, issues, pull requests, reviews, releases and labels, under a spending cap; GitLab projects are supported as a source too.
  - The Mirror Action keeps a copy in sync from GitHub Actions, idempotently and under a per-run cost cap; the web app's `/mirror` wizard sets it up.
  - A GitLab CI template ([integrations/gitlab](integrations/gitlab/README.md)) does the same from GitLab.
- **CI**
  - Check runs on commits and pull requests, reported by `dg ci report` under a runner key that can sign nothing else, with logs and artifacts checked by hash; re-runs from the web and `dg`.
  - `forge-runner`, a self-hosted runner that runs a repository's `.forge/workflows` (GitHub Actions syntax) with nektos/act in Docker.
  - The check action reports GitHub Actions jobs as Forge check runs.
  - `forge-relay`, a relay you run yourself, turns on-chain activity into GitHub-shaped webhooks with encrypted secrets and a durable retry queue.
- **Verification**
  - Every Platform read is checked against a proof and every byte against its hash; the CLI and the web app share conformance vectors so they reach the same answer.
  - What is checked, and what is still trusted, is documented in [Check that Forge isn't lying to you](docs/guides/verify-forge.md).
- **Distribution**
  - Prebuilt binaries for Linux (x86_64 and aarch64, glibc; x86_64 static musl), macOS (Intel and Apple silicon) and Windows, with `SHA256SUMS` and GitHub build provenance attestations.
  - `install.sh`, which checks the checksum and, when the GitHub CLI is available, the attestation; `cargo binstall` support.
  - A `forge-relay` container image on GitHub Container Registry.
  - A reproducible IPFS build of the web app, published as a CAR file and CID with each release ([Verify the app you loaded](docs/guides/verify-the-app.md)).

### Known limitations

See [Known limitations](docs/releases/v0.1.0.md#known-limitations) in the release notes.

[Unreleased]: https://github.com/PastaPastaPasta/dash-forge/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/PastaPastaPasta/dash-forge/releases/tag/v0.2.0
[0.1.0]: https://github.com/PastaPastaPasta/dash-forge/releases/tag/v0.1.0
