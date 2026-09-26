# End-to-end suites

- `cli/run.sh`: the CLI suite, run against **live devnet moutai** (forge-v2, protocol 14) with `make e2e`. Configuration is in `cli/config.sh`; fixture identities come from `~/.config/dash-forge/test-identities/devnet-moutai/` (OWNER, COLLAB, CONTRIB). Scenario 08 reads a forge-v1 repo on **testnet** to prove v1 read-compatibility (needs a testnet identity, default `test-identities/CONTRIB.identity.json`).
- `cli/seed-read-fixture.sh`: checks the testnet read fixture that the browser specs read (`make e2e-fixture`). The nightly runs it before Playwright. The fixture is a forge-v1 repo, which is read only now, so the script verifies it and can no longer reseed it; the fixture moves to forge-v2 together with the web app.
- `../forge-web/e2e/`: the Playwright specs. The read specs only read the read fixture.
- `cli/storage-byo.sh`: bring-your-own storage (`make storage-e2e`). A real `git push` / `git clone` whose packs go to the local MinIO + kubo from `infra/docker-compose.yml`.

| Scenario | Proves |
|---|---|
| 01 round-trip | push a branch + tag, clone it back byte-identical |
| 02 non-ff | non-fast-forward refused without `+`, accepted with it |
| 03 ref delete | `:branch` removes a ref from `ls-remote` and a fresh clone |
| 04 revoked-writer push | `dg collab add` → writer pushes → `dg collab remove` → the next push is refused **at consensus** (40120) |
| 05 non-member push | a never-member's push is refused at consensus (40120) |
| 06 third-party verify | refs and manifests read raw from Platform bind to a locally hash-verified clone |
| 07 depth / filter | `--depth` fails loudly, `--filter=blob:none` works |
| 08 v1 read-compat | a testnet v1 repo clones by name and by contract id; a push to it is refused as read only |
| 09 issue lifecycle | a non-member opens an issue (§6 numbering), closes and reopens it as the author (`authorEvent`); a stranger's close is refused by `dg` before signing (E601) and, with the pre-check off, **at consensus** (40120); a maintainer labels, comments and closes it (member `event`) |
| 10 PR from a fork | `dg repo fork` records the parent's packs by reference (nothing re-uploaded) and the fork clones; a PR opened from the fork with no `--head-repo`; `pr view/diff/checkout` fetch the head from the fork; only a member's approval counts; `dg pr merge` builds a real 3-way merge commit, pushes it to the base and posts the merge event, and a fresh clone shows the merge |
| 11 release asset | a non-maintainer is refused before uploading; a maintainer publishes a release whose asset goes to local MinIO with its sha256 recorded; a reader without storage credentials downloads and verifies it. SKIPs when MinIO is down (`make infra-up`) |
| 12 star / unstar | star, star again (nothing written), unstar with the protocol-14 `indexOnly` delete, unstar again (nothing to remove); the star count follows |

The binaries come from `target/`, `$CARGO_TARGET_DIR`, or `E2E_BIN_DIR` when set.

## Reserved fixture repos

Each fixture repo belongs to one suite. Don't push to a repo that another suite owns, and don't run ad-hoc experiments on any of them.

Why this matters: a pack is only as readable as the storage its manifest names. Packs stored on local-only storage (MinIO/kubo on `127.0.0.1`) can't be read by anyone else. On 2026-09-25 a BYO-storage run pushed such packs into the CLI suite's repo, and every browser spec that browsed that repo failed with "no external URI served the range". A repo shared between suites turns one suite's storage choices into another suite's failures.

The CLI suite's repos are forge-v2 repos owned by the moutai OWNER fixture, created on first use (~0.001 DASH each; the create is resumable and never pays twice).

| Repo | Written by | Read by | Notes |
|---|---|---|---|
| `e2e-cli` (moutai) | `cli/scenarios/*` (`make e2e`) | the same | The CLI suite's repo. Platform-stored packs only. Each run pushes fresh `e2e/<run-id>/…` refs and deletes them afterwards. Override with `E2E_REPO_NAME`. Scenarios 09–12 also leave issues, PRs, reviews and releases (`e2e-<run-id>`) behind: those documents cannot be deleted on forge-v2. Release assets point at the runner's local MinIO. |
| `e2e-cli-fork` (moutai, CONTRIB) | `cli/scenarios/10-pr-from-fork.sh` | the same | CONTRIB's fork of `e2e-cli`, created on first use and reused (resumable). Each run pushes an `e2e/<run-id>/feature` branch to it. Override with `E2E_FORK_NAME`. |
| `storage-e2e-a` (moutai) | `cli/storage-byo.sh` steps 1–4 | the same script | Each run uses a fresh `e2e/<run-id>/byo` branch and deletes it afterwards. |
| `storage-e2e-b` (moutai) | `cli/storage-byo.sh` steps 5–6 | the same script | Same, plus the step-5 "copy deleted" scenario. Step 6 restores that copy, so the repo stays clonable. |
| `m1-5124` (testnet, v1) | nothing now (v1 is read only); `cli/seed-read-fixture.sh` verifies it | `forge-web/e2e/*` (read-paths, fallback-browse, zero-backend, a11y) | The read fixture: `main` holds one deterministic commit (`README.md`, `src/`, `lib/`) with its pack stored on Platform and no browse index. DEPLOYER-owned (`8hJmcHWT…`). Override with `NIGHTLY_FIXTURE_REPO` (seeder) and `E2E_FIXTURE_NAME` (Playwright). |
| `m1-75299` (testnet, v1) | nothing now | scenario 08; `forge-web/e2e/auth-write.spec.ts` with `E2E_WRITE=1` (issues only) | The former CLI suite repo, read only now. It still holds seven stale external packs (MinIO/IPFS on `127.0.0.1`) from the 2026-09-25 incident; clones skip them with a warning. |

Override the storage repo names with `STORAGE_E2E_REPO` / `STORAGE_E2E_REPO_B`. When you add a suite that writes, give it its own repo and add a row here.

## The partial-clone rule both clients follow

A live pack whose storage cannot be reached does not fail a whole clone or browse:

- `git-remote-dash` skips an external pack whose mirrors are down, and git's connectivity check then fails the fetch only if a wanted object was in it.
- The web app's in-browser clone tries every recorded URI and the shared IPFS gateway list (`forge-contracts/config/storage-defaults.json`). If none of them serves the pack's exact sha256, it skips that pack. It then shows "N packs could not be fetched from their storage; some objects may be missing", marks the trust panel's content link `partial`, and names the missing pack and its hosts in any view that needs an object from it.

Packs stored on Platform are never skipped: if one can't be read, the clone fails loudly.
