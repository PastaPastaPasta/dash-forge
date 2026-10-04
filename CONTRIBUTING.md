# Contributing to Dash Forge

Thanks for helping. This page covers how to build Forge, the checks a change must pass, and how review works. For a security problem, don't open an issue: follow [SECURITY.md](SECURITY.md).

## What's in the repository

| Path | What it is |
|---|---|
| `crates/forge-core` | The shared library: Platform reads and writes, the client rules, storage, sealing |
| `crates/dg` | The `dg` CLI |
| `crates/git-remote-dash` | The git remote helper behind `dash://` URLs |
| `crates/forge-relay`, `forge-import`, `forge-runner` | The webhook relay, the GitHub and GitLab importer, the self-hosted CI runner |
| `forge-web` | The static web app (Next.js); see [forge-web/README.md](forge-web/README.md) |
| `forge-contracts` | The data contracts, per-network deployments and the conformance vectors |
| `docs` | Guides, reference and design notes |

## Build

You need Rust (rustup installs the pinned toolchain), `protoc` 25 or newer, Node 22 and pnpm 11. [docs/BUILDING.md](docs/BUILDING.md) explains each one, including why an older `protoc` fails.

```sh
cargo build --workspace                        # every Rust binary
cd forge-web && pnpm install --frozen-lockfile # the web app's dependencies
make dev-web                                   # the web app on http://localhost:3000, reading devnet sakura
```

## Checks

Run these before you open a pull request. CI runs the same ones.

```sh
make check-rust    # cargo fmt --check, clippy -D warnings, cargo test
make check-web     # tsc, eslint, vitest
```

CI also builds with `--locked`, so commit `Cargo.lock` and `pnpm-lock.yaml` with any dependency change.

## Rules that both clients share

Forge has two implementations of its client rules: Rust in `crates/forge-core/src/rules` and TypeScript in `forge-web/lib/rules`. They must agree, so a rule change starts with its vectors:

1. Add or change cases in `forge-contracts/vectors/` (one JSON file per case; [forge-v2.md](docs/contracts/forge-v2.md) describes the rules).
2. Change both implementations in the same pull request.
3. `cargo test -p forge-core` and `pnpm test` run every vector against each side.

A pull request that changes one side alone, or a rule without a vector, is not merged.

The contracts on devnet sakura are frozen: no new indexes, rules or required fields. Build on the existing document types and the conventions in [forge-v2.md](docs/contracts/forge-v2.md).

## End-to-end tests

The unit tests need no network. The end-to-end suites run against devnet sakura and need identities with credits. You don't need the maintainers' identities: make your own.

1. Mint identities with `tools/mint-identity`, one per role, and pay each deposit address from the [sakura faucet](https://faucet.sakura.networks.dash.org) when it asks:
   ```sh
   cd tools/mint-identity && npm install
   node mint.mjs --network devnet --devnet-name sakura --funding manual --out ~/forge-e2e --label OWNER
   ```
   Repeat with `--label COLLAB` and `--label CONTRIB`.
2. Point `E2E_IDENTITY_DIR` at that directory ([e2e/cli/config.sh](e2e/cli/config.sh) lists every variable), then run `make e2e` for the CLI suite.
3. For the browser suite, `cd forge-web && pnpm test:e2e` runs the read-only specs against the shared read fixture, with no identities.
4. The browser write specs write to a copy of that fixture which your identities own. Mint a `MAINTAINER` too, then seed your copy (`npm ci` in `forge-contracts/sdk-v2` first):
   ```sh
   node forge-contracts/scripts/seed-v2-fixture.mjs --network devnet --devnet-name sakura \
     --identities ~/forge-e2e --summary ~/forge-e2e/seed.json
   ```
   Then set `E2E_IDENTITY_DIR=~/forge-e2e`, `FORGE_SEED_SUMMARY=~/forge-e2e/seed.json`, and `E2E_V2_OWNER` and `E2E_V2_EMPTY_OWNER` to the two repository owners the summary names, and run `pnpm test:e2e`.

Write only to repositories your own identities created.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit subjects and pull request titles: `fix(dg): …`, `feat(web): …`, `docs: …`. The scope is the part you changed (`dg`, `web`, `core`, `relay`, `import`, `runner`, `contracts`).
- Keep a pull request to one change. Say what it changes, why, and how you tested it. Add before and after screenshots for anything visible in the web app, at 390 px wide and in both themes.
- Update the guides in `docs/guides` when behaviour a user sees changes.
- Write user-facing text the way [docs/design/style-guide.md](docs/design/style-guide.md) asks: short, concrete and in the active voice.

## Review

A maintainer reviews every pull request. We merge once CI is green on the final commit and review comments are resolved. Automated reviewers comment too; we answer what is right and say why when we disagree.

## License

Forge is licensed under either of [Apache License 2.0](LICENSE-APACHE) or [MIT](LICENSE-MIT), at your option. Unless you say otherwise, any contribution you submit for inclusion in Forge is dual licensed the same way, with no additional terms.
