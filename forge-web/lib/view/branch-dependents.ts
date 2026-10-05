/**
 * The warning before a branch is deleted while open pull requests use it (as GitHub's "Delete
 * branch" warns): which PRs, how each uses it, and what deleting it does to them. Read on delete,
 * never on page load (`openPullsOnBranch`).
 */

import type { PullOnBranch } from '../repo/pull-index'
import { plural } from './format'

/** A delete's dependent PRs as read: the PRs, or why they could not be read. */
export type Dependents = { readonly pulls: readonly PullOnBranch[]; readonly searched: number | null } | { readonly error: string }

const MAX_NAMED = 5

/**
 * The confirm's warning, or null when no open PR uses the branch. `name` is the short branch
 * name.
 */
export function dependentsWarning(name: string, d: Dependents): string | null {
  if ('error' in d) return `Couldn't check whether open pull requests use ${name}: ${d.error}.`
  const partial = d.searched !== null ? ` (of the newest ${d.searched} pull requests)` : ''
  if (d.pulls.length === 0) return d.searched !== null ? `No open pull request among the newest ${d.searched} uses ${name}.` : null
  const named = d.pulls
    .slice(0, MAX_NAMED)
    .map((p) => `#${p.number} ${p.title || '(untitled)'} (${p.uses === 'base' ? 'merges into it' : 'its source branch'})`)
    .join('; ')
  const more = d.pulls.length > MAX_NAMED ? `; and ${d.pulls.length - MAX_NAMED} more` : ''
  const bases = d.pulls.some((p) => p.uses === 'base')
  const heads = d.pulls.some((p) => p.uses === 'head')
  const effects = [
    bases ? "A pull request whose base branch is deleted can't be merged until its base is changed (Edit base on the pull request)." : '',
    heads ? 'A pull request whose source branch is deleted stops following new pushes.' : '',
  ]
    .filter((x) => x !== '')
    .join(' ')
  return `${plural(d.pulls.length, 'open pull request')} use${d.pulls.length === 1 ? 's' : ''} ${name}${partial}: ${named}${more}. ${effects}`
}

/** Whether the confirm must say "Delete anyway": an open PR uses the branch. */
export function deleteNeedsForce(d: Dependents | null): boolean {
  return d !== null && !('error' in d) && d.pulls.length > 0
}
