# Draft issue: dashpay/dashwallet-ios — DashConnect: accept contract-group bounds, grant limits, publish to App Connect (protocol 14)

*Draft, not posted. The owner decides whether and when to file it.*

**Title:** DashConnect: accept contract-group grants, register keys with budget and expiry, publish to the App Connect system contract

## Context

Dash Forge signs users in with the DashConnect key exchange (`Models/DashConnect/`). On testnet and on devnet (with the configurable login contract) it works with today's code. Protocol 14 adds contract-group bounds, key budgets and expiry, and the App Connect system contract `H8F9mP1BM55TE1ShsxPZHzhyinaMdY9bMmP85mkDhcJJ` (platform `docs/protocol/app-connect.md`, `contract-bound-authentication-keys.md`, `authentication-key-limits.md`).

## What happens today (from the source, `develop` a345cc852)

1. `PlatformWalletDashConnectStateTransitionParser` **throws `keyRegistrationUnexpectedMutation` on a `contractGroup` bound** (dashpay/platform#4853 left the DPP `ContractBounds` without that case). An app that asks for a key bound to its contract group cannot complete the first login.
2. `makeManagedIdentityPubkey` passes no `totalBudget` / `expiresAt`, so an app's key has no spending limit and no expiry, even though `ManagedPlatformWallet.IdentityPubkey` supports both (`ShareLoginKeyView` in the platform SwiftExampleApp already uses them).
3. The response goes to yappr's key-exchange contract (the testnet id is pinned; on devnet the id is entered by the user), not to the App Connect system contract.
4. The pairing code is not shown (`BrowserLoginKeyProtocol.pairingCode` exists in the platform example app).

## Request

(a) **Accept `contractGroup` bounds** in `dash-st:` key registrations: map the FFI's kind 3 into `ContractBounds`, and use the group id to find the approved connection when the request's id is a group. Show the group's name and member contracts on the approval sheet.

(b) **Register limited keys and publish to App Connect** at protocol ≥ 14. Set a budget and an expiry the user picks on the registered auth key, then publish the `loginKeyResponse` to `H8F9…` once the key is confirmed (index-only; delete-then-create on re-login). Keep the yappr contract as the fallback on testnet.

(c) **Show the pairing code** on `ApproveConnectionSheet`.

(d) **Do not re-add a revoked key.** `missingKeyRegistrationKeys` treats a disabled login key as missing and adds the very same key again: a key the user revoked (after a compromise, say) comes back with any stolen copy. Add a per-app, per-rotation salt to the derivation (`"dash:login-key:v2" ‖ contractId ‖ rotation`), bumped when the current key is found disabled.

(e) **Sign the request context** in the response, with a key of the answering identity, so the app can authenticate who answered: [app-connect-responder-auth.md](app-connect-responder-auth.md).

## Acceptance

- A Forge login with a group-id request completes: one AUTHENTICATION/HIGH key bound to the Forge group, with a budget and an expiry, and a response in `H8F9…`.
- The pairing code matches the one the app shows.
- yappr logins keep working.

App-side reference: dash-forge `forge-web/lib/auth/app-connect.ts`, `docs/design/wallet-login.md`.
