# Self-host a CI runner (forge-runner)

`forge-runner` runs a Forge repository's workflows on your own machine and reports the results as Forge check runs. It is a small wrapper around [nektos/act](https://github.com/nektos/act), which runs GitHub Actions workflows locally in Docker. Forge runs no CI service: you run the runner, and it signs its reports with a runner key that can do nothing but write check runs (see [CI and check runs](ci.md)).

**Read [Security](#security) before you point it at a repository.** The runner executes code that whoever can push to the repository wrote. It keeps several doors shut, but the wall between a job and your machine is the Docker daemon you give it, not the runner.

## What it does

On every poll (every `interval_secs`, default 120 s, and within seconds of a push when [your relay wakes it](#wake-it-from-your-relay)), for each repository:

1. **Lists the refs.** It runs `git ls-remote dash://<owner>/<repo>`; `git-remote-dash` reads the refs from Platform proofs. The first poll only records where each ref is: the runner reports pushes made while it watches, not the repository's history.
2. **Checks out each ref that moved and matches `refs`.** It fetches the commit into a per-repository cache, then clones that cache into a fresh directory for this run.
3. **Reads the workflows before act does.** It reads every `*.yml` / `*.yaml` directly in `.forge/workflows`:
   - A file that is not valid YAML becomes one failed check, named after the file, with the reason.
   - A workflow runs only if its `on:` includes `push` and its `on.push` filters (`branches`, `branches-ignore`, `tags`, `tags-ignore`, `paths`, `paths-ignore`, GitHub's rules) match this push.
   - A job is **refused** if it:
     - puts anything but `image`, `env`, `ports` and `credentials` in its `container` or in a service (so no `options` or `volumes`);
     - uses an expression (`${{ … }}`) anywhere in `container` or `services`;
     - calls a reusable workflow (`uses:`);
     - names a `runs-on` label that `[platforms]` does not map to an image.

     A refused job becomes a failed check saying why, and act never sees it. `allow_container_options = true` lifts the container and service rules for one repository; the label rule always applies.
   - A workflow that uses a YAML merge key (`<<:`) is refused as a whole. The runner's YAML reader and act's disagree about it.
4. **Runs act once per workflow file** that runs, with one container per job:
   - Every job is reported as `queued`, then `in_progress`, then `completed`, with `success`, `failure`, `skipped` or `timed_out`.
   - A job act never finished counts as `failure`.
   - The check is named `<workflow name> / <job name>`.
   - A job's reports share one run id, a hash of the repository, ref, commit, workflow file, job and the run's start time, so they update a single check run, and re-running a commit (`forge-runner run`) records a new check run, as a GitHub re-run attempt does.
5. **Uploads each job's log** (capped at 16 MiB) to your storage profile, with secret values redacted, and, with `artifacts = true`, [its artifacts](#artifacts). The check run records the log's URL and SHA-256, and the web app shows the log only if the bytes match.

6. **Lists the pull requests** (`dg pr list`, the newest 100, and up to 10 older members' open PRs it keeps following) and runs each one that was opened, reopened or marked ready for review, or whose head moved, as [Pull requests](#pull-requests) says. The first poll only records them.
7. **Reads the re-run requests** written since the last poll (`dg ci reruns`, one query) and runs each one that counts, as [Re-runs](#re-runs) says. The first poll only records the time (five minutes back, so a clock running ahead hides no request).
8. **Runs the schedules** whose time came since the last poll, with `schedule = true`, as [Schedules](#schedules) says.

If a run could not start because the fetch or checkout failed, the next polls try it again, up to `attempts` (default 3). A run whose jobs did run is not repeated by a poll: a maintainer or writer [asks for a re-run](#re-runs), or you run `forge-runner run` by hand.

## Pull requests

A workflow whose `on:` includes `pull_request` runs when a pull request is opened, its head moves (`synchronize`), it is reopened, or (when the workflow's `types` asks for it) it is marked ready for review. Drafts run too, as on GitHub.

- **What runs is the PR's head commit.** The runner fetches the branch the PR names, from this repository or from the fork that holds it, and runs only if the branch's tip is the head `dg` reports. A head that is not its branch's tip is retried up to `attempts` times, then waits for the PR's next head. GitHub runs a merge preview instead; here `github.sha` is the head.
- **The event is GitHub's `pull_request` payload.** It carries `action`, `number`, `pull_request.{number, title, draft, user.login, head.{ref, sha, repo.fork}, base.{ref, sha}}`, and `before`/`after` on a `synchronize`. act turns these into `github.ref` = `refs/pull/<n>/merge`, `github.head_ref` and `github.base_ref`. The PR's author writes the title and the branch name: never paste `${{ github.event.pull_request.title }}` or `${{ github.head_ref }}` into a `run:` script; pass them through `env:`, as on GitHub.
- **Filters are GitHub's.** `types` (by default `opened`, `synchronize` and `reopened`), `branches` / `branches-ignore` on the base branch, and `paths` / `paths-ignore` on the PR's changes (`base...head`).
- **Checks go on the head, named apart.** A member's PR posts `<workflow> / <job> (pull_request)` on its head commit; anyone else's posts `<workflow> / <job> (pull_request, non-member)`. Both are keyed by `refs/pull/<n>/head`, so a PR's run and the branch's own push run on the same commit never replace each other, and a stranger's PR that names a member's commit can never post the run a member's required check reads. Require `ci / build (pull_request)` in a branch policy to gate merges on it.
- **Which PRs are watched.** Each poll reads the newest 100 PRs (open and closed, by creation). A member's open PR it has seen stays followed after newer PRs push it out of that window: each poll reads up to 10 such PRs, one read each, in turn, and a failed read drops nothing. Anyone can open PRs, so an identity that opens more than 100 between two polls can hide a PR opened in between from CI until its next head; `forge-runner run --pr <n>` reads any PR directly.
- **Polling sees states, not every step.** A draft marked ready whose head also moved runs as `synchronize`; a close and reopen between two polls runs nothing. A PR the policy skipped is not revisited until its head moves or it is reopened.
- **`pull_request_target` and `workflow_dispatch` never run.** `schedule` runs on the default branch with `schedule = true` ([Schedules](#schedules)).

Which pull requests run is the repository's `pull_requests` setting. A member is the owner, a maintainer or a writer, as `dg collab list` reads them at the poll:

| `pull_requests` | Runs |
|---|---|
| `"members"` (default) | Members' PRs, from a branch here or from a fork. Others are skipped with a log line. |
| `"all"` | Also strangers' PRs from forks. A stranger's code then runs on your Docker daemon (without secrets), one PR after another, each up to `job_timeout_secs`: as a fork's PR does on GitHub, without the approval step. |
| `"off"` | No PR. Turning it off forgets the PRs seen, so turning it on again starts afresh. |

A stranger's PR whose head is a branch of **this** repository never runs by itself, under any setting: members pushed that code and its push run tested it, and running it again would only let a stranger choose the event (base, title) of a run on a member's commit.

`forge-runner -c runner.toml run alice/project --pr 12` runs one open PR's current head by hand as `opened`, for example a stranger's that the policy skipped, after you read it. It gets the secrets only if the rules below hold, so a stranger's never does.

**Secrets follow GitHub's fork-PR model.** A pull request's run gets the secrets file and its `GITHUB_TOKEN` only when all three hold:

1. its head is a branch of **this** repository, not a fork's;
2. that branch matches `trusted_refs`, so only those who could push there with secrets anyway wrote the code;
3. its author is the owner or a maintainer, so the PR's title, base and other event fields, which choose what runs and might reach a shell, come from someone who could push that branch too. A writer's PR does not qualify.

Every other PR, including a maintainer's PR from a fork and every PR from a writer or a stranger, runs with no secrets and an empty `GITHUB_TOKEN`. Forge has no job token at all: the runner key never reaches a job, so such a run can read public data and nothing else. Its check-run summary says "with secrets" only when it had them.

**A fork's code stays apart.** A fork's head is fetched into a cache of that run's own, without tags, and deleted with the run, so nothing from a fork (objects, tags that could shadow the repository's own) reaches the cache that push runs are checked out from. `allow_container_options` never applies to a fork's or a stranger's PR: their jobs keep the container rules whatever the repository allows.

**Private repositories.** The runner reads pull requests without its key, and a private repository's PRs are sealed to its members: a runner that is not a member cannot read them. Set `pull_requests = "off"` for a private repository, or its polls log that `dg pr list` failed.

The runner needs a `dg` of the same release: it reads `repoId`, `sourceRefName` and `baseTip` from `dg pr list --json` and `dg pr view --json`, `ownerId` from `dg collab list --json`, and the re-run requests from `dg ci reruns --json`.

## Re-runs

A maintainer or writer can ask the runners to run a pull request's checks again: **Re-run** beside a completed check, or **Re-run all checks**, on the PR's Checks tab, or `dg ci rerun alice/project 12 [--check "ci / build (pull_request)"]` ([CI and check runs](ci.md#re-run-checks)). The request is an `event` on the PR (kind 26, [forge-v2.md §3.3](../contracts/forge-v2.md#33-ci-re-run-requests-kind-26)) naming the PR's head and, optionally, one check. The runner reads the requests on each poll, and within seconds when [your relay](#wake-it-from-your-relay) wakes it: the relay wakes runners on a request too.

- **Who counts.** Only the owner's, a maintainer's or a writer's request runs. A triage member's is admitted by Platform but not counted, as GitHub needs write access to re-run a workflow; `dg ci reruns` marks it, and the runner logs it and runs nothing.
- **What runs is the PR's current head, as a poll would run it.** A request for a commit that is no longer the head runs nothing: the new head ran by itself. A check of the PR's own runs (`… (pull_request)`) re-runs the PR as `pull_request` (`opened`; a workflow runs when its `types` name any activity the runner runs PRs on, `opened`, `synchronize`, `reopened` or `ready_for_review`, since it may have run on another of them, and never one only for `closed` or `labeled`; the runner keeps no record of which ran, so **Re-run all checks** can also run a workflow typed only for an activity this PR has not had, such as `ready_for_review` on a PR never a draft), under the same `pull_requests` policy, so a re-run never runs a PR the poll would have skipped. Any other check (a push run's) re-runs the push of the branch at that commit: the PR's own branch here, or another watched branch at it. A request without a check re-runs both, where each applies.
- **One workflow, all its jobs.** A check is re-run by running again the workflow file whose job reports it, every job of it, as GitHub's "Re-run all jobs" does for a workflow. Each job is a new check run (a new run id), which then becomes the one shown.
- **Secrets as before.** A re-run gets the secrets only when the run it repeats would ([Security](#security)); who asked does not matter. Its summary and the act event (`github.event.forge.rerun_requested_by`) name who asked.
- **Once each.** A request is handled once, whatever its runs came to; two requests for the same check in one poll run once, and a request for every check covers the named ones beside it. A request whose pull request or members could not be read is tried again on the next polls, up to `attempts`. `forge-runner run <repo> --pr N --check NAME` re-runs one check by hand the same way. Turn re-runs off for a repository with `reruns = false`.
- **Private repositories.** The runner reads requests without its key; a private repository's are sealed like its pull requests, so a runner that is not a member cannot read them.

`forge-runner -c runner.toml run alice/project --pr 12 --check "ci / build (pull_request)"` runs only the workflow that reports one check, by hand; `--check` works with `--ref`/`--sha` too.

## Schedules

With `schedule = true` on a repository, a workflow's `on.schedule` runs as on GitHub:

```yaml
on:
  schedule:
    - cron: '30 5 * * 1-5'   # 05:30 UTC on weekdays
```

- **On the default branch's tip.** Each poll reads the default branch (the `HEAD` that `git ls-remote --symref` names, checked against `dg repo view` once per tip) and, once per tip, the `cron` entries of its workflows, from the first workflow directory the commit has. The `refs` setting does not apply: a schedule always runs on the default branch, and none runs while that branch is missing. A workflow file that a run would refuse as a whole (not YAML, a merge key, no jobs) runs no schedule, and the runner logs why.
- **Cron as GitHub reads it.** Five fields (minute, hour, day of the month, month, day of the week), in UTC: `*`, values, ranges `a-b`, steps `/n` and comma-separated lists; month and day names (`JAN`, `MON`); 7 is Sunday too. When both day fields are restricted, a day matches if either does. An expression the runner cannot read is logged with its file and never runs.
- **Once per poll, however many times passed.** A poll runs each expression whose time came since the last poll once, as `schedule` (`github.event.schedule` is the expression, `github.ref` the default branch), and only the workflows that list that expression; a workflow listing several expressions due in the same poll runs once. As on GitHub, an expression runs at most every five minutes. Polling every `interval_secs` means a run starts up to that late. A time missed while the runner was stopped is not made up (only the last week is looked at), and a run that fails is not repeated, as on GitHub. The first poll with `schedule = true` only records the time.
- **Checks are named apart.** A scheduled job posts `<workflow> / <job> (schedule)` on the tip, so it never replaces the push run's check. A re-run request for a scheduled check runs nothing: it runs again at its next time.
- **Secrets as for a push of the branch.** A scheduled run gets the secrets when `trusted_refs` covers the default branch.
- **Every run costs credits.** Each job posts three check-run reports, so `*/5 * * * *` writes hundreds of documents a day. That is why `schedule` is off by default. Pick the longest interval that does the job.

## Set it up

0. **The binaries.** Each release archive for Linux and macOS holds `forge-runner` beside `dg` and `git-remote-dash` ([Install](../INSTALL.md)): `curl -fsSL https://raw.githubusercontent.com/PastaPastaPasta/dash-forge/master/install.sh | DASH_FORGE_BINARIES="dg git-remote-dash forge-runner" sh` installs all three. The Windows archive leaves it out: the runner drives act and Linux job containers. From source, `cargo install --locked --path crates/forge-runner`. Install [act](https://github.com/nektos/act) yourself, or use the [image](#with-docker), which has all four tools.
1. **A runner identity and key.** On your own computer, create the runner identity with `dg auth new --backup-file runner.json`. In a terminal it shows the recovery words once. Without one it never prints them: they go only to `runner.json`, sealed under `DASH_FORGE_PASSPHRASE`. Then, as the repository owner, run `dg ci runner new alice/project --runner runner.json -o runner.dfk1` ([CI and check runs](ci.md#enrol-a-runner)). `runner.dfk1` is the runner's `DASH_FORGE_KEY`: copy it to the runner host (0600) and delete your copy. Keep `runner.json` offline, not on the runner host.
2. **A storage profile for logs.** This is optional, but without it reports carry no log. Run `dg storage add ci-logs --kind s3 …` on the runner's machine ([Bring your own storage](bring-your-own-storage.md)). Its public URL must be readable by browsers, with CORS for the web app.
3. **A Docker daemon for the runner alone.** See [Security](#security).
4. **`runner.toml`**:

```toml
network = "mainnet"                 # or testnet; "devnet" needs devnet_name
state_dir = "/var/lib/forge-runner"
interval_secs = 120                 # at least 30
log_storage = "ci-logs"             # the profile from step 2: logs and artifacts
# artifacts = true                  # act's artifact server for actions/upload-artifact (see Artifacts)
# artifact_server_addr = "172.17.0.1"   # required with artifacts: where only jobs reach it
sweep_after_timeout = true          # only on a daemon the runner owns (see Security)
# job_timeout_secs = 3600           # for all workflows of one push
# attempts = 3                      # retries of a push whose checkout failed
# container_options = "--memory 4g --cpus 2 --pids-limit 512"   # yours, for every job
# [platforms]                       # runs-on label → image (act -P); never "-self-hosted"
# ubuntu-latest = "node:20-bookworm-slim"   # the default: small, has bash

[[repo]]
repo = "alice/project"
refs = ["refs/heads/**"]            # which pushes run; `*` stays in one path segment, `**` does not
trusted_refs = ["refs/heads/main"]  # only these get the secrets
secrets_file = "/etc/forge-runner/project.secrets"   # KEY=value lines, as act reads them
# pull_requests = "members"         # or "all" (strangers' too, never with secrets) or "off"
# reruns = true                     # honour maintainers' and writers' re-run requests (see Re-runs)
# schedule = false                  # run on.schedule crons on the default branch (see Schedules)
# allow_container_options = false   # see Security before turning it on
```

5. **Run it.**
   - `DASH_FORGE_KEY="$(cat runner.dfk1)" forge-runner -c runner.toml watch` runs the service. It needs `dg`, `git`, `git-remote-dash` and `act` on `PATH`, and `DOCKER_HOST` pointing at the runner's daemon.
   - `forge-runner … watch --once` polls once, for cron or a first try.
   - `forge-runner … run alice/project --ref refs/heads/main --sha <oid>` runs one commit again; `--pr <n>` runs a pull request's head; `--check <name>` only the workflow that reports that check.

### Wake it from your relay

Polling finds a push within `interval_secs`. If you run a [relay](../../crates/forge-relay/README.md#wake-a-runner), it can wake the runner as soon as it sees a push, a pull request's activity (opened, head moved, reopened, marked ready, …) or a [re-run request](#re-runs):

```toml
# runner.toml
[relay]
url = "http://relay:8080"                       # the relay's --listen address, no path
secret_file = "/etc/forge-runner/relay.secret"  # 32–96 printable ASCII, the same as the relay's [wake] secret
```

```toml
# relay.toml
[wake]
repos = ["alice/project"]
secret-file = "/run/secrets/wake"
```

- **The runner connects to the relay.** A thread long-polls `GET /v1/wake`, so nothing listens on the runner's machine and it works behind NAT. It logs `woken by the relay at …` once connected.
- **A wake only moves the next poll earlier.** The runner polls a woken repository at once (never within 10 s of its last poll), and once more 20 s later in case its DAPI node is a block behind the relay's. It still reads the refs and pull requests itself; a wake decides nothing about what runs.
- **Polling stays the default.** Without `[relay]`, the runner only polls. With it, it still polls every `interval_secs`; if the relay is down, the runner logs the error, retries with a backoff (5 s up to 2 min) and keeps polling. A relay that restarted tells the runner to poll everything.
- **Authentication is the shared secret.** Every request is signed with it (HMAC-SHA256, a fresh nonce, the time) and every answer is signed over the request, so neither can be forged or replayed, and the secret never crosses the wire. The relay refuses a request more than 5 minutes off its clock: keep the runner's clock in sync (NTP), or every request gets `401`. The protocol is in the [relay README](../../crates/forge-relay/README.md#wake-a-runner).
- **Names must match.** A repository's `repo` here must be spelled as the relay's `[wake] repos` entry, or as `<owner id>/<name>`. The runner logs the names once if a wake matches none of its repositories.

### Artifacts

With `artifacts = true`, the runner starts act's artifact server for each workflow file, so `actions/upload-artifact` works (v4, and v3 as far as act serves it). After the run, each job's artifacts go to your `log_storage` through `dg ci report --artifact` and are recorded on its check run: name, size, SHA-256 and URL. The web app lists them on the Checks tab and saves one only if its bytes hash to that SHA-256. Nothing goes to storage but yours.

- **One zip per artifact.** A v4 upload is already one zip and is recorded as it was uploaded. A v3 upload's files are zipped (its gzipped parts inflated), as GitHub serves a v3 artifact.
- **Which job it belongs to.** act's server does not say, so the runner reads each job's log for upload-artifact's `Artifact <name> has been successfully uploaded!`. An artifact no job's log names goes on every job of that workflow file, so none is lost.
- **Limits.** At most 10 artifacts per job (the check run's list holds 4,096 bytes, about a dozen), the job's own first, each at most 256 MiB, and an upload that did not finish is left out; the job's summary says so. If the list still overflows 4,096 bytes (long names, a long storage URL), `dg` records what fits and the runner's log names the rest. If uploading them fails, the job's result is reported without them, and its summary says so.
- **Private repositories record none.** forge-community refuses artifacts on a private repository's run, so `dg` uploads none there.
- **Artifacts are public, and not scrubbed.** Anyone can download them from your bucket, like logs, including those of a stranger's pull request under `pull_requests = "all"`: your storage pays for them. Unlike logs, the runner does not remove secret values from them: never put secrets in an artifact.
- **Jobs must reach the server.** act listens on `artifact_server_addr`, which you must set (act's own default is this host's outbound address, public on many cloud machines), at `artifact_server_port` (default 34567), and tells jobs to upload to `http://<addr>:<port>/`. Where job containers reach the host by another name, set `artifact_server_url`: under Docker Desktop or OrbStack, `artifact_server_addr = "127.0.0.1"` and `artifact_server_url = "http://host.docker.internal:34567/"`. The server has no authentication: anyone who can reach it during a run can add to that run's artifacts. Bind it where only the job network reaches, such as the Docker bridge's gateway, never a public address. Two runners on one machine need different ports.

### With Docker

`crates/forge-runner/Dockerfile` builds an image with all four tools. It runs as an unprivileged `runner` user, whose state is in `/var/lib/forge-runner`. Here it is next to a Docker-in-Docker daemon that only it talks to, over TLS:

```yaml
# compose.yaml
services:
  dind:
    image: docker:27-dind
    privileged: true                  # the daemon's own sandbox; jobs run inside it
    environment:
      DOCKER_TLS_CERTDIR: /certs      # TLS on 2376, client certs in /certs/client
    volumes: [certs:/certs]
    networks: [ci]                    # no published ports
  runner:
    image: forge-runner
    environment:
      DASH_FORGE_KEY: ${DASH_FORGE_KEY}
      DOCKER_HOST: tcp://dind:2376
      DOCKER_TLS_VERIFY: "1"
      DOCKER_CERT_PATH: /certs/client
    volumes:
      - certs:/certs:ro
      - ./runner.toml:/etc/forge-runner/runner.toml:ro
      - ./secrets:/etc/forge-runner/secrets:ro
      - state:/var/lib/forge-runner
    networks: [ci]
volumes: { certs: {}, state: {} }
networks: { ci: {} }
```

The runner reads the workflow and checkout from its own filesystem and hands them to act. act then copies them into the job containers on the dind daemon.

## Security

The runner executes code from the repository: anyone who can push to a watched ref can run programs in its job containers. Treat a runner like a CI worker, not like a desktop.

**The boundary is the Docker daemon.** A job runs in a container on the daemon the runner is given. Container escapes, kernel bugs, and anything a job can make that daemon do are contained only as well as that daemon is. So:

- **Give the runner a daemon of its own.**
  - Good choices: rootless Docker, a [sysbox](https://github.com/nestybox/sysbox) runtime, or a Docker-in-Docker sidecar on a machine or VM used for nothing else.
  - Reach it over TLS (`tcp://…:2376` with client certificates), or over a unix socket that only the runner can open.
  - **Never** use the host's `/var/run/docker.sock`, and never an unauthenticated `tcp://…:2375`: whoever reaches either controls the host.
- **`sweep_after_timeout = true` only on that daemon.** After a timed-out or crashed run, the runner removes every `act-*` container, volume and network there. Before each run it also removes act's shared `act-toolcache` volume, so tools a job wrote there cannot reach the next run. On a daemon anything else uses, leave it off (the default); act's leftovers then stay until you remove them.

**What the runner enforces on top:**

- **No Docker socket in jobs.** Job containers do not get the daemon's socket (act's `--container-daemon-socket -`). `mount_docker_socket = true` turns that off, for trusted repositories only.
- **No docker options from a workflow.** These are refused before act runs:
  - a job's `container` or `services` with anything but `image`, `env`, `ports` and `credentials`;
  - any expression in `container` or `services`, which act evaluates at run time;
  - a reusable workflow call (`uses:`).

  Each can reach past the container: `--privileged`, a mounted socket, a host path, or a workflow the runner never read. Because of the expression rule, a registry password must be a literal in the workflow, or the image must be public or pulled in advance; `${{ secrets.… }}` in `container.credentials` is refused. `allow_container_options = true` allows them for one repository. Turn it on only if you would trust everyone who can push there with the daemon itself. The runner owner's own `container_options` still apply to every job.
- **No host execution.** A `[platforms]` entry of `-self-hosted`, which would make act run steps directly on the runner's machine, is refused at startup.
- **Not the host network.** Job containers join Docker's `bridge` network (`container_network`), not act's default `host`. Put the daemon where jobs cannot reach what they must not, such as cloud metadata endpoints and your LAN.
- **Secrets only for trusted refs.**
  - A secrets file, and a `GITHUB_TOKEN` from it, is passed to act only for refs matching `trusted_refs`, which match nothing by default.
  - Every other run gets an explicitly empty `GITHUB_TOKEN`, so act never falls back to a token from the host.
  - Anyone who can push a branch that matches `trusted_refs` can read the secrets, and so can a maintainer who opens a PR from such a branch. Keep `trusted_refs` to branches only maintainers can update: [protected branches](collaborating.md) take a maintainer's `protectedRefUpdate`.
  - Job summaries say "with secrets" when a run had them.
  - Secret values are masked in logs by act, and the runner replaces them again before a log is uploaded, because logs are public.
- **Never a fork's or a stranger's code with secrets.** A push run is of the repository's own refs, which only its members can make. A pull request's run gets the secrets only when its head is a `trusted_refs` branch of this repository and its author the owner or a maintainer ([Pull requests](#pull-requests)); a fork's head never does, whoever wrote it, and a fork's objects and tags never reach the cache push runs use.
- **Strangers' pull requests do not run by default.** With `pull_requests = "members"` only members' PRs run. `"all"` runs strangers' fork PRs on your daemon (without secrets, without `allow_container_options`), one after another: turn it on only for a daemon you would let anyone on the network use, and a job timeout you can afford per PR.
- **The checkout cannot configure act.**
  - act is given `/dev/null` for its `.env`, `.secrets`, `.vars` and `.input` files, and is run with `-C <checkout>` from the runner's own directory. A `.actrc`, `.secrets` or `.env` committed to the repository is never read; the end-to-end test plants all three.
  - act has no flag to turn `.actrc` off: it reads it from its working directory, `HOME` and `XDG_CONFIG_HOME`. So run the runner from a directory with no `.actrc`, and keep none in the runner user's home.
  - A workflow file act runs is either the file as read, or, when jobs were refused, a copy without them outside the checkout.
- **A clean environment.** act runs with its environment cleared except `PATH`, `HOME`, `TMPDIR`, `USER`, `LANG`, `TZ`, `DOCKER_*` and `XDG_*`. The runner's `DASH_FORGE_KEY` and cloud credentials never reach act or a job.
- **No shared caches.** act's cache server is off (`--no-cache-server`), and act's action cache and workspaces are per run. One run cannot read or poison another's.
- **One run at a time per repository.** Each run has its own directory under a per-repository lock, which is removed when the run ends.
- **The runner key.** `DASH_FORGE_KEY` is a runner key: it can write check runs and nothing else, only on repositories that enrolled its identity, and only within its budget. It is passed to `dg` in the environment, never on a command line and never to act.
- **Logs are public.** Anyone can read a check run's log URL, so keep private output out of logs. On a private repository a check run carries no log, summary or run id (forge-community refuses them), so `dg` uploads no log there and records only each job's name, status and conclusion. The old `public_log` setting has no effect.
- **The artifact server has no authentication.** With `artifacts = true`, anyone who can reach `artifact_server_addr:artifact_server_port` while a workflow runs can add to its artifacts, which then go on its check run. Bind it where only the job network reaches ([Artifacts](#artifacts)); artifacts are public, like logs.

## What it does not do (yet)

- **Only `push`, `pull_request` and (opted in) `schedule` run.** There are no `pull_request_target` or `workflow_dispatch` events, and a pull request runs its head, not a merge preview.
- **Pull requests are watched by window.** The newest 100, and members' open PRs already seen, 10 a poll in turn; see [Pull requests](#pull-requests).
- **One push at a time.** The workflow files of a push run one after another, within one `job_timeout_secs`.
- **Only configured `runs-on` labels.** A job whose `runs-on` label is not in `[platforms]` is refused, rather than run on act's own default image.

## Test it locally

`bash crates/forge-runner/tests/e2e-local.sh <path to forge-runner>` runs the runner against a throwaway local git repository, with a recording stand-in for `dg` and real act and Docker. It checks:

- the first poll runs nothing;
- a push reports every job three times under one run id, with the right conclusions and logs;
- a job with `container.options`, and a reusable-workflow call, are refused and never run;
- an invalid workflow file is one failed check;
- a `branches: [main]` workflow skips a feature branch;
- jobs get no Docker socket, no secrets, an empty `GITHUB_TOKEN` and no Forge key on an untrusted branch;
- a trusted branch gets the secrets, and their value appears in no report;
- a planted `.actrc` and `.secrets` are ignored;
- a member's pull request from a trusted branch here runs as `pull_request` with GitHub's context and the secrets, a member's from a fork runs without them, and a stranger's is skipped, then runs by hand without them;
- a pull request's moved head runs as `synchronize`, and a closed one runs nothing;
- a member's re-run request runs its check again on the head (once, however often it is asked in a poll), a push check re-runs as its branch's push, and an uncounted request or one for a moved head runs nothing;
- with `artifacts = true`, an `upload-artifact@v4` zip is recorded as uploaded and a v3 upload is zipped, each on the job that uploaded it (on Docker Desktop or OrbStack, set `FORGE_RUNNER_E2E_ARTIFACT_ADDR=127.0.0.1` and `FORGE_RUNNER_E2E_ARTIFACT_URL=http://host.docker.internal:34567/`);
- a request for every check covers a named one in the same poll, and a request whose pull request could not be read is tried again;
- with `schedule = true`, a cron expression of the default branch whose time came runs once, as `schedule` on the branch's tip, named `(schedule)`, and an invalid expression is logged and never run;
- a commit without workflows runs nothing, and no `act-*` container is left behind.

On a live devnet, `bash e2e/cli/run.sh 37` (scenario `37-forge-runner`) enrols a runner on the suite repository, pushes a workflow, runs one `forge-runner watch --once` and reads the check back with `dg ci status`, then asks for a re-run with `dg ci rerun` and checks that the next poll runs it again. It needs act, Docker and `forge-runner` beside `dg`.
