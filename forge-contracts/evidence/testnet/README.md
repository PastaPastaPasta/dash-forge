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

## forge-meta update to version 3: boards (2026-10-27)

forge-meta was updated in place to add the `board` and `card` document types (UPDATE-3, the flag `boards`,
[docs/design/boards.md](../../../docs/design/boards.md) §3), nothing else: the new forge-meta.json
differs from version 2's only by the two added types (every other type, `schemaDefs`, the config and
the description are equal), and `contract-validate --expect-update` accepts it as an update of
version 2 (`ALLOWED`). The update is one `DataContractUpdate` of 10,913 B (the contract is
10,842 B), signed by the deployer at contract nonce 3 (gitCommit `7562a74e`), costing
0.461175 tDASH (46,117,488,830 credits): a contract update pays the whole contract's registration
fee again (10 types and 16 indexes). The other three contracts are unchanged. It is recorded in
`forge-contracts/deployments/testnet.json` (`forgeMeta.updates`, `v2.nonceLedger`), and the web
snapshot (`deployments/contracts/testnet.json`) was refreshed at protocol 14 right after it.

| File | What it shows |
|---|---|
| `update-meta-v3.sha256` | The sums of the set the update was run against (`--expect-sha256`): only forge-meta's differs from `update-meta-v2.sha256`. |
| `c1-v3.json` | C1 on the live set after the update: every contract on chain equals the signed JSON, forge-meta at version 3 (44/44). |
| `rehearsal-scratch-record.json` | The update applied to the scratch set (`forgeMeta.updates`, version 3: contract nonce 3, 10,913 B, 0.461175 tDASH). The record's top-level `sizeBytes` and `roomBytes` stay the registration's (6,976 B); the contract is now 10,842 B, about 9.6 KB under the transition limit. |
| `rehearsal-c1-v3.json` | C1 on the scratch set after the update: every contract on chain equals the signed JSON, forge-meta at version 3 (44/44). |

**The scratch rehearsal.** The scratch set's forge-meta (`8qj74sQt…`) was updated to version 3
with the same bytes. The first run's version check read a node that had not applied the block yet
(it still proved version 2) and stopped with the update recorded as pending; the update had
landed, and rerunning the same command completed the record. `deploy-v2.mjs` now reads the version
again for a few seconds, both after a broadcast and before rebroadcasting a pending update.

Then `forge-web/lib/repo/boards.live.test.ts` passed three times against the scratch set
(`FORGE_BOARDS_RECORD` names its record), with the testnet QA identities OWNER (the repository's
owner), CONTRIB (granted triage) and TREASURY (a stranger). It ran the web's data layer end to end
in a throwaway repository: a board created, renamed, closed (a card write then refused before
signing), reopened, and a second one deleted; cards placed, moved with a rank, given field values
and archived; the triage member placing a card. `readBoards`, `readBoard`, `readCardsSince`,
`readItemCards` and the fold agreed with what was written. Consensus refused, each paying only a
processing fee:

- a stranger's card and board: the member gate (40120);
- a board signed by the triage member: its writer document's role is not the claimed `r` (40127);
- the triage member's replace of its own card after the owner removed it: the gate is checked
  again on a replace (40120);
- a member's card naming the repository document instead of an issue or PR: `card.item`'s
  reference (40120).

Fees the live test measured on the scratch set, in credits (three runs):

| Write | Credits |
|---|---|
| A board with the Kanban template's definition (738 B): a repository's first | 62,769,780 to 63,818,180 |
| A repository's later board | 53,713,440 to 54,681,460 |
| A board's rename / close / reopen / delete (replaces) | 3,379,880 to 4,628,500 |
| A card for an item another member has a card for | 42,757,600 to 43,197,820 |
| An item's first card | 70,513,480 to 70,860,620 |
| A board's first card (also the item's first) | 88,333,520 to 89,120,880 |
| A card's move / field change / archive (replaces) | 4,157,662 to 5,209,102 |
| A refused write (stranger, removed member, card naming no issue or PR) | 1,628,280 to 1,980,780 |

**The live set.** After the scratch rehearsal the live forge-meta (`6arQJW8y…`) was updated with the
same bytes; C1 passed 44/44 (`c1-v3.json`). `boards.live.test.ts` then passed against the live set
(a throwaway `boards-live-*` repository of OWNER, the same identities), every refusal above
included. Its fees fell within the scratch set's ranges, in credits: a repository's first board
62,924,580, a later one 53,868,240; board replaces 3,534,680 to 4,077,560; a board's first card
88,488,320; a card for an item another member has one for 42,912,400; card replaces 4,312,462 to
4,689,622; refused writes 1,641,280 to 2,135,580. Two writes paid more than on the scratch set, for
a reason not established here: the triage member's first card (the item's first) 79,191,280
(70.5M-70.9M there; still under its preview with the contract-nonce surcharge, 88.5M), and the
stranger's first refused card 10,257,440 (its refused board right after it paid 1,641,280).
