# Docs audit 2026-11-25: in-app copy for sign-in, identity, keys, funds and account settings

Lane `webcopy-identity`. Base: `origin/master` 1b547336. Both live sites serve that commit (the mainnet footer links commit `1b547336…`), so a claim checked against the code is also checked against forge.dashhq.org and testnet-forge.dashhq.org. Signed-out pages `/`, `/start/`, `/login/`, `/connect/`, `/settings/` and `/org/` answer 200 on both sites.

Verdicts: **ok**, **stale** (true once, not now), **wrong**, **missing**, **jargon** (true, but unclear to a newcomer; fixed under Pasta's UX rules), **deferred** (maintainer storage sharing, which another thread is changing).

## In-app links to `/docs/<slug>`

Every slug in `forge-web/lib/docs-links.ts` resolves in `forge-web/lib/docs/catalog.ts`, and every `#fragment` matches a heading in the target document (GitHub-style slugs, `components/markdown-view.tsx:742`).

| # | Claim (short quote) | Location | Verdict | Evidence |
|---|---|---|---|---|
| L1 | `/docs/identity-and-keys/#replacing-it-after-a-lost-device` | `components/devices-keys.tsx:335,402`, `components/auth/remove-passkeys-option.tsx:70` | ok | `docs/guides/identity-and-keys.md:170` "### Replacing it after a lost device" |
| L2 | `/docs/identity-and-keys/#what-an-identity-is` | `components/username-hint.tsx:42` | ok | `identity-and-keys.md:19` |
| L3 | `/docs/identity-and-keys/#passkeys-for-other-devices` | `components/auth/passkeys-section.tsx:132` | ok | `identity-and-keys.md:334` |
| L4 | `/docs/revoke-keys/` "If Forge tells you to revoke keys" | `components/auth/scan-warning.tsx:59` | ok | catalog `revoke-keys` → `docs/guides/revoke-keys.md` |
| L5 | `/docs/quick-start/`, `/docs/costs/`, `/docs/moving-from-github/`, `/docs/mirror-a-github-repo/`, `/docs/bring-your-own-storage/`, `/docs/` | `app/start/page.tsx:81-113` | ok | all in catalog `DOC_SECTIONS` |
| L6 | `/docs/devnet-move/`, `/docs/networks/` | `app/networks/page.tsx:142,145`, `lib/devnet-notice.ts:45` | ok | catalog `devnet-move`, `networks` |
| L7 | `/docs/identity-and-keys/` "Identities and keys"; `/docs/costs/`; `/docs/quick-start/` | `app/page.tsx:213-237` | ok | catalog |
| L8 | "More in Getting started" → `/start/` | `components/login-modal.tsx:484` | ok | `app/start/page.tsx` |
| L9 | Verify link on "Unpublished build" → GitHub `docs/guides/verify-the-app.md` at the build's commit | `components/build-integrity-notice.tsx:29`, `lib/build-info.ts:34` | ok | file exists |
| L10 | `DOCS.rotateStorage` → GitHub `docs/guides/rotate-storage-credentials.md` | `components/storage/repo-share-notes.tsx:42` | deferred → see maintainer-sharing.md #31 | maintainer storage sharing; file exists |

## Sign-in (`/login`, the sign-in sheet, wallet, dg, passkey)

| # | Claim (short quote) | Location | Verdict | Evidence |
|---|---|---|---|---|
| S1 | "Sign in with a Dash wallet, an identity file or your recovery phrase, or create a new identity." | `app/login/page.tsx:41` | **stale** (fixed) | Since #704/#707, where the wallet leads, the sheet's first options are the wallet and a passkey; otherwise creating an identity and a passkey. On mainnet every recovery-phrase route sits under Advanced (`lib/auth/sign-in-methods.ts:66-79`). Now reads "Sign in with your Dash wallet, a passkey or dg, or create a new identity." |
| S2 | "Dash Forge isn't available on {network} yet" when there is no forge-v2 | `app/login/page.tsx:40`, `components/login-modal.tsx:251` | ok | `ACTIVE_NETWORK.v2 === null` / `limitedKeys` false |
| S3 | Wallet tile, not offered: "Your wallet answers App Connect v2, which can't be offered here right now. Use another option for now." | `components/login-modal.tsx:325` | **jargon** (fixed) | Shown on mainnet or testnet when the v2 check fails (`walletLeads`). The protocol name tells a newcomer nothing. Now reads "Wallet sign-in isn't available here right now. Use another way for now." |
| S4 | Wallet flow error: "Wallet sign-in needs App Connect v2, which can't be offered on {net} right now. Sign in with your recovery phrase or identity file, or create an identity in the browser." | `components/auth/wallet-connect-flow.tsx:813` | **wrong on mainnet + jargon** (fixed) | On mainnet a recovery-phrase sign-in is a developer path under Advanced (#707, `sign-in-methods.ts:69`). Now reads "Wallet sign-in isn't available on {net} right now. Go back and choose another way to sign in." The test regexes are updated in `wallet-connect-flow.test.tsx:224,244`. |
| S5 | Wallet tile on mainnet: "DashPay (Dash Wallet) on your phone: scan a QR code (or tap a link on the phone) and approve once for all of Forge." | `components/login-modal.tsx:322` | ok | `dashpay://connect` carrier (#703), `lib/auth/app-connect-v2.ts`. One grant covers the group (`ApprovalTerms`). |
| S6 | Testnet: "DashPay on your phone (its testnet build)" | `components/login-modal.tsx:321` | ok | `walletSignInReady` (`sign-in-methods.ts:47`). Only Android's testnet APK is verified (`WalletSupportNote`). |
| S7 | Devnet: "Test wallets only on {key}: released Dash Wallet apps carry no devnet's settings." | `components/login-modal.tsx:324` | ok | `walletSignInReady` is false on devnets |
| S8 | "DashPay for Android 11.9.2 or later … or Dash Wallet for iOS 9.1.4 or later." | `components/login-modal.tsx:348`, `wallet-connect-flow.tsx:833` | ok | `docs/design/wallet-primary.md`, #703 |
| S9 | Mainnet: "Get DashPay, create your identity there, then sign in" sits under Other ways; Create is under Advanced | `components/login-modal.tsx:340` | ok | `signInMethods`: `dashpayFirst` → `get-dashpay` in `more`, `create` in `phrase` group = `advanced` on mainnet |
| S10 | "Use dg on your computer — Already signed in to the dg command line? Run one command there. Your recovery phrase stays out of the browser." | `components/login-modal.tsx:401` | ok (see Q3) | `dg auth keys add --for-browser` signs with the master key in the terminal (`crates/dg/src/auth/keys.rs:460`, `--master` or the typed words). The phrase never enters the browser. |
| S11 | dg command shown: `dg auth keys add --network … --for-browser … [--for-identity] --budget … --expires …d [--replace] [--with-encryption-key]` | `lib/auth/key-handoff.ts:230` | ok | All of these flags exist in `AddArgs` (`crates/dg/src/auth/keys.rs:88-121`). |
| S12 | "Paste the line dg printed — It starts with dfkh1:" | `components/auth/dg-handoff-flow.tsx:172` | ok | `forge_core::browser_key::seal`; `docs/guides/identity-and-keys.md:255` |
| S13 | Passkey tile: "Added in Dash Forge on another device? It moves that sign-in here. It doesn't recover an account." | `components/auth/passkey-sign-in.tsx:46` | ok | |
| S14 | Key limits note: "spends at most 0.05 DASH, only on Forge. It lasts 90 days by default, and up to a year." | `components/login-modal.tsx:266` | ok | `BROWSER_KEY_DEFAULTS`, `BROWSER_KEY_MAX_DAYS` = 365 (`keys.rs:470`) |
| S15 | Glossary (Identity, Recovery phrase, Master key, This browser's key, Passkey, Credits) | `components/login-modal.tsx:451-456` | ok | |
| S16 | Protect step: "Add a passkey" leads; "Skip for now" keeps the spend-capped key in this browser | `components/auth/wallet-connect-flow.tsx:769-812` | ok (see Q2 on "password") | the `device` vault slot (#706) |
| S17 | `/connect`: "You're signing in on your other Forge tab. You can close this one." | `components/auth/connect-return.tsx:85` | ok | `lib/auth/connect-callback.ts` |
| S18 | Scan warning: "Only scan codes shown on {host}"; "Scanned a code you didn't trust?" → revoke-keys | `components/auth/scan-warning.tsx:36,54` | ok | |
| S19 | Mainnet: master-key actions collapse under "Advanced: use your recovery phrase or identity file" | `components/auth/phrase-advanced.tsx:19` | ok | `phraseIsAdvanced()` (#707) |
| S20 | Create identity: "Write down 12 words, lock this browser with a passkey or passphrase, then fund it…" | `components/login-modal.tsx:363-364` | ok | The create flow offers a passkey or passphrase at that step (`create-identity-flow.tsx:345`). Choosing neither keeps a browser-only key (`useProtection` default, `protection-fields.tsx:78`), so the step is optional but offered. |
| S21 | Create flow, no DAPI nodes: "Use another Forge build or dg auth new." | `components/auth/create-identity-flow.tsx:231` | ok | `AuthCommand::New` (`crates/dg/src/auth/mod.rs:54`) |

## /start (Getting started)

| # | Claim (short quote) | Location | Verdict | Evidence |
|---|---|---|---|---|
| G1 | "Your Dash Platform identity is your account (made from a 12-word recovery phrase, or connected via a wallet). Keep it offline." | `app/start/page.tsx:59` | **wrong (ambiguous)** (fixed) | "it" read as the identity, which can't be kept offline; the phrase is what must stay offline. The wallet is also now the main way in. Now reads "Create it in a Dash wallet app, or in the browser from a 12-word recovery phrase. Keep the phrase offline: nobody can reset it for you." |
| G2 | "How browser sign-in stays safe: … A passkey or passphrase protects it" | `app/start/page.tsx:99` | **stale** (fixed) | Since #706 a wallet sign-in can "Skip for now" and keep the key unprotected in a browser-only `device` vault slot (`wallet-connect-flow.tsx:790`; `lib/auth/vault.ts:681`). Now reads "A passkey or passphrase can lock it". |
| G3 | "Add credits in Settings → Top up" | `app/start/page.tsx:81` | ok | `app/settings/page.tsx` "Top up" button |
| G4 | "about {x} DASH for an issue … Reading is free" | `app/start/page.tsx:66` | ok | `typicalIssueCredits()` |
| G5 | Test-network note: "Its DASH is free test money with no value … and the network can be reset." | `components/test-network-note.tsx` | ok | not rendered on mainnet |

## Keys, devices, funds

| # | Claim (short quote) | Location | Verdict | Evidence |
|---|---|---|---|---|
| K1 | Key origin "Your DashPay wallet (App Connect)" | `lib/view/funds.ts:127` | **stale** (fixed) | Mainnet sign-in also works from Dash Wallet for iOS 9.1.4 (#703). Now reads "Your Dash wallet (App Connect)", and the pinned test is updated (`funds.test.ts:107`). |
| K2 | Low-budget banner: "Renew it (or top up its budget in Settings)." | `lib/view/funds.ts:177` | **stale** (fixed) | "Top up key budget" needs the master key. On mainnet it sits under Advanced (`keys-panel.tsx:207`, `PhraseAdvanced`), and the banner's own button is Renew or Sign in again. Pasta's one-next-step rule applies. Now reads "Renew it to keep writing.", which matches the expiry message. |
| K3 | "Your balance is under {x} DASH, enough for only a few more writes. Top up to keep writing." / "Your balance is 0: writes are off…" | `lib/view/funds.ts:161-167` | ok | |
| K4 | "This browser's key expires within 7 days" | `lib/view/funds.ts:185` | ok | `LOW_KEY_EXPIRY_MS` |
| K5 | Keys panel: "Top-up keeps this key and adds budget. Renew replaces it and disables this one. Revoke disables it on Platform. Each uses your master key once and does not store it." | `components/keys-panel.tsx:216` | ok | |
| K6 | Keys panel unlimited key: "Limits can't be added to this key. Replace it with a limited key: one approval in your wallet." | `components/keys-panel.tsx:160` | ok | DashConnect removal; `docs/guides/identity-and-keys.md:307` |
| K7 | Revoke dialog: "In DashPay for Android, open More → Tools → Connections and disconnect Dash Forge" | `components/key-revoke-dialog.tsx:89` | ok (see Q1) | names Android only |
| K8 | Devices & keys: "To disconnect a wallet sign-in, use Connections in DashPay or Dash Wallet." | `components/devices-keys.tsx:80` | ok | |
| K9 | Lost device: `dg auth keys rotate --encryption` "adds a new key, moves the private repos you maintain… The browser can't do this yet." | `components/devices-keys.tsx:368,395` | ok | `KeysCommand::Rotate { encryption }` (`crates/dg/src/auth/keys.rs:60`); `auth/rekey.rs` |
| K10 | "Platform disables up to {MAX_KEYS_PER_UPDATE} keys per update" | `components/devices-keys.tsx:342` | ok | constant used in the code that sends |
| K11 | Top-up sheet: "Buy credits in DashPay or Dash Wallet, then check again." | `components/top-up-sheet.tsx:192` | ok | verified in both apps during #707 |
| K12 | Identity top-up: "Send at least {MIN_TOP_UP} DASH to this address from any Dash wallet." | `components/identity-top-up-flow.tsx:181` | ok | |
| K13 | Spend panel: "Every write you sign here is recorded on this device only." | `components/spend-panel.tsx:154` | ok | local ledger (not in the synced prefs slot, `lib/user-sync/prefs-slot.ts:3`) |
| K14 | New-key alert copy | `components/new-key-alert.tsx:29-30` | ok | |
| K15 | Username hint: "A DPNS username makes your addresses readable (forge.dashhq.org/alice/project, @alice)" | `components/username-hint.tsx:32` | **wrong on testnet + jargon** (fixed) | The host was hard-coded, so testnet-forge.dashhq.org showed the mainnet host. Now reads "A Dash username … (/alice/project, @alice)". Short URLs: `lib/short-url.ts`. |
| K16 | Mainnet username: "Choose one in your DashPay wallet." | `components/username-hint.tsx:35` | **stale** (fixed) | Mainnet users may be on Dash Wallet for iOS. Now reads "Choose one in your Dash wallet app." |

## Account settings

| # | Claim (short quote) | Location | Verdict | Evidence |
|---|---|---|---|---|
| A1 | Storage, signed out: "Storage credentials stay encrypted in this browser." | `app/settings/storage/page.tsx:46` | **stale** (fixed) | On testnet a wallet sign-in now syncs them, encrypted, to forge-user on Platform (#729, `lib/user-sync/service.ts`). Now reads "Storage credentials are kept encrypted." |
| A2 | Sync note "Synced with your identity" / "On this device only"; "Your storage and display settings follow your identity to every device where you sign in with your Dash wallet." | `components/storage/sync-note.tsx` | ok | Shown only when forge-user is deployed. Only `forge-contracts/deployments/testnet.json` records `user`, so the note is shown on testnet and hidden on mainnet (status `off`, `hooks/use-user-sync.ts:62`). The synced slots are storage and prefs: diff, commit identity, fiat, stars, image hosts, IPFS gateways and orgs (`lib/user-sync/prefs-slot.ts:1-8`). |
| A3 | "To share these settings with your other devices, sign in with your Dash wallet and unlock this browser." | `components/storage/sync-note.tsx:18` | ok | `local` status = no sync key (not a wallet sign-in, or locked) |
| A4 | Security: "Stay signed in for public repos (up to 12 h)", "(4 h idle)" | `components/security-panel.tsx:48,53` | ok | `KEPT_TTL_MS`, `KEPT_IDLE_MS` (`lib/auth/session-resume.ts:32,34`) |
| A5 | Security, pasted key: "Import your identity file or recovery phrase to get a key this browser can keep." | `components/security-panel.tsx:51` | **stale on mainnet** (fixed) | It pointed to a phrase path that is a developer path on mainnet (#707). Now reads "Sign in another way to get a key this browser can keep." |
| A6 | Encryption key panel: "Wallets can't share your encryption key yet. To read and write private content here, add it below." | `components/encryption-key-panel.tsx:230` | ok | App Connect v2 grants a signing key only. The forge-user sync key is a separate key (`lib/user-sync/crypto.ts`). |
| A7 | Encryption key: "This identity has no encryption key that opens with that. Register one…, or run `dg auth keys add --encryption`." | `components/encryption-key-panel.tsx:112` | ok | `AddArgs.encryption` (`keys.rs:93`) |
| A8 | Settings nav: "Storage — Buckets and IPFS nodes for browser pushes"; "Notifications — Browser inbox[, email and push]" | `app/settings/page.tsx` | ok | `NOTIFY_URL` gate |
| A9 | Notifications: "Reads activity from the chain while Forge is open. No server involved." | `app/settings/notifications/page.tsx:28` | ok | |
| A10 | /settings/keys: "Every key on your identity, as the network has it." | `app/settings/keys/page.tsx:31` | ok | |
| A11 | Maintainer storage sharing copy (repo share notes, "rotate those storage keys") | `components/storage/repo-share-notes.tsx` | deferred → see maintainer-sharing.md #25–#30 | another thread is changing maintainer storage sharing |

## Banners

| # | Claim (short quote) | Location | Verdict | Evidence |
|---|---|---|---|---|
| B1 | Mainnet-live: "Forge {testnet} (test DASH only) — mainnet is live at forge.dashhq.org" | `components/mainnet-live-banner.tsx` | ok | shown on test builds only (`config.network === 'mainnet'` → null) |
| B2 | Clock skew: "Your device clock is wrong (… ahead) — enable automatic time to connect." | `components/clock-skew-banner.tsx`, `lib/sdk/clock-skew.ts:59-65` | ok | |
| B3 | New build: "A new version is available." + Reload (never automatic) | `components/new-build-banner.tsx` | ok | |
| B4 | Build integrity: "Unpublished build — verify before unlocking keys." | `components/build-integrity-notice.tsx` | ok | `lib/build-check.ts` |
| B5 | Devnet notice: "Repos, issues, stars and keys on this devnet will be wiped…" / "Writing is paused here…" | `lib/devnet-notice.ts:97-112` | ok | only with `NEXT_PUBLIC_DEVNET_NOTICE` |

## Organizations

| # | Claim (short quote) | Location | Verdict | Evidence |
|---|---|---|---|---|
| O1 | Mainnet: "Organizations are not available on mainnet yet." | `app/org/client.tsx:19` | ok | `ORGS_ON` is false on mainnet (org-multisig: mainnet gated) |
| O2 | "Start a group in multisig … Open multisig.dashhq.org … Then come back and connect it above with its invite link." | `components/org/connect-flow.tsx:20-29` | ok | `ConnectFlow` renders above `NewOrganizationSteps` (`app/org/client.tsx:44-45`); https://multisig.dashhq.org/ answers 200 |
| O3 | "Members and the threshold change in multisig.dashhq.org." | `app/org/client.tsx:133` | ok | |

## Product questions

1. **Revoke dialog names only Android.** `components/key-revoke-dialog.tsx:89` says to disconnect in "DashPay for Android, More → Tools → Connections". Does Disconnect in Dash Wallet for iOS 9.1.4 disable an App Connect v2 key on mainnet? The guide says the iOS app's Disconnect does not disable keys from the older code. If iOS works for v2 keys, the dialog should name both apps. This needs a wallet check, which this lane did not do.
2. **"password" vs "passphrase".** The wallet sign-in's protect step and `unlock-more.tsx:173` say "password" ("Use a password instead", "Save with password"). Everything else, including the docs, says "passphrase". Which word should the app use everywhere? Changing it is copy-only but touches many strings and tests, so I left it.
3. **dg handoff needs the master key.** `dg auth keys add --for-browser` always signs with the master key (`keys.rs:460`). A dg that signed in with the wallet only prompts for the recovery phrase in the terminal. The tile's "Already signed in to the dg command line?" can suggest that being signed in is enough. Should dg hand a browser a key without the master key, or should the tile say that it asks for the identity file or the words in the terminal?
4. **"Top up key budget" on mainnet.** It needs the master key, so it sits under Advanced on mainnet. Wallet keys can't be topped up in the wallet, only renewed. Should the top-up stay offered for wallet-granted keys at all?
