# Forge sync

`.github/workflows/forge-sync.yml` keeps the mainnet Forge copy of this repository,
`dash://CL4UTHLAyjYDvWNSgzmY7cXiBBba6fDt4BarAqt2XT3y/dash-forge` (owner `forge.dash`), equal to
GitHub's master and tags. It runs on every push to master, daily at 04:23 UTC, and on demand
(with an optional dry run). A tag push only asks for a run on master, so the code at a tag never
gets the key. GitHub is primary: [`mirror.sh`](mirror.sh) never force-pushes.
When Forge has a ref GitHub lacks, a master that is not in GitHub's history, or a tag that names
another object, it pushes nothing, fails, and opens (or comments on) the issue
"Forge mirror diverged from GitHub".

## Where things live

| | |
|---|---|
| Secrets | in the `forge-mainnet` environment, which only master may deploy from. |
| Signing key | secret `FORGE_MAINNET_KEY`: a `dfk1:` limited key of forge.dash, bound to forge-core only, with a budget and an expiry. It cannot write issues, PRs, stars or labels, but within forge-core it can still change repositories, their settings and collaborators: treat a leak as serious, and disable the key. |
| Packs | a kubo service container in the job, then copied as CARs to our IPFS node on build.thepasta.org (`~/forge-ipfs`, container `forge-ipfs`) and confirmed pinned there. Platform holds only the manifest, the ref update and the history index (about 0.004 DASH a push). |
| IPFS host access | secret `FORGE_IPFS_SSH_KEY`. In `~pasta/.ssh/authorized_keys` it is `restrict,command="/home/pasta/forge-ipfs/ci-import.sh"`: no shell, no forwarding; the script reads one CAR (512 MiB at most) from stdin, imports and pins it, and prints `confirmed<TAB><cid>` per root. |

The helper writes refs one at a time, so a failed push may still have moved some. The script
therefore copies whatever the push pinned even when the push failed. Any CAR the host did not
confirm is uploaded as the artifact `forge-sync-cars-<run id>-<attempt>` (kept 90 days) and the
job opens the issue "Forge mirror push or replication failed": a later run sees Forge equal to
GitHub and would not notice. Import the CARs on the IPFS host with
`docker exec forge-ipfs ipfs dag import --pin-roots <file>`; if a pack is lost for good, push it
again from a clone with `dg reseed --from-local`.

Limits:

- Deleting or moving a tag on GitHub makes a permanent divergence: the old tag stays on Forge.
  Delete it there (or restore it on GitHub) before the next run can pass.
- Platform has no compare-and-swap. If another writer races a push, Forge holds both heads and
  `ls-remote` shows only the newest, so the comparison can miss the other one until master moves
  again and the helper refuses the push.

## Rotating the key

The job summary does not show the key's budget; check it with
`dg auth keys list --network mainnet --identity <forge.dash identity file>`. To replace it:

```sh
dg auth export --network mainnet --new-key --scope core --master <forge.dash identity file> \
  --budget 0.5 --expires 90d --format dfk1 --reveal-secrets -o runner.dfk1
gh secret set FORGE_MAINNET_KEY --env forge-mainnet < runner.dfk1 && rm runner.dfk1
dg auth keys disable <old key id> --network mainnet --master <forge.dash identity file>
```

## Tests

`bash tools/forge-sync/test.sh` runs `mirror.sh` against local bare repositories and a stub kubo:
first sync, nothing to do, GitHub ahead with a stale checkout, each kind of divergence, a dry
run, and replication (only new pins, after a failed push, and a CID the host does not confirm).
