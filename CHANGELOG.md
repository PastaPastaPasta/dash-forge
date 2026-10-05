# Changelog

All notable changes to Dash Forge are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
What a version number promises before 1.0 is described in [docs/VERSIONING.md](docs/VERSIONING.md).

## [Unreleased]

### Added

- **Members-only discussion from `dg`** in public repositories with members-only content turned on: `--members` on `dg issue create`, `dg issue comment`, `dg pr comment` and `dg pr review`. Members read it in `dg issue view/list` and `dg pr view/list`; everyone else sees "#3 · members-only issue by @alice · open" and "3 members-only comments hidden". Every item in `--json` carries `"audience"` and `"readable"`.

### Changed

- `dg repo view` counts git packs only: `packCount` and `packBytes` (and the `packs:` line) no longer include browse indexes, history indexes, release-asset lists or long bodies. `dg storage status` still lists every artifact.

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
