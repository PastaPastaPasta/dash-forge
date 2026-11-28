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

**Create.** A member starts an owner action in Forge as they would for a personal repo. Because the owner is an organization, Forge builds the unsigned transition(s) with the organization as owner and its HIGH authentication key as signer, and posts them as `proposal` envelopes. A multi-document action (create repository) is several proposals, tied together by a `note` of the form `{"forge":1,"group":"<id>","seq":i,"of":k,"title":"…"}`. Forge calls the whole thing a **request**: one member's proposals sharing a group. Its id is `<group>-<first 16 hex of the proposer's key>`, so someone else reusing the group makes a separate request with its own id; a bare group id resolves when exactly one proposer used it (§11.5). Each write takes the lowest identity-contract nonce above the identity's current one that no request holds. A proposal holds its nonce when a participant of the organization's ceremony made it, the room accepted it and it writes as the organization, whatever its request's status; two parts of one request never share a nonce on a contract; Platform accepts nonces out of order up to 24 ahead (23 on a contract the identity never wrote to), so one request's far nonce blocks nothing.

**Review.** A signer's client never trusts the proposal's description. It decodes the transition bytes and checks:

- the owner is the organization and the signing key is its group key, enabled on chain;
- the contract is one of this network's Forge contracts, and there is exactly one document transition;
- the bytes to sign are the signable bytes of that decoded transition;
- the nonce has not been used, and the fee increase is zero.

It then describes the action from the decoded content ("Give `alice.dash` Maintain access to `acme/widgets`"). A document type or action Forge does not recognise is shown as unrecognised and Forge refuses to sign it.

**Sign.** Signing needs the member's multisig seed phrase, because the share is derived from it and the ceremony's messages. The web app asks for it once per tab and keeps it in memory only; `dg` reads it from `--phrase-file`, `DG_ORG_PHRASE`, or a hidden prompt. Nothing secret is stored.

**Broadcast.** The signature that completes the threshold also finishes the job: that client combines the shares, checks the result against the group key, broadcasts the transitions in nonce order, confirms each with a proved read and posts `broadcast`. If it fails midway, any member (or `dg org finish`) can resume; BLS signatures are deterministic, so a rebroadcast is the same transition.

**Decline.** A member can decline a request (`reject`). Declines do not block; a request that will never reach N simply stays open and can be dismissed locally. While it is still collecting (no part ready or executed), once more than M−N members decline it without having approved it, it no longer holds its nonces. A request whose nonce was overtaken is shown as expired.

Requests live on Platform (§10); multisig.dashhq.org does not show them.

## 5. Coordination and notifications

- **Web.** The header shows a count of requests waiting for the signed-in user's signature across their connected organizations. The inbox gets a "Needs your signature" section. The organization page lists open requests, each with one primary action: **Sign (1 of 2 collected)**, then **Done** once broadcast. Who signed is one click away; raw bytes are collapsed.
- **dg.** `dg org list`, `dg org requests`, `dg org show <request>`, `dg org sign <request>`, `dg org decline <request>`, `dg org finish <request>`. `dg status` prints one line when requests are waiting. Owner commands (`dg repo create --owner <org>`, `dg collab add|remove` on an org repo) create a request and print what to send to co-signers.
- **Telling the others.** Every request has a link (`/org?id=<org>&request=<id>`). After creating one, Forge shows "Send this to your co-signers" with copy and share buttons. Members who have connected the organization also see the badge without being told, because every client polls Platform for the organization's messages (§10).
- **Which device knows.** A client remembers, per organization, the group id, the relay and the member's public auth key. Those are public values, so the badge works without unlocking the seed phrase.

Requests, approvals, declines and broadcast records are on Platform (§10). The relay (multisig.dashhq.org by default, any `dti relay serve` otherwise) is read only for the key ceremony, and it can withhold messages but cannot forge them.

## 6. Contract changes

Revised 2026-11-28 (owner: "it should live on platform"). Requests, signature shares and the roster live on Platform, in a new contract, `forge-org`, registered in Forge's existing contract group (§10). No existing contract is changed: forge-core, forge-collab, forge-community, forge-meta and forge-user keep their bytes, so every repository, ref, issue and pull request reads exactly as before. A separate contract was chosen over another forge-meta update because it costs one registration (about 0.2 DASH) instead of repaying forge-meta's whole fee now and on every later forge-meta update, and because it leaves the live mainnet contracts untouched (forge-user set the precedent).

The relay at multisig.dashhq.org keeps only the key ceremony that created the organization's identity. Once the organization has published its roster (§10.5), members sign from Platform alone.

Testnet gets `forge-org` first. Mainnet gets it only on the owner's go; until then the mainnet gate (§7) keeps every organization feature off there.

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

**Request.** One proposer's proposals sharing a `note.group`, ordered by `seq`, among the proposals that ask for the organization's ceremony. Its id is `<group>-<first 16 hex of the proposer's key>`, for every proposer; a bare group id resolves to the request when exactly one proposer used that group (§11.5). It is whole only when its parts are exactly `seq` 0 to `of`−1 with one `of`. A proposal without a Forge note is a request of its own, with the proposal id as request id, shown as "Made outside Forge" and signable only when its decoded transition passes the review below.

**Review before signing** (every proposal of the request; all must pass):

1. `unsigned` decodes to a documents batch with exactly one document transition, owner = the organization, `signaturePublicKeyId` = the group key id, `userFeeIncrease` = 0.
2. The signable bytes of the decoded transition equal `signable`.
3. The data contract is one of this network's Forge contracts.
4. The identity-contract nonce is above the current one.
5. The (document type, action) pair is one Forge recognises: `org` create/replace (`forge-org`, §10.5), `repo` create/replace, `maintainer` create/delete, `writer` create/delete, `config` create, `profile` create/replace, `topic` create/delete, `runner` create/delete. A delete is described from the stored document (proved read).

**Request status** (as amended by §11.6). `collecting` (fewer than N valid shares on some proposal), `ready`, `done` (every part's write is visible on chain as §11.6 defines it; a broadcast record whose nonce is still free is a claim, and Finish broadcasts it), `expired` (a part's nonce is spent, Platform's skipped-nonce window included, and its write is not on chain; or, for a replace, its document is past its revision without this part's nonce spent and a member's claim, so it can never land: that part no longer holds its nonce; or, for a delete, its document is gone without both this part's nonce spent and a member's claim, so it can never land), `declined` (still collecting, but more members declined it without approving than M−N, so the rest cannot reach the threshold; nobody can sign it any more. Checked before `done` and `expired`: its nonces are free, and a later request may spend them), `invalid`.

**Signing a request** posts one `approve` per proposal the member has not approved. If that makes the request `ready`, the same client finishes it.

**Finishing.** For each proposal in `seq` order that is `ready` and not broadcast: combine the N lowest-index valid shares, verify against the group key, set the transition's signature to the 96 signature bytes, broadcast, confirm with a proved read, post `broadcast` with `{ proposalId, result: { ok: true, confirmed: true } }` (or `{ ok: false, error }`).

**Creating a request** also signs it with the creator's share, so a new request starts at "1 of N".

**Same bytes from both clients.** A transition is built the way evo-sdk builds it: document base transition version 1, identifier and byte properties as plain byte arrays, integers as 64-bit. What is proven, for every write Forge signs (`repo` create and replace, `maintainer`, `writer`, `topic` and `runner` create and delete, `config` create, `profile` create and replace, which covers repository creation, member changes, role changes, listing edits, topics, runners and profiles):

- forge-web's builder (`lib/org/transition.ts`) gives byte-identical unsigned bytes and bytes to sign under evo-sdk 5.0.3 and Forge's pin (5.1.0), and each SDK decodes and re-encodes the other's bytes, unsigned and signed, to the same bytes (`tools/org-vectors`, CI job `org-vectors`).
- The bytes do not depend on the protocol version: 5.1.0 builds the same bytes at protocol 14 (mainnet) and 15 (testnet). evo-sdk 5.0.3 does not know protocol 15: it builds the same bytes for every delete and replace at it, and refuses to build a create at it ("unknown platform version: 15").
- dg (forge-core `platform::org`) rebuilds every one of them byte for byte from its intent, at protocols 14 and 15, and produces the same intent `document`.

The vectors are `forge-contracts/fixtures/org/cross-sdk.json` (regenerate with `npm run update` in `tools/org-vectors`) and `forge-contracts/fixtures/org/web-built.json` (transitions forge-web built on testnet); forge-core's `rebuilds_forge_web_transitions_byte_for_byte` reads both.

**multisig.dashhq.org's own review** (historical: since §10, Forge requests are no longer posted there). `dti review` rebuilds each proposal from its intent and requires identical bytes, bytes to sign and `derived`. The live site serves dash-threshold-identity 6ab3c47 (evo-sdk 5.1.0, page hash checked 2026-11-28), so both apps now run the same SDK; 0cf86d3 (evo-sdk 5.0.3) gives the same results. Recorded per vector in `cross-sdk.json` (`dtiReview`, from `tools/org-vectors/cross-sdk/dti-review.mjs`):

| Write | `dti review` |
|---|---|
| `repo` create, `profile` create | passes |
| `maintainer`, `writer`, `topic`, `runner` delete | passes |
| `repo` replace, `profile` replace | same bytes, but refused: its rebuild derives `{ documentId, newRevision }` and Forge's `derived` is `{ documentId }` |
| `maintainer`, `writer`, `config`, `topic`, `runner` create | refused: a `dti` intent has no byte type, so its rebuild turns `repoId`, `memberId` and `consentBy` into text |

Members sign the refused ones in Forge. Making identifier writes reviewable in multisig.dashhq.org needs a byte encoding for `dti` intents; making replaces reviewable needs only `newRevision` in Forge's `derived`.

Shared test vector: `forge-contracts/fixtures/org/dti-2of3.json` (three members with their test phrases, the ceremony messages, proposals, approvals, the expected states and the combined signature).

## 10. On Platform (the `forge-org` contract)

This section supersedes the relay transport of §4, §5 and §9 for Forge requests. Everything else in §9 (proposal bodies, review, nonces, status as amended by §11, finishing, byte parity) is unchanged: the same `dti/1` envelopes, carried in Platform documents instead of the relay room. Forge requests are no longer visible in multisig.dashhq.org, and requests made there are not shown in Forge.

### 10.1 Document types (`forge-org`, in Forge's contract group)

| Type | Owner | Properties | Mutable / deletable | Indices |
|---|---|---|---|---|
| `orgMember` | a member's own Forge identity | `org` identifier; `room` string ≤ 64 (the dti group id); `authPub` bytes 32 (the member's dti auth key); `proof` bytes 64 | no / no | `byOrg` (`org`, `$ownerId`, `authPub`) unique; `byKey` (`org`, `authPub`, `$createdAt`); `byOwner` (`$ownerId`, `org`) |
| `orgShare` | a member's own Forge identity | `org` identifier; `cid` bytes 32 (the ceremony it is a share of); `sealed` byte array 1–128 | no / no | `byCeremony` (`org`, `$ownerId`, `cid`) unique |
| `org` | the organization (N of M) | `room` string ≤ 64; `relay` string ≤ 200, optional; `cid` bytes 32 (ceremony id); `keyId` integer; `groupKey` bytes 48; `threshold` integer 2–64; `members` byte array 64–2048 (participants' auth keys, 32 bytes each, by participant index); `pubShares` byte array 96–3072 (participants' public key shares of `groupKey`, 48 bytes each, same order) | yes / no | `owner` (`$ownerId`) unique |
| `orgMessage` | a member's own Forge identity | `org` identifier; `digest` bytes 32; `part` integer 0–15; `parts` integer 1–16; `fmt` integer 0–1; `body` byte array 1–5120 | no / no | `log` (`org`, `$ownerId`, `$createdAt`) |

`$createdAt` is required on all four and `$updatedAt` on `org`. No `refersTo` and no rule reads them, so no existing write is affected.

- **`orgMember` proof**: Ed25519 by `authPub` over the UTF-8 bytes of `dash-forge/org-member/1\n<network>\n<org base58>\n<$ownerId base58>`. It binds one Forge identity to one participant key, once per (organization, identity, key): after a ceremony re-run with a new phrase, the same identity binds its new key with another `orgMember`, and readers ignore the binding whose key is no longer in the roster. It is never deleted: leaving is a local action, and the history stays readable.
- **`orgShare`** (`sealed`): the member's secret share of the signing slot, encrypted so only the phrase opens it: XChaCha20-Poly1305 with key HKDF-SHA256(ikm = the member's 64-byte BIP-39 seed, salt = `dash-forge/org-share/1`, info = `<network>\n<org base58>\n<cid hex>`), a random 24-byte nonce, and stored as nonce ‖ ciphertext ‖ tag. That is the same exposure as the ceremony's encrypted shares on the relay. With it, a member signs on any device from the phrase and Platform alone. It is a separate type, one per (member identity, ceremony), so after the organization re-runs its ceremony each member writes a new one.
- **`org`** is the public roster, written by the organization through the "Publish organization" request (§10.5). Readers trust it only while `groupKey` is the organization's enabled key `keyId` (AUTHENTICATION, HIGH, BLS12_381); otherwise it is stale and ignored.
- **`orgMessage`**: one `dti/1` envelope (`proposal`, `approve`, `reject` or `broadcast`; other types are ignored), as canonical JSON UTF-8, deflate-raw compressed when `fmt` = 1, split into `parts` documents of at most 5,120 bytes that share `digest` = SHA-256 of the whole stored payload. A message counts when every part from the same owner is present and the digest matches. Documents are never edited or deleted, so the log is also the public record of who approved what.

### 10.2 Reading an organization's log

1. **Roster.** The organization's `org` document when it is current (above); before one is published, the ceremony transcript (§10.4). Both give the members, N, the group key and the public shares that `reduce` needs.
2. **Member identities.** For each member's `authPub`, `orgMember` documents read by `byKey` (`org`, that `authPub`), earliest `$createdAt` first. A document counts only when its `authPub` is in the roster and its `proof` verifies; both are checked before the cap, so documents that fail are skipped and paging continues past them. The first 4 that count are that key's identities. A reader scans at most 1,000 documents per key and stops there. That is an accepted risk with a cost bound: hiding a member's binding past it takes about 1,000 paid documents written before it, each by a separate identity (`byOrg` allows one per identity and key). A member's own client always finds its own binding through `byOwner`.
3. **Messages.** For each member identity, `orgMessage` documents by `log` (`org`, that `$ownerId`), paged by `$createdAt`. Documents owned by anyone else are never read, so a stranger cannot flood the log. Only identities bound to keys in the current roster are read: after a ceremony re-run, a participant who left is not read, and requests of an older ceremony cannot be signed anyway (they ask for the old key), so their history is shown only from the relay or multisig.dashhq.org.
4. **State.** Each envelope must be canonical JSON, verify as a `dti/1` envelope and name the organization's room. Envelopes from all members' logs are merged, deduplicated by envelope id, ordered by (earliest `$createdAt` of the documents carrying it, envelope id), and go through the same `reduce` as before.

### 10.3 Writing

Posting a request, a signature, a decline or a broadcast record is one `orgMessage` (one document per part) created by the member's own signed-in Forge identity, with its ordinary key. Measured on testnet (2026-11-28, [evidence](../../forge-contracts/evidence/testnet/forge-org-2026-11-28.md)): an approve about 0.0005 DASH, a full 5,120-byte proposal part about 0.0017 DASH, an `orgMember` about 0.0009 and an `orgShare` about 0.0004 (a member's first forge-org write adds about 0.0002 for its contract nonce); never refunded, since the log is permanent. The organization pays only for its own writes when a request finishes. A member therefore needs a Forge identity on that network.

### 10.4 The key ceremony

Before the roster is published, share recovery needs the ceremony's messages from the relay. Forge reads them when a member connects, verifies them as before and keeps them locally (dg: beside `orgs.json`; web: browser storage). Connecting also writes the member's `orgShare` for the ceremony, so from then on that member needs only the phrase and Platform. Changing members or keys stays in multisig.dashhq.org; after a re-run, the organization publishes its roster again, and each member connects again: a new `orgShare` for the new ceremony, and a new `orgMember` if their key changed.

### 10.5 Connecting, the inbox and publishing

- **Connect** (web `/org`, `dg org connect <group id or invite>`): unlock the phrase, verify the ceremony and the identity's keys (§3), write `orgMember` if this identity has none for the organization and this participant key (`authPub`), and `orgShare` if it has none for the ceremony. One identity holds one participant key per ceremony, since `orgShare` is one per (organization, identity, ceremony): clients refuse to connect a second participant key of the same ceremony to an identity that already has a share for it (that seat needs another Forge identity). Before writing either, the client decrypts its own `sealed` value and checks that the recovered share's public key is its public share in the ceremony (and in the roster's `pubShares` when a current roster, one with this ceremony's `cid`, is published); if a check fails it writes neither and says so, since an `orgShare` can never be replaced.
- **Inbox by identity.** A signed-in member's organizations are their `orgMember` documents (`byOwner`), on any device, each organization shown once; an organization where none of the identity's bound keys is in the current roster is shown as needing a new connect.
- **Publish organization** (web: the organization page; `dg org publish <org>`): one request with two writes: the `org` roster, and the organization's `profile` with the declared link (§3) added to its links (other profile fields kept). Signers check that both match the bound ceremony exactly (room, ceremony id, key id, group key, N, the members and public shares in order, the link's N and M) and refuse otherwise. §9's review list gains `org` create/replace in `forge-org`.

### 10.6 Migration from the relay

Requests made before this change live in the relay room. `dg org migrate <org>` copies to Platform only the envelopes the running member made themselves (their proposals, approvals, declines and broadcast records in the room's open requests), so nobody can drop or re-time another member's messages; each member who took part runs it once. Requests nobody migrates can still be finished or declined in multisig.dashhq.org. Clients older than this change keep using the relay: their requests are invisible to new clients and may expire on a reused nonce, which loses no data (an organization write that loses its nonce simply never lands). Organizations are testnet-only, so there is no mainnet cutover.

## 11. Follow-up decisions (2026-11-28)

1. **Refused requests.** When review finds problems, both clients say "Forge won't sign this: <reasons>". dg reports it with its own error code (not E204 "invalid configuration", and no `dg doctor` hint). The next step for a request that can never be valid is a local Dismiss (free); Decline stays for valid requests a member disagrees with.
2. **Phrase box.** The organization phrase is masked as typed, with a Show button to reveal it.
3. **One wording.** Status `declined`: "Declined: too many members declined it to reach N of M." Status `invalid` (it does not form a request, or review found problems): "Forge won't sign this: <reasons>." Both clients take the review into the status the same way: structural problems and review problems give `invalid`, which wins over `declined`.
4. **Member changes mid-request.** Signing and finishing re-run the creation checks for member changes (a repository that now has members-only content or environments is refused: "<repo> now has members-only content or environments, so an organization can't change its members; decline this request").
5. **Backdated ids.** Every request id is `<group>-<first 16 hex of the proposer's key>`, so no member can claim another's id, by time or otherwise. A bare group id still resolves when exactly one proposer used it.
6. **Executed once its nonce is spent.** Narrowed: a member's `broadcast` claim no longer makes a part done by itself. A replace or a delete is done only when its write is visible: a replace's document at its revision with the same fields; a later revision counts only when this part's nonce is spent and a member's `broadcast` claim for it exists, and is `expired` otherwise (§9); a delete only when its document is gone, its nonce is spent and a member's `broadcast` claim for it exists, and is `expired` otherwise (§9). A create is done when its document exists; when it is absent but the claim exists and the nonce is spent, it reads "Done (no longer on Platform)", since a create later deleted cannot be told apart. A part whose nonce another request's part is known to have landed with is `expired`, and this rule wins over the others, so a false claim cannot make it done.
