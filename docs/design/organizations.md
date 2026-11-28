# Organizations: a repository owner that is an N-of-M multisig

Status: design, 2026-11-24; revised 2026-11-28 (requests and roster on Platform, §10; follow-up decisions, §11). Testnet only until the owner says go.

## 1. What an organization is

An organization is a Platform identity whose keys are threshold keys: *M* people each hold a share, any *N* of them can sign, and the full key never exists. This is what [multisig.dashhq.org](https://multisig.dashhq.org) (`PastaPastaPasta/dash-threshold-identity`, protocol `dti/1`) creates. To Platform the identity is ordinary: its keys are BLS12-381 keys and a threshold signature verifies as a plain BLS signature (protocol 14 and later).

Forge already separates the two levels of power:

- **Owner**: the identity that owns the `repo` document. Consensus lets only it write `repo` (create, edit listing), `maintainer` and `writer` (grant, revoke, change role), `topic` and `runner`.
- **Maintainer / writer**: identities the owner enrolled. They push, merge, release, change settings, label and triage with their own keys.

So an organization needs no new authorization rule. A repository owned by a threshold identity is an organization repository:

- maintainers and writers work exactly as today, each with their own identity and keys;
- every owner action is a document written by the organization identity, so it needs N of M signatures.

## 2. Which actions need N of M

| Action | Documents (signed by the org identity) |
|---|---|
| Create a repository | `repo`, the org's own `maintainer`, first `config` (three transitions, one request) |
| Give, change or remove access | `maintainer` / `writer` create or delete (the member's `consent` comes first, as today) |
| Edit the repository listing | `repo` replace (description, display name, topics, language, `renamedTo`) |
| Organization profile | `profile` create or replace |
| Topics, CI runners | `topic`, `runner` create or delete |

Everything else (push, protected branches, config, releases, policy, webhooks, labels, issues, PRs, reviews) stays with maintainers and writers and needs one ordinary signature.

Changing the organization's own members or threshold, withdrawing credits and rotating keys are identity operations. They stay in multisig.dashhq.org; Forge links there. Topping up the organization's credits needs no group signature: anyone can top up any identity.

Out of scope for v1: private repositories owned by an organization (member changes there re-wrap repo keys), and moving an existing personal repository to an organization (Platform documents cannot change owner; the personal repo can point at the new one with `renamedTo`).

## 3. Registering and detecting an organization

No on-chain field says "this identity is a multisig", so Forge uses three signals, strongest first:

1. **Connected.** A member connects the organization in Forge by pasting its group invite (group id and relay) from multisig.dashhq.org. Forge reads the group's public message log, verifies the key ceremony the same way `dti` does, and checks that the identity's on-chain keys are that ceremony's group keys. This proves N, M and the member list to that member.
2. **Declared.** The organization identity publishes a `profile` whose `links` hold `https://multisig.dashhq.org/?network=<network>#org=<N>of<M>`. The profile is itself a threshold-signed document, so N of M members made the claim. Every visitor then sees "Organization · N of M".
3. **Detected.** An identity whose enabled authentication keys are all BLS12-381 is shown as "Multisig" with no N or M. Forge never creates such identities for individuals.

Creating the organization (key ceremony, funding, identity) is done in multisig.dashhq.org. Forge's "New organization" explains the three steps and links there, then offers **Connect organization**.

## 4. Partially signed actions

Forge reuses `dti/1` as is: a group is an append-only log of Ed25519-signed envelopes on an untrusted relay. A proposal carries the unsigned transition and the bytes to sign; each `approve` carries one BLS signature share; any *N* valid shares combine into the identity's signature.

**Create.** A member starts an owner action in Forge as they would for a personal repo. Because the owner is an organization, Forge builds the unsigned transition(s) with the organization as owner and its HIGH authentication key as signer, and posts them as `proposal` envelopes. A multi-document action (create repository) is several proposals, tied together by a `note` of the form `{"forge":1,"group":"<id>","seq":i,"of":k,"title":"…"}`. Forge calls the whole thing a **request**: one member's proposals sharing a group (someone else reusing the group makes a separate request, `<group>-<first 16 hex of their key>`; the plain id goes to the earliest proposal by a participant of the organization's ceremony that the room accepted and that asks for the organization's key alone). Each write takes the lowest identity-contract nonce above the identity's current one that no request holds. A proposal holds its nonce when a participant of the organization's ceremony made it, the room accepted it and it writes as the organization, whatever its request's status; two parts of one request never share a nonce on a contract; Platform accepts nonces out of order up to 24 ahead (23 on a contract the identity never wrote to), so one request's far nonce blocks nothing.

**Review.** A signer's client never trusts the proposal's description. It decodes the transition bytes and checks:

- the owner is the organization and the signing key is its group key, enabled on chain;
- the contract is one of this network's Forge contracts, and there is exactly one document transition;
- the bytes to sign are the signable bytes of that decoded transition;
- the nonce has not been used, and the fee increase is zero.

It then describes the action from the decoded content ("Give `alice.dash` Maintain access to `acme/widgets`"). A document type or action Forge does not recognise is shown as unrecognised and Forge refuses to sign it.

**Sign.** Signing needs the member's multisig seed phrase, because the share is derived from it and the ceremony's messages. The web app asks for it once per tab and keeps it in memory only; `dg` reads it from `--phrase-file`, `DG_ORG_PHRASE`, or a hidden prompt. Nothing secret is stored.

**Broadcast.** The signature that completes the threshold also finishes the job: that client combines the shares, checks the result against the group key, broadcasts the transitions in nonce order, confirms each with a proved read and posts `broadcast`. If it fails midway, any member (or `dg org finish`) can resume; BLS signatures are deterministic, so a rebroadcast is the same transition.

**Decline.** A member can decline a request (`reject`). Declines do not block; a request that will never reach N simply stays open and can be dismissed locally. While it is still collecting (no part ready or executed), once more than M−N members decline it without having approved it, it no longer holds its nonces. A request whose nonce was overtaken is shown as expired.

Requests made in Forge are visible in multisig.dashhq.org as proposals, and its members can see shares arrive there.

## 5. Coordination and notifications

- **Web.** The header shows a count of requests waiting for the signed-in user's signature across their connected organizations. The inbox gets a "Needs your signature" section. The organization page lists open requests, each with one primary action: **Sign (1 of 2 collected)**, then **Done** once broadcast. Who signed is one click away; raw bytes are collapsed.
- **dg.** `dg org list`, `dg org requests`, `dg org show <request>`, `dg org sign <request>`, `dg org decline <request>`, `dg org finish <request>`. `dg status` prints one line when requests are waiting. Owner commands (`dg repo create --owner <org>`, `dg collab add|remove` on an org repo) create a request and print what to send to co-signers.
- **Telling the others.** Every request has a link (`/org?id=<org>&request=<id>`). After creating one, Forge shows "Send this to your co-signers" with copy and share buttons. Members who have connected the organization also see the badge without being told, because every client polls Platform for the organization's messages (§10).
- **Which device knows.** A client remembers, per organization, the group id, the relay and the member's public auth key. Those are public values, so the badge works without unlocking the seed phrase.

Requests, approvals, declines and broadcast records are on Platform (§10). The relay (multisig.dashhq.org by default, any `dti relay serve` otherwise) is read only for the key ceremony, and it can withhold messages but cannot forge them.

## 6. Contract changes

Revised 2026-11-28 (owner: "it should live on platform"). Requests, signature shares and the roster live on Platform, in three new forge-meta document types added by an in-place update (UPDATE-4, §10). Nothing existing changes: no existing type, index or rule is touched, so every repository, ref, issue and pull request reads exactly as before. The relay at multisig.dashhq.org keeps only what it was made for, the key ceremony that created the organization's identity; Forge reads that once per device (§10.4).

Testnet gets the update first. Mainnet gets it only on the owner's go (its cost is reported with the PR); until then the mainnet gate (§7) keeps every organization feature off there.

## 7. Gating

Organizations are on for every network except mainnet (`orgsEnabled(network)` in forge-web, `org::enabled` in `dg`). On mainnet the pages, commands and badge are absent and an organization-owned repository reads as any other repository.

## 8. Implementation outline

- `forge-core::org` (Rust): `dti/1` envelopes, canonical JSON, room state (ceremony verification, proposals, shares), seed derivation, share recovery, BLS share signing and combination, relay client, unsigned transition build and decode. Checked against vectors generated by `dti` itself.
- `forge-web/lib/org`: the same in TypeScript on `@noble/curves`, sharing the vectors.
- `dg org …` and the owner-command routing; web organization page, connect flow, unlock dialog, inbox section and header badge.

## 9. Wire conventions (both clients must agree)

Protocol reference: `dash-threshold-identity` `docs/PROTOCOL.md` and `src/{util,envelope,derive,bls,ceremony,state,participant}.mjs`. Forge implements the reading and signing side only (no key ceremony): envelope verification, the `reduce` state function restricted to what a completed ceremony and its proposals need, share recovery (`recoverShares`), `approve`, `reject`, `combine` and `broadcast`.

**Local record of a connected organization** (public values only): `{ network, orgId, room, relay, authPub, label, threshold, members }`. Web: `localStorage` key `forge:orgs:<network>`. dg: `orgs.json` beside its config.

**Which identity a group controls.** Take the completed ceremony's slot with purpose `AUTHENTICATION` and security level `HIGH` (the default layout's `high`, key id 2). The organization is the identity that holds that group public key (lookup by public key hash, then check the key id, type `BLS12_381`, and that it is enabled). A room with several completed ceremonies uses the newest one whose key is enabled on an identity.

**Proposal body** (a standard `dti/1` `proposal`):

- `network`: Forge's network name (`testnet`, `mainnet`, `devnet-<name>`).
- `unsigned`: hex of the serialized state transition with `signaturePublicKeyId` set to the group key's id and an empty signature.
- `signable`: hex of its signable bytes.
- `requirements`: `[{ cid, slot }]` for the slot above.
- `intent`: a `dti` `document` intent describing the same write (`type`, `userFeeIncrease: 0`, `ownerId`, `contractId`, `identityContractNonce`, `document: { action, documentType, properties?, entropy?, id?, revision? }`, `signer: { keyId, cid, slot }`), with byte values as hex strings. Forge clients do not read it back; they decode `unsigned`.
- `derived`: `{ documentId }`.
- `note`: `{"forge":1,"group":"<16 hex>","seq":<0-based>,"of":<count>,"title":"<at most 120 characters>"}` as a JSON string.

**Request.** One proposer's proposals sharing a `note.group`, ordered by `seq`, among the proposals that ask for the organization's ceremony. Its id is the group value when its earliest proposal (by `at`, then proposer key) is the earliest in the group among proposals the room accepted, made by a participant of the organization's ceremony and asking for its key alone; any other proposer's request with that group gets `<group>-<first 16 hex of the proposer's key>`. It is whole only when its parts are exactly `seq` 0 to `of`−1 with one `of`. A proposal without a Forge note is a request of its own, with the proposal id as request id, shown as "Made outside Forge" and signable only when its decoded transition passes the review below.

**Review before signing** (every proposal of the request; all must pass):

1. `unsigned` decodes to a documents batch with exactly one document transition, owner = the organization, `signaturePublicKeyId` = the group key id, `userFeeIncrease` = 0.
2. The signable bytes of the decoded transition equal `signable`.
3. The data contract is one of this network's Forge contracts.
4. The identity-contract nonce is above the current one.
5. The (document type, action) pair is one Forge recognises: `repo` create/replace, `maintainer` create/delete, `writer` create/delete, `config` create, `profile` create/replace, `topic` create/delete, `runner` create/delete. A delete is described from the stored document (proved read).

**Request status.** `collecting` (fewer than N valid shares on some proposal), `ready`, `done` (every proposal has a member's `broadcast` with `ok: true` and its nonce is spent, or its document write is visible on chain: a broadcast record whose nonce is still free is a claim, and Finish broadcasts it), `expired` (a proposal's nonce is spent, Platform's skipped-nonce window included, and its write is not on chain), `declined` (still collecting, but more members declined it without approving than M−N, so the rest cannot reach the threshold; nobody can sign it any more. Checked before `done` and `expired`: its nonces are free, and a later request may spend them), `invalid`.

**Signing a request** posts one `approve` per proposal the member has not approved. If that makes the request `ready`, the same client finishes it.

**Finishing.** For each proposal in `seq` order that is `ready` and not broadcast: combine the N lowest-index valid shares, verify against the group key, set the transition's signature to the 96 signature bytes, broadcast, confirm with a proved read, post `broadcast` with `{ proposalId, result: { ok: true, confirmed: true } }` (or `{ ok: false, error }`).

**Creating a request** also signs it with the creator's share, so a new request starts at "1 of N".

**Same bytes from both clients.** A transition is built the way evo-sdk builds it: document base transition version 1, identifier and byte properties as plain byte arrays, integers as 64-bit. forge-web and dg then produce identical bytes for the same write; `forge-contracts/fixtures/org/web-built.json` holds transitions forge-web built on testnet, and dg's tests rebuild them byte for byte.

**multisig.dashhq.org's own review.** `dti review` rebuilds each proposal from its intent and requires identical bytes. Checked on testnet (2026-11-24): it passes a repository create, a `maintainer` or `writer` delete and other writes whose properties are text and numbers, whether forge-web or dg made them. It refuses writes that carry an identifier property (`maintainer`/`writer`/`config` create): a `dti` intent has no byte type, so its rebuild turns `repoId` and `memberId` into text. Members sign those in Forge; making them reviewable in multisig.dashhq.org needs a byte encoding for `dti` intents.

Shared test vector: `forge-contracts/fixtures/org/dti-2of3.json` (three members with their test phrases, the ceremony messages, proposals, approvals, the expected states and the combined signature).

## 10. On Platform (forge-meta UPDATE-4)

This section supersedes the relay transport of §4, §5 and §9 for Forge requests. Everything else in §9 (proposal bodies, review, nonces, status, finishing, byte parity) is unchanged: the same `dti/1` envelopes, carried in Platform documents instead of the relay room.

### 10.1 Document types (forge-meta, flag `orgs`)

| Type | Owner | Properties | Mutable / deletable | Indices |
|---|---|---|---|---|
| `orgMember` | a member's own Forge identity | `org` identifier; `room` string (the dti group id, ≤ 64); `authPub` bytes 32 (the member's dti auth key); `proof` bytes 64 | no / yes (a member unlinks) | `byOrg` (`org`, `$ownerId`) unique; `byOwner` (`$ownerId`, `org`) |
| `org` | the organization (N of M) | `room` string ≤ 64; `cid` bytes 32 (ceremony id); `threshold` integer 2–64; `members` byte array 64–2048 (the ceremony participants' auth keys, 32 bytes each, in participant index order) | yes / yes | `owner` (`$ownerId`) unique |
| `orgMessage` | a member's own Forge identity | `org` identifier; `env` byte array 1–5120 (one `dti/1` envelope, its canonical JSON as UTF-8) | no / no | `log` (`org`, `$ownerId`, `$createdAt`) |

`$createdAt` is required on all three. No `refersTo` and no rule reads them, so no existing write is affected.

- **`orgMember` proof**: Ed25519 by `authPub` over the UTF-8 bytes of `dash-forge/org-member/1\n<network>\n<org base58>\n<$ownerId base58>`. It binds one Forge identity to one participant key; a member may bind several identities. Nothing secret is on chain.
- **`org`** is the public roster, written by the organization through a request (the "Publish organization" request, §10.5). Visitors use it to show "Organization · N of M" and the member list (each `orgMember` whose proof verifies against a key in `members`).
- **`orgMessage`** carries `proposal`, `approve`, `reject` and `broadcast` envelopes only; other types are ignored. Documents are never edited or deleted, so the log is also the public record of who approved what.

### 10.2 Reading an organization's log

1. **Members.** The participants of the ceremony the organization's key comes from (§9 "Which identity a group controls"), read from the ceremony transcript (§10.4).
2. **Member identities.** `orgMember` documents with `org` = the organization whose `authPub` is a participant and whose `proof` verifies.
3. **Messages.** For each member identity, `orgMessage` documents by `log` (`org`, that `$ownerId`), paged by `$createdAt`. Documents owned by anyone else are never read, so a stranger cannot flood the log.
4. **State.** Each `env` must be canonical JSON, verify as a `dti/1` envelope and name the organization's room. The ceremony messages and these envelopes together go through the same `reduce` as before. The same envelope posted twice counts once.
5. **Time.** A message's time is the earliest `$createdAt` of the documents carrying it (Platform's block time). It replaces the envelope's own `at` wherever order decides something (the request id claim, §11.5), so nobody can backdate.

### 10.3 Writing

Posting a request, a signature, a decline or a broadcast record is one `orgMessage` create by the member's own signed-in Forge identity, with its ordinary key (fees from that identity: about 0.0005–0.002 DASH per message by size). The organization pays only for its own writes when a request finishes. A member therefore needs a Forge identity on that network; connecting writes their `orgMember` document once.

### 10.4 The key ceremony

Share recovery needs the ceremony's messages (about 20 KB for 2 of 3). Forge reads them from the relay when a member connects the organization on a device, verifies them as before, and keeps them locally (dg: beside `orgs.json`; web: browser storage). They are public and encrypted to each member, so keeping them is safe. Later signing on that device needs only Platform. The relay is the identity's own home (multisig.dashhq.org made it); changing members or keys stays there.

### 10.5 Connecting and the inbox

- **Connect** (web `/org`, `dg org connect <group id or invite>`): unlock the phrase, verify the ceremony and the identity's keys (§3), write `orgMember` if this identity has none for the organization.
- **Inbox by identity.** A signed-in member's organizations are their `orgMember` documents (`byOwner`), on any device. The ceremony is fetched from the relay the first time a device signs.
- **Publish organization** (web: the organization page; `dg org publish <org>`): one request with two writes, the `org` roster and the organization's `profile` with the declared link (§3) added to its links (other profile fields kept). Signers check that both match the bound ceremony exactly (room, ceremony id, N, the members in order, the link's N and M) and refuse otherwise.

### 10.6 Migration from the relay

Requests made before UPDATE-4 live in the relay room. `dg org migrate <org>` copies every Forge envelope of the room's open requests (their proposals, approvals, declines and broadcast records) to Platform as `orgMessage` documents owned by the member running it; envelopes carry their own signatures, so who made each one is unchanged. Finished requests stay readable in multisig.dashhq.org. After UPDATE-4 Forge reads and writes requests only on Platform; requests made in the multisig app itself are not shown in Forge.

## 11. Follow-up decisions (2026-11-28)

1. **Refused requests.** When review finds problems, both clients say "Forge won't sign this: <reasons>" and offer the one next step, Decline. dg reports it with its own error code (not E204 "invalid configuration", and no `dg doctor` hint).
2. **Phrase box.** The organization phrase is masked as typed, with a Show button to reveal it.
3. **One wording.** Status `declined`: "Declined: too many members declined it to reach N of M." Status `invalid` (it does not form a request, or review found problems): "Forge won't sign this: <reasons>." Both clients take the review into the status the same way: structural problems and review problems give `invalid`, which wins over `declined`.
4. **Member changes mid-request.** Signing and finishing re-run the creation checks for member changes (a repository that now has members-only content or environments is refused: "<repo> now has members-only content or environments, so an organization can't change its members; decline this request").
5. **Backdated ids.** The plain request id goes to the earliest claim by Platform time (§10.2 step 5), never the envelope's `at`. If two members' claims share the same block time, neither gets the plain id and both use `<group>-<first 16 hex of the key>`.
6. **Executed once its nonce is spent.** Kept, because the nonce is the organization's own, and only its requests spend it: Forge clients never give two open requests the same nonce, and a create later deleted or a replace later superseded would otherwise read as never done. Narrowed: a part whose nonce another request's part is known to have landed with is `expired`, not `done`.
