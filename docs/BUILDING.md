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
| Rust | ≥ 1.80 (`rust-version` in `Cargo.toml`) | the workspace |
| **protoc** | ≥ 3.20 | `tenderdash-proto`, a transitive dependency of the Platform SDK, compiles `.proto` files in its build script |
| Node | 22 | forge-web |
| pnpm | 11 | forge-web (`pnpm-lock.yaml` is committed) |

`protoc` is the one non-obvious requirement. Without it the **whole workspace** fails to
build, and the error names neither cargo nor the crate that needs it:

```
error: failed to run custom build command for `tenderdash-proto`
  [error] => proto compile failed: protoc not found in PATH
```

```sh
sudo apt-get install -y protobuf-compiler     # Debian/Ubuntu
brew install protobuf                          # macOS
```

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

CI verifies with `cargo metadata --locked` that the lockfile matches the manifests, so a
dependency change that forgets step 4 fails the build rather than silently un-pinning.

### Developing against a local Platform checkout

To build against a Platform working tree without editing `Cargo.toml`:

```sh
mkdir -p .cargo
cat >> .cargo/config.toml <<'EOF'
paths = ["../platform/packages/rs-sdk", "../platform/packages/dapi-grpc"]
EOF
```

`paths` overrides apply only when the local package's version matches the locked one, so
this is safe to leave in place: if your checkout drifts to a different version, cargo
ignores the override rather than silently building something else. `.cargo/config.toml` is
local-only — do not commit it.

## Checks

```sh
make check         # everything below
make check-rust    # cargo fmt --check, clippy -D warnings, cargo test --workspace
make check-web     # pnpm typecheck, lint, test
```

`make check-rust` and CI's `rust` workflow run the same three commands, so a green local
run means a green CI run.

## End-to-end suites

Both e2e suites run against **live Dash Platform testnet** and are not part of the
per-push gate:

* `make e2e` — the CLI suite (`e2e/cli/run.sh`, 7 scenarios). Needs the funded fixture
  identities described in `e2e/cli/config.sh` under
  `~/.config/dash-forge/test-identities/`.
* `cd forge-web && pnpm test:e2e` — the Playwright suite. The read-path, fallback-browse,
  zero-backend and a11y specs need only network access to testnet; `auth-write.spec.ts`
  needs a funded identity.

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
