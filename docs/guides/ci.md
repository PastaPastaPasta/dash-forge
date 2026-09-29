# CI and check runs

Forge has no CI service of its own. Any CI can report results on Forge: GitHub Actions, GitLab CI, a shell script on your laptop, or a runner you host. It writes **check runs**, small on-chain documents that say "check `build` on commit `5950173` passed", and the web app and `dg` show them on the commit page, on a pull request's Checks tab and in the merge box.

Every check run is signed by an identity the repository trusts. Nothing is trusted because of where it came from:

- **Consensus checks the writer.** Platform accepts a `checkRun` only from a current **runner**, **maintainer** or **writer** of the repository. It refuses anyone else's with code 40120.
- **Readers check again.** A run counts only while its reporter still holds that role. Revoke a runner, and its runs are still listed but no longer count ("reporter is no longer a member or runner: not counted").
- **A runner key can sign nothing else.** `dg ci runner new` registers a key bound to the `checkRun` document type, with a budget and an expiry. If it leaks, it can only post check runs, only to repositories where its identity is a runner, and only until the budget or the expiry ends.

The design is in [platform-parity-spec §2](../design/platform-parity-spec.md#2-ci--actions-design).

## Enrol a runner

A runner is an identity of its own. Mint one for CI (`dg auth new --backup-file runner.json`, with a small deposit, since it pays for its own reports). Then, as the repository owner:

```sh
dg ci runner new alice/project --runner runner.json -o runner.dfk1
```

This does two things:

1. **Registers a key on the runner identity**, signed once with the runner's master key from `runner.json`. The key is AUTHENTICATION / HIGH, bound to `(forge-collab, checkRun)`, with a 0.5 DASH budget and a 365-day expiry (`--budget`, `--expires` change them).
2. **Enrols the identity as a runner** of `alice/project`: a forge-core `runner` document that only the owner can write.

The key is written to `runner.dfk1` (0600, unencrypted) *before* it is registered, so a key that nobody holds is never registered. Put the file's contents in your CI's secret store as `DASH_FORGE_KEY`, then delete the file.

Other commands:

| Command | Does |
|---|---|
| `dg ci runner add <repo> <identity>` | enrols an identity that already has a key (one you keyed yourself) |
| `dg ci runner list <repo>` | lists the repository's runners |
| `dg ci runner revoke <repo> <identity>` | deletes the membership; the runner's next report is refused at consensus, and its old runs stop counting |

Without `--runner`, `dg ci runner new` puts the key on your own identity (it asks for your master key once). As the owner you are a maintainer, so no enrolment is needed. That suits a single-developer setup, but it gives up the separate identity.

## Report a check run

```sh
export DASH_FORGE_KEY="$(cat runner.dfk1)"   # in CI: from the secret store
SHA=$(git rev-parse HEAD)
dg ci report alice/project --sha "$SHA" --name build --status queued \
    --details-url "https://ci.example/runs/42"
dg ci report alice/project --sha "$SHA" --name build --status in_progress
dg ci report alice/project --sha "$SHA" --name build --status completed \
    --conclusion success --summary "412 tests passed" --log build.log --storage my-r2
```

- **The first report creates the run; the next ones update it in place.** An update is a replace of your own open run with that name on that commit. Once a run is `completed`, reporting the same name again starts a new run (a re-run). With `--external-id <your CI's run id>`, a report always updates the run carrying that id, even after it completed.
- **`--status`** is `queued`, `in_progress` or `completed`. A completed run needs a `--conclusion`: `success`, `failure`, `neutral`, `cancelled`, `skipped`, `timed_out`, `action_required` or `stale` (GitHub's set). `dg` refuses a wrong combination before it signs anything, and so does the contract.
- **`--log <file>`** uploads the log to your storage profile. It is content-addressed, the same way a release asset is (see [Bring your own storage](bring-your-own-storage.md)), and the run records the log's URL and SHA-256. The web app downloads the log from your bucket and shows it only if its bytes hash to the recorded SHA-256; otherwise it says the bytes are not the reported log. Log bytes never go on Platform. The bucket needs CORS for the web app's origin, like any bucket the browser reads.
- **`--summary`** (or `--summary-file`) takes up to 1,000 characters.
- `dg` prints the commit's web page, where the run shows up.

`dg ci status alice/project <sha>` lists the newest run per name on a commit. `dg pr checks alice/project <n>` does the same for a pull request's head.

The newest run per name wins, by `($createdAt, $id)`. A merge box whose branch policy has `requireChecks` needs every counted run on the head to pass (`success`, `neutral` or `skipped`), and at least one run to exist.

## What it costs

Measured on devnet moutai (2026-09-29, drive 4.2.0-beta.6; 1 DASH = 10¹¹ credits):

| Write | Who pays | Credits | DASH |
|---|---|---|---|
| Register the runner key (identity update) | the runner | 28,519,540 | 0.000285 |
| Enrol the runner (`runner` document) | the owner | 45,820,360 | 0.000458 |
| First report of a run (`checkRun` create) | the reporter | 55,036,900 – 78,132,420 | 0.00055 – 0.00078 |
| Each later update (replace) | the reporter | 3,338,780 – 3,687,280 | ≈ 0.000035 |
| First report with `--log` (adds the log URL and hash) | the reporter | 59,100,320 | 0.00059 |

The create's price depends on the fields it carries; a report with a details URL and a summary sits at the top of the range. A typical run is one create plus two updates, about **0.00063 DASH**, so a 0.5 DASH runner key covers roughly 790 runs. The log itself costs nothing on Platform: it goes to your bucket.

## Security

- **Keys.** Give CI a runner key, never your identity file: the file holds your master key. The runner key's bounds are enforced by consensus. Anything else it signs is refused with `ContractBoundedKeyOutOfBoundsError` (20014), which `dg` reports as [E302](../errors.md#e302) before anything is broadcast. The key cannot register keys, move credits or write any other document type. The budget and the expiry cap the damage from a leak. `dg auth keys disable <id> --master runner.json` retires the key early, and `dg ci runner revoke` removes the identity's standing on the repo.
- **What a runner can do.** It can write check runs on *any* commit id of the repositories it runs for, including commits that are not in the repository. Readers match runs to commits by id, so a run on a stranger's commit shows nowhere. A runner cannot edit or delete another identity's run.
- **What is public.** Check runs are plaintext on chain, even for a private repository: name, status, summary, details URL, log URL. See [private-repos §7](../security/private-repos.md#7-metadata-that-stays-visible). Do not put secrets or private code in summaries or in logs stored on a public bucket.
- **Verifying a log.** The SHA-256 on chain pins the bytes. Whoever controls the bucket can delete a log, but cannot swap it for another without the web app noticing.

## Limits of the current contract

These are what the protocol and the current forge-collab contract allow. They are verified against Platform v4.2.0-beta.6.

- **A key can be bound to `checkRun` only.** Protocol 14 admits `SingleContractDocumentType` bounds on AUTHENTICATION keys (`validate_identity_public_key_contract_bounds` v2), and consensus enforces them per batch member (`ContractBounds::check_batched_transition`).
- **The contract does not say *which* identity may report, beyond "runner, maintainer or writer".** It cannot require that only runners write `checkRun`, and it has no status-transition rule, such as "no `queued` after `completed`". The one rule it has is that a conclusion is present exactly when the status is `completed`. Clients follow the newest-run rule. [ci-contract-wishes.md](../design/ci-contract-wishes.md) lists what the next registration should add.
- **A check run is not tied to a pushed commit.** Consensus cannot check that `headOid` exists in the repository: packs live off-chain.

**Coming soon (this series):** reporting from GitHub Actions (`forge-check-action`), a self-hosted runner that runs `.forge/workflows/*.yml` with [act](https://github.com/nektos/act), and relay `check_run` webhooks for in-place updates.
