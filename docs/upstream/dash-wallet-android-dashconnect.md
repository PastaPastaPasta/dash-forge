# Draft issue: dashpay/dash-wallet — DashConnect: limited, group-scoped grants via App Connect (protocol 14)

*Draft, not posted. The owner decides whether and when to file it.*

**Title:** DashConnect: grant apps limited, group-scoped keys and publish to the App Connect system contract (protocol 14)

## Context

Dash Forge (a git forge on Platform) signs users in with the DashConnect key exchange in the wallet's `master` (`ui/more/connections/`, MO-945; not in a release yet). Forge matches the current code byte for byte in unit and simulated tests on testnet's rules; it has not been run against a device. Protocol 14 adds what apps need to hold a wallet key safely, and the wallet does not use it yet:

- contract-group bounds for AUTHENTICATION keys (`contractBounds: contractGroup`, platform `docs/protocol/contract-bound-authentication-keys.md`);
- key budgets and expiry (`IdentityPublicKey` V1 `totalBudget` / `expiresAt`, `docs/protocol/authentication-key-limits.md`);
- the App Connect system contract `H8F9mP1BM55TE1ShsxPZHzhyinaMdY9bMmP85mkDhcJJ` (`docs/protocol/app-connect.md`), with the same id on every network and deployed at protocol 14. The yappr key-exchange contract `7UaqHGBJBbRLJ4fUWS45cnud8PPUugJWoGTt1SKwHJ2P` exists only on testnet.

## What happens today (from the source, `master` fedb593e4)

1. `completeKeyRegistration` rebuilds the `dash-st:` update with the auth key **unbounded and without limits** (`IdentityPublicKey(nextKeyId, ECDSA_HASH160, AUTHENTICATION, HIGH, null, authData, false)`). Whatever bounds the app put in the transition are dropped. The app therefore holds a HIGH key that can sign on **any** contract, with no spending limit and no expiry, until the user disables it with the master key.
2. The request carries one contract id, and the login key is derived from it, so an app spanning two contracts (Forge: forge-core + forge-collab) needs two approvals.
3. `KEY_EXCHANGE_CONTRACT_ID` is pinned to the testnet yappr contract, and the feature is gated on `IS_TESTNET_BUILD`, so no devnet or mainnet support is possible.
4. If an app disables a login key (for example "sign out everywhere"), `approveLogin` treats the key as still registered because it does not check `disabledAt`, so the app is never offered QR #2 again.

## Request

(a) **Keep the bounds, and accept a contract-group id.** In `completeKeyRegistration`, keep the `singleContract` bound from the app's transition, and allow `contractGroup` when the request's 32-byte id resolves to a contract group on chain (`contractGroups.info`). Show the group's name and member contracts on the approval sheet. A group bound lets one approval cover an app's whole contract set.

(b) **Grant limits and publish to App Connect at protocol 14.** On protocol ≥ 14, register the app's key with a budget and an expiry the user picks (defaults such as 0.05 DASH / 90 days), wait for it to be confirmed, and publish the `loginKeyResponse` to the App Connect system contract (index-only; delete the previous response with its original values before creating a new one, `app-connect.md` §Approval and re-login). Keep yappr's contract as the fallback on testnet until apps have moved. This also removes the testnet-only gate.

(d) **Check `disabledAt`** when deciding whether the login keys are already registered. **Do not derive the same key after a revoke**: add a per-app, per-rotation salt to the login-key derivation (`"dash:login-key:v2" ‖ contractId ‖ rotation`), and bump it when the app's key is found disabled. Today a disabled login key counts as registered, so the app is never offered QR #2, and the wallet can never give that app a fresh key.

(e) **Sign the request context** in the response, with a key of the answering identity, so the app can authenticate who answered. On yappr's contract the first answer is the only one the app can see, so an observer of the QR who answers first can only be caught by the user comparing ids. Details: [app-connect-responder-auth.md](app-connect-responder-auth.md).

## Acceptance

- A Forge login on a protocol-14 devnet (sakura) or testnet produces one AUTHENTICATION/HIGH key bound to the Forge contract group, with a budget and an expiry, and a `loginKeyResponse` in `H8F9…`.
- Existing yappr logins on testnet keep working.

Reference implementation on the app side: dash-forge `forge-web/lib/auth/app-connect.ts` (reads both contracts) and `docs/design/wallet-login.md`.
