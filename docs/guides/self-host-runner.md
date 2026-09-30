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
   - A job's reports share one run id, a hash of the repository, ref, commit, workflow file and job, so they update a single check run.
5. **Uploads each job's log** (capped at 16 MiB) to your storage profile, with secret values redacted. The check run records the log's URL and SHA-256, and the web app shows the log only if the bytes match.

If a run could not start because the fetch or checkout failed, the next polls try it again, up to `attempts` (default 3). A run whose jobs did run is not repeated; `forge-runner run` repeats one by hand.

## Set it up

1. **A runner identity and key.** As the repository owner, run `dg ci runner new alice/project --runner runner.json -o runner.dfk1` ([CI and check runs](ci.md#enrol-a-runner)). `runner.dfk1` is the runner's `DASH_FORGE_KEY`.
2. **A storage profile for logs.** This is optional, but without it reports carry no log. Run `dg storage add ci-logs --kind s3 …` on the runner's machine ([Bring your own storage](bring-your-own-storage.md)). Its public URL must be readable by browsers, with CORS for the web app.
3. **A Docker daemon for the runner alone.** See [Security](#security).
4. **`runner.toml`**:

```toml
network = "mainnet"                 # or testnet; "devnet" needs devnet_name
state_dir = "/var/lib/forge-runner"
interval_secs = 120                 # at least 30
log_storage = "ci-logs"             # the profile from step 2
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
# allow_container_options = false   # see Security before turning it on
```

5. **Run it.**
   - `DASH_FORGE_KEY="$(cat runner.dfk1)" forge-runner -c runner.toml watch` runs the service. It needs `dg`, `git`, `git-remote-dash` and `act` on `PATH`, and `DOCKER_HOST` pointing at the runner's daemon.
   - `forge-runner … watch --once` polls once, for cron or a first try.
   - `forge-runner … run alice/project --ref refs/heads/main --sha <oid>` runs one commit again.

### Wake it from your relay

Polling finds a push within `interval_secs`. If you run a [relay](../../crates/forge-relay/README.md#wake-a-runner), it can wake the runner as soon as it sees a push or a pull request's activity:

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
- **A wake only moves the next poll earlier.** The runner polls a woken repository at once (at most every 10 s), and once more 20 s later in case its DAPI node is a block behind the relay's. It still reads the refs and pull requests itself; a wake decides nothing about what runs.
- **Polling stays the default.** Without `[relay]`, the runner only polls. With it, it still polls every `interval_secs`; if the relay is down, the runner logs the error, retries with a backoff (5 s up to 2 min) and keeps polling. A relay that restarted tells the runner to poll everything once.
- **Authentication is the shared secret.** Every request is signed with it (HMAC-SHA256, a fresh nonce, the time) and every answer is signed over the request, so neither can be forged or replayed, and the secret never crosses the wire. The protocol is in the [relay README](../../crates/forge-relay/README.md#wake-a-runner).

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
  - Anyone who can push a branch that matches `trusted_refs` can read the secrets. Keep `trusted_refs` to branches only maintainers can update: [protected branches](collaborating.md) take a maintainer's `protectedRefUpdate`.
  - Job summaries say "with secrets" when a run had them.
  - Secret values are masked in logs by act, and the runner replaces them again before a log is uploaded, because logs are public.
- **Never a fork's code with secrets.** The runner runs pushes to the watched repository's own refs, which only its members can make. A pull request from a fork is a ref in the fork, which the runner does not watch. To test fork PRs, watch the fork as its own `[[repo]]` without `trusted_refs`.
- **The checkout cannot configure act.**
  - act is given `/dev/null` for its `.env`, `.secrets`, `.vars` and `.input` files, and is run with `-C <checkout>` from the runner's own directory. A `.actrc`, `.secrets` or `.env` committed to the repository is never read; the end-to-end test plants all three.
  - act has no flag to turn `.actrc` off: it reads it from its working directory, `HOME` and `XDG_CONFIG_HOME`. So run the runner from a directory with no `.actrc`, and keep none in the runner user's home.
  - A workflow file act runs is either the file as read, or, when jobs were refused, a copy without them outside the checkout.
- **A clean environment.** act runs with its environment cleared except `PATH`, `HOME`, `TMPDIR`, `USER`, `LANG`, `TZ`, `DOCKER_*` and `XDG_*`. The runner's `DASH_FORGE_KEY` and cloud credentials never reach act or a job.
- **No shared caches.** act's cache server is off (`--no-cache-server`), and act's action cache and workspaces are per run. One run cannot read or poison another's.
- **One run at a time per repository.** Each run has its own directory under a per-repository lock, which is removed when the run ends.
- **The runner key.** `DASH_FORGE_KEY` is a runner key: it can write check runs and nothing else, only on repositories that enrolled its identity, and only within its budget. It is passed to `dg` in the environment, never on a command line and never to act.
- **Logs are public.** Anyone can read a check run's log URL, so keep private output out of logs. On a private repository a check run carries no log, summary or run id (forge-community refuses them), so `dg` uploads no log there and records only each job's name, status and conclusion. The old `public_log` setting has no effect.

## What it does not do (yet)

- **Only `push` runs.** There are no `pull_request`, `schedule` or `workflow_dispatch` events.
- **No artefacts.** `actions/upload-artifact` needs act's artifact server, which the runner does not start.
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
- a commit without workflows runs nothing, and no `act-*` container is left behind.
