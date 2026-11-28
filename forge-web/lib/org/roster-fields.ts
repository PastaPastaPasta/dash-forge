import { concatBytes } from '@noble/hashes/utils.js'

import type { RosterFields } from './platform'
import { hex, unhex } from './util'

/**
 * What reading and signing an organization's requests needs: its members' auth keys and public
 * shares (by participant index, from 1), N, and the group key, from a current `org` document or
 * from the key ceremony's transcript.
 */
export interface Roster {
  readonly source: 'org' | 'ceremony'
  readonly orgId: string
  readonly room: string
  readonly relay: string | null
  readonly cid: string
  readonly keyId: number
  readonly slot: string
  readonly groupKey: string
  readonly threshold: number
  readonly members: readonly string[]
  readonly pubShares: readonly string[]
  readonly label: string | null
  readonly names: readonly string[]
}

export function rosterFields(r: Roster): RosterFields {
  return {
    room: r.room,
    ...(r.relay ? { relay: r.relay } : {}),
    cid: unhex(r.cid),
    keyId: r.keyId,
    groupKey: unhex(r.groupKey),
    threshold: r.threshold,
    members: concatBytes(...r.members.map(unhex)),
    pubShares: concatBytes(...r.pubShares.map(unhex)),
  }
}

/** Why an `org` write does not match the roster exactly, or null when it does. */
export function rosterMismatch(r: Roster, data: Readonly<Record<string, unknown>>): string | null {
  const bytes = (v: unknown): string | null => (v instanceof Uint8Array ? hex(v) : null)
  const want = rosterFields(r)
  const problems: string[] = []
  if (data['room'] !== want.room) problems.push('room')
  if (bytes(data['cid']) !== r.cid) problems.push('ceremony id')
  if (Number(data['keyId']) !== r.keyId) problems.push('key id')
  if (bytes(data['groupKey']) !== r.groupKey) problems.push('group key')
  if (Number(data['threshold']) !== r.threshold) problems.push('threshold')
  if (bytes(data['members']) !== hex(want.members)) problems.push('members')
  if (bytes(data['pubShares']) !== hex(want.pubShares)) problems.push('public shares')
  const relay = data['relay']
  if (relay !== undefined && (typeof relay !== 'string' || !/^https:\/\//.test(relay) || relay.length > 200)) problems.push('relay')
  return problems.length ? `the roster does not match the organization's key ceremony (${problems.join(', ')})` : null
}
