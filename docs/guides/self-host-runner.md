# Self-host a CI runner (forge-runner)

`forge-runner` runs a Forge repository's workflows on your own machine and reports the results as Forge check runs. It is a small wrapper around [nektos/act](https://github.com/nektos/act), which runs GitHub Actions workflows locally in Docker. Forge runs no CI service: you run the runner, and it signs its reports with a runner key that can do nothing but write check runs (see [CI and check runs](ci.md)).

What it does, on every poll (every `interval_secs`, default 120 s):

1. `git ls-remote dash://<owner>/<repo>`: the refs, read from Platform proofs by `git-remote-dash`. The first poll only records where each ref is; the runner reports pushes made while it watches, not the repository's history.
2. For each ref that moved and matches `refs`: fetch that commit (a shallow fetch into the state dir) and check it out.
3. Run `.forge/workflows/*.yml` (GitHub Actions syntax) with `act push`, one Docker container per job.
4. Report each job as a check run named `<workflow name> / <job name>`: `queued`, then `in_progress`, then `completed` with `success`, `failure`, `skipped`, `timed_out` or `cancelled`. All three reports carry one run id (`--external-id`), so they update a single check run.
5. Upload each job's log to your storage profile. It is content-addressed, and the check run records its URL and SHA-256. The web app shows the log only if the bytes match.

## Set it up

1. **A runner identity and key.** As the repository owner: `dg ci runner new alice/project --runner runner.json -o runner.dfk1` ([CI and check runs](ci.md#enrol-a-runner)). Keep `runner.dfk1` as the runner's `DASH_FORGE_KEY`.
2. **A storage profile for logs** (optional, but without it reports carry no log). Run `dg storage add ci-logs --kind s3 …` on the runner's machine; see [Bring your own storage](bring-your-own-storage.md). Its public URL must be readable by browsers, with CORS for the web app.
3. **`runner.toml`**:

```toml
network = "mainnet"                 # or testnet; "devnet" needs devnet_name
state_dir = "/var/lib/forge-runner"
interval_secs = 120                 # at least 30
log_storage = "ci-logs"             # the profile from step 2
# job_timeout_secs = 3600
# [platforms]                       # runs-on label → image (act -P)
# ubuntu-latest = "node:20-bookworm-slim"   # the default: small, has bash

[[repo]]
repo = "alice/project"
refs = ["refs/heads/**"]            # which pushes run; `*` stays in one path segment, `**` does not
trusted_refs = ["refs/heads/main"]  # only these get the secrets
secrets_file = "/etc/forge-runner/project.secrets"   # KEY=value lines, as act reads them
```

4. **Run it**: `DASH_FORGE_KEY="$(cat runner.dfk1)" forge-runner -c runner.toml watch`. It needs `dg`, `git`, `git-remote-dash` and `act` on `PATH`, and a Docker daemon. Use `forge-runner … watch --once` for cron or a first try. `forge-runner … run alice/project --ref refs/heads/main --sha <oid>` runs one commit again.

### With Docker

`crates/forge-runner/Dockerfile` builds an image with all four tools:

```sh
docker build -f crates/forge-runner/Dockerfile -t forge-runner .
docker run -d --name forge-runner \
  -e DASH_FORGE_KEY="$(cat runner.dfk1)" \
  -e DOCKER_HOST=tcp://dind:2375 \               # a dedicated daemon: see Security
  -v /etc/forge-runner:/etc/forge-runner:ro \
  -v forge-runner-state:/var/lib/forge-runner \
  forge-runner
```

## Security

The runner executes code from the repository: anyone who can push to a watched ref can run programs on your machine. Treat a runner like a CI worker, not like a desktop.

- **No Docker socket in jobs.** By default, job containers do not get `/var/run/docker.sock` (act's `--container-daemon-socket -`). A job holding the socket controls the Docker host. `mount_docker_socket = true` turns it on, for trusted repositories only.
- **The runner's own daemon.** The runner itself needs a Docker daemon to start job containers. Give it a dedicated one: rootless Docker, or a Docker-in-Docker sidecar on its own VM, reached over `DOCKER_HOST`. Mounting the host's socket into the runner container is simplest, but then a bug in the runner, or in act, is a path to the host.
- **Not the host network.** Job containers join Docker's `bridge` network (`container_network`), not act's default `host`, so a job does not share the runner's network namespace. Put the runner where it cannot reach what jobs must not reach: metadata endpoints, your LAN.
- **Secrets only for trusted refs.** A secrets file is passed to act only for refs matching `trusted_refs`, and the default is none. Anyone who can push a branch that matches can read the secrets, so keep `trusted_refs` to branches only maintainers can update: [protected branches](collaborating.md) take a maintainer's `protectedRefUpdate`. Job summaries say "with secrets" when they had them. Secret values are masked in logs by act, and the runner replaces them again before a log is uploaded, because logs are public.
- **Never a fork's code with secrets.** The runner runs pushes to the watched repository's own refs, which only its members can make. A pull request from a fork is a ref in the fork, which the runner does not watch. To test fork PRs, watch the fork as its own `[[repo]]` without `trusted_refs`.
- **The checkout cannot configure act.** The runner passes `/dev/null` for act's `.env`, `.secrets`, `.vars` and `.input` files, and runs act with `-C <checkout>` from its own directory. A `.actrc`, `.secrets` or `.env` committed to the repository is never read. The e2e test plants all three.
- **The runner key.** `DASH_FORGE_KEY` is a runner key: it can write check runs and nothing else, only on repositories that enrolled its identity, within its budget. It is passed to `dg` as an environment variable, never on a command line or to a job container.
- **Logs are public.** Anyone can read a check run's log URL. Keep private output out of logs. On a private repository `dg ci report --log` is refused unless the runner sets `public_log = true`.

## What it does not do (yet)

- **No push wake-up.** The runner polls, so a push shows up within `interval_secs`. A relay webhook that wakes it is planned (platform-parity-spec §2.4).
- **No pull-request events.** Only `push` runs.
- **No artefacts.** `actions/upload-artifact` needs act's artifact server, which the runner does not start.
- **Jobs run one push at a time,** and all the jobs of a push run in one act invocation.
- **`runs-on` labels other than those in `[platforms]`** fall back to act's own image choice.

## Test it locally

`bash crates/forge-runner/tests/e2e-local.sh <path to forge-runner>` runs the runner against a throwaway local git repository, with a recording stand-in for `dg` and real act and Docker. It checks:

- the first poll runs nothing;
- a push reports every job three times under one run id, with the right conclusions and logs;
- jobs get no Docker socket, and no secrets on an untrusted branch;
- a trusted branch gets the secrets, and their value appears in no report;
- a planted `.actrc` and `.secrets` are ignored;
- a commit without workflows runs nothing.
