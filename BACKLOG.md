# Backlog

Small follow-ups that are known and accepted, not yet scheduled. Larger work is in [docs/roadmap.md](docs/roadmap.md).

## Platform SDK

- **TODO: bump the JS SDK to 4.2.0-beta.5 (blocked on dashpay/platform#5077).** moutai runs drive 4.2.0-beta.5 since the 2026-09-27 reset, and the Rust crates are on the `v4.2.0-beta.5` tag. `@dashevo/evo-sdk@4.2.0-beta.5` is on npm, but the dependency it pins, `@dashevo/wasm-sdk@4.2.0-beta.5`, was never published: the release's NPM job failed with ENEEDAUTH. So forge-web, `tools/mint-identity` and `forge-contracts/sdk-v2` stay on the beta.4 pair. A beta.4 client works against beta.5 (identities, contract registration, documents, proofs; `/Users/pasta/workspace/dash-forge-qa/BETA5-ANALYSIS.md`). Once wasm-sdk beta.5 is published:
  - move the pins in all three `package.json` files and `forge-web/pnpm-workspace.yaml` together, and refresh the locks;
  - pass `contestFund` where a contested DPNS name is registered, if the default is not enough;
  - only then register schema changes that use the new `propertyConstraints` forms (C-1), since beta.4 clients cannot parse them.

## Cost estimates

- **TODO: recalibrate own-storage pushes to existing repositories.** `forge-import` prices a push whose pack goes to your own storage at 100M credits per manifest and 64M per ref update, beyond their bytes (`crates/forge-import/src/budget.rs`). That is calibrated on first pushes into new repositories, where it is 3–4% over. A one-ref push to an existing repository paid 136–214M against an estimate of 291M: 36–114% over. That is safe, because the estimate stays an upper bound, but it is loose. Once more traced samples exist (`RUST_LOG=forge_import::cost=debug`), give pushes to existing repositories their own figures, and add the samples to `gitsync::tests::own_storage_estimates_cover_recorded_pushes`.
