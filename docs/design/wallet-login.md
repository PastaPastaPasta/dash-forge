# Sign in with a mobile Dash wallet (D-L)

Status: shipped in forge-web (`lib/auth/wallet-protocol.ts`, `app-connect.ts`, `key-registration.ts`, `components/auth/wallet-connect-flow.tsx`). Verified 2026-09-26 against the wallets' sources: Dash Wallet Android `master` fedb593e4 and Dash Wallet iOS `develop` a345cc852.

## What the shipped wallets do

Both wallets implement yappr's key exchange ("DashConnect"). Forge now speaks it byte for byte.

| | Android (`ui/more/connections/`) | iOS (`Models/DashConnect/`) |
|---|---|---|
| Request (`dash-key:`) | `0x01 ‖ appEphemeralPub(33) ‖ contractId(32) ‖ labelLen(1, ≤64) ‖ label`, plain base58, `?n=<m\|t\|d>&v=1` | same; also refuses a payload longer than 67 + 64 bytes |
| Networks | testnet builds only (`IS_TESTNET_BUILD`); devnet flavour exists, but the contract id is pinned to testnet | testnet, and devnet with a configurable login contract (Settings → Devnet) |
| Where it answers | `loginKeyResponse` in yappr's key-exchange contract `7UaqHGBJBbRLJ4fUWS45cnud8PPUugJWoGTt1SKwHJ2P` (one per owner and app contract, replaced on re-login) | same (devnet: the configured copy) |
| What it grants | one 32-byte login key, `HKDF(chainKey, identityId, "dash:login-key:v1" ‖ contractId)`: one contract per request | same |
| First-login registration (`dash-st:`) | checks the tagless IdentityUpdate adds its two derived keys, then **rebuilds** it: auth `ECDSA_HASH160` AUTHENTICATION/HIGH and enc `ECDSA_SECP256K1` ENCRYPTION/MEDIUM, **no bounds, no limits** | checks exactly those two keys and no disables, **keeps a `singleContract` bound, refuses a `contractGroup` bound**, drops any budget or expiry |
| Pairing code | not shown | not shown |
| PV14 App Connect system contract `H8F9…` | not used | not used |

What that rules out:
- **A group-scoped grant.** The request has one 32-byte contract slot, and the wallet derives and bounds everything by it. Putting the dash-forge **group** id there (Forge's previous request) makes the Android key unbounded and makes iOS refuse the registration.
- **Two contracts in one approval.** A request names exactly one contract, and there is no multi-binding field. The App Connect "up to 8 bindings" is a response format the wallets do not produce yet.
- **Limits.** Neither wallet registers a budget or an expiry. Platform cannot add limits to a key registered without them (`IdentityKeyLimitsUpdate` only raises existing limits).

Forge's previous request also had an extra `keyIndex(u32)` between the contract id and the label. That shifted `labelLen` off byte 66, so the wallets read a zero byte as the label length and showed an empty label, and iOS refused the longer payload. It is gone.

## Design

1. **Ask for forge-core first.** The tile's request names forge-core (repositories, refs, pushes). This works with both wallets today.
2. **Then one tap for forge-collab.** A session holds up to one key per Forge contract: the vault's main key, plus extra wallet grants sealed beside it (`vault-extra:` blob under the vault's derived storage key). `getSigningKeyWif(contractId)` picks the key whose on-chain bounds cover the write's contract. With none, it throws `MissingGrantError` *before signing* (nothing is broadcast or charged) and opens the sheet on **Approve issues and pull requests**. That is a second `dash-key:` for forge-collab, read only from the signed-in identity. Settings shows the same button until the grant exists.
3. **Read both response contracts**, behind one interface (`responseSources`): the legacy key-exchange contract recorded in `deployments/<key>.json` `keyExchange` (testnet: yappr's; moutai: Forge's copy `E2ykCqF8mysgjVWNMRFdMzT6X7wgnFdaV5UdohpzUkDK`) and the App Connect system contract, wherever each exists on chain. Both go through the same checks.
4. **First login registers the key (`dash-st:`)**: an unsigned, tagless IdentityUpdate adding the auth key bound to the requested contract, plus the encryption key with its proof of possession. The wallet rebuilds and signs it. Forge then waits for the auth key (whatever key id it landed under) and verifies it.
5. **Upgrade path.** When a wallet grants a key bound to the dash-forge group (with limits, through App Connect), it covers both contracts and is not flagged, so no second approval is asked. Nothing else changes.

### Verification (same rules for both sources)

A granted key is used only if it is: on the responder's identity, not disabled, **AUTHENTICATION / HIGH** (CRITICAL and MASTER are refused as more than Forge needs), not expired, with budget left if it has one, controlled by the decrypted private key, and **inside Forge's contracts**. Allowed bounds are forge-core, forge-collab, the current dash-forge group, or none. A key bound to another app's contract, a superseded group, or a single document type is refused. Legacy rows are re-checked for `contractId == requested contract`, so a node cannot hand over another app's response. The legacy payload must be exactly one key.

### Unlimited keys (the shipped wallets' keys)

Policy: **accept, warn, and push towards replacing the key.** A shipped wallet cannot produce anything else, and refusing its keys would mean no wallet login at all.
- The session flags `unlimited` (no budget or no expiry) and `unbounded` (Android: no contract bounds, so the key can sign on any contract). The confirm step and Settings show a persistent warning: *"This wallet key has no spending limit or expiry: anyone who copies it from this browser can spend your balance on Forge [on any Platform app]. Disabling it on chain stops it, but this wallet derives the same key every time: signing in with the wallet again would need a new wallet key."*
- The vault defaults to a passkey for such keys (the primary button, with a caution against a passphrase alone). A passphrase is still accepted, because whether an authenticator supports PRF is only known after trying.
- **Replace with a limited key** (Settings): the identity file or recovery phrase, once, registers the usual group-bound, budgeted, expiring key. The same master-key update disables every wallet key this browser holds, and only live HIGH keys the stored private key proves it controls. Replacing a stored wallet-key vault (or one holding wallet grants) needs it unlocked first, so those keys can be disabled; while locked, Forge refuses rather than forget keys that would stay live. "Add limits" in place is impossible on Platform: `IdentityKeyLimitsUpdate` cannot add a limit a key lacks. The wallets' own route to limits is the upstream issue below.
- **Disable key on chain** (Settings): the same master-key update, without a replacement.
- **A disable is not permanent for a wallet that derives the same key again.** The login key is `HKDF(chainKey, identity, "dash:login-key:v1" ‖ contractId)`, so the next login from the same wallet asks to register the *same* key, and any copy stolen before the disable would work again. Forge therefore refuses: if a disabled key on the identity matches the key the wallet derived, the sign-in stops with "your wallet would add a key you revoked". The user must sign in another way (Import) or rotate the wallet's identity key. The copy says "disabling stops it" but no longer promises it stays stopped. Upstream (d) asks for a per-app, per-rotation salt.
- WIF strings (the vault's in-memory copy, the signing path) cannot be zeroed in JavaScript. Byte buffers are zeroed: ephemeral keys, login keys, the derived auth/encryption keys, the envelope AES key, and decoded private-key bytes.

### Who answered

The response does not prove who answered: anyone who saw the QR can answer from their own identity.

**On the legacy contract (what the shipped wallets use), Forge cannot detect a second answerer.** Its unique index `(contractId, appEphemeralPubKeyHash)` holds one answer per request: the first writer wins, and the real wallet's publish is then rejected as a duplicate. Someone who photographed the QR (or an app that caught the deep link) and answers first is the identity Forge shows. The refusal of "more than one identity" only works on App Connect, whose index includes `$ownerId`.

Mitigations, all in the confirmation step and the poll:
- the full identity id, its DPNS name and when that name was registered (Platform stores no identity creation time; the name's `$createdAt` is the proxy), and "Your wallet shows the identity it signed in with: check it matches, character for character" (the same on a phone);
- a loud warning when the identity is not the one this device already holds a key for, when it has no DPNS name, or when its name is less than a day old;
- the poll never settles on a round that could not read every source in full: a failed or cut-short read shows "Couldn't read all answer sources — retrying" and restarts the settle window, so a node cannot hide an answer by failing a read;
- on App Connect, two answers are refused; an answer whose key Forge cannot use is skipped but still counted;
- a request expires after 5 minutes, with a countdown; the QR must stay private (the pairing code is public, derived from the request's public key);
- the pairing code (Platform's `BrowserLoginKeyProtocol.pairingCode`) is shown for wallets that display it; the shipped ones do not.

The real fix is upstream (e): the wallet signs the request context (`hash160(appEphemeralPub)`, contract, network) with a key of the identity it answers for, so the app can authenticate the responder instead of asking the user.

**Deep-link hijack.** On a phone the request is an `Open in Dash Wallet` link (`dash-key:` URI). Any installed app can register the scheme, and iOS's own notes say a custom scheme carries no authenticated caller. A hijacking app learns only the ephemeral public key and the contract id. It cannot decrypt a response meant for Forge, and anything it answers is caught by the checks above: a different identity, or keys Forge would not accept. What it *can* do is answer with its own identity, which the identity confirmation is there to catch. The link carries no secret.

## Compatibility matrix

| Wallet | Network | Works today | Notes |
|---|---|---|---|
| Dash Wallet Android (testnet build) | testnet | **Once forge-v2 is on testnet** (PV14; testnet runs protocol 13 today) | publishes to yappr's 7Uaq, which Forge reads; key lands unbounded and unlimited; forge-collab needs the second approval |
| Dash Wallet Android | moutai / devnet | No | the wallet pins the testnet contract id; see upstream (b) |
| Dash Wallet Android | mainnet | No | feature disabled on mainnet builds |
| Dash Wallet iOS | testnet | **Once forge-v2 is on testnet** | key lands bound to forge-core (or forge-collab), unlimited |
| Dash Wallet iOS | moutai (devnet) | **Yes**, with Settings → Devnet → DashConnect login contract = `E2ykCqF8mysgjVWNMRFdMzT6X7wgnFdaV5UdohpzUkDK` and a DashPay identity on moutai | not run on a device in this change (see Manual test) |
| Any wallet publishing to App Connect `H8F9…` with group-bound, limited keys | moutai now, all networks at PV14 | **Yes** (unit-tested) | one approval, no warning |
| Scripted responder (`e2e/wallet-responder.mjs`, the Android/iOS logic) | moutai | **Yes**, live | vitest live test and Playwright e2e below |

## Tests

- `lib/auth/wallet-protocol.test.ts`: the request is byte-identical to the wallets' fixture (`DashConnectUriTest.kt` `SERIALIZED_REQUEST_HEX`) and parses with a port of `DashConnectUri.kt` plus the iOS ceilings (`wallet-sim.ts`); yappr's captured testnet URI parses; the wallets' key-derivation vectors (`KeyExchangeCryptoTest.kt`); legacy and multi-key envelopes; `dash-st:` framing and contents checked against the iOS validation rules; scope rules; and the poll against a simulated wallet on both contracts (first login, returning login, App Connect, confused deputy, other-app/CRITICAL/disabled keys, two answerers, foreign ciphertext, grant for the signed-in identity, expiry).
- `lib/auth/wallet-session.test.ts`: per-contract key selection, `MissingGrantError`, a second grant sealed and restored across lock/unlock, grants dropped when disabled on chain, group keys, other apps' keys refused.
- `lib/auth/wallet-login.live.test.ts` (`FORGE_LIVE=1`, moutai): first login with QR #2, a forge-core repo created with the wallet's key, a star refused locally, the one-tap forge-collab grant, the star lands, a returning login without QR #2, then cleanup.
- `e2e/wallet-login.spec.ts` (`E2E_DEVNET=moutai E2E_WRITE=1`): the same in a real browser, from the QR text on the page, and the phone viewport's deep link.

## Manual test on a device

Not run in this change: no device or emulator with a DashPay identity on testnet or moutai was available here, and testnet has no forge-v2 yet.

iOS simulator, moutai (skill `run-ios-simulator`, dashwallet-ios `develop`):
1. Build and launch Dash Wallet iOS on devnet. In Settings → Devnet, set the devnet name `moutai`, the quorum URL `https://quorums.moutai.networks.dash.org`, and the DashConnect login contract `E2ykCqF8mysgjVWNMRFdMzT6X7wgnFdaV5UdohpzUkDK`.
2. Create a wallet, fund it from https://faucet.moutai.networks.dash.org, and register a DashPay username (this creates the identity).
3. Serve a moutai build: `cd forge-web && NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=moutai pnpm build && node e2e/static-server.mjs --port 4321`.
4. In Safari in the simulator, open `http://<host>:4321`, then Sign in → Use my Dash wallet. Tap **Open in Dash Wallet** (the phone layout). Expect the wallet's approval sheet naming "Dash Forge". Approve.
5. The page shows **One more step**. Tap **Add the key in Dash Wallet** and approve. Expect the identity id to match the wallet's, plus the no-limit warning.
6. Confirm, protect with a passkey (or a passphrase), then Finish. Create a repo (New → Repository): it lands.
7. Star it. Expect **Approve issues and pull requests**. Approve in the wallet: one approval, plus a second `dash-st` the first time. Star again: it lands.
8. Settings → Keys: expect the warning, **Replace with a limited key** and **Disable key on chain**. Record screenshots of steps 4–8.

Android emulator, testnet (once forge-v2 is on testnet): install a `_testNet3` build of dash-wallet, create a DashPay identity, and repeat steps 3–8 with a testnet build of Forge, scanning the QR with the wallet's scanner (More → Connections → Scan). Expect the key to be reported as unbounded ("on any Platform app").

## Upstream

Drafts for dashpay/dash-wallet and dashpay/dashwallet-ios are in [`docs/upstream/`](../upstream/): (a) group-scoped grants, (b) publish to the PV14 App Connect system contract with limits, (c) show the pairing code, (d) a per-app, per-rotation salt in the login-key derivation so a revoked key never comes back, and (e) a signature over the request context so the app can authenticate the responder ([app-connect-responder-auth.md](../upstream/app-connect-responder-auth.md), for the App Connect spec as well); plus fixes for dropped bounds and limits in `dash-st:` and for iOS refusing group bounds.
