# Draft note: wallet login responder authentication (App Connect spec, Dash Wallet Android and iOS)

*Draft, not posted. The owner decides whether and where to file it: dashpay/platform (`docs/protocol/app-connect.md`), dashpay/dash-wallet, dashpay/dashwallet-ios.*

**Title:** Wallet login: let the app authenticate who answered (sign the request context), and stop a revoked login key coming back

## Problem 1: the app cannot tell who answered

A `dash-key:` request carries only an ephemeral public key and a contract id. Anyone who sees the QR code (over a shoulder, on a screen share, or as an app that registered the `dash-key:` scheme) can answer from their own identity. The response proves only that its author saw the request.

- On yappr's key-exchange contract (what the shipped wallets use), the unique index `(contractId, appEphemeralPubKeyHash)` keeps the **first** answer only. An attacker who answers first is the only answer the app can see, and the real wallet's publish then fails as a duplicate.
- On App Connect (`H8F9…`), the index includes `$ownerId`, so two answers are visible and an app can refuse. Only one answer is still unauthenticated. `app-connect.md` step 3 says so: "pairing and approval must establish which identity the app intends to log in".

Today every app has to ask the user to compare the username and the shortened identity id (first 7 and last 5 characters) that the wallet's approval screen shows. Dash Forge does, with extra warnings, but that is a human check.

**Proposal.** The response carries a signature over the request context, made with a key of the identity it answers for:

```
msg = "dash:login-response:v1" ‖ hash160(appEphemeralPub) ‖ contractId(32) ‖ network(1) ‖ walletEphemeralPub(33) ‖ sha256(encryptedPayload)
sig = sign(msg) with an AUTHENTICATION key of $ownerId (HIGH or CRITICAL), plus its key id
```

The app verifies `sig` against that key on chain. That proves the answer came from someone holding a key of `$ownerId`, not merely from someone who saw the QR. Whoever saw the QR can still sign for *their own* identity, so this does not replace the confirmation step, but it does make the identity the app shows one that provably answered.

- App Connect: add an optional `responderSignature` (65 bytes) and `responderKeyId` (u32) to `loginKeyResponse` (schema version 2), or put them inside the encrypted payload so they are not public.
- Legacy contract: put them inside the encrypted payload (after the 32-byte login key). A new payload length tells apps it is present.

## Problem 2: a revoked login key comes back

The login key is `HKDF(chainKey, identityId, "dash:login-key:v1" ‖ contractId)`, the same for every login of that identity to that app. If the user (or the app) disables the key after a compromise, the next login derives the same key. iOS asks to register it again (`missingKeyRegistrationKeys` skips disabled keys); Android treats it as registered and never offers QR #2. Either way the wallet cannot give the app a fresh key, and an app that accepted the same key again would revive any copy stolen before the disable. Dash Forge refuses a key that matches a disabled one, so the user cannot use wallet sign-in for that identity again: both wallets derive from a fixed chain-key index.

**Proposal.** Add a per-app, per-rotation salt to the derivation: `info = "dash:login-key:v2" ‖ contractId ‖ rotation(u32)`, where the wallet bumps `rotation` for that app when it sees its current key disabled on chain, or when the user taps "Reset this app's key". Keep a local record per app. The key registered after a revoke is then new.

## Acceptance

- A response lets the app prove which identity signed it; an app that verifies the signature rejects a response signed by a different identity than `$ownerId`.
- After a login key is disabled, the next approval registers a different key.
