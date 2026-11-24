# Organizations: a repository owner that is an N-of-M multisig

Status: design, 2026-11-24. Testnet only until the owner says go.

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

**Create.** A member starts an owner action in Forge as they would for a personal repo. Because the owner is an organization, Forge builds the unsigned transition(s) with the organization as owner and its HIGH authentication key as signer, and posts them as `proposal` envelopes. A multi-document action (create repository) is several proposals with consecutive nonces, tied together by a `note` of the form `{"forge":1,"group":"<id>","seq":i,"of":k,"title":"…"}`. Forge calls the whole thing a **request**.

**Review.** A signer's client never trusts the proposal's description. It decodes the transition bytes and checks:

- the owner is the organization and the signing key is its group key, enabled on chain;
- the contract is one of this network's Forge contracts, and there is exactly one document transition;
- the bytes to sign are the signable bytes of that decoded transition;
- the nonce has not been used, and the fee increase is zero.

It then describes the action from the decoded content ("Give `alice.dash` Maintain access to `acme/widgets`"). A document type or action Forge does not recognise is shown as unrecognised and Forge refuses to sign it.

**Sign.** Signing needs the member's multisig seed phrase, because the share is derived from it and the ceremony's messages. The web app asks for it once per tab and keeps it in memory only; `dg` reads it from `--phrase-file`, `DG_ORG_PHRASE`, or a hidden prompt. Nothing secret is stored.

**Broadcast.** The signature that completes the threshold also finishes the job: that client combines the shares, checks the result against the group key, broadcasts the transitions in nonce order, confirms each with a proved read and posts `broadcast`. If it fails midway, any member (or `dg org finish`) can resume; BLS signatures are deterministic, so a rebroadcast is the same transition.

**Decline.** A member can decline a request (`reject`). Declines do not block; a request that will never reach N simply stays open and can be dismissed locally. A request whose nonce was overtaken is shown as expired.

Requests made in Forge are visible in multisig.dashhq.org as proposals, and its members can see shares arrive there.

## 5. Coordination and notifications

- **Web.** The header shows a count of requests waiting for the signed-in user's signature across their connected organizations. The inbox gets a "Needs your signature" section. The organization page lists open requests, each with one primary action: **Sign (1 of 2 collected)**, then **Done** once broadcast. Who signed is one click away; raw bytes are collapsed.
- **dg.** `dg org list`, `dg org requests`, `dg org show <request>`, `dg org sign <request>`, `dg org decline <request>`, `dg org finish <request>`. `dg status` prints one line when requests are waiting. Owner commands (`dg repo create --owner <org>`, `dg collab add|remove` on an org repo) create a request and print what to send to co-signers.
- **Telling the others.** Every request has a link (`/org?id=<org>&request=<id>`). After creating one, Forge shows "Send this to your co-signers" with copy and share buttons. Members who have connected the organization also see the badge without being told, because every client polls the relay.
- **Which device knows.** A client remembers, per organization, the group id, the relay and the member's public auth key. Those are public values, so the badge works without unlocking the seed phrase.

The relay is the hosted one at multisig.dashhq.org by default and any `dti relay serve` otherwise. It can withhold messages but cannot forge them; it is reachable over IPv4 and IPv6.

## 6. Contract changes

**None are needed.** Everything above works with the contracts registered on mainnet and testnet today.

One optional change would make coordination zero-backend, and it is the owner's decision (see the status report): new document types in forge-meta, added by an in-place update, for an on-chain roster (`org`, written by the organization: N, M, member identities, public shares) and on-chain requests and signature shares (`orgRequest`, `orgShare`, written by members' own identities). That gives an inbox by identity on every device with no relay, a public record of who approved what, and lets a maintainer who is not a signer ask the organization for something. It costs a contract update on mainnet (the registration fee again, about 0.39 DASH) and a small fee per signature.

## 7. Gating

Organizations are on for every network except mainnet (`orgsEnabled(network)` in forge-web, `org::enabled` in `dg`). On mainnet the pages, commands and badge are absent and an organization-owned repository reads as any other repository.

## 8. Implementation outline

- `forge-core::org` (Rust): `dti/1` envelopes, canonical JSON, room state (ceremony verification, proposals, shares), seed derivation, share recovery, BLS share signing and combination, relay client, unsigned transition build and decode. Checked against vectors generated by `dti` itself.
- `forge-web/lib/org`: the same in TypeScript on `@noble/curves`, sharing the vectors.
- `dg org …` and the owner-command routing; web organization page, connect flow, unlock dialog, inbox section and header badge.
