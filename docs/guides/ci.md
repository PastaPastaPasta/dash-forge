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
| `dg ci runner add <repo> <identity>` | enrols an identity that already has a key (one you keyed yourself) |
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

- **The first report creates the run; the next ones update it in place.** An update is a replace of your own open run with that name on that commit. Once a run is `completed`, reporting the same name again starts a new run (a re-run).
- **`--external-id <your CI's run id>`** ties reports to one run: a report always updates the run carrying that id, even after it completed, and never starts a second one for it. If no run carries the id yet, `dg` reads once more a few seconds later before it creates one, so a report sent right after the first does not split the run. Use it whenever your CI has a run id (the GitHub Action passes `gh:<run id>:<attempt>:<job>:<name>`).
- **What an update keeps.** A field the report does not give keeps its stored value. The exceptions: `completedAt` is cleared unless the run is `completed`; a re-queued run (`--status queued`) also clears its start time and its log; and the start time, once set, does not move on a repeated `in_progress` report.
- **`--status`** is `queued`, `in_progress` or `completed`. A completed run needs a `--conclusion`: `success`, `failure`, `neutral`, `cancelled`, `skipped`, `timed_out`, `action_required` or `stale` (GitHub's set). `dg` refuses a wrong combination before it signs anything, and so does the contract.
- **`--log <file>`** uploads the log to your storage profile (after you confirm the report). It is content-addressed, the same way a release asset is (see [Bring your own storage](bring-your-own-storage.md)), and the run records the log's URL and SHA-256. The web app downloads the log from your bucket and shows it only if its bytes hash to the recorded SHA-256; otherwise it says the bytes are not the reported log. Log bytes never go on Platform. The bucket needs CORS for the web app's origin, like any bucket the browser reads.
- **`--summary`** (or `--summary-file`) takes up to 1,000 characters.
- `dg` prints the commit's web page, where the run shows up.

`dg ci status alice/project <sha>` lists one run per name on a commit: the newest run by a current member or runner, which is the one a merge counts. A newer run by anyone else is not shown in its place. `dg pr checks alice/project <n>` does the same for a pull request's head.

For each name, the newest run by `($createdAt, $id)` among runs by current members and runners decides. A branch policy with `requireChecks` needs every such run on the head to pass (`success`, `neutral` or `skipped`), and at least one to exist. The web merge box and `dg pr merge` apply the same rule; a maintainer can override it (`--override-policy`).

## What it costs

Measured on devnet moutai (2026-09-29, drive 4.2.0-beta.6; 1 DASH = 10¹¹ credits):

| Write | Who pays | Credits | DASH |
|---|---|---|---|
| Register the runner key (identity update) | the runner | 28,519,540 | 0.000285 |
| Enrol the runner (`runner` document) | the owner | 45,820,360 | 0.000458 |
| First report of a run (`checkRun` create) | the reporter | 55,036,900 – 78,132,420 | 0.00055 – 0.00078 |
| Each later update (replace) | the reporter | 3,338,780 – 3,687,280 | ≈ 0.000035 |
| First report with `--log` (adds the log URL and hash) | the reporter | 59,100,320 | 0.00059 |

The create's price depends on the fields it carries; a report with a details URL and a summary sits at the top of the range. A typical run is one create plus two updates, about **0.00063 DASH**, so a 0.5 DASH runner key covers roughly 790 runs. The log itself costs nothing on Platform: it goes to your bucket.

Before it signs, `dg` shows an estimate a little above these numbers: 0.00035 DASH for the key, 0.00055 for the enrolment, 0.00085 for a create and 0.00005 for an update. It reads the commit's runs first, so the prompt names the write that will happen (create or update). After the write it prints what was actually charged.

## Security

- **Keys.** Give CI a runner key, never your identity file: the file holds your master key. The runner key's bounds are enforced by consensus. Anything else it signs is refused with `ContractBoundedKeyOutOfBoundsError` (20014), which `dg` reports as [E302](../errors.md#e302) before anything is broadcast. The key cannot register keys, move credits or write any other document type. The budget and the expiry cap the damage from a leak. `DASH_FORGE_KEY=runner.json dg auth keys disable <id> --master runner.json` retires the key early (it signs as the runner identity, whose key it is), and `dg ci runner revoke` removes the identity's standing on the repo.
- **What a runner can do.** It can write check runs on *any* commit id of the repositories it runs for, including commits that are not in the repository. Readers match runs to commits by id, so a run on a stranger's commit shows nowhere. A runner cannot edit or delete another identity's run.
- **What is public.** Check runs are plaintext on chain, even for a private repository: name, status, summary, details URL, log URL. See [private-repos §7](../security/private-repos.md#7-metadata-that-stays-visible). Do not put secrets or private code in summaries.
- **Logs of a private repository.** A log is uploaded unencrypted and its URL is public on chain, so on a private repository `dg ci report --log` is refused ([E207](../errors.md#e207)) unless you pass `--public-log`, and then `dg` warns. Keep private build output out of the log, or leave `--log` out and link a log your CI keeps private with `--details-url`.
- **Reading a log in the browser.** The web app fetches a log only over https (plain http only from a page served on the same machine, for local tests), without cookies or a referrer, gives up after 30 seconds, and stops reading at 32 MiB.
- **Verifying a log.** The SHA-256 on chain pins the bytes. Whoever controls the bucket can delete a log, but cannot swap it for another without the web app noticing.

## Limits of the current contract

These are what the protocol and the current forge-collab contract allow. They are verified against Platform v4.2.0-beta.6.

- **A key can be bound to `checkRun` only.** Protocol 14 admits `SingleContractDocumentType` bounds on AUTHENTICATION keys (`validate_identity_public_key_contract_bounds` v2), and consensus enforces them per batch member (`ContractBounds::check_batched_transition`).
- **The contract does not say *which* identity may report, beyond "runner, maintainer or writer".** It cannot require that only runners write `checkRun`, and it has no status-transition rule, such as "no `queued` after `completed`". The one rule it has is that a conclusion is present exactly when the status is `completed`. Clients follow the newest-run rule. [ci-contract-wishes.md](../design/ci-contract-wishes.md) lists what the next registration should add.
- **A check run is not tied to a pushed commit.** Consensus cannot check that `headOid` exists in the repository: packs live off-chain.

## Self-host a runner

[`forge-runner`](self-host-runner.md) watches a repository, runs `.forge/workflows/*.yml` (GitHub Actions syntax) with [nektos/act](https://github.com/nektos/act) in Docker on every push, and reports each job through `dg ci report` with its log.

**The security boundary is the Docker daemon you give the runner.** Give it a daemon of its own: rootless, sysbox, or a Docker-in-Docker sidecar over TLS. Never the host's socket. On top of that, the runner:

- **Refuses workflow options that reach past the container.** A job that sets docker options or mounts (`container.options` / `volumes`, the same on `services`), or calls a reusable workflow, is refused unless the repository allows it.
- **Keeps the daemon's socket out of jobs,** and puts jobs on the `bridge` network, not the host's.
- **Hands secrets and a `GITHUB_TOKEN` to trusted refs only.** Other runs get an empty token, and secret values are redacted from logs before upload.
- **Clears act's environment,** so `DASH_FORGE_KEY` never reaches act or a job, and ignores act configuration planted in the checkout.
- **Never runs a fork's pull request:** it runs pushes to the watched repository's own refs only.

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
