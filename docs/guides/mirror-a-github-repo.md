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
5. [The Forge Mirror Action](#the-forge-mirror-action)

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

> **Network.** The importer writes **forge-v2** repositories (about **0.001 DASH** to create). They exist on devnet moutai today (`--network devnet --devnet-name moutai`), come to testnet when Platform protocol 14 reaches it, and to mainnet after protocol 14 activates there.

---

## 1. First import

`forge-import` (or `dg import`, the same engine) copies a GitHub repository into a forge-v2 repository: every branch and tag, the head of every open PR (as `refs/mirror/pull/<n>/head`, so imported PRs can be checked out; a closed PR's head is removed and its commits are not the mirror's to pay for), labels, issues and PRs with their comments, reviews and state (open, closed, merged, labels, draft), and releases (tag, title, notes, and each asset referenced by its GitHub URL and SHA-256; assets are not re-uploaded).

**Always start with a dry run.** It reads everything, compares it with what the destination already holds, and prints what it would write and what that would cost. It writes nothing:

```sh
forge-import alice/project --dry-run
```

Then run it with a spending cap:

```sh
forge-import alice/project --max-spend 0.5 --state ./alice-project.sync.json
```

Useful flags (see `forge-import --help`):

| Flag | Effect |
|---|---|
| `--repo <owner/name or name>` | The destination. The default is the GitHub name, owned by you; it is created when missing. |
| `--sync code,issues,prs,releases,labels` | What to mirror (default: all). |
| `--max-spend <DASH>` | A hard cap. The importer refuses to start when the estimate exceeds it, and checks it again **before every write** against what the run has actually spent (the measured balance drop, not just the estimate), so it stops before the write that would cross it. |
| `--state <file>` | Incremental state: the next run asks GitHub only for issues, PRs and comments updated since this run started. |
| `--dry-run` | Price only. |
| `--limit <n>` | At most `n` issues and PRs, for a cheap trial. |
| `--yes` | No confirmation prompt, for CI. |
| `--summary-json <file>` | Write the run summary (counts, spend, key budget) as JSON. |
| `--network`, `--devnet-name`, `--identity` | As for `dg`. `DASH_FORGE_KEY` may be a file path or an inline `dfk1:` key. |

Issues and PRs keep their GitHub numbers (Forge numbers issues and PRs separately, so each keeps its own). They are written by **your** identity, since GitHub users have no Dash identity: each opens with *"Mirrored from github.com/alice/project#12 by @bob"* and carries an `imported` record with the GitHub author, creation time and URL. Close, reopen, merge, label and draft changes are written as member events, so the importing identity must be a maintainer (or a writer, which cannot publish releases) of the destination.

**Re-running is safe and cheap.** What is already mirrored is decided on chain (by the GitHub URL recorded in each document), not by a local file. A re-run writes only what is new or changed, and costs nothing when nothing changed. An interrupted or capped run is finished by running it again; nothing is written twice.

**How a run ends.** The summary's `status` (and the exit code) says:

| Status | `forge-import` exit | `dg import` exit | Meaning |
|---|---|---|---|
| `ok` / `dry_run` | 0 | 0 | Finished. |
| `partial` | 4 | 1 (E106) | Finished, but some items were skipped (their number is taken in the destination, the destination refused them, another identity already mirrored them, or the optional push of open PR heads did not fit the cap or failed). `counts.skipped`, `counts.gitSkipped` and the warnings say which. When issues or PRs were skipped, the `--state` file does not advance, so the next run retries them. A skipped PR-heads push alone does not hold the state back: git data is compared with the destination on every run. |
| `cap_exceeded` | 3 | 8 (E801) | Stopped before the write that would cross `--max-spend`. |
| `error` | 1 | by error | Failed. What was spent before the failure is still reported. |

A run with `--limit` that left items out does not advance `--state` either, and warns: every run takes the same first `n` items, so a recurring job with `--limit` never reaches the rest. Use `--limit` for a trial only.

**Not mirrored.** Edits to a title or body after the item was first mirrored, a PR's later retarget to another base, and a PR's later head moves (its `headOid` stays at the commit it was mirrored at; `refs/mirror/pull/<n>/head` follows the head while the PR is open). Reactions, milestones, assignees, projects and GitHub Discussions are not mirrored.

**Where the packs go.** The importer pushes through `git-remote-dash`, so it follows the git config the helper reads. To keep packs off Platform, set the storage policy globally before you import:

```sh
dg storage use r2-main --global
```

---

## 2. Keep it in sync

Run the same import again whenever you like, from cron or CI, with the same `--state` file. It copies branches and tags (force-pushes and deletions included), plus new issues, PRs, comments, reviews, state changes, labels and releases. Nothing else is written. The Mirror Action below does exactly this on every GitHub event.

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

This lowers the risk but does not remove it. A leaked HIGH key can still sign documents and spend the identity's credits until you disable the key. For CI, a cleaner setup is a **separate identity** with a small balance, added to the repository as a collaborator (`dg collab add … --role writer`). Then a leak costs only that balance. See [Identity and keys](identity-and-keys.md).

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
      DASH_FORGE_NETWORK: devnet
      DASH_FORGE_DEVNET_NAME: moutai
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

## The Forge Mirror Action

The [Forge Mirror Action](../../action/README.md) replaces the hand-written workflow above. It pushes code, and it also syncs issues, PRs, releases and labels incrementally. Each run is idempotent, so running it again writes nothing and costs 0, and each run has a cost cap. The [Action's README](../../action/README.md) covers the inputs, the outputs, what is and is not synced, and the security notes.

```yaml
name: Forge mirror
on:
  push: { branches: ['**'], tags: ['**'] }
  issues: { types: [opened, edited, closed, reopened, labeled, unlabeled] }
  issue_comment: { types: [created] }
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
      - uses: PastaPastaPasta/dash-forge/action@master
        with:
          repo: dash://<owner identity id>/<repo name>
          network: devnet                 # the default is mainnet, which has no Forge deployment yet
          devnet-name: moutai
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

Before you copy it:

- **No release is published yet.** The Action's default `install: 'true'` downloads a release, so for now it has nothing to install. Build `dg`, `git-remote-dash` and `forge-import` in the job, as in the workflow above, and pass `install: 'false'`. [`.github/workflows/mirror-action.yml`](../../.github/workflows/mirror-action.yml) shows how. Use `@master` until the Action has a release tag, or pin a reviewed commit id.
- **`DASH_FORGE_KEY`** is either a limited runner key, as one pasteable value (`dfk1:<network>:<identity id>:<key id>:<wif>`), or the contents of the CI-only identity file from [The CI secret](#the-ci-secret). A limited key can spend at most a set budget (0.5 DASH by default), only on Forge, and only until it expires. Limited keys need Platform protocol 14.
- **Anyone who can open an issue or a PR can make a run spend**, up to `cost-cap` per event, until the key's budget or the identity's balance runs out. On a busy public repository, drop the event triggers and let the daily schedule do the work.
- Release assets are not copied. They are recorded by GitHub URL, with a sha256 when GitHub reports one. Edits to an issue or PR body after the first import are not synced yet.

A setup wizard at `forge.dashhq.org/mirror` (coming soon) will create the identity, the storage and the runner key in your browser, with no local install.
