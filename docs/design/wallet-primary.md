# Wallet sign-in as the primary method (all surfaces)

Status: plan (Phase 0), 2026-11-22. Direction from the owner: "forge needs to migrate to sign in with wallet flows as primary for all surfaces, frontends, web and cli".

This page records how every surface signs in today, what wallets can do now, what "primary" means per surface, what each flow exposes, the PR plan, and the decisions the owner has to make. [wallet-login.md](wallet-login.md) has the protocol details of the existing wallet flows. Parts of it are now out of date (see "What changed since wallet-login.md").

## 1. How each surface signs in today

### forge-web (`forge-web/`)

| Method | Where | Key material in the page | Stored |
|---|---|---|---|
| Wallet, App Connect v2 (one approval, group-bound, budget + expiry) | `lib/auth/app-connect-v2.ts`, `components/auth/wallet-connect-flow.tsx`, `components/auth/connect-return.tsx`, `lib/auth/connect-callback.ts`; vendored protocol in `lib/vendor/platform-auth/app-connect/` | an ephemeral request key (zeroed), then the granted HIGH key | vault (origin `app-connect`) |
| Wallet, v1 DashConnect (one key per contract, unlimited) | `lib/auth/app-connect.ts`, `lib/auth/wallet-protocol.ts`, `lib/auth/key-registration.ts`, `lib/auth/guided-grants.ts` | the granted login key (and encryption key) | vault, not kept across reload |
| Create a new identity (deposit) | `components/auth/create-identity-flow.tsx`, `lib/auth/create-identity.ts`, `asset-lock.ts`, `dapi-core.ts`, `hd.ts` | **the recovery phrase, the master key and every canonical key**, plus the asset-lock key, for the length of the flow | only the limited browser key (key 5) |
| Recovery phrase or identity file | `components/auth/master-key-input.tsx`, `lib/auth/identity-file.ts`, `hd.ts`, `limited-key.ts` (`registerLimitedKey`) | **the master key** (one operation, then dropped; JS strings cannot be wiped) | the limited key it registers |
| Passkey (on-chain sealed vault entry) | `components/auth/passkey-sign-in.tsx`, `lib/auth/passkey-vault/` | the sealed limited key(s); never master | on chain (forge-meta `vaultEntry`, ciphertext) |
| From the dg CLI (browser → `dfkr1:` request, terminal registers, `dfkh1:` sealed reply) | `components/auth/dg-handoff-flow.tsx`, `lib/auth/key-handoff.ts`; Rust half `crates/forge-core/src/browser_key.rs` | the limited key only (master stays in the terminal) | vault (origin `dg`) |
| Paste a private key (Advanced) | `components/login-modal.tsx` `AdvancedView`, `controller.loginWithRawKey` | whatever was pasted | session only |

Entry point: `components/login-modal.tsx` `ChooseView`. Tile order: resume creation, wallet (first only if `walletSignInReady`, which is mainnet-only today), create, passkey, import, dg, wallet (last otherwise), then Advanced. Gate: `walletSignInReady` / `walletSignInSupported` in `lib/auth/app-connect.ts`.

Storage (`lib/auth/vault.ts`, `session-resume.ts`): IndexedDB `vault` (AES-GCM data key wrapped by a passkey PRF or an Argon2id passphrase), extra wallet grants and the encryption key and storage credentials as separate sealed blobs; a 12 h resume record (`session:<network>`); localStorage holds only ids, labels and the App Connect connection id.

Later operations that still need the **master key** in the page: renew, replace or top up the browser key (`limited-key.ts`), revoke and disable keys (`controller.disableIdentityKey`, `disableOtherKeys`), the private-repo encryption key (`encryption-key.ts`), the CI runner key (`mirror-steps.tsx`), identity balance top-up (`identity-top-up.ts`, the phrase). Username registration uses the CRITICAL and HIGH keys from the file or phrase (`username-register.ts`).

Signing seam: `WriteAuth.getSigningKeyWif(contractId)` (`lib/sdk/write.ts`) is the only signer contract, picked per contract in `AuthController.writeAuth` (`lib/auth/controller.ts`); `serviceKey()` hands the main key to the notify client (`lib/notify/client.ts`).

### The shared layer

There is no shared signer abstraction in either language. forge-web passes WIF strings (`WriteAuth`). Rust passes `keystore::IdentityKey` / `BridgeIdentity` into `WriteEngine::new(client, identity, key)` (`crates/forge-core/src/platform/mod.rs`), which builds a single-key signer. The browser and CLI share formats, not code: `dfk1:<network>:<identity>:<keyId>:<wif>` (a limited key) and the `dfkr1:`/`dfkh1:` handoff.

### dg CLI (`crates/dg/src/auth/`)

- `dg auth new` (creates an identity; holds the phrase), `dg auth login <identity file> | --mnemonic` (uses the master key once to register a limited key: 0.25 DASH, 180 days, group-bound), `dg auth keys add --for-browser` (the handoff), `keys disable|rotate`, `name register`, `export`, `logout --disable`.
- Storage (`store.rs`): OS keychain first (`dash-forge/<network>/<id>`), else a sealed file `~/.config/dash-forge/identities/<network>-<id>.key` (`crates/forge-core/src/sealed.rs`: Argon2id 64 MiB + XChaCha20-Poly1305; passphrase from `DASH_FORGE_PASSPHRASE` or the tty). A full identity (master) never goes in the keychain.
- Env: `DASH_FORGE_KEY` (path, `keychain:` or `dfk1:`), `DASH_FORGE_PASSPHRASE`.
- Every key add or disable goes through `platform/identity.rs` `update_identity_keys`, which needs MASTER.

### git-remote-dash (`crates/git-remote-dash/`)

No sign-in of its own. It signs with the key dg hands it (`forge-core/src/key_handoff.rs`) or `DASH_FORGE_KEY`, then `identities/<owner>.identity.json`, then the stored default (`helper.rs` `load_signer`). It uses the HIGH key.

### Services and tools

| Surface | Auth today | Holds a user key? |
|---|---|---|
| forge-gateway (`services/forge-gateway`) | none: anonymous reads | no |
| forge-notify (`services/forge-notify/src/auth.rs`) | verifies requests signed by a HIGH or CRITICAL Forge-bound auth key | no (verifies only) |
| forge-relay (`crates/forge-relay`) | its own encryption keys; HMAC wake secret shared with the runner | no |
| forge-runner (`crates/forge-runner`) | `DASH_FORGE_KEY` (a checkRun-bound runner key, registered with the master) | a scoped runner key |
| GitHub Action (`action/`), GitLab template (`integrations/gitlab/`) | `DASH_FORGE_KEY` secret: `dfk1` (limited) or an identity file (refused unless `allow-unlimited-key`) | a limited key in CI secrets |
| GitHub/GitLab import (`crates/forge-import`) | `--identity` or `DASH_FORGE_KEY`; `GH_TOKEN`/`GITLAB_TOKEN` | the mirror identity's key |
| `tools/mint-identity` | mnemonic + funding WIF (test tooling) | yes (test only) |

No other client exists (no mobile app of Forge's own, no editor extension).

## 2. What wallets can do (checked 2026-11-22)

Both mainnet and testnet run Platform protocol 14, which carries the App Connect system contract (`H8F9mP1BM55TE1ShsxPZHzhyinaMdY9bMmP85mkDhcJJ`, platform v5.0.3).

| Wallet | Web | CLI | Protocol | Release | Maturity |
|---|---|---|---|---|---|
| DashPay Wallet Android | yes | yes (phone scans a QR the terminal prints) | **App Connect v2 only** (`dashpay://connect` or `dash-key:…&v=2`); **v1 is refused** (`DashConnectUri.kt` `LEGACY_KEY_REQUEST_ERROR`) | **v11.9.2, released 2026-11-09** (`654f1540e`); `SUPPORTS_CONNECT` on for mainnet, testnet, devnet, gated on protocol ≥ 14 | released, two weeks old |
| Dash Wallet iOS | yes | yes (same) | v9.1.4: v2 on any network, v1 on testnet only; `develop`: v2 only, and `dash-key:` refused on mainnet (`dashpay://connect` only) | **v9.1.4, 2026-11-06** (`8ea58b0b8`) | released on GitHub; store availability unverified |
| Dash Evo Tool | no | manual only (Add key screen: any key, single-contract bounds, no budget or expiry) | none | v0.9.3 stable, weekly pre-releases | not a sign-in path |
| dashwallet-desktop | no | no | none (roadmap: DashConnect in 0.4, ~2026-12) | v0.2.0 | speculative |
| Dash Platform Extension (Chrome) | its own per-transaction signer (`window.dashPlatformExtension`) | no | not App Connect | v1.5.3 | released, different model |
| WalletConnect-style relay | none found | — | — | — | does not exist |

So **App Connect v2 from the two DashPay mobile wallets is the one real, released path**, for web and CLI alike (App Connect is cross-device: the CLI keeps the request key and polls Platform for the answer, no Forge server involved). Everything else is manual or speculative.

### What changed since wallet-login.md

- v1 (`dash-key:` without `v=2`, answered in yappr's `7Uaq…`) is dead: Android rejects it on every network, iOS `develop` rejects it, and it never worked on mainnet.
- `walletSignInReady` keeps the wallet tile last on testnet because "released wallets pin protocol 13 (#591)". That is no longer true: both released wallets need protocol 14, which testnet runs.
- Forge's vendored platform-auth (`a627708d`) builds only `dash-key:…&v=2`. Current yappr adds the `dashpay://connect` carrier, which iOS `develop` requires on mainnet. Re-vendoring is needed before mainnet.
- Wallets accept up to two encryption bindings, but no Forge contract allows wallet-issued encryption keys, so a v2 sign-in still cannot set up private repos by itself.

## 3. What "wallet sign-in is primary" means per surface

| Surface | Primary | Kept, demoted | Removed (needs the owner's decision first) |
|---|---|---|---|
| forge-web sign-in | "Sign in with DashPay" (App Connect v2) first on every network where Forge is deployed at protocol ≥ 14; QR on desktop, deep link on phones | passkey (it is an unlock of a key you already have, so it stays prominent for returning users); "From the dg CLI"; recovery phrase or identity file under **Other ways to sign in** | v1 DashConnect ("Show the older code"); raw key paste (keep under Advanced or remove) |
| forge-web "Create identity" | "Get DashPay, create your identity there, then sign in" | the in-page create under Other ways, because it holds the phrase and master in the page | — |
| forge-web key management | renew = **Renew in your wallet**; revoke = the wallet's disconnect (it disables the old key in the same update) | master-key renew/top-up/disable under "Use your recovery phrase instead" | — |
| dg CLI | `dg auth login` with no arguments prints an App Connect QR (and the `dashpay://` link) in the terminal, polls Platform, stores the granted key like today's limited key | `dg auth login <file>` / `--mnemonic` | — |
| git-remote-dash | unchanged: it uses whatever dg stored; its "no key" error says `dg auth login` (wallet) | `DASH_FORGE_KEY` | — |
| Action / GitLab / runner / import | unchanged secrets (`dfk1:`); docs say to get one from `dg auth login` (wallet) then `dg auth export` | identity files | — |
| gateway, relay, notify | unchanged (no user sign-in; notify already accepts any Forge-bound HIGH key, wallet-granted included) | — | — |

### Migration for people who already signed in

- **A vault in this browser (any origin):** keeps working. Unlock stays as it is. When its key nears budget or expiry, the renewal sheet offers the wallet first. For a key of origin `app-connect` it already does.
- **A passkey vault entry:** keeps working. It unlocks a limited key you already registered.
- **Identity created in Forge (phrase only, no wallet):** the user can restore that phrase in DashPay (the wallets restore a BIP-39 phrase and find the identity) and then sign in with the wallet. Forge says so in Settings, once, as a suggestion.
- **A v1 wallet key (unlimited):** the existing "Replace with a limited key" warning stays; the replacement offered first becomes a v2 wallet sign-in.
- **dg users:** a stored key keeps working. `dg auth status` suggests `dg auth login` (wallet) when the key is renewed.

Nothing is deleted from anyone's browser or keychain by this work.

## 4. Security: what each flow exposes

Rule: the hosted page, the CLI and Forge's services never see a seed or master key in the primary flow. They see at most one scoped, revocable, minimum-purpose key.

| Flow | Page / CLI sees | Server sees | Revocation |
|---|---|---|---|
| App Connect v2 (primary) | one AUTHENTICATION / HIGH key, bound to the `dash-forge` contract group, with a budget and an expiry the wallet confirms; the request's ephemeral key (memory only). No encryption key, no master, no seed | nothing: the answer is on chain, encrypted to the request key; gateway and notify see only signatures | the wallet's disconnect, or the next approval for the same connection id disables the old key in the same update |
| Passkey unlock | the same limited key, decrypted with the passkey PRF | the on-chain ciphertext | as for the key |
| dg handoff (browser) | the limited key, sealed to a one-time browser key | nothing | as for the key |
| Recovery phrase / identity file (fallback) | **the master key, for one operation** | nothing | — |
| Create in page (fallback) | **the phrase and every key, for the flow** | nothing | — |
| Raw key paste (advanced) | whatever was pasted, for the session | nothing | — |

Known gaps, unchanged by this plan: anyone who sees the QR can answer from their own identity (the confirm step shows the identity; the fix is the responder signature, `docs/upstream/app-connect-responder-auth.md`), and the request binds no origin, so a lookalike page can show Forge's request (the request screen says where to scan).

Things the wallet cannot do for Forge yet, so they stay on the fallback path: master-signed key operations (top-up of a key's budget, disabling other keys), registering a DPNS name for a Forge-created identity, the private-repo encryption key, and the checkRun-bound CI runner key. A wallet-side `dashpay://sign` for one-off master operations does not exist yet.

## 5. PR plan

Each PR is small, changes one thing, and lands green.

**Phase 1: abstraction, no behavior change**
1. This document.
2. forge-web: a sign-in method registry (`lib/auth/sign-in-methods.ts`). Each method has an id, a tier (primary / other / advanced), and an availability check; `ChooseView` renders from it. Tests pin today's order per network.
3. forge-web: a `WriteSigner` seam behind `WriteAuth` (sign a transition, add to an `IdentitySigner`), with today's WIF provider as the one implementation, so a wallet-held key can plug in without touching `write.ts` again.
4. Rust: an `AuthSource` enum in forge-core naming where a key came from (file, mnemonic, keychain, `dfk1`, wallet), reported by `dg auth status`; no new flow.

**Phase 2: web, wallet first**
5. Re-vendor platform-auth `app-connect` (adds `dashpay://connect`; vectors from yappr).
6. `walletSignInReady`: lead with the wallet on testnet too (the #591 reason is gone). Copy names DashPay Wallet 11.9.2+ / iOS 9.1.4+. Before/after screenshots; a real login from the released Android build on the `agentbox-api36` emulator.
7. Create-identity tile becomes "Get DashPay" with the in-page create under Other ways; renewal and revoke route to the wallet first.
8. (After the owner decides) remove v1 DashConnect and its guided grants.

**Phase 3: CLI**
9. forge-core: an App Connect module in Rust (request codec, crypto, verifier) checked against platform-auth's `vectors.json`. Library only.
10. dg: `dg auth login --wallet` (terminal QR via a small QR crate, plus the link; polls; stores the key with the existing `Storer`). Opt-in.
11. dg: a bare `dg auth login` defaults to the wallet; files and phrases still work as arguments. git-remote-dash's and the Action's messages point there; docs and the empty-repo steps updated.

**Phase 4: polish**
12. `dg auth status` and Settings show the key's origin, budget and expiry, with "Renew in your wallet".
13. Re-check the iOS `develop` carrier rules before any mainnet deployment.

## 6. Decisions for the owner

1. **Which wallets first.** Options: (a) DashPay Android + iOS over App Connect v2 only; (b) also wait for Dash Evo Tool or dashwallet-desktop. Recommendation: **(a)**. They are the only released implementations, and App Connect is cross-device, so the phone also signs in the CLI.
2. **Old methods.** Options: (a) keep all as fallbacks under "Other ways"; (b) remove the phrase and file import; (c) remove only v1 DashConnect and raw key paste. Recommendation: **(a) plus removing v1 DashConnect** (no wallet accepts it any more). Keep the phrase and file import: users without a phone, and the master-key operations, need them.
3. **Creating identities.** Options: (a) send newcomers to DashPay to create the identity, and keep Forge's in-page create under Other ways; (b) remove in-page create (it holds the master key in the page); (c) keep it as is. Recommendation: **(a)**.
4. **Private repos with wallet sign-in.** The wallets can grant encryption keys, but Forge's contracts do not accept wallet-issued encryption keys. Options: (a) keep "import your encryption key with the phrase" for private repos; (b) allow it at the next contract registration (mainnet). Recommendation: **(a) now, (b) at the mainnet registration**.
5. **Upstream wallet work.** The drafts in `docs/upstream/` (responder signature, per-app salt) have not been filed with dashpay. Recommendation: file the responder-signature request with dashpay/dash-wallet and dashpay/dashwallet-ios (it closes the "anyone who sees the QR can answer" gap), and ask for a `dashpay://sign` for master operations later. This is an owner call because it is outward-facing.
6. **CLI QR vs browser relay.** Options: (a) the terminal prints the QR and polls Platform itself; (b) the CLI opens a Forge page that shows the QR. Recommendation: **(a)**. No server hop, and it works over SSH.
