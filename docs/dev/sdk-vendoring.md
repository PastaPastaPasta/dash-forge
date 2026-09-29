# Vendored Platform JS SDK

forge-web, `tools/mint-identity` and `forge-contracts/sdk-v2` run on `@dashevo/evo-sdk` and `@dashevo/wasm-sdk` **4.2.0-beta.6**. dashpay never published that version to npm: the `v4.2.0-beta.6` release job asks for a runner group that no longer exists, and dashpay/platform#5077 fixes this only for later tags. So this repository builds the two packages from the tag itself and installs them from a GitHub release asset.

Nothing is built on a developer's machine or in CI: `pnpm install` and `npm ci` download two tarballs, and the lockfiles pin their integrity. A Rust or LLVM toolchain is needed only to produce a new pair, and that happens in a workflow.

## What is where

| | |
|---|---|
| Build | [`.github/workflows/vendor-sdk.yml`](../../.github/workflows/vendor-sdk.yml), `workflow_dispatch` on master with `platform_tag` and, optionally, `expected_commit` (the commit the tag must point at) |
| Artifacts | pre-release [`vendor-sdk-v4.2.0-beta.6`](https://github.com/PastaPastaPasta/dash-forge/releases/tag/vendor-sdk-v4.2.0-beta.6): `dashevo-wasm-sdk-4.2.0-beta.6.tgz`, `dashevo-evo-sdk-4.2.0-beta.6.tgz`, `SHA256SUMS`. The release notes name the source commit, the toolchain and the checksums |
| forge-web | `package.json` depends on both asset URLs; `pnpm-workspace.yaml` `overrides` sends evo-sdk's own `@dashevo/wasm-sdk: 4.2.0-beta.6` dependency to the same URL (otherwise pnpm looks for it on npm, where it does not exist) |
| tools/mint-identity, forge-contracts/sdk-v2 | the same two URLs in `dependencies`, plus `"overrides": { "@dashevo/wasm-sdk": "$@dashevo/wasm-sdk" }` for the same reason |

The release is a build artifact, not a Dash Forge release. It is marked pre-release and never "latest", so `install.sh` and `cargo binstall` never see it, and `release.yml` excludes `vendor-sdk-*` from its `v*` tag trigger. The `refs/tags/v*` tag ruleset does cover it, so the tag cannot be moved or deleted.

**The assets are immutable in practice.** Every lockfile records their sha512; replacing an asset breaks every install that pins it with an integrity error. The workflow refuses to publish when the release or its tag already exists unless dispatched with `replace: true`. Only use that if a published asset is known to be broken, and then refresh all three lockfiles in the same change. It creates the release as a draft, uploads the assets, then publishes, so a half-filled release is never visible. It also attests the tarballs' provenance (`gh attestation verify dashevo-wasm-sdk-<v>.tgz -R PastaPastaPasta/dash-forge`).

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

## Rebuilding for a new tag

Only when a new Platform tag is also unpublished on npm (check `npm view @dashevo/wasm-sdk@<version> version` first).

1. If the tag's recipe pins different tool versions, update the workflow's `env` block. Compare `.github/actions/npm-release-build/action.yaml` and `rust-toolchain.toml` at the tag, fetch each binary, and record its `sha256sum`. Merge that change first: a dispatch runs the workflow as it is on the chosen branch.
2. Actions → *Vendor the Platform JS SDK* → Run workflow on master, `platform_tag: v4.2.0-beta.N`, `expected_commit:` the tag's commit (`git ls-remote https://github.com/dashpay/platform refs/tags/v4.2.0-beta.N`). Most of the run is the wasm compile. A dispatch from another branch builds and checks but does not publish.
3. Point the three consumers at the new release, then refresh the lockfiles:
   - forge-web: in `package.json` and `pnpm-workspace.yaml` `overrides`, swap the URLs, then `pnpm install`;
   - tools/mint-identity and forge-contracts/sdk-v2: in `package.json`, swap the URLs, then `npm install`.
4. Update the other places that name the version: `forge-contracts/scripts/deploy-v2.mjs` (`v2.sdk`), docs, and `BACKLOG.md`.
5. Run the web unit suite, typecheck and `next build` (`next.config.js` fails the build if evo-sdk and forge-web resolve different wasm-sdk versions), plus the Playwright read-only suite against the devnet.

## Moving back to npm once dashpay publishes

1. Check that the published packages are the same code as the vendored ones. Their tarballs will not be byte-identical (another build host), so compare contents, not integrity:

   ```sh
   v=4.2.0-beta.6
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
2. In forge-web, set both dependencies back to the plain version (`"4.2.0-beta.6"`), delete the `overrides` entry from `pnpm-workspace.yaml`, and add both to `minimumReleaseAgeExclude` while the release is newer than pnpm's minimum release age. Then `pnpm install`.
3. In tools/mint-identity and forge-contracts/sdk-v2, set `"@dashevo/evo-sdk": "4.2.0-beta.6"`, drop the `@dashevo/wasm-sdk` dependency and the `overrides` block, then `npm install`.
4. Run the checks from step 5 above. Leave the pre-release in place (older commits' lockfiles still name it) and note in its description that npm now has the version.

## API notes for the contract rework (4.2.0-beta.6)

The JS surface between beta.5 and beta.6 is unchanged apart from what the wasm exports: evo-sdk's `dist/*.js` facades are identical, and `@dashevo/wasm-sdk`'s declarations add or change the following.

**Contracts with beta.6 rules parse.** `DataContract.fromJSON(json, true, 14)` accepts the beta.6 `propertyConstraints` grammar: `countOf`, `sumOf`, `ifThen`, `ifThenElse`, `notIn`, `min`/`max`/`abs`, `length`/`byteLength`/`count`, `startsWith`/`endsWith`/`contains`, `$ownerId` and the system times and heights (`$createdAtBlockHeight`, …). beta.5 refuses such a contract, so every client must be on beta.6 before one is registered. `forge-web/lib/sdk/contract-rules-beta6.test.ts` pins this with the state-counts forge-collab draft.

New in beta.6:

- `DataContract#documentTypePropertyConstraints(type: string): DocumentPropertyConstraint[]`: each rule's `name`, `rule`, `reads`, `readsOwner`, `readsSystem`, `readsTotals` (`{ kind: 'countOf' | 'sumOf', documentType, property?, filter: string[] }`).
- `DataContract#checkDocumentPropertyConstraints(document: Document): DocumentPropertyConstraintViolation | undefined` evaluates locally with consensus's code. It does not judge rules that read a block height or a `countOf`/`sumOf` total.

Not new: `DocumentPropertyConstraintErrorCode.DocumentPropertyConstraintViolated = 10422` (a rule broken) is in beta.5 too; beta.6 only widens what a rule can say.

**Errors carry their consensus code (platform#5112).** A refusal at the broadcast check used to arrive as a `WasmSdkError` of kind `Generic` with `code` -1; it now arrives as kind `Protocol` *with* the node's numeric `code`. A block's verdict from a result wait stays kind `StateTransitionBroadcastError`. forge-web's `asConsensusRefusal` (`lib/sdk/write.ts`) reads the charge from the kind: `StateTransitionBroadcastError` charged, `Protocol` not charged, any other kind unknown (no "nothing was charged" claim). Call sites that know where the error came from override it: a broadcast's own catch is never charged, and the result wait's verdict is charged unless the SDK could not decode it (then unknown). A stale document id (10405) now carries its code too and is still re-prepared before any refusal decode. The text patterns remain as a fallback and for the figures (budget, balance) that only the text holds. platform#5053 also restored the node's order of `BasicError`, so the beta.5-only remap of decoded codes (`consensus-shift.ts`) is gone.

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
