# Organizations

An organization is a repository owner held by several people: any *N* of its *M* members sign together, and no one holds the whole key. Forge uses the groups made in [multisig.dashhq.org](https://multisig.dashhq.org). How it works, and why, is in the [organizations design](../design/organizations.md).

Organizations are on testnet and devnets. On mainnet the pages, menu entry and badge are absent, and `dg org …` and `dg repo create --owner` stop with "Organizations are not available on mainnet yet." ([E205](../errors.md#e205)). A team on mainnet can share an [organization identity](collaborating.md#organizations) instead.

## Make an organization

1. In multisig.dashhq.org, start a group and invite the other members.
2. Make the keys together (the key ceremony) and choose how many must sign.
3. Fund and create the organization's identity there.

Then open **Organizations** in Forge (the account menu, or `/org`), paste the group's invite link or its group id, and press **Continue**. Forge reads the group's messages from the relay, checks the key ceremony, and checks that an identity on this network uses the group's signing key. It then asks which member you are and saves the organization in this browser. Only public values are saved: the group id, the relay, the organization's identity, its members' names and public keys.

## Ask for a change

These are owner actions, so the organization signs them:

- **New repository**: choose the organization as the owner on the New repository page. One request creates the repository, makes the organization its maintainer, and writes its first settings.
- **Members**: add a member, change a role or remove one under the repository's Settings → Members. A member still accepts the invitation first, as for any repository.
- **Description and topics**: edit them under Settings → General.

Each of these asks for your multisig seed phrase once per tab, signs the request with your share, and opens the request with a link to send to your co-signers. The phrase stays in the tab's memory; closing the tab or signing out forgets it. A phrase that does not belong to a member of the organization is refused.

Maintainers and writers of an organization's repository push, merge and change settings with their own identities, as in any repository. A maintainer who is not a member of the organization sees that its members manage access.

## Sign

The header shows how many requests wait for your signature, and the Notifications page lists them under **Needs your signature**. Each request reads as a sentence that Forge builds from the transition it would sign, never from the text its creator typed. Forge refuses to sign a request that writes as another owner, to a contract that is not one of this network's Forge contracts, with a nonce already used, or an action it does not recognise.

**Sign** adds your share. The signature that completes the threshold also combines the shares, broadcasts the transitions in order, and confirms each with a proved read; the request then reads **Done**. **Decline** records that you declined; it does not block the others unless so many members decline that the rest can no longer reach the threshold, and then the request reads **Declined** and its nonces are free for new requests. A request overtaken by another change of the organization reads as expired.

## From the command line (dg)

### Owner commands

Owner actions need *N* of *M* signatures. In dg these are:

- `dg repo create <name> --owner <org>`: the repository, the organization's own Maintain access and the first settings, as one request;
- `dg collab add` and `dg collab remove` on a repository the organization owns.

### Connect the organization

You need the organization's group id (or its invite link), your multisig recovery phrase, and your own Forge identity on the network (`dg auth login`): requests, signatures and declines are documents your identity writes on Platform.

```sh
dg org connect t_0123456789abcdef
```

dg reads the key ceremony from the group's relay (`--relay`, default `https://multisig.dashhq.org`), checks it, and finds the organization's identity on the network. It then links your Forge identity to your member key on Platform and stores your share of the signing key there, sealed so that only your recovery phrase opens it. From then on dg needs only the phrase and Platform. It remembers the organization in `orgs.json` next to dg's `config.toml` (the identity id, the group id, the relay, your public key, the name, the threshold and the members) and keeps the ceremony's public messages in `org-ceremonies/`. Nothing secret is stored on this computer.

Your recovery phrase is read from `--phrase-file <file>`, else `DG_ORG_PHRASE`, else a hidden prompt. A passphrase comes from `--passphrase-file`, `DG_ORG_PASSPHRASE`, or the prompt. dg never writes either to disk.

`dg org list` shows the organizations connected on this computer.

### Make a request

```sh
dg repo create widgets --owner acme
```

This makes a request, signs it with your share, and prints what to send the other members:

```
Request 3f2a9c1e0b7d4a55-e40009bfc871bc5c: Create acme/widgets
1 of 2 collected. Send this to your co-signers:
  dg org sign 3f2a9c1e0b7d4a55-e40009bfc871bc5c
```

A request id names the member who made it. The first part alone also works while no one else used it. Each message is a small Platform write by your identity (about 0.001 DASH for a request, 0.0003 DASH for a signature); the organization pays only for its own writes when a request finishes.

An organization's repositories are public for now. A member added with `dg collab add` must accept first (`dg collab accept`), as on any repository. A repository with members-only content refuses member changes by an organization for now.

### Review and sign

```sh
dg org requests        # open requests, and which wait for you
dg org show 3f2a9c1e   # what it writes, who signed, who declined
dg org sign 3f2a9c1e
```

Before signing, dg decodes the request's transitions itself and checks them: the organization is the owner and its group key signs, there is one document write per transition, the write goes to this network's Forge contracts, the bytes to sign are the transition's, the nonce is unused, and the kind of write is one Forge makes for an owner. It refuses to sign anything else.

A request Forge won't sign reads "Forge won't sign this: <reasons>." and stops with [E613](../errors.md#e613). Nothing is wrong on your side: `dg org dismiss <request>` hides it on this computer, for free.

The signature that completes a request also puts it on Platform. If that stops part way, any member runs `dg org finish <request>`. A request is done once its writes are on Platform; a member's report that it broadcast is not enough. `dg org decline <request> --reason "…"` declines a request you disagree with; it stays open for the others until so many members decline that it can no longer reach the threshold, and then it reads "Declined: too many members declined it to reach N of M."

### Requests made before the move to Platform

Requests made with an older dg or Forge live on the relay and are not shown. Each member who took part runs, once:

```sh
dg org migrate acme
```

It copies only your own messages in the relay's open requests (your requests, signatures, declines and broadcast records), so nobody can drop or re-time another member's. Requests nobody copies can still be finished or declined in multisig.dashhq.org.

`dg auth status` prints one line when requests wait for your signature (only when an organization is connected).
