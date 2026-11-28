import { publicShareOf, type CeremonyConfig } from './ceremony'
import type { OrgIdentity } from './identity'
import type { RosterFields } from './platform'
import type { Ceremony } from './state'
import { hex, isHex } from './util'
import type { Roster } from './roster-fields'

export { rosterFields, rosterMismatch, type Roster } from './roster-fields'

/** The slot name the default `dti` key layout gives the HIGH authentication key. */
export const ROSTER_SLOT = 'high'

export function rosterFromIdentity(identity: OrgIdentity, relay: string | null): Roster {
  const c = identity.ceremony
  const keys = c.result!.keys[identity.slot]!
  const people = c.config.participants
  return {
    source: 'ceremony',
    orgId: identity.orgId,
    room: c.config.room,
    relay,
    cid: c.cid,
    keyId: identity.keyId,
    slot: identity.slot,
    groupKey: identity.groupPublicKey,
    threshold: c.config.threshold,
    members: people.map((p) => p.authPub),
    pubShares: people.map((p) => keys.publicShares[p.index] as string),
    label: c.config.label,
    names: people.map((p) => p.name),
  }
}

function chunks(bytes: Uint8Array, size: number): string[] | null {
  if (bytes.length === 0 || bytes.length % size !== 0) return null
  return Array.from({ length: bytes.length / size }, (_, i) => hex(bytes.slice(i * size, (i + 1) * size)))
}

/** A roster read from an `org` document, or null when its fields do not fit together. */
export function rosterFromDoc(orgId: string, f: RosterFields): Roster | null {
  const members = chunks(f.members, 32)
  const pubShares = chunks(f.pubShares, 48)
  if (!members || !pubShares || members.length !== pubShares.length || members.length < 2 || members.length > 64) return null
  if (new Set(members).size !== members.length) return null
  if (!Number.isInteger(f.threshold) || f.threshold < 2 || f.threshold > members.length) return null
  if (f.cid.length !== 32 || f.groupKey.length !== 48 || !Number.isInteger(f.keyId)) return null
  return {
    source: 'org',
    orgId,
    room: f.room,
    relay: f.relay ?? null,
    cid: hex(f.cid),
    keyId: f.keyId,
    slot: ROSTER_SLOT,
    groupKey: hex(f.groupKey),
    threshold: f.threshold,
    members,
    pubShares,
    label: null,
    names: members.map(() => ''),
  }
}

/** A completed ceremony standing in for the roster, so `reduce` checks shares against its public shares. */
export function rosterCeremony(r: Roster): Ceremony {
  const participants = r.members.map((authPub, i) => ({ index: i + 1, name: r.names[i] ?? '', authPub, transportPub: '' }))
  const config: CeremonyConfig = {
    protocol: 'dti/1',
    room: r.room,
    network: '',
    label: r.label ?? '',
    threshold: r.threshold,
    organizer: r.members[0] as string,
    participants,
    keys: [{ slot: r.slot, keyId: r.keyId, purpose: 'AUTHENTICATION', securityLevel: 'HIGH' }],
    createdAt: '',
  }
  const publicShares = Object.fromEntries(r.pubShares.map((s, i) => [i + 1, s]))
  return {
    cid: r.cid,
    config,
    configMessage: '',
    configAt: '',
    raw: { commits: {}, reveals: {}, completes: {} },
    reveals: {},
    revealDigests: {},
    status: 'complete',
    result: { cid: r.cid, network: '', threshold: r.threshold, transcript: '', keys: { [r.slot]: { slot: r.slot, keyId: r.keyId, purpose: 'AUTHENTICATION', securityLevel: 'HIGH', groupPublicKey: r.groupKey, publicShares } } },
  }
}

export const memberIndex = (r: Roster, authPub: string): number | null => {
  const i = r.members.indexOf(authPub)
  return i < 0 ? null : i + 1
}

/** Whether `share` is member `index`'s share of the roster's key. */
export const shareMatches = (r: Roster, index: number, share: bigint): boolean => isHex(r.pubShares[index - 1], 48) && publicShareOf(share) === r.pubShares[index - 1]

