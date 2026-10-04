/**
 * Signing keys on a profile (P1-7): building `profile.pubkeys` entries from a pasted SSH public
 * key line or an armored OpenPGP public key, and publishing them. The entry formats and how a
 * commit's signature is judged against them are the shared rule in `lib/rules/signature.ts`.
 * Parity: `forge_core::signing_keys` (`dg profile key add/remove`).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { ForgeIds } from '../deployments'
import { createDocumentIdempotent, previewCreate, previewReplace, replaceDocumentIdempotent, type CostPreview, type WriteAuth } from '../sdk'
import { readPubkeyEntry } from '../rules/signature'
import { DOC } from './contract'
import type { Profile } from './profile'

/** At most this many keys on a profile (`pubkeys.maxItems`). */
export const MAX_KEYS = 4
/** At most this many bytes per entry (`pubkeys.items.maxBytes`). */
export const MAX_ENTRY_BYTES = 300

const utf8 = (s: string): number => new TextEncoder().encode(s).length

/** A built entry, or why it is refused (too long, or a key Forge does not verify). */
async function checked(entry: string): Promise<string> {
  if (utf8(entry) > MAX_ENTRY_BYTES) {
    throw new Error(`This key takes ${utf8(entry)} bytes, over a profile entry's ${MAX_ENTRY_BYTES}: use an Ed25519 key (an RSA key does not fit).`)
  }
  if (!(await readPubkeyEntry(entry)).verifiable) {
    throw new Error('Forge verifies Ed25519 SSH keys and Ed25519 or ECDSA (P-256/384/521) OpenPGP keys; this is neither.')
  }
  return entry
}

/** The entry for an OpenSSH public key line; its comment kept when the entry still fits. */
export async function sshEntry(line: string): Promise<string> {
  const [type, data, ...comment] = line.trim().split(/\s+/)
  if (type === undefined || data === undefined) throw new Error('An SSH public key line is `ssh-ed25519 AAAA… [comment]`.')
  const bare = `${type} ${data}`
  const withComment = comment.length > 0 ? `${bare} ${comment.join(' ')}` : bare
  if (withComment !== bare && utf8(withComment) <= MAX_ENTRY_BYTES) {
    try {
      return await checked(withComment)
    } catch {
      // fall through to the bare key
    }
  }
  return checked(bare)
}

/** A packet with a new-format header, as an entry stores it. */
function framed(tag: number, body: Uint8Array): Uint8Array {
  const n = body.length
  const len = n < 192 ? [n] : n < 8384 ? [((n - 192) >> 8) + 192, (n - 192) & 0xff] : [0xff, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
  return new Uint8Array([0xc0 | tag, ...len, ...body])
}

/**
 * The entry for an armored OpenPGP public key: its signing key as OpenPGP.js (and gpg) picks it,
 * the newest valid subkey that may sign, else the primary key.
 */
export async function openpgpEntry(armored: string): Promise<string> {
  const pgp = await import('openpgp')
  let key: Awaited<ReturnType<typeof pgp.readKey>>
  try {
    key = await pgp.readKey({ armoredKey: armored })
  } catch {
    throw new Error('That is not an armored OpenPGP public key (gpg --armor --export <key id>).')
  }
  let signing: Awaited<ReturnType<typeof key.getSigningKey>>
  try {
    signing = await key.getSigningKey()
  } catch {
    throw new Error('This OpenPGP key has no valid key that may sign.')
  }
  const packet = signing.keyPacket
  const tag = packet instanceof pgp.PublicSubkeyPacket || packet instanceof pgp.SecretSubkeyPacket ? 14 : 6
  const body = (packet as unknown as { writePublicKey(): Uint8Array }).writePublicKey()
  const b64 = btoa(String.fromCharCode(...framed(tag, body)))
  return checked(`gpg:${packet.getFingerprint().toUpperCase()} ${b64}`)
}

/** The entry for whatever was pasted: an SSH line or an armored OpenPGP key. */
export function keyEntry(pasted: string): Promise<string> {
  const t = pasted.trim()
  return t.startsWith('-----BEGIN PGP') ? openpgpEntry(t) : sshEntry(t)
}

/** `pubkeys` with `entry` added (refused when its key is already there or the profile is full). */
export async function withKey(pubkeys: readonly string[], entry: string): Promise<string[]> {
  const fp = (await readPubkeyEntry(entry)).fingerprint
  for (const k of pubkeys) {
    if ((await readPubkeyEntry(k)).fingerprint === fp) throw new Error('This key is already on your profile.')
  }
  if (pubkeys.length >= MAX_KEYS) throw new Error(`A profile lists at most ${MAX_KEYS} keys: remove one first.`)
  return [...pubkeys, entry]
}

/** What publishing `pubkeys` costs: a new profile, or a replace of its `pubkeys`. */
export function pubkeysCost(stored: Profile | null, pubkeys: readonly string[]): CostPreview {
  return stored === null ? previewCreate(DOC.profile, { pubkeys: [...pubkeys] }) : previewReplace(DOC.profile, { pubkeys: [...pubkeys] })
}

/** Set the signer's `profile.pubkeys` (none removes the property), creating the profile if needed. */
export async function savePubkeys(sdk: EvoSDK, auth: WriteAuth, forge: ForgeIds, stored: Profile | null, pubkeys: readonly string[], intent?: string): Promise<void> {
  if (stored === null) {
    if (pubkeys.length === 0) return
    await createDocumentIdempotent(sdk, auth, { contractId: forge.community, documentType: DOC.profile, data: { pubkeys: [...pubkeys] }, ...(intent ? { intent } : {}) })
    return
  }
  await replaceDocumentIdempotent(sdk, auth, {
    contractId: forge.community,
    documentType: DOC.profile,
    documentId: stored.id,
    changes: { pubkeys: pubkeys.length === 0 ? undefined : [...pubkeys] },
    expectedRevision: BigInt(stored.revision),
  })
}
