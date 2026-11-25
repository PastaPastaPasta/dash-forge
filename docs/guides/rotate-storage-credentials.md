# Rotate storage credentials

When you share a repository's storage with its maintainers (`dg storage share <owner/repo> <profile>`, or the repo's Settings → Storage; see [settings that follow the identity](../design/identity-synced-state.md#5-flows)), each maintainer's client decrypts the storage profiles you set for that repository, credentials included, so their pushes can write packs to your bucket or IPFS node. Removing a maintainer stops them reading anything shared **after** the removal: Forge moves the share to a new key and deletes their grant. It cannot take back what they already decrypted. Rotate those credentials.

Rotating takes three steps:

1. Make a new credential at the provider.
2. Update the profile with it.
3. Revoke the old credential at the provider.

The shared copy follows automatically. Your next push to the repository re-encrypts the share with the updated profile for the remaining maintainers. So do `dg collab add`, `dg collab remove` and `dg storage share` on it: they refresh the shared profiles from the storage you set for that repository. Maintainers only ever get storage set for their repository, never your default storage.

## Cloudflare R2

1. In the Cloudflare dashboard, open **R2 → Manage R2 API Tokens** and create a token with **Object Read & Write** on the bucket only. Copy the access key id and the secret access key.
2. Update the profile:
   - **dg:** keep the old name so repositories that use it don't change.
     ```sh
     dg storage add r2-main --kind s3 --endpoint https://<account>.r2.cloudflarestorage.com \
       --region auto --bucket forge --public-url https://<your public origin> \
       --access-key-id <new id> --secret-access-key keychain:dash-forge/r2-main
     ```
     Then store the new secret under that keychain entry. `dg storage add` with no arguments asks for each value and stores a pasted secret for you.
   - **Web app:** open **Settings → Storage**, edit the profile, and paste the new keys.
3. Delete the old token in the dashboard.

## Other S3-compatible storage (AWS, Backblaze B2, MinIO, a NAS)

1. Create a new access key for the same user or service account, limited to the bucket.
2. Update the profile as above (`--access-key-id`, `--secret-access-key`, and `--session-token` if you use one).
3. Deactivate and delete the old key.

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
dg storage test r2-main
```

A green test means the new credential works. Run one push to each repository whose maintainers changed. It shares the updated profile with the remaining maintainers; the removed one gets nothing.

## What happens to existing testnet maintainers

Before repo-specific sharing, a share could carry your default storage. At your next push, `dg collab add`/`remove`, `dg storage share`, or visit to the repo's settings, a repository with no storage of its own set stops sharing: its share moves to an empty one at the next epoch and every maintainer's grant is revoked, exactly as a removal does. dg says so once. Your maintainers then push to their own storage. To keep sharing, set storage for the repository (`dg storage share <owner/repo> <profile>`). Those maintainers could read the default storage's credentials before, so rotate them as described above if that matters to you.

## What a maintainer trusts

Sharing works both ways. The upload address in a shared profile (the bucket endpoint, the kubo API) is chosen by the owner, and the maintainer's own client connects to it when it pushes. Forge never lets a shared profile record a non-public address on chain from the maintainer's machine, but the maintainer still trusts the owner with where their pushes go.

## What rotation does not cover

- **Objects already uploaded.** A removed maintainer could have copied the bucket's contents while they had access. Packs of public repositories are public anyway. Private repositories' packs are encrypted to their members key, which `dg collab remove` rotates separately.
- **Old document versions.** A removed maintainer can still decrypt shares from before the removal, if they or a Platform node kept them. That is why you rotate: the credentials inside those shares stop working.
