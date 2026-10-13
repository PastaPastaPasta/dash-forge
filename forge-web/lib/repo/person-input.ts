/**
 * A person typed into a member or audience picker: an identity id, or a DPNS name (`alice.dash`,
 * `@alice`, `alice`) looked up through the same forward resolution the search and code-owners use
 * ({@link resolveDpnsIds}). An unknown name is refused; a read that fails is not "no such name".
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { decodeIdentifier } from '@/lib/auth'
import { base58Encode } from '@/lib/auth/base58'
import type { Network } from '@/lib/constants'
import { displayDpnsName, looksLikeDpnsName, resolveDpnsIds } from '@/lib/view/dpns'

/** What the typed text is, before any lookup. */
export type PersonInput =
  | { readonly kind: 'empty' }
  | { readonly kind: 'id'; readonly id: string }
  | { readonly kind: 'name'; readonly name: string }
  | { readonly kind: 'invalid'; readonly error: string }

export const NOT_A_PERSON = 'Not an identity id or a name like alice.dash.'

/** Classify `text`: an id (canonical base58), a name worth a lookup (as `label.parent`), or neither. */
export function parsePersonInput(text: string): PersonInput {
  const t = text.trim().replace(/^@/, '')
  if (t === '') return { kind: 'empty' }
  try {
    const bytes = decodeIdentifier(t)
    // the canonical form: an audience lists ids exactly as the artifact writes them
    if (bytes.length === 32) return { kind: 'id', id: base58Encode(bytes) }
  } catch {
    // not an id: maybe a name
  }
  return looksLikeDpnsName(t) ? { kind: 'name', name: displayDpnsName(t) } : { kind: 'invalid', error: NOT_A_PERSON }
}

/** The text shown for a name that does not exist. */
export const unknownName = (name: string): string => `No DPNS name ${name} was found.`

/** The text shown when the lookup itself failed. */
export const NAME_LOOKUP_FAILED = "Couldn't look that name up. Try again."

/** The identity `name` (`label.parent`) belongs to, or null when no such name exists. Rejects when the read fails. */
export async function lookUpName(sdk: EvoSDK, name: string, network: Network): Promise<string | null> {
  return (await resolveDpnsIds(sdk, [name], network)).get(name) ?? null
}

/** `text` resolved to an identity id (and the name it was given by, if any), or why not. */
export async function resolvePerson(
  sdk: EvoSDK,
  network: Network,
  text: string,
): Promise<{ readonly id: string; readonly name: string | null } | { readonly error: string }> {
  const input = parsePersonInput(text)
  if (input.kind === 'id') return { id: input.id, name: null }
  if (input.kind === 'invalid') return { error: input.error }
  if (input.kind === 'empty') return { error: NOT_A_PERSON }
  try {
    const id = await lookUpName(sdk, input.name, network)
    return id === null ? { error: unknownName(input.name) } : { id, name: input.name }
  } catch {
    return { error: NAME_LOOKUP_FAILED }
  }
}
