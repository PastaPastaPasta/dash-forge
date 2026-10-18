# Managed IPFS node

`dg ipfs up` installs kubo 0.43.1, replaces its browser and owner authorizations
while it is stopped, verifies storage through the loopback proxy, saves a CLI
profile, and creates a one-time browser connection code. Upgrades can migrate
kubo's repo forward; downgrading a migrated repo is unsupported. The admin token
stays in the private data directory and is used directly by `status` and `ipfs`.
The internal gateway replaces kubo's wildcard CORS with the allowed origins.
Residual risk: the internal loopback ports (5101/8180 by default) have no Host
check. Kubo's authorizations cover `/api/v0`, but `/debug` and `/webui` on its
API listener remain reachable without a token, including through DNS rebinding.
The proxy's Host checks and gateway sandbox protect its public ports only.
Do not expose the internal ports to a network; browser CORS alone does not
prevent navigation or other requests to them. Unix sockets could close this
browser access path, but are not enabled in this implementation.
The passthrough command needs kubo's `--api-auth`, so that child argument is visible
to processes running as the same user.

`--no-service` starts a temporary supervisor for verification, then stops it.
Run `dg ipfs serve` afterwards under your own supervisor. No browser is opened
until the permanent node is running; the printed connection link also works once
`serve` starts. `down` also stops a manually running supervisor using its private
stop request file. The supervisor holds an OS file lock to prevent duplicate
children; stale lock files do not prevent restarts.

Tests normally use only local stub HTTP servers. To run the opt-in real-kubo test,
first obey the disk and Cargo-lock rules in the task brief, then run:

```sh
DASH_FORGE_KUBO_BIN=/absolute/path/to/ipfs cargo test -p dg --test managed_ipfs -- --ignored
```

The smoke test uses isolated data/config directories, no login service, no
keychain, and no paid Platform operations. It requires ports 5101 and 8180 to be
available. It initializes a real node, checks `ipfs config show`, starts `serve`,
checks owner status, then stops and purges only its temporary node.

Offline installation can use `DASH_FORGE_KUBO_ARCHIVE=/path/to/archive`; its SHA-512
is still verified. `DASH_FORGE_KUBO_BIN` skips installation but still requires the
pinned version. Synthetic test archives can bypass the hash only with a local
archive plus `DASH_FORGE_KUBO_SKIP_SHA=1` and `DASH_FORGE_KUBO_TEST_HOOKS=1` (or a
unit-test build). These are test hooks, never normal installation settings.

The supervisor calls `ipfs_pin::follow_tick(ctx)` after waiting up to two minutes
for the admin API to answer, then every 30 minutes. Refresh failures are logged
and do not stop the node. Both kubo output and tracing use the capped, rotating
`serve.log`; launchd's fixed stdout/stderr descriptors use `serve.stderr.log`.
The proxy-only `/dash-forge/health` endpoint identifies our listeners during
setup; it requires a loopback Host and never grants browser CORS access.

Connection links use the first `--origin` passed to `up`, or
`https://forge.dashhq.org` when none is passed. `connect` reuses that saved
`linkOrigin`; `connect --origin <origin>` can select another already allowed
website for one connection without changing the saved preference.
