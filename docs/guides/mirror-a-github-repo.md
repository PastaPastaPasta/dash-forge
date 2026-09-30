# Mirror a GitHub repository

GitHub can take down a repository: a DMCA notice, a sanctions ruling, or a policy change is enough. A Forge mirror is a copy that nobody can take down:

- **Refs and history metadata** live on Dash Platform, signed by your identity. There is no moderation at the protocol level, so nobody can delete them.
- **Pack bytes** live in storage you control (your bucket or IPFS node), on Platform, or both. Every reader checks them against the hash recorded on-chain.
- **Readers** clone with `git clone dash://…` or browse from a static web app. Neither needs a server run by the Forge project.

You do not have to move off GitHub. Keep working there, and let the mirror follow.

There are two ways to run a mirror, and both use the same engine, `forge-import`:

- **The [Forge Mirror Action](#2-the-forge-mirror-action)** (recommended): one workflow file in the GitHub repository. On every push, issue, PR and release, and on a daily schedule, it mirrors what changed, under a per-run cost cap. **[The setup wizard](#the-setup-wizard) at forge.dashhq.org/mirror sets it up from your browser, with nothing to install.**
- **By hand or from cron**: run `forge-import` (or `dg import`) yourself.

This guide covers:

1. [The setup wizard](#the-setup-wizard)
1. [Before you start](#before-you-start)
2. [First import: code, issues, PRs and releases](#1-first-import)
3. [The Forge Mirror Action](#2-the-forge-mirror-action)
4. [Keep it in sync without the Action](#3-keep-it-in-sync-without-the-action)
5. [Check the mirror](#4-check-the-mirror)

---

## The setup wizard

Open **[forge.dashhq.org/mirror](https://forge.dashhq.org/mirror/)**, or **New → Mirror a GitHub repo** in the header. You need a public GitHub repository and a Dash identity. You can create the identity on the same page ([Identity and keys](identity-and-keys.md)). The hosted site moves to bonsia when the web app cuts over ([Which network](README.md#which-network)). Until then, the wizard is at `/mirror` on any build of `forge-web` for bonsia. The wizard works through six steps:

| Step | What happens | On chain |
|---|---|---|
| 1. GitHub repository | Your browser asks GitHub's public REST API, without signing in, whether the repository exists and is public. There is no GitHub OAuth app. | nothing |
| 2. Forge repository | The name is suggested from GitHub, and the description is `… (mirror of github.com/<owner>/<repo>)`, which the web uses to link back. A repository of yours with that name is reused at no cost. | three documents, about 0.002 DASH |
| 3. Storage | Pick a saved bucket, or add one with the [storage wizard](bring-your-own-storage.md). R2 or S3 is recommended. The step shows the CORS policy to paste, and also offers Dash Platform, priced for this repository's size. | nothing |
| 4. Runner key | This registers a limited key on your identity: bound to Forge's contracts, with a budget (default 0.5 DASH) and an expiry (default 365 days). Your identity file or recovery words sign once and are not stored. The key is shown **once**, as the `DASH_FORGE_KEY` value to paste into GitHub. It belongs to the repository's owner, so the Action needs no membership. | one identity update, about 0.0003–0.0005 DASH |
| 5. Workflow file | The wizard lists the secrets to add first (`DASH_FORGE_KEY`, plus `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` for a bucket), with copy buttons and a link to GitHub's *New repository secret* page. It then builds [the workflow below](#the-workflow) with every input filled in. **Create this file on GitHub** opens GitHub's new-file page with it filled in. | nothing |
| 6. First run | Committing the file starts the first run. The page checks Platform every 10 seconds until the mirror's branches appear, then links to the repository. | the run, under its cost cap, paid through the runner key |

The wizard pins the build and the Action to one Dash Forge commit, the one the site was built from. The workflow checks out that commit, builds the three tools, and runs the Action from the checkout (`uses: ./.dash-forge/action`). Progress is saved in the browser, so a closed tab picks up where it stopped. A key is never saved.

**How long it takes.** A timed run on devnet bonsia (2026-09-30) mirrored a small public repository (two commits) with Platform storage. The wizard's own steps took 16 seconds of machine time: the GitHub check, signing in, creating the repository, the runner key and the workflow. A person reading, typing and pasting needs a few minutes more. From the workflow commit to the first mirrored push took 3 minutes 50 seconds. Of that, compiling the tools took 3 minutes 9 seconds, because no Dash Forge release is published yet. Mirroring took under 30 seconds and spent 0.018 DASH, the Action's own up-front estimate. Counted from opening the page, the mirror was live after 6 minutes 11 seconds, and that included a two-minute fix made during the run. Later runs reuse rust-cache: the run for the next push took 1 minute 41 seconds in all.

---

## Before you start

You need:

- `dg`, `git-remote-dash` and `forge-import`, built as in the [quick start](quick-start.md#1-install). Build the importer too:
  ```sh
  cargo install --locked --path crates/forge-import
  ```
- A funded identity, signed in with `dg auth new` or `dg auth login` ([quick start, steps 2–3](quick-start.md#2-get-an-identity)). `dg import` uses that stored key. The standalone `forge-import` does not read `dg`'s default: give it `--identity <source>` or `DASH_FORGE_KEY`, for example `DASH_FORGE_KEY=keychain:dash-forge/devnet-bonsia/<identity id>` for the key `dg auth` keeps in the keychain ([key sources](identity-and-keys.md#where-keys-live-today)).
- The [GitHub CLI](https://cli.github.com), logged in with `gh auth login` (or `GH_TOKEN` / `GITHUB_TOKEN` in the environment). The importer reads issues, PRs and releases through it.
- Optional but recommended: a storage profile for your own bucket (`dg storage add`; see [Bring your own storage](bring-your-own-storage.md)), so that pack bytes do not go on Platform at ~0.33 DASH/MiB ([Costs](costs.md)).

> **Network.** The importer writes **forge-v2** repositories (about **0.0016 DASH** to create). They exist on devnet bonsia today (`--network devnet --devnet-name bonsia`), come to testnet when Platform protocol 14 reaches it, and to mainnet after protocol 14 activates there and the contracts are registered.

> **Cost.** A first import is mostly git data plus one document per issue, PR, comment and review. The Mirror Action's first live run of a small repository (`dash-faucet`, packs on Platform) cost about **0.078 DASH**; a repository with 2 PRs, 15 comments and 7 reviews cost 0.112 DASH. Re-runs pay only for what is new, and nothing when nothing changed. `--dry-run` prices your repository before you spend anything.

---

## 1. First import

`forge-import` (or `dg import`, the same engine) copies a GitHub repository into a forge-v2 repository: every branch and tag, the head of every open PR (as `refs/mirror/pull/<n>/head`, so imported PRs can be checked out; a closed PR's head is removed and its commits are not the mirror's to pay for), labels, issues and PRs with their comments, reviews and state (open, closed, merged, labels, draft), and releases (tag, title, notes, and each asset referenced by its GitHub URL and SHA-256; assets are not re-uploaded).

**Where the packs go.** The importer pushes through `git-remote-dash`, so it follows the git config the helper reads. To keep packs off Platform, set the storage policy globally before you import:

```sh
dg storage use r2-main --global
```

The estimate follows the same policy. With your own storage, the git part costs only the manifests and ref updates on Platform (measured at 0.0035–0.0041 DASH for a push of two or three refs; see [Costs](costs.md)), not the pack's bytes, so a `--max-spend` sized for that is not refused. A policy that includes `platform`, or sets `dash.platformFallback`, is priced as Platform storage, because the pack may land there.

**Log output.** The importer prints its own warnings. The Platform SDK's reports of a failure forge-core recovers from (a write whose nonce another write by the same identity took, a transport retry) are not printed. A failure still ends the run with an error. To see every retry, set `RUST_LOG=debug`.

**Always start with a dry run.** It reads everything, compares it with what the destination already holds, and prints what it would write and what that would cost. It writes nothing:

```sh
forge-import alice/project --network devnet --devnet-name bonsia --dry-run
```

Then run it with a spending cap:

```sh
forge-import alice/project --network devnet --devnet-name bonsia --max-spend 0.5 --state ./alice-project.sync.json
```

Unlike `git` and `dg`, the standalone `forge-import` does not read the network `dg auth` recorded: without `--network` (or `DASH_FORGE_NETWORK` / `DASH_FORGE_DEVNET_NAME`) it uses testnet, which has no Forge deployment ([E702](../errors.md#e702)). `dg import alice/project` takes the same core flags and uses `dg`'s network and identity defaults.

Useful flags (see `forge-import --help`):

| Flag | Effect |
|---|---|
| `--repo <owner/name or name>` | The destination. The default is the GitHub name, owned by you; it is created when missing. |
| `--sync code,issues,prs,releases,labels` | What to mirror (default: all). |
| `--max-spend <DASH>` | A hard cap. The importer refuses to start when the estimate exceeds it, and checks it again **before every write** against what the run has actually spent (the measured balance drop, not just the estimate), so it stops before the write that would cross it. The estimate is calibrated to stay an upper bound. |
| `--state <file>` | Incremental state: the next run asks GitHub only for issues, PRs and comments updated since this run started. |
| `--dry-run` | Price only. |
| `--include-label-definitions` | A private destination only: mirror the label definitions too. Their names, colours and descriptions are not encrypted, so they are left out by default; the labels set on issues and PRs are encrypted either way. |
| `--limit <n>` | At most `n` issues and PRs (the oldest), for a cheap trial. Only those items and their comments are read, so a trial on a repository with thousands of issues takes a few requests. |
| `--yes` | No confirmation prompt, for CI. |
| `--summary-json <file>` | Write the run summary (counts, spend, key budget) as JSON. `forge-import` only. |
| `--work-dir <dir>` | Keep the bare git mirror between runs instead of a temporary directory. `forge-import` only. |
| `--network`, `--devnet-name`, `--identity` | As for `dg`. `DASH_FORGE_KEY` may be a file path or an inline `dfk1:` key. |

Issues and PRs keep their GitHub numbers (Forge numbers issues and PRs separately, so each keeps its own). They are written by **your** identity, since GitHub users have no Dash identity: each opens with *"Mirrored from github.com/alice/project#12 by @bob"* and carries an `imported` record with the GitHub author, creation time and URL. Close, reopen, merge, label and draft changes are written as member events, so the importing identity must be a maintainer (or a writer, which cannot publish releases) of the destination.

**Numbers on a mirror.** Forge continues a mirror's numbering: after an imported #7761, the next issue opened on Forge is #7762, as on GitHub. That holds when the importing identity is the repo's owner or a **maintainer**, whose numbers clients trust; a writer's imported numbers get no such trust, and new issues start again from a low number. Because a mirror shares numbers with its source, an issue opened on the mirror can take a number the upstream project uses later. When the import meets such a number, it stores that one upstream item at the lowest free number instead (its header and `imported` record still name the GitHub number) and says so in the summary's warnings, for example *"upstream issue #7762 stored as #16 (number taken on Forge): https://github.com/alice/project/issues/7762"*. GitHub gives issues and PRs numbers from one sequence, so that low number is one a PR has upstream, and later upstream issues keep their numbers. (From GitLab, where issues and merge requests are numbered separately and a full mirror leaves no gap, each later item moves by one instead, and each move is reported.) The New issue form on a mirror says this before you post.

**Re-running is safe and cheap.** What is already mirrored is decided on chain (by the GitHub URL recorded in each document), not by a local file. A re-run writes only what is new or changed, and costs nothing when nothing changed. An interrupted or capped run is finished by running it again; nothing is written twice.

**How a run ends.** The summary's `status` (and the exit code) says:

| Status | `forge-import` exit | `dg import` exit | Meaning |
|---|---|---|---|
| `ok` / `dry_run` | 0 | 0 | Finished. |
| `partial` | 4 | 1 (E106) | Finished, but some items were skipped (their number is taken in the destination, the destination refused them, another identity already mirrored them, or the optional push of open PR heads did not fit the cap or failed). `counts.skipped`, `counts.gitSkipped` and the warnings say which. When issues or PRs were skipped, the `--state` file does not advance, so the next run retries them. A skipped PR-heads push alone does not hold the state back: git data is compared with the destination on every run. |
| `cap_exceeded` | 3 | 8 (E801) | Stopped before the write that would cross `--max-spend`. |
| `error` | 1 | by error | Failed. What was spent before the failure is still reported. |

A run with `--limit` that left items out does not advance `--state` either, and warns: every run takes the same first `n` items, so a recurring job with `--limit` never reaches the rest. Use `--limit` for a trial only.

**Refused history.** The importer pushes through `git-remote-dash`, so a history holding an object git itself refuses (a `.git` look-alike path, a hostile `.gitmodules`) stops the push before anything is stored or paid for ([E511](../errors.md#e511)). Old commits with malformed author or committer lines (a bad time zone, a broken email) are accepted, as a plain `git clone` accepts them; that needs git 2.44 or newer.

**Importing in phases.** A large repository can be imported in steps: the code first, then the issues and PRs, each with its own cap and state file:

```sh
forge-import alice/project --sync code,releases,labels --work-dir ./project.git --state ./project-code.sync.json --max-spend 100
forge-import alice/project --sync issues,prs,labels --work-dir ./project.git --state ./project-collab.sync.json --max-spend 5
```

**Run the code pass first.** A merged PR is recorded as merged only when a base tip already on chain contains its merge commit. A pass without `code` checks that itself and pushes nothing. It fetches the merged PRs' base branches from the source: into the `--work-dir` mirror when a code run left one there, or else commits only, into a temporary repository that is removed after the run (never inside `--work-dir`). If the base branch's tip on chain does not contain the merge yet, the PR is recorded as closed. The same happens when the base could not be fetched. The run warns for each such PR, the summary counts them (`unprovedMerges`), and `--state` keeps their numbers: the next run reads them again whatever changed, and turns each close into a merge once the code is on chain (one small event per PR; nothing else is written again). A PR whose base branch was deleted at the source can never be proved; it stays closed, and is not revisited. Nor can a PR mirrored before its base branch was on chain at all: a merge counts only into a base that was a branch when the PR was opened on Forge ([forge-v2 §6](../contracts/forge-v2.md)), which is why the code must come first.

**Release assets.** A release lists its assets in at most 4,096 bytes, about 16 GitHub assets. When a source release has more, the importer keeps, in this order:
1. checksum files (`SHA256SUMS`, `checksums.txt`) and their signatures;
2. Linux x86-64 builds;
3. Windows;
4. macOS arm64;
5. macOS x86-64;
6. Linux arm64;
7. source archives;
8. everything else.

A signature or per-file checksum (`<file>.asc`, `.sig`, `.minisig`, `.sha256`, `.sha512`) is kept right after its file when it fits, and never without it; a checksum list such as `SHA256SUMS.asc` counts as a checksum file. The release's notes then end with a line saying how many assets are not mirrored, with a link to the source release, and the web shows it as "N more assets not mirrored". The summary counts them (`assetsOmitted`). The importer hashes up to 4 GiB of assets per run, newest releases first; an imported asset it has not hashed yet is shown as "not verified yet" with a link to its original on GitHub or GitLab, and a later run hashes it (`assetsUnhashed`). A release published on Forge itself never offers a file without a recorded hash. Mirroring every asset of a large release needs a contract change, proposed in [release asset manifests](../design/release-asset-manifest.md).

**Into a private repository**, releases are sealed ([private repositories §16](../security/private-repos.md#16-sealed-releases)) and have no 4,096-byte limit: every asset is listed in an encrypted asset list. Each asset the importer can download from its public URL, within the same 4 GiB per run and 1 GiB per release (a release's files are held in memory while they are encrypted), is checked against the size and digest the source records, encrypted and stored on your own storage (the policy set above). The others are listed as links to the source until a later run seals them (`assetsLinked`). The download sends no token, so a private source repository's assets stay links. The source link, publisher and publish date are encrypted too. A private import with releases therefore needs storage of your own: without it, a release with assets is skipped and the run ends `partial`. Storage still shows each asset's exact size, which can identify the public release it mirrors, and the run warns about it.

**Not mirrored.** Edits to a title or body after the item was first mirrored, a PR's later retarget to another base, and a PR's later head moves (its `headOid` stays at the commit it was mirrored at; `refs/mirror/pull/<n>/head` follows the head while the PR is open). Reactions, milestones, assignees, projects and GitHub Discussions are not mirrored.

---

## 2. The Forge Mirror Action

The [Forge Mirror Action](../../action/README.md) runs `forge-import` from GitHub Actions. It pushes code and syncs issues, PRs, releases and labels incrementally. Each run is idempotent, so running it again writes nothing and costs 0, and each run has a cost cap. The [Action's README](../../action/README.md) covers every input and output, what is and is not synced, the job summary, and the security notes.

### The CI secret

The Action signs with the `DASH_FORGE_KEY` repository secret (Settings → Secrets and variables → Actions → New repository secret). **Do not give CI your main identity file.** The file from the bridge holds your 12 words and your MASTER key, which is everything. Use one of these:

- **A limited runner key** (best): one pasteable value, `dfk1:<network>:<identity id>:<key id>:<wif>`. It can spend at most its budget, only on Forge, and only until it expires, and Platform enforces that at consensus. Making one needs your master key once. If you signed in with the identity file from the bridge, pass that file with `--master`:

  ```sh
  dg auth export --new-key --master dash-identity-<id>.json \
    --budget 0.5 --expires 365d --format dfk1 --reveal-secrets -o runner.dfk1
  ```

  Without `--master`, `dg` asks for your 12 recovery words instead. `dg` only reads the master key from the file: the key is not stored and CI never sees it.

  The file's one line is the secret. Paste it, then delete the file. `dg auth keys list` shows the key, and `dg auth keys disable <id>` retires it.
- **A CI-only identity file**, stripped to the one signing key a push needs, the HIGH authentication key. The fields the tools need are kept, and every other secret is blanked:

  ```sh
  jq '{network, identityId, mnemonic: "",
       identityKeys: [.identityKeys[] | select(.purpose == "AUTHENTICATION" and .securityLevel == "HIGH")],
       assetLockKey: {wif: "", publicKeyHex: "", derivationPath: ""}}' \
    dash-identity-<id>.json > ci-identity.json
  jq '.identityKeys | length' ci-identity.json    # must print 1
  ```

  Paste the file's contents as the secret. This lowers the risk but does not remove it: a leaked HIGH key can sign documents and spend the identity's credits until you disable it. Better still, use a **separate identity** with a small balance, added to the repository as a maintainer (`dg collab add <owner>/<repo> <ci identity id> --role maintainer`; a writer works too, but cannot publish releases). Then a leak costs only that balance. See [Identity and keys](identity-and-keys.md).

Add your storage secrets too, for example `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` (or `PINNING_TOKEN`).

### The workflow

Save this as `.github/workflows/forge-mirror.yml` in the GitHub repository. Replace the owner id and repository name.

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
      # Until the first Dash Forge release, build the binaries (see below).
      - name: Install protoc
        run: |
          curl -sSLo /tmp/protoc.zip https://github.com/protocolbuffers/protobuf/releases/download/v28.3/protoc-28.3-linux-x86_64.zip
          sudo unzip -q -o /tmp/protoc.zip -d /usr/local bin/protoc 'include/*'
      - name: Build dg, git-remote-dash and forge-import
        env:
          DASH_FORGE_REF: <a dash-forge commit you have reviewed>
        run: |
          git clone https://github.com/PastaPastaPasta/dash-forge "$RUNNER_TEMP/dash-forge"
          cd "$RUNNER_TEMP/dash-forge" && git checkout --detach "$DASH_FORGE_REF"
          cargo build --release --locked -p dg -p git-remote-dash -p forge-import
          echo "$RUNNER_TEMP/dash-forge/target/release" >> "$GITHUB_PATH"

      - uses: PastaPastaPasta/dash-forge/action@<the same commit>
        with:
          repo: dash://<owner identity id>/<repo name>
          network: devnet                 # the default is mainnet, which has no Forge deployment yet
          devnet-name: bonsia
          sync: code,releases,issues,prs
          storage-kind: s3
          s3-endpoint: https://<account>.r2.cloudflarestorage.com
          s3-region: auto
          s3-bucket: forge
          s3-public-url: https://pub-9a1.r2.dev
          cost-cap: '0.05'
          install: 'false'                # use the binaries built above
        env:
          DASH_FORGE_KEY: ${{ secrets.DASH_FORGE_KEY }}
          S3_ACCESS_KEY_ID: ${{ secrets.S3_ACCESS_KEY_ID }}
          S3_SECRET_ACCESS_KEY: ${{ secrets.S3_SECRET_ACCESS_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

No `actions/checkout` step is needed: the Action keeps its own bare mirror of the GitHub repository and never runs code from it, so `pull_request_target` is safe here.

Run it once with `dry-run: 'true'` from the Actions tab (`workflow_dispatch`) to see the estimate before you spend anything.

Before you copy it:

- **No release is published yet.** The Action's default `install: 'true'` downloads a release with `install.sh`, so for now it has nothing to install; that is why the workflow builds the binaries and passes `install: 'false'`. The first build takes several minutes; [`Swatinem/rust-cache`](https://github.com/Swatinem/rust-cache) speeds up later runs. [`.github/workflows/mirror-action.yml`](../../.github/workflows/mirror-action.yml) is this repository's own live test of the Action. Once releases exist, drop the two build steps and `install: 'false'`.
- **Pin a reviewed commit** for both the build and the Action. The binaries run with your key, so building whatever `master` holds on each run would hand the key to any future change there.
- **Anyone who can open an issue or a PR can make a run spend**, up to `cost-cap` per event, until the key's budget or the identity's balance runs out. On a busy public repository, drop the event triggers and let the daily schedule do the work, or remove `issues,prs` from `sync`.
- **Status.** `ok`, `dry_run` and `partial` succeed (`partial` with a warning, since the next run retries; `fail-on-partial: 'true'` fails it). `cap_exceeded` and `error` fail the step. The job summary shows what was written, the spend against the estimate, and the runner key's remaining budget and expiry.
- Release assets are not copied. They are recorded by GitHub URL with a sha256: GitHub's digest when it reports one, otherwise one the importer computes by downloading the asset once (nothing is kept, and a re-run reuses the recorded hash). An asset that cannot be hashed is recorded without one, with a warning; `dg release download` and the web refuse to hand out such an asset unverified. GitHub's download links cannot be read by a web page (no CORS), so the web's release page links to them directly and offers to check the downloaded file against the hash.
- A merged pull request is recorded as merged when the mirror has pushed a tip of its base branch that contains the merge commit (usually the next run after the merge). A PR merged into a branch that is not mirrored, or was deleted, is recorded as closed. A PR an older import recorded closed becomes merged on the next run: the first run after upgrading `forge-import` reads everything again, whatever its `--state` file says (the state's scope carries a version, `v2`), so older items are revisited once.
- If a run fails after some ref updates or a pack landed, the summary counts them (and warns); a re-run does not write or pay for them again.

The [setup wizard](#the-setup-wizard) writes this file for you, with the secrets and every input filled in.

---

## 3. Keep it in sync without the Action

Run the same import again whenever you like, from cron or another CI system, with the same `--state` file. It copies branches and tags (force-pushes and deletions included), plus new issues, PRs, comments, reviews, state changes, labels and releases. Nothing else is written.

```sh
# crontab -e: every 15 minutes, code and issues, never more than 0.02 DASH a run
*/15 * * * * DASH_FORGE_KEY=/srv/mirror/ci-identity.json forge-import alice/project --repo <owner id>/project --network devnet --devnet-name bonsia --state /srv/mirror/project.sync.json --work-dir /srv/mirror/project.git --max-spend 0.02 --yes --summary-json /srv/mirror/last-run.json
```

If you only want code, plain git does it with no importer at all:

```sh
# once: git clone --bare https://github.com/alice/project /srv/mirror/project
cd /srv/mirror/project \
  && git fetch --prune --prune-tags origin '+refs/heads/*:refs/mirror/heads/*' '+refs/tags/*:refs/tags/*' \
  && DASH_FORGE_KEY=/srv/mirror/ci-identity.json git -c dash.confirm=never push --prune dash://<owner>/<repo> \
       '+refs/mirror/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*'
```

The fetch copies GitHub's branches into a private `refs/mirror/heads/` namespace, so git's own `origin/HEAD` pointer never reaches the mirror, and `--prune-tags` makes tag deletions on GitHub reach it too. `dash.confirm=never` tells the cost guard not to wait for a terminal; the push still prints its estimate and its actual charge. A plain push has no per-run cap, so keep that identity's balance small.

**Use explicit refspecs, not `git push --mirror`.** `--mirror` pushes every ref the local repository holds. A clone made with `git clone --mirror` holds GitHub's `refs/pull/*`, and each of those would become a paid ref update on the mirror. Push `refs/heads/*` and `refs/tags/*` as above. `HEAD` needs no push: the helper derives it from the repository's default branch and does not offer it to a push, and a push that names `HEAD` anyway writes nothing.

---

## 4. Check the mirror

```sh
git ls-remote dash://<owner>/<repo>           # every branch and tag, as recorded on-chain
dg repo view <owner>/<repo>                   # refs, members, pack count and size
dg storage status <owner>/<repo>              # does every recorded copy of every pack answer?
```

On the web: `https://forge.dashhq.org/<owner>/<repo>`. Each imported issue and PR opens with a line naming its GitHub original and author.

If the page says **Not indexed for browsing yet**, the import stored the code but not its browse index; the import's summary says so as a warning. The repository still clones. To publish the index without storing the code again, run:

```sh
dg repo reindex <owner>/<repo>   # shows the price first; the index is 36 bytes per object
```

It reads the stored packs, builds their index locally and uploads only that, about a thirtieth of what the code cost: about 3.6 DASH quoted for dashpay/dash's 268,015 objects, whose code upload was 98 DASH. The index goes to Platform when the packs are there. When the packs live on your own storage, name it with `--profile <name>[,<name>…]` (as for `dg repack`); the index then costs only its manifest on chain. If the warning names `dg repack` instead, the index cannot be extended as it stands, and a repack rebuilds it.

To check that a branch's history on the mirror matches GitHub, compare its tip on both:

```sh
git clone dash://<owner>/<repo> from-forge
git -C from-forge rev-parse main
git ls-remote https://github.com/alice/project refs/heads/main
```

The two ids must match. A commit id is a hash over the commit and everything it reaches, so equal ids mean identical history for that branch. Repeat for other branches and tags, or compare the full `git ls-remote` output of both. [Verify Forge](verify-forge.md) goes further.
