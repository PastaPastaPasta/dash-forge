# Dash Forge check action

Reports a GitHub Actions job's result as a [Dash Forge](../README.md) check run on the same commit of the repository's Forge copy, so the Forge commit page, pull request Checks tab and merge box show what GitHub's CI said.

- **The commit is the same.** A Forge mirror (the [Mirror Action](../action/README.md), or `forge-import`) is the same git history, byte for byte, so GitHub's commit id is the Forge commit id. For a `pull_request` run the action reports on the pull request's head commit, not the merge commit GitHub builds, which exists in no mirror.
- **It signs with a runner key.** A key from `dg ci runner new` can write check runs and nothing else ([CI and check runs](../docs/guides/ci.md)).
- **It never fails your CI by default.** If the report cannot be written, the step warns and passes; `fail-on-error: 'true'` changes that.

## Quick start

1. **A runner identity and key.** On your own computer, not in CI, create an identity for CI, with a small deposit because it pays for its own reports, then enrol it as the repository's owner. `dg auth new` makes the new identity this computer's default, so sign back in as the owner, or pass `--identity`:

   ```sh
   dg auth new --backup-file runner.json                              # the runner identity
   dg auth login ~/owner.identity.json                                # back to the owner
   dg ci runner new alice/project --runner runner.json -o runner.dfk1
   ```

   In a terminal, `dg auth new` shows the runner's 12 recovery words once and asks for three of them back; `runner.json` gets a passphrase-sealed copy too. Scripted (no terminal), it never prints the words: they go only to `runner.json`, sealed under `DASH_FORGE_PASSPHRASE`, and it refuses to run without `--backup-file`. `--skip-backup-check` only skips the three-word check (and needs `--backup-file`).

   Add the contents of `runner.dfk1` as a GitHub secret named `FORGE_RUNNER_KEY`, then delete the file. Keep `runner.json` (it holds the runner's master key and words) somewhere safe, not in CI. See [CI and check runs](../docs/guides/ci.md#enrol-a-runner).

2. **Report each job.** Add the action as the last step, with `if: always()` so failures are reported too.

> **No Dash Forge release is published yet**, so this action pins none (`version` is empty), and the default `install: 'true'` builds `dg` from the action's own source: the ref after `@` in `uses:`. This works on **Linux runners only** (it needs Rust and jq, which GitHub's ubuntu runners have; protoc is installed if missing on x86_64 and arm64): on macOS or Windows the step warns and reports nothing, or fails with `fail-on-error`. It also costs time in every job that reports: the first build takes several minutes, and even with a warm build cache each job recompiles Dash Forge's own crates, a few minutes more. So report from one Linux leg of a matrix, or from one summary job that `needs:` the others, rather than from every job. A pinned commit keeps building from source after a release is published: only an action version that sets `version` downloads one. Pin a commit you have reviewed, since the key is handed to the `dg` it builds.

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: cargo test
      - name: Report to Dash Forge
        if: always()
        uses: PastaPastaPasta/dash-forge/check-action@master   # better: @<a commit you reviewed>
        with:
          repo: <owner identity id>/project     # or dash://<owner>/project
          job-status: ${{ job.status }}
          network: devnet                       # Forge's network today (the default)
          devnet-name: bonsia
        env:
          DASH_FORGE_KEY: ${{ secrets.FORGE_RUNNER_KEY }}
```

**The check's name.** By default it is `<workflow> / <job>`, as GitHub shows it; `name:` changes it. A matrix leg gets its matrix values in parentheses, `CI / test (ubuntu-latest, 1.80)`, and its own run id, so the legs of one job are separate checks rather than overwriting each other. Give each leg a distinct `name:` if you set one yourself.

The check run's details link goes back to this GitHub run. Its summary names the workflow, job, run number and attempt.

Optionally, report `in_progress` at the start of a long job with an early step that has `status: in_progress`. The completed report then updates that same check run: both reports carry the same run id, `gh:<run id>:<attempt>:<job>:<name>`.

## Inputs

| Input | Default | |
|---|---|---|
| `repo` | *(required)* | The Forge repository: `<owner>/<name>` or `dash://<owner>/<name>`. |
| `name` | `<workflow> / <job>` (plus a matrix leg's values) | The check's name on Forge. |
| `status` | `completed` | `queued`, `in_progress` or `completed`. |
| `job-status` | | Pass `${{ job.status }}`: `success`, `failure` or `cancelled` become the conclusion. |
| `conclusion` | from `job-status` | Or set it: `success`, `failure`, `neutral`, `cancelled`, `skipped`, `timed_out`, `action_required`, `stale`. |
| `sha` | the PR head, else `github.sha` | The commit to report on. |
| `summary` | workflow / job / run | One line. Longer ones are cut to 500 characters (the contract allows 1000 characters and 2000 bytes). |
| `details-url` | this GitHub run | An https link back (a host, no `user:password@`, no spaces). A GitHub Enterprise Server on plain http gets no default link. |
| `log` | | A file to upload as the run's log. It needs `log-storage`. |
| `log-storage` | | The storage profile the log goes to. The job must provide it: a `storage.toml` under `$XDG_CONFIG_HOME/dash-forge/` naming a bucket, with the bucket's credentials in the job's environment (see [Bring your own storage](../docs/guides/bring-your-own-storage.md)). |
| `public-log` | `false` | No longer has any effect (it warns): a private repository's check run cannot carry a log. |
| `network` / `devnet-name` | `devnet` / `bonsia` | Which network the Forge repository is on. The default is the devnet the hosted site uses; Forge has no mainnet or testnet deployment yet. `devnet-name` (lowercase letters, digits, `-`) is used only with `network: devnet`. |
| `version` | *(empty)* | The Dash Forge release to install. Empty until the first release: `install: 'true'` then builds from source. |
| `install` | `true` | `true`: install release `version` (the step warns, or fails with `fail-on-error`, if it is not published), or, with `version` empty, build `dg` from the action's own source. `source`: always build from source. `false`: use a `dg` already on `PATH`. A second use of the action in the same job reuses the installed `dg`. |
| `build-cache` | `true` | A source build reuses its compiled dependencies from `actions/cache`, which is trusted like any other cache of your repository: a workflow there that can write the default branch's caches (one that runs a pull request's code, say) could plant one. `false`: compile everything on every run. |
| `fail-on-error` | `false` | `true`: fail the step when `dg` cannot be installed or the report cannot be written. |

## Outputs

`document-id`, `sha` (the commit reported on: the PR head for pull request runs), `name` (the check's name), `url` (the Forge commit page), `action` (`created`, `updated` or `unchanged`; empty when nothing was written) and `dg` (the `dg` the action installed or built, for later steps; empty with `install: 'false'`).

## Security

- **The key.** `DASH_FORGE_KEY` is read by `dg` from the environment. It never goes on a command line, and the tests check that.
- **Inputs are data.** Every input reaches the scripts as an environment variable, never as shell text. Every `dg` argument is passed as `--flag=value`, so a value such as a summary of `--public-log` stays a value. A newline in any value is refused. Messages are escaped before they go into a workflow command, so a value cannot start another command.
- **Pull requests from forks.** A fork's `pull_request` run has no access to your secrets, so it cannot report; the step warns and passes. Do not use `pull_request_target` to give it the key: that would run the fork's code with your secret.
- **What is public.** A check run is public on chain: its name, summary, details link and log URL. On a private repository Forge refuses a run with a summary, details link, log or run id, so `dg` leaves them out (with a warning) and records only the name, status and conclusion; the log is not uploaded. The name stays public.

## Test it

- `bash check-action/test.sh` runs offline against a fake `dg`. It checks the arguments built from each input and the environment, the refusals, the outputs, the step summary, warn-or-fail, and that the key stays off the command line.
- The `Check Action` workflow (`.github/workflows/check-action.yml`) also reports its own job to a Forge repository on a devnet. That live job is **skipped** until the repository has a `FORGE_CI_RUNNER_KEY` secret and the `FORGE_CHECK_REPO` and `FORGE_CHECK_DEVNET` variables (for example `bonsia`). These need the owner's approval (`SECRETS-TODO.md`).
- To run the same flow on your machine against a repository you own, set a simulated GitHub environment and run the two scripts. With a runner key in `DASH_FORGE_KEY`:

```sh
export RUNNER_TEMP=$(mktemp -d) GITHUB_OUTPUT=/dev/stdout GITHUB_RUN_ID=1 GITHUB_JOB=local \
       GITHUB_SERVER_URL=https://github.com GITHUB_REPOSITORY=me/app GITHUB_SHA=<commit>
INPUT_REPO=<owner>/<repo> INPUT_NAME=local-check INPUT_JOB_STATUS=success INPUT_NETWORK=devnet INPUT_DEVNET_NAME=bonsia \
  bash check-action/resolve.sh > /tmp/o && FORGE_ARGS_FILE=$(sed -n 's/^args-file=//p' /tmp/o) \
  bash check-action/report.sh
```
