// An in-memory VaultPort with the contract's rules: one entry per (owner, credential), credentialId and recipientKey immutable,
// replace only the revision read. Optional read lag (a node a block behind) and a log of writes.
import { bytesEqual } from '../bytes'
import type { SealedVaultEntry } from '../entry'
import type { OnChainKey, VaultEntryRecord, VaultPort } from '../port'

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const clone = (e: VaultEntryRecord): VaultEntryRecord => ({
  ...e,
  ownerId: e.ownerId.slice(),
  credentialId: e.credentialId.slice(),
  recipientKey: e.recipientKey.slice(),
  enc: e.enc.slice(),
  sealed: e.sealed.slice(),
})

export class MemoryVaultPort implements VaultPort {
  entries: VaultEntryRecord[] = []
  readonly identities = new Map<string, OnChainKey[]>()
  readonly writes: Array<{ op: 'create' | 'replace' | 'delete'; credentialId: Uint8Array }> = []
  /** byCredential misses this many reads after each write. */
  lag = 0
  #lagLeft = 0
  #clock = 1_700_000_000_000
  #ids = 0

  setKeys(ownerId: Uint8Array, keys: OnChainKey[]): void {
    this.identities.set(hex(ownerId), keys)
  }

  /** Writes an entry directly, as any holder of a live key of the owner could (a planted entry). */
  plant(ownerId: Uint8Array, entry: SealedVaultEntry): VaultEntryRecord {
    const record: VaultEntryRecord = { ...entry, ownerId: ownerId.slice(), documentId: `doc${++this.#ids}`, revision: 1, createdAt: this.#clock, updatedAt: this.#clock }
    this.entries.push(record)
    return clone(record)
  }

  #find(ownerId: Uint8Array, credentialId: Uint8Array) {
    return this.entries.find((e) => bytesEqual(e.ownerId, ownerId) && bytesEqual(e.credentialId, credentialId))
  }

  async list(ownerId: Uint8Array) {
    return this.entries.filter((e) => bytesEqual(e.ownerId, ownerId)).map(clone)
  }

  async byCredential(ownerId: Uint8Array, credentialId: Uint8Array) {
    if (this.#lagLeft > 0) {
      this.#lagLeft -= 1
      return null
    }
    const e = this.#find(ownerId, credentialId)
    return e ? clone(e) : null
  }

  async identityKeys(ownerId: Uint8Array) {
    return this.identities.get(hex(ownerId))?.map((k) => ({ ...k })) ?? null
  }

  async put(o: { ownerId: Uint8Array; entry: SealedVaultEntry; existing: VaultEntryRecord | null }) {
    const current = this.#find(o.ownerId, o.entry.credentialId)
    this.#clock += 1000
    if (!o.existing) {
      if (current) throw new Error('duplicate unique index byCredential')
      this.plant(o.ownerId, o.entry)
      this.writes.push({ op: 'create', credentialId: o.entry.credentialId.slice() })
    } else {
      if (!current || current.revision !== o.existing.revision) throw new Error('the document changed since it was read')
      if (!bytesEqual(current.recipientKey, o.entry.recipientKey)) throw new Error('recipientKey is immutable')
      Object.assign(current, { ...o.entry, ownerId: current.ownerId, revision: (current.revision ?? 1) + 1, updatedAt: this.#clock })
      this.writes.push({ op: 'replace', credentialId: o.entry.credentialId.slice() })
    }
    this.#lagLeft = this.lag
  }

  async remove(o: { ownerId: Uint8Array; entry: VaultEntryRecord }) {
    const before = this.entries.length
    this.entries = this.entries.filter((e) => !(bytesEqual(e.ownerId, o.ownerId) && bytesEqual(e.credentialId, o.entry.credentialId)))
    if (this.entries.length !== before) this.writes.push({ op: 'delete', credentialId: o.entry.credentialId.slice() })
  }
}
