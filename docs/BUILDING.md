# Building Dash Forge

A fresh clone builds with no out-of-tree setup:

```sh
git clone https://github.com/PastaPastaPasta/dash-forge && cd dash-forge
cargo build --workspace          # Rust: forge-core, git-remote-dash, dg, forge-relay, forge-import
cd forge-web && pnpm install --frozen-lockfile && pnpm build   # the static web app
```

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Rust | pinned by `rust-toolchain.toml` (1.98.0) | rustup installs it automatically; MSRV floor is 1.92, which the pinned Platform packages require |
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
dash-sdk = { git = "https://github.com/dashpay/platform.git", tag = "v3.1.0-dev.8", default-features = false }
```

This is deliberate. They used to be path dependencies on a sibling `../platform` checkout,
which meant a fresh clone of this repo could not build at all, and two developers on the
same commit could compile against different Platform source. Pinning a tag makes the SDK
revision part of this repository's history.

Cargo will clone the Platform monorepo once into `~/.cargo/git` (a few hundred MB) and
cache it across builds.

### Bumping the pinned tag

1. Change the tag in **all five** entries under `[workspace.dependencies]` in `Cargo.toml`
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
EOF
```

Two things matter here:

* **`[patch]`, not `paths`.** Cargo's `paths` override only works for crates published to
  crates.io; these are git dependencies, so `paths` would be silently ignored.
* **All five packages, together.** Patching only some of them leaves `forge-core` holding
  git copies of the rest, and the graph ends up with two incompatible copies of `dpp` /
  `drive-proof-verifier` — which fails to compile with a type mismatch that does not
  mention the override at all.

The patch stays active until you remove it. Confirm which source is in use with
`cargo tree -p dash-sdk`, which prints the resolved source for the package.

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

## Storage integration tests (local MinIO + kubo)

* `make storage-it`: brings up `infra/docker-compose.yml`, then runs the bring-your-own
  storage tests against it. Covered: SigV4-signed S3 operations on a bucket that refuses
  anonymous writes, kubo CIDs matching the local CIDv1 derivation, and N-of-M
  replication with gateway read-back. Localhost only; no testnet. `FORGE_IT_S3=1` /
  `FORGE_IT_IPFS=1` make an unreachable fixture fail instead of skip.
* `make storage-e2e`: a real `git push` / `git clone` over `dash://` with packs on the
  local MinIO + kubo. Only the manifest and ref go to testnet, and it spends a few hundred
  thousand credits of the e2e DEPLOYER identity. See `e2e/cli/storage-byo.sh`.

## End-to-end suites

Both e2e suites run against **live Dash Platform testnet** and are not part of the
per-push gate:

* `make e2e` — the CLI suite (`e2e/cli/run.sh`, 7 scenarios). Needs the funded fixture
  identities described in `e2e/cli/config.sh` under
  `~/.config/dash-forge/test-identities/`.
* `cd forge-web && pnpm test:e2e` — the Playwright suite. `pnpm install` does not
  download browsers, so a fresh clone needs one extra step first:

  ```sh
  cd forge-web
  pnpm install --frozen-lockfile
  pnpm exec playwright install --with-deps chromium
  pnpm test:e2e
  ```

  The read-path, fallback-browse, zero-backend and a11y specs need only network access to
  testnet; `auth-write.spec.ts` needs a funded identity.

The `Testnet Nightly` workflow runs the read-only half unconditionally and the funded half
only when the fixture secrets are configured, reporting a clear SKIP when they are not.

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
