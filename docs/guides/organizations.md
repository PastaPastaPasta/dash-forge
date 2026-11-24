# Organizations

An organization is a repository owner that several people control together: *M* members each hold a share of its key, and any *N* of them sign for it. You create one in [multisig.dashhq.org](https://multisig.dashhq.org); Forge then lets its members own repositories with it. The design is in [docs/design/organizations.md](../design/organizations.md).

Organizations work on testnet and devnets. On mainnet every `dg org` command answers "Organizations are not available on mainnet yet."

**Status.** dg's organization code is checked against the shared `dti/1` test vector that dash-threshold-identity generated: the key ceremony, each member's share recovered from their recovery phrase, the share signatures, the combined signature and the request states. dg has not yet run the whole flow on testnet against a live organization.

## What needs the organization, and what doesn't

Owner actions need *N* of *M* signatures. In dg these are:

- `dg repo create <name> --owner <org>`: the repository, the organization's own Maintain access and the first settings, as one request;
- `dg collab add` and `dg collab remove` on a repository the organization owns.

Everything else (push, pull requests, reviews, merges, releases, settings) is done by the repository's maintainers and writers with their own identities, as on any repository.

## Connect the organization

You need the organization's group id (or its invite link) and your multisig recovery phrase:

```sh
dg org connect t_0123456789abcdef
```

dg reads the group's messages from its relay (`--relay`, default `https://multisig.dashhq.org`), checks the key ceremony, and finds the organization's identity on the network. It remembers the organization in `orgs.json` next to dg's `config.toml`: the identity id, the group id, the relay, your public key, the name, the threshold and the members. Nothing secret is stored.

Your recovery phrase is read from `--phrase-file <file>`, else `DG_ORG_PHRASE`, else a hidden prompt. A passphrase comes from `--passphrase-file`, `DG_ORG_PASSPHRASE`, or the prompt. dg never writes either to disk.

`dg org list` shows the organizations connected on this computer.

## Make a request

```sh
dg repo create widgets --owner acme
```

This makes a request, signs it with your share, and prints what to send the other members:

```
Request 3f2a9c1e0b7d4a55: Create acme/widgets
1 of 2 collected. Send this to your co-signers:
  dg org sign 3f2a9c1e0b7d4a55
```

An organization's repositories are public for now. A member added with `dg collab add` must accept first (`dg collab accept`), as on any repository. A repository with members-only content refuses member changes by an organization for now.

## Review and sign

```sh
dg org requests                 # open requests, and which wait for you
dg org show 3f2a9c1e0b7d4a55    # what it writes, who signed, who declined
dg org sign 3f2a9c1e0b7d4a55
```

Before signing, dg decodes the request's transitions itself and checks them: the organization is the owner and its group key signs, there is one document write per transition, the write goes to this network's Forge contracts, the bytes to sign are the transition's, the nonce is unused, and the kind of write is one Forge makes for an owner. It refuses to sign anything else.

The signature that completes a request also puts it on Platform. If that stops part way, any member runs `dg org finish <request>`. `dg org decline <request> --reason "…"` declines a request; it stays open for the others.

`dg auth status` prints one line when requests wait for your signature (only when an organization is connected).
