/**
 * A member's view of a PUBLIC repository's refs (`docs/security/private-repos.md` §19.3,
 * mixed-visibility DESIGN §4.3; forge-core `refs::members_updates_of`, pinned by the shared
 * `sealed_ref` union vectors): the union, per ref name, of the public updates (plaintext,
 * `gitPlaneWellFormed`) and the members-only ones (`enc` v0x03, `vis: "public"`) the reader opens,
 * each members-only update taken to its real values with every blind checked.
 *
 * The path is chosen per document, never by the repository's visibility: a plaintext update is
 * folded as written, a sealed one only through `open`. Public names win (D29): a name that is
 * live in public folds its public updates alone, so members and the public read the same public
 * branch. The public reader (`refs.ts`) folds the plaintext updates alone. Pure: nothing here
 * reads the chain or is wired into a page yet.
 */

import { V3, bytesToHex, refOpenedFrom, type OidField, type OpenResult, type StoredPrivateDoc } from '../private'
import { compareKey, compareStrings, resolveRef, type ConfigDoc, type IsAncestor, type RefUpdate } from '../rules'
import type { PlainDocument } from '../sdk'
import { gitPlaneDocWellFormed, str, toRefUpdate } from './contract'
import { bytesField, storedPrivateDoc } from './private-content'
import { publicRefKey } from './refs'

/** Both ref-update types' rows, as the chain returns them. */
export interface RefRows {
  readonly refUpdate: readonly PlainDocument[]
  readonly protectedRefUpdate: readonly PlainDocument[]
}

/** Opens one members-only ref update (`openContent` under the reader's members-key context). */
export type RefOpener = (doc: StoredPrivateDoc) => Promise<OpenResult>

/**
 * Why a members-only ref update is shown with an alert, by its `$id`: a blind that did not check
 * (kept on its real values), or `publicName`, an update naming a branch that is live in public
 * (left out of the fold, D29).
 */
export type RefAlert =
  | { readonly id: string; readonly field: OidField; readonly kind: 'mismatch' | 'width' }
  | { readonly id: string; readonly kind: 'publicName' }

/** What {@link membersUpdatesOf} returns. */
export interface MembersUpdates {
  /**
   * Updates by full ref name, in name order, restated with the public key (`refNameHash =
   * sha256(name)`, the name set, real OIDs) so the public folds apply; each sorted by
   * `($createdAt, $id)`.
   */
  readonly byName: ReadonlyMap<string, readonly RefUpdate[]>
  /** Blind alerts in row order (`refUpdate` rows, then `protectedRefUpdate`), then `publicName` alerts by name, then `($createdAt, $id)`. */
  readonly alerts: readonly RefAlert[]
  /**
   * Members-only updates this reader could not fold (no key, another epoch, late, malformed, a
   * plaintext `refName` beside `enc`, an `enc` version it does not open): counted, never folded.
   */
  readonly unreadable: number
}

const TYPES = [
  ['refUpdate', false],
  ['protectedRefUpdate', true],
] as const

const NO_ANCESTRY: IsAncestor = () => false

function isInteger(v: unknown): boolean {
  return (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) || (typeof v === 'bigint' && v >= 0n)
}

function pushTo(m: Map<string, RefUpdate[]>, name: string, u: RefUpdate): void {
  const group = m.get(name)
  if (group === undefined) m.set(name, [u])
  else group.push(u)
}

/**
 * A member's ref updates of a public repository with members-only branches: the union, per ref
 * name, of the public plaintext updates and the members-only ones `open` reads, on real values.
 * A row with `enc` is members-only when its own `vis` is public (a converted repository's
 * private-era rows are skipped, not counted); it is opened only when it is `enc` v0x03 with an
 * integer epoch and no plaintext `refName`, and counted in `unreadable` otherwise. A name whose
 * public updates resolve (over `configHistory`) to anything but unborn keeps those alone: its
 * members-only updates are dropped with a `publicName` alert each.
 */
export async function membersUpdatesOf(
  rows: RefRows,
  open: RefOpener,
  configHistory: readonly ConfigDoc[] = [],
  isAncestor: IsAncestor = NO_ANCESTRY,
): Promise<MembersUpdates> {
  const publicByName = new Map<string, RefUpdate[]>()
  const membersByName = new Map<string, RefUpdate[]>()
  const alerts: RefAlert[] = []
  let unreadable = 0
  for (const [type, isProtected] of TYPES) {
    for (const doc of rows[type]) {
      const enc = bytesField(doc, 'enc')
      if (enc === undefined || enc.length === 0) {
        const name = doc['refName']
        if (gitPlaneDocWellFormed('refUpdate', doc) && typeof name === 'string') {
          pushTo(publicByName, name, { ...toRefUpdate(doc, isProtected), refNameHash: publicRefKey(name) })
        }
        continue
      }
      // sealed: members-only content only under its own `vis: "public"` stamp
      if (doc['vis'] !== 'public') continue
      const stored = enc[0] === V3 && isInteger(doc['epoch']) && typeof doc['refName'] !== 'string' ? storedPrivateDoc(type, doc, 'public') : null
      if (stored === null) {
        unreadable++
        continue
      }
      const opened = await refOpenedFrom(stored, await open(stored))
      if (opened.status !== 'readable') {
        unreadable++
        continue
      }
      const real = opened.ref
      const id = str(doc, '$id')
      for (const a of real.alerts) alerts.push({ id, field: a.field, kind: a.kind })
      pushTo(membersByName, real.name, {
        ...toRefUpdate(doc, isProtected),
        refNameHash: publicRefKey(real.name),
        refName: real.name,
        newOid: bytesToHex(real.newOid),
        prevOid: real.prevOid === undefined ? '' : bytesToHex(real.prevOid),
      })
    }
  }
  // names in code-point order, which is UTF-8 byte order (forge-core's `BTreeMap<String, _>`)
  const byName = new Map<string, RefUpdate[]>()
  for (const name of [...new Set([...publicByName.keys(), ...membersByName.keys()])].sort(compareStrings)) {
    const pub = [...(publicByName.get(name) ?? [])].sort(compareKey)
    const members = [...(membersByName.get(name) ?? [])].sort(compareKey)
    // public names win (D29): a live public branch is never shadowed by a members-only update
    if (pub.length > 0 && members.length > 0 && resolveRef(pub, configHistory, publicRefKey(name), isAncestor).state !== 'unborn') {
      for (const u of members) alerts.push({ id: u.id, kind: 'publicName' })
      byName.set(name, pub)
    } else {
      byName.set(name, [...pub, ...members].sort(compareKey))
    }
  }
  return { byName, alerts, unreadable }
}
