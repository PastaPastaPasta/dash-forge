/**
 * Which of a few branches already have an open PR (#451, "Compare & pull request"): the question
 * the recently-pushed-branch banner asks before it offers to open one, answered in ONE proved
 * round trip.
 *
 * The composite's page is the branches' PRs, filed in any repository, on forge-collab's `sourceRef`
 * index `(sourceRepoId, sourceRefNameHash)` with `sourceRefNameHash in [the branches]` (as
 * forge-core's `patches_from_branch` and the branch-delete check `openPullsFromBranch` read it,
 * one branch at a time there); its one sub-query is those PRs' transitions, the `perTarget` lookup
 * bound `$id → targetId`. A PR's state code is the sum of its transitions' `delta` (consensus
 * accepts a transition only as a legal move from the current state; `lib/repo/transitions.ts`,
 * `STATE-COUNTS.md` §2), so the page's states need no second request (the PR list's proved sum
 * query, `readThreadStates`, answers the same sum for pages too big for one lookup).
 *
 * A PR opened upstream from a fork's branch is filed in the upstream's index, which the fork's own
 * PR list never holds: the `sourceRef` page finds it all the same. A page or lookup that came back
 * full may have left rows out, so the answer is null then (unknown): the banner stays hidden
 * rather than offer a PR that may exist.
 *
 * Public repos only. A private repo's (and a members-only PR's) `sourceRefNameHash` is a keyed
 * HMAC under the write epoch (`docs/security/private-repos.md` §4.5, `lib/repo/private-writes.ts`),
 * which `sha256(name)` never matches.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { bytesToHex } from '@noble/hashes/utils.js'

import { hexToBase64, type PlainDocument } from '../sdk'
import { compositeOf, docsAt, queryComposite } from '../sdk/composite'
import { statusOfCode, threadStateOf } from '../rules/transition'
import { DOC, asIdentifierString, byteFieldToHex, num, str, type RepoRef } from './contract'
import { refNameHash } from './push'
import { repoSource } from './source'

/** The protocol's per-query cap: a page or lookup this long may have more rows than it holds. */
const PAGE = 100

/**
 * The branches of `refNames` (`refs/heads/…`, at most a few) of the public `repo` that are the head
 * of an open PR, filed here or upstream; null when the answer is not complete (see the module doc).
 * One composite request; none for an empty list.
 */
export async function branchesWithOpenPulls(sdk: EvoSDK, repo: RepoRef, refNames: readonly string[]): Promise<ReadonlySet<string> | null> {
  if (repo.visibility !== 'public') return null
  const names = [...new Set(refNames)]
  if (names.length === 0) return new Set()
  const hashOf = new Map(names.map((name) => [bytesToHex(refNameHash(name)), name]))
  const page = repoSource(repo).targetQuery(DOC.patch, {
    where: [
      ['sourceRepoId', '==', repo.repoId],
      // An `in` takes its values sorted and once each, as the proved sum reads do.
      ['sourceRefNameHash', 'in', [...hashOf.keys()].sort().map(hexToBase64)],
    ],
    orderBy: [
      ['sourceRepoId', 'asc'],
      ['sourceRefNameHash', 'asc'],
    ],
  })
  const transitions = repoSource(repo).targetQuery(DOC.transition)
  const res = await queryComposite(
    sdk,
    compositeOf(page, PAGE, [
      { dataContractId: transitions.dataContractId, documentType: DOC.transition, bind: { sourceProperty: '$id', field: 'targetId' }, orderBy: [['targetId', 'asc']], limit: PAGE },
    ]),
  )
  const moves = docsAt(res, 0)
  if (res.page.length >= PAGE || moves.length >= PAGE) return null
  const sums = new Map<string, number>()
  for (const t of moves) {
    const target = asIdentifierString(t['targetId'])
    sums.set(target, (sums.get(target) ?? 0) + num(t, 'delta'))
  }
  const open = new Set<string>()
  for (const d of res.page) {
    const name = nameOf(d, hashOf)
    if (name !== null && statusOfCode(threadStateOf(sums.get(str(d, '$id')) ?? 0).code).open) open.add(name)
  }
  return open
}

/**
 * The branch a PR document names, of those asked: its `sourceRefName` when that is the name its hash
 * was asked for (a document whose name disagrees with its hash is malformed, as forge-core's
 * `patches_from_branch` holds), or the asked name for a members-only one, whose name is sealed
 * (`enc` set, no plain name). Null for anything else.
 */
function nameOf(d: PlainDocument, hashOf: ReadonlyMap<string, string>): string | null {
  const asked = hashOf.get(byteFieldToHex(d, 'sourceRefNameHash'))
  if (asked === undefined) return null
  const name = str(d, 'sourceRefName')
  return name === asked || (name === '' && byteFieldToHex(d, 'enc') !== '') ? asked : null
}
