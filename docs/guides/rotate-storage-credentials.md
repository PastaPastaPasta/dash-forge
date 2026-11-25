# Rotate storage credentials

Rotate a storage credential when someone may have seen it:

- **A maintainer you shared a repository's storage with** (testnet only). When you share a repository's storage with its maintainers (`dg storage share <owner/repo> <profile>`, or the repo's **Settings → Storage**; see [Collaborating](collaborating.md#storage-for-maintainers-testnet)), each maintainer's client decrypts the storage profiles you set for that repository, credentials included, so their pushes can write packs to your bucket or IPFS node. Removing a maintainer stops them reading anything shared **after** the removal: Forge moves the share to a new key and deletes their grant. It cannot take back what they already decrypted.
- **Your settings-sync key** (testnet only), if a site may have tricked you into approving a wallet code: whoever holds it can read every storage credential synced with your identity ([Identity and keys](identity-and-keys.md#settings-that-follow-your-identity-testnet)).

Sharing and settings sync use the forge-user contract, which is registered on testnet only. On mainnet, Forge neither shares nor syncs storage credentials.

Rotating takes three steps:

1. Make a new credential at the provider.
2. Update the profile with it.
3. Revoke the old credential at the provider.

The shared copy follows automatically. Your next push to the repository re-encrypts the share with the updated profile for the remaining maintainers. So do `dg collab add`, `dg collab remove`, `dg storage share` and opening the repo's **Settings** in the web app: they refresh the shared profiles from the storage you set for that repository. Maintainers only ever get storage set for their repository, never your default storage.

## S3-compatible storage

1. Make a new key that can read and write the bucket only. On a store you run, with the `g` function and `rc` commands from [Storage on your home NAS](home-nas-storage.md#a-bucket-a-key-for-that-bucket-only-public-reads-and-cors):
   - **Garage:** `g key create forge-key-2`, then `g bucket allow --read --write forge --key forge-key-2`.
   - **RustFS:** a new user with the same policy: `rc admin user add nas/ forge-2 <a new long random secret>`, then `rc admin policy attach nas/ forge-rw --user forge-2`.
   - **A hosted provider:** a new access key limited to the bucket, from its dashboard.
2. Update the profile:
   - **dg:** keep the old name so repositories that use it don't change. The simplest way is `dg storage add` with no arguments: give the same name, confirm the replace, and paste the new secret. It stores the secret, then syncs the profile.
     With flags, store the new secret **first**, because `dg storage add` syncs the profile with whatever secret it finds at that moment:
     ```sh
     security add-generic-password -U -s dash-forge -a nas -w     # macOS; on Linux: secret-tool store --label=nas service dash-forge account nas
     dg storage add nas --kind s3 --endpoint <endpoint> --region <region> \
       --bucket forge --public-url <public URL> \
       --access-key-id <new key id> --secret-access-key keychain:dash-forge/nas
     ```
     Add `--session-token` if your provider uses one.
   - **Web app:** open **Settings → Storage**, edit the profile, and paste the new keys.
3. Delete the old key: `g key delete --yes forge-key` on Garage, remove the old user (`forge`) on RustFS, or delete it in the provider's dashboard.

## A kubo node behind auth

1. Change the credential your proxy checks: the basic-auth password, or the bearer token.
2. Update the profile's `--api-auth` (the full `Authorization` header value, kept in the keychain or an environment variable).
3. Reload the proxy so the old value stops working.

## An IPFS pinning service

1. Create a new access token in the service's dashboard.
2. Update the profile's `--pinning-token`.
3. Revoke the old token.

## Check

```sh
dg storage test nas
```

A green test means the new credential works. Run one push to each repository whose maintainers changed. It shares the updated profile with the remaining maintainers; the removed one gets nothing.

## What happens to existing testnet maintainers

Before repo-specific sharing, a share could carry your default storage. At your next push, `dg collab add`/`remove`, `dg storage share`, or visit to the repo's settings, a repository with no storage of its own set stops sharing: its share moves to an empty one at the next epoch and every maintainer's grant is revoked, exactly as a removal does. dg and the web app say so once. Your maintainers then push to their own storage. To keep sharing, set storage for the repository: `dg storage share <owner/repo> <profile>`, or **Use separate storage for this repo to share it with maintainers** in the repo's **Settings → Storage**. Those maintainers could read the default storage's credentials before, so rotate them as described above if that matters to you.

## What a maintainer trusts

Sharing works both ways. The upload address in a shared profile (the bucket endpoint, the kubo API) is chosen by the owner, and the maintainer's own client connects to it when it pushes. Forge never lets a shared profile record a non-public address on chain from the maintainer's machine, but the maintainer still trusts the owner with where their pushes go.

## What rotation does not cover

- **Objects already uploaded.** A removed maintainer could have copied the bucket's contents while they had access. Packs of public repositories are public anyway. Private repositories' packs are encrypted to their members key, which `dg collab remove` rotates separately.
- **Old document versions.** A removed maintainer can still decrypt shares from before the removal, if they or a Platform node kept them. That is why you rotate: the credentials inside those shares stop working.
