# Docs audit 2026-11-25: install lane

Scope: README, install, build from source, release notes, networks and project-level docs, checked against `origin/master` at 1b547336, the v0.2.0 release assets and the live sites.

Evidence key:

- **cleanroom**: a boat.dev Ubuntu 24.04 sandbox. It cloned `master` from GitHub and followed README/INSTALL/BUILDING literally.
- **docker**: `ubuntu:24.04` inside that sandbox, with only `curl git ca-certificates unzip` installed first. Packages were then added one step at a time.
- **v0.2.0 dg**: `dash-forge-0.2.0-x86_64-unknown-linux-gnu.tar.gz`, downloaded and checked against `SHA256SUMS`.
- **master dg**: `dg` built from 1b547336. Both were run with an empty `HOME`.

## Answer to the lane's key question

There is no mainnet binary release. On mainnet, a terminal user builds `dg` and `git-remote-dash` from source (`cargo install --locked --path crates/dg` and `crates/git-remote-dash` from a `master` clone). On Linux that also needs `build-essential pkg-config libssl-dev` and protoc ≥ 25 from GitHub. Ubuntu's protoc 3.21 fails. Then sign in with `dg auth login --network mainnet --wallet`.

- `install.sh` and `cargo binstall` install v0.2.0, and `dg --version` there prints `mainnet  not deployed`.
- A source build also reports `dg 0.2.0`. Only the contracts list in `dg --version` (mainnet `H5gXhG…`) tells it apart from the release.
- Before this PR, the docs listed only Rust and protoc as prerequisites.

## Audit table

| # | Claim (short quote) | Location | Verdict | Evidence |
|---|---|---|---|---|
| 1 | "Mainnet: Live since 2026-11-24 at forge.dashhq.org" | README.md:9 | ok | `https://forge.dashhq.org/forge-manifest.json`: `"network": "mainnet"`, commit 1b547336 |
| 2 | "Testnet: Live at testnet-forge.dashhq.org" | README.md:10 | ok | `https://testnet-forge.dashhq.org/forge-manifest.json`: `"network": "testnet"` |
| 3 | "v0.2.0 … works on testnet only. To use mainnet from the terminal, build from source" | README.md:11 | ok; now says there is no mainnet release yet | v0.2.0 dg: `dg --version` lists `mainnet not deployed`; `dg --network mainnet doctor` ✗ "forge-v2 isn't deployed on mainnet yet" |
| 4 | "Build both (needs Rust and `protoc` 25+)" | README.md:25, INSTALL.md (Build from source), CONTRIBUTING.md:19 | missing (fixed) | docker: with protoc 28.3 + rustup + build-essential the build stops in `openssl-sys`: "Could not find openssl via pkg-config … The pkg-config command could not be found"; after `apt-get install pkg-config libssl-dev`, `Installed package dg v0.2.0` |
| 5 | `cargo install --locked --path crates/dg` / `crates/git-remote-dash` | README.md:28-30, INSTALL.md | ok | cleanroom and docker: `Installed package dg v0.2.0`; git-remote-dash installed |
| 6 | "`dg auth login --network mainnet --wallet` prints a QR code: scan it in DashPay (More → Tools → Connections)" | README.md:36 | ok | `crates/dg/src/auth/wallet.rs:49`; `--network` on login records the default: `crates/dg/src/auth/store.rs:383` |
| 7 | "Without it the tools use testnet" | README.md:43, networks.md:12 | ok | `crates/forge-core/src/network.rs:975` (`(None, None) => "testnet"`); master dg `dg doctor`: "testnet, the default" |
| 8 | "v0.2.0 binaries … have no `--wallet`" | README.md:44 | ok | v0.2.0 dg `dg auth login --help`: no `--wallet` |
| 9 | "DashPay for Android (11.9.2+) or Dash Wallet for iOS (9.1.4+)" | README.md:18 | ok | `forge-web/components/login-modal.tsx:346-350` |
| 10 | "Platform … up to about 0.39 DASH per MiB" | README.md:62 | ok | master dg `dg doctor`: "~0.39 DASH/MiB" |
| 11 | "Readers try the repository's own gateway, then ipfs.dashhq.org, then public gateways" | README.md:60 | deferred (storage lane) | #702 |
| 12 | `git clone -c dash.network=mainnet dash://forg3/dash-forge` | README.md:75 | ok | cleanroom, source-built `git-remote-dash`: clone succeeded, `git log -1` = 1b547336 (the master merge of #729) |
| 13 | "Build with `cargo build --workspace` (with `protoc` on `PATH`)" | README.md:96 | missing (fixed) | same as #4; now links BUILDING prerequisites |
| 14 | "Every release … ships prebuilt binaries … Each archive contains" (table without README/INSTALL) | INSTALL.md:19-31 | missing (fixed) | `tar -tzf dash-forge-0.2.0-x86_64-unknown-linux-gnu.tar.gz`: also `INSTALL.md`, `README.md` |
| 15 | Supported platforms: five targets; "Windows: use WSL" | INSTALL.md:33-50 | stale (fixed) | v0.2.0 assets include `dash-forge-0.2.0-x86_64-pc-windows-msvc.zip`; `release.yml:273` builds it; install.sh:107 and :286 refuse Windows. Kept WSL as the advice, noted the untested zip |
| 16 | "Make sure all six targets are green" vs five listed | INSTALL.md (maintainers) | stale (fixed) | `release.yml:252-274` six matrix targets |
| 17 | install.sh: detects OS/CPU/libc, downloads latest `SHA256SUMS`, checks sha256, `gh attestation verify` when available, test-runs `dg`, installs to `~/.local/bin`, never sudo | INSTALL.md:56-80 | ok | `install.sh:80-110, 281-330`; cleanroom: `curl … install.sh \| DASH_FORGE_INSTALL_DIR=/tmp/ibin sh` fetched latest SHA256SUMS → v0.2.0, "Checksum verified", said provenance was not checked without gh, installed dg + git-remote-dash, warned that another dg comes first on PATH |
| 18 | `DASH_FORGE_*` variables table | INSTALL.md:82-90 | ok | `install.sh:15-30` header and option handling |
| 19 | "dg --version # dg 0.2.0 (<commit> <target>)" | INSTALL.md:100 | missing (fixed) | it also prints the Forge contracts per network; v0.2.0 shows `mainnet not deployed` |
| 20 | `cargo binstall --git … dg git-remote-dash` uses the release archives | INSTALL.md:142-150 | ok | `crates/dg/Cargo.toml:68-71`, `crates/git-remote-dash/Cargo.toml:37-44`; master `Cargo.toml` version 0.2.0 → v0.2.0 archives (testnet only) |
| 21 | Build from source: "You need Rust … and `protoc` 25 or newer" | INSTALL.md (Build from source) | missing (fixed) | #4; also added the mainnet sign-in step and that a source build also says 0.2.0 |
| 22 | "Approve three times" (`publish`, relay image, gateway image) | INSTALL.md (maintainers) | ok | `release.yml:719, 810, 870` (`environment: release`) |
| 23 | "prebuilt binaries for Linux, macOS and Windows come with every release" | BUILDING.md:3 | wrong (fixed) | INSTALL documents only Linux/macOS; Windows zip untested; and the release is testnet only |
| 24 | `cargo build --workspace # Rust: forge-core, git-remote-dash, dg, forge-relay, forge-import` | BUILDING.md:11 | stale (fixed) | `Cargo.toml:3-12` members also include forge-runner, forge-secrets, forge-gateway, forge-notify |
| 25 | Prerequisites table: Rust, protoc, Node, pnpm | BUILDING.md:17-22 | missing (fixed) | #4: C compiler, pkg-config, OpenSSL headers on Linux; added rustup link |
| 26 | "pinned Platform packages (v5.0.0-beta.1)" | BUILDING.md:19 | wrong (fixed) | `Cargo.toml:52-73` tag `v5.0.0-rc.8`; `forge-web/package.json:30-31` `5.0.0-rc.8` |
| 27 | Ubuntu's protoc 3.21 fails: "failed to parse protoc version libprotoc 3.21.12" | BUILDING.md:36-46 | ok | cleanroom step B: exactly that error |
| 28 | protoc 28.3 zip install recipe | BUILDING.md:53-58 | ok | cleanroom step C and docker: `libprotoc 28.3`, the build then passes `tenderdash-proto` |
| 29 | "Without it the whole workspace fails … protoc not found in PATH" | BUILDING.md:24-30 | ok | cleanroom step A |
| 30 | "rustup installs the pinned toolchain automatically" | BUILDING.md:62-66 | ok | docker: rustup with `--default-toolchain none`; the first `cargo install` in the clone installed 1.98.0 |
| 31 | "Protocol versions (SDK v4.2) … `v5.0.0-beta.1` … protocol 13 (mainnet)" | BUILDING.md:134-138 | stale (fixed) | SDK pin rc.8 (#26); master dg `dg --network mainnet doctor`: "protocol version 14 (from a proof-verified response)" |
| 32 | "Mainnet still runs protocol 13; forge-v2 is registered there after protocol 14 activates" | BUILDING.md:175-180 | wrong (fixed) | `forge-contracts/deployments/mainnet.json` v2 all `registered`, group `H5gXhG…`; mainnet doctor ✓ forge-v2 |
| 33 | "forge.dashhq.org … `PAGES_NETWORK` (default testnet), and shows 'testnet'" | BUILDING.md:269-273 | wrong (fixed) | live manifest network=mainnet (#1); `pages-testnet.yml:65-66` builds testnet-forge |
| 34 | "Mainnet keeps the SDK's built-in seeds" | BUILDING.md:247 | ok | master dg mainnet doctor: "DAPI: built-in seed list" (`mainnet.json` has 167 `dapiAddresses`, unused by Rust) |
| 35 | "`make e2e` — the CLI suite (… 11 scenarios)" | BUILDING.md:350 | stale (fixed) | `ls e2e/cli/scenarios` → 37 |
| 36 | tenderdash archive `v1.5.3`; "version comes from `TENDERDASH_COMMITISH`" | BUILDING.md:379-385 | stale (fixed) | rs-tenderdash-abci v1.8.0 `proto/build.rs:7` `DEFAULT_VERSION = "v1.8.0"` (env var overrides) |
| 37 | dash.site build section | BUILDING.md:287-313 | deferred (dash-sites lane) | wording already says "copy", not "gateway" |
| 38 | Network precedence for dg / git-remote-dash | BUILDING.md:214-235 | ok (spot check) | `dg doctor` names the chooser ("from the command line", "the default"); #698 env warning is documented |
| 39 | Release notes v0.2.0 asset table (6 archives, CAR, CID, manifest, SHA256SUMS) | docs/releases/v0.2.0.md:93-104 | ok | `gh release view v0.2.0` assets match exactly; `sha256sum --check` OK for the gnu archive and `.cid` |
| 40 | "forge-web-0.2.0.cid" CID | release body | ok | file content `bafybeiagoqvgg642b253tcf7o4ij462xdvpg3w7w5dsdwcpuk4aknlrua4` = release body |
| 41 | Archive contents list in release notes (dg, git-remote-dash, relay, import, runner, completions, README, INSTALL, licenses) | docs/releases/v0.2.0.md:106-113 | ok | `tar -tzf` of the gnu archive |
| 42 | "The hosted web app at forge.dashhq.org runs on testnet"; "Mainnet: No" | docs/releases/v0.2.0.md:48-49 | stale (banner added) | true at release; added a "Since this release" note instead of rewriting history |
| 43 | Mainnet row: chain id `evo1`, protocol 14, group `H5gXhG…` | docs/networks.md:9 | ok | `mainnet.json` `chainId: evo1`, `v2.contractGroup.id`; mainnet doctor protocol 14 |
| 44 | Testnet row: `dash-testnet-51`, group `EXgzBM…` | docs/networks.md:10 | ok | `testnet.json` |
| 45 | forge-user (testnet only) not mentioned | docs/networks.md | missing (fixed) | `testnet.json` `user.contractId 46phmE…`, `deployedAt 2026-11-25`; `mainnet.json` has no `user` |
| 46 | `forge-relay` image only; "Publishing and the image push both wait for … approval" | docs/VERSIONING.md:10, :53 | stale (fixed) | `release.yml:713-870`: relay and gateway image pushes plus publish, each `environment: release` |
| 47 | "`make dev-web` … reading devnet sakura" | CONTRIBUTING.md:79, Makefile:32 | wrong (fixed) | `forge-web/.env.development`: `NEXT_PUBLIC_NETWORK=testnet` |
| 48 | "contracts on devnet sakura are frozen"; e2e against sakura, sakura faucet | CONTRIBUTING.md:103-122 | stale (fixed) | sakura down since 2026-10-24 (networks.md); rewritten for testnet with `E2E_LIVE_TARGET=1` (`e2e/cli/config.sh:41-47, 91-93`), `mint.mjs --network testnet --funding manual` (`tools/mint-identity/mint.mjs:4, 164`) |
| 49 | "hosted gateway: git-forge.dashhq.org, which serves public repositories" | SECURITY.md:37 | stale (fixed) | `https://git-forge.dashhq.org/readyz`: `"network":"testnet"` |
| 50 | security.txt on the web app and the gateway | SECURITY.md:9 | ok | both URLs return 200 |
| 51 | "Forge runs on Dash Platform mainnet and testnet (protocol 14)" | SECURITY.md:24 | ok | #43/#44 |
| 52 | `pnpm dev` reads `.env.development` → testnet; Node 22, pnpm 11 | forge-web/README.md:7, :16 | ok | `.env.development`; `ci.yml:100-106` |
| 53 | Playwright default still devnet sakura | forge-web/README.md:64, e2e/README.md:8 | ok (says so) | `forge-web/playwright.config.ts:11` |
| 54 | "`cli/run.sh` … run against **live devnet sakura**" | e2e/README.md:3 | stale (fixed) | sakura down; line 8 already says to use testnet |
| 55 | Mirror Action: default network testnet; mainnet needs `install: 'source'` at `44691a33c` or later | action/README.md:7, :77 | ok | `action/action.yml:24-26`; `44691a33` "wire the mainnet registration into the clients", ancestor of master |
| 56 | check action: version 0.2.0, testnet default, mainnet needs source build | check-action/README.md:36-68 | ok | `check-action/action.yml:45-56` |
| 57 | Guides index links `pin-and-fork.md`, `organizations.md` | docs/guides/README.md:16, :18 | wrong (fixed) | not in `forge-web/lib/docs/catalog.ts`, so the docs site sent them to GitHub; `https://forge.dashhq.org/docs/pin-and-fork/` → 404. Added both to the catalog |
| 58 | Guides index links `rotate-storage-credentials.md` (not in the catalog) | docs/guides/README.md:12 | deferred | maintainer storage sharing is being changed in another thread; `forge-web/lib/docs-links.ts:37` links it on GitHub on purpose |
| 59 | Catalog page `devnet-move` not linked from the index | docs/guides/README.md | missing (fixed) | catalog.ts "Bring your code"; added to "Also" |
| 60 | Every other index link resolves to a catalog slug; every catalog page reachable | docs/guides/README.md, catalog.ts | ok | `pnpm exec vitest run lib/docs/` 9/9 after the change (checks every relative link) |
| 61 | "v0.2.0 binaries work on testnet only and have no `--wallet`" | docs/guides/README.md:55 | ok (linked build from source) | #3, #8 |
| 62 | Wallet sign-in versions and testnet build | docs/guides/README.md:51 | deferred (guides-identity lane) | — |
| 63 | "no wiki, discussions, organizations or global search" | docs/FAQ.md:83 | stale (fixed) | organizations exist on testnet (#723; `dg org --help`) |
| 64 | "Projects and boards: later" | docs/FAQ.md:93 | wrong (fixed) | boards shipped in v0.2.0 (CHANGELOG 0.2.0 "Boards in the web app", `dg board`) |
| 65 | "Teams … Use an organization identity (collaborating.md#organizations)" | docs/FAQ.md:95 | stale (fixed) | links the organizations guide (testnet) |
| 66 | "served from GitHub Pages at forge.dashhq.org" | docs/FAQ.md:9 | ok, testnet site added | `server: GitHub.com` on both hosts |
| 67 | "Is it on mainnet? Yes, since 2026-11-24" | docs/FAQ.md:57-64 | ok | #1 |
| 68 | `dg ipfs up` "prints a link and a code" | docs/FAQ.md:127 | ok | master `dg ipfs up --help`: `--open  Also open the connection link in a browser` (#727) |
| 69 | Roadmap Phase 6a "[ ] Register … on testnet"; Phase 6 "[ ] owner registers … mainnet" | docs/roadmap.md:192, :197 | stale (fixed) | testnet 2026-10-26, mainnet 2026-11-24 (#700); self-hosting row marked partial (forge-sync mirrors GitHub → Forge) |
| 70 | BACKLOG status lines | BACKLOG.md | ok (no status claim contradicted) | items are TODO/Done notes on importer and blame; nothing found contradicting master |
| 71 | CHANGELOG Unreleased covers master since v0.2.0 | CHANGELOG.md:9-69 | missing (fixed) | `git log --first-parent v0.2.0..origin/master`: 75 merged PRs; ~35 user-visible ones had no entry (#649, #650, #653, #655, #658/#659, #662, #666, #668, #669, #671, #678, #686, #687, #691-#698, #700-#702, #708, #709, #717, #719, #720, #722-#729). Two `### Fixed` headings merged into one, and sections put in Keep a Changelog order |
| 72 | Maintainer storage sharing (#729 part 2) | CHANGELOG, guides | deferred | another thread is changing it; the new CHANGELOG entry for #729 covers only your own devices |
| 73 | Lane rule: dash.site called "static site", publishing via dash.site/new | lane files | ok | no "gateway" wording for dash.site and no `/publish` link in this lane's files |
| 74 | Dual stack in hosting text | lane files | ok | no IPv4-only instructions in this lane's files |
| 75 | In-app help link `DOCS.selfHost` (Pin button) | forge-web/lib/docs-links.ts:39 | stale (other lane) | it points at `self-host-backend.md` on GitHub, though the catalog serves it as `/docs/self-host-backend/` (`DOCS.selfHostBackend`); left for the webcopy-repo lane |

## Product questions

1. **No mainnet binaries.** Mainnet is live, but `install.sh`, `cargo binstall`, the Mirror Action and the check action all install v0.2.0, which is testnet only. Every mainnet terminal user, and every mainnet Action user, has to build from source. That needs protoc from GitHub plus system packages. Cutting the mainnet release (PR #688, still a draft) is the owner's call, and it is the fix.
2. **A source build from master reports `dg 0.2.0`,** the same version as the testnet-only release. Only the contracts list in `dg --version` tells them apart. `dg doctor` and bug reports can't distinguish them by version. Bump `Cargo.toml` to a pre-release version (for example `0.3.0-dev`) on master?
3. **`install.sh` on a mainnet user's machine.** It installs v0.2.0 silently, and the first mainnet command fails with "not deployed". Should the script, or the `dg` it installs, say up front that this release is testnet only?
4. **The e2e defaults still name devnet sakura** (`e2e/cli/config.sh:41-43`, `forge-web/e2e/network.ts`), which has been down since 2026-10-24. The docs now say to pass testnet. Should the defaults change? That is a behavior change, so it was not made here.
5. **Windows zip.** Every release builds and publishes an untested `x86_64-pc-windows-msvc` zip, while the docs say to use WSL. Keep publishing it, label it experimental in the release notes, or drop it from the matrix?
6. **`docs/guides/collaborating.md#organizations`** still says "Forge has no organization accounts" and describes the single-identity workaround. It now contradicts `organizations.md` (testnet). That file belongs to another lane; flagged here.
7. **`rotate-storage-credentials.md`** is linked from the guides index but is not in the docs catalog, so it opens on GitHub. It is left as is until the maintainer-storage change lands.
