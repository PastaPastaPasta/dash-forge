/** An in-memory forge-user for tests: documents by owner, revisions, and identities' sync keys. */

import type { ShareFields, StateFields } from './crypto'
import type { GrantFields, Stored, SyncPublicKey, UserSyncPort } from './platform'

export interface FakePlatform {
  readonly states: Map<string, Stored<StateFields>>
  readonly shares: Map<string, Stored<ShareFields>>
  readonly grants: Map<string, Stored<GrantFields>>
  /** Each identity's newest live sync key. */
  readonly keys: Map<string, SyncPublicKey>
  /** Older sync keys still live, per identity. */
  readonly olderKeys: Map<string, SyncPublicKey[]>
  /** Disabled sync keys, per identity. */
  readonly disabledKeys: Map<string, SyncPublicKey[]>
  /** Each identity's highest key id of any kind (else its highest sync key's). */
  readonly maxKeyIds: Map<string, number>
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
    olderKeys: new Map(),
    disabledKeys: new Map(),
    maxKeyIds: new Map(),
    writes: 0,
    port(signer) {
      const liveKeys = (identityId: string): SyncPublicKey[] => {
        const k = p.keys.get(identityId)
        return [...(p.olderKeys.get(identityId) ?? []), ...(k ? [k] : [])].sort((a, b) => a.keyId - b.keyId)
      }
      const bump = <T>(existing: Stored<T> | null, fields: T, map: Map<string, Stored<T>>, key: string): void => {
        const current = map.get(key) ?? null
        // As Platform: a replace names the document it read (its id) at the revision it read.
        if ((existing?.revision ?? null) !== (current?.revision ?? null) || (existing?.id ?? null) !== (current?.id ?? null)) throw new Error('revision conflict')
        map.set(key, { id: current?.id ?? nextId(), ownerId: signer, revision: (current?.revision ?? 0n) + 1n, fields })
        p.writes++
      }
      return {
        readState: async (ownerId, slot) => p.states.get(`${ownerId}/${slot}`) ?? null,
        statesOf: async (ownerId) => [...p.states.entries()].filter(([k]) => k.startsWith(`${ownerId}/`)).map(([, v]) => v),
        writeState: async (fields, existing) => bump(existing, fields, p.states, `${signer}/${fields.slot}`),
        readShare: async (ownerId, repoId) => p.shares.get(`${ownerId}/${repoId}`) ?? null,
        sharesOf: async (ownerId) => [...p.shares.entries()].filter(([k]) => k.startsWith(`${ownerId}/`)).map(([k, share]) => ({ repoId: k.slice(ownerId.length + 1), share })),
        writeShare: async (repoId, fields, existing) => bump(existing, fields, p.shares, `${signer}/${repoId}`),
        grantsOf: async (ownerId, repoId) => [...p.grants.values()].filter((g) => g.ownerId === ownerId && g.fields.repoId === repoId),
        grantFor: async (ownerId, repoId, memberId) => p.grants.get(`${ownerId}/${repoId}/${memberId}`) ?? null,
        writeGrant: async (fields, existing) => bump(existing, fields, p.grants, `${signer}/${fields.repoId}/${fields.memberId}`),
        deleteGrant: async (existing) => {
          if (existing.ownerId !== signer) throw new Error('not the owner')
          const key = `${signer}/${existing.fields.repoId}/${existing.fields.memberId}`
          // Only the document read: one recreated since is another document.
          if (p.grants.get(key)?.id !== existing.id) return
          p.grants.delete(key)
          p.writes++
        },
        syncKey: async (identityId, keyId) => {
          const live = liveKeys(identityId)
          return (keyId === undefined ? live.at(-1) : live.find((k) => k.keyId === keyId)) ?? null
        },
        syncKeys: async (identityId) => liveKeys(identityId),
        identitySyncKeys: async (identityId) => {
          const live = liveKeys(identityId).map((k) => ({ ...k, disabled: false }))
          const keys = [...live, ...(p.disabledKeys.get(identityId) ?? []).map((k) => ({ ...k, disabled: true }))].sort((a, b) => a.keyId - b.keyId)
          if (keys.length === 0 && !p.maxKeyIds.has(identityId)) return null
          return { keys, maxKeyId: Math.max(p.maxKeyIds.get(identityId) ?? -1, ...keys.map((k) => k.keyId)) }
        },
      }
    },
  }
  return p
}

/** The identity update a move sends, on the fake: `add` becomes the newest live key, `disable` is disabled. */
export function fakeReplaceKey(p: FakePlatform, identityId: string): (add: { readonly keyId: number; readonly pub: Uint8Array }, disable: number) => Promise<void> {
  return async (add, disable) => {
    const live = [...(p.olderKeys.get(identityId) ?? []), ...(p.keys.has(identityId) ? [p.keys.get(identityId)!] : [])]
    const off = live.find((k) => k.keyId === disable)
    if (off === undefined) throw new Error(`key ${disable} is not live`)
    p.disabledKeys.set(identityId, [...(p.disabledKeys.get(identityId) ?? []), off])
    const rest = live.filter((k) => k.keyId !== disable)
    p.olderKeys.set(identityId, rest)
    p.keys.set(identityId, { keyId: add.keyId, pub: add.pub })
    p.maxKeyIds.set(identityId, Math.max(p.maxKeyIds.get(identityId) ?? -1, add.keyId))
  }
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
