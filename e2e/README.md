# End-to-end suites

- `cli/run.sh`: the CLI suite, run against **live testnet** (`make e2e`). Its configuration is in `cli/config.sh`.
- `cli/seed-read-fixture.sh`: seeds the read fixture that the browser specs read (`make e2e-fixture`). The nightly runs it before Playwright.
- `../forge-web/e2e/`: the Playwright specs. The read specs only read the read fixture.
- `cli/storage-byo.sh`: bring-your-own storage (`make storage-e2e`). A real `git push` / `git clone` whose packs go to the local MinIO + kubo from `infra/docker-compose.yml`.

## Reserved fixture repos (testnet)

Each fixture repo belongs to one suite. Don't push to a repo that another suite owns, and don't run ad-hoc experiments on any of them.

Why this matters: a pack is only as readable as the storage its manifest names. Packs stored on local-only storage (MinIO/kubo on `127.0.0.1`) can't be read by anyone else. On 2026-09-25 a BYO-storage run pushed such packs into the CLI suite's repo, and every browser spec that browsed that repo failed with "no external URI served the range". A repo shared between suites turns one suite's storage choices into another suite's failures.

All of these repos are owned by DEPLOYER (`8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB`).

| Repo | Written by | Read by | Notes |
|---|---|---|---|
| `m1-5124` | `cli/seed-read-fixture.sh` only | `forge-web/e2e/*` (read-paths, fallback-browse, zero-backend, a11y) | The read fixture. `main` holds one deterministic commit (`README.md`, `src/`, `lib/`) with its pack stored on Platform and no browse index published, so the browser takes the in-browser fallback clone. The seeder is idempotent: it force-pushes `main` only when `main` is not at that commit. Override the name with `NIGHTLY_FIXTURE_REPO` (seeder) and `E2E_FIXTURE_NAME` (Playwright). |
| `m1-75299` | `cli/scenarios/*` (`make e2e`) | the same scenarios | The CLI suite's repo. It holds Platform-stored packs only. Each run pushes fresh `e2e/<run-id>/…` refs and deletes them afterwards. Override with `E2E_REPO_NAME`. It still holds seven stale external packs (MinIO/IPFS on `127.0.0.1`) from the 2026-09-25 incident; clones skip them with a warning. |
| `storage-e2e-a` | `cli/storage-byo.sh` steps 1–4 | the same script | Created by the script on its first run (repo-v1, about 1.18 tDASH once). Each run uses a fresh `e2e/<run-id>/byo` branch and deletes it afterwards. |
| `storage-e2e-b` | `cli/storage-byo.sh` steps 5–6 | the same script | Same, plus the step-5 "copy deleted" scenario. Step 6 restores that copy, so the repo stays clonable. |

Override the storage repo names with `STORAGE_E2E_REPO` / `STORAGE_E2E_REPO_B`. When you add a suite that writes, give it its own repo and add a row here. `dg repo create <name>` costs about 1.18 tDASH once.

## The partial-clone rule both clients follow

A live pack whose storage cannot be reached does not fail a whole clone or browse:

- `git-remote-dash` skips an external pack whose mirrors are down, and git's connectivity check then fails the fetch only if a wanted object was in it.
- The web app's in-browser clone tries every recorded URI and the shared IPFS gateway list (`forge-contracts/config/storage-defaults.json`). If none of them serves the pack's exact sha256, it skips that pack. It then shows "N packs could not be fetched from their storage; some objects may be missing", marks the trust panel's content link `partial`, and names the missing pack and its hosts in any view that needs an object from it.

Packs stored on Platform are never skipped: if one can't be read, the clone fails loudly.
