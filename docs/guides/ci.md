# CI and check runs

Forge has no CI service of its own. Any CI can report results on Forge: GitHub Actions, GitLab CI, a shell script on your laptop, or a runner you host. It writes **check runs**, small on-chain documents that say "check `build` on commit `5950173` passed", and the web app and `dg` show them on the commit page, on a pull request's Checks tab and in the merge box.

Every check run is signed by an identity the repository trusts. Nothing is trusted because of where it came from:

- **Consensus checks the writer.** Platform accepts a `checkRun` only from a current **runner**, **maintainer** or **writer** of the repository. It refuses anyone else's with code 40120.
- **Readers check again.** A run counts only while its reporter still holds that role. Revoke a runner, and its runs are still listed but no longer count ("reporter is no longer a member or runner: not counted").
- **A runner key can sign nothing else.** `dg ci runner new` registers a key bound to the `checkRun` document type, with a budget and an expiry. If it leaks, it can only post check runs, only to repositories where its identity is a runner, and only until the budget or the expiry ends.

The design is in [platform-parity-spec §2](../design/platform-parity-spec.md#2-ci--actions-design).

## Enrol a runner

A runner is an identity of its own. Mint one for CI with `dg auth new --backup-file runner.json` and a small deposit, since it pays for its own reports. `dg auth new` makes the new identity this computer's default, so sign back in as the repository owner (`dg auth login <your identity file>`), or pass `--identity` for the next command. Then, as the owner:

```sh
dg ci runner new alice/project --runner runner.json -o runner.dfk1 \
    --identity ~/owner.identity.json      # only if you did not sign back in as the owner
```

This does two things:

1. **Registers a key on the runner identity**, signed once with the runner's master key from `runner.json`. The key is AUTHENTICATION / HIGH, bound to `(forge-collab, checkRun)`, with a 0.5 DASH budget and a 365-day expiry (`--budget`, `--expires` change them).
2. **Enrols the identity as a runner** of `alice/project`: a forge-core `runner` document that only the owner can write.

The key is written to `runner.dfk1` (0600, unencrypted) *before* it is registered, so a key that nobody holds is never registered. Put the file's contents in your CI's secret store as `DASH_FORGE_KEY`, then delete the file.

Other commands:

| Command | Does |
|---|---|
| `dg ci runner add <repo> <identity>` | enrols an identity that already has a key (one you keyed yourself); `<identity>` is an id or a DPNS name |
| `dg ci runner list <repo>` | lists the repository's runners |
| `dg ci runner revoke <repo> <identity>` | deletes the membership; the runner's next report is refused at consensus, and its old runs stop counting |

Without `--runner`, `dg ci runner new` puts the key on your own identity (it asks for your master key once). As the owner you are a maintainer, so no enrolment is needed. That suits a single-developer setup, but it gives up the separate identity.

## Report a check run

```sh
export DASH_FORGE_KEY="$(cat runner.dfk1)"   # in CI: from the secret store
SHA=$(git rev-parse HEAD)
dg ci report alice/project --sha "$SHA" --name build --status queued \
    --details-url "https://ci.example/runs/42"
dg ci report alice/project --sha "$SHA" --name build --status in_progress
dg ci report alice/project --sha "$SHA" --name build --status completed \
    --conclusion success --summary "412 tests passed" --log build.log --storage my-r2
```

- **The network comes with the key.** A `dfk1:` key records its network (`dfk1:devnet-bonsia:…`), and `dg` uses it when nothing else names one, so a fresh CI machine needs no `--network` flags. In a checkout of a `dash://` clone, the network the clone pinned wins; `DASH_FORGE_NETWORK` takes the same `devnet-<name>` form `dg` prints.
- **The first report creates the run; the next ones update it in place.** An update is a replace of your own open run with that name on that commit. Once a run is `completed`, reporting the same name again starts a new run (a re-run).
- **`--external-id <your CI's run id>`** ties reports to one run: a report always updates the run carrying that id, even after it completed, and never starts a second one for it. If no run carries the id yet, `dg` reads once more a few seconds later before it creates one, so a report sent right after the first does not split the run. Use it whenever your CI has a run id (the GitHub Action passes `gh:<run id>:<attempt>:<job>:<name>`).
- **What an update keeps.** A field the report does not give keeps its stored value. The exceptions: `completedAt` is cleared unless the run is `completed`; a re-queued run (`--status queued`) also clears its start time and its log; and the start time, once set, does not move on a repeated `in_progress` report.
- **`--status`** is `queued`, `in_progress` or `completed`. A completed run needs a `--conclusion`: `success`, `failure`, `neutral`, `cancelled`, `skipped`, `timed_out`, `action_required` or `stale` (GitHub's set). `dg` refuses a wrong combination before it signs anything, and so does the contract.
- **`--log <file>`** uploads the log to your storage profile (after you confirm the report). It is content-addressed, the same way a release asset is (see [Bring your own storage](bring-your-own-storage.md)), and the run records the log's URL and SHA-256. The web app downloads the log from your bucket and shows it only if its bytes hash to the recorded SHA-256; otherwise it says the bytes are not the reported log. Log bytes never go on Platform. The bucket needs CORS for the web app's origin, like any bucket the browser reads.
- **`--artifact <file>`** (repeatable, at most 10) uploads a file the run produced to the same storage, content-addressed, and records it in the run's `artifacts`: its name, size, SHA-256 and URL, in the shape of a release's assets. The field holds 4,096 bytes, about a dozen entries; one that does not fit is uploaded but not recorded, with a warning. The web app lists them on the Checks tab and saves one only if its bytes hash to the recorded SHA-256, as it does a release asset. Archive a directory into one file first (forge-runner zips each `actions/upload-artifact` artifact).
- **`--summary`** (or `--summary-file`) takes up to 1,000 characters.
- `dg` prints the commit's web page, where the run shows up.

`dg ci status alice/project <sha>` lists one run per name on a commit: the newest run by a current member or runner, which is the one a merge counts. A newer run by anyone else is not shown in its place. `dg pr checks alice/project <n>` does the same for a pull request's head.

For each name, the newest run by `($createdAt, $id)` among runs by current members and runners decides. A branch policy with `requireChecks` needs every such run on the head to pass (`success`, `neutral` or `skipped`), and at least one to exist; a policy that names required checks needs each named one to pass, `requireChecks` or not. The web merge box and `dg pr merge` apply the same rule; a maintainer can bypass it ("bypass rules" in the web, `--override-policy` in `dg`), and the bypass is recorded on the PR.

## What it costs

Measured on devnet bonsia (2026-09-30, drive 4.2.0-beta.7; 1 DASH = 10¹¹ credits):

| Write | Who pays | Credits | DASH |
|---|---|---|---|
| Register the runner key (identity update) | the runner | 43,008,000 | 0.00043 |
| Enrol the runner (`runner` document) | the owner | 47,298,000 | 0.00047 |
| First report of a run (`checkRun` create) | the reporter | 81,508,000 – 95,093,000; a repository's first 121,929,000 | 0.00082 – 0.00095; the first 0.00122 |
| Each later update (replace) | the reporter | 4,651,000 – 5,546,420 | ≈ 0.00005 |

The create's price depends on the fields it carries (a details URL, a summary, artifacts, a log's URL and hash), and a repository's first check run pays more: it opens the check-run indexes. A typical run is one create plus two updates, about **0.001 DASH**, so a 0.5 DASH runner key covers roughly 500 runs. The log itself costs nothing on Platform: it goes to your bucket. On devnet moutai (drive 4.2.0-beta.6, 2026-09-29) the same writes cost less: the key 0.000285, the enrolment 0.000458, a create 0.00055–0.00078 (0.00059 with `--log`) and an update ≈ 0.000035 DASH.

Before it signs, `dg` shows an upper bound over these numbers: 0.0005 DASH for the key, 0.00055 for the enrolment, 0.0013 for a create and 0.00008 for an update, plus 27,700 credits (0.000000277 DASH) per byte of the text the report carries (name, details URL, summary, external id, artifacts; a log adds its URL and hash). The contract admits up to ~7 KB of that text, so a report with a full summary, artifacts and a log is quoted up to ~0.002 DASH more. It reads the commit's runs first, so the prompt names the write that will happen (create or update). After the write it prints what was actually charged.

## Security

- **Keys.** Give CI a runner key, never your identity file: the file holds your master key. The runner key's bounds are enforced by consensus. Anything else it signs is refused with `ContractBoundedKeyOutOfBoundsError` (20014), which `dg` reports as [E302](../errors.md#e302) before anything is broadcast. The key cannot register keys, move credits or write any other document type. The budget and the expiry cap the damage from a leak. `DASH_FORGE_KEY=runner.json dg auth keys disable <id> --master runner.json` retires the key early (it signs as the runner identity, whose key it is), and `dg ci runner revoke` removes the identity's standing on the repo.
- **What a runner can do.** It can write check runs on *any* commit id of the repositories it runs for, including commits that are not in the repository. Readers match runs to commits by id, so a run on a stranger's commit shows nowhere. A runner cannot edit or delete another identity's run.
- **What is public.** Check runs are plaintext on chain: name, status, summary, details URL, log URL. See [private-repos §7](../security/private-repos.md#7-metadata-that-stays-visible). Do not put secrets or private code in summaries.
- **Check runs of a private repository.** forge-community refuses a private repository's run that carries a summary, details URL, log, artifacts or external id. `dg ci report` leaves them out with a warning and records only the name, status, conclusion and times; `--log` and `--artifact` files are not uploaded, and `--public-log` no longer does anything. Without an external id, a report updates your open run of the same name on that commit, so two jobs that report the same name on the same commit at once (a push and a pull request run, or two branches) share one run: give them different names. The check's name stays public, so do not put secrets in it.
- **URLs.** `--details-url` must be `https://` (an IP host is accepted, unlike a webhook URL — see [Webhooks and CI](collaborating.md#webhooks-and-ci)). A log's storage must record an https address (an S3 bucket's https `public_url`) or an `ipfs://` one: `dg` refuses a plain-http or private bucket before uploading.
- **A home-NAS or self-hosted log server needs TLS before you can use `--log` at all.** `dg ci report --log` checks the storage profile's `public_url` first and refuses, before uploading anything, if none of the profile's targets record an https or `ipfs://` address ("the log's storage gives no https or IPFS address"). If your storage is a self-hosted MinIO, a NAS's built-in S3 endpoint, or anything else on your own network (see [Bring your own storage](bring-your-own-storage.md) and the [home-NAS storage guide](home-nas-storage.md)), put a real TLS terminator in front of it on a domain you control — a named Cloudflare Tunnel, or a reverse proxy such as [Caddy](https://caddyserver.com/) — and only then run `dg storage add … --public-url https://…` (or edit an existing profile) to record that https address. A Tailscale-only name doesn't help here: it isn't reachable by a browser outside your tailnet, so a log linked from a public check run would not load for anyone else, the same reason it is refused for pack storage ([Public addresses](bring-your-own-storage.md#public-addresses)). Claiming an https `public_url` for a bucket that is actually still serving plain http breaks the same way: the web app fetches the literal recorded URL, and every reader's browser refuses that fetch, not just yours.
- **Reading a log in the browser.** The web app fetches a log only over https (plain http only from a page served on the same machine, for local tests), without cookies or a referrer, gives up after 30 seconds, and stops reading at 32 MiB.
- **Verifying a log or an artifact.** The SHA-256 on chain pins the bytes. Whoever controls the bucket can delete a log or an artifact, but cannot swap it for another without the web app noticing. Artifacts are as public as logs: anyone can download them from the bucket.

## Limits of the current contract

These are what the protocol and the current forge-collab contract allow. They are verified against Platform v4.2.0-beta.6.

- **A key can be bound to `checkRun` only.** Protocol 14 admits `SingleContractDocumentType` bounds on AUTHENTICATION keys (`validate_identity_public_key_contract_bounds` v2), and consensus enforces them per batch member (`ContractBounds::check_batched_transition`).
- **The contract does not say *which* identity may report, beyond "runner, maintainer or writer".** It cannot require that only runners write `checkRun`, and it has no status-transition rule, such as "no `queued` after `completed`". The one rule it has is that a conclusion is present exactly when the status is `completed`. Clients follow the newest-run rule. [ci-contract-wishes.md](../design/ci-contract-wishes.md) lists what the next registration should add.
- **A check run is not tied to a pushed commit.** Consensus cannot check that `headOid` exists in the repository: packs live off-chain.

## Self-host a runner

[`forge-runner`](self-host-runner.md) watches a repository, runs `.forge/workflows/*.yml` (GitHub Actions syntax) with [nektos/act](https://github.com/nektos/act) in Docker on every push and pull request, and reports each job through `dg ci report` with its log. It polls; [your own relay can wake it](self-host-runner.md#wake-it-from-your-relay) within seconds of a push.

**The security boundary is the Docker daemon you give the runner.** Give it a daemon of its own: rootless, sysbox, or a Docker-in-Docker sidecar over TLS. Never the host's socket. On top of that, the runner:

- **Refuses workflow options that reach past the container.** A job that sets docker options or mounts (`container.options` / `volumes`, the same on `services`), or calls a reusable workflow, is refused unless the repository allows it.
- **Keeps the daemon's socket out of jobs,** and puts jobs on the `bridge` network, not the host's.
- **Hands secrets and a `GITHUB_TOKEN` to trusted refs only.** Other runs get an empty token, and secret values are redacted from logs before upload.
- **Clears act's environment,** so `DASH_FORGE_KEY` never reaches act or a job, and ignores act configuration planted in the checkout.
- **Follows GitHub's fork-PR model:** a pull request runs with the secrets only when its head is a trusted branch of the repository itself and its author the owner or a maintainer; a fork's or a non-member's PR runs with no secrets and an empty token, and by default a non-member's PR does not run at all ([Pull requests](self-host-runner.md#pull-requests)).

[Self-host a CI runner](self-host-runner.md#security) has the details.

## Report from GitHub Actions

A repository mirrored from GitHub keeps its CI on GitHub. The [check action](../../check-action/README.md) reports each GitHub job's result as a Forge check run on the same commit (a mirror is the same git history, so the commit ids match; a pull request run reports on the PR head):

```yaml
      - name: Report to Dash Forge
        if: always()
        uses: PastaPastaPasta/dash-forge/check-action@master
        with:
          repo: <owner identity id>/project
          job-status: ${{ job.status }}
          network: devnet           # Forge runs on a devnet today
          devnet-name: <devnet name>
          install: 'false'          # until a release exists; build dg in an earlier step
        env:
          DASH_FORGE_KEY: ${{ secrets.FORGE_RUNNER_KEY }}      # from `dg ci runner new`
```

No Dash Forge release is published yet, so the step needs `dg` built earlier in the job: the [check action's README](../../check-action/README.md#quick-start) has the build steps. The check is named `<workflow> / <job>`, and each matrix leg is its own check. The check run's details link goes back to the GitHub run. A failed report warns and passes by default, so a Forge outage never fails your CI. A pull request from a fork has no access to the secret and does not report: do not use `pull_request_target` to give it one.
