// Loads the JSON vectors (read from disk so no tsconfig needs resolveJsonModule) and turns their keys into codec input.
import { readFileSync } from 'node:fs'
import { hexToBytes } from '@noble/hashes/utils.js'
import type { SlotBundle, SlotKey } from '../codecs'

export interface VectorKey {
  purpose: number
  securityLevel: number
  keyType: number
  keyId: number
  privateKey: string
  label?: string
}

export interface Vector {
  name: string
  format?: number
  credentialId: string
  prfOutput: string
  ephemeralIkm: string
  keys: VectorKey[]
  prfInput?: string
  recipientSk?: string
  recipientKey?: string
  info?: string
  authKeyId?: number
  aad?: string
  bundle?: string
  enc?: string
  sealed?: string
}

export interface VectorFile {
  contractId: string
  ownerId: string
  vectors: Vector[]
}

export interface GovhubFile {
  contractId: string
  ownerId: string
  vector: Vector & {
    snapshot: { enc: string; sealedHead: string; tag: string }
    derived: Required<Pick<Vector, 'prfInput' | 'recipientSk' | 'recipientKey' | 'info' | 'aad' | 'bundle' | 'enc' | 'sealed'>>
  }
}

export function loadVectors<T = VectorFile>(name: 'yappr' | 'govhub' | 'forge'): T {
  return JSON.parse(readFileSync(new URL(`../__vectors__/${name}.json`, import.meta.url), 'utf8')) as T
}

const slotKeys = (keys: readonly VectorKey[]): SlotKey[] =>
  keys.map((k) => ({ purpose: k.purpose, securityLevel: k.securityLevel, keyType: k.keyType, keyId: k.keyId, privateKey: hexToBytes(k.privateKey) }))

export const slotBundle = (format: number, keys: readonly VectorKey[]): SlotBundle => ({ format, keys: slotKeys(keys) })

/** A field of a vector that must be present. */
export function req<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the vector has no ${what}`)
  return value
}
