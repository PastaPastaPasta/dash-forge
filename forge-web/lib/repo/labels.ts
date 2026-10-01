/**
 * Label definitions (forge-core `label`, `forge-v2.md` §2): member-gated, immutable, newest
 * definition per name wins (the CLI's `Collab::labels`). Applying a label to an issue or PR is
 * an `event` (kind 4/5, `value` = the name), not a field of the label document, so a label
 * that was never defined can still be applied, and the picker shows it without a colour.
 *
 * Labels are plaintext in a private repo too (`docs/security/private-repos.md` §13).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { decodeIdentifier } from '../auth/base58'
import { createDocumentIdempotent, deleteDocumentIdempotent, queryAllDocuments, type PlainDocument, type WriteAuth, type WriteResult } from '../sdk'
import { compareStrings } from '../rules/oid'
import { DOC, num, str, type RepoRef } from './contract'
import { roleClaim } from './role-claim'
import { repoSource } from './source'
import { utf8Length } from '../view/issue-query'
import { luminance } from '../design/avatar'

/** A label's current definition. */
export interface LabelDef {
  readonly name: string
  /** `#rrggbb`, or '' when the definition has none. */
  readonly color: string
  readonly description: string
  readonly retired: boolean
  readonly createdAt: number
  readonly id: string
}

/** The `label` schema's bounds. */
export const LABEL_LIMITS = { name: 30, nameBytes: 60, description: 200, descriptionBytes: 400 } as const

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

/** A label document, flattened (a missing or malformed colour reads as none). */
export function toLabelDef(doc: PlainDocument): LabelDef | null {
  const name = str(doc, 'name')
  if (name === '') return null
  const color = str(doc, 'color')
  return {
    name,
    color: HEX_COLOR.test(color) ? color.toLowerCase() : '',
    description: str(doc, 'description'),
    retired: doc['retired'] === true,
    createdAt: num(doc, '$createdAt'),
    id: str(doc, '$id'),
  }
}

/** Newest definition per name, by `($createdAt, $id)` (parity: forge-core `Collab::labels`), sorted by name. */
export function newestLabels(docs: readonly PlainDocument[]): LabelDef[] {
  const newest = new Map<string, LabelDef>()
  for (const l of docs.map(toLabelDef)) {
    if (l === null) continue
    const held = newest.get(l.name)
    if (held === undefined || l.createdAt > held.createdAt || (l.createdAt === held.createdAt && compareStrings(l.id, held.id) > 0)) {
      newest.set(l.name, l)
    }
  }
  return [...newest.values()].sort((a, b) => compareStrings(a.name.toLowerCase(), b.name.toLowerCase()))
}

/** Every label definition of `repo` (complete), newest per name. */
export async function readLabels(sdk: EvoSDK, repo: RepoRef): Promise<LabelDef[]> {
  const docs = await queryAllDocuments(
    sdk,
    repoSource(repo).repoQuery(DOC.label, { orderBy: [['name', 'asc'], ['$createdAt', 'asc']] }),
  )
  return newestLabels(docs)
}

/** Refuse a definition the schema would refuse, with a reason, before anything is signed. */
export function checkLabelInput(input: { name: string; color?: string; description?: string }): void {
  const name = input.name.trim()
  if (name === '') throw new Error('a label needs a name')
  if ([...name].length > LABEL_LIMITS.name || utf8Length(name) > LABEL_LIMITS.nameBytes) throw new Error(`a label name is at most ${LABEL_LIMITS.name} characters`)
  if (input.color && !HEX_COLOR.test(input.color)) throw new Error('a label colour looks like #1f883d')
  const d = input.description ?? ''
  if ([...d].length > LABEL_LIMITS.description || utf8Length(d) > LABEL_LIMITS.descriptionBytes) throw new Error(`a label description is at most ${LABEL_LIMITS.description} characters`)
}

/**
 * Define (or redefine, or retire) a label: a new `label` document (members only at
 * consensus; the newest per name wins). Parity: forge-core `Collab::create_label`.
 */
export async function defineLabel(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { name: string; color?: string; description?: string; retired?: boolean; intent?: string },
): Promise<WriteResult> {
  checkLabelInput(input)
  const data: Record<string, unknown> = { repoId: decodeIdentifier(repo.repoId), name: input.name.trim(), retired: input.retired ?? false }
  if (input.color) data['color'] = input.color.toLowerCase()
  if (input.description) data['description'] = input.description
  // Writer or triage (`r`), refused before signing for a reader.
  Object.assign(data, await roleClaim(sdk, auth, repo, DOC.label, data))
  return createDocumentIdempotent(sdk, auth, {
    contractId: repo.forge.core,
    documentType: DOC.label,
    data,
    ...(input.intent ? { intent: input.intent } : {}),
  })
}

/** One definition document of a label, with its signer (a definition is deletable by its owner only). */
export interface LabelDocRef {
  readonly id: string
  readonly owner: string
  readonly createdAt: number
  /** A retirement (`retired: true`). */
  readonly retired?: boolean
}

/** Every definition document of label `name` in `repo`, oldest first (the `(repoId, name, $createdAt)` index). */
export async function readLabelDocs(sdk: EvoSDK, repo: RepoRef, name: string): Promise<LabelDocRef[]> {
  const docs = await queryAllDocuments(
    sdk,
    repoSource(repo).repoQuery(DOC.label, { where: [['name', '==', name]], orderBy: [['name', 'asc'], ['$createdAt', 'asc']] }),
  )
  return docs.map((d) => ({ id: str(d, '$id'), owner: str(d, '$ownerId'), createdAt: num(d, '$createdAt'), retired: d['retired'] === true }))
}

/**
 * What {@link deleteLabel} writes for `docs` (a label's definitions) signed by `me`: a retirement
 * first when someone else also defined it, then a delete of each of `me`'s definitions (`mine`).
 * When `me`'s newest definition is already a retirement newer than everyone else's (a retry of a
 * delete whose retirement landed), that retirement is kept and not written again. Nothing for a
 * name with no definitions. The confirm dialog prices this before anything is signed.
 */
export function planLabelDelete(docs: readonly LabelDocRef[], me: string): { readonly retire: boolean; readonly mine: readonly LabelDocRef[] } {
  const mine = docs.filter((d) => d.owner === me)
  if (mine.length === docs.length) return { retire: false, mine }
  const newest = docs.reduce((a, b) => (b.createdAt > a.createdAt || (b.createdAt === a.createdAt && compareStrings(b.id, a.id) > 0) ? b : a))
  if (newest.owner === me && newest.retired === true) return { retire: false, mine: mine.filter((d) => d !== newest) }
  return { retire: true, mine }
}

/**
 * Delete label `name` (parity: forge-core `Collab::delete_label`). A `label` document is
 * deletable by its owner only, so: when every definition of the name is the signer's, they are
 * all deleted (the label is gone); otherwise a retirement is written first (the newest definition
 * wins, so every reader stops offering it) and the signer's older definitions are deleted,
 * keeping that retirement. The labels already on issues and PRs are their history and stay.
 * `retired`: a retirement was written; `deleted`: definition documents removed.
 */
export async function deleteLabel(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  name: string,
  intent?: string,
): Promise<{ readonly retired: boolean; readonly deleted: number }> {
  const { retire: retired, mine } = planLabelDelete(await readLabelDocs(sdk, repo, name), auth.identityId)
  // A replayed retirement (same intent) returns its document id: never delete what was just written.
  const kept = retired ? (await defineLabel(sdk, auth, repo, { name, retired: true, ...(intent ? { intent: `${intent}:retire` } : {}) })).documentId : null
  const doomed = mine.filter((d) => d.id !== kept)
  for (const d of doomed) {
    await deleteDocumentIdempotent(sdk, auth, { contractId: repo.forge.core, documentType: DOC.label, documentId: d.id, repo: repo.repoId })
  }
  return { retired, deleted: doomed.length }
}

/** GitHub's default label palette, offered when defining a label. */
export const LABEL_COLORS: readonly string[] = [
  '#b60205', '#d93f0b', '#fbca04', '#0e8a16', '#006b75', '#1d76db', '#0052cc', '#5319e7',
  '#e99695', '#f9d0c4', '#fef2c0', '#c2e0c6', '#bfdadc', '#c5def5', '#bfd4f2', '#d4c5f9',
]

/** WCAG 2 relative luminance of a `#rrggbb` colour. */
function hexLuminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
  return luminance([r, g, b])
}

/** WCAG 2 contrast ratio between two luminances. */
const ratio = (la: number, lb: number): number => (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)

/** WCAG 2 contrast ratio between two `#rrggbb` colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  return ratio(hexLuminance(a), hexLuminance(b))
}

/** The theme's ink, which the chip's dark text renders as. */
const INK = '#1f2328'
const INK_LUM = hexLuminance(INK)
/** WCAG AA for the chip's 11 px text. */
const AA = 4.5

/**
 * A readable text colour on a label's fill, at least 4.5:1 (WCAG AA) against the colour it
 * actually renders: the theme's ink on light fills, white on dark ones. The ink (#1f2328) is
 * not black, so a mid-tone fill such as #ee0701 or #159818 can fail with both it and white
 * (QW2-067); pure black is used there, since black or white reaches 4.58:1 on any fill.
 * No colour → null (the chip uses the theme's neutral style).
 */
export function labelTextColor(color: string): string | null {
  if (!HEX_COLOR.test(color)) return null
  const fill = hexLuminance(color)
  const ink = ratio(fill, INK_LUM)
  const white = ratio(fill, 1)
  if (ink >= white && ink >= AA) return INK
  if (white >= AA) return '#ffffff'
  return ratio(fill, 0) >= white ? '#000000' : '#ffffff'
}
