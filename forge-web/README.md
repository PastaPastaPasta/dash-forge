# forge-web

The Dash Forge web app: a static Next.js site with no backend. It reads Dash Platform through the Platform SDK's WebAssembly build, checks every proof in the browser, and signs writes with keys held in the browser. The same build runs at [forge.dashhq.org](https://forge.dashhq.org), from IPFS, or from any static host.

## Run it locally

You need Node 22 and pnpm 11.

```sh
pnpm install --frozen-lockfile
pnpm dev                     # http://localhost:3000
```

Or `make dev-web` from the repository root. The first page load takes a while: the SDK is about 23 MB of WebAssembly.

`pnpm dev` reads `.env.development`, which points the app at testnet. To try another network, override these variables in `.env.development.local`, which git ignores:

| Variable | What it sets |
|---|---|
| `NEXT_PUBLIC_NETWORK` | `devnet`, `testnet` or `mainnet` |
| `NEXT_PUBLIC_DEVNET_NAME` | The devnet's name |
| `NEXT_PUBLIC_DAPI_ADDRESSES` | Comma-separated DAPI nodes. Default: the list in `forge-contracts/deployments/<network>.json` |
| `NEXT_PUBLIC_QUORUM_URL` | The quorum service the app checks proofs against. Default: the network's own |

Contract ids always come from `forge-contracts/deployments/`, so a network with no file there has nothing to read.

To sign in locally, use **Sign in** and scan the QR code with DashPay. On testnet, use DashPay for Android's testnet build. Test DASH comes from the [testnet faucet](https://faucet.testnet.networks.dash.org).

## Build

```sh
pnpm build                   # static export into out/
pnpm build:ipfs              # the variant that runs from any IPFS gateway path
```

`next build` does not read `.env.development`, so set the network for a build:

```sh
NEXT_PUBLIC_NETWORK=mainnet pnpm build
```

The build is reproducible from a commit. [Verify the app you loaded](../docs/guides/verify-the-app.md) explains how a release is rebuilt and checked, and [docs/hosting.md](../docs/hosting.md) covers serving `out/` from your own host.

## Tests

```sh
pnpm typecheck
pnpm lint
pnpm test                    # vitest: unit, component and conformance tests, no network
```

`pnpm test` includes the client-rule conformance suite, which runs every case in `forge-contracts/vectors/` against the TypeScript rules in `lib/rules/`. The Rust rules run the same cases, so a rule change updates both (see [CONTRIBUTING.md](../CONTRIBUTING.md#rules-that-both-clients-share)).

Files named `*.live.test.ts` talk to a real network and are skipped unless `FORGE_LIVE=1` is set. Each file's header says which network it needs. Most still target devnet sakura, which is gone, and fail if run.

### Browser tests (Playwright)

```sh
pnpm exec playwright install --with-deps chromium   # once
E2E_NETWORK=testnet pnpm test:e2e                   # builds for testnet, serves out/ on :4321
pnpm test:e2e e2e/v2-home.spec.ts                   # one spec
```

The specs run against a local build of the app that reads live testnet. Without `E2E_NETWORK=testnet`, the suite still defaults to devnet sakura, which is gone. `E2E_SKIP_BUILD=1` serves an `out/` you already built.

- **Read-only specs** read the shared fixture and need nothing else.
- **Write specs** sign in as test identities (`OWNER.identity.json`, `COLLAB.identity.json` and so on in `E2E_IDENTITY_DIR`) and write to a copy of the fixture those identities seeded. A spec whose identities are missing skips. [CONTRIBUTING.md](../CONTRIBUTING.md#end-to-end-tests) shows how to mint identities and seed your copy.
- **Request budgets.** `e2e/page-budget.spec.ts` and `e2e/pulls-budget.spec.ts` count the Platform requests each page makes. A change that adds requests to a page has to fit its budget.

## Layout

| Path | What it holds |
|---|---|
| `app/` | Routes. Repository pages are under `app/repo/`; short URLs such as `/<owner>/<name>/issues/1` reach them through `404.html` |
| `components/` | React components, grouped by area (`repo/`, `auth/`, `storage/`, `ui/`) |
| `lib/` | Everything that isn't UI: Platform reads and writes (`sdk/`, `repo/`), the client rules (`rules/`), sealing (`private/`), page view models (`view/`) |
| `hooks/`, `contexts/` | React state: the signed-in identity, the SDK connection, private-repo sessions |
| `e2e/` | Playwright specs |
| `scripts/` | The IPFS build and its reproducible release script |
