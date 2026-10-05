# Changelog

All notable changes to Dash Forge are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
What a version number promises before 1.0 is described in [docs/VERSIONING.md](docs/VERSIONING.md).

## [Unreleased]

Members-only content in public repositories, Environments and the secret scan. People using older Forge builds see fewer things until they update: they leave members-only items out, and they don't count a members-only review's approval, so they may refuse a merge an up-to-date build allows. **Update to see and count members-only reviews.** [Who can read what](docs/security/audiences.md) explains the audiences, what stays public and what can still leak.

### Added

- **Members-only content in public repositories.** A maintainer turns it on once with `dg repo members enable` (it shows the cost first: about 0.004 DASH for 5 members), and `dg repo members status` shows who has the key. Members can then post issues, comments and reviews only members can read: maintainers, writers, triage members and readers, including members added later. Removed members keep what they could already read. CI runners are not members. Everyone can still see that something was posted, by whom, when and how large, and a review's verdict.
- **Members-only discussion from `dg`** in public repositories with members-only content turned on: `--members` on `dg issue create`, `dg issue comment`, `dg pr comment` and `dg pr review`. Members read it in `dg issue view/list` and `dg pr view/list`; everyone else sees "#3 · members-only issue by @alice · open" and "3 members-only comments hidden". Every item in `--json` carries `"audience"` and `"readable"`. A members-only text longer than its field is stored encrypted (by maintainers and writers), and a members-only pending review is kept encrypted on disk.
- **Readers on public repositories.** `dg collab add --role reader` works on public repositories: a reader follows the members-only discussion without pushing or merging.
- **Membership changes follow the members key.** On a repository with members-only content, `dg collab add` shares the key with the new member and `dg collab remove` changes it, as on a private repository. `dg repo keys status`, `repair` and `rotate` work there too. A member added by an older build sees E311 until a maintainer's repair shares the key.
- **A members-only review's approval counts for everyone**, member or not, so everyone sees the same merge button.
- **The web app** reads members-only issues, comments and reviews for members after one unlock per tab, keeps a reply in a members-only conversation members-only, offers the reader role on public repositories, and shares or changes the key when members are added or removed. <!-- PENDING #400 (weblane) -->
- **Environments** (`dg env`): configuration and secrets kept outside git, encrypted for a repository's **Maintainers** (the default for `production`, `prod*`, `staging` and `release*`) or its **Members**, changed by maintainers only, injected with `dg env run` or written to a git-ignored file with `dg env export -o .env`. Two changes at once fail closed (E608) until a maintainer keeps one. `dg collab remove` lists the values the removed member could read. See [Environments](docs/guides/environments.md). <!-- PENDING #397 (environments lite) -->
- **Secrets in a public push.** `git push` to a public repository checks every file it publishes for the first time. It refuses a new `.env` file, a PEM private key, an AWS key pair or a GitHub or GitLab token with a valid checksum (E807), and warns about `.envrc` files, random-looking values and keys in test folders. `-o allow-secret=<fingerprint>` or `.forge/secret-scan-allow` lets a checked finding through. See [Secrets in a push](docs/guides/quick-start.md#secrets-in-a-push).
- **Wallet sign-in keeps your encryption key.** The web app stores the encryption key the Dash Wallet registers in the browser's vault, every one of them across approvals, so private repositories and members-only content open after one unlock per tab. When the identity's key came from somewhere else, it says "Your encryption key is held elsewhere. Import it under Settings → Private repos."

### Changed

- `dg repo view` counts git packs only: `packCount` and `packBytes` (and the `packs:` line) no longer include browse indexes, history indexes, release-asset lists or long bodies. `dg storage status` still lists every artifact.
- Notifications and `forge-relay` webhooks never carry members-only text: they say that something happened, by whom and where. An encrypted comment or review from someone who is not a member is not shown and notifies nobody.

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

[Unreleased]: https://github.com/PastaPastaPasta/dash-forge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/PastaPastaPasta/dash-forge/releases/tag/v0.1.0
