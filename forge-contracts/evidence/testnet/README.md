# Testnet registration evidence (2026-10-26)

forge-v2 was registered on testnet (`dash-testnet-51`, Platform 5.0.0-rc.8, protocol 14) from the
committed `forge-contracts/contracts/mainnet/` set by the dedicated deployer
`3pjHaytsQJg5aKZj3VeqwBPccN7uN3bCJiUNkT8KUBwM`. The live record is
`forge-contracts/deployments/testnet.json`; the registered bytes are in
`forge-contracts/contracts/registered/testnet/`.

| File | What it shows |
|---|---|
| `signed-sums.sha256` | The SHA-256 of the four contract files registered (`deploy-v2.mjs --print-sha256 --set mainnet`, passed as `--expect-sha256`). |
| `c1.json` | C1 on the live registration: every contract on chain equals the signed JSON (44/44). |
| `rehearsal-scratch-record.json` | The scratch registration of the same JSON under a throwaway deployer, before the live one. |
| `rehearsal-c1.json` | C1 on the scratch set (44/44). |
| `rehearsal-empty-aggregates.json` | Every aggregate query shape the clients use proves 0 on empty data (42/42). |
| `rehearsal-rc1-live.json` | The RC1 consensus vectors against the scratch set (258/258). |
| `rehearsal-mv-live.json` | The mixed-visibility consensus negatives against the scratch set (400/401; the one not run addresses the live forge-community). |
| `rehearsal-fee-probe.json` | The fee gates D-3 and COMM-9 (both within +5 %). |

The contract group (`EXgzBMpwC7RMjSU4WQghLAnfboswsssMGiXRtiV1hmBC`) was verified by `deploy-v2.mjs`
after the last create: owned by the deployer, no admins, all four contracts enrolled. `dg doctor
--network testnet` re-checks enrolment from a proof.

## forge-meta update to version 2: the passkey vault (2026-10-26)

forge-meta was updated in place to add the `vaultEntry` document type (UPDATE-2, `passkey_vault`,
#605). That is one `DataContractUpdate` (same id, same group) of 7755 B signed by the deployer at
identity nonce 2, costing 0.390410 tDASH. The other three contracts are unchanged. It is recorded in
`forge-contracts/deployments/testnet.json` (`forgeMeta.updates`, `v2.nonceLedger`).

| File | What it shows |
|---|---|
| `update-meta-v2.sha256` | The sums of the set the update was run against (`--expect-sha256`): only forge-meta's differs from `signed-sums.sha256`. |
| `rehearsal-scratch-record.json` | Now also records the same update applied to the scratch set first (`forgeMeta.updates`). |

Before the live update, the scratch set's forge-meta was updated with the same bytes. Then
`forge-web/lib/auth/passkey-vault.live.test.ts` ran against it with the testnet RELAY identity. A
group-bound limited key registered for a fresh browser wrote two `vaultEntry` documents (a type the
contract gained after the key was bound to the group), a fresh device signed in with the passkey
alone, then the test re-sealed one entry and deleted both. The same test then passed against the live
set. Fees measured on the live set, in credits: first entry 51,513,300, a later one 33,110,400, a
re-seal 3,143,380; the two deletes refunded 26,654,372 and 37,031,569; the sign-in cost nothing.
