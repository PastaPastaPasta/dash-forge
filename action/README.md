# Dash Forge Mirror Action

Keeps a [Dash Forge](../README.md) copy of a GitHub repository up to date: branches and tags, and optionally issues, pull requests, releases and labels. The copy lives on Dash Platform, so it stays readable and clonable if the GitHub repository goes away.

Each run is **idempotent** (running it again writes nothing and costs nothing) and **capped** (it will not spend more than `cost-cap` DASH).

> **Status.** Forge runs on devnet **sakura** (Forge's contracts are registered on Platform v5.0.0-beta.2), the network [forge.dashhq.org](https://forge.dashhq.org) runs on, and that is the Action's default network. It is not deployed on mainnet or testnet yet. Pin a release tag: at `@v0.1.0` the Action's `version` defaults to `0.1.0`, so the default `install: 'true'` downloads that release's `dg`, `git-remote-dash` and `forge-import`, checked against its `SHA256SUMS` (and its build attestation, with `gh` signed in). To run code that is not in a release, pin a commit you have reviewed (`@<40-character commit id>`) with `install: 'source'`: the Action then builds the three tools from that commit, which takes several minutes on the first run; later runs reuse a build cache. Avoid `@master`: it runs master's scripts with the latest release's binaries.

## Quick start

1. **Create the destination repository and an identity to sign with.** Follow [Mirror a GitHub repository](../docs/guides/mirror-a-github-repo.md) for the first import. The Action can also create the repository on its first run, when `repo` is a bare name or names the signer as the owner.
2. **Make a runner key.** The best choice is a *limited runner key*: it can spend at most its budget (0.5 DASH by default), only on Forge, and only until it expires (365 days by default). Make one with `dg auth export --new-key` ([guide](../docs/guides/mirror-a-github-repo.md#the-ci-secret)) or the [setup wizard](https://forge.dashhq.org/mirror/). The alternative is a **separate CI-only identity** with a small balance, added to the repository as a **maintainer** (`dg collab add … --role maintainer`). A writer also works, but cannot publish releases, and Forge does not trust a writer's imported numbers: issues opened on the mirror then start again from a low number instead of continuing GitHub's (#7762 after #7761). The trade-off is exposure: a leaked maintainer key can also change protected branches and the repo's settings, not just mirror. Do not give CI your main identity file, because it holds your master key. See [Identity and keys](../docs/guides/identity-and-keys.md).
3. **Add repository secrets** (Settings → Secrets and variables → Actions):
   - `DASH_FORGE_KEY`: the runner key, `dfk1:<network>:<identityId>:<keyId>:<wif>`. The contents of a bridge-format identity JSON file also work.
   - For bucket storage: `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`, or `PINNING_TOKEN`.
4. **Add the workflow** as `.github/workflows/forge-mirror.yml`:

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
    timeout-minutes: 60
    permissions: { contents: read, issues: read, pull-requests: read }
    steps:
      # A release tag: installs that release's checksum-verified binaries, which run with your key.
      - uses: PastaPastaPasta/dash-forge/action@v0.1.0
        with:
          repo: dash://<owner identity id>/project
          network: devnet                # Forge's network today (the default)
          devnet-name: sakura
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

No `actions/checkout` step is needed. The Action keeps its own bare mirror of the GitHub repository and never runs code from it, so `pull_request_target` is safe here: pull requests from forks are mirrored, but none of their code runs with your secrets.

Run it once with `dry-run: 'true'` from the Actions tab (`workflow_dispatch`) to see the estimate before you spend anything.

## Inputs

| Input | Default | |
|---|---|---|
| `repo` | *(required)* | Destination: `dash://<owner>/<name>`, `<owner>/<name>`, or a bare name (the signer's own). Created if missing when the signer is the owner. |
| `network` | `devnet` | `mainnet`, `testnet` or `devnet`. The default is the network Forge is deployed on today; mainnet and testnet have no deployment yet. |
| `devnet-name` | `sakura` | The devnet's name. Used only when `network` is `devnet`. |
| `sync` | `code,releases` | Comma list of `code`, `issues`, `prs`, `releases`, `labels`. |
| `storage-kind` | `platform` | Where pack bytes go: `platform`, `s3` or `ipfs-pinning`. Refs, manifests, issues and PRs are always on Platform. |
| `s3-endpoint`, `s3-region`, `s3-bucket`, `s3-public-url`, `s3-prefix` | | S3-compatible bucket (R2, B2, S3, MinIO). `s3-public-url` is the origin browsers read packs from. See [Bring your own storage](../docs/guides/bring-your-own-storage.md). |
| `s3-virtual-hosted` | `false` | `true`: virtual-hosted addressing (`https://<bucket>.<endpoint host>/<key>`), the same as `dg storage add --virtual-hosted`. Use it for AWS S3, which deprecates path-style. |
| `pinning-endpoint` | | `ipfs-pinning`: Pinning Service API base URL. |
| `ipfs-api` | `http://127.0.0.1:5001` | `ipfs-pinning`: the kubo RPC API the job runs, for example as a service container. |
| `replicas` | `1` | Storage confirmations a push needs. The Action never falls back to Platform storage silently. |
| `cost-cap` | `0.05` | Maximum DASH one run may spend (see below). |
| `dry-run` | `false` | `true`: list, compare and estimate, and write nothing. |
| `fail-on-partial` | `false` | `true`: fail the step when some items were skipped (`status: partial`). By default that is a warning, because the next run retries them. |
| `github-repo` | `${{ github.repository }}` | The GitHub repository to mirror. |
| `version` | `0.1.0` | The Dash Forge release this Action version pins: the one it was cut with. Empty: `install: 'true'` builds from source. |
| `install` | `true` | `true`: install release `version` with [`install.sh`](../install.sh) (the step fails if that release is not published), or, with `version` empty, build from source as `source` does. `source`: build `dg`, `git-remote-dash` and `forge-import` from the Action's own source, the ref after `@` in `uses:` (needs Rust and jq, which GitHub's ubuntu runners have; protoc is installed if missing on Linux x86_64 and arm64). `false`: use the binaries already on `PATH`. |
| `build-cache` | `true` | A source build reuses its compiled dependencies from `actions/cache`, keyed by `Cargo.lock` and the toolchain. `false`: compile everything on every run. |
| `state-cache` | `true` | Keep the incremental sync state in `actions/cache`, so a run looks only at what changed on GitHub since the last one. This is only for speed: without the cache a run re-examines everything and still writes nothing that is already there. |

## Outputs

| Output | |
|---|---|
| `status` | `ok`, `partial`, `dry_run`, `cap_exceeded` or `error` (see below). |
| `spent-dash` | DASH spent by this run: the larger of what Platform charged and the drop in the identity's balance. |
| `summary-json` | Path of the full run summary (`forge-import --summary-json`): counts, estimate, spend, key budget and warnings. It is written on every exit, including errors. |

### Statuses

| `status` | `forge-import` exit code | Step result | Meaning |
|---|---|---|---|
| `ok` | 0 | succeeds | Everything was mirrored. |
| `dry_run` | 0 | succeeds | Nothing was written. If a real run would stop at the cap, a warning says so. |
| `partial` | 4 | succeeds, with a warning (fails if `fail-on-partial: 'true'`) | The run finished, but some items were skipped: the issue or PR number is already taken in the destination, the destination refused a write, or a PR head push did not fit under the cap. The summary counts them as *Skipped*. The sync state does not advance, so the next run retries them. |
| `cap_exceeded` | 3 | fails | The estimate or the spend reached `cost-cap`. |
| `error` | 1 | fails | Anything else. The error is shown as an annotation. |

## What is synced

- **Code** (`code`): every branch and tag. Force-pushes are mirrored as force-pushes. The head of each **open** pull request is stored at `refs/mirror/pull/<n>/head`, so it can be checked out.
- **Issues and pull requests** (`issues`, `prs`): title and body as of the first mirror, plus state, labels, comments and reviews. They are signed by the runner identity, and each one says which GitHub item and author it came from. State changes are recorded as events. A merged PR reads as merged once the base branch's tip on chain contains its merge commit. A run without `code` checks that by fetching the base branches' commits, and records a PR as closed when the code is not mirrored yet.
- **Releases** (`releases`): tag, title and notes. Assets are **not re-uploaded**. They are referenced by their GitHub URL and SHA-256 (GitHub's digest, or one the importer computes). A release lists at most about 16 assets. Past that, checksum files, signatures and the common platform builds are kept first, and the notes link the source release for the rest ([guide](../docs/guides/mirror-a-github-repo.md#1-first-import)).
- **Labels** (`labels`).

Not mirrored:

- edits to an issue's or PR's title or body after it was first mirrored;
- a PR retargeted to another base branch after it was first mirrored;
- later moves of a PR's head once the PR is closed: `refs/mirror/pull/<n>/head` follows the head only while the PR is open;
- reactions, milestones, assignees, projects and discussions;
- the wiki and Actions artifacts.

## Idempotency

Packs are content-addressed, and a ref is written only when its tip differs. Each issue and PR records its GitHub number, so a re-run finds the existing copy instead of making a new one. Re-running any event costs 0. The live test in this repository runs the Action twice in a row and fails unless the second run writes nothing and spends 0.

## The cost cap

`cost-cap` is enforced twice:

1. **Before writing.** The run lists what it would write and estimates the cost. If the estimate is above the cap, it stops with `status: cap_exceeded` and writes nothing.
2. **While writing.** If the actual spend reaches the cap, the run stops. What was written so far stays written, and the next run continues from there.

`forge-import` enforces the cap itself, on every write, including the `git push`es it makes for code. A capped run fails the job with `status: cap_exceeded`. A limited runner key adds a hard limit that Platform itself enforces: whatever happens, a run cannot spend more than the key's remaining budget.

## The job summary

Each run adds a table to the job summary:

| Written | |
|---|---:|
| Ref updates | 3 |
| Packs | 2 (3.00 MiB) |
| Issues | 4 |
| PRs | 1 |
| Comments | 7 |
| Reviews | 2 |
| Events | 5 |
| Releases | 1 |
| Labels | 6 |
| **Spent** | **0.025 DASH** |
| Estimate | 0.026 DASH |
| Runner key budget left | 0.45 of 0.5 DASH, expires 2027-09-24 |
| Identity balance | 0.4 DASH |

With `dry-run: 'true'` the same table says *Would write*, and its cost row is labelled *Estimated cost*. The run also adds warning annotations:

- when less than 20% of the runner key's budget is left, or the key expires within 30 days: *"Renew at forge.dashhq.org/&lt;owner&gt;/&lt;name&gt;/settings/mirror."*;
- when `DASH_FORGE_KEY` is not a limited key (it has no budget), recommending a limited runner key;
- for anything the importer flags, such as a release asset without a digest.

A `partial` run adds a *Skipped (retried next run)* row and a warning. A failed or capped run shows the error as an annotation.

## Security

- Grant the job only `contents: read, issues: read, pull-requests: read`. The Action writes to Dash Platform, never to GitHub.
- **Anyone who can open an issue, comment or send a pull request can make a run spend.** Their content is stored permanently on-chain, fork PR heads included, and you pay for it: up to `cost-cap` per event, until the runner key's budget runs out. That budget is the real limit, so keep it small and use a limited key. On a busy public repository, drop the `issues`, `issue_comment` and `pull_request_target` triggers and let the daily `schedule` run pick up the changes, or remove `issues,prs` from `sync`.
- Secrets are passed through `env:` and are never printed. A `dfk1:` key's WIF, and any secret field of an identity JSON, is masked in the log. An identity JSON is written to a `0600` file in `$RUNNER_TEMP` and deleted at the end of the job, even when the job fails.
- The storage secrets are never written to disk. The storage profile holds `env:S3_SECRET_ACCESS_KEY`-style references, which are resolved when the push runs.
- Every input is validated before anything runs, and inputs reach the scripts only as environment variables, never as text inside a script.
- The storage settings are passed to git only for the Action's own step (as git's command-scope config). The runner's `~/.gitconfig` is left unchanged.
- `install: 'true'` uses this repository's `install.sh` at the same ref as the Action. It checks the archive's sha256 against the release's `SHA256SUMS`, and checks its build provenance attestation with `gh`. A source build (`install: 'source'`, or `'true'` with no `version`) compiles the code at the ref in `uses:`, with `cargo build --locked`, so pin that ref to a commit you have reviewed. Its workspace crates are always compiled from that source. Its compiled dependencies come from the build cache, which is trusted like any other cache of your repository: a workflow there that can write the default branch's caches (for example one that runs a pull request's code) could plant one. Set `build-cache: 'false'` for a build from source alone. The protoc it may download is checked against a pinned sha256.

## Development

`bash action/test.sh` runs the offline tests (input validation, the defaults, the install choice and source build with stub tools, and summary rendering against `action/testdata/*.json`). `.github/workflows/mirror-action.yml` runs those tests together with actionlint and shellcheck on pull requests. On a weekly schedule, and on demand, it also runs a live mirror of `PastaPastaPasta/dash-faucet` into the reserved devnet fixture repository `mirror-ci-dash-faucet` ([e2e/README.md](../e2e/README.md)).
