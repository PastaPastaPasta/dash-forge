# Dash Forge

**Git hosting that nobody can take down.** Refs, issues, pull requests and access control live on Dash Platform, signed by your own keys. Your code lives in storage you choose. There is no Forge server, and every read is checked against a Platform proof and a hash.

## Status

| | |
|---|---|
| **Mainnet** | Live since 2026-11-24 at **[forge.dashhq.org](https://forge.dashhq.org)**. Real DASH. |
| **Testnet** | Live at **[testnet-forge.dashhq.org](https://testnet-forge.dashhq.org)**. Free test DASH; the network can be reset. |
| **Binaries** | The latest release, [v0.2.0](https://github.com/PastaPastaPasta/dash-forge/releases/tag/v0.2.0) (2026-11-22), predates mainnet and works on **testnet only**. To use mainnet from the terminal, build from source (below). |

[Networks](docs/networks.md) has contract ids and history.

## Use it in the browser

1. Open [forge.dashhq.org](https://forge.dashhq.org) and choose **Sign in**.
2. Scan the QR code with **DashPay** for Android (11.9.2+) or **Dash Wallet** for iOS (9.1.4+). The wallet adds a *limited key* for Forge: a budget, an expiry, and usable only on Forge's contracts. No recovery phrase touches the browser. New to Dash? DashPay creates your identity and username.
3. Already signed in on another device? **Sign in with a passkey** you added there (Settings → Devices & keys).

Then **New → Repository**, and **Settings → Storage** to choose where code is kept.

## Use it from the terminal

`dg` is a `gh`-style CLI, and `git-remote-dash` lets plain git use `dash://` URLs. Build both (needs Rust and `protoc` 25+, see [BUILDING.md](docs/BUILDING.md)):

```sh
git clone https://github.com/PastaPastaPasta/dash-forge && cd dash-forge
cargo install --locked --path crates/dg
cargo install --locked --path crates/git-remote-dash
```

Sign in with your wallet, then publish a repository:

```sh
dg auth login --network mainnet --wallet   # prints a QR code: scan it in DashPay (More → Tools → Connections)
dg storage add                             # where packs go: your S3 bucket, your IPFS node, or Platform
dg init                                    # creates the repository, adds `origin`, pushes this branch
```

Clone and push with plain git: `git clone dash://<owner>/<repo>`, `git push`. Every push prints its cost first ([costs](docs/guides/costs.md)).

- **Network:** `--network mainnet` on the first sign-in makes mainnet your default for `dg` and `git`. Without it the tools use testnet (free test DASH; DashPay's testnet build).
- **v0.2.0 binaries:** `curl -fsSL https://raw.githubusercontent.com/PastaPastaPasta/dash-forge/master/install.sh | sh` installs them ([INSTALL.md](docs/INSTALL.md)). They work on testnet only and have no `--wallet`, so sign in with an identity file there.

<details>
<summary>Other ways to sign in (CI, scripts, developers)</summary>

- **CI:** a pasteable `dfk1:` runner key in `DASH_FORGE_KEY` ([CI guide](docs/guides/ci.md)).
- **Identity file:** `dg auth login <file>`, from a bridge export or `dg auth export`.
- **Recovery phrase (developers only):** `dg auth new` and `dg auth login --mnemonic` handle the 12 words on this computer. Prefer the wallet.

[Identity and keys](docs/guides/identity-and-keys.md) explains every option.
</details>

## Storage

Platform holds only the small signed records. Git packs go where you choose:

- **IPFS:** your own node. `dg ipfs up` sets one up on your computer; on a Linux server, PC or NAS with Docker, one command does it ([Run your own backend](docs/guides/self-host-backend.md)). Readers try the repository's own gateway, then [ipfs.dashhq.org](https://ipfs.dashhq.org), then public gateways. Every byte is hash-checked, so no gateway can change your code.
- **S3-compatible bucket:** a hosted bucket or a store you run, such as RustFS or Garage on a NAS ([how](docs/guides/home-nas-storage.md)).
- **Platform:** packs stored on chain, with no extra account (up to about 0.39 DASH per MiB, quoted before each push).

You can replicate packs across several of these. [Bring your own storage](docs/guides/bring-your-own-storage.md) has the setup.

## What you can do

- **Host:** branches, tags, partial clones, releases with hash-checked assets, forks and stars. jj works too ([quick start](docs/guides/quick-start.md#jj)).
- **Collaborate:** issues, labels, pull requests with reviews and real merges, and writers and maintainers enforced at consensus.
- **Keep it private:** `dg repo create --private` encrypts code, issues and PRs to members' keys. [Collaborating](docs/guides/collaborating.md#private-repositories) lists what stays visible.
- **Bring a project from GitHub:** `dg import` copies code, issues, PRs, releases and labels, and the [Mirror Action](action/README.md) keeps a copy in sync.
- **Verify:** every repository page has a Verification card ([what is checked](docs/guides/verify-forge.md)).
- **Wire up CI:** `dg webhook add` plus a relay you run (`forge-relay`) turns on-chain activity into GitHub-style webhooks.

This repository's home is GitHub. Every push to master, and every tag, is mirrored to Forge on mainnet by [forge-sync](tools/forge-sync/README.md): `git clone -c dash.network=mainnet dash://forg3/dash-forge` (`forg3` is the owner's username).

## Docs

- [Quick start](docs/guides/quick-start.md), [all guides](docs/guides/README.md), [FAQ](docs/FAQ.md), [error codes](docs/errors.md)
- [Moving from GitHub](docs/guides/moving-from-github.md) and [mirroring a GitHub repository](docs/guides/mirror-a-github-repo.md)
- [Installing binaries](docs/INSTALL.md) and [building from source](docs/BUILDING.md)

<details>
<summary>For developers</summary>

| Component | What it is |
|---|---|
| `forge-contracts` | The data contracts (forge-core, forge-collab, forge-community, forge-meta) in one contract group ([forge-v2](docs/contracts/forge-v2.md)). |
| `crates/git-remote-dash` | The git remote helper for `dash://` URLs. |
| `crates/dg` | The CLI. |
| `crates/forge-core` | The shared Rust library behind both. |
| `forge-web` | The static web app (Next.js and the Platform SDK's WebAssembly build), served from GitHub Pages or IPFS ([README](forge-web/README.md)). |
| `crates/forge-relay` | A user-run daemon that turns Platform events into webhooks ([README](crates/forge-relay/README.md)). |
| `crates/forge-import` | GitHub import and mirroring, behind `dg import` and the [Mirror Action](action/README.md). |

Build with `cargo build --workspace` (with `protoc` on `PATH`) and `pnpm install && pnpm build` in `forge-web/`. Contract ids come only from `forge-contracts/deployments/<network>.json`. Design notes: [architecture](docs/architecture.md), [economics](docs/economics.md), [limits](docs/limits.md), [deploying to a network](docs/deploying-to-a-network.md). End-to-end tests: [e2e/README.md](e2e/README.md).
</details>

## Contributing, security and license

- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md).
- **Security:** report vulnerabilities privately, as [SECURITY.md](SECURITY.md) describes, not in a public issue. Fixes are published as [security advisories](https://github.com/PastaPastaPasta/dash-forge/security/advisories).
- **Releases** are announced in [GitHub Releases](https://github.com/PastaPastaPasta/dash-forge/releases).
- **License:** [Apache-2.0](LICENSE-APACHE) or [MIT](LICENSE-MIT), at your option.
