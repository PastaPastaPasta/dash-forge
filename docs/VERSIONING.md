# Versioning

Dash Forge follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html). Changes are recorded in [CHANGELOG.md](../CHANGELOG.md).

## One version for everything

- `dg`, `git-remote-dash`, `forge-relay`, `forge-import` and `forge-runner` share one version: `version` under `[workspace.package]` in the root `Cargo.toml`. `dg --version` prints it, and `dg doctor` warns when `git-remote-dash` is a different version.
- A release is the git tag `v<version>`, such as `v0.1.0`, on a commit on `master`.
- The Mirror Action (`PastaPastaPasta/dash-forge/action@v<version>`) and the check action (`PastaPastaPasta/dash-forge/check-action@v<version>`) use the same tags. At a release tag, each action installs that release's binaries by default.
- The `forge-relay` container image is tagged with the version (`ghcr.io/pastapastapasta/forge-relay:<version>`), and `:latest` follows the newest release that is not a pre-release.
- Each release has its own web app build, and so its own IPFS CID (`forge-web-<version>.cid`). The CID changes with every release.
- Pre-releases are tagged like `v0.2.0-rc.1`. `install.sh` never picks one as "latest": install it with `DASH_FORGE_VERSION=0.2.0-rc.1`.

## What 0.x means

Until 1.0:

- **A minor release** (0.1 → 0.2) may break things: CLI flags and commands, the configuration file, environment variables and `--json` output. The changelog lists each break.
- **A patch release** (0.1.0 → 0.1.1) contains fixes only, with no intended breaking change.

From 1.0, breaking changes to these come only in a major release.

## JSON output

Every `dg` command run with `--json` prints one JSON object on stdout, and every such object, an error included, carries `"schemaVersion": 1`. [`docs/schemas/`](schemas/README.md) has a JSON Schema (draft 2020-12) for each command's object and lists the few commands that print no JSON: `dg completions`, `dg env run` (its output is the command's) and `dg api query`, which prints raw Platform documents as they are, like `gh api`.

`schemaVersion` is the contract scripts can check:

- **Adding a field doesn't change it.** Scripts should ignore fields they don't use. Each schema allows extra fields.
- **Renaming or removing a field, changing its type, or changing what a value means raises it.** The changelog names the change.
- A field a schema lists as `required` is in every success of that command. Others appear in some outcomes only (an `unchanged` result has no `cost`, for example).

Times are milliseconds since the Unix epoch (`createdAt`, `updatedAt`, `expiresAt`). Identities are base58 ids. Costs are `{ "credits", "dash", "usd", "usdPrice" }`.

Before 1.0, a minor release may still raise `schemaVersion`, so pin the `dg` version a script was written for (`DASH_FORGE_VERSION` for `install.sh`, a tag for the actions) as well as checking `schemaVersion`. From 1.0, raising it needs a major release.

## Networks and contracts

A release works with the forge-v2 contracts registered on each network, and their ids are built into the binaries and the web app. They come from [`forge-contracts/deployments/`](../forge-contracts/deployments):

- `<network>.json`, one file per network (`devnet-sakura.json`, `testnet.json`, `mainnet.json`, and so on): the contract ids, the contract group and its owner, the DAPI addresses and the quorum key endpoint. A file without a `v2` section means Forge is not deployed there, and a file marked `retired` is a network Forge has left;
- `contracts/<network>.json`: a snapshot of the registered contracts, which the web app bundles;
- `fixtures/<network>.json`: the seeded test data the end-to-end suites read.

A release works on the networks that have a live deployment in that directory at the time it is tagged. Tools from an older release do not know about a later registration. So a devnet reset, a move to a new devnet, or a re-registration of the contracts can require a new release. That happened when Forge moved to devnet sakura: tools built for the previous devnet do not work there ([Dash Forge moved to devnet sakura](guides/devnet-move.md)). On a network without a deployment, every tool stops with a "not deployed" error ([E702](errors.md#e702)) and never falls back to another network's contracts.

## How a release is cut

1. A pull request sets the new version in `Cargo.toml` and adds its section to `CHANGELOG.md`. Because it touches `Cargo.toml`, the release pipeline runs on it as a dry run.
2. After it merges, a maintainer pushes a signed tag `v<version>` on the merge commit on `master`.
3. `release.yml` builds every target from scratch, writes `SHA256SUMS`, attests the files, publishes the GitHub release with the web app's IPFS build, and pushes the `forge-relay` image. Publishing and the image push both wait for a maintainer's approval in the protected `release` environment. It refuses to publish if the tag does not match the `Cargo.toml` version or the commit is not on `master`.

[INSTALL.md](INSTALL.md#for-maintainers-cutting-a-release) has the details, including the protected `release` environment and recording the web app's build on Forge.
