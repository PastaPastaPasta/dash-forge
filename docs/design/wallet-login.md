# Sign in with a mobile Dash wallet (D-L)

Status: shipped in forge-web (`lib/auth/wallet-protocol.ts`, `app-connect.ts`, `key-registration.ts`, `components/auth/wallet-connect-flow.tsx`). Verified 2026-09-26 against the wallets' sources: Dash Wallet Android `master` fedb593e4 and Dash Wallet iOS `develop` a345cc852.

## What the wallets do

Both wallets implement yappr's key exchange ("DashConnect"). Forge now speaks it byte for byte.

**Release status (checked 2026-09-26):** DashConnect is on the wallets' development branches only. It is not in Dash Wallet Android's latest release (v11.9.0; the feature landed in `086babb84`, after it) or in Dash Wallet iOS's (v9.0.2; landed in `96a46f1fc`, after it). App names: Android shows "DashPay Wallet" ("DashPay Wallet [testnet]" in the testnet build, `app_name`); iOS shows "DashPay" as of `develop` `aa079d7d0`. The release titles are "DashPay Wallet 11.9" and "Dash Wallet (iOS) v9.0.2", hence "DashPay (Dash Wallet)" in Forge's copy. So "the shipped wallets" below means the wallets' current source, not a store build.

| | Android (`ui/more/connections/`) | iOS (`Models/DashConnect/`) |
|---|---|---|
| Where it is in the app | More → Tools → Connections (`ToolsScreen.kt`, when `SUPPORTS_CONNECT`) | More → Tools → Connections (`ToolsMenuViewModel.swift`) |
| Opens `dash-key:` / `dash-st:` links | yes (`AndroidManifest.xml` intent filter on `MainActivity`) | yes (`Info.plist` `CFBundleURLSchemes`, routed by `DWURLParser` → `openDashConnect`) |
| Request (`dash-key:`) | `0x01 ‖ appEphemeralPub(33) ‖ contractId(32) ‖ labelLen(1, ≤64) ‖ label`, plain base58, `?n=<m\|t\|d>&v=1` | same; also refuses a payload longer than 67 + 64 bytes |
| Networks | testnet builds only (`checkTestnet`: `IS_TESTNET_BUILD`); the devnet flavour shows Connections, but every request is refused there | testnet; devnet only in internal builds (`WalletEnvironment.isDevnetAvailable`, `DASH_DEVNET`), with the login contract entered in Settings → Devnet Settings → DashConnect Contract ID; off on mainnet |
| Where it answers | `loginKeyResponse` in yappr's key-exchange contract `7UaqHGBJBbRLJ4fUWS45cnud8PPUugJWoGTt1SKwHJ2P` (one per owner and app contract, replaced on re-login) | same (devnet: the configured copy) |
| What it grants | one 32-byte login key, `HKDF(chainKey, identityId, "dash:login-key:v1" ‖ contractId)`: one contract per request | same |
| First-login registration (`dash-st:`) | checks the tagless IdentityUpdate adds its two derived keys, then **rebuilds** it: auth `ECDSA_HASH160` AUTHENTICATION/HIGH and enc `ECDSA_SECP256K1` ENCRYPTION/MEDIUM, **no bounds, no limits** | checks exactly those two keys and no disables, **keeps a `singleContract` bound, refuses a `contractGroup` bound**, drops any budget or expiry |
| What the approval screen shows | the app's name (the requested contract owner's profile or DPNS name; the QR label only when the owner has none), the wallet's username (DPNS label) and its identity id shortened to 7 + 5 characters (`truncateMiddle`) | same: owner's DPNS label, else the QR label (`DashConnectIdentifierFormatting.truncateMiddle`) |
| PV14 App Connect system contract `H8F9…` | not used | not used |

Neither wallet shows any code to compare with the app, and the key-exchange protocol has none. (Platform's Swift *example app* has a Bluetooth experiment with a six-digit code, `BrowserLoginKeyProtocol`; it is not part of this protocol and Forge does not use it.)

What that rules out:
- **A group-scoped grant.** The request has one 32-byte contract slot, and the wallet derives and bounds everything by it. Putting the dash-forge **group** id there (Forge's previous request) makes the Android key unbounded and makes iOS refuse the registration.
- **Two contracts in one approval.** A request names exactly one contract, and there is no multi-binding field. The App Connect "up to 8 bindings" is a response format the wallets do not produce yet.
- **Limits.** Neither wallet registers a budget or an expiry. Platform cannot add limits to a key registered without them (`IdentityKeyLimitsUpdate` only raises existing limits).

Forge's previous request also had an extra `keyIndex(u32)` between the contract id and the label. That shifted `labelLen` off byte 66, so the wallets read a zero byte as the label length and showed an empty label, and iOS refused the longer payload. It is gone.

## Design

1. **Ask for forge-core first.** The tile's request names forge-core (repositories, refs, pushes). Both wallets' current source accepts it (on testnet; see the matrix).
2. **Then one tap for forge-collab.** A session holds up to one key per Forge contract: the vault's main key, plus extra wallet grants sealed beside it (`vault-extra:` blob under the vault's derived storage key). `getSigningKeyWif(contractId)` picks the key whose on-chain bounds cover the write's contract. With none, it throws `MissingGrantError` *before signing* (nothing is broadcast or charged) and opens the sheet on **Approve issues and pull requests**. That is a second `dash-key:` for forge-collab, read only from the signed-in identity. Settings shows the same button until the grant exists.
3. **Read both response contracts**, behind one interface (`responseSources`): the legacy key-exchange contract recorded in `deployments/<key>.json` `keyExchange` (testnet: yappr's; moutai: Forge's copy `E2ykCqF8mysgjVWNMRFdMzT6X7wgnFdaV5UdohpzUkDK`) and the App Connect system contract, wherever each exists on chain. Both go through the same checks.
4. **First login registers the key (`dash-st:`)**: an unsigned, tagless IdentityUpdate adding the auth key bound to the requested contract, plus the encryption key with its proof of possession. The wallet rebuilds and signs it. Forge then waits for the auth key (whatever key id it landed under) and verifies it.
5. **Upgrade path.** When a wallet grants a key bound to the dash-forge group (with limits, through App Connect), it covers both contracts and is not flagged, so no second approval is asked. Nothing else changes.
6. **Say which wallets work, per network** (`walletSignInSupported`, the request screen's footer). On testnet the tile comes first and names DashPay (Dash Wallet), where to find the feature (More → Tools → Connections), and that it is not in a released version yet. Elsewhere the tile comes last, and the request screen says Dash Wallet support arrives with testnet, that on this devnet only an internal iOS build with the contract entered by hand can answer, and to use an identity file or create an identity instead.

### Verification (same rules for both sources)

A granted key is used only if it is: on the responder's identity, not disabled, **AUTHENTICATION / HIGH** (CRITICAL and MASTER are refused as more than Forge needs), not expired, with budget left if it has one, controlled by the decrypted private key, and **inside Forge's contracts**. Allowed bounds are forge-core, forge-collab, the current dash-forge group, or none. A key bound to another app's contract, a superseded group, or a single document type is refused. Legacy rows are re-checked for `contractId == requested contract`, so a node cannot hand over another app's response. The legacy payload must be exactly one key.

### Unlimited keys (the shipped wallets' keys)

Policy: **accept, warn, and push towards replacing the key.** A shipped wallet cannot produce anything else, and refusing its keys would mean no wallet login at all.
- The session flags `unlimited` (no budget or no expiry) and `unbounded` (Android: no contract bounds, so the key can sign on any contract). The confirm step and Settings show a persistent warning: *"This wallet key has no spending limit or expiry: anyone who copies it from this browser can spend your balance on Forge [on any Platform app]. Disabling it on chain stops it, but this wallet derives the same key every time: so once it is disabled, Forge refuses wallet sign-in for this identity."* The Forge-registered key's budget and expiry (0.05 DASH, 90 days, `BROWSER_KEY_DEFAULTS`) are promised only on the Create and Import views and, scoped to "a new or imported identity", on the tile list; never for a wallet key.
- The vault defaults to a passkey for such keys (the primary button, with a caution against a passphrase alone). A passphrase is still accepted, because whether an authenticator supports PRF is only known after trying.
- **Replace with a limited key** (Settings): the identity file or recovery phrase, once, registers the usual group-bound, budgeted, expiring key. The same master-key update disables every wallet key this browser holds, and only live HIGH keys the stored private key proves it controls. Replacing a stored wallet-key vault (or one holding wallet grants) needs it unlocked first, so those keys can be disabled; while locked, Forge refuses rather than forget keys that would stay live. (A locked vault holding only a limited Forge browser key may be replaced by a new wallet sign-in without disabling that key: it stays bounded by its budget and expiry, and a renewal from the identity file disables it.) A pasted raw key is never carried into the vault, and never counts as an unlocked vault. "Add limits" in place is impossible on Platform: `IdentityKeyLimitsUpdate` cannot add a limit a key lacks. The wallets' own route to limits is the upstream issue below.
- **Disable key on chain** (Settings): the same master-key update, without a replacement.
- **A disable is not permanent for a wallet that derives the same key again.** The login key is `HKDF(chainKey, identity, "dash:login-key:v1" ‖ contractId)`, so the next login from the same wallet derives the *same* key: it cannot give Forge a fresh one. (iOS then asks to register it again, since `missingKeyRegistrationKeys` skips disabled keys; Android treats it as already registered, since it does not check `disabledAt`. Whether Platform would accept re-adding a disabled key's data is not established.) Forge therefore refuses: if a disabled key on the identity matches the key the wallet derived, the sign-in stops with `RevokedWalletKey`. The user must sign in another way (Import): neither wallet can change the chain key it derives from (both use auth-chain index 0, `LoginKeyDerivation` `DEFAULT_KEY_INDEX` / `defaultKeyIndex`). The copy says "disabling stops it" but no longer promises it stays stopped. Upstream (d) asks for a per-app, per-rotation salt.
- WIF strings (the vault's in-memory copy, the signing path) cannot be zeroed in JavaScript. Byte buffers are zeroed: ephemeral keys, login keys, the derived auth/encryption keys, the envelope AES key, and decoded private-key bytes.

### Who answered

The response does not prove who answered: anyone who saw the QR can answer from their own identity.

**On the legacy contract (what the shipped wallets use), Forge cannot detect a second answerer.** Its unique index `(contractId, appEphemeralPubKeyHash)` holds one answer per request: the first writer wins, and the real wallet's publish is then rejected as a duplicate. Someone who photographed the QR (or an app that caught the deep link) and answers first is the identity Forge shows. The refusal of "more than one identity" only works on App Connect, whose index includes `$ownerId`.

Mitigations, all in the confirmation step and the poll:
- the full identity id, its DPNS name and when that name was registered (Platform stores no identity creation time; the name's `$createdAt` is the proxy), and a prompt to check them against the wallet's approval screen. That screen shows the username and the id shortened to its first 7 and last 5 characters (both wallets' `truncateMiddle`), so the copy asks for the username and the start and end of the id, not a character-for-character match;
- a loud warning when the identity is not the one this device already holds a key for, when it has no DPNS name, or when its name is less than a day old;
- the poll never settles on a round that could not read every source in full: a failed or cut-short read shows "Couldn't read all answer sources — retrying" and restarts the settle window, so a node cannot hide an answer by failing a read;
- on App Connect, two answers are refused; an answer whose key Forge cannot use is skipped but still counted;
- a request expires after 5 minutes, with a countdown, and the page asks the user to keep the QR private.

The real fix is upstream (e): the wallet signs the request context (`hash160(appEphemeralPub)`, contract, network) with a key of the identity it answers for, so the app can authenticate the responder instead of asking the user.

**Deep-link hijack.** On a phone the request is an `Open in DashPay (Dash Wallet)` link (`dash-key:` URI; both wallets register the scheme, see the table above). A desktop browser shows only the QR, since the wallets are phone apps. Any installed app can register the scheme, and iOS's own notes say a custom scheme carries no authenticated caller (`DashConnectDeepLink.swift`). A hijacking app learns only the ephemeral public key and the contract id. It cannot decrypt a response meant for Forge, and anything it answers is caught by the checks above: a different identity, or keys Forge would not accept. What it *can* do is answer with its own identity, which the identity confirmation is there to catch. The link carries no secret.

## Compatibility matrix

Every Dash Wallet row needs a build from the development branch: no released version has DashConnect yet (see "Release status" above).

| Wallet | Network | Works today | Notes |
|---|---|---|---|
| Dash Wallet Android (testnet build) | testnet | **Once forge-v2 is on testnet** (PV14; testnet runs protocol 13 today) | publishes to yappr's 7Uaq, which Forge reads; key lands unbounded and unlimited; forge-collab needs the second approval |
| Dash Wallet Android | moutai / devnet | No | `checkTestnet` refuses every request off testnet, and the contract id is pinned to testnet; see upstream (b) |
| Dash Wallet Android | mainnet | No | feature disabled on mainnet builds |
| Dash Wallet iOS | testnet | **Once forge-v2 is on testnet** | key lands bound to forge-core (or forge-collab), unlimited |
| Dash Wallet iOS, internal build (`DASH_DEVNET`) | moutai (devnet) | **Only with a manual override**: Settings → Devnet Settings → DashConnect Contract ID = `E2ykCqF8mysgjVWNMRFdMzT6X7wgnFdaV5UdohpzUkDK`, and a DashPay identity on moutai | shipping builds have no devnet; not run on a device in this change (see Manual test) |
| Dash Wallet iOS | mainnet | No | Connections is off on mainnet (`!WalletEnvironment.isTestNetwork`) |
| Any wallet publishing to App Connect `H8F9…` with group-bound, limited keys | moutai now, all networks at PV14 | **Yes** (unit-tested) | one approval, no warning |
| Scripted responder (`e2e/wallet-responder.mjs`, the Android/iOS logic) | moutai | **Yes**, live | vitest live test and Playwright e2e below |

## Tests

- `lib/auth/wallet-protocol.test.ts`: the request is byte-identical to the wallets' fixture (`DashConnectUriTest.kt` `SERIALIZED_REQUEST_HEX`) and parses with a port of `DashConnectUri.kt` plus the iOS ceilings (`wallet-sim.ts`); yappr's captured testnet URI parses; the wallets' key-derivation vectors (`KeyExchangeCryptoTest.kt`); legacy and multi-key envelopes; `dash-st:` framing and contents checked against the iOS rules, the encryption key's proof of possession recovered to its public key, and the tag-6 framing parsed too; scope rules; and the poll against a simulated wallet on both contracts (first and returning login, App Connect, confused deputy, other-app/CRITICAL/revoked keys, two answerers, an unusable stranger counted but not fatal, incomplete reads never settle, base58 or base64 contract ids, App Connect paging past junk, grant filtering, expiry).
- `lib/auth/wallet-session.test.ts`: per-contract key choice by scope, `MissingGrantError`, non-Forge contracts refused, a grant kept across lock/unlock and across a returning login, a group-key grant for forge-collab, a grant that does not cover the request refused, a failed grant check keeps the session, disabled grants dropped, renewal disabling every held key in the same update, locked renew/revoke refused, revoke of a wallet session.
- `lib/auth/responder-profile.test.ts`: the confirmation warnings (another stored identity, no name, a new name).
- `lib/auth/wallet-login.live.test.ts` (`FORGE_LIVE=1`, moutai): (iOS path) first login with QR #2, a forge-core repo created with the wallet's key, a star refused locally, the one-tap forge-collab grant, the star lands, a returning login without QR #2, cleanup; (Android path) the key lands unbounded and covers both contracts, and after it is disabled the next login is refused (`RevokedWalletKey`).
- `e2e/wallet-login.spec.ts` (`E2E_DEVNET=moutai E2E_WRITE=1`): the real browser from the QR text on the page (QR #2, confirmation warnings, passkey preference), Settings' grant prompt, **Star opening the grant sheet by itself**, the wallet's approval, the star landing, and the phone viewport's deep link.

## Manual test on a device

Not run in this change: no device or emulator with a DashPay identity on testnet or moutai was available here, and testnet has no forge-v2 yet.

iOS simulator, moutai (skill `run-ios-simulator`, dashwallet-ios `develop`):
1. Build and launch Dash Wallet iOS with `DASH_DEVNET` (an internal build) on devnet. In Settings → Devnet Settings, set the devnet name `moutai`, the quorum URL `https://quorums.moutai.networks.dash.org`, and the DashConnect Contract ID `E2ykCqF8mysgjVWNMRFdMzT6X7wgnFdaV5UdohpzUkDK`.
2. Create a wallet, fund it from https://faucet.moutai.networks.dash.org, and register a DashPay username (this creates the identity).
3. Serve a moutai build: `cd forge-web && NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=moutai pnpm build && node e2e/static-server.mjs --port 4321`.
4. In Safari in the simulator, open `http://<host>:4321`, then Sign in → Use my Dash wallet. Tap **Open in DashPay (Dash Wallet)** (the phone layout). Expect the wallet's approval sheet naming the forge-core contract owner's DPNS name (or "Dash Forge", the QR label, if the owner has none). Approve.
5. The page shows **One more step**. Tap **Add the key in DashPay (Dash Wallet)** (iOS asks for your PIN or biometrics; Android adds the key on opening, with no approval screen). Expect the username and the start and end of the identity id to match the wallet's approval sheet, plus the no-limit warning.
6. Confirm, protect with a passkey (or a passphrase), then Finish. Create a repo (New → Repository): it lands.
7. Star it. Expect **Approve issues and pull requests**. Approve in the wallet: one approval, plus a second `dash-st` the first time. Star again: it lands.
8. Settings → This browser's key: expect the warning, **Replace with a limited key** and **Disable key on chain**. Record screenshots of steps 4–8.

Android emulator, testnet (once forge-v2 is on testnet): install a `_testNet3` build of dash-wallet, create a DashPay identity, and repeat steps 3–8 with a testnet build of Forge, scanning the QR with the wallet's scanner (More → Tools → Connections → Scan QR). Expect the key to be reported as unbounded ("on any Platform app").

## Upstream

Drafts for dashpay/dash-wallet and dashpay/dashwallet-ios are in [`docs/upstream/`](../upstream/): (a) group-scoped grants, (b) publish to the PV14 App Connect system contract with limits, (d) a per-app, per-rotation salt in the login-key derivation so a revoked key never comes back, and (e) a signature over the request context so the app can authenticate the responder ([app-connect-responder-auth.md](../upstream/app-connect-responder-auth.md), for the App Connect spec as well); plus fixes for dropped bounds and limits in `dash-st:` and for iOS refusing group bounds.
