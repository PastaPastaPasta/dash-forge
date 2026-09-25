# Dash Forge Mirror Action

Keeps a [Dash Forge](../README.md) copy of a GitHub repository up to date: branches and tags, and optionally issues, pull requests, releases and labels. The copy lives on Dash Platform, so it stays readable and clonable if the GitHub repository goes away.

Each run is **idempotent** (running it again writes nothing and costs nothing) and **capped** (it will not spend more than `cost-cap` DASH).

> **Status.** No Dash Forge release is published yet, so the default `install: 'true'` has nothing to download. Until the first release, build `dg`, `git-remote-dash` and `forge-import` from source in the job and set `install: 'false'` (see [`.github/workflows/mirror-action.yml`](../.github/workflows/mirror-action.yml)). Use `@master` until this action has a release tag; `@v1` will follow with the first release.

## Quick start

1. **Create the destination repository and an identity to sign with.** Follow [Mirror a GitHub repository](../docs/guides/mirror-a-github-repo.md) for the first import. The Action can also create the repository on its first run, when `repo` is a bare name or names the signer as the owner.
2. **Make a runner key.** The best choice is a *limited runner key*: it can spend at most its budget (0.5 DASH by default), only on Forge, and only until it expires (365 days by default). Limited keys need Platform protocol 14. Until then, use a **separate CI-only identity** with a small balance, added to the repository as a writer (`dg collab add … --role write`). Do not give CI your main identity file, because it holds your master key. See [Identity and keys](../docs/guides/identity-and-keys.md).
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
    permissions: { contents: read, issues: read, pull-requests: read }
    steps:
      - uses: PastaPastaPasta/dash-forge/action@master
        with:
          repo: dash://<owner identity id>/project
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
| `network` | `mainnet` | `mainnet`, `testnet` or `devnet`. |
| `devnet-name` | | Required when `network` is `devnet`. |
| `sync` | `code,releases` | Comma list of `code`, `issues`, `prs`, `releases`, `labels`. |
| `storage-kind` | `platform` | Where pack bytes go: `platform`, `s3` or `ipfs-pinning`. Refs, manifests, issues and PRs are always on Platform. |
| `s3-endpoint`, `s3-region`, `s3-bucket`, `s3-public-url`, `s3-prefix` | | S3-compatible bucket (R2, B2, S3, MinIO). `s3-public-url` is the origin browsers read packs from. See [Bring your own storage](../docs/guides/bring-your-own-storage.md). |
| `pinning-endpoint` | | `ipfs-pinning`: Pinning Service API base URL. |
| `ipfs-api` | `http://127.0.0.1:5001` | `ipfs-pinning`: the kubo RPC API the job runs, for example as a service container. |
| `replicas` | `1` | Storage confirmations a push needs. The Action never falls back to Platform storage silently. |
| `cost-cap` | `0.05` | Maximum DASH one run may spend (see below). |
| `dry-run` | `false` | `true`: list, compare and estimate, and write nothing. |
| `github-repo` | `${{ github.repository }}` | The GitHub repository to mirror. |
| `version` | `0.1.0` | The Dash Forge release this Action version pins. |
| `install` | `true` | `false`: use `dg`, `git-remote-dash` and `forge-import` already on `PATH`. |
| `state-cache` | `true` | Keep the incremental sync state in `actions/cache`, so a run looks only at what changed on GitHub since the last one. This is only for speed: without the cache a run re-examines everything and still writes nothing that is already there. |

## Outputs

| Output | |
|---|---|
| `status` | `ok`, `dry_run`, `cap_exceeded` or `error`. |
| `spent-dash` | DASH charged by this run. |
| `summary-json` | Path of the full run summary (`forge-import --summary-json`): counts, estimate, spend, key budget and warnings. |

## What is synced

- **Code** (`code`): every branch and tag. Force-pushes are mirrored as force-pushes. The head of each pull request is stored at `refs/mirror/pull/<n>/head`, so it can be checked out.
- **Issues and pull requests** (`issues`, `prs`): title, body, state, labels, comments and reviews. They are signed by the runner identity, and each one says which GitHub item and author it came from. State changes are recorded as events.
- **Releases** (`releases`): tag, title and notes. Assets are **not re-uploaded**. They are referenced by their GitHub URL, together with their sha256 when GitHub reports a digest.
- **Labels** (`labels`).

Not synced yet: edits to an issue or PR **body** after its first import. Later runs pick up state, labels and new comments and reviews only. Wiki, projects, discussions and Actions artifacts are not synced.

## Idempotency

Packs are content-addressed, and a ref is written only when its tip differs. Each issue and PR records its GitHub number, so a re-run finds the existing copy instead of making a new one. Re-running any event costs 0. The live test in this repository runs the Action twice in a row and fails unless the second run writes nothing and spends 0.

## The cost cap

`cost-cap` is enforced twice:

1. **Before writing.** The run lists what it would write and estimates the cost. If the estimate is above the cap, it stops with `status: cap_exceeded` and writes nothing.
2. **While writing.** If the actual spend reaches the cap, the run stops. What was written so far stays written, and the next run continues from there.

Each `git push` inside the run has the same limit (`dash.costWarnThreshold`), and in CI a push over it is refused rather than prompted. A limited runner key adds a hard limit that Platform itself enforces: whatever happens, a run cannot spend more than the key's remaining budget.

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
| **Platform charged** | **0.025 DASH** |
| Estimate | 0.026 DASH |
| Runner key budget left | 0.45 of 0.5 DASH, expires 2027-09-24 |
| Identity balance | 0.4 DASH |

With `dry-run: 'true'` the same table says *Would write*, and its cost row is labelled *Estimated cost*. The run also adds warning annotations:

- when less than 20% of the runner key's budget is left, or the key expires within 30 days: *"Renew at forge.dashhq.org/&lt;owner&gt;/&lt;name&gt;/settings/mirror."*;
- when `DASH_FORGE_KEY` is not a limited key (it has no budget), recommending a limited runner key;
- for anything the importer flags, such as a release asset without a digest.

A failed or capped run shows the error as an annotation.

## Security

- Grant the job only `contents: read, issues: read, pull-requests: read`. The Action writes to Dash Platform, never to GitHub.
- **Anyone who can open an issue, comment or send a pull request can make a run spend.** Their content is stored permanently on-chain, fork PR heads included, and you pay for it: up to `cost-cap` per event, until the runner key's budget runs out. That budget is the real limit, so keep it small and use a limited key. On a busy public repository, drop the `issues`, `issue_comment` and `pull_request_target` triggers and let the daily `schedule` run pick up the changes, or remove `issues,prs` from `sync`.
- Secrets are passed through `env:` and are never printed. A `dfk1:` key's WIF, and any secret field of an identity JSON, is masked in the log. An identity JSON is written to a `0600` file in `$RUNNER_TEMP` and deleted at the end of the job, even when the job fails.
- The storage secrets are never written to disk. The storage profile holds `env:S3_SECRET_ACCESS_KEY`-style references, which are resolved when the push runs.
- Every input is validated before anything runs, and inputs reach the scripts only as environment variables, never as text inside a script.
- The storage and cost settings are passed to git only for the Action's own step (as git's command-scope config). The runner's `~/.gitconfig` is left unchanged.
- `install: 'true'` uses this repository's `install.sh` at the same ref as the Action. It checks the archive's sha256 against the release's `SHA256SUMS`, and checks its build provenance attestation with `gh`.

## Development

`bash action/test.sh` runs the offline tests (input validation, and summary rendering against `action/testdata/*.json`). `.github/workflows/mirror-action.yml` runs those tests together with actionlint and shellcheck on pull requests. On a weekly schedule, and on demand, it also runs a live mirror of `PastaPastaPasta/dash-faucet` into the reserved devnet fixture repository `mirror-ci-dash-faucet` ([e2e/README.md](../e2e/README.md)).
