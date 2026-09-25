# End-to-end suites

- `cli/`: the CLI suite, run against **live testnet** (`make e2e`). Configuration is in `cli/config.sh`.
- `cli/storage-byo.sh`: bring-your-own storage (`make storage-e2e`). A real `git push` / `git clone` whose packs go to the local MinIO + kubo from `infra/docker-compose.yml`.

## Reserved fixture repos (testnet)

Each fixture repo belongs to one suite. Don't push to a repo that another suite owns.
Packs stored on a repo's local-only storage (MinIO/kubo on `127.0.0.1`) can't be read by anyone else, so a repo shared with other suites would make their clones depend on your laptop.

| Repo (owner = DEPLOYER `8hJmcHWT…`) | Used by | Notes |
|---|---|---|
| `m1-75299` | `cli/scenarios/*` (`make e2e`) | The shared M1 repo; Platform-stored packs only. |
| `storage-e2e-a` | `cli/storage-byo.sh` steps 1–4 | Created by the script on its first run (repo-v1, about 1.18 tDASH once). Each run uses a fresh `e2e/<run-id>/byo` branch and deletes it afterwards. |
| `storage-e2e-b` | `cli/storage-byo.sh` steps 5–6 | Same, plus the step-5 "copy deleted" scenario. Step 6 restores that copy, so the repo stays clonable. |

Override the names with `STORAGE_E2E_REPO` / `STORAGE_E2E_REPO_B`.
