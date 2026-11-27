# Rotate storage credentials

Rotate a storage credential when someone may have seen it:

- **A maintainer you shared a repository's storage with**. When you share a repository's storage with its maintainers (`dg storage share <owner/repo> <profile>`, or the repo's **Settings → Storage**; see [Collaborating](collaborating.md#storage-for-maintainers)), each maintainer's client decrypts the storage profiles you set for that repository, credentials included, so their pushes can write packs to your bucket or IPFS node. Removing a maintainer stops them reading anything shared **after** the removal: Forge moves the share to a new key and deletes their grant. It cannot take back what they already decrypted.
- **Your settings-sync key**, if a site may have tricked you into approving a wallet code: whoever holds it can read every storage credential synced with your identity ([Identity and keys](identity-and-keys.md#settings-that-follow-your-identity)). Move sync to a new key first, as below, or the new credentials sync under the key the site has.

Sharing and settings sync use the forge-user contract, which is registered on testnet and mainnet.

## If a site may have your settings-sync key

Disabling keys doesn't take the sync key back, and every wallet sign-in hands out the same one. Shut the site out first, then move sync to a new key made from your recovery phrase, then rotate:

1. **Disable the signing key the site got** ([Revoke keys](revoke-keys.md)). The same approval gave it a key that signs as you, and with it the site could still overwrite your synced settings.
2. **Move sync to a new key.** Close your other Forge tabs first. In the web app: **Settings → Storage → Synced with your identity → Move sync to a new key**, then enter your recovery phrase. With `dg` (built from source until the next release): `dg storage sync move-key`, which asks for the phrase. Forge registers the new key on your identity, disables the old one, and encrypts your synced settings and your repositories' shares again under the new key. Your settings stay as they were; nothing of yours is deleted. A maintainer whose own key is no longer live loses access to your shared storage, as at any refresh.
3. **Rotate each credential**, as in the rest of this page. The update syncs under the new key, which the site doesn't have.
4. **Add the new key on your other devices**, once each: **Settings → Storage → Add the new key** in the web app, or `dg storage sync add-key`, with the same recovery phrase.

After the move:

- **Wallet sign-ins no longer carry the sync key.** A new device signs in with your wallet as before, then adds the key once with your recovery phrase (**Add the sync key**, or `dg storage sync add-key`).
- **A device still holding the old key stops syncing**, released `dg` v0.3.1 included: it can no longer read your synced settings, and a change made there stays on that device. Its own `storage.toml` is untouched. Add the new key there, or update it first.
- **A profile changed on another device while this one waited** for the new key shows up twice after **Add the new key**: the synced one under its name and this device's older copy as `<name>-<device>`. Nothing is dropped; remove the copy you don't want.

Rotating takes four steps, in this order, so nobody is left holding a key that no longer works:

1. Make a new credential at the provider, next to the old one.
2. Update the profile with it, then run `dg storage test <name>`.
3. Refresh each share that uses the profile (testnet): `dg storage share <owner/repo> <the same profiles>` (with the same `--copies`, if you set it), or open (or reload) the repository's **Settings** in the web app. Updating the profile alone does not, and neither does adding a writer.
4. Revoke the old credential at the provider.

Maintainers only ever get storage set for their repository, never your default storage.

## S3-compatible storage

1. Make a new key that can read and write the bucket only. On a store you run, with the `g` function and `rc` commands from [Storage on your home NAS](home-nas-storage.md#a-bucket-a-key-for-that-bucket-only-public-reads-and-cors):
   - **Garage:** `g key create forge-key-2`, then `g bucket allow --read --write forge --key forge-key-2`.
   - **RustFS:** a new user with the same policy: `rc admin user add nas/ forge-2 <a new long random secret>`, then `rc admin policy attach nas/ forge-rw --user forge-2`.
   - **A hosted provider:** a new access key limited to the bucket, from its dashboard.
2. Update the profile:
   - **dg:** keep the old profile name so repositories that use it don't change. The simplest way is `dg storage add` with no arguments: give the same name, confirm the replace, and answer every question again with the **new access key id** and the new secret. It stores the secret, then syncs the profile.
     With flags, store the new secret **first**, under a keychain entry you haven't used yet (`nas-2`, next time `nas-3`), because `dg storage add` syncs the profile with whatever secret it finds at that moment. Repeat every setting the profile has (`dg storage list` shows them), changing only the key:
     ```sh
     security add-generic-password -s dash-forge -a nas-2 -w     # macOS; on Linux: secret-tool store --label=nas-2 service dash-forge account nas-2
     dg storage add nas --kind s3 --endpoint <endpoint> --region <region> \
       --bucket forge --public-url <public URL> \
       --access-key-id <new key id> --secret-access-key keychain:dash-forge/nas-2
     ```
     Add `--session-token` if your provider uses one. A new entry name matters on Linux: overwriting the old entry with `secret-tool` does not replace a secret dg stored itself, so the profile would sync the new key id with the old secret. Changing only the keychain entry or the environment variable also changes this computer, not the synced copy: maintainers keep getting the old key, and `dg storage share` stops with E502.
   - **Web app:** open **Settings → Storage**, edit the profile, and paste the new keys.
3. Refresh the shares, as in step 3 at the top.
4. Delete the old key: `g key delete --yes forge-key` on Garage, remove the old user (`forge`) on RustFS, or delete it in the provider's dashboard.

## A kubo node behind auth

1. Add the new credential to your proxy next to the old one (a second basic-auth user, or a second accepted bearer token), and reload it.
2. Update the profile's `--api-auth` (the full `Authorization` header value, kept in a new keychain entry or an environment variable).
3. Refresh the shares, as in step 3 at the top.
4. Remove the old credential from the proxy and reload it.

## An IPFS pinning service

1. Create a new access token in the service's dashboard.
2. Update the profile's `--pinning-token` (kept in a new keychain entry or an environment variable).
3. Refresh the shares, as in step 3 at the top.
4. Revoke the old token.

## Check

```sh
dg storage test nas
```

A green test means the new credential works on this computer. `dg storage list` must not mark the profile "local (synced copy differs)": that means maintainers still get the old key, so run `dg storage add` again as in step 2, then refresh the shares. A push with nothing new to send does not refresh a share.

Before you revoke the old credential, also update every other place that holds it: another computer whose own `storage.toml` has the profile (its local copy wins over the synced one; run `dg storage list` there), and any GitHub Action or mirror secret that uses the same key.

## What happens to existing testnet maintainers

Before repo-specific sharing, a share could carry your default storage. At your next push, a maintainer change (`dg collab add … --role maintainer`, `dg collab remove`), `dg storage share`, or visit to the repo's settings, a repository with no storage of its own set stops sharing: its share moves to an empty one at the next epoch and every maintainer's grant is revoked, exactly as a removal does. dg and the web app say so once. Your maintainers then push to their own storage. To keep sharing, set storage for the repository: `dg storage share <owner/repo> <profile>`, or **Use separate storage for this repo to share it with maintainers** in the repo's **Settings → Storage**. Those maintainers could read the default storage's credentials before, so rotate them as described above if that matters to you.

## What a maintainer trusts

Sharing works both ways. The upload address in a shared profile (the bucket endpoint, the kubo API) is chosen by the owner, and the maintainer's own client connects to it when it pushes. Forge never lets a shared profile record a non-public address on chain from the maintainer's machine, but the maintainer still trusts the owner with where their pushes go.

## What rotation does not cover

- **Objects already uploaded.** A removed maintainer could have copied the bucket's contents while they had access. Packs of public repositories are public anyway. Private repositories' packs are encrypted to their members key, which `dg collab remove` rotates separately.
- **Old document versions.** A removed maintainer can still decrypt shares from before the removal, if they or a Platform node kept them. That is why you rotate: the credentials inside those shares stop working.
