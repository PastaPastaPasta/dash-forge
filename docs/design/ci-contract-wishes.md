# CI: what the next contract registration should change

Status: wishes for the fresh registration after the next moutai wipe (see `dash-forge-qa/design/STATE-COUNTS.md`, which moves `checkRun`, `webhook` and `policy` into a new **forge-community** contract). Nothing here is deployed. Today's clients are built against the current forge-collab `checkRun` and forge-core `runner` (platform-parity-spec §6.2, §6.4). Every contract lookup in `forge_core::ci` and `forge-web/lib/repo/checks.ts` goes through the repo's `ForgeIds` / `repoSource`, so moving `checkRun` to forge-community is a deployment-file change plus one line in `CORE_TYPES` (web).

Each item says whether the protocol can do it (checked against `dashpay/platform` v4.2.0-beta.6) and why it matters.

## 1. Only a runner may write `checkRun` (optional)

**Today:** `ownerRefersTo anyOf [runner, maintainer, writer]`. A writer can post a "passing" run for its own PR's head, and that run counts in the merge box.

**Wish:** a policy flag, not a gate change. GitHub lets any collaborator with `checks:write` post, so keep the three operands. Add `policy.checksFrom` (enum `members` | `runners`), and have the client rule (`checks_state`) count only runners' runs when it is `runners`.

A consensus-level "runners only" would be a second document type, `runnerCheckRun`, gated on `runner` alone. It doubles the reader paths; not recommended.

**Protocol:** `anyOf` with up to four operands exists (meta-schema v3 `refersTo`). A per-repo choice between gates does not; hence the client rule.

## 2. Status transitions

**Today:** the only rules are `conclusionIfDone` / `doneIfConclusion`. A reporter can replace a `completed` run back to `queued`. `dg ci report` never does this (a completed run is history; a new report is a new document, unless the report carries `--external-id`), but another client could.

**Wish:** refuse `completed → queued | in_progress` on a replace.

**Protocol: UNVERIFIED / likely not expressible.** beta.6 `propertyConstraints` judge the document being written, not its previous revision. Nothing in `beta6/RULE-LANGUAGE.md` lets a rule compare against the stored revision. The practical alternative is to make `status` and `conclusion` immutable once `completed`: `immutable` is per property, not conditional, so this is not expressible either. **Keep it as a client rule**, and document it in `FORGE_RULES_V2`: a reader ignores a run whose `completedAt` is set but whose status is not `completed`.

## 3. `$updatedAt` index for pollers

**Today:** a relay or runner that watches for progress re-reads `(repoId, headOid)` for every watched head (I-5), because `recent (repoId, $createdAt)` misses replaces.

**Wish:** an index `updated (repoId, $updatedAt)`, so "what changed since my cursor" is one query per repo.

**Protocol:** `$updatedAt` is indexable when it is required, and it is required on `checkRun`. Cost: one more index entry per create and per replace (not measured yet; measure it on the fresh registration). Worth it only if relays poll many heads.

## 4. `headOid` tied to a ref (not possible)

A check run on a commit that is not in the repository is accepted. Consensus cannot see pack contents, so this stays a reader concern: readers look runs up by commit id, so an unrelated id shows nowhere.

## 5. Log retention hints

**Wish:** an optional `logExpiresAt` (integer), so the web app can say "log expired" instead of "storage answered 404" when a runner prunes its bucket. The cost is a few bytes a run.

## 6. Keep

- `externalId`, `startedAt`, `completedAt`, `artifacts`, `logUrl`, `logSha256` (`dependentRequired` both ways), and GitHub's conclusion set.
- `canBeDeleted` default (true): a runner may delete its own mistaken run. A delete removes the run from every reader, which is what the reporter meant.
- The key model: `ContractBounds::SingleContractDocumentType {contract, "checkRun"}` on an AUTHENTICATION / HIGH key with a budget and an expiry. If `checkRun` moves to forge-community, runner keys bound to the old forge-collab stop working and must be re-issued (`dg ci runner new`). Say so in the migration notes.
