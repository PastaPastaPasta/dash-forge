# Dash Forge — Design Freeze #2 (as-built)

Design Freeze #1 (`spike-results.md`) froze decisions from the Phase-0 spikes. Design Freeze #2 records what the **implementation** actually established — the deviations, discoveries, and final decisions that emerged while building every component to a working, testnet-verified product. This is the "as-built" delta.

## Verified end-to-end on testnet

The thesis is proven, not asserted:
- `git clone dash://…` / `git push` byte-identical round-trip (fsck clean, trees identical, tags).
- **Frozen collaborator's push rejected at consensus** (error 40702) through real git — the headline INIT criterion, proven end-to-end in the CLI e2e suite.
- No-token push rejected (40700); third-party hash-chain verification ("no trust in any server").
- Browser app renders live testnet data with the trust panel; zero-backend proven (only Platform DAPI + quorum endpoint contacted); resumable push (interrupted, resumed, no double-pay).
- CLI↔web interop: an issue created in the browser is read and folded identically by the CLI (shared `FORGE_RULES_V1`, 66 conformance vectors passing in **both** Rust and TS).

## As-built decisions & deviations

1. **Native rs-sdk `put/wait` works** — the WASM `waitForResponse` panic (S0.1) is WASM-only; native Rust uses the SDK's `broadcast_and_wait`. The browser uses broadcast + poll. Both idempotent (sign-once, re-broadcast same bytes, `AlreadyExists`/`DuplicateUniqueIndex` = success).
2. **`FieldValue::Uint64`** — nested-object integers CBOR-canonicalize to minimal width and fail proof read-back; the fix is full-width u64 for such fields (surfaced by forge-import's `imported.createdAt`).
3. **Ref resolution is prevOid-DAG-causal, not clock-first** — the deployed repo-v1 `refUpdate` didn't mark `$createdAt` required (fixed in source since), so resolution uses the prevOid chain as the authoritative causal order; the clock only breaks genuine-divergence ties. More correct regardless.
4. **Identifier vs byteArray encoding is the #1 SDK gotcha.** Native Rust operands are raw bytes; WASM/JS query operands are base64 for byteArray fields but **base58 for identifier-typed fields** — mismatching these silently breaks reads (this was the browser "[object Object]" bug: `repoContractId` is a byteArray field returned as base64, but `contracts.fetch` needs base58). forge-web normalizes via `asIdentifierString()`.
5. **Trusted-connect proof-verifies plain reads** — the explicit `*WithProof` facade is redundant *and* browser-buggy in evo-sdk 4.0.0; forge-web uses plain `query()`/`get()` (still verified in trusted mode).
6. **Repo-v1 economics: instantiation ~1.18 DASH** (2 tokens + 15 doc types + count-trees), registry ~0.68 DASH — materially above the early <0.02 estimate; count-tree indices are the main driver. tokenCost payments **recirculate to the repo owner**, not burned.
7. **Contract templates: solo-owner by default.** A MainGroup needs ≥2 members; the source template now uses `ContractOwner` admin (org multi-sig is an opt-in v2 variant). Positions must be top-level-contiguous. Deployed contracts predate these and work via name-addressing + runtime compat shims; only new repos inherit the fixes.
8. **Query completeness is mandatory, not optional** — `in`-batch starvation and the 100-row default truncate authz/fold reads; every fold/authz path paginates to exhaustion + the per-key completeness fallback. Ref enumeration uses flat `limit-1` skip-scan.
9. **Shallow clone dropped; partial clone kept** (S0.9) — a fetch/push helper has no depth reply channel; `--depth` fails loudly, `--filter=blob:none` works via `.promisor`. **jj works unmodified** (gitoxide).
10. **objectLocator: 36-byte fixed-stride rows** (deltaChainSpan fixed 4-byte, not varint; +1-byte delta-depth hint); single-span read for blobs, per-base walk for deep-delta trees. Cold browse loads root-tree-via-locator, not the O(files) flatIndex.
11. **CI reality**: the Rust workspace's path dep on the 3 GB Platform monorepo makes per-push GitHub CI impractical; per-push CI runs the web app + the 66-vector TS parity suite, Rust builds nightly (clones platform). Local + testnet is the authoritative Rust gate.
12. **Codex computer-use** verification was environment-blocked (no browser window); **Playwright headless** substituted and is the better repeatable fit — it caught the browser read bug all node/jsdom tests missed.

## Known limitations (documented, accepted for v1)

- **Repo transfer / owner succession**: contract owners are immutable; "transfer" = fork-and-abandon. Orgs mitigate with jointly-held owner identities (the only mechanism).
- **Cross-repo aggregation** (activity feed, org-wide search): no platform-side cross-contract query; needs an optional community-run indexer (relay-pattern) — not v1.
- **Deployed testnet contracts** (registry `5fu48x`, repos) predate the Stage-5 template fixes; they work by name-addressing but a mainnet deploy should use the reconciled source.
- **Unbounded audit log**: non-deletable `refUpdate`/`event`/`config` grow with activity (~0.08 DASH per 1000 pushes locked); a compaction scheme is a future design item.
- **Private repos, org multi-sig groups, SHA-256 git repos, syntax-highlight coverage beyond common languages, milestone doc type** — v2.
- **`dg` stubs**: `repo fork`, `import` (forge-import is a separate bin), some `repack` browse-artifact regeneration.

## Quality posture

Every substantial module went through: build → all gates (fmt/clippy/test or typecheck/lint/test/build) → live testnet test → independent code-review (which caught real bugs: parity divergences, ACL truncation/injection, SSRF rebinding, financial-safety idempotency, the browser read bug) → fixes re-verified. The design docs were reconciled to as-built at each freeze. This is production-grade rigor for a testnet-complete product; mainnet is a funded runbook away.
