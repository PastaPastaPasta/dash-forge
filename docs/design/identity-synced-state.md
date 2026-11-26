# Settings that follow the identity (storage, preferences, maintainer access)

Status: built. Settings sync shipped in [#729](https://github.com/PastaPastaPasta/dash-forge/pull/729), and repo-only maintainer sharing in [#740](https://github.com/PastaPastaPasta/dash-forge/pull/740). testnet-forge.dashhq.org runs both; `dg` has them when built from source (no release includes them yet). forge-user is registered on testnet only; mainnet is the owner's decision (§9). Designed 2026-11-25. Request from the owner (via Forge PM): "if I set up storage in cli via dash wallet login, any other dash wallet login should share that storage automatically, whether in another wallet or computer. Being a maintainer should let someone else see the storage / use the storage (r2 / ipfs, not platform spend)."

## 1. Where things live today

| Data | forge-web | dg / git-remote-dash |
|---|---|---|
| Storage profiles (S3/R2, kubo, pinning, NAS, self-hosted backend), default policy, per-repo policies | one sealed blob in the IndexedDB vault (`lib/storage/store.ts`, `vault.ts` `writeStorageBlob`), opened by this device's passkey or passphrase | `~/.config/dash-forge/storage.toml`; secrets as `env:` / `keychain:` references (`forge-core/src/storage/profiles.rs`) |
| Display preferences (diff layout, whitespace, palette), merge author name/email | `localStorage forge.prefs.v1` | `git config` |
| Fiat display | `forge:fiat:v1` | `fiat.toml` |
| Trending, image hosts, IPFS gateways, IPFS peer setting | `forge.trending.v1`, `forge.imageHosts.v1`, `forge.ipfsGateways`, `forge.ipfsPeer` | `storage.toml [read]` |
| Organizations you follow | `forge:orgs:<network>` | `org` config |
| Session, vault, connection id, resume, banner dismissals, drafts, DAPI budget | local by nature | local by nature |

None of it leaves the device. A second login (another browser, another wallet app, another computer) starts empty.

## 2. The one key every wallet login can derive

App Connect v2 can hand the app a **shared encryption key**: the wallet derives it from the seed at the DIP "Encryption Keys" path `m/9'/coin'/5'/7'/0'/identityId'/contractId'/purpose'/rotation'`, rotation 0, and registers its public key on the identity as `ECDSA_SECP256K1 / ENCRYPTION / MEDIUM`, bound to that one contract. Every approval sends the same private key again. That holds on any device and in any wallet app restored from the same recovery phrase. Checked against the source:
- DashPay Android: released v11.9.2, `AppConnectSession.kt` `ApplicationKeyDerivation.encryption(seed, identity, contractId, purpose, rotation = 0)`;
- Dash Wallet iOS: `develop` f6e507b5b, `AppConnectV2Login.swift` (same path).

The wallets have two conditions (Android `AppConnectSession.kt:250`, iOS `ownershipRefusal`):
1. The encryption binding must name the request's **app contract** (`appId`).
2. That contract must opt in with `requiresIdentityEncryptionBoundedKey` set to `Unique` or `MultipleReferenceToLatest`.

No Forge contract opts in (`forge-contracts/evidence/*/c1.json`), and Platform forbids changing that setting on an existing contract (`rs-dpp` `validate_update_v0`: "contract can not change the requirement of needing a document encryption bounded key"). **So automatic sync for wallet logins needs one new contract.** Nothing else a wallet login holds is the same on two devices: the auth key is derived per request (`hash256(appEphPub ‖ index)`), and the connection id is random per browser.

We considered and rejected three alternatives:
- **Keys per device, re-wrapped by an existing device.** It needs a device that is already signed in to be online. That fails "automatic", and fails outright for someone with only one device that was wiped.
- **Storing it in an existing document type** (`vaultEntry.sealed` is at most 256 bytes; `profile` and `board` would change what those documents mean). This breaks the rule that existing documents keep their meaning.
- **A Forge-hosted key service.** The owner decided "we host nothing".

## 3. Data model: contract `forge-user`

A new, small contract, `forge-contracts/contracts/forge-user.json`, owned by the deployer that owns the other Forge contracts:
- `requiresIdentityEncryptionBoundedKey: 2` (`MultipleReferenceToLatest`, as yappr's vault contract uses);
- registered as a member of the existing `dash-forge` contract group. Every group-bound key a wallet already granted can therefore write to it without a new approval. Older web and dg builds accept unknown group members owned by the same owner (`assertGroupHolds`; `dg auth group.rs`, rule 4).

| Type | Owner | Fields | Index | Mutable / deletable |
|---|---|---|---|---|
| `state` | the identity | `slot` (string ≤ 32: `storage`, `prefs`), `v` (format, 1), `keyId` (the enc key used), `n` (12-byte nonce), `d0` `d1` `d2` (ciphertext, ≤ 5000 bytes each) | unique `($ownerId, slot)` | yes / yes |
| `share` | the repo owner | `repoId`, `epoch` (u32), `n`, `d0` `d1` (the repo's storage, under the repo storage key) | unique `($ownerId, repoId)` | yes / yes |
| `grant` | the repo owner | `repoId`, `memberId`, `epoch`, `recipientKeyId`, `senderKeyId`, `wrapped` (≤ 96 bytes) | unique `($ownerId, repoId, memberId)`; `(memberId)` | yes / yes |

Only the owner of a Platform document can change or delete it, so nobody but the identity can write its `state`. The same goes for the repo owner's `share` and `grant`. Readers accept a `share` or `grant` only when its `$ownerId` is the repo's owner.

## 4. Encryption

The normative definitions are `tools/user-sync-vectors/gen.py` and its output, `forge-contracts/fixtures/user-sync/vectors.json`. Rust and TypeScript must both reproduce every value in the vectors. The primitives are AES-256-GCM (16-byte tag), HKDF-SHA256 (32-byte output) and secp256k1 ECDH (the x coordinate). Ids are their 32 raw bytes, `lp(s)` is a one-byte length followed by the UTF-8 bytes, and `u32` is big-endian. `network` is Forge's network key (`mainnet`, `testnet`, `devnet-<name>`).

- **State.** `E` is the wallet's shared encryption private key for `forge-user`, and `keyId` is its id on the identity.
  - `K = HKDF(ikm = E, salt = identityId, info = "forge-user/v1/state/" ‖ network ‖ "/" ‖ slot)`.
  - `AAD = "forge-user/v1" ‖ lp(network) ‖ identityId ‖ lp(slot) ‖ u8(v) ‖ u32(keyId)`.
  - The plaintext is `deflate-raw(JSON)`. The ciphertext (with its tag) is split into 5,000-byte pieces `d0`, `d1`, `d2`, so at most 15,000 bytes. `n` is a fresh random 12-byte nonce on every write.
- **The repo storage key.** `RSK(repo, epoch) = HKDF(ikm = E_owner, salt = repoId, info = "forge-user/v1/repo-storage/" ‖ network ‖ "/" ‖ u32(epoch))`. Any device of the owner derives it, so the owner needs no grant to themself.
  - The share is encrypted under it with `AAD = "forge-user/v1/share" ‖ lp(network) ‖ repoId ‖ u32(epoch) ‖ u32(keyId)`, which binds the `keyId` the owner derived it with.
- **A grant.**
  - `shared = ECDH(E_owner, P_member)`.
  - `W = HKDF(shared, salt = repoId, info = "forge-user/v1/grant/" ‖ lp(network) ‖ memberId ‖ u32(epoch) ‖ u32(senderKeyId) ‖ u32(recipientKeyId))`.
  - `wrapped = nonce(12) ‖ AES-GCM(W, RSK, AAD = ownerId)`, which is 60 bytes.
  - The member computes `ECDH(E_member, P_owner)` from the owner's key, which it reads as `senderKeyId` on the owner's identity.
- **Plaintext formats.** Every slot is a last-writer-wins map: `{"format": "forge-user/<slot>", "version": 1, "entries": {key: {"at": ms, "v": value | null}}}`, where `null` is a tombstone.
  - Storage keys are `profile:<name>` (`{settings, secrets}`, in the same camelCase fields as the web app's `StorageProfile`), `default` (a policy), `repo:<repoId>` (a policy) and `test:<name>`.
  - Prefs keys are `diff`, `mergeIdentity`, `fiat`, `trending`, `imageHosts`, `ipfsGateways`, `ipfsPeer` and `orgs`.
  - A share is `{"format": "forge-user/share", "version": 2, "profiles": {name: {settings, secrets}}, "policy": policy}`. Version 2 marks a share written under the repo-only rule (§5); version 1 shares, from builds that could share the default storage, are still read. The version sits inside the encrypted plaintext, so the share's AAD and keys are unchanged.
  - A reader ignores entries it does not understand and writes them back unchanged, so older and newer clients do not erase each other's keys.
- Decrypted settings are held in memory. The web app writes them through to the existing local vault blob (sealed as today), and dg to the OS keychain or sealed file (§7). Nothing is logged. In Rust, every credential is held in the redacting `Secret` type.

## 5. Flows

**Sign-in.** The App Connect v2 request gains one encryption binding (purpose ENCRYPTION, contract `forge-user`), and its `appId` becomes `forge-user` wherever that contract exists on the network; elsewhere it stays as it is today. The auth binding is unchanged (contract group, HIGH, the same limits). The wallet shows the same title (the owner's DPNS name). The response carries the key, which Forge checks against the identity before use: `ECDSA_SECP256K1`, ENCRYPTION, bound to `forge-user`, not disabled, and its public key matches the private key. dg (`dg auth login --wallet`) stores `E` next to its auth key (keychain, else the sealed file). The web app keeps it in the vault, under the same rules as the private-repo encryption key (memory for the tab, sealed at rest, never in the 12 h resume record).

**Sync** is invisible. Once a session holds `E`, both clients read the `state` slots when they start and after each change, and write the merged result back. The effective storage config is the merged view (§7). Settings → Storage shows no new screen. One collapsed line under "More" says "Synced with your identity" (or "On this device only", with how to turn sync on).

**Maintainers.** Maintainers get only storage the owner set **for that repository**: the owner's synced `repo:<id>` storage policy. They never get the owner's default storage or any other account-wide credentials. The owner sets it with `dg storage share <owner/repo> <profile>[,<profile>…] [--copies N]` or in the repo's Settings → Storage, and stops it with `dg storage share <owner/repo> --stop`. When the owner's client holds `E` and that policy names a non-Platform profile:
1. It writes `share` (epoch e), holding only the profiles that policy names.
2. For each current maintainer (forge-core `maintainer` docs) whose identity has a live `forge-user` encryption key, it writes a `grant`.

With no `repo:<id>` entry (absent, or tombstoned by `--stop`), or one naming only Platform, sharing stops (below). An entry that can't be used (it does not parse, or names a profile that is missing, tombstoned, of an unknown kind or invalid) keeps the share as it is and lends it to no new maintainer, but only a version 2 share: a version 1 share that lends storage may hold the default, so it stops the same way. Clients write every share as version 2 and never rewrite one newer than they know. This is reconciled on each owner visit to the repo's settings, each owner `dg` push, `dg collab add/remove` and `dg storage share`. When the owner adds a maintainer to a repo with no storage of its own, dg says the maintainer pushes to their own storage and how to share it. A maintainer pushing to a repo whose owner shares nothing sees one line, once per repo per device, naming the command the owner can run; their own storage is used. A maintainer with no key yet is listed, collapsed, as "gets access after signing in with a wallet once". A maintainer's client merges granted repo profiles into its effective config for **that repo only**, so its pushes to that repo store packs in the owner's storage. Its Platform writes still use its own identity's key and credits.

**Removal.** When the owner removes a maintainer (web or `dg collab remove`), or the reconcile finds a grant to someone who is no longer a maintainer, the client:
1. moves to epoch e+1;
2. re-encrypts `share` with `RSK(e+1)`;
3. rewrites the remaining members' grants;
4. deletes the removed member's grant.

The removed member can no longer read the current share. **What cannot be revoked:** credentials they already decrypted, and old document versions anyone may have cached. The removal screen therefore says so in one line and links to `docs/guides/rotate-storage-credentials.md`: roll the S3 key, kubo auth or pinning token, update the profile, and the share follows automatically.

## 6. Threat model

| Adversary | Gets | Doesn't get |
|---|---|---|
| Anyone reading the chain | that the identity has sync slots, their sizes and update times; which repos share storage with whom (the `grant` rows are public) | any setting or credential (AES-GCM under keys derived from `E`) |
| A Platform node | the same; it can withhold or roll back a document (the client then shows the older config, which is not a secret leak) | the plaintext |
| A current maintainer | the shared profiles of that repo, including credentials, by design | the owner's other profiles, the owner's prefs, the owner's Platform key or credits |
| A removed maintainer | what they saw before removal (rotate it, §5) | anything shared after removal |
| XSS in the Forge origin, with a session unlocked | `E`, and through it the synced config. This is the same exposure as today's vault blob and private-repo key | the wallet seed, other apps' keys |
| Malware on a device running dg | `E` from the keychain or sealed file. This is equivalent to today's storage.toml secrets | the seed |
| A phishing page that gets a wallet approval | `E` (SECU-08), and with it this identity's synced settings, including storage credentials, and every repo share the identity can open. That's more than an auth-key phish gives. | the seed, and other apps' keys |
| Disabling `E` on-chain | blocks new grants to it | old ciphertext. The rotation path is a new rotation index, which the wallets do not offer yet |

`E` is bound to `forge-user` only. It can't open private-repo content (that uses the separate encryption key from Settings) and can't sign anything.

## 7. Migration and merge (additive)

- **Local data is never deleted or rewritten by sync.** The web vault blob and `storage.toml` stay the source on their device. The synced copy is written alongside, and the local blob gains synced profiles (write-through), so older builds on the same device keep working.
- **First sync on a device.** If a local config exists and the `storage` slot is empty, the client uploads it, re-reads it, decrypts it and checks it is deep-equal to what it uploaded. It records `syncedAt` locally only after that check. Until then the local copy is what pushes use.
- **Merging.** Profiles are merged by name, with an `updatedAt` per profile and tombstones for deletions made on a synced device.
  - A local profile that is not in the synced copy is uploaded.
  - When names collide with different settings, nothing is dropped: the newer one is the synced copy, and the other is kept as `<name>-<device short id>` on the device that had it. Policies follow the same last-writer-wins rule per repo.
  - A tombstone hides a profile from the merged view, but leaves it in the local blob or `storage.toml`, where it can be restored from "On this device only".
- **dg** materializes synced profiles in memory and in the keychain (`keychain:dash-forge-sync/<network>/<identity>/<profile>`), never into `storage.toml`. A profile in `storage.toml` wins on name. `dg storage list` marks each profile as local or synced.
- **Old clients against new data.** They never read `forge-user`. Their local data is unchanged, so they behave exactly as before.
- **New clients against old data.** With no `forge-user` contract on the network, or a session without `E` (passkey, identity file, pasted key, or a wallet login from before this change), they behave exactly as today. The only addition is the collapsed line.

## 8. Backwards compatibility

- **No change to any existing contract, document type or document meaning.** `forge-user` is a new contract that joins the existing group.
- **Local storage config, credentials, keys, repos and packs** keep working, and nothing local is deleted (§7). A migration test (`forge-web/lib/user-sync/migration.test.ts`, `crates/forge-core/src/user_sync/migration_tests.rs`) starts from master-format state (a web vault blob and `forge.prefs.v1`; a dg `storage.toml` with `keychain:` refs) and proves that the merged view contains every profile, policy and preference, and that the local stores are byte-identical afterwards except for additions.
- **Sign-in request.** On networks with `forge-user`, `appId` changes from forge-core to forge-user.
  - Consequence: the wallet's "disable the previous key for the same identity/app/connection id" rule doesn't match the browser's older forge-core-app grant on the first new sign-in. That older key stays live until it expires or the user disconnects it in the wallet.
  - It loses no data, and the existing "older key from this browser" row in Settings lists it.
  - A wallet that refuses the binding (an older iOS) leaves the user unable to sign in. To prevent that, a refusal of type `unsupported` or `invalid` is retried once without the binding and with the old `appId`.
- **Shares made from the default storage (testnet only).** Builds before repo-specific sharing could share the owner's synced default. At the owner's next reconcile (a push, `dg collab add/remove`, `dg storage share`, or a visit to the repo's settings) such a share, whose repo has no `repo:<id>` entry, moves to an empty share at the next epoch and every grant is revoked: the same path as a removal. The same happens to a version 1 share that lends storage when the repo's `repo:<id>` entry can't be used (§5). The owner sees one line saying the default storage is no longer shared, how to set storage for the repo, and where to rotate what the maintainers saw; the maintainers fall back to their own storage. Nothing local is deleted.
- **Share version 2.** New clients write shares as `version: 2` and read versions 1 and 2. A dg that predates it refuses to rewrite a share newer than it knows (`crates/forge-core/src/user_sync/mod.rs`, "written by a newer Forge; update dg to change it"); its push prints a note and goes on, so it can't put back a share the new rule stopped. As a maintainer it still reads a version 2 share. The web app before it does not check the version, so the web app ships with or before the dg that writes version 2. A version 1 share that a usable `repo:<id>` entry replaces is written again as version 2 once, and so is an empty version 1 share when sharing stops. A share kept with no usable entry that lends nothing but still has grants (a stop that was interrupted) stops again, so those grants go.
- **Mainnet.** `forge-user` is registered on mainnet as `hxrzsQRUwprcekNur1N9ygc1zLX8jAuBaRTvnq3HmgK` (2026-11-26, in group `H5gXhGVabbSdDdZMesVXevfbvNU8CgSCcHdhx6ekL2eJ`, recorded in `deployments/mainnet.json` `user`). Builds that embed that record sync on mainnet; older builds behave exactly as before (§7, last bullet).

## 9. Mainnet decision (owner)

Registering `forge-user` on mainnet from the deployer `CL4UTHLA…` costs the amount measured by its testnet registration (recorded in `deployments/testnet.json` `user.costCredits`). Fees are protocol constants, so mainnet costs the same in credits. It needs the deployer key, which is only on the owner's machine. The owner approved it on 2026-11-25; it cost 20,141,511,940 credits (0.2014 DASH).

## 10. As built (where the code differs from the plan above)

- **Sign-in fallback.**
  - The web app retries once without the encryption binding, and with the old `appId`, when the wallet reports `unsupported` or `invalid`, when the request expires unanswered, or when the user taps "Try again" after an error.
  - dg can't see a wallet's refusal, because the request just expires. It offers `dg auth login --wallet --no-sync` instead, and the expiry message says so.
  - A renewal asks with the same `appId` as the grant it replaces, so the wallet's same-connection disable still matches.
- **Where `E` is kept.**
  - **Web:** its own sealed vault entry, `vault-sync:<network>:<identity>`. It isn't stored in `vault-enc`, because older builds treat the highest key there as the private-repo key. It is never kept in the 12-hour resume record.
  - **dg:** a new key slot, keychain `dash-forge/<network>/<identity>.sync`, else a sealed `.key.sync` file. Older dg never reads either.
- **dg holds synced secrets in memory only.** There is no `keychain:dash-forge-sync/…` cache. A new `SecretRef::Value` refuses to serialize, so a synced secret can't reach `storage.toml`. First-sync state lives in `user-sync.toml`.
- **Name clashes.** On a dg device the local profile keeps its name, because `storage.toml` wins, and it is uploaded as `<name>-<device>`. The web app shows the local copy as `<name>-<device>`. dg-only profile fields (`allowPrivateUri`, `pinTimeoutSecs`) travel in a sibling `dg` object, which the web app keeps when it edits that profile.
- **Shared storage on the maintainer's side.**
  - dg names a shared profile `share.<owner8>.<name>`, and the web app names it `shared-<name>`.
  - It is used for that repo when git config (the clone's, or the global one `dg storage use --global` writes) sets no `dash.storage`; with one set, the push doesn't read the share. A repo's own setting always wins.
  - **What a share holds.** Both clients use the same rule (`forge-contracts/fixtures/user-sync/share-rule.json`): only the owner's synced `repo:<id>` policy and the synced profiles it names. The synced default is never shared, and a policy set only in git config is never shared. No synced slot: the share stays as it is. No live `repo:<id>` entry, or one naming only Platform: sharing stops. An entry that doesn't parse, or names a profile that isn't synced, live, known or valid: the share stays as it is. Shares are compared by content, not by bytes, so dg and the web app don't rewrite each other's share.
  - **Stopping.** A repo with no live `repo:<id>` entry, or one naming only Platform, gets a share with no content at the next epoch, and all its grants are revoked. A share that is already empty is left as it is. A share kept as it is (a repo entry that doesn't parse or names an unusable profile) still refreshes the grants its maintainers hold, but is never lent to a new maintainer, since it may hold what an older build shared from the default storage. A maintainer is told the owner shares nothing only when there is no share, or no grant to them at all; a grant that is just behind (a new key the owner hasn't reconciled yet) says nothing. A share is never deleted, and a new share starts above the highest epoch any grant ever used, so an epoch key a removed member kept never opens later content.
  - The owner side reconciles on owner pushes (dg), on `dg collab add/remove` and `dg storage share`, and on visits to the repo's settings (web).
  - A removal writes the share at the new epoch first, then the remaining grants, and deletes the revoked grants last, so an interrupted removal never leaves new credentials at an epoch the removed member can open.
- **Preferences** sync in the web app only: diff view, merge identity, fiat, trending, image hosts, IPFS gateways and organizations. The IPFS peer setting stays per device. A local value is never overwritten. A device reads the synced value only while its own copy is unchanged since the last sync.
- **`dg storage use --global`** writes `dash.storage` to the global git config, as on master, and also records the synced default policy. Git config itself never syncs: on a second machine, pushes from dg read `dash.storage` from that machine's git config first.

## 11. Testnet proof (2026-11-25)

The proof used builds of this branch, the testnet `forge-user` contract, and a RustFS S3 bucket on a public https URL (a temporary boat.dev sandbox). Evidence is in `forge-contracts/evidence/testnet/user-sync-2026-11-25.md`. It predates #740: the maintainer steps (5 and 6) shared the owner's default storage, which today's clients stop sharing; today the owner would first run `dg storage share`. Steps, all passing:

1. **Box A, real wallet.** `dg auth login --wallet` with DashPay Android 11.9.2 (testnet build), identity `G1SAVd3…`. The approval screen shows App ID `forge-user` and "Receive messages encrypted to you in Dash Forge". dg reports "storage settings sync with your identity across devices".
2. **Box A, storage.** `dg storage add proof-s3 … --secret-access-key env:…` lists the profile as `[local+synced]`. `storage.toml` still holds only the `env:` reference.
3. **Box B, same wallet, fresh config.** `dg storage list` shows `proof-s3 [synced]` with both credentials. `dg storage test proof-s3` passes every row (signed put, get, public read, CORS, delete) with nothing configured locally, and no `storage.toml` is written.
4. **Web, same wallet, fresh browser.** Settings → Storage shows `proof-s3` as the saved default for browser pushes, with "Synced with your identity" collapsed underneath, and no duplicate.
5. **Maintainer shares the owner's storage.**
   - The owner creates `usersync-proof` and pushes; the pack lands on `proof-s3`, and the share is written (epoch 0).
   - Maintainer `HJu2c168…` signs in through dg, answered by the scripted App Connect wallet (`forge-web/e2e/wallet-responder-v2.ts`). That wallet registers a `forge-user`-bound ENCRYPTION key just as the wallets do.
   - The maintainer runs `collab accept`, and the owner runs `collab add --role maintain`.
   - The maintainer's push stores its pack on `share.G1SAVd3d.proof-s3`. Platform fees come from the maintainer's balance.
6. **Removal.** `dg collab remove --role maintainer` prints the line about rotating credentials. On-chain, the share is at epoch 1 and no grants remain. The maintainer's next push is refused before anything is stored.

