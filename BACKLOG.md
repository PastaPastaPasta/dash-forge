# Backlog

Small follow-ups that are known and accepted, not yet scheduled. Larger work is in [docs/roadmap.md](docs/roadmap.md).

## Platform SDK

- **TODO: bump the JS SDK to 4.2.0-beta.6 once `@dashevo/wasm-sdk@4.2.0-beta.6` is on npm** (the release's NPM job failed: "Required runner group 'platform-npm-releases' not found"). moutai runs drive 4.2.0-beta.6 since the 2026-09-28 reset and the Rust crates are on the `v4.2.0-beta.6` tag; forge-web, `tools/mint-identity` and `forge-contracts/sdk-v2` stay on the beta.5 pair, which reads and writes on beta.6 nodes. When it is published:
  - move the pins in all three `package.json` files and `forge-web/pnpm-workspace.yaml` together, and refresh the locks;
  - **delete `forge-web/lib/sdk/consensus-shift.ts`** and its use in `asConsensusRefusal` with the 11001 / 10904 patterns (platform#5053: until then the pinned SDK decodes a beta.6 node's CheckTx refusal one variant off; `consensus-shift.test.ts` fails once `PINNED_WASM_SDK` no longer matches package.json, as a reminder), and set the 10421 fixture in `write-errors.test.ts` back to 10421;
  - beta.6 JS carries the node's code on every refusal path (platform#5112), so `REFUSAL_PATTERNS` becomes a fallback;
  - only then register contracts that use the beta.6 `propertyConstraints` forms (`$ownerId`, `startsWith`, `countOf`, …), since beta.5 clients cannot parse them (BETA6-ANALYSIS §3.1).

## Cost estimates

- **TODO: recalibrate own-storage pushes to existing repositories.** `forge-import` prices a push whose pack goes to your own storage at 100M credits per manifest and 64M per ref update, beyond their bytes (`crates/forge-import/src/budget.rs`). That is calibrated on first pushes into new repositories, where it is 3–4% over. A one-ref push to an existing repository paid 136–214M against an estimate of 291M: 36–114% over. That is safe, because the estimate stays an upper bound, but it is loose. Once more traced samples exist (`RUST_LOG=forge_import::cost=debug`), give pushes to existing repositories their own figures, and add the samples to `gitsync::tests::own_storage_estimates_cover_recorded_pushes`.

## Web: code browsing

- **Port xdiff's diff for exact blame parity.** Web blame (`forge-web/lib/view/blame.ts`) aligns lines with our Myers diff plus a port of git's change compaction and indent heuristic (`xdiff-compact.ts`). On about 1–2% of random edit histories it still gives a line to a different commit than `git blame --first-parent`: where a line repeats and moves, xdiff's own diff (`xdl_do_diff` with `xdl_cleanup_records`) pairs different copies. The case is recorded in `blame.test.ts`, under "known differences". The UI says blame is computed in the browser and can differ from `git blame`. For exact parity, port `xdl_do_diff` and `xdl_cleanup_records`, then turn the known-difference test into an equality test.
- **Blame through renames with edits.** Only exact renames are followed (the same blob, deleted elsewhere by the commit that added the path). Git scores similarity. The UI notes the case when the add commit also deleted a file of the same name.
