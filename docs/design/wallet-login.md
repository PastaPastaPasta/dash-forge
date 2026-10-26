# Sign in with a mobile Dash wallet (D-L)

Status: shipped in forge-web (`lib/auth/wallet-protocol.ts`, `app-connect.ts`, `key-registration.ts`, `components/auth/wallet-connect-flow.tsx`). Verified 2026-09-26 against the wallets' sources: Dash Wallet Android `master` fedb593e4 and Dash Wallet iOS `develop` a345cc852. Those sections describe the **older exchange (v1, DashConnect)**. App Connect v2, which asks for one key for all of Forge, is described in [its own section](#app-connect-v2-one-approval-for-all-of-forge) below; we know of no released wallet that speaks it yet.

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
2. **Then one approval per further contract, asked in one sequence.** A session holds up to one key per Forge contract (forge-core, forge-collab, forge-community, and forge-meta on a four-contract set): the vault's main key, plus extra wallet grants sealed beside it (`vault-extra:` blob under the vault's derived storage key). `getSigningKeyWif(contractId)` picks the key whose on-chain bounds cover the write's contract. With none, it throws `MissingGrantError` *before signing* (nothing is broadcast or charged), and the write's guard opens the sheet on the grant for **that** contract: **Approve issues and pull requests** (forge-collab) or **Approve stars, watches and follows** (forge-community). Each is one more `dash-key:` for that contract, read only from the signed-in identity. The first sign-in does not leave that to a refused write: when it finishes, the sheet asks for every contract the wallet has not covered, in order (forge-collab, forge-community, then forge-meta), as "Step 2 of 3: approve Forge collaboration" (`lib/auth/guided-grants.ts`). The user can skip a step or the rest, and a skipped grant keeps the on-demand behaviour above. Settings shows the button for the next missing grant until all exist. A wallet whose key is unbounded (Android) covers every contract at once and the sequence does not start. So the honest statement is **one approval per Forge contract until wallets grant group-bound keys**, not one QR code.
3. **Read both response contracts**, behind one interface (`responseSources`): the legacy key-exchange contract recorded in `deployments/<key>.json` `keyExchange` (testnet: yappr's; a devnet: Forge's copy from `deploy-key-exchange.mjs`, on bonsia `4avwgxyfhPjtiTTNwkz9ei7bYTHG5NUUtwNx9mA8Uzwh`) and the App Connect system contract, wherever each exists on chain. Both go through the same checks.
4. **First login registers the key (`dash-st:`)**: an unsigned, tagless IdentityUpdate adding the auth key bound to the requested contract, plus the encryption key with its proof of possession. The wallet rebuilds and signs it. Forge then waits for the auth key (whatever key id it landed under) and verifies it.
5. **Upgrade path.** When a wallet grants a key bound to the dash-forge group (with limits, through App Connect), it covers every Forge contract and is not flagged, so no further approval is asked and the guided sequence does not start. That is the v2 flow below, which is now offered first where it is available; this section's v1 flow stays behind "Show the older code".
6. **Say which wallets work, per network** (`walletSignInSupported`, the request screen's footer). Where App Connect v2 is on offer the tile comes first on any network (see below). On testnet the tile comes first and names DashPay (Dash Wallet), where to find the feature (More → Tools → Connections), and that it is not in a released version yet. Elsewhere the tile comes last, and the request screen says Dash Wallet support arrives with testnet, that on this devnet only an internal iOS build with the contract entered by hand can answer, and to use an identity file or create an identity instead.
7. **Tell the user where to scan (SECU-08).** The request binds nothing about who shows it (no origin or domain, here or in App Connect), so a lookalike page can show a code with Forge's contract id and the label "Dash Forge", and the wallet's approval screen cannot tell it from this one. The request step therefore opens with "Scan only a code shown on forge.dashhq.org" (the build's own address, `lib/site.ts`), that Forge never asks for a code it didn't show, what an approval grants (a key that signs as the identity with no budget or expiry unless the wallet sets one, which today's wallets don't, and the encryption key that opens private and members-only content), and what to do after scanning an untrusted code (Settings → Devices & keys → Disable all other keys, then replace the encryption key; docs/guides/revoke-keys.md). This is copy only: how the login derives and delivers the encryption key is unchanged (D27). Origin binding in the request needs the upstream wallet work in `docs/upstream/`.

### Verification (same rules for both sources)

A granted key is used only if it is: on the responder's identity, not disabled, **AUTHENTICATION / HIGH** (CRITICAL and MASTER are refused as more than Forge needs), not expired, with budget left if it has one, controlled by the decrypted private key, and **inside Forge's contracts**. Allowed bounds are forge-core, forge-collab, forge-community, the current dash-forge group, or none. A key bound to another app's contract, a superseded group, or a single document type is refused. Legacy rows are re-checked for `contractId == requested contract`, so a node cannot hand over another app's response. The legacy payload must be exactly one key.

### Unlimited keys (the shipped wallets' keys)

Policy: **accept, warn, and push towards replacing the key.** A shipped wallet cannot produce anything else, and refusing its keys would mean no wallet login at all.
- The session flags `unlimited` (no budget or no expiry) and `unbounded` (Android: no contract bounds, so the key can sign on any contract). The confirm step and Settings show a persistent warning: *"This wallet key has no spending limit or expiry: anyone who copies it from this browser can spend your balance on Forge [on any Platform app]. Disabling it on chain stops it, but this wallet derives the same key every time: so once it is disabled, Forge refuses wallet sign-in for this identity."* The Forge-registered key's budget and expiry (0.05 DASH, 90 days, `BROWSER_KEY_DEFAULTS`) are promised only on the Create and Import views and, scoped to "a new or imported identity", on the tile list; never for a wallet key.
- The vault defaults to a passkey for such keys (the primary button, with a caution against a passphrase alone). A passphrase is still accepted, because whether an authenticator supports PRF is only known after trying.
- **Replace with a limited key** (Settings): the identity file or recovery phrase, once, registers the usual group-bound, budgeted, expiring key. The same master-key update disables every wallet key this browser holds, and only live HIGH keys the stored private key proves it controls. Replacing a stored wallet-key vault (or one holding wallet grants) needs it unlocked first, so those keys can be disabled; while locked, Forge refuses rather than forget keys that would stay live. (A locked vault holding only a limited Forge browser key may be replaced by a new wallet sign-in without disabling that key: it stays bounded by its budget and expiry, and a renewal from the identity file disables it.) A pasted raw key is never carried into the vault, and never counts as an unlocked vault. "Add limits" in place is impossible on Platform: `IdentityKeyLimitsUpdate` cannot add a limit a key lacks. The wallets' own route to limits is the upstream issue below.
- **Disable key on Platform** (Settings): the same master-key update, without a replacement.
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

## App Connect v2: one approval for all of Forge

Status: implemented in forge-web, on protocol code vendored from platform-auth (`lib/vendor/platform-auth/app-connect/`, recorded in `VENDORED.json`; the profile is platform-auth's `docs/APP_CONNECT_PROFILE.md`). **We know of no released wallet that speaks it yet** (not checked against any wallet's source in this change). It is covered by the profile's test vectors and unit tests. A scripted wallet (`e2e/wallet-responder-v2.ts`), a live test and a Playwright spec are written for sakura (see Tests) but **have not been run against a live chain yet**: no devnet node was reachable when they were written. v1 above is unchanged and stays for wallets that only speak it: a wallet that does not know `v=2` refuses the request, so the two never share a QR code.

### The request

`lib/auth/app-connect-v2.ts` builds one request per attempt:
- **One binding**: `contractGroup(dash-forge group)`, AUTHENTICATION / **HIGH**, with Forge's default limits (`defaultLimits`: 0.05 DASH, 90 days) as a proposal. HIGH, not CRITICAL: Forge has no tokens and refuses anything but HIGH. The wallet clamps the proposal to its presets (0.1 DASH and up) and the chain records what was granted; the confirm step and Settings show the granted figures.
- **`appId` is forge-core** (the group's owner owns it, which is what the profile's owner rule needs), label "Dash Forge".
- **No encryption binding.** No Forge contract allows wallet-issued encryption keys, so a wallet would refuse one as invalid. A v2 sign-in therefore does not deliver the encryption key that a v1 sign-in registers (D27): members-only and private content are set up in Settings afterwards.
- **`CONNECTION_ID`**: 16 random bytes per network in localStorage, kept across sign-out and forget (`lib/auth/connection-id.ts`). A wallet that approves disables the key of its previous grant for the same (identity, app, connection id) in the same update, so signing in again or renewing never leaves this browser's old key live.
- **Clocks**: `CREATED_AT` is this device's clock (the wallet compares it with its own); the proposed expiry and the verifier's "now" are chain time (`readChainClock`), falling back to the device clock.
- **Only the phone's deep link carries `cb`** (`https://<site>/connect/?r=<hash160 of the ephemeral key>`). The QR leaves it out (a smaller code, and a phone scanning it has no Forge tab to return to). It is left out too on an IPFS build and when the page is not on the canonical site's origin: the return page can only reach tabs of its own origin.

### Availability and trust

The v2 request is offered when Forge is deployed on the network, the chain reports protocol 14 or later, and the group check passes. `AuthController.checkGroup` (`assertGroupHolds`) runs before a code is shown: it pins the group owner, requires no admins, and accepts and names members this build does not know (shown on the confirm step). The vendored `group.ts` (an exact member list) is not used; it would break whenever Forge adds a contract. Otherwise only v1 is offered, as before.

A locked vault holding a wallet-granted key blocks a v2 sign-in (`walletSignInBlocker`): any approval disables the key of the wallet's previous grant before Forge sees the answer, and nobody knows which identity will answer, so such a vault is unlocked first while its key still opens.

### Verification

The poll pages through the `loginKeyResponse` rows of the request (`listAppConnectCandidates`), opens each with the request's ephemeral key and checks it with the vendored verifier (the key is live on the answering identity, has exactly the bounds, level and limits asked for, and is not about to expire or spent), then once more with Forge's own rules (`findWalletKey`: AUTHENTICATION / HIGH, group-bound, with a budget and an expiry), which yields the key the vault stores. The key is stored like any wallet key, with origin `app-connect`.

Who answered is still not proven (anyone who saw the QR can answer from their own identity), but on App Connect Forge can see it: every answer that opens with this request's key counts as a responder, accepted or not, for a 3 second settle window, and **two identities are refused**. Without an identity hint the confirm step stays ("A wallet answered for this identity": compare the username and id with the wallet). A request lives 10 minutes and is polled every 2 s for a minute, then every 4 s; the poll also runs at once when the tab regains focus or becomes visible, and when the `/connect/` page reports the wallet came back. The return page tells that tab a failure the wallet reports (`ac` = declined, stale, unsupported, invalid, failed), and the tab shows it; it is only a nudge, and nothing is trusted from it. With no tab waiting (a code shown in another browser), the page says what the wallet reported and sends the user back to the Forge tab where they started: the request's key lives in that tab's memory only, so nothing continues on the return page.

### The session

- One key covers every contract, so `grants` are complete, the key is not flagged `unlimited`, and no guided grants follow.
- `AuthSession.origin = 'app-connect'` survives a reload (stored with the vault). A write is not started in the last 5 minutes before the key expires (`APP_CONNECT_SIGNING_EXPIRY_MARGIN_MS`): it would fail as expired, so the session offers renewal first.
- **Write errors** read as App Connect does (`classifyAppConnectError`, in `lib/view/write-errors.ts`):

| Action | Codes | What Forge does |
|---|---|---|
| `renew` | 20015, 20016, 40218 | The key sheet opens (budget or expiry), with **Renew in your wallet** first and the identity file second |
| `logout` | 20003, 20006, 40208 | "Your wallet revoked this browser's access": the key sheet opens and the session locks as for any disabled key. Forge keeps the vault (lock-only; it may hold storage settings and an encryption key) |
| `handoff` | 20013, 20004, 20007 | Cannot happen: Forge's identity updates are signed with the master key. Shown as any refusal |
| `invalidate` | 20014 | The session's keys are checked on chain again (`recheckSession`), and the usual sentence is shown |

- **Renewing** (`walletRenewalRequest`, "Renew in your wallet"): the same request with `IDENTITY_HINT` and the same connection id, and no `MODE` (no wallet supports `MODE` = renew yet, and its type is even, so a wallet that does not know it refuses the whole request; `RENEW_MODE` is off). The vault protection is chosen **before** the code shows. The wallet disables the old key in the same update that adds the new one, so a marker for the renewal in flight keeps other tabs from locking the vault in that window; it is cleared when the new key is stored, and on cancel, expiry or refusal (`endWalletRenewal`). The banner, the top-up sheet and Settings → This browser's key route a wallet-granted key here (`fundsNotice(state, origin)` → `renew-in-wallet`); the thresholds are Forge's (under 20 % of the budget, under 7 days).
- Master-key top-up, renewal and revocation work on a v2 key as on any Forge browser key (`isForgeBrowserKey`).

### Not done

- A wallet's list of known apps: wallets open `cb` and show branding only for hosts they associate with the `appId`, so forge-core and forge.dashhq.org have to be added to it, or a wallet may warn about an unknown app. Not pursued upstream yet.
- Wiping the vault when the wallet revokes access (the profile suggests it); Forge only locks.
- `MODE` = renew, and an encryption binding (it would need a contract that allows wallet-issued encryption keys).

## Compatibility matrix

Every Dash Wallet row needs a build from the development branch: no released version has DashConnect yet (see "Release status" above).

| Wallet | Network | Works today | Notes |
|---|---|---|---|
| Dash Wallet Android (testnet build) | testnet | **Once forge-v2 is on testnet** (PV14; testnet runs protocol 13 today) | publishes to yappr's 7Uaq, which Forge reads; key lands unbounded and unlimited; forge-collab needs the second approval |
| Dash Wallet Android | sakura / devnet | No | `checkTestnet` refuses every request off testnet, and the contract id is pinned to testnet; see upstream (b) |
| Dash Wallet Android | mainnet | No | feature disabled on mainnet builds |
| Dash Wallet iOS | testnet | **Once forge-v2 is on testnet** | key lands bound to forge-core (or forge-collab), unlimited |
| Dash Wallet iOS, internal build (`DASH_DEVNET`) | sakura (devnet) | **Only with a manual override**: Settings → Devnet Settings → DashConnect Contract ID = the `keyExchange.contractId` of `deployments/devnet-sakura.json` (deployed with the RC2 registration), and a DashPay identity on sakura | shipping builds have no devnet; not run on a device in this change (see Manual test) |
| Dash Wallet iOS | mainnet | No | Connections is off on mainnet (`!WalletEnvironment.isTestNetwork`) |
| Any wallet that answers an App Connect **v2** request (`dash-key:…&v=2`) per the profile | sakura now, any network where Forge is deployed at PV14 | **Yes** (unit-tested; no released wallet known to do it yet) | one approval for all of Forge, a budget and an expiry, no warning; no encryption key; renewed in the wallet; the wallet may warn about an app it does not know |
| Any wallet publishing to App Connect `H8F9…` a v1-style response with group-bound, limited keys | sakura now, all networks at PV14 | **Yes** (unit-tested) | one approval, no warning (shown under "Show the older code") |
| Scripted v2 responder (`e2e/wallet-responder-v2.ts`, the profile's wallet rules) | sakura (needs a test identity of your own) | **Written, not yet run live** (its request checks are unit-tested) | login, a forge-community write with no grant, renewal and the old key disabled; vitest live test and Playwright e2e below |
| Scripted responder (`e2e/wallet-responder.mjs`, the Android/iOS logic) | sakura (run on bonsia) | **Yes**, live | vitest live test and Playwright e2e below |

## Tests

- `lib/auth/wallet-protocol.test.ts`: the request is byte-identical to the wallets' fixture (`DashConnectUriTest.kt` `SERIALIZED_REQUEST_HEX`) and parses with a port of `DashConnectUri.kt` plus the iOS ceilings (`wallet-sim.ts`); yappr's captured testnet URI parses; the wallets' key-derivation vectors (`KeyExchangeCryptoTest.kt`); legacy and multi-key envelopes; `dash-st:` framing and contents checked against the iOS rules, the encryption key's proof of possession recovered to its public key, and the tag-6 framing parsed too; scope rules; and the poll against a simulated wallet on both contracts (first and returning login, App Connect, confused deputy, other-app/CRITICAL/revoked keys, two answerers, an unusable stranger counted but not fatal, incomplete reads never settle, base58 or base64 contract ids, App Connect paging past junk, grant filtering, expiry).
- `lib/auth/wallet-session.test.ts`: per-contract key choice by scope, `MissingGrantError`, non-Forge contracts refused, a grant kept across lock/unlock and across a returning login, a group-key grant for forge-collab, a grant that does not cover the request refused, a failed grant check keeps the session, disabled grants dropped, renewal disabling every held key in the same update, locked renew/revoke refused, revoke of a wallet session.
- `lib/auth/responder-profile.test.ts`: the confirmation warnings (another stored identity, no name, a new name).
- `lib/auth/wallet-login.live.test.ts` (`FORGE_LIVE=1`, sakura; run on bonsia): (iOS path) first login with QR #2, a forge-core repo created with the wallet's key, a star refused locally, the one-tap forge-collab grant, the star lands, a returning login without QR #2, cleanup; (Android path) the key lands unbounded and covers both contracts, and after it is disabled the next login is refused (`RevokedWalletKey`).
- `e2e/wallet-login.spec.ts` (`E2E_DEVNET=sakura E2E_WRITE=1`): the real browser from the QR text on the page (QR #2, confirmation warnings, passkey preference), Settings' grant prompt, **Star opening the grant sheet by itself**, the wallet's approval, the star landing, and the phone viewport's deep link. Where App Connect v2 is on offer (sakura) it takes "Show the older code" first.
- `lib/auth/app-connect-v2.test.ts`, `app-connect-port.test.ts`, `app-connect-session.test.ts`, `connection-id.test.ts`: the request's bytes and `cb` (QR without, link with), the verifier's accept and reject cases, the ambiguity rule, retries, the port's key mapping, the vault origin, the expiry margin and the renewal marker. The vendored module's own tests (profile vectors, verifier, poller, errors) run in `pnpm test`.
- `lib/auth/connect-callback.test.ts`, `components/auth/connect-return.test.tsx`: the `cb` rules (omitted on IPFS builds, other origins and http), the `r` / `ac` parsing, the channel messages, and the return page (declined and failed statuses, the ack from the waiting tab, the "go back to the Forge tab" case).
- `components/auth/wallet-connect-flow.test.tsx`, `login-modal.test.tsx`, `top-up-sheet.test.tsx`, `low-funds-banner.test.tsx`, `hooks/use-write-guard.test.tsx`: v2 shown first (after the group and locked-key checks), the older code and back, the confirm step, poll on focus and on the return page's message, the renewal (protection first, the marker ended on every way out but a stored key), the tile order, and renewal routed to the wallet.
- `lib/auth/wallet-responder-v2.test.ts`: the scripted wallet's request checks accept exactly what Forge asks for and refuse what the profile's wallet rules refuse.
- `lib/auth/app-connect-v2.live.test.ts` (`FORGE_LIVE=1`, sakura; real spend; not yet run): login with the scripted v2 wallet, a repo and a star signed by the one key, renewal in the wallet and the old key disabled, cleanup.
- `e2e/wallet-login-v2.spec.ts` (the live part not yet run; the read-only part skips itself when no devnet node is reachable): read-only (the wallet tile first, the v2 request and its terms, the older code and back, the phone link without `cb` on a local http build, the `/connect/` page) and, with `E2E_WRITE=1`, the full login, a star with no grant sheet, and renewal.

## Manual test on a device

Not run in this change: no device or emulator with a DashPay identity on testnet or moutai was available here, and testnet has no forge-v2 yet.

iOS simulator, sakura (skill `run-ios-simulator`, dashwallet-ios `develop`):
1. Build and launch Dash Wallet iOS with `DASH_DEVNET` (an internal build) on devnet. In Settings → Devnet Settings, set the devnet name `sakura`, the quorum URL `https://quorums.sakura.networks.dash.org`, and the DashConnect Contract ID: the `keyExchange.contractId` of `deployments/devnet-sakura.json` (deployed with the RC2 registration).
2. Create a wallet, fund it from https://faucet.sakura.networks.dash.org, and register a DashPay username (this creates the identity).
3. Serve a sakura build: `cd forge-web && NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=sakura pnpm build && node e2e/static-server.mjs --port 4321`.
4. In Safari in the simulator, open `http://<host>:4321`, then Sign in → Use my Dash wallet. Tap **Open in DashPay (Dash Wallet)** (the phone layout). Expect the wallet's approval sheet naming the forge-core contract owner's DPNS name (or "Dash Forge", the QR label, if the owner has none). Approve.
5. The page shows **One more step**. Tap **Add the key in DashPay (Dash Wallet)** (iOS asks for your PIN or biometrics; Android adds the key on opening, with no approval screen). Expect the username and the start and end of the identity id to match the wallet's approval sheet, plus the no-limit warning.
6. Confirm, protect with a passkey (or a passphrase), then Finish. Create a repo (New → Repository): it lands.
7. Right after the first sign-in the sheet asks for the other contracts ("Step 2 of 3: approve Forge collaboration", then "Step 3 of 3: approve Forge community"). Approve each in the wallet (one approval, plus a second `dash-st` the first time), or skip one. Star the repo: a star is a forge-community write, so if you skipped that step it asks for **Approve stars, watches and follows** now. Star again: it lands.
8. Settings → This browser's key: expect the warning, **Replace with a limited key** and **Disable key on Platform**. Record screenshots of steps 4–8.

Android emulator, testnet (once forge-v2 is on testnet): install a `_testNet3` build of dash-wallet, create a DashPay identity, and repeat steps 3–8 with a testnet build of Forge, scanning the QR with the wallet's scanner (More → Tools → Connections → Scan QR). Expect the key to be reported as unbounded ("on any Platform app").

## Upstream

Drafts for dashpay/dash-wallet and dashpay/dashwallet-ios are in [`docs/upstream/`](../upstream/): (a) group-scoped grants, (b) publish to the PV14 App Connect system contract with limits, (d) a per-app, per-rotation salt in the login-key derivation so a revoked key never comes back, and (e) a signature over the request context so the app can authenticate the responder ([app-connect-responder-auth.md](../upstream/app-connect-responder-auth.md), for the App Connect spec as well); plus fixes for dropped bounds and limits in `dash-st:` and for iOS refusing group bounds.
