/**
 * Hosted-surface curation (docs/hosted-curation.md): the repos and identities dashhq's own build
 * keeps out of its discovery surfaces and does not open. NOT protocol moderation. The data stays
 * on Dash Platform, `dash://` clones work, and any other client or build shows it. The list is a
 * file in the repository (`forge-contracts/config/curation.json`, read at build time, the same
 * way `storage-defaults.json` is), changed by a pull request and a Pages deploy.
 *
 * Every discovery read goes through {@link dropHidden} / {@link isHiddenRepo}, so one rule holds
 * on the landing page, Explore, topics, the ranked lists, search, and profiles.
 */

import curationFile from '../../../forge-contracts/config/curation.json'
import { base58Decode } from '../auth/base58'
import { ACTIVE_NETWORK } from '../constants'

/** One hidden repo or identity: its id, when it was added, and a short public reason or ticket. */
export interface CurationEntry {
  readonly id: string
  /** `YYYY-MM-DD`. */
  readonly added: string
  readonly note: string
}

export interface NetworkCuration {
  readonly hiddenRepos: readonly CurationEntry[]
  readonly hiddenIdentities: readonly CurationEntry[]
}

/** The curation file by network key (`ACTIVE_NETWORK.key`: `testnet`, `devnet-<name>`, `mainnet`). */
export type CurationFile = Readonly<Record<string, NetworkCuration>>

/** What a hosted build hides: repo document ids and owner identity ids. */
export interface Hidden {
  readonly repos: ReadonlySet<string>
  readonly identities: ReadonlySet<string>
}

const NO_HIDDEN: Hidden = { repos: new Set(), identities: new Set() }

function isId(s: unknown): s is string {
  if (typeof s !== 'string') return false
  try {
    return base58Decode(s).length === 32
  } catch {
    return false
  }
}

function isDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Throws when `rest` (what is left of an object after its known fields) is not empty. */
function rejectUnknown(rest: Record<string, unknown>, at: string): void {
  const fields = Object.keys(rest)
  if (fields.length > 0) throw new Error(`curation.json: ${at} has unknown fields: ${fields.join(', ')}`)
}

function parseEntries(raw: unknown, where: string): CurationEntry[] {
  if (!Array.isArray(raw)) throw new Error(`curation.json: ${where} must be an array`)
  const seen = new Set<string>()
  return raw.map((e, i) => {
    const at = `${where}[${i}]`
    if (!isRecord(e)) throw new Error(`curation.json: ${at} must be an object`)
    const { id, added, note, ...rest } = e
    rejectUnknown(rest, at)
    if (!isId(id)) throw new Error(`curation.json: ${at}.id is not a base58 identifier`)
    if (!isDate(added)) throw new Error(`curation.json: ${at}.added must be a YYYY-MM-DD date`)
    if (typeof note !== 'string' || note.trim() === '' || note.length > 200) throw new Error(`curation.json: ${at}.note must be 1 to 200 characters`)
    if (seen.has(id)) throw new Error(`curation.json: ${at}.id ${id} is listed twice`)
    seen.add(id)
    return { id, added, note }
  })
}

/** Validate the file's contents; throws a message naming the first malformed entry. */
export function parseCuration(raw: unknown): CurationFile {
  if (typeof raw !== 'object' || raw === null) throw new Error('curation.json: must be an object')
  const networks = (raw as Record<string, unknown>)['networks']
  if (!isRecord(networks)) throw new Error('curation.json: "networks" must be an object')
  const out: Record<string, NetworkCuration> = {}
  for (const [key, value] of Object.entries(networks)) {
    if (!isRecord(value)) throw new Error(`curation.json: networks.${key} must be an object`)
    const { hiddenRepos, hiddenIdentities, ...rest } = value
    rejectUnknown(rest, `networks.${key}`)
    out[key] = {
      hiddenRepos: parseEntries(hiddenRepos, `networks.${key}.hiddenRepos`),
      hiddenIdentities: parseEntries(hiddenIdentities, `networks.${key}.hiddenIdentities`),
    }
  }
  return out
}

/** The build's curation. A malformed file fails the build here, never at a visitor's page. */
export const CURATION: CurationFile = parseCuration(curationFile)

/** The ids hidden on `networkKey`; none for a network the file does not list. */
export function hiddenFor(networkKey: string, curation: CurationFile = CURATION): Hidden {
  const c = curation[networkKey]
  if (c === undefined) return NO_HIDDEN
  return { repos: new Set(c.hiddenRepos.map((e) => e.id)), identities: new Set(c.hiddenIdentities.map((e) => e.id)) }
}

/** What this build hides (`ACTIVE_NETWORK`). */
export function activeHidden(): Hidden {
  return hiddenFor(ACTIVE_NETWORK.key)
}

/** Whether the repo (by document id) or its owner is hidden. */
export function isHiddenRepo(repoId: string, ownerId: string, hidden: Hidden = activeHidden()): boolean {
  return hidden.repos.has(repoId) || hidden.identities.has(ownerId)
}

/** Whether the identity is hidden (its profile shows the notice instead of its repos). */
export function isHiddenIdentity(identityId: string, hidden: Hidden = activeHidden()): boolean {
  return hidden.identities.has(identityId)
}

/** `repos` without the hidden ones and the ones of hidden identities. */
export function dropHidden<T extends { readonly key: string; readonly ownerId: string }>(repos: readonly T[], hidden: Hidden = activeHidden()): T[] {
  return repos.filter((r) => !isHiddenRepo(r.key, r.ownerId, hidden))
}

/** Whether this build hides anything (Explore and the repo page say so only then). */
export function curates(hidden: Hidden = activeHidden()): boolean {
  return hidden.repos.size > 0 || hidden.identities.size > 0
}
