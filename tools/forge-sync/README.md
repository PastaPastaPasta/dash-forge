# Forge sync

`.github/workflows/forge-sync.yml` keeps the mainnet Forge copy of this repository,
`dash://CL4UTHLAyjYDvWNSgzmY7cXiBBba6fDt4BarAqt2XT3y/dash-forge` (owner `forg3.dash`, the identity that registered the mainnet contracts; `forge.dash` is in a DPNS vote and does not resolve yet), equal to
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
| Signing key | secret `FORGE_MAINNET_KEY`: a `dfk1:` limited key of that identity, bound to forge-core only, with a budget and an expiry. It cannot write issues, PRs, stars or labels, but within forge-core it can still change repositories, their settings and collaborators: treat a leak as serious, and disable the key. |
| Packs | a kubo service container in the job, then copied as CARs to our IPFS node on build.thepasta.org (`~/forge-ipfs`, container `forge-ipfs`) and confirmed pinned there. Platform holds only the manifest, the ref update and the history index (about 0.004 DASH a push). |
| IPFS host access | secret `FORGE_IPFS_SSH_KEY`. In `~pasta/.ssh/authorized_keys` it is `restrict,command="/home/pasta/forge-ipfs/ci-import.sh"`: no shell, no forwarding. [`ci-import.sh`](ci-import.sh) (keep the installed copy equal to it) reads one CAR (512 MiB at most) from stdin, imports and pins it, and prints `confirmed<TAB><cid>` per root; empty stdin answers `ready`. The key runs as `pasta`, who can use docker, so a leaked key can fill that node's disk: rotate it like the signing key. |

Before pushing, [`mirror.sh`](mirror.sh) checks that the IPFS host answers `ready`, so a push
never lands while its packs have nowhere durable to go. The helper writes refs one at a time, so
a failed or cancelled push may still have moved some; [`replicate.sh`](replicate.sh) therefore
runs as its own step after any push attempt and copies whatever the push pinned. Any CAR the host did not
confirm is uploaded as the artifact `forge-sync-cars-<run id>-<attempt>` (kept 90 days) and the
job opens the issue "Forge mirror push or replication failed" (also on a cancel or timeout): a
later run sees Forge equal to GitHub and would not notice. Any other failure on master opens
"Forge sync failing". Import the CARs on the IPFS host with
`docker exec forge-ipfs ipfs dag import --pin-roots <file>`; if a pack is lost for good, push it
again from a clone with `dg reseed --from-local`.

Limits:

- Deleting or moving a tag on GitHub makes a permanent divergence: the old tag stays on Forge.
  Delete it there (or restore it on GitHub) before the next run can pass.
- Platform has no compare-and-swap. If another writer races a push, Forge holds both heads and
  `ls-remote` shows only the newest, so the comparison can miss the other one until master moves
  again and the helper refuses the push.

## Rotating the key

Each run's summary shows the key's budget left and its expiry, and warns below 20% or two weeks.
At about 0.004 DASH a push, 0.5 DASH lasts roughly 40 days of master merges. To replace it:

```sh
dg auth export --network mainnet --new-key --scope core --master <owner identity file> \
  --budget 0.5 --expires 90d --format dfk1 --reveal-secrets -o runner.dfk1
gh secret set FORGE_MAINNET_KEY --env forge-mainnet < runner.dfk1 && rm runner.dfk1
dg auth keys disable <old key id> --network mainnet --master <owner identity file>
```

## Tests

`bash tools/forge-sync/test.sh` runs `mirror.sh` against local bare repositories and a stub kubo:
first sync, nothing to do, GitHub ahead with a stale checkout, each kind of divergence, a dry
run, and replication (only new pins, after a failed push, and a CID the host does not confirm).
