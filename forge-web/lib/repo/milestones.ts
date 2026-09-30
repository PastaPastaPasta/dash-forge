/**
 * Milestones (forge-collab `milestone`, C-1): member-gated definitions, newest per title wins
 * (FORGE_RULES_V2 `foldMilestonesV2`). An issue or PR joins one with a member event (kind 17,
 * the title as its value).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { foldMilestonesV2, type Milestone, type MilestoneDoc, type MilestoneItem } from '../rules/parity'
import { deleteDocumentIdempotent, queryAllDocuments, type PlainDocument, type WriteAuth, type WriteResult } from '../sdk'
import { utf8Length } from '../view/issue-query'
import { DOC, num, str, type RepoRef } from './contract'
import { repoSource } from './source'
import { contractFor, writeRepoDoc } from './writes'

/** Every `milestone` document of `repo` (all definitions, oldest first per title). */
function readMilestoneDocs(sdk: EvoSDK, repo: RepoRef): Promise<PlainDocument[]> {
  return queryAllDocuments(sdk, repoSource(repo).repoQuery(DOC.milestone, { orderBy: [['repoId', 'asc'], ['title', 'asc'], ['$createdAt', 'asc']] }))
}

function milestoneDocOf(d: PlainDocument): MilestoneDoc {
  return {
    id: str(d, '$id'),
    title: str(d, 'title'),
    description: str(d, 'description'),
    dueOn: typeof d['dueOn'] === 'number' ? d['dueOn'] : null,
    closed: d['closed'] === true,
    createdAt: num(d, '$createdAt'),
  }
}

/** A repo's milestones with their progress over `items` (each issue's open state and milestone). */
export async function readMilestones(sdk: EvoSDK, repo: RepoRef, items: readonly MilestoneItem[] = []): Promise<Milestone[]> {
  return foldMilestonesV2((await readMilestoneDocs(sdk, repo)).map(milestoneDocOf), items)
}

/** A milestone's definition documents' ids and signers, by title (a definition is deletable by its owner only). */
export async function readMilestoneOwners(sdk: EvoSDK, repo: RepoRef): Promise<Map<string, { readonly id: string; readonly owner: string }[]>> {
  const out = new Map<string, { id: string; owner: string }[]>()
  for (const d of await readMilestoneDocs(sdk, repo)) {
    const title = str(d, 'title')
    const list = out.get(title) ?? []
    list.push({ id: str(d, '$id'), owner: str(d, '$ownerId') })
    out.set(title, list)
  }
  return out
}

/** The `milestone` schema's bounds. */
export const MILESTONE_LIMITS = { title: 63, titleBytes: 252, description: 1000, descriptionBytes: 2000 } as const

/** What a milestone definition says. */
export interface MilestoneInput {
  readonly title: string
  readonly description?: string
  /** The due day, ms since the epoch at UTC midnight, or null for none. */
  readonly dueOn?: number | null
  readonly closed?: boolean
}

/** Refuse a definition the schema would refuse, with a reason, before anything is signed. */
export function checkMilestoneInput(input: MilestoneInput): void {
  const title = input.title.trim()
  if (title === '') throw new Error('a milestone needs a title')
  if ([...title].length > MILESTONE_LIMITS.title || utf8Length(title) > MILESTONE_LIMITS.titleBytes) throw new Error(`a milestone title is at most ${MILESTONE_LIMITS.title} characters`)
  const d = input.description ?? ''
  if ([...d].length > MILESTONE_LIMITS.description || utf8Length(d) > MILESTONE_LIMITS.descriptionBytes) throw new Error(`a milestone description is at most ${MILESTONE_LIMITS.description} characters`)
  if (input.dueOn != null && (!Number.isSafeInteger(input.dueOn) || input.dueOn < 0)) throw new Error('a due date is a day on or after 1970-01-01')
}

/** `YYYY-MM-DD` as ms since the epoch at UTC midnight (the CLI's `parse_day`), or null when it is not a real day. */
export function dueOnOf(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const at = Date.UTC(y, mo - 1, d)
  const back = new Date(at)
  if (y < 1970 || back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return at
}

/** A due date as `YYYY-MM-DD` (UTC), for a date input. */
export function dayOf(dueOn: number): string {
  return new Date(dueOn).toISOString().slice(0, 10)
}

/**
 * Define (or redefine: the newest definition per title wins) a milestone: one `milestone`
 * document (maintainers and writers only at consensus). Parity: forge-core
 * `Collab::define_milestone`. A private repo's milestones are sealed, which neither client does
 * yet, so it is refused there rather than written in plaintext.
 */
export async function defineMilestone(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, input: MilestoneInput & { intent?: string }): Promise<WriteResult> {
  if (repo.visibility === 'private') throw new Error('milestones in a private repository are sealed; this build does not seal them yet')
  checkMilestoneInput(input)
  const data: Record<string, unknown> = { title: input.title.trim(), closed: input.closed ?? false }
  if (input.description) data['description'] = input.description
  if (input.dueOn != null) data['dueOn'] = input.dueOn
  return writeRepoDoc(sdk, auth, repo, DOC.milestone, data, input.intent)
}

/**
 * Delete milestone `title`: the signer's definition documents of it. A `milestone` document is
 * deletable by its owner only, and the newest definition per title wins, so deleting only the
 * signer's while another member's remain would bring an older definition back: that case is
 * refused (close it instead, or ask them). The issues and PRs in it keep the milestone in their
 * history. Returns how many documents were deleted.
 */
export async function deleteMilestone(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, title: string): Promise<number> {
  const defs = (await readMilestoneOwners(sdk, repo)).get(title) ?? []
  if (defs.some((d) => d.owner !== auth.identityId)) {
    throw new Error('another member also defined this milestone, and only they can delete their definition: close it instead, or ask them')
  }
  for (const d of defs) {
    await deleteDocumentIdempotent(sdk, auth, { contractId: contractFor(repo, DOC.milestone), documentType: DOC.milestone, documentId: d.id, repo: repo.repoId })
  }
  return defs.length
}
