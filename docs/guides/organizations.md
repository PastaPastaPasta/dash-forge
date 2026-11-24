# Organizations

An organization is a repository owner held by several people: any *N* of its *M* members sign together, and no one holds the whole key. Forge uses the groups made in [multisig.dashhq.org](https://multisig.dashhq.org). How it works, and why, is in the [organizations design](../design/organizations.md).

Organizations are on testnet and devnets. On mainnet the pages, menu entry and badge are absent.

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

**Sign** adds your share. The signature that completes the threshold also combines the shares, broadcasts the transitions in order, and confirms each with a proved read; the request then reads **Done**. **Decline** records that you declined; it does not block the others. A request overtaken by another change of the organization reads as expired.
