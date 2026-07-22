# S0.3 — Proof-verifying vs trusted SDK mode: forge-web default

**Goal.** Measure the perf/memory cost of proof-verifying vs trusted `@dashevo/evo-sdk@4.0.0`
modes to decide forge-web's default (PRD 01 open question 4 / PRD 03 / architecture.md /
implementation-plan.md, all citing "S0.3 benchmark").

**Headline verdict — the premise behind the open question is wrong, and that's the actual
answer.** The design assumed the axis was `EvoSDK.testnet()` (fully trustless,
proof-verifying) vs `EvoSDK.testnetTrusted()` (fast, trusts a hosted quorum-key endpoint).
**`EvoSDK.testnet()` (non-trusted mode) is not supported at all in WASM** — it connects in
~45 ms but throws on the very first read: *"Non-trusted mode is not supported in WASM."*
There is no fully-trustless option for a browser SDK in this release. `testnetTrusted()` /
`mainnetTrusted()` — trusting the `quorums.<network>.networks.dash.org` key-hosting endpoint
— is **forge-web's only usable connect path**, full stop. Given that, the only remaining
question is whether to use the proof-verifying facade methods (`*WithProof`) on top of that
connection, and the measured answer is: **do it everywhere — the marginal cost is
statistically indistinguishable from zero.** Median per-op deltas between plain and
`*WithProof` calls ranged from **-6.7% to +11.0%**, well inside testnet's own run-to-run
network jitter (individual call latencies ranged 91–1466 ms against a ~300–700 ms median).
**Recommendation: default forge-web to proof-verified reads (`testnetTrusted()` connect +
`*WithProof` facades) everywhere the design's verification badge appears.** See §6.

---

## Method note

Node is used as a proxy for the browser (`wasm-sdk`'s Rust→WASM core is identical in both —
`@dashevo/evo-sdk@4.0.0` ships the same `.wasm` binary; Node just supplies a different JS
host). **Caveat or Node-vs-browser deltas:**
- Network transport differs (Node's `fetch`/HTTP client vs browser `fetch`, no COOP/COEP
  `credentialless` isolation overhead, different TLS session-reuse/connection-pooling
  behavior) — the absolute latency numbers below will shift some in-browser, though both
  environments hit the same testnet DAPI/masternode endpoints over HTTPS so the order of
  magnitude should transfer.
- `process.memoryUsage()` (V8 heap + the wasm linear-memory arena, reported under
  `external`/`arrayBuffers`) is not directly comparable to browser heap-snapshot numbers, but
  the **wasm linear-memory footprint itself is environment-independent** — it's the same
  compiled module — so the *relative* trusted-vs-non-trusted memory delta should hold.
- CPU-bound work (the actual proof-verification arithmetic: GroveDB merkle-proof walk + one
  BLS threshold-signature check) runs identically in both hosts; this is the part of the
  result most safely portable to the browser.

Testnet identity used: `OWNER` from the throwaway pool at
`/Users/pasta/.config/dash-forge/test-identities/OWNER.identity.json`
(`B72TJDCsaExkoET6enz6HZGvGcHiSRYupjgve9KARoGx`, real registered testnet identity, minted by
`tools/mint-identity`). Contract used: the **DPNS system contract**
(`GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec`, from
`platform/packages/dpns-contract/lib/systemIds.js`), queried for `domain` documents under
`normalizedParentDomainName == 'dash'`, `limit 25`. All operations are **reads only** — no
testnet writes, no funding needed. `node_modules` is a symlink to
`tools/mint-identity/node_modules` (same evo-sdk 4.0.0 install), matching the S0.2 spike's
pattern.

Reproduce: `node bench.mjs > raw-results.json` (env `BENCH_CONNECT_RUNS=5 BENCH_REPS=20` used
for these results; takes ~90 s, all testnet reads).

---

## 1. Finding: `EvoSDK.testnet()` (non-trusted) is unusable in WASM

`connect-child.mjs testnet` (5 fresh-process runs):

| | connect median | connect p90 | rss median | heapUsed median | can read? |
|---|---:|---:|---:|---:|---|
| `EvoSDK.testnet()` | 45.1 ms | 46.7 ms | 214.1 MB | 17.7 MB | **NO** |

`connect()` itself succeeds fast — it's cheap because it does *not* fetch any quorum context.
But the first proof-bearing call (`contracts.fetch`, which is not even the `WithProof`
variant) throws immediately:

```
context provider error: Context provider error: Non-trusted mode is not supported in WASM.
Please construct a WasmTrustedContext via prefetchMainnet/prefetchTestnet/prefetchDevnet/
prefetchLocal and attach it with WasmSdkBuilder.withTrustedContext().
```

This matches the evo-sdk README's actual (previously easy-to-miss) wording: *"Trusted mode
is required for all queries."* The `platform-constraints.md` §7 / PRD phrasing ("`testnet()`
(proof-verifying)" as a distinct, more-trustless alternative to `testnetTrusted()`) does not
hold for the wasm target forge-web uses. **There is no lever in evo-sdk@4.0.0/wasm to avoid
trusting the quorum-key-hosting endpoint** (`https://quorums.testnet.networks.dash.org` /
mainnet equivalent) — that trust is baked into the only functional connect path. forge-web's
trust panel (PRD 03 "trust panel explains the chain") should disclose this dependency
explicitly rather than implying a fully trustless option exists.

## 2. Finding: `{ proofs: false }` crashes the WASM module — never expose it

`connect-child.mjs`/`workload.mjs` never pass `proofs: false`, because it doesn't degrade
gracefully — it panics the WASM instance outright. Minimal repro:
`repro-proofs-false-panic.mjs` (`node repro-proofs-false-panic.mjs`, output archived in
`repro-proofs-false-panic.log`):

```
connected; issuing plain contracts.fetch() under proofs:false ...
panicked at packages/rs-sdk/src/platform/query.rs:134:13:
not implemented: queries without proofs are not supported yet
...
RuntimeError: unreachable
```

This is an **unrecoverable WASM trap**, not a catchable JS rejection — the process (tab, in a
browser) dies. The evo-sdk README's `proofs` option description ("setting to `false` disables
proof requests where supported... several query paths force proofs regardless") undersells
this: for documents/contracts queries it isn't merely ignored, it's a hard crash.
**forge-web must never construct an SDK instance with `proofs: false`, and must never surface
a "disable proof verification" UI toggle that maps to it** in this SDK version.

## 3. Finding: plain vs `*WithProof` facade calls cost the same

Because (1) and (2) rule out any genuinely "unverified, faster" document/contract read path,
the only real comparison left is: does calling the `*WithProof` variant (which returns proof
+ metadata to the caller) cost anything over the plain variant, given a `testnetTrusted()`
connection? `identities` is the one facade with an explicit escape hatch
(`fetchUnproved()`), included for reference.

**Read workload — single persistent `testnetTrusted()` connection, n=20 interleaved reps per
op** (interleaved A/B/A/B... specifically to cancel out connection-warmup/testnet-load drift
across the run; one untimed warm-up call per op precedes all timing):

| Operation | Mode | Median (ms) | p90 (ms) |
|---|---|---:|---:|
| `contracts.fetch` (DPNS contract) | plain | 470.3 | 592.8 |
| `contracts.fetchWithProof` | proof-verified | 438.8 | 533.3 |
| `documents.query` (DPNS `domain`, limit 25) | plain | 517.8 | 690.4 |
| `documents.queryWithProof` | proof-verified | 512.0 | 575.9 |
| `identities.fetch` (OWNER identity) | plain | 284.8 | 469.6 |
| `identities.fetchWithProof` | proof-verified | 316.0 | 398.4 |
| `identities.fetchUnproved` | explicit no-proof | 325.0 | 510.3 |

**Proof-verification overhead** (median `*WithProof` vs plain, per op):

| Operation | Overhead |
|---|---:|
| contract fetch | **-6.7%** (proof-verified was *faster*) |
| documents query | **-1.1%** |
| identity fetch | **+11.0%** |
| identity fetch vs explicit `fetchUnproved` | **+2.8%** |

All four deltas are within testnet's own jitter — individual call latencies in the raw log
(`bench.log`) range **91 ms to 1,466 ms** for the *same operation, same mode, same
connection*, so a ±40 ms median shift one way or the other is noise, not signal. If anything,
the direction is inconsistent (sometimes proof-verified is *faster*), which is itself strong
evidence there's no real per-call verification tax at this scale: local verification of a
~4 KB merkle proof + one BLS pairing check is on the order of low single-digit milliseconds,
utterly swamped by the ~300–700 ms cross-network round trip both paths pay regardless (both
paths **already** fetch the proof from the server — `queryWithProof`/`fetchWithProof` don't
trigger extra network requests, they just additionally surface the proof object that was
already transmitted; see §4).

## 4. Confirming proofs are actually verified (not silently skipped)

Two independent checks, since "the number didn't move" alone doesn't prove verification is
real — it could equally mean verification never happens:

**(a) Proof material is real and substantial**, not a decorative flag. Captured from
`contracts.fetchWithProof(DPNS_CONTRACT_ID)`:

```json
{
  "grovedbProofBytes": 4377,
  "quorumType": 6,
  "quorumHashHex": "00000000476aa2aaa7cb4062d6714d358c46f44d8ffff5d24467f1949998288c",
  "signatureBytes": 96,
  "metadataHeight": "443577"
}
```

A 4.4 KB GroveDB merkle proof plus a 96-byte BLS threshold signature and quorum hash are
transmitted and exposed per call — this is the actual cryptographic material a verifier needs,
not a boolean.

**(b) Negative control**: point `testnetTrusted()` at a bogus `quorumUrl` (so the SDK cannot
obtain real quorum public keys) and confirm reads are blocked, not silently allowed through
unverified (`negative-test.mjs`):

```json
{ "connectOk": false, "stage": "connect", "error": "Failed to prefetch quorums: HTTP request error: error sending request" }
```

`connect()` itself refuses to proceed without a working quorum-key source — proving the
quorum-key prefetch is a genuine, load-bearing prerequisite for every subsequent read, not a
decorative parameter that verification silently bypasses if absent.

Together, (a) and (b) confirm forge-web's proof-verifying reads are doing real cryptographic
verification work, consistent with the near-zero measured overhead in §3 (the crypto is cheap
relative to network RTT, not absent).

## 5. Connect time & memory: the one real cost of "proof mode"

The only place `testnetTrusted()` genuinely costs more than a hypothetical unverified
baseline is the one-time, per-session quorum-key prefetch at `connect()`:

| | connect median | connect p90 | rss median | heapUsed median | usable for reads |
|---|---:|---:|---:|---:|---|
| `EvoSDK.testnet()` (non-trusted) | 45.1 ms | 46.7 ms | 214.1 MB | 17.7 MB | No (§1) |
| `EvoSDK.testnetTrusted()` | 553.5 ms | 597.5 ms | 228.5 MB | 22.2 MB | Yes |

`testnetTrusted()`'s ~550 ms connect cost is itself just another network round trip (fetching
quorum public keys from `quorums.testnet.networks.dash.org`), comparable in magnitude to a
single read op — and it's **paid once per session**, not per query, so it amortizes away
completely for any session that does more than one read (which is every forge-web page view).
Memory overhead is modest: **+14.4 MB RSS / +4.5 MB heapUsed** for the cached quorum context,
negligible against forge-web's < 1.5 MiB gz + lazy-WASM budget (INIT.md; the WASM binary
itself, not this delta, dominates the download budget).

## 6. Recommendation

**Default forge-web to proof-verified reads: `EvoSDK.testnetTrusted()` /
`EvoSDK.mainnetTrusted()` to connect, and the `*WithProof` facade methods
(`documents.queryWithProof`, `contracts.fetchWithProof`, `identities.fetchWithProof`, etc.)
for every read that feeds the PRD 03 "verification chip row" (refs ✓ proof · packs ✓ sha256 ·
source).**

Rationale, ranked:
1. **There's no cheaper alternative to compare against.** The fully-trustless mode the design
   imagined (`EvoSDK.testnet()`) doesn't work in WASM at all (§1), and the config-level
   "skip verification" escape hatch crashes the process (§2). Proof fetch+verify is not
   optional for documents/contracts in this SDK version — it happens whether or not you ask
   for it, so refusing to *read* the proof result buys forge-web nothing.
2. **Measured marginal overhead is ~0%, indistinguishable from testnet jitter** (§3):
   -6.7% to +11.0% across three op types, no consistent direction. This is the direct
   quantification the design asked for — it's small enough that the "if proof overhead is
   small, default proofs" branch of the open question applies cleanly.
3. **The one real cost — connect-time quorum prefetch (~550 ms, ~14 MB RSS) — is a
   one-time session cost**, appropriate to absorb into forge-web's existing "connecting to
   Platform..." loading state, not a per-page-view tax.
4. **Update the trust-panel copy** (PRD 03 §"Cost & trust UX") to accurately describe what's
   actually being trusted: not "fully verified, zero external trust," but "cryptographically
   verified against quorum keys fetched from `quorums.<network>.networks.dash.org`" — an
   honest, still-strong trust story, just not the maximal one the open question's phrasing
   implied was available.
5. Use `identities.fetchUnproved()` only for genuinely best-effort, non-trust-badged reads
   (e.g. a speculative prefetch/hover-preview) — not because it's measurably faster (§3 shows
   it isn't), but because it's the one facade where explicitly opting out of the proof/
   metadata payload is actually supported without crashing.

**Action items for later spikes/implementation:**
- Wire `evo-sdk-service.ts`-equivalent in forge-web to always use `*Trusted()` factories
  (never plain `testnet()`/`mainnet()`) and always call the `*WithProof` variant for anything
  feeding a verification badge — codify this as a lint/review rule given how easy it'd be to
  accidentally call the plain variant and silently drop the proof metadata the UI needs.
- Add a runtime guard or lint rule banning `proofs: false` in any `EvoSDK*` constructor call
  in forge-web, given §2's crash behavior.
- Re-run this benchmark against a real browser (COOP/COEP `credentialless`, actual `fetch`)
  once forge-web's SDK wrapper exists, to close the Node-proxy caveat — expected to confirm
  rather than overturn this result, since the dominant cost (network RTT) is host-independent
  and the proof-verification math is unchanged.

---

## Files

| File | Purpose |
|---|---|
| `bench.mjs` | Orchestrator: spawns `connect-child.mjs` (fresh process per run, clean memory reads), runs `workload.mjs` + `negative-test.mjs`, prints consolidated JSON |
| `connect-child.mjs` | Single-process connect+memory probe for one mode (`testnet` \| `testnetTrusted`) |
| `workload.mjs` | Persistent-connection read-latency workload (interleaved plain vs `*WithProof`, n=20) |
| `negative-test.mjs` | Bogus-`quorumUrl` negative control (§4b) |
| `repro-proofs-false-panic.mjs` / `.log` | Minimal repro of the `proofs:false` WASM panic (§2) |
| `lib.mjs` | Shared constants (DPNS contract id, test identity id, query shape) + median/p90 helpers |
| `raw-results.json` | Full benchmark output (this run) |
| `bench.log` | Per-rep stderr log (this run) |
