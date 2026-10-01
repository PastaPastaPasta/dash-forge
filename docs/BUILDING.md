# Building Dash Forge

To use Dash Forge you do not have to build it: prebuilt binaries for Linux, macOS and
Windows come with every release. See [INSTALL.md](INSTALL.md). This page is for
contributors.

A fresh clone builds with no out-of-tree setup:

```sh
git clone https://github.com/PastaPastaPasta/dash-forge && cd dash-forge
cargo build --workspace          # Rust: forge-core, git-remote-dash, dg, forge-relay, forge-import
cd forge-web && pnpm install --frozen-lockfile && pnpm build   # the static web app
```

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Rust | pinned by `rust-toolchain.toml` (1.98.0) | rustup installs it automatically; MSRV floor is 1.98, which the pinned Platform packages (v5.0.0-beta.1) require |
| **protoc** | ≥ 25 | `tenderdash-proto`, a transitive dependency of the Platform SDK, compiles `.proto` files in its build script |
| Node | 22 | forge-web |
| pnpm | 11 | forge-web (`pnpm-lock.yaml` is committed) |

`protoc` is the one non-obvious requirement. Without it the **whole workspace** fails to
build, and the error names neither cargo nor the crate that needs it:

```
error: failed to run custom build command for `tenderdash-proto`
  [error] => proto compile failed: protoc not found in PATH
```

```sh
brew install protobuf                          # macOS
```

**The version matters, and distro packages are often too old.** The floor is 25 —
`DEP_PROTOC_VERSION` in rs-tenderdash-abci's proto-compiler — and it is enforced two
different ways, so an older protoc fails in one of two unhelpful ways. Ubuntu's
`protobuf-compiler` is protoc 3.21.x; protobuf renumbered its releases to
`<major>.<minor>` at v22, so 3.21 reports the three-component `libprotoc 3.21.12`, which
the version parser reads as a float and rejects outright:

```
[error] => proto compile failed: failed to parse protoc version libprotoc 3.21.12
: invalid float literal
```

protoc 22, 23 and 24 parse fine and then fail the explicit version check
(`protoc version must be 25 or higher`). Install a modern release directly — this is what
CI does, pinned:

```sh
PROTOC_VERSION=28.3
curl -sSLo /tmp/protoc.zip \
  "https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOC_VERSION}/protoc-${PROTOC_VERSION}-linux-x86_64.zip"
sudo unzip -q -o /tmp/protoc.zip -d /usr/local bin/protoc 'include/*'
protoc --version   # libprotoc 28.3
```

## The pinned toolchain

`rust-toolchain.toml` pins rustc/clippy/rustfmt, for the same reason `Cargo.lock` pins
dependencies: `cargo clippy -- -D warnings` fails the moment a new stable ships a lint, with
no change to this repository. Pinning makes the lint set a property of the commit. rustup
reads the file automatically, so no setup is needed — the first cargo command in this
directory installs the pinned toolchain.

Bumping it is a deliberate change: raise `channel`, run
`cargo clippy --workspace --all-targets -- -D warnings`, fix what the new stable found, and
commit the toolchain file and the fixes together. It must stay at or above the workspace
`rust-version` in `Cargo.toml`.

## The Dash Platform SDK dependency

`forge-core` talks to Dash Platform through the Rust SDK (`dash-sdk`, `dapi-grpc`,
`drive-proof-verifier`, `rs-sdk-trusted-context-provider`, `simple-signer`). These are
declared in the root `Cargo.toml` as **git dependencies pinned to an immutable upstream
tag**, and `Cargo.lock` records the exact commit:

```toml
dash-sdk = { git = "https://github.com/dashpay/platform.git", tag = "v5.0.0-beta.1", default-features = false }
```

This is deliberate. They used to be path dependencies on a sibling `../platform` checkout,
which meant a fresh clone of this repo could not build at all, and two developers on the
same commit could compile against different Platform source. Pinning a tag makes the SDK
revision part of this repository's history.

Cargo will clone the Platform monorepo once into `~/.cargo/git` (a few hundred MB) and
cache it across builds.

### Bumping the pinned tag

1. Change the tag in **every** Platform entry (seven) under `[workspace.dependencies]` in `Cargo.toml`
   (the `PLATFORM_TAG` comment above them records the current value).
2. `cargo update -p dash-sdk`
3. `cargo test --workspace`
4. Commit the resulting `Cargo.lock`.

CI passes `--locked` to every cargo invocation, so a dependency change that forgets step 4
fails the build rather than silently re-resolving and un-pinning.

### Developing against a local Platform checkout

To build against a Platform working tree without editing `Cargo.toml`, patch the git
source in `.cargo/config.toml` (git-ignored):

```sh
mkdir -p .cargo
cat >> .cargo/config.toml <<'EOF'
[patch."https://github.com/dashpay/platform.git"]
dash-sdk = { path = "../platform/packages/rs-sdk" }
dapi-grpc = { path = "../platform/packages/dapi-grpc" }
drive-proof-verifier = { path = "../platform/packages/rs-drive-proof-verifier" }
rs-sdk-trusted-context-provider = { path = "../platform/packages/rs-sdk-trusted-context-provider" }
simple-signer = { path = "../platform/packages/simple-signer" }
platform-encryption = { path = "../platform/packages/rs-platform-encryption" }
dpp = { path = "../platform/packages/rs-dpp" }
EOF
```

Two things matter here:

* **`[patch]`, not `paths`.** Cargo's `paths` override only works for crates published to
  crates.io; these are git dependencies, so `paths` would be silently ignored.
* **All the packages, together.** Patching only some of them leaves `forge-core` holding
  git copies of the rest, and the graph ends up with two incompatible copies of `dpp` /
  `drive-proof-verifier` — which fails to compile with a type mismatch that does not
  mention the override at all.

The patch stays active until you remove it. Confirm which source is in use with
`cargo tree -p dash-sdk`, which prints the resolved source for the package.

### Protocol versions (SDK v4.2)

The pinned SDK (`v5.0.0-beta.1` in Rust; `@dashevo/evo-sdk` and `@dashevo/wasm-sdk` `5.0.0-beta.1` from npm in forge-web; a tag missing from npm can be vendored: [dev/sdk-vendoring.md](dev/sdk-vendoring.md)) speaks
protocol 13 (testnet, mainnet) and protocol 14 (devnets such as bonsia). Neither client pins
a version. The SDK starts at a per-network floor (13 for testnet and mainnet, 14 for a
devnet) and raises it from the metadata of the first **proof-verified** response. So
`Sdk::version()` / `sdk.version()` gives the network's version only after a proved query
has succeeded. `dg doctor` issues one and then prints the protocol version.

Protocol 14 changes three things that a client has to handle:

- **Document ids.** A new document's id commits to the identity-contract nonce of its
  create transition as well as the entropy. Both clients derive the id with
  `Document::generate_document_id(.., nonce, version)` (forge-web:
  `Document.generateId(.., nonce, version)`) at the version they sign with, so the id they
  report before broadcast is the one that lands, on either protocol.
- **`indexOnly` document types** (forge-v2's `star` / `follow`). Their proofs only
  authenticate the resulting state, so forge-core waits with
  `broadcast_and_wait_for_affected_state`; the strict wait rejects them. Deleting one is a
  separate transition kind that carries the document's values, not just its id.
  `WriteEngine::prepare_delete` does not build that transition yet.
- **Serialization.** evo-sdk 4.2 `toJSON` returns identifier-typed byteArray fields
  (`repoContractId`) as base58, where 4.0 returned base64. Also,
  `new Document({ properties })` now turns a `Uint8Array` into an integer array, which
  Drive rejects. forge-web's `documentForCreate` builds documents through
  `Document.fromObject`, which keeps bytes as bytes.

Protocol 13 under the 4.2 verifier has two paging gotchas, which both clients handle in their
complete readers (`query_all_documents` / `queryAllDocuments`):

- **Descending page after a cursor.** The 4.2 grovedb verifier rejects the proof a
  protocol-13 node returns for one ("Proof op family does not match the query direction").
  A descending read is paged ascending and reversed, which gives the same rows in the same
  order.
- **Same-block ties.** A `start_after` cursor excludes the cursor's whole `$createdAt`, so
  documents created in the same block as a page's last row, and sorting after it, are
  skipped. When the index ends in `$createdAt`, the readers also query the boundary
  timestamp with `==`. This needs the boundary row's `$createdAt`, which history-keeping
  types (`packManifest`, `event`, `refUpdate`, `issue`, ...) do not return from a proved
  query on protocol 13. forge-v2 runs only on protocol 14, where the readers bound the
  cursor by document id.

## Networks

Every binary and the web app target one of **testnet**, **mainnet**, or a **named devnet**
such as `bonsia`. The CLI tools default to testnet, but forge-v2 is deployed only on devnet
bonsia today (Platform protocol 14). Testnet and mainnet run protocol 13; forge-v2 is
registered on testnet once protocol 14 reaches it, and on mainnet after protocol 14
activates there ([mainnet-runbook.md](mainnet-runbook.md)). Until then, pass
`--network devnet --devnet-name bonsia` (or just `--devnet-name bonsia`), or record it once
with `dg auth login --network devnet --devnet-name bonsia`, which saves the network in
`~/.config/dash-forge/config.toml`.

**Devnet bonsia** (Platform 4.2.0-beta.7, chain id `dash-devnet-bonsia-g1`) replaced moutai: the
RC1 contracts are registered there, and the defaults (Makefile `DEVNET`, `E2E_DEVNET`, the
Pages and e2e workflows) target it. `devnet-bonsia.json` records its 13 DAPI addresses and
quorum service (`https://quorums.bonsia.networks.dash.org`), so `--devnet-name bonsia` works
for every tool. Devnet moutai was upgraded in place to beta.7, which retired the forge-v2
contracts registered there; `devnet-moutai.json` stays in the tree as the record of them.
(The beta.7 wasm SDK sends DAPI calls to `https://node:1443//org.dash…`; a gateway that does
not merge slashes answers them 404, which the SDK reports as "malformed response". bonsia's
merges them.)

Contract ids are never written into code: they come from the `v2` section of
`forge-contracts/deployments/<key>.json`, where the key is `testnet`, `mainnet` or
`devnet-<name>`. The Rust crates embed every file in that directory at build time
(`crates/forge-core/build.rs`); forge-web bundles them through `forge-web/lib/deployments.ts`,
and a unit test fails if that map is missing a file.

A network whose deployment file has no registered forge-v2 pair (or has no file at all) is
**not deployed**. Commands that need the contracts fail with a "not deployed" error and never
fall back to another network's ids. Identity and balance reads still work there. `dg doctor`
prints the network, the forge-core, forge-collab and forge-community ids, and where they came from.

### Selecting a network

| Tool | Network | Devnet name | Devnet DAPI addresses |
|---|---|---|---|
| `dg` (flags) | `--network testnet\|mainnet\|devnet` | `--devnet-name bonsia` | `--dapi-addresses a,b` |
| `dg` (`~/.config/dash-forge/config.toml`) | `network` | `devnet_name` | `dapi_addresses` |
| `git-remote-dash` (git config) | `dash.network` | `dash.devnetName` | `dash.dapiAddresses` |
| `forge-relay` (flags / TOML) | `--network` / `network` | `--devnet-name` / `devnet-name` | `--dapi-addresses` / `dapi-addresses` |
| `forge-import` (flags) | `--network` | `--devnet-name` | `--dapi-addresses` |
| any of the above (env) | `DASH_FORGE_NETWORK` | `DASH_FORGE_DEVNET_NAME` | `DASH_FORGE_DAPI_ADDRESSES` |
| forge-web (build env) | `NEXT_PUBLIC_NETWORK` | `NEXT_PUBLIC_DEVNET_NAME` | `NEXT_PUBLIC_DAPI_ADDRESSES` |

Precedence is per field. For `forge-relay` and `forge-import` it is: flags, then the config
file, then the environment, then the deployment file. For `dg` it is: flags, then the git
config of the repository in the current directory (only its own `local` / `worktree` values,
which `dg init` and `dg repo clone` write; `dg auth`, `dg repo clone` and `dg repo create`
skip it), then `config.toml`, then the environment, then the
network the key in use records (`dfk1:<network>:…`, an identity file's `network`, so a CI runner
key needs no network setting), then the deployment file. `dg doctor` shows which one chose the
network. For `git-remote-dash` it is the
environment, then git config, then the network `dg` recorded in `config.toml` (by `dg auth new`
or `dg auth login`), then the deployment file. The environment comes first there because `dg`
and `forge-import` pass their resolved network to the helper through it. `dg init` and
`dg repo clone` write the network into the repository's git config, so the repository keeps it
when the default changes. Two more rules apply to every tool:

- `--devnet-name` on its own implies `--network devnet`.
- A network value may name the devnet itself, as the tools print it:
  `DASH_FORGE_NETWORK=devnet-bonsia` is `devnet` plus the name `bonsia`.
- A layer that names a different network contributes nothing network-specific. For example,
  `dapi_addresses` saved for a devnet in `config.toml` are ignored under
  `--network mainnet`.

A devnet's quorum keys come from `https://quorums.<name>.networks.dash.org`. Override the
URL with `DASH_FORGE_QUORUM_URL` or git config `dash.quorumUrl` (forge-web:
`NEXT_PUBLIC_QUORUM_URL` at build time), or with `quorumBaseUrl` in the deployment file. The
devnet's DAPI addresses are taken from the first of these that is set:

1. the flag, config or env setting;
2. `dapiAddresses` in `deployments/devnet-<name>.json`, else the `v2.devnet.addresses` that
   `deploy-v2.mjs` recorded there;
3. discovery through the quorum service's `/masternodes` endpoint.

Each address is `host`, `host:port` or `https://host:port`. The port defaults to 1443.

```sh
dg --devnet-name bonsia doctor                       # bonsia, addresses from devnet-bonsia.json
dg --network devnet --devnet-name bonsia --dapi-addresses 68.67.122.224,68.67.122.225 repo list
git config dash.network devnet && git config dash.devnetName bonsia   # per repo
git clone -c dash.network=devnet -c dash.devnetName=bonsia dash://<owner>/<repo>   # kept in the clone
dg repo clone <owner>/<repo>                            # the same, on dg's network
NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=bonsia pnpm build  # forge-web
```

The web header shows a network badge on every network except mainnet (the production build
at forge.dashhq.org is built from master by `pages.yml`, for devnet bonsia since the 2026-09-30
cut-over, and shows "devnet"). On a network with no
forge-v2 deployment, the badge is amber and the pages that need the contracts show a "not
deployed" state instead of querying.

### Adding a network

To add a network, register forge-v2 there with `forge-contracts/scripts/deploy-v2.mjs`
([contracts/forge-v2.md §8](contracts/forge-v2.md#8-deploying)). It writes the `v2` section of
`forge-contracts/deployments/<network>.json` (`devnet-<name>.json` for a devnet). Commit the
file, then add a matching import to `forge-web/lib/deployments.ts`. The script's SDK is
pinned in `forge-contracts/sdk-v2` (`(cd forge-contracts/sdk-v2 && npm ci)` once). Deployment
resolution exposes the ids (forge-core `NetworkTarget::v2`, forge-web `NETWORKS[n].v2`) once
both contracts are `registered`. `devnet-bonsia.json` also records bonsia's DAPI addresses and quorum service.

## Checks

```sh
make check         # everything below
make check-rust    # cargo fmt --check, clippy -D warnings, cargo test --workspace
make check-web     # pnpm typecheck, lint, test
```

`make check-rust` runs the same three commands as CI's `rust` workflow, with one
difference: CI passes `--locked`, so it also fails when a dependency change landed without
its `Cargo.lock`. A green `make check-rust` therefore does not by itself prove a green CI
run after a dependency bump — run `cargo test --locked --workspace` once before pushing
one.

## Storage integration tests (local RustFS + kubo)

* `make storage-it`: brings up `infra/docker-compose.yml`, then runs the bring-your-own
  storage tests against it. Covered: SigV4-signed S3 operations on a bucket that refuses
  anonymous writes, kubo CIDs matching the local CIDv1 derivation, and N-of-M
  replication with gateway read-back. Localhost only; no Platform network. `FORGE_IT_S3=1` /
  `FORGE_IT_IPFS=1` make an unreachable fixture fail instead of skip. CI runs it on every
  Rust change (the `storage-it` step of the `rust` job in `.github/workflows/rust.yml`). The S3 store is
  RustFS (`rustfs/rustfs`, pinned by digest), set up by a one-shot `amazon/aws-cli`
  container; the `minio/minio` and `minio/mc` images it replaced no longer pull.
* `make storage-e2e`: a real `git push` / `git clone` over `dash://` with packs on the
  local RustFS (S3) + kubo. Only the manifest and ref go to devnet bonsia, paid by the e2e OWNER
  identity. See `e2e/cli/storage-byo.sh`.

## End-to-end suites

Both e2e suites run against **live devnet bonsia** (the RC1 contracts, protocol 14) and are not part
of the per-push gate:

* `make e2e` — the CLI suite (`e2e/cli/run.sh`, 11 scenarios). Needs the funded fixture
  identities described in `e2e/cli/config.sh` under
  `~/.config/dash-forge/test-identities/devnet-bonsia/` (OWNER, COLLAB, CONTRIB).
* `cd forge-web && pnpm test:e2e` — the Playwright suite. `pnpm install` does not
  download browsers, so a fresh clone needs one extra step first:

  ```sh
  cd forge-web
  pnpm install --frozen-lockfile
  pnpm exec playwright install --with-deps chromium
  pnpm test:e2e
  ```

  The specs run against a bonsia build and read the forge-v2 read fixture that
  `forge-contracts/scripts/seed-v2-fixture.mjs` seeds (idempotent); the write specs need a
  funded identity.

The `Devnet Nightly` workflow seeds the v2 fixture, runs Playwright against a bonsia build,
and runs the CLI suite on bonsia. The funded jobs run only when the fixture secrets are
configured, reporting a clear SKIP when they are not.

## Notes for sandboxed / offline environments

`tenderdash-proto`'s build script downloads a Tenderdash source archive over HTTPS using
its own certificate store, so it fails behind a TLS-intercepting proxy even when `curl`
works. It reads a pre-populated cache, so you can seed the archive yourself:

```sh
curl -sSL -o "$CARGO_TARGET_DIR/tenderdash-v1.5.3.zip" \
  https://github.com/dashpay/tenderdash/archive/v1.5.3.zip
```

(with `CARGO_TARGET_DIR` exported; otherwise the cache lives under the crate's own
`OUT_DIR`, which changes per build profile). The version comes from `TENDERDASH_COMMITISH`
in that crate's build script.
