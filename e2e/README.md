# End-to-end suites

- `cli/run.sh`: the CLI suite, run against **live devnet moutai** (forge-v2, protocol 14) with `make e2e`. Configuration is in `cli/config.sh`; fixture identities come from `~/.config/dash-forge/test-identities/devnet-moutai/` (OWNER, COLLAB, CONTRIB).
- `../forge-contracts/scripts/seed-v2-fixture.mjs`: seeds the forge-v2 read fixture that the browser specs read (`make e2e-fixture`; needs `npm ci` in `forge-contracts/sdk-v2` and the moutai OWNER, MAINTAINER, COLLAB and CONTRIB identities). Idempotent: each step's result is recorded in `~/.cache/dash-forge/seed-v2-devnet-moutai.json` and a rerun skips what is recorded. The Devnet Nightly runs it before Playwright.
- `../forge-web/e2e/`: the Playwright specs, run against a moutai build (`E2E_DEVNET=moutai`, the default). The read specs only read the read fixture.

Everything runs on devnet moutai because forge-v2 needs Platform protocol 14, which testnet and mainnet do not run yet. Testnet runs resume once protocol 14 reaches testnet and forge-v2 is deployed there.
- `cli/storage-byo.sh`: bring-your-own storage (`make storage-e2e`). A real `git push` / `git clone` whose packs go to the local RustFS (S3) + kubo from `infra/docker-compose.yml`.

| Scenario | Proves |
|---|---|
| 01 round-trip | push a branch + tag, clone it back byte-identical |
| 02 non-ff | non-fast-forward refused without `+`, accepted with it |
| 03 ref delete | `:branch` removes a ref from `ls-remote` and a fresh clone |
| 04 revoked-writer push | `dg collab add` → writer pushes → `dg collab remove` → the next push is refused **at consensus** (40120) |
| 05 non-member push | a never-member's push is refused at consensus (40120) |
| 06 third-party verify | refs and manifests read raw from Platform bind to a locally hash-verified clone |
| 07 depth / filter | `--depth` fails loudly, `--filter=blob:none` works |
| 09 issue lifecycle | a non-member opens an issue (§6 numbering), closes and reopens it as the author (`authorEvent`); a stranger's close is refused by `dg` before signing (E601) and, with the pre-check off, **at consensus** (40120); a maintainer labels, comments and closes it (member `event`) |
| 10 PR from a fork | `dg repo fork` records the parent's packs by reference (nothing re-uploaded) and the fork clones; a PR opened from the fork with no `--head-repo`; `pr view/diff/checkout` fetch the head from the fork; only a member's approval counts; `dg pr merge` builds a real 3-way merge commit, pushes it to the base and posts the merge event, and a fresh clone shows the merge |
| 11 release asset | a non-maintainer is refused before uploading; a maintainer publishes a release whose asset goes to local RustFS (S3) with its sha256 recorded; a reader without storage credentials downloads and verifies it. SKIPs when the local S3 store (RustFS) is down (`make infra-up`) |
| 12 star / unstar | star, star again (nothing written), unstar with the protocol-14 `indexOnly` delete, unstar again (nothing to remove); the star count follows |
| 13 init + push | `dg storage add` (flags) makes a profile for the local RustFS; `dg init --storage <it>` on a new repo creates it, sets remote `origin` and repo-local `dash.storage`, pushes with upstream tracking and prints the web URL; a re-run writes nothing; the clone is byte-identical. `dg repo create` with no storage configured exits 5 with E508 and the balance does not move. SKIPs when the local S3 store (RustFS) is down |

The binaries come from `target/`, `$CARGO_TARGET_DIR`, or `E2E_BIN_DIR` when set.

## Reserved fixture repos

Each fixture repo belongs to one suite. Don't push to a repo that another suite owns, and don't run ad-hoc experiments on any of them.

Why this matters: a pack is only as readable as the storage its manifest names. Packs stored on local-only storage (the S3 store or kubo on `127.0.0.1`) can't be read by anyone else. On 2026-09-25 a BYO-storage run pushed such packs into the CLI suite's repo, and every browser spec that browsed that repo failed with "no external URI served the range". A repo shared between suites turns one suite's storage choices into another suite's failures.

The CLI suite's repos are forge-v2 repos owned by the moutai OWNER fixture, created on first use (~0.001 DASH each; the create is resumable and never pays twice).

| Repo | Written by | Read by | Notes |
|---|---|---|---|
| `e2e-cli` (moutai) | `cli/scenarios/*` (`make e2e`) | the same | The CLI suite's repo. Platform-stored packs only. Each run pushes fresh `e2e/<run-id>/…` refs and deletes them afterwards. Override with `E2E_REPO_NAME`. Scenarios 09–12 also leave issues, PRs, reviews and releases (`e2e-<run-id>`) behind: those documents cannot be deleted on forge-v2. Release assets point at the runner's local S3 store (RustFS; MinIO before 2026-09-27). |
| `e2e-cli-fork` (moutai, CONTRIB) | `cli/scenarios/10-pr-from-fork.sh` | the same | CONTRIB's fork of `e2e-cli`, created on first use and reused (resumable). Each run pushes an `e2e/<run-id>/feature` branch to it. Override with `E2E_FORK_NAME`. |
| `e2e-init-<run-id>` (moutai) | `cli/scenarios/13-init-push.sh` | the same | A new repo every run (`dg init` must create one; v2 repos cannot be deleted, ~0.0015 DASH each). Its one pack lives on the runner's local S3 store (RustFS), so nothing else may read it. |
| `storage-e2e-a` (moutai) | `cli/storage-byo.sh` steps 1–4 | the same script | Each run uses a fresh `e2e/<run-id>/byo` branch and deletes it afterwards. |
| `storage-e2e-b` (moutai) | `cli/storage-byo.sh` steps 5–6 | the same script | Same, plus the step-5 "copy deleted" scenario. Step 6 restores that copy, so the repo stays clonable. |
| `relay-e2e` (moutai) | the forge-relay live check (`crates/forge-relay/README.md`) | the same | Repo id `3HKxeeGrJjfVP6msx7yEKUPp9ghev2sAPFHEFLQ1c1x1` (recreated on the re-registered forge-v2 contracts). Webhooks on it point at `127.0.0.1` receivers and are removed after each run; pushes are tiny Platform-stored commits on `main`. The MAINTAINER fixture is granted maintainer for the tombstone check and revoked after it. Last runs 2026-09-26: (1) push delivered with a valid `X-Hub-Signature-256`, secret decrypted from chain by a relay-only key file; none delivered after `dg webhook remove`. (2) Retry queue: with the receiver down, a push was queued (`forge-relay deliveries` showed it pending, files 0600 in a 0700 dir); the relay was restarted and the receiver started, and the queued push was delivered on a backoff retry with a valid signature (`FORGE_RELAY_RETRY_SCHEDULE=20,40`). (3) Another maintainer's hook: MAINTAINER added a hook, both hooks delivered a push, OWNER ran `dg webhook remove` on it, which wrote a disabled tombstone addressed to OWNER; the next push was delivered to OWNER's hook only. (4) After the retry-queue review fixes, with a static `[[webhook]]` (no `webhook add`): a queued delivery survived a relay restart and was delivered with the same delivery id and a valid signature; a second relay on the same state dir refused to start; a push was delivered 0.6 s after `git push` returned, with a valid signature, the health endpoint reported `"durable":true`, and SIGTERM stopped the relay gracefully. Live-test cost (measured 2026-09-26): a tiny push ≈ 0.0034 DASH (340,735,800 credits: 1 chunk, 2 manifest docs, 1 refUpdate); `dg webhook add` ≈ 0.00076 DASH, of which `remove` refunds all but ≈ 0.000076. The relay itself never spends: RELAY's balance stayed at 499,867,962,300 credits across a run that delivered a push. OWNER's balance is shared with other suites (imports, hang probes), so a drop in it over a run is not this test's cost. |
| `mirror-ci-dash-faucet` (moutai) | `.github/workflows/mirror-action.yml` | the same | The Mirror Action's live test: a mirror of `PastaPastaPasta/dash-faucet` (code, issues, PRs, releases, labels), Platform-stored packs only. Created on first run; each run mirrors twice and requires the second to write nothing. |
| `forge-v2-demo` (moutai, OWNER) and `forge-v2-empty` (moutai, MAINTAINER) | `forge-contracts/scripts/seed-v2-fixture.mjs` | `forge-web/e2e/*` read specs | The browser read fixture: `main` (three commits, `docs/`), a feature branch and tag `v0.1.0` with a published locator; three issues, an open PR with a maintainer approval, a merged PR, a star. `forge-v2-empty` has nothing pushed. Override with `E2E_V2_OWNER` / `E2E_V2_NAME`. |
| `gh-bvs-mirror` (moutai) | `forge-import PastaPastaPasta/backports-validation-script` (manual, PR G live check) | the same | A GitHub mirror (re-created 2026-09-26 on the re-registered contracts): 2 branches + the open PR's head, 1 issue, 2 PRs, 15 comments, 7 reviews, 9 labels, 0.112 DASH. Branches match GitHub's. Re-running the import is a no-op at cost 0. |

Override the storage repo names with `STORAGE_E2E_REPO` / `STORAGE_E2E_REPO_B`. When you add a suite that writes, give it its own repo and add a row here.

## The partial-clone rule both clients follow

A live pack whose storage cannot be reached does not fail a whole clone or browse:

- `git-remote-dash` skips an external pack whose mirrors are down, and git's connectivity check then fails the fetch only if a wanted object was in it.
- The web app's in-browser clone tries every recorded URI and the shared IPFS gateway list (`forge-contracts/config/storage-defaults.json`). If none of them serves the pack's exact sha256, it skips that pack. It then shows "N packs could not be fetched from their storage; some objects may be missing", marks the trust panel's content link `partial`, and names the missing pack and its hosts in any view that needs an object from it.

Packs stored on Platform are never skipped: if one can't be read, the clone fails loudly.
