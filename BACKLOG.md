# Backlog

Small follow-ups that are known and accepted, not yet scheduled. Larger work is in [docs/roadmap.md](docs/roadmap.md).

## Cost estimates

- **TODO: recalibrate own-storage pushes to existing repositories.** `forge-import` prices a push whose pack goes to your own storage at 100M credits per manifest and 64M per ref update, beyond their bytes (`crates/forge-import/src/budget.rs`). That is calibrated on first pushes into new repositories, where it is 3–4% over. A one-ref push to an existing repository paid 136–214M against an estimate of 291M: 36–114% over. That is safe, because the estimate stays an upper bound, but it is loose. Once more traced samples exist (`RUST_LOG=forge_import::cost=debug`), give pushes to existing repositories their own figures, and add the samples to `gitsync::tests::own_storage_estimates_cover_recorded_pushes`.
