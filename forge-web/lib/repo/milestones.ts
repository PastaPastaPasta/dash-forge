/**
 * Milestones (forge-collab `milestone`, C-1): member-gated definitions, newest per title wins
 * (FORGE_RULES_V2 `foldMilestonesV2`). An issue or PR joins one with a member event (kind 17,
 * the title as its value).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { foldMilestonesV2, type Milestone, type MilestoneDoc, type MilestoneItem } from '../rules/parity'
import { queryAllDocuments } from '../sdk'
import { DOC, num, str, type RepoRef } from './contract'
import { repoSource } from './source'

/** A repo's milestones with their progress over `items` (each issue's open state and milestone). */
export async function readMilestones(sdk: EvoSDK, repo: RepoRef, items: readonly MilestoneItem[] = []): Promise<Milestone[]> {
  const docs = await queryAllDocuments(
    sdk,
    repoSource(repo).repoQuery(DOC.milestone, { orderBy: [['repoId', 'asc'], ['title', 'asc'], ['$createdAt', 'asc']] }),
  )
  const rows: MilestoneDoc[] = docs.map((d) => ({
    id: str(d, '$id'),
    title: str(d, 'title'),
    description: str(d, 'description'),
    dueOn: typeof d['dueOn'] === 'number' ? d['dueOn'] : null,
    closed: d['closed'] === true,
    createdAt: num(d, '$createdAt'),
  }))
  return foldMilestonesV2(rows, items)
}
