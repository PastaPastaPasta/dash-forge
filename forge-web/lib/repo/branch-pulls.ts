/**
 * Which of a few recently pushed branches a PR already covers (#451, "Compare & pull request"): the
 * question the recently-pushed-branch banner asks before it offers to open one, answered in ONE
 * proved round trip.
 *
 * The composite's page is the branches' PRs, filed in any repository and in any state, on
 * forge-collab's `sourceRef` index `(sourceRepoId, sourceRefNameHash)` with `sourceRefNameHash in
 * [the branches]` (as forge-core's `patches_from_branch` and the branch-delete check
 * `openPullsFromBranch` read it, one branch at a time there); its one sub-query is those PRs'
 * transitions, the `perTarget` lookup bound `$id → targetId`. A PR's state code is the sum of its
 * transitions' `delta` (consensus accepts a transition only as a legal move from the current state;
 * `lib/repo/transitions.ts`, `STATE-COUNTS.md` §2), the sum the PR list's proved sum query
 * (`readThreadStates`) reads, so the page's states need no second request.
 *
 * A push is covered, as on GitHub, by a PR from its branch that is open (the push updates it), or
 * that was opened at or after the push, or whose head is the pushed tip: a PR opened from the banner
 * and merged or closed within the hour does not bring the banner back.
 *
 * A PR opened upstream from a fork's branch is filed in the upstream's index, which the fork's own
 * PR list never holds: the `sourceRef` page finds it all the same. A page or lookup that came back
 * full may have left rows out, so the answer is null then (unknown): the banner stays hidden rather
 * than offer a PR that may exist.
 *
 * Public repos only, and public PRs only: a sealed patch (a private repo's, or a members-only PR on a
 * public repo) files its `sourceRefNameHash` as a keyed HMAC under its epoch
 * (`docs/security/private-repos.md` §4.5, `lib/repo/private-writes.ts`), which `sha256(name)` never
 * matches.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { bytesToHex } from '@noble/hashes/utils.js'

import { hexToBase64, type PlainDocument } from '../sdk'
import { compositeOf, queryComposite } from '../sdk/composite'
import { statusOfCode, threadStateOf } from '../rules/transition'
import { DOC, asIdentifierString, byteFieldToHex, num, str, type RepoRef } from './contract'
import { refNameHash } from './push'
import { repoSource } from './source'

/** The protocol's per-query cap: a page or lookup this long may have more rows than it holds. */
const PAGE = 100

/** A push the banner may offer: its branch, the tip it set, and when. */
export interface BranchPush {
  /** `refs/heads/…` */
  readonly refName: string
  /** The pushed tip (hex). */
  readonly tip: string
  /** Consensus `$createdAt` of the push (ms). */
  readonly pushedAt: number
}

/**
 * The branches of `pushes` (at most a few) of the public `repo` whose push a PR already covers (see
 * the module doc); null when the answer is not complete. One composite request; none for no push.
 */
export async function coveredPushes(sdk: EvoSDK, repo: RepoRef, pushes: readonly BranchPush[]): Promise<ReadonlySet<string> | null> {
  if (repo.visibility !== 'public') return null
  if (pushes.length === 0) return new Set()
  const byHash = new Map(pushes.map((p) => [bytesToHex(refNameHash(p.refName)), p]))
  const page = repoSource(repo).targetQuery(DOC.patch, {
    where: [
      ['sourceRepoId', '==', repo.repoId],
      // An `in` takes its values sorted and once each, as the proved sum reads do.
      ['sourceRefNameHash', 'in', [...byHash.keys()].sort().map(hexToBase64)],
    ],
    orderBy: [
      ['sourceRepoId', 'asc'],
      ['sourceRefNameHash', 'asc'],
    ],
  })
  const res = await queryComposite(
    sdk,
    // The transitions live in the page's contract (forge-collab).
    compositeOf(page, PAGE, [{ documentType: DOC.transition, bind: { sourceProperty: '$id', field: 'targetId' }, orderBy: [['targetId', 'asc']], limit: PAGE }]),
    // eslint-disable-next-line no-console
    { onFallback: () => console.warn('[forge] the recent-push composite was refused; read with plain queries instead') },
  )
  const lookup = res.subs[0]
  // A missing lookup would read every PR as open: not an answer.
  if (lookup?.kind !== 'documents' || res.page.length >= PAGE || lookup.documents.length >= PAGE) return null
  const sums = new Map<string, number>()
  for (const t of lookup.documents) {
    const target = asIdentifierString(t['targetId'])
    sums.set(target, (sums.get(target) ?? 0) + num(t, 'delta'))
  }
  const covered = new Set<string>()
  for (const d of res.page) {
    const push = pushOf(d, byHash)
    if (push === null) continue
    const open = statusOfCode(threadStateOf(sums.get(str(d, '$id')) ?? 0).code).open
    if (open || num(d, '$createdAt') >= push.pushedAt || byteFieldToHex(d, 'headOid') === push.tip) covered.add(push.refName)
  }
  return covered
}

/**
 * The push a PR document's branch is, of those asked: the one whose name hash it carries, when its
 * `sourceRefName` is that name (a document whose name disagrees with its hash is malformed, as
 * forge-core's `patches_from_branch` holds) or is sealed (`enc` set, no plain name: a v0x03 patch
 * that kept the public hash, `lib/private/doc.ts`). Null for anything else.
 */
function pushOf(d: PlainDocument, byHash: ReadonlyMap<string, BranchPush>): BranchPush | null {
  const asked = byHash.get(byteFieldToHex(d, 'sourceRefNameHash'))
  if (asked === undefined) return null
  const name = str(d, 'sourceRefName')
  return name === asked.refName || (name === '' && byteFieldToHex(d, 'enc') !== '') ? asked : null
}
