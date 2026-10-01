# The Platform JS SDK: npm pins, and vendoring as a fallback

forge-web, `tools/mint-identity` and `forge-contracts/sdk-v2` run on `@dashevo/evo-sdk` and `@dashevo/wasm-sdk` **5.0.0-beta.1 from npm** (Platform v5, still protocol 14), pinned exactly; forge-web's `pnpm-workspace.yaml` exempts the pair from pnpm's minimum release age while it is new. Its first release run failed to publish on a transient protoc download; the rerun reached npm (dist-tag `5.0-beta`), so no vendoring was needed.

**Vendoring is fallback tooling.** 4.2.0-beta.6 was never published: its release job asked for a runner group that no longer exists. For such a tag this repository can build the two packages itself and serve them as release assets, with no Rust or LLVM toolchain on any developer's machine or CI job. It was built for beta.6 as [`vendor-sdk-v4.2.0-beta.6`](https://github.com/PastaPastaPasta/dash-forge/releases/tag/vendor-sdk-v4.2.0-beta.6), which proved the pipeline; **nothing depends on that release**, since the move went straight to npm beta.7. Use it again only when a Platform tag the app needs is missing from npm.

## What is where

| | |
|---|---|
| Build | [`.github/workflows/vendor-sdk.yml`](../../.github/workflows/vendor-sdk.yml), `workflow_dispatch` on master with `platform_tag` and, optionally, `expected_commit` (the commit the tag must point at) |
| Artifacts | a pre-release `vendor-sdk-<tag>` with `dashevo-wasm-sdk-<v>.tgz`, `dashevo-evo-sdk-<v>.tgz`, `SHA256SUMS`. The release notes name the source commit, the toolchain and the checksums, including each tarball's npm/pnpm `sha512-…` integrity. `vendor-sdk-v4.2.0-beta.6` (sha256 `4ad6500f…5185` wasm-sdk, `a2bf9949…04df` evo-sdk) is the one built so far |
| Consuming it (forge-web) | `package.json` depends on both asset URLs; `pnpm-workspace.yaml` `overrides` sends evo-sdk's own `@dashevo/wasm-sdk: <v>` dependency to the same URL (otherwise pnpm looks for it on npm, where it does not exist) |
| Consuming it (tools/mint-identity, forge-contracts/sdk-v2) | the same two URLs in `dependencies`, plus `"overrides": { "@dashevo/wasm-sdk": "$@dashevo/wasm-sdk" }` for the same reason |

The release is a build artifact, not a Dash Forge release. It is marked pre-release and never "latest", so `install.sh` and `cargo binstall` never see it, and `release.yml` excludes `vendor-sdk-*` from its `v*` tag trigger. The `refs/tags/v*` tag ruleset does cover it, so the tag cannot be moved or deleted.

**Once consumed, the assets are immutable in practice.** Every lockfile records their sha512; replacing an asset breaks every install that pins it with an integrity error. The workflow refuses to publish when the release or its tag already exists unless dispatched with `replace: true`. Only use that if a published asset is known to be broken, and then refresh all three lockfiles in the same change. It creates the release as a draft, uploads the assets, then publishes, so a half-filled release is never visible. It also attests the tarballs' provenance (`gh attestation verify dashevo-wasm-sdk-<v>.tgz -R PastaPastaPasta/dash-forge`).

**Owner option: immutable releases.** GitHub's repository setting *Immutable releases* would make published assets and their tag unchangeable even to maintainers, which is exactly the guarantee the lockfiles rely on. It applies to every release of the repository, including `release.yml`'s, and it rules out `replace: true`, so it is left as an owner decision; nothing here depends on it.

## How the tarballs are built

The workflow follows upstream's own release recipe at the tag (`.github/actions/npm-release-build/action.yaml`) on a GitHub-hosted `ubuntu-24.04` runner:

1. checks out `dashpay/platform` at `refs/tags/<platform_tag>`, and checks that `packages/wasm-sdk` and `packages/js-evo-sdk` both carry that version;
2. installs the Rust toolchain the tag's `rust-toolchain.toml` pins (1.98.1 for beta.6) with `wasm32-unknown-unknown`, clang/llvm from apt, and wasm-bindgen-cli 0.2.108, wasm-pack 0.15.0, Binaryen version_121 and protoc 32.0 as release binaries, each checked against a SHA-256 in the workflow's `env`;
3. `yarn workspaces focus @dashevo/wasm-sdk @dashevo/evo-sdk` with the tag's own yarn (4.12.0, via corepack);
4. `CARGO_BUILD_PROFILE=release yarn build` in `packages/wasm-sdk` (`build-optimized.sh`, then `bundle.cjs`), `yarn build` in `packages/js-evo-sdk`;
5. `yarn pack` for both. It rewrites evo-sdk's `workspace:*` dependency to the exact version, and the workflow fails if it did not;
6. checks the tarballs' contents (the `dist/` files forge-web loads, the versions, evo-sdk's exact wasm-sdk dependency, a real `.wasm`), writes `SHA256SUMS` and the npm/pnpm `sha512-…` integrity of each tarball into the release notes, attests them, publishes, and re-downloads the assets to check them against `SHA256SUMS`.

Do not expect the wasm to be bit-for-bit reproducible on another host or toolchain build. The checksums identify *this* build; the release notes say how it was made.

## Vendoring a tag

Only when a Platform tag the app needs is unpublished on npm (check `npm view @dashevo/wasm-sdk@<version> version` first).

1. If the tag's recipe pins different tool versions, update the workflow's `env` block. Compare `.github/actions/npm-release-build/action.yaml` and `rust-toolchain.toml` at the tag, fetch each binary, and record its `sha256sum`. Merge that change first: a dispatch runs the workflow as it is on the chosen branch.
2. Actions → *Vendor the Platform JS SDK* → Run workflow on master, `platform_tag: v4.2.0-beta.N`, `expected_commit:` the tag's commit (`git ls-remote https://github.com/dashpay/platform refs/tags/v4.2.0-beta.N`). Most of the run is the wasm compile. A dispatch from another branch builds and checks but does not publish.
3. Point the three consumers at the release (see "What is where"), then refresh the lockfiles:
   - forge-web: in `package.json` and `pnpm-workspace.yaml` `overrides`, swap the URLs, then `pnpm install`;
   - tools/mint-identity and forge-contracts/sdk-v2: in `package.json`, swap the URLs, then `npm install`.
4. Update the other places that name the version: `forge-contracts/scripts/deploy-v2.mjs` (`v2.sdk`), docs, and `BACKLOG.md`.
5. Run the web unit suite, typecheck and `next build` (`next.config.js` fails the build if evo-sdk and forge-web resolve different wasm-sdk versions), plus the Playwright read-only suite against the devnet.

## Moving from a vendored build back to npm

1. Check that the published packages are the same code as the vendored ones. Their tarballs will not be byte-identical (another build host), so compare contents, not integrity:

   ```sh
   v=<the vendored version>
   rel=https://github.com/PastaPastaPasta/dash-forge/releases/download/vendor-sdk-v$v
   tmp=$(mktemp -d); cd "$tmp"
   for p in wasm-sdk evo-sdk; do
     mkdir npm-$p ours-$p
     npm pack "@dashevo/$p@$v" --pack-destination npm-$p >/dev/null && tar -xzf npm-$p/*.tgz -C npm-$p && rm npm-$p/*.tgz
     curl -fsSL "$rel/dashevo-$p-$v.tgz" | tar -xz -C ours-$p
     # Declarations and JS glue must match exactly; the wasm may differ only by build host.
     diff -r -x '*.wasm' -x 'sdk.js' -x 'sdk.compressed.js' -x '*.map' -x 'evo-sdk.module.js' npm-$p ours-$p && echo "$p: same API"
   done
   ```

   `dist/sdk.d.ts` (wasm-sdk) and the `dist/**/*.d.ts` and facade modules (evo-sdk) must be identical. The inlined `sdk.js`/`evo-sdk.module.js` embed the wasm and will differ with it.
2. In forge-web, set both dependencies back to the plain version, delete the `overrides` entry from `pnpm-workspace.yaml`, and add both to `minimumReleaseAgeExclude` while the release is newer than pnpm's minimum release age. Then `pnpm install`.
3. In tools/mint-identity and forge-contracts/sdk-v2, set `"@dashevo/evo-sdk"` to the version, drop the `@dashevo/wasm-sdk` dependency and the `overrides` block, then `npm install`.
4. Run the checks from step 5 above. Leave the pre-release in place (older commits' lockfiles still name it) and note in its description that npm now has the version.

## API notes for the contract rework (4.2.0-beta.6, beta.7 and 5.0.0-beta.1)

### From beta.5 to beta.6

The JS surface between beta.5 and beta.6 is unchanged apart from what the wasm exports: evo-sdk's `dist/*.js` facades are identical, and `@dashevo/wasm-sdk`'s declarations add or change the following.

**Contracts with beta.6 rules parse.** `DataContract.fromJSON(json, true, 14)` accepts the beta.6 `propertyConstraints` grammar: `countOf`, `sumOf`, `ifThen`, `ifThenElse`, `notIn`, `min`/`max`/`abs`, `length`/`byteLength`/`count`, `startsWith`/`endsWith`/`contains`, `$ownerId` and the system times and heights (`$createdAtBlockHeight`, …). beta.5 refuses such a contract, so every client must be on beta.6 before one is registered. `forge-web/lib/sdk/contract-rules-beta6.test.ts` pins this with the state-counts forge-collab draft.

New in beta.6:

- `DataContract#documentTypePropertyConstraints(type: string): DocumentPropertyConstraint[]`: each rule's `name`, `rule`, `reads`, `readsOwner`, `readsSystem`, `readsTotals` (`{ kind: 'countOf' | 'sumOf', documentType, property?, filter: string[] }`).
- `DataContract#checkDocumentPropertyConstraints(document: Document): DocumentPropertyConstraintViolation | undefined` evaluates locally with consensus's code. It does not judge rules that read a block height or a `countOf`/`sumOf` total.

Not new: `DocumentPropertyConstraintErrorCode.DocumentPropertyConstraintViolated = 10422` (a rule broken) is in beta.5 too; beta.6 only widens what a rule can say.

**Errors carry their consensus code (platform#5112).** A refusal at the broadcast check used to arrive as a `WasmSdkError` of kind `Generic` with `code` -1; it now arrives as kind `Protocol` *with* the node's numeric `code`. A block's verdict from a result wait stays kind `StateTransitionBroadcastError`. forge-web's `asConsensusRefusal` (`lib/sdk/write.ts`) reads the charge from the kind: `StateTransitionBroadcastError` charged, `Protocol` not charged, any other kind unknown (no "nothing was charged" claim). Call sites that know where the error came from override it: a broadcast's own catch is never charged, and the result wait's verdict is charged unless the SDK could not decode it. An undecodable error has an unknown charge wherever it surfaces (it is kind `Protocol`, code -1, whether the node refused at CheckTx or in a block), except in a broadcast's own catch. A stale document id (10405) now carries its code too and is still re-prepared before any refusal decode. The text patterns remain as a fallback and for the figures (budget, balance) that only the text holds. platform#5053 also restored the node's order of `BasicError`, so the beta.5-only remap of decoded codes (`consensus-shift.ts`) is gone.

**Aggregate reads.** The evo-sdk facade names these; wasm-sdk's `getDocumentsCount`/`getDocumentsSum`/`getDocumentsAverage` (and `…WithProofInfo`) sit behind them:

```ts
sdk.documents.count(query: DocumentsQuery): Promise<Map<string, bigint>>
sdk.documents.countWithProof(query: DocumentsQuery): Promise<ProofMetadataResponseTyped<Map<string, bigint>>>
sdk.documents.sum(query: DocumentsQuery, sumProperty: string): Promise<Map<string, bigint>>
sdk.documents.sumWithProof(query: DocumentsQuery, sumProperty: string): Promise<ProofMetadataResponseTyped<Map<string, bigint>>>
sdk.documents.average(query: DocumentsQuery, averageProperty: string): Promise<Map<string, { count: bigint; sum: bigint }>>
sdk.documents.averageWithProof(query: DocumentsQuery, averageProperty: string): Promise<ProofMetadataResponseTyped<Map<string, { count: bigint; sum: bigint }>>>
sdk.documents.ranked(query: DocumentsRankedQuery): Promise<DocumentsRankedResult>
```

`DocumentsQuery` is `{ dataContractId, documentTypeName, where?, orderBy?, limit?, startAfter?, startAt?, groupBy?: string[], timeRange?: {...}[] }`, and `where` clauses are `[field, op, value]` with `op` (`DocumentWhereOperator`) one of `==`, `=`, `>`, `>=`, `<`, `<=`, `between`/`Between`, `BetweenExcludeBounds`, `BetweenExcludeLeft`, `BetweenExcludeRight`, `in`/`In`, `startsWith`/`StartsWith`. Only `between`, `in` and `startsWith` have capitalized aliases; the three `BetweenExclude*` exist only capitalized. Grouping:

- `groupBy` omitted or `[]`: one entry keyed `''` with the total;
- `groupBy: ['<field>']` where `<field>` carries an `in` clause: one entry per `in` value (PerInValue);
- `groupBy: ['<field>']` on a range clause: one entry per distinct value in the range (RangeDistinct);
- `groupBy: ['<inField>', '<rangeField>']`: compound entries.

The first `orderBy` clause sets the entry order. A count needs a `countable` index whose properties the `==`/`in` clauses cover (Platform book, `drive/document-count-trees.md`); a count over a range, or one entry per distinct value in a range, needs `rangeCountable` on that index. A sum needs `summable` naming the property on the index, and `rangeSummable` for a range (book, `contract-keywords/aggregates.md`). These signatures are the same in beta.5; what beta.6 adds is the contract grammar that lets rules read the same totals (`countOf`/`sumOf`) at write time.

### From beta.6 to beta.7

**Breaking for today's contracts: `refersTo` finds by `findBy` and checks with `where` (platform#5197).** Every parse, whatever the validation mode, refuses the protocol-14-beta keywords `refersTo.lookup` (now `findBy`: `{ "<index property>": <source> }`, the index being the unique one those properties name), `propertyAgreement` (now `where`, keyed by the referenced document's property) and the `listElement` type (now a `permanentDocument` found by `$id` with `inList`); `ownerRefersTo` follows the same grammar (Platform book, `contract-keywords/refers-to-lookup.md`). forge-core and forge-collab as registered on moutai before its beta.7 wipe use `lookup` and `propertyAgreement`, so a beta.7 client cannot even fetch them ("invalid contract structure: refersTo lookup was replaced by findBy …"). The move to beta.7 therefore lands with the fresh registration of both contracts in the new syntax, not before.

**Index-only creates and deletes resolve once they land (platform#5136).** `sdk.documents.create` / `delete` of an `indexOnly` type now wait with the affected-state proof inside the SDK instead of rejecting the strict wait with "received a verified … snapshot". forge-web's engine broadcasts and waits itself, and the strict `waitForResponse` still refuses such an outcome, so an indexOnly create (star, follow, watch, starBeat) waits with `stateTransitions.waitForAffectedState` and every stored document keeps the strict wait; its delete path goes through `documents.delete` and needs no snapshot handling any more. forge-core's `WriteEngine::execute` keeps its `wait_for_affected_state` for the same reason.

**Local contract-update check (platform#5140).** `DataContract#validateUpdate(newContract, blockInfo, platformVersion)` lives in `@dashevo/wasm-dpp2`, not in `@dashevo/wasm-sdk` or evo-sdk, so the app cannot call it through its SDK; `tools/contract-validate --expect-update` (rs-dpp) remains the update check.

**Storage layout and create cost, computed locally (platform#5153, #5159).** Both are exported from evo-sdk's entry (`export * from './wasm.js'`) and need no network:

```ts
documentTypeLayout(contract: DataContract, documentTypeName: string, platformVersion: PlatformVersionLike): DocumentTypeLayout
documentCreateCost(contract: DataContract, documentTypeName: string, options: DocumentCreateCostOptions | undefined, platformVersion: PlatformVersionLike): DocumentCreateCost
// options: { fields?: Record<path, { present?, length? }>, existingDocuments?, signatureKeyType?, userFeeIncrease?, feeMultiplierPermille?, contenders? }
// result: storage / indexes / elements / processing / contractCharges / refund / totalCredits, each amount as { newValues, knownValues }
```

*Could it replace `lib/sdk/cost.ts`'s hand-calibrated constants?* Partly, not yet wholesale. What it gives is the storage side exactly, per index, with the "every index value new" and "values already known" scenarios that `FirstWrite`'s surcharges approximate by hand today. The processing side is estimated (`exact: false`) from an assumed `existingDocuments`. A first probe on the state-counts forge-collab draft gave 143.8M credits (known values) for a 10-byte comment and 145.2M for a 10-byte issue. The same writes measured 52.2M and 59.0M on moutai, against today's contracts. So the figures are not comparable until the fresh contracts exist to measure against. The route that fits `cost.ts` is:
- after the fresh registration, call `documentCreateCost` for the base and the first-write surcharges of each type;
- keep the measured table as the regression check, with an explicit headroom;
- then retire the per-type constants that it matches within that headroom.

The measured `Admission` side (what Drive requires the key budget and the balance to cover) stays measured: `documentCreateCost` prices the charge, not the admission check.

### From beta.7 to 5.0.0-beta.1

Platform v5.0.0-beta.1 is the 4.2 line renamed; the protocol is still 14. Paths below are in `dashpay/platform` at the tag.

**Breaking for today's contracts: `immutableAllowSetting` is gone.** Every parse refuses it (`packages/rs-dpp/src/data_contract/document_type/class_methods/try_from_schema/common/mod.rs:3106-3134`). Each set-once property becomes a conditional `immutable` entry, `{ "property": "p", "when": { "present": "$old.p" } }` (Platform book, `contract-keywords/mutability.md`). forge-community's checkRun used it, so its RC1 bytes cannot be parsed by this SDK (no snapshot, no fetch), and beta.7 refuses the new form. The SDK bump therefore ships with the forge-community re-registration and its snapshot, never before. The bonsia snapshot is dropped until then (`forge-web/lib/sdk/contract-seed.ts`).

**JS API: additive, except one field.**
- `DataContract.documentTypeImmutableProperties` returns `immutableWhen: Record<string, unknown>` in place of `immutableAllowSetting: string[]` (`packages/wasm-dpp2/src/data_contract/document_type_immutability.rs:45-52`). forge-web does not read it.
- New moderation calls on `contracts`: `moderatorDeleteSettledDocument`, `moderatorApproveTeamAction`, `teamActions`, `teamActionSigners`, `moderationActionCounts` (`packages/js-evo-sdk/src/contracts/facade.ts:194, 210, 314, 331, 351`). Forge contracts declare no moderation.
- A composite sub-result gains `removed: JoinedDocumentRemoval[]` (`packages/wasm-sdk/src/queries/composite_document.rs:149`), only ever filled for `moderatedDocument` joins. `lib/sdk/composite.ts` maps only the fields it reads.
- The facade calls forge-web uses (`documents.*`, `contracts.{fetch,getLatestVersions,addKnown}`, `identities.*`, `stateTransitions.*`, `dpns.resolveName`, `system.*`, `epoch.current`) are unchanged, and `tsc --noEmit` is clean on the bump.

**An immutable-property refusal names the property.** Code 40128 renders `property 'p' of document <id> (type 't') is immutable and cannot be changed by a replace` (`packages/rs-dpp/src/errors/consensus/state/document/document_immutable_property_changed_error.rs:27`); a replace that breaks a `when` condition is refused with the same code (`document_type_immutability.rs:45-49`). `lib/sdk/write.ts` reads the property and type out of the text, and `lib/view/write-errors.ts` names the frozen field (a completed check run's evidence, a set-once field, or any other).
