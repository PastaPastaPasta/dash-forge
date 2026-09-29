/**
 * The contract-group check made before a limited key is bound to the forge group (parity
 * with `dg`'s `crates/dg/src/auth/group.rs`; `docs/contracts/forge-v2.md` § Contract group
 * trust).
 *
 * A group-bound key can sign documents for every member of the group, so binding one trusts
 * whoever can add members: only the group's owner or an admin (a member joins in its own
 * contract's create transition, which Platform accepts only from them, and the owner and
 * admins never change). So the check pins the trust root, not the member list:
 *
 * 1. the group's owner, read with proofs, is the Forge deployer the bundled deployment file
 *    records, and the group has no admins. Consensus then guarantees every member was
 *    created by that owner;
 * 2. forge-core and forge-collab are whole-contract members (checked before anything else is
 *    read);
 * 3. cross-check: each member contract this build does not know is read with proofs, and an
 *    `$ownerId` other than the pinned owner is refused. A contract that cannot be read (a
 *    format newer than this build) is accepted and named, since rule 1 already bounds it;
 * 4. members this build does not know are accepted and reported, so the key-creation screen
 *    lists them. (Strict mode is `dg`-only.)
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { GroupTrust } from '../deployments'

/** What the chain says owns the group. */
export interface GroupOwnership {
  readonly ownerId: string
  readonly adminIds: readonly string[]
}

/** Everything the group holds: whole contracts, document types and tokens (by contract). */
export interface GroupMemberSet {
  readonly contracts: readonly string[]
  readonly documentTypes: readonly { readonly contractId: string; readonly documentTypeName: string }[]
  readonly tokens: readonly { readonly contractId: string; readonly tokenPosition: number }[]
}

/** The outcome of a passing check: the members this build does not know, and what to show. */
export interface GroupCheck {
  /** Members beyond Forge's known contracts (`contract`, `contract (document type t)`, …). */
  readonly unknown: readonly string[]
  /** Unknown member contracts whose owner was not cross-checked (unreadable, or past the cap). */
  readonly unchecked: readonly string[]
  /** One line for the key-creation screen, or null when the group holds only known members. */
  readonly notice: string | null
}

const REFUSE = 'refusing to bind a key to the dash-forge contract group'
/** The most member pages read per kind. */
export const MAX_PAGES = 20
/** The most unknown member contracts whose owner is cross-checked; the rest are accepted unchecked. */
export const MAX_UNKNOWN_CONTRACTS = 64

function refuse(cause: string): Error {
  return new Error(`${REFUSE}: ${cause}`)
}

function isKnown(trust: GroupTrust, contractId: string): boolean {
  return contractId === trust.core || contractId === trust.collab || contractId === trust.community || trust.superseded.includes(contractId)
}

/** Every member contract (whole, or through a document type or token) Forge does not know. */
export function unknownMemberContracts(trust: GroupTrust, members: GroupMemberSet): string[] {
  const all = [...members.contracts, ...members.documentTypes.map((d) => d.contractId), ...members.tokens.map((t) => t.contractId)]
  return [...new Set(all.filter((c) => !isKnown(trust, c)))].sort()
}

function describeUnknown(trust: GroupTrust, members: GroupMemberSet): string[] {
  const whole = members.contracts.filter((c) => !isKnown(trust, c)).sort()
  const parts = [
    ...members.documentTypes.map((d) => `${d.contractId} (document type ${d.documentTypeName})`),
    ...members.tokens.map((t) => `${t.contractId} (token ${t.tokenPosition})`),
  ].sort()
  return [...whole, ...parts]
}

/** Rule 1: the group exists, its owner is the pinned one, and it has no admins. Throws otherwise. */
export function checkOwnership(trust: GroupTrust, group: string, info: GroupOwnership | undefined): void {
  if (group !== trust.group) throw refuse(`the key would be bound to group ${group}, but this build's deployment records ${trust.group}`)
  if (!trust.owner) throw refuse(`this build's deployment records no owner for group ${group}, so there is no trust root to check it against`)
  if (!info) throw refuse(`contract group ${group} does not exist on this network`)
  if (info.ownerId !== trust.owner) {
    throw refuse(
      `group ${group} is owned by ${info.ownerId}, but this build pins the Forge deployer ${trust.owner}; whoever owns the group decides what every key bound to it can sign`,
    )
  }
  if (info.adminIds.length > 0) throw refuse(`group ${group} lets ${info.adminIds.join(', ')} add members besides its owner; the Forge group has no admins`)
}

/**
 * Rule 2: forge-core, forge-collab and forge-community are whole-contract members (forge-community
 * is forge-collab on a deployment that predates the split). Throws otherwise.
 */
export function checkPair(trust: GroupTrust, members: GroupMemberSet): void {
  if (![trust.core, trust.collab, trust.community].every((c) => members.contracts.includes(c))) {
    throw refuse(
      `group ${trust.group} does not hold forge-core ${trust.core}, forge-collab ${trust.collab} and forge-community ${trust.community} as whole contracts`,
    )
  }
}

/**
 * Rules 3–4, given each unknown member contract's proof-verified owner (absent = not read).
 * Throws on an owner mismatch; returns the unknown members and the notice otherwise.
 */
export function checkMembers(trust: GroupTrust, members: GroupMemberSet, owners: ReadonlyMap<string, string>): GroupCheck {
  checkPair(trust, members)
  const unknown = describeUnknown(trust, members)
  if (unknown.length === 0) return { unknown, unchecked: [], notice: null }
  const unchecked: string[] = []
  for (const contract of unknownMemberContracts(trust, members)) {
    const owner = owners.get(contract)
    if (owner === undefined) unchecked.push(contract)
    else if (owner !== trust.owner) {
      throw refuse(`group ${trust.group} holds contract ${contract}, owned by ${owner} and not by the Forge deployer ${trust.owner}; a key bound to the group could sign for it`)
    }
  }
  const extraParts = [...members.documentTypes, ...members.tokens].some((m) => isKnown(trust, m.contractId))
  const what = extraParts ? 'additional group member(s)' : 'newer Forge contract revision(s)'
  const skipped = unchecked.length ? ` (Could not read contract ${unchecked.join(', ')}; accepted because the group owner is pinned.)` : ''
  return {
    unknown,
    unchecked,
    notice: `The Forge group also holds ${what}, added by the Forge deployer: ${unknown.join(', ')}. This key can sign for them too; reload for the latest app to use them.${skipped}`,
  }
}

interface ContractGroupsLike {
  info(id: string): Promise<GroupOwnership | undefined>
  members(query: { contractGroupId: string; kind: 'contracts' | 'documentTypes' | 'tokens'; limit?: number; startAfter?: unknown }): Promise<{
    contracts?: string[]
    documentTypes?: GroupMemberSet['documentTypes'][number][]
    tokens?: GroupMemberSet['tokens'][number][]
    nextStartAfter?: unknown
  }>
}

interface ContractsLike {
  fetch(id: string): Promise<{ ownerId: { toBase58(): string } | string } | undefined>
}

async function readMembers(groups: ContractGroupsLike, group: string): Promise<GroupMemberSet> {
  const out = { contracts: [] as string[], documentTypes: [] as GroupMemberSet['documentTypes'][number][], tokens: [] as GroupMemberSet['tokens'][number][] }
  for (const kind of ['contracts', 'documentTypes', 'tokens'] as const) {
    let startAfter: unknown
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) throw refuse(`contract group ${group} has more members than this app checks`)
      const p = await groups.members({ contractGroupId: group, kind, limit: 100, ...(startAfter ? { startAfter } : {}) })
      out.contracts.push(...(p.contracts ?? []))
      out.documentTypes.push(...(p.documentTypes ?? []))
      out.tokens.push(...(p.tokens ?? []))
      // The SDK sets `nextStartAfter` on every non-empty page, so the walk ends on an empty one.
      if (!p.nextStartAfter) break
      startAfter = p.nextStartAfter
    }
  }
  return out
}

async function readOwner(contracts: ContractsLike, id: string): Promise<string | undefined> {
  try {
    const c = await contracts.fetch(id)
    if (!c) return undefined
    return typeof c.ownerId === 'string' ? c.ownerId : c.ownerId.toBase58()
  } catch {
    // Unreadable (e.g. a contract format newer than this build): accepted on the pinned owner.
    return undefined
  }
}

/**
 * Check on chain (the SDK verifies every read's proof) that binding a key to `group` trusts
 * only the pinned owner. Throws a refusal; returns what to show on the key-creation screen.
 */
export async function assertGroupHolds(sdk: EvoSDK, group: string, trust: GroupTrust): Promise<GroupCheck> {
  const facades = sdk as unknown as { contractGroups: ContractGroupsLike; contracts: ContractsLike }
  checkOwnership(trust, group, await facades.contractGroups.info(group))
  const members = await readMembers(facades.contractGroups, group)
  checkPair(trust, members)
  const owners = new Map<string, string>()
  for (const id of unknownMemberContracts(trust, members).slice(0, MAX_UNKNOWN_CONTRACTS)) {
    const owner = await readOwner(facades.contracts, id)
    if (owner !== undefined) owners.set(id, owner)
  }
  return checkMembers(trust, members, owners)
}
