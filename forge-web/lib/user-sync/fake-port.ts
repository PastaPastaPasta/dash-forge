/** An in-memory forge-user for tests: documents by owner, revisions, and identities' sync keys. */

import type { ShareFields, StateFields } from './crypto'
import type { GrantFields, Stored, SyncPublicKey, UserSyncPort } from './platform'

export interface FakePlatform {
  readonly states: Map<string, Stored<StateFields>>
  readonly shares: Map<string, Stored<ShareFields>>
  readonly grants: Map<string, Stored<GrantFields>>
  readonly keys: Map<string, SyncPublicKey>
  writes: number
  /** The port as `signer` sees it: it writes only its own documents. */
  port(signer: string): UserSyncPort
}

export function fakePlatform(): FakePlatform {
  let seq = 0
  const nextId = (): string => `doc${++seq}`
  const p: FakePlatform = {
    states: new Map(),
    shares: new Map(),
    grants: new Map(),
    keys: new Map(),
    writes: 0,
    port(signer) {
      const bump = <T>(existing: Stored<T> | null, fields: T, map: Map<string, Stored<T>>, key: string): void => {
        const current = map.get(key) ?? null
        if ((existing?.revision ?? null) !== (current?.revision ?? null)) throw new Error('revision conflict')
        map.set(key, { id: current?.id ?? nextId(), ownerId: signer, revision: (current?.revision ?? 0n) + 1n, fields })
        p.writes++
      }
      return {
        readState: async (ownerId, slot) => p.states.get(`${ownerId}/${slot}`) ?? null,
        writeState: async (fields, existing) => bump(existing, fields, p.states, `${signer}/${fields.slot}`),
        readShare: async (ownerId, repoId) => p.shares.get(`${ownerId}/${repoId}`) ?? null,
        writeShare: async (repoId, fields, existing) => bump(existing, fields, p.shares, `${signer}/${repoId}`),
        grantsOf: async (ownerId, repoId) => [...p.grants.values()].filter((g) => g.ownerId === ownerId && g.fields.repoId === repoId),
        grantFor: async (ownerId, repoId, memberId) => p.grants.get(`${ownerId}/${repoId}/${memberId}`) ?? null,
        writeGrant: async (fields, existing) => bump(existing, fields, p.grants, `${signer}/${fields.repoId}/${fields.memberId}`),
        deleteGrant: async (existing) => {
          if (existing.ownerId !== signer) throw new Error('not the owner')
          p.grants.delete(`${signer}/${existing.fields.repoId}/${existing.fields.memberId}`)
          p.writes++
        },
        syncKey: async (identityId, keyId) => {
          const k = p.keys.get(identityId)
          return k && (keyId === undefined || k.keyId === keyId) ? k : null
        },
      }
    },
  }
  return p
}

/** A `Storage` over a map, for `localStorage` in node. */
export function memoryStorage(): Storage & { readonly map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  }
}
