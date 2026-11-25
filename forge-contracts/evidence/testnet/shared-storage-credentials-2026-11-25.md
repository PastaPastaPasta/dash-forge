# Repo storage credentials: who can read them (live check, 2026-11-25)

This is a live check of one claim: only a repository's current maintainers, and its owner, can read the write credentials of storage the owner shares with that repository. It ran on testnet with dg built from master 1aa3f302 (#740). The storage was two throwaway S3-compatible buckets (RustFS in a boat.dev sandbox, not Cloudflare R2), each with its own key, both deleted afterwards. The profile names say "r2" only because the check was for an R2 setup. Credentials are never shown here.

- **Owner:** `G1SAVd3dfdjNHJo2YmaNmhKThEa9kPVcwefCpeinC8ce`, signed in with `dg auth login --wallet` through DashPay Android (testnet build). The approval screen showed App ID `46phm…` (forge-user).
- **Maintainer, later removed:** `HJu2c168iR72DYPVTakTBSy68zs1PpQrTpQgcHTLiLkD`, signed in through the scripted App Connect wallet.
- **Non-maintainer, later added as a maintainer:** `EXHftJ1DQ9SsLFSJgv8p2GiVNC4qtCbKdmNmub9ktGNu`, signed in through the scripted wallet.
- **Repo:** `G1SAVd3…/r2sec-proof`, id `xdeXRkcuZL4UM9dn4PeH6hMJe55MxYDsaDRinh5HYi9`.
- **Profiles:** the owner's default `r2def` (bucket `r2sec-default`) and the repo's `r2repo` (bucket `r2sec-repo`). Both were added with `env:` references.

## Results

| Check | Result |
|---|---|
| Maintainer added while the repo had no storage of its own | dg prints "pushes to their own storage; to share yours … `dg storage share`". No share and no grant on chain. The maintainer's `dg storage list` shows only `platform`, so the owner's default `r2def` is not shared. |
| `dg storage share <repo> r2repo`, then a maintainer push | "using the storage G1SAVd3… shares with this repository's maintainers". The pack is stored on `share.G1SAVd3d.r2repo`, and its manifest names `r2sec-repo`. |
| Non-maintainer | No grant. `dg storage list` shows only `platform`. The push is refused with E601 before anything is stored. |
| Signed-out reader | `git clone dash://…` works with no identity. |
| Raw Platform documents (`state`, `share`, `grant`, `packManifest`, `packMirror`, `config`, `maintainer`) | Only ciphertext and public https/`s3://` addresses. None of the 6 test secrets (both buckets' keys, before and after rotation) occurs plain, as base64 or as hex. |
| Local files of all four roles and every dg log | No secret value. The owner's `storage.toml` holds only `env:` references. The maintainer's dg wrote the shared secret to no file or log. |
| `dg collab remove … --role maintainer` | The share moves to epoch 1 and the maintainer's grant is deleted. dg says to rotate. |
| Rotation (new bucket key; the old key is rejected by the bucket), then `dg storage add r2repo …` again and `dg storage share` | The share is rewritten at epoch 1. The newly added maintainer `EXHftJ1D` (grant at epoch 1) pushes through it. The removed maintainer has no grant, and their push is refused with E601. |
| `dg repo pin <repo> --storage r2repo` | 8 `packMirror` records, each holding only `https://…/r2sec-repo/packs/<hash>.pack`. |

## Mainnet, same build

- `dg auth login --wallet --network mainnet` asks for App ID `GPHh5EAjvh346epUPQSijmz1xgJp6APjn45EPkGMCjLo` (forge-core) with no encryption binding. The request was decoded with the wallets' parser and never approved.
- `dg storage share … --network mainnet` stops with E205, "sync isn't available on this network".
- Mainnet has no forge-user, so nothing is synced or shared there. Storage credentials stay on the device that holds them.

## Found

Rotating by changing only the secret behind an `env:` or `keychain:` reference leaves the synced copy, the one maintainers get, on the old key. `dg storage share` then stops with E502, and its suggested fix didn't fit a rotation. Re-running `dg storage add <name> …` with the new secret in place updates the synced copy. The guide now says so, and E502 offers that fix when only the secrets differ.
