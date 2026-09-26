/**
 * The header jump box (`ux-dx-spec.md` §5.2, §5.11): `owner/name`, `owner/name#n`, `@name`
 * (or a bare name / identity id), and `#n` inside a repo, which opens issue or PR n of it.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { DOC, repoSource, type RepoRef } from '../repo'
import { queryDocumentsWithProof } from '../sdk'

export type Jump =
  | { readonly kind: 'repo'; readonly owner: string; readonly name: string; readonly number?: number }
  | { readonly kind: 'number'; readonly number: number }
  | { readonly kind: 'profile'; readonly name: string }
  | { readonly kind: 'invalid'; readonly message: string }

const NUMBER = /^#(\d{1,10})$/
const REPO = /^@?([^\s/#@]+)\/([^\s/#]+?)(?:#(\d{1,10}))?$/
const PROFILE = /^@?([^\s/#@]+)$/

/** Parse what was typed. `inRepo`: the page is a repo page, so `#n` has a repo to mean. */
export function parseJump(input: string, inRepo: boolean): Jump | null {
  const q = input.trim()
  if (q === '') return null
  const n = NUMBER.exec(q)
  if (n) {
    if (!inRepo) return { kind: 'invalid', message: '#n works inside a repo; try owner/name#n' }
    return { kind: 'number', number: Number(n[1]) }
  }
  const r = REPO.exec(q)
  if (r) {
    const owner = r[1] ?? ''
    return r[3] === undefined ? { kind: 'repo', owner, name: r[2] ?? '' } : { kind: 'repo', owner, name: r[2] ?? '', number: Number(r[3]) }
  }
  const p = PROFILE.exec(q)
  if (p) return { kind: 'profile', name: p[1] ?? '' }
  return { kind: 'invalid', message: 'type owner/name, @name, or #n inside a repo' }
}

/** Which of issue n and PR n exist in `repo` (a `(repoId, number)` lookup each). */
export async function numberTargets(sdk: EvoSDK, repo: RepoRef, number: number): Promise<{ issue: boolean; pull: boolean }> {
  const exists = async (type: string): Promise<boolean> => {
    const { documents } = await queryDocumentsWithProof(sdk, repoSource(repo).repoQuery(type, { where: [['number', '==', number]], limit: 1 }))
    return documents.length > 0
  }
  const [issue, pull] = await Promise.all([exists(DOC.issue), exists(DOC.patch)])
  return { issue, pull }
}
