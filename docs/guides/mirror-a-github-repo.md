# Mirror a GitHub repository

GitHub can take down a repository: a DMCA notice, a sanctions ruling, or a policy change is enough. A Forge mirror is a copy that nobody can take down:

- **Refs and history metadata** live on Dash Platform, signed by your identity. There is no moderation at the protocol level, so nobody can delete them.
- **Pack bytes** live in storage you control (your bucket or IPFS node), on Platform, or both. Every reader checks them against the hash recorded on-chain.
- **Readers** clone with `git clone dash://…` or browse from a static web app. Neither needs a server run by the Forge project.

You do not have to move off GitHub. Keep working there, and let the mirror follow.

This guide covers:

1. [Before you start](#before-you-start)
2. [First import: code, issues, PRs and releases](#1-first-import)
3. [Keep it in sync: push from CI](#2-keep-it-in-sync)
4. [Check the mirror](#3-check-the-mirror)
5. [The Forge Mirror Action (coming soon)](#the-forge-mirror-action-coming-soon)

---

## Before you start

You need:

- `dg`, `git-remote-dash` and `forge-import`, built as in the [quick start](quick-start.md#1-install). Build the importer too:
  ```sh
  cargo install --locked --path crates/forge-import
  ```
- A funded identity, signed in with `dg auth login` and exported as `DASH_FORGE_KEY` ([quick start, steps 2–3](quick-start.md#2-get-an-identity)).
- The [GitHub CLI](https://cli.github.com), logged in with `gh auth login`. The importer reads issues, PRs and releases through it.
- Optional but recommended: a storage profile for your own bucket ([Bring your own storage](bring-your-own-storage.md)), so that pack bytes do not go on Platform at ~0.28 DASH/MiB.

> **Network.** Everything here runs on **testnet** today. There, each repository is a v1 contract that costs about **1.18 DASH** to create. On **forge-v2**, the same repository will cost about **0.001 DASH**. forge-v2's contracts are registered on devnet moutai, but `forge-import`, `dg` and `git-remote-dash` cannot use them yet; it comes to mainnet after Platform protocol 14 activates.

---

## 1. First import

`forge-import` copies a GitHub repository into Forge in one command: every branch and tag, then labels, milestones (as labels), issues with their comments and state, PRs (as metadata: title, body, state and head commit), and releases (tag, title and notes; release assets are not copied).

**Always start with a dry run.** It enumerates everything and prints an estimate, and it writes nothing:

```sh
forge-import alice/project --dry-run
```

Then run it with a spending cap. If the estimate is above the cap, the importer refuses to start:

```sh
forge-import alice/project --max-spend 3 --resume ./alice-project.import.json
```

Useful flags (all real; see `forge-import --help`):

| Flag | Effect |
|---|---|
| `--repo-name <name>` | Name on Forge. The default is the GitHub name. |
| `--skip issues` / `prs` / `releases` / `comments` | Leave out a class. Repeat the flag for more than one. |
| `--limit <n>` | Import at most `n` issues and PRs. Useful for a cheap trial run. |
| `--max-spend <DASH>` | Refuse to start when the estimate exceeds this. The check is on the up-front estimate: actual spend is not metered write by write yet, so leave some margin. |
| `--resume <file>` | The progress file. Rerunning with the same file never duplicates a document or pays twice. |
| `--yes` | No confirmation prompt, for CI. |
| `--network`, `--devnet-name` | The same network flags as `dg`. |

Issues and PRs are created by **your** identity, since GitHub users have no Dash identity. Each carries an `imported` record with the GitHub author, creation time and URL. Forge assigns its own issue and PR numbers, so they may differ from GitHub's.

**Where the packs go.** The importer pushes through `git-remote-dash`, so it follows the git config the helper reads. To keep packs off Platform, set the storage policy globally before you import:

```sh
dg storage use r2-main --global
```

`dg import <url>` exists as a command but is **not wired yet**: it fails with `E103` and points you to `forge-import`.

---

## 2. Keep it in sync

The import is a one-time copy. To follow new commits, push every branch and tag from CI after each push to GitHub. This is plain `git push` to a `dash://` remote.

**What stays in sync this way:** branches and tags, including force-pushes and deletions (with `--prune`).

**What does not:** new issues, PRs and releases. To copy new ones, rerun `forge-import` with the same `--resume` file: it skips everything it already imported. Two things to know about reruns:

- Name the repository you already have with `--repo-contract <contract id>` (from `dg repo view`), so the importer adds to it instead of planning a new one. That path imports issues, PRs and releases only; your CI job keeps pushing the code.
- The printed estimate, and the `--max-spend` check, cover **all** of the GitHub repository's issues, PRs, releases, labels and comments again, not only the new ones. Size the cap for that, or leave it off and read the estimate.

Incremental issue and PR sync is part of the [Mirror Action](#the-forge-mirror-action-coming-soon).

### The CI secret

CI needs an identity file. **Do not give CI your main identity file.** The file from the bridge holds your 12 words and your MASTER key, which is everything.

Make a CI-only copy that holds just the signing key a push needs, the HIGH authentication key. The fields `dg` and the helper need are kept, and every other secret is blanked:

```sh
jq '{network, identityId, mnemonic: "",
     identityKeys: [.identityKeys[] | select(.purpose == "AUTHENTICATION" and .securityLevel == "HIGH")],
     assetLockKey: {wif: "", publicKeyHex: "", derivationPath: ""}}' \
  dash-identity-<id>.json > ci-identity.json
```

Check that it contains exactly one key:

```sh
jq '.identityKeys | length' ci-identity.json    # 1
```

This lowers the risk but does not remove it. A leaked HIGH key can still sign documents and spend the identity's credits until you disable the key. For CI, a cleaner setup is a **separate identity** with a small balance, added to the repository as a collaborator (`dg collab add … --role write`). Then a leak costs only that balance. See [Identity and keys](identity-and-keys.md).

Store the file as a GitHub Actions secret named `DASH_FORGE_IDENTITY`: Settings → Secrets and variables → Actions → New repository secret, and paste the file's contents.

### The workflow

Save this as `.github/workflows/forge-mirror.yml` in the GitHub repository. Replace the owner id and repository name.

```yaml
name: Forge mirror
on:
  push: { branches: ['**'], tags: ['**'] }
  delete:
  schedule: [{ cron: '17 3 * * *' }]   # daily catch-up
  workflow_dispatch:
concurrency: { group: forge-mirror, cancel-in-progress: false }
jobs:
  mirror:
    runs-on: ubuntu-latest
    permissions: { contents: read }
    env:
      FORGE_REMOTE: dash://<owner identity id>/<repo name>
      DASH_FORGE_NETWORK: testnet
      DASH_FORGE_REF: <a dash-forge commit you have reviewed>
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }

      - name: Install protoc
        run: |
          curl -sSLo /tmp/protoc.zip https://github.com/protocolbuffers/protobuf/releases/download/v28.3/protoc-28.3-linux-x86_64.zip
          sudo unzip -q -o /tmp/protoc.zip -d /usr/local bin/protoc 'include/*'

      - name: Build git-remote-dash
        run: |
          git clone https://github.com/PastaPastaPasta/dash-forge "$RUNNER_TEMP/dash-forge"
          cd "$RUNNER_TEMP/dash-forge"      # rustup installs the pinned toolchain here
          git checkout --detach "$DASH_FORGE_REF"
          cargo install --locked --path crates/git-remote-dash

      - name: Push every branch and tag
        env:
          DASH_FORGE_IDENTITY: ${{ secrets.DASH_FORGE_IDENTITY }}
        run: |
          umask 077
          printf '%s' "$DASH_FORGE_IDENTITY" > "$RUNNER_TEMP/identity.json"
          export DASH_FORGE_KEY="$RUNNER_TEMP/identity.json"
          git -c dash.confirm=never push --prune "$FORGE_REMOTE" \
            '+refs/remotes/origin/*:refs/heads/*' '+refs/tags/*:refs/tags/*'
```

Notes:

- **Build time.** The first run builds from source, which takes several minutes. Add [`Swatinem/rust-cache`](https://github.com/Swatinem/rust-cache) to reuse it. Once releases are published, the build step becomes one `install.sh` line.
- **Pin `DASH_FORGE_REF`** to a full commit id you have reviewed. The helper you build runs with your identity file, so building whatever `master` holds on each run would hand your key to any future change there.
- `refs/remotes/origin/*` is used because `actions/checkout` creates only one local branch. With `fetch-depth: 0` it fetches every branch into `refs/remotes/origin/`. `actions/checkout` does not create git's `origin/HEAD` pointer, so no stray `HEAD` branch is pushed.
- `dash.confirm=never` tells the cost guard not to wait for a terminal that CI does not have. The push still prints its estimate and its actual charge in the job log.
- **Cost cap.** The helper has no per-run cap yet (the Action will add `cost-cap`). Keep the CI identity's balance small. That balance is the cap.
- **Bring your own storage in CI.** Add your storage profile to the job with `dg storage add … --secret-access-key env:S3_SECRET_ACCESS_KEY`, set the secret from GitHub secrets, and run `dg storage use <profile>` before the push. The job then also needs `dg`. [Bring your own storage](bring-your-own-storage.md) lists the flags for each provider.

### Without GitHub Actions

Any machine with cron works the same way:

```sh
# crontab -e
*/15 * * * * cd /srv/mirror/project && git fetch --prune --prune-tags origin '+refs/heads/*:refs/mirror/heads/*' '+refs/tags/*:refs/tags/*' && DASH_FORGE_KEY=/srv/mirror/ci-identity.json git -c dash.confirm=never push --prune dash://<owner>/<repo> '+refs/mirror/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*'
```

Create `/srv/mirror/project` once with `git clone --bare https://github.com/alice/project /srv/mirror/project`. The fetch copies GitHub's branches into a private `refs/mirror/heads/` namespace, so git's own `origin/HEAD` pointer never reaches the mirror, and `--prune-tags` makes tag deletions on GitHub reach it too.

---

## 3. Check the mirror

```sh
git ls-remote dash://<owner>/<repo>           # every branch and tag, as recorded on-chain
dg repo view <owner>/<repo>                   # refs, collaborators, storage
dg storage status <owner>/<repo>              # does every recorded copy of every pack answer?
```

On the web: `https://forge.dashhq.org/repo?owner=<owner>&name=<repo>`.

To check that a branch's history on the mirror matches GitHub, compare its tip on both:

```sh
git clone dash://<owner>/<repo> from-forge
git -C from-forge rev-parse main
git ls-remote https://github.com/alice/project refs/heads/main
```

The two ids must match. A commit id is a hash over the commit and everything it reaches, so equal ids mean identical history for that branch. Repeat for other branches and tags, or compare the full `git ls-remote` output of both. [Verify Forge](verify-forge.md) goes further.

---

## The Forge Mirror Action (coming soon)

A dedicated GitHub Action will replace the hand-written workflow above. It will also sync issues, PRs and releases incrementally, and it will enforce a cost cap per run. A setup wizard at `forge.dashhq.org/mirror` will create the identity, the storage and the runner key in your browser, with no local install.

The Action will sign with a **limited runner key**: a key that can spend at most a set budget (0.5 DASH by default), only on Forge, and only until it expires. If it leaks, the damage is bounded. Limited keys need Platform protocol 14.

The spec'd workflow file. **Not published yet: do not copy this into a real workflow.**

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

In this future format, `DASH_FORGE_KEY` holds the limited key itself as one pasteable value (`dfk1:<network>:<identity id>:<key id>:<wif>`), not a file path. Planned behavior:

- Every branch and tag is mirrored, force-pushes included.
- Releases are mirrored with their assets re-uploaded to your bucket and their SHA-256 recorded.
- Issues, PRs and comments are mirrored with a header naming the GitHub author. A mirrored PR's head is kept at `refs/mirror/pull/<n>/head`, so it can be checked out.
- The job summary shows what was written, what Platform charged, and how much budget the runner key has left.
