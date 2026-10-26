# Passkeys for other devices: the passkey vault and its threat model

Status: implemented in the web app, and live wherever forge-meta has the `vaultEntry` type: on testnet since its forge-meta update to version 2 on 2026-10-26 (see [Deployment status](#deployment-status)). Elsewhere it stays hidden. The contract is [forge-v2.md §2](../contracts/forge-v2.md#forge-meta-mainnet-set-only), and the user-facing guide is [identity and keys](../guides/identity-and-keys.md#passkeys-for-other-devices).

## What it is

A passkey added in the web app holds a copy of the browser's current session keys, encrypted to that passkey, in a public `vaultEntry` on Platform. On another device, **Sign in with a passkey** reads the entry, decrypts it with the passkey, checks every key in it against the identity, and keeps the session in that browser's own vault under the same passkey.

**Passkeys move a session. They do not recover an account.** The keys inside are the ordinary limited keys Forge signs with: they have a budget and an expiry (a key Forge registers lasts at most a year; a wallet may ask for other limits), and they stop working when they expire, run out or are disabled. Getting a new key still takes the identity file, the recovery phrase or the wallet that granted the old one. A passkey cannot create, renew or top up anything; it only carries across the key you already have.

## Why the entries are public

Platform stores documents in the open. An entry's ciphertext is readable by anyone, and stays readable in the state-transition history after the entry is deleted. Everything below follows from that: the protection is the passkey (a PRF output only the authenticator can produce), never the secrecy of the entry.

## What an entry holds

One format, always padded to the same size (240 bytes plaintext, 256 sealed), so an entry does not show how many keys it holds or which kind of key is in it.

| Slot | Holds | Rule |
|---|---|---|
| 0 | The session's main key | AUTHENTICATION, HIGH, secp256k1 or its hash160, **bound to the `dash-forge` contract group, with a budget and an expiry**. A Forge limited key or an App Connect v2 wallet key. |
| 1 to 4 | Live per-contract wallet grants | Only keys with **both a budget and an expiry**. A grant with no spending limit, or no expiry (a v1 wallet's one-contract key), is left out and stays on the device that holds it. Never a key held only to be disabled later. |
| 5 | The identity's usable encryption key | Only when the user ticked "Also keep my encryption key". Off by default, with a warning that it cannot be taken back. |

Never stored: a MASTER, TRANSFER or CRITICAL key, a key with no bounds, a key bound to something other than Forge's contracts, or a key pasted into a tab ("Advanced"). The extras rule above exists because of the previous section: **a leaked passkey must never yield a key that does not expire or has no spending limit.** The same rule is applied again when an entry is opened, so an entry planted with such a key gets it dropped.

The web app says so where it matters: the add dialog and the passkeys section read "Keys without a spending limit stay on this device only", and the section counts how many keys that is.

## Where it works

A passkey's relying party id is the page's host. Forge allows exactly `forge.dashhq.org` and `localhost` (development and the end-to-end suite), nothing else:

- Never `dashhq.org`: every subdomain could then ask the browser for the same PRF output and open every entry.
- Not a shared origin (a GitHub Pages project site, an IPFS path gateway) and not an IPFS subdomain gateway (one origin per release, so the passkey would be lost with the next one).
- Not an IP address: WebAuthn does not allow one. The end-to-end suite opens `http://localhost:<port>` for that reason, not `127.0.0.1`.

The web app hides every passkey control (`platformPasskeyProblem`) wherever the page cannot have them, the browser has no passkeys, the network has no forge-meta, or the deployed forge-meta has no `vaultEntry`.

## Flows and checks

**Add** (signed-in session, key kept in the browser, whole vault unlocked in this tab, no staged renewal, fewer than 10 passkeys): make the passkey, confirm it with a second prompt limited to it, derive the recipient key from the confirmed PRF output, seal the keys and write the entry, wait until Platform shows it, then record a local marker (credential id, recipient key, key ids) in IndexedDB. A passkey made but not yet seen on Platform is kept across reloads for **Check again**, or deleted by **Discard** (the entry first, if Platform has it). Writing an entry costs about 0.0005 DASH, paid from the key's budget ([costs](../guides/costs.md#passkeys-for-other-devices)).

**Sign in on a new device**: one discoverable prompt for any of the site's passkeys; the user handle must be a vault's (64 bytes: identity and forge-meta). A 32-byte handle is a passkey the browser made for its own vault: "This passkey only unlocks the browser that made it." The entry is read with a proof and opened only if the passkey's derived key is the entry's recipient key. Every slot is then checked against the identity read fresh with proofs:

- slot 0 is on the identity, enabled, matches the private key, is group-bound with a budget left and an expiry still ahead; if it fails, the sign-in is refused with the reason ("disabled", "expired", "no budget left");
- every extra must pass the same checks and have a budget and an expiry; one that fails is dropped;
- the encryption key is kept only if it is the identity's usable one and matches.

The keys then go into the browser vault, protected by the same passkey (its local key is derived from the same PRF output under a different label than the entry's). A browser that already keeps a key for the identity stops and offers **Unlock instead**.

**List and remove**: each passkey shows when it was added, "This device" or "Another device", the key it holds and that key's state, and **Needs update** when it holds an older key. Removing deletes the entry (the deposit comes back) and tells the passkey provider only about this device's own credentials. The key it held stays live.

**Re-seal**: when this tab changes its keys (a renewal, a new wallet grant, an imported encryption key) the entries this device made are encrypted again, without a prompt, but only if the recipient key on Platform is the one this device recorded. A new encryption key is never added silently: an entry that held the old one shows **Needs update**, and you tick the encryption key again when you update that passkey (the usual reason to replace it is a suspected leak). Other devices' entries show **Needs update**, which asks that passkey once: the key it derives must be the entry's recipient key before anything is sealed to it.

**Revoke and disable**: the dialogs that disable a key offer to delete the passkeys that name it first, while the key can still sign. That step is best effort: if it fails (this browser's key has no budget left, or Platform is slow) the key is still disabled and the page says which passkeys to remove in Settings.

**Renewing a restored key**: a passkey does not say who made the key (a wallet or the master key), so a session restored from one is stored with origin `passkey`, and renewal offers both **Renew in your wallet** and **Renew with identity file**. It also follows the wallet-key rule of starting no write in the key's last minutes. A wallet only disables the key of its own earlier grant for the same browser, so renewing a passkey's key in a wallet leaves the restored key live: it is kept here never to sign, is never put into a passkey again, and the next renewal or revoke disables it.

## Threat model

**Planted entries.** Any live key the identity has that forge-meta accepts can write an entry for the owner, including a leaked one. HPKE authenticates nobody, so an entry proves nothing by itself. Mitigations: every opened slot is checked against the identity's keys read with proofs; and Forge only encrypts new keys to a recipient key it derived in this tab or that a passkey confirmed (or that this device recorded), so a planted entry cannot trick a user into sealing fresh keys to an attacker's passkey.

**Stale entries.** A revoked, expired or spent key fails the check, and the sign-in says to sign in another way. Two things outlast it:

- The encryption key inside stays readable to anyone holding the passkey, and the old ciphertexts stay public in the history for good. Removing the passkey does not lock that person out: the encryption key must be replaced too ([replacing it](../guides/identity-and-keys.md#replacing-it-after-a-lost-device)). That is why it is opt-in with a warning.
- Expiry is the limit of what a passkey can do: it moves a session between devices; it does not recover an account.

**What is public.** The owner, how many passkeys there are, when each was written or changed, the credential id (its length can hint at the passkey provider) and the `authKeyId`, which says which of the identity's keys is the main one. The fixed size hides how many keys an entry holds and whether it holds a wallet's key or Forge's own.

**Shared devices.** Every device uses the same key and the same budget, so one device can spend what the others would, and disabling the key signs all of them out. The passkeys section says so. Spending is capped by the key's budget whatever a leaked passkey does.

**A leaked passkey.** Whoever holds the passkey and can read the public entry gets the keys inside: a group-bound key with a budget and an expiry, and possibly an encryption key. They cannot get a master key, a key without limits, or anything that outlives the expiry. **A top-up of the key (more budget or a later expiry) reaches every passkey that holds it**, because the passkey holds the key, not a copy of its limits: disable the key when a passkey may have leaked, rather than topping it up. Disable the key (Devices & keys, or Revoke) and delete the entry.

**XSS.** A script injected into the page could ask the user's passkey to seal keys to an attacker without a separate prompt for the attacker's key. It could already read an unlocked key and sign with it, so the exposure is the same; the page's CSP is the defence ([hosting.md](../hosting.md#7-security-headers)).

**Framing.** There is no `frame-ancestors` header on GitHub Pages ([hosting.md §7](../hosting.md#7-security-headers)), and an attacker's page can delegate `publickey-credentials-get` to a frame. That is one more reason to add the header at the host (Cloudflare in front of Pages can). A framed page never picks up a session, and the policy refuses a shared origin.

**Weak spots left.** A passkey provider that syncs its passkeys (iCloud Keychain, Google Password Manager) is as safe as that account. A passkey without PRF support cannot be used; the add stops with a clear message. Pending enrolments are settled by looking for the entry on Platform (Yappr's nonce-level settling is not built).

## Deployment status

The `vaultEntry` type is in the committed forge-meta (`forge-contracts/contracts/mainnet/forge-meta.json`).

- **Testnet: live.** forge-meta was updated in place to version 2 on 2026-10-26: one `DataContractUpdate`, `deploy-v2.mjs --set mainnet --update meta`, signed by the testnet deployer with `--expect-sha256`, then `snapshot-contracts.mjs`. The scratch set got the same update first. On both, the live test showed that a group-bound limited key writes `vaultEntry` ([evidence](../../forge-contracts/evidence/testnet/README.md#forge-meta-update-to-version-2-the-passkey-vault-2026-10-26)). Testnet lists the flag in its `since` (`build.py` `NETWORK_REGISTRATIONS`), so `--check` still reproduces what testnet registered.
- **Devnet sakura: not updated.** It is retired and unreachable; the same update, signed by its deployer, would be needed if it came back.
- **Mainnet:** the type is part of the registration set.

Where forge-meta has no `vaultEntry`, the feature is **inert**: the web app reads forge-meta from Platform (a proved fetch, which bypasses the bundled snapshot) and shows no passkey tile, no passkeys section and no offer while the contract has no `vaultEntry`. A read that fails also hides them. Nothing breaks and nothing is spent.

If forge-meta is ever re-registered with a new id (`--force-new`), every passkey stops working: the contract id is in the PRF input and in the user handle. The new contract starts empty, and each user adds passkeys again.

## Tests

- The core (`platform-auth`): RFC 9180 vectors, Yappr's and govhub's formats byte for byte, Forge's vectors cross-checked by an independent Python generator, negative cases (wrong passkey, identity, contract, credential; bit flips; padding; slot rules).
- `forge-web/lib/auth/passkey-vault/*.test.ts` and `lib/auth/passkey-session.test.ts`: enrol, sign in, store locally, planted keys refused (not on the identity, disabled, expired, no budget, unbounded, foreign group, **extras without a budget or an expiry**), the "not-vault" and "other-vault" handles, the cap, re-seals that touch only this device's entries, removal that signals only this device's credentials, wiped buffers.
- Component tests for the sign-in tile, the passkeys section, the one-time offer and the revoke and disable dialogs.
- `forge-web/e2e/passkey-vault.spec.ts`: Chromium with a virtual authenticator (CDP `WebAuthn.addVirtualAuthenticator`, PRF) on `http://localhost`. The hermetic cases run anywhere; the full flow needs `E2E_WRITE=1` and a forge-meta with `vaultEntry`.
- `forge-web/lib/auth/passkey-vault.live.test.ts` (`FORGE_LIVE=1`): a fake authenticator on testnet (or a devnet), printing each step's fee.
