# S0.6 — Data Contract Realization & Validation — RESULTS

**Goal:** produce the two real Dash Platform data-contract JSONs from `docs/contracts/data-contracts.md` (v3) and prove they validate (`fullValidation: true`) and fit the size / property limits. Local construction only — no testnet.

**Toolchain:** `@dashevo/wasm-sdk` (`/Users/pasta/workspace/platform/packages/wasm-sdk/dist/sdk.js`), loaded in Node via `await init()`. Contracts constructed with `sdk.DataContract.fromJSON(json, /*fullValidation*/ true, /*platformVersion*/ 9)`. Platform version **9** is where V1 contracts (tokens + groups) activate (per `wasm-sdk/tests/unit/data-contract.spec.ts`). Serialized size = `dc.toBytes(9).length`.

**Artifacts written to `forge-contracts/`:**
- `contracts/registry.json` — registry contract (repoListing, profile, star, follow).
- `templates/repo-v1.json` — single per-repo template, all 15 doc types + 2 tokens + control group.
- `templates/repo-core.json`, `templates/repo-collab.json` — the §6 split, built and validated as a proven fallback (not needed — see decision).

**Spike programs (`spikes/S0.6-contracts/`):** `build.mjs` (emits the JSON), `validate.mjs` (constructs + reports), `flag-checks.mjs` (isolates each design flag combo).

---

## 1. Validation result: BOTH CONTRACTS PASS

```
### REGISTRY            PASS   2,620 B   (4 doc types)                     WITHIN 16 KiB
### REPO-V1 (single)    PASS  11,713 B   (15 doc types, 2 tokens, 1 group) WITHIN 16 KiB
### REPO-CORE  (split)  PASS   4,815 B   (6 doc types,  2 tokens, 1 group) WITHIN 16 KiB
### REPO-COLLAB (split) PASS   7,354 B   (9 doc types,  2 tokens, 1 group) WITHIN 16 KiB
```

Max declared properties in any single doc type = **12** (`patch`), far under the 100 limit. Full per-type counts in `validate.mjs` output.

## 2. Split decision: **NO SPLIT REQUIRED**

`repo-v1.json` serializes to **11,713 bytes — 71% of the 16,384-byte estimate**, with ~4.7 KiB of headroom. The single-template path (D4 primary) is viable; ship `repo-v1.json`. The `repo-core` / `repo-collab` split (§6 fallback) is proven to validate and is kept in `templates/` as a ready fallback if future doc-type additions push the single template over the limit.

> **Split caveat (documented, since it changes the token model):** in the split, **each** contract must carry its own `WRITE`+`MAINTAIN` tokens, because `tokenCost` references a `tokenPosition` in *the same contract* (its `contractId` defaults to self, and a per-repo core contract's ID isn't known at template-authoring time to hard-code into collab). So the split yields *two* independent WRITE balances per repo, weakening the "one balance = the ACL" model. This is a further reason to prefer the single template while it fits.

## 3. Flag-combination verification (deliverable #5) — all design-critical combos ACCEPT

Each combination isolated in `flag-checks.mjs` and run through `fullValidation`:

| Flag combination the design leans on | Result |
|---|---|
| `countable` on a **unique compound** index (`repoListing` ownerName = `$ownerId`+`normalizedName`) | **ACCEPT** |
| `countable` on a non-unique index (`comment` targetId, `star` listing, `follow`) | **ACCEPT** |
| `documentsCountable` primary-tree total (`issue`, `patch`, `packManifest`) | **ACCEPT** |
| `tokenCost.delete` (delete-gating on packManifest/chunk/manifestPart/label/release/webhook/checkRun) | **ACCEPT** |
| `canBeDeleted: false` + `documentsMutable: false` (refUpdate/protectedRefUpdate/event/config) | **ACCEPT** |
| `documentsKeepHistory: true` on a mutable/replaceable type (issue/patch/comment) | **ACCEPT** |
| `documentsKeepHistory` + `documentsCountable` together (issue/patch) | **ACCEPT** |
| token `baseSupply: 10^9` (owner auto-credit at DataContractCreate) | **ACCEPT** |

**No design flag combination is rejected by the platform.** The unique+countable combo (the named S0.6 risk) is fine.

## 4. Deviations from `data-contracts.md` forced by schema syntax (reconcile the doc)

Two, both verified empirically and confirmed against all four system contracts (dpns / dashpay / keyword-search / token-history):

### D1 — Non-byteArray arrays are forbidden. **This is the significant one.**
The v1 document meta-schema (`rs-dpp/schema/meta_schemas/document/v1/document-meta.json`, lines 239–259) requires every `type: "array"` property to also be `byteArray: true`. Empirical probe returns:
```
REJECT  string array  ->  invalid contract structure: only byte arrays are supported now
```
Zero of the 4 system contracts contain a non-byteArray array. **This contradicts data-contracts.md §0 ("string arrays fine as non-indexed props (DPNS/keyword-search precedent)") — that precedent does not exist in the v1 (protocol v12) meta-schema.**

Every list-valued field in the design was re-encoded. Two encodings, chosen per field:
- **JSON-in-`string`** (human-readable, non-indexed lists): `repoListing.topics`, `profile.links`, `config.protectedPatterns`, `config.backend.uris`, `packManifest.uris`, `release.assets` (was an array of objects), `webhook.events`. Each capped with a `maxLength` budget and marked with a `description` noting the D1 encoding. Client `FORGE_RULES_V1` must `JSON.parse` these.
- **Packed `byteArray`** (binary id lists): `packManifest.tips` (≤16 oid → `maxItems 512`), `packManifest.supersedes` (≤32 hash32 → `maxItems 1024`).

Doc reconciliation needed: §1 (topics, links), §2.3 (protectedPatterns, backend.uris, packManifest uris/tips/supersedes, release.assets, webhook.events), and the §0 "string arrays fine" mechanic row. None of these fields were ever indexed, so query design is unaffected — only the on-wire field type and a client parse step change.

### D2 — Index sort direction: only `"asc"` in the contract.
The meta-schema index-property enum permits only `"asc"` (line 370); all system contracts use `"asc"` exclusively. The doc's `$createdAt desc` / `(…, $createdAt desc)` markers are **query-time reverse traversal**, not part of the index definition. All indices in the emitted contracts use `"asc"`; "newest-first" ordering is a query-time concern.
- Nuance: the wasm-sdk's `fullValidation` *does* accept a literal `"desc"` in an index (probe: ACCEPT) — its index parser tolerates asc/desc — but the authoritative JSON meta-schema forbids it and no system contract uses it, so `"asc"` is the conservative, consensus-safe choice. Not a blocker either way; the doc just shouldn't imply `desc` is a stored index property.

### Minor representational notes (not deviations, just pinned choices)
- `config.backend` kept as a nested object `{ mode: int, uris: <D1 json-string> }`; nested object properties carry their own `position`.
- Identifier fields use `contentMediaType: application/x.dash.dpp.identifier` with `minItems/maxItems = 32` (meta-schema forces exactly 32 for that media type). `oid` fields (git oids, 20–32 B) therefore **cannot** use that media type — encoded as plain `byteArray` `minItems 20, maxItems 32`. `hash32` = `byteArray` 32/32, no media type.
- Token control (`freeze` / `destroyFrozenFunds` / `mint` / `emergencyAction`) authority routed to `MainGroup` (control group 0); conventions/supply/distribution routed to `ContractOwner`. `mainControlGroup: 0`, group 0 = `{ owner: 1, requiredPower: 1 }`. `AuthorizedActionTakers` unit variants serialize as bare strings (`"ContractOwner"`, `"MainGroup"`); `Group(n)` = `{ "Group": n }`.
- `baseSupply` = `1000000000` (10^9) on both tokens; `maxSupply: null` (owner may mint more — the "grant" action); token names `write`/`writes`, `maintain`/`maintains` (convention forms must be 3–25 chars, no whitespace/control).

## 5. Count-tree assignments realized

- **Registry:** `repoListing` ownerName (unique compound) `countable` + `forkOf` `countable`; `star` listing `countable`; `follow` identity + owner both `countable`.
- **Repo:** `packManifest` `documentsCountable`; `issue`/`patch` `documentsCountable`; `chunk` (packHash,seq) `countable`; `comment` (targetId) `countable`.
- **Not countable** (per §3, no story pays the overhead): `refUpdate`, `protectedRefUpdate`, `event`, `manifestPart`, `checkRun`, `label`, `release`, `webhook`, `profile`, `config`. Verified none carry a count flag.

## 6. Iteration log
1. Confirmed the construction API: `DataContract.fromJSON(fullObject, true, 9)` validates the whole contract incl. tokens/groups (unit spec + fixture `data-contract-v1-with-docs-tokens-groups.ts`).
2. First token build failed — `MainGroup` was written as `{MainGroup:[]}`; `AuthorizedActionTakers` unit variants serialize as bare strings. Fixed → 2-token+group+tokenCost contract validates.
3. Discovered D1 (string arrays rejected) and D2 (asc-only) from the meta-schema; confirmed empirically and against all system contracts; re-encoded all list fields.
4. Built + validated all four contracts on the first full run: all PASS, repo-v1 under 16 KiB → no split.

**Bottom line:** both real contracts validate under `fullValidation`, fit the size and property limits, and every flag the design depends on is accepted. The only doc changes required are the D1 array-encoding reconciliation (material) and the D2 asc/desc clarification (cosmetic).
