# mint-identity

Headless Dash Platform identity-minting CLI for **testnet** and **devnets**
(Dash Forge spike **S0.4**).

Mints a **funded Dash Platform identity** with zero browser involvement:

```
derive HD keys → fund the deposit address (testnet faucet, or a devnet funding
key) → build & sign a type-8 asset-lock transaction → wait for the lock
(InstantSend on testnet, chain lock on devnets) → register the identity on
Platform → write a bridge-format identity JSON
```

It is a Node ≥ 20 ESM tool. The crypto/transaction/proof logic is ported from the
`mainnet-bridge` browser app (`src/crypto`, `src/transaction`, `src/proof`,
`src/api`, `src/platform`); Platform operations use `@dashevo/evo-sdk@4.2.0-beta.4`,
which runs natively under Node. The 4.2 SDK talks protocol 14 to devnet moutai
and still negotiates protocol 13 with testnet, so one install serves both.

## Install

```bash
cd tools/mint-identity
npm install
npm test        # offline unit tests (no network)
```

## Networks

| Flag | Network | Default funding | Lock proof |
|---|---|---|---|
| `--network testnet` (default) | public testnet, protocol 13 | `faucet` | InstantSend (islock via `getislocks` JSON-RPC) |
| `--network devnet --devnet-name moutai` | devnet moutai (`dash-devnet-moutai`), protocol 14 | `fund-from-key` | chain lock (`ChainAssetLockProof`) |

Devnets are listed in the `DEVNETS` registry in `src/config.mjs` (Insight URL,
DAPI addresses, quorum base URL, chain id). A devnet uses testnet's Core
prefixes (address 140, WIF 239, coin type 1), so deposit addresses start with `y`.

Identity files record their network (`"network": "devnet-moutai"`), so `topup`,
`balance`, `transfer` and `verify` pick the network from the file. Passing a
`--network` that disagrees with the file is an error.

### How the SDK is pointed at a devnet

`src/platform.mjs` builds the SDK from the registry entry:

```js
new EvoSDK({
  network: 'devnet',
  trusted: true,                                         // proofs verified against the quorum service
  devnetName: 'moutai',
  quorumUrl: 'https://quorums.moutai.networks.dash.org', // what devnetName alone would derive; explicit for clarity
  addresses: ['https://68.67.122.254:1443', /* ... */], // pinned DAPI nodes; skips quorum-service discovery
  settings: { connectTimeoutMs: 10000, timeoutMs: 40000, retries: 3 },
});
```

`EvoSDK.devnetTrusted('moutai')` works as well. After connecting, the tool
checks that `system.status()` reports chain id `dash-devnet-moutai`.

### Why devnets use chain-lock proofs

There is no public `getislocks` JSON-RPC for moutai (rs-dapi's JSON-RPC serves
only `getStatus`, `getBestBlockHash`, `getBlockHash`, `sendRawTransaction`), and
recovering an islock otherwise needs a DAPI bloom-filter stream opened before the
broadcast. On a devnet the tool waits for the asset-lock tx to be mined,
then waits for Platform's chain-locked Core height (`system.status()`) to reach
that block, and registers with
`AssetLockProof.createChainAssetLockProof(txBlockHeight, new OutPoint(txid, 0))`.
With moutai's 1-minute blocks this takes about 1–3 minutes. The pool command
broadcasts every asset lock first, so the whole pool pays the wait once.

Testnet uses the same path as a fallback. If the `getislocks` endpoint
(`trpc.digitalcash.dev`) times out, which happens when it rate-limits the IP with
TLS resets, the already-broadcast asset lock is proven with a chain-lock proof
instead of being stranded. Mint and top-up both record the asset-lock txid in
their pending file, so an interrupted run resumes from that tx.

## Funding modes

`--funding faucet | fund-from-key | manual`

- **`faucet`** (testnet only): `faucet.thepasta.org`, CAP proof-of-work solved
  headlessly (see below).
- **`fund-from-key`**: one standard P2PKH transaction from UTXOs a WIF controls,
  paying every deposit address that needs funds, with change back to the key's address. On devnets
  this is the network's faucet wallet key. The key is read at runtime and never
  written or logged. Only its address is printed. Give it either way:
  - `--funding-key-file <path>`: a dash-network-configs devnet YAML (its
    `faucet_privkey:` line) or a file containing just the WIF. Process
    substitution avoids a copy on disk:
    `--funding-key-file <(git -C ../dash-network-configs show origin/master:devnet-moutai.yml)`
  - `FORGE_DEVNET_FUNDING_WIF=<wif>` in the environment.

  Only outputs with ≥ 101 confirmations are spent (coinbase maturity). A
  single random output that covers the whole amount is preferred, so concurrent runs rarely
  pick the same input. A rejected broadcast retries with other inputs.
- **`manual`** (alias `--skip-faucet`): prints the deposit address and waits up
  to 5 minutes for you to fund it from any wallet.

Every mode writes a *pending* identity file (mnemonic + deposit key) before any
funds move. Rerunning with the same `--out` resumes: it does not fund an address that already holds funds, it
reuses a broadcast asset-lock txid, and it does not re-register an identity that
already exists.

## Commands

### Mint one identity

```bash
node mint.mjs --out <dir> [--label OWNER] [--amount 0.5]                  # testnet, faucet
node mint.mjs --network devnet --devnet-name moutai --out <dir> --label OWNER --amount 5 \
  --funding-key-file <path>                                               # devnet
```

- Generates a fresh BIP39 mnemonic and the canonical 5-key identity set:

  | id | purpose | security level |
  |---|---|---|
  | 0 | AUTHENTICATION | MASTER |
  | 1 | AUTHENTICATION | HIGH |
  | 2 | AUTHENTICATION | CRITICAL |
  | 3 | TRANSFER | CRITICAL |
  | 4 | ENCRYPTION | MEDIUM |

  All are `ECDSA_SECP256K1`. Key 4 is the ENCRYPTION key that PV14
  `encryptedFor` needs on the sender side, and it also serves as the recipient key
  when a contract does not require a contract-bound DECRYPTION key.
- Writes `<dir>/<label>.identity.json` with mode `0600`.
- `--amount` is the deposit in DASH. The asset lock locks the whole deposit
  UTXO minus a 1000-duff fee (1 DASH ≈ 1e11 credits). The testnet faucet
  dispenses a fixed ~1 tDASH regardless.

### Mint the 9-role pool

```bash
node mint.mjs pool --out <dir> [--amount 0.05]                           # testnet
node mint.mjs pool --network devnet --devnet-name moutai --out <dir> \
  --amount 5 --role-amounts DEPLOYER=50 --funding-key-file <path>         # devnet
make devnet-identities                                                    # the same, from the repo root
```

Mints `OWNER MAINTAINER COLLAB CONTRIB FROZEN CI-RUNNER RELAY DEPLOYER TREASURY`,
writing one `<ROLE>.identity.json` per role. `--amount` is per role (default
0.05 on testnet, 5 on devnets). `--role-amounts LABEL=DASH,...` overrides it for
specific roles.

- **Devnet (`fund-from-key`)**: one transaction from the funding key pays every
  unfunded deposit address, then every asset lock is broadcast, and all 9
  identities are registered once the chain lock arrives (~3 min in total). A rerun
  skips roles that are already minted.
- **Testnet (`faucet`)**: the faucet allows only **3 requests/hour/IP**, so the
  pool calls it **once** to fund `TREASURY`'s deposit address (~1 tDASH), then
  one L1 transaction fans those funds out to the other 8 deposit addresses,
  with change returning to `TREASURY`'s deposit address (its own asset-lock
  UTXO). This touches the faucet exactly once.

### Top up an identity

```bash
node mint.mjs topup --identity <file> [--amount 0.1] [--funding-key-file <path>]
```

Adds credits via the same asset-lock flow, using a fresh one-time asset-lock
key (persisted next to the identity file as `*.topup-pending.json` until the
top-up lands) and `identities.topUp`. It funds from the faucet on testnet and from the
funding key on devnets.

### Print identity balance

```bash
node mint.mjs balance --identity <file>
```

### Verify a directory of identities

```bash
node mint.mjs verify --dir <dir>
```

Fetches every `*.identity.json` identity from Platform (proved) and checks
that it exists, has a non-zero balance, and that its on-chain keys match the
file's key for key (id, purpose, security level, public key, not disabled),
including an ENCRYPTION key. Exits non-zero if any check fails.

### Transfer credits

```bash
node mint.mjs transfer --from <file> --to <file> [--amount 0.2]
```

## Faucet & CAP proof-of-work (testnet)

The faucet (`faucet.thepasta.org`) gates requests behind a **CAP** (`cap.js`)
proof-of-work captcha. CAP is pure SHA-256 hashing with **no human
interaction**. The tool solves it headlessly in Node (see `src/cap.mjs`),
typically in ~2-3 seconds. On a 429 it escalates to the harder hard-cap
challenge, whose token bypasses the per-IP limit.

Devnet web faucets (e.g. `faucet.moutai.networks.dash.org`) use reCAPTCHA and
cannot be used headlessly. Use `fund-from-key`.

## Rate-limit quick reference (testnet faucet)

| Command | Faucet calls |
|---|---|
| `mint` (one identity) | 1 |
| `pool` (9 identities) | 1 (TREASURY only; rest funded via L1 fan-out) |
| `topup` | 1 |
| `balance` / `verify` | 0 |

## Security notes

- **The identity JSON files contain private keys**: the BIP39 mnemonic, every
  identity key (WIF + hex), and the asset-lock key WIF. Files are written with
  `0600` permissions, in a directory created `0700`.
- **Never commit these files.** The repo `.gitignore` already excludes
  `*.identity.json`, `test-identities/`, and `dash-identity-*.json`.
- **Never commit or log a funding key.** Pass it by file or env var only.
  The tool prints only the key's address.
- These are **testnet/devnet** identities only. Do not reuse these keys or this
  flow on mainnet.

## Output format

Each `<label>.identity.json` reproduces the `mainnet-bridge` key-backup shape
(create mode):

```json
{
  "network": "testnet | devnet-moutai",
  "created": "<ISO timestamp>",
  "mode": "create",
  "depositAddress": "y...",
  "txid": "<asset-lock txid>",
  "mnemonic": "<12 words>",
  "identityId": "<base58 Platform identity id>",
  "identityKeys": [ { "id": 0, "name": "Master", "keyType": "ECDSA_SECP256K1",
    "purpose": "AUTHENTICATION", "securityLevel": "MASTER",
    "privateKeyWif": "...", "privateKeyHex": "...", "publicKeyHex": "...",
    "derivationPath": "m/9'/1'/5'/0'/0'/0'/0'" }, "... 4 more" ],
  "assetLockKey": { "wif": "...", "publicKeyHex": "...",
    "derivationPath": "m/44'/1'/0'/0/0" }
}
```

## Layout

```
mint.mjs            CLI entry + subcommand orchestration
src/config.mjs      TESTNET + DEVNETS registry, --network resolution
src/bytes.mjs       hex / base58check / WIF helpers
src/hash.mjs        sha256 / hash256 / hash160
src/hd.mjs          BIP32/39 derivation (asset-lock BIP44, identity DIP-0013)
src/keys.mjs        key generation, P2PKH addresses, 5-key identity set
src/tx.mjs          serialization, type-8 asset-lock + multi-input P2PKH build/sign
src/cap.mjs         headless CAP proof-of-work solver
src/faucet.mjs      testnet faucet client (status + core-faucet + CAP)
src/funding.mjs     fund-from-key: load the WIF, select UTXOs, pay deposit addresses
src/insight.mjs     Insight API (UTXO polling, broadcast, tx status, raw tx)
src/islock.mjs      InstantSend lock retrieval via JSON-RPC (getislocks)
src/lock.mjs        asset-lock proof data: instant (testnet) or chain (devnets)
src/platform.mjs    evo-sdk connect / register / topUp / balance / describe
src/backup.mjs      bridge-format identity JSON writer (0600)
src/flow.mjs        mint primitives shared by the subcommands
test/               offline unit tests (npm test)
```
