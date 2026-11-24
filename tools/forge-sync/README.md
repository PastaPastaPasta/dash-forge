# Forge sync

`.github/workflows/forge-sync.yml` keeps the mainnet Forge copy of this repository,
`dash://CL4UTHLAyjYDvWNSgzmY7cXiBBba6fDt4BarAqt2XT3y/dash-forge` (owner `forge.dash`), equal to
GitHub's master and tags. It runs on every push to master, every tag, daily at 04:23 UTC, and on
demand (with an optional dry run). GitHub is primary: [`mirror.sh`](mirror.sh) never force-pushes.
When Forge has a ref GitHub lacks, a master that is not in GitHub's history, or a tag that names
another object, it pushes nothing, fails, and opens (or comments on) the issue
"Forge mirror diverged from GitHub".

## Where things live

| | |
|---|---|
| Signing key | secret `FORGE_MAINNET_KEY`: a `dfk1:` limited key of forge.dash, bound to forge-core only, with a budget and an expiry. It can push code and releases; it cannot write issues, PRs, stars or labels. |
| Packs | a kubo service container in the job, then copied as CARs to our IPFS node on build.thepasta.org (`~/forge-ipfs`, container `forge-ipfs`) and confirmed pinned there. Platform holds only the manifest, the ref update and the history index (about 0.004 DASH a push). |
| IPFS host access | secret `FORGE_IPFS_SSH_KEY`. In `~pasta/.ssh/authorized_keys` it is `restrict,command="/home/pasta/forge-ipfs/ci-import.sh"`: no shell, no forwarding; the script reads one CAR (512 MiB at most) from stdin, imports and pins it, and prints `confirmed<TAB><cid>` per root. |

If replication fails after the refs moved, the job uploads the CARs as the artifact
`forge-sync-cars-<run id>` (kept 90 days). Import them on the IPFS host with
`docker exec forge-ipfs ipfs dag import --pin-roots <file>`.

## Rotating the key

The job summary does not show the key's budget; check it with
`dg auth keys list --network mainnet --identity <forge.dash identity file>`. To replace it:

```sh
dg auth export --network mainnet --new-key --scope core --master <forge.dash identity file> \
  --budget 0.5 --expires 90d --format dfk1 --reveal-secrets -o runner.dfk1
gh secret set FORGE_MAINNET_KEY < runner.dfk1 && rm runner.dfk1
dg auth keys disable <old key id> --network mainnet --master <forge.dash identity file>
```

## Tests

`bash tools/forge-sync/test.sh` runs `mirror.sh` against local bare repositories: first sync,
nothing to do, GitHub ahead with a stale checkout, and each kind of divergence.
