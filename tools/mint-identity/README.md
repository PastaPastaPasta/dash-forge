# mint-identity

Headless testnet Dash Platform identity-minting CLI (Dash Forge spike **S0.4**).

Mints a **funded Dash Platform testnet identity** with zero browser involvement:

```
derive HD keys → get testnet DASH from the faucet → build & sign a type-8
asset-lock transaction → wait for an InstantSend lock → register the identity
on Platform → write a bridge-format identity JSON
```

It is a Node ≥ 20 ESM tool. The crypto/transaction/proof logic is ported from the
`mainnet-bridge` browser app (`src/crypto`, `src/transaction`, `src/proof`,
`src/api`, `src/platform`); Platform operations use `@dashevo/evo-sdk@4.0.0`,
which runs natively under Node.

## Install

```bash
cd tools/mint-identity
npm install
```

## Commands

### Mint one identity

```bash
node mint.mjs --out <dir> [--label OWNER] [--amount 0.5]
```

- Generates a fresh BIP39 mnemonic and the canonical 5-key identity set
  (Master AUTH/MASTER, High Auth, Critical Auth, Transfer CRITICAL, Encryption MEDIUM).
- Funds the derived deposit address from the faucet (solving the CAP
  proof-of-work headlessly — see below), waits for the UTXO, asset-locks it,
  waits for the InstantSend lock, and registers the identity.
- Writes `<dir>/<label>.identity.json` with mode `0600`.
- `--amount` is the minimum deposit (tDASH) to wait for; the asset lock locks
  the whole received UTXO minus a 1000-duff fee. The faucet currently dispenses
  a fixed ~1 tDASH regardless.

### Mint the 9-role pool

```bash
node mint.mjs pool --out <dir> [--amount 0.05]
```

Mints the full role pool: `OWNER MAINTAINER COLLAB CONTRIB FROZEN CI-RUNNER
RELAY DEPLOYER TREASURY`, writing one `<ROLE>.identity.json` per role.

**Rate-limit strategy** (the faucet allows only **3 requests/hour/IP**): the
pool command calls the faucet **once** — it funds `TREASURY`'s deposit address
with the faucet maximum (~1 tDASH). It then builds and broadcasts a single
Layer-1 P2PKH transaction that fans those funds out to the other 8 deposit
addresses (`--amount` each, default 0.05 tDASH), with the change returning to
`TREASURY`'s own deposit address (which becomes `TREASURY`'s asset-lock funding
UTXO). After the fan-out transaction InstantSend-locks, all 9 identities are
minted from their now-funded deposit UTXOs. This touches the faucet exactly
once, so the pool never trips the rate limit.

### Top up an identity

```bash
node mint.mjs topup --identity <file> [--amount 0.1]
```

Adds credits to an existing identity via the same asset-lock flow, using a
fresh one-time asset-lock key funded from the faucet, then `identities.topUp`.

### Print identity balance

```bash
node mint.mjs balance --identity <file>
```

Prints the identity's credit balance from Platform.

## Faucet & CAP proof-of-work

The faucet (`faucet.thepasta.org`) gates requests behind a **CAP** (`cap.js`)
proof-of-work captcha. CAP is pure SHA-256 hashing with **no human
interaction** — the tool solves it headlessly in Node (see `src/cap.mjs`),
typically in ~2-3 seconds. There is no browser and no manual captcha step.

If the faucet is ever unavailable or you would rather pre-fund manually, use
the skip-faucet fallback:

```bash
# Same --mnemonic across runs keeps the deposit address stable.
node mint.mjs --out <dir> --label OWNER --skip-faucet --mnemonic "<12 words>"
```

With `--skip-faucet` the tool derives and prints the deposit address, writes a
recoverable *pending* backup immediately, and then polls that address for funds
you send from any testnet wallet (up to a 5-minute window) before completing.
`--utxo-from <address>` may be supplied as an explicit guard — it must match the
derived deposit address, because the asset lock can only spend funds controlled
by the identity's own key.

## Rate-limit quick reference

| Command | Faucet calls |
|---|---|
| `mint` (one identity) | 1 |
| `pool` (9 identities) | 1 (TREASURY only; rest funded via L1 fan-out) |
| `topup` | 1 |
| `balance` | 0 |

The faucet allows 3 calls/hour/IP, so up to 3 single mints (or 1 pool + 2
mints) per hour. Beyond that, use `--skip-faucet`.

## Security notes

- **The identity JSON files contain private keys** — the BIP39 mnemonic, every
  identity key (WIF + hex), and the asset-lock key WIF. Files are written with
  `0600` permissions.
- **Never commit these files.** The repo `.gitignore` already excludes
  `*.identity.json`, `test-identities/`, and `dash-identity-*.json`.
- The live smoke-test output lives in `.smoke/` inside this tool directory and
  is likewise git-ignored via `*.identity.json`.
- These are **testnet** identities only. Do not reuse these keys or this flow on
  mainnet.

## Output format

Each `<label>.identity.json` reproduces the `mainnet-bridge` key-backup shape
(create mode):

```json
{
  "network": "testnet",
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
src/config.mjs      testnet params (addressPrefix 140, wifPrefix 239, endpoints)
src/bytes.mjs       hex / base58check / WIF helpers
src/hash.mjs        sha256 / hash256 / hash160
src/hd.mjs          BIP32/39 derivation (asset-lock BIP44, identity DIP-0013)
src/keys.mjs        key generation, P2PKH addresses, 5-key identity set
src/tx.mjs          serialization, type-8 asset-lock + standard P2PKH build/sign
src/cap.mjs         headless CAP proof-of-work solver
src/faucet.mjs      faucet client (status + core-faucet + CAP)
src/insight.mjs     Insight API (UTXO polling, broadcast, tx status)
src/islock.mjs      InstantSend lock retrieval via JSON-RPC (getislocks)
src/platform.mjs    evo-sdk register / topUp / balance
src/backup.mjs      bridge-format identity JSON writer (0600)
src/flow.mjs        mint primitives shared by the subcommands
```
