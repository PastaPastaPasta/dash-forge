/**
 * The merge box's proved verdict count (RC1 R-16): how many member approvals and member change
 * requests a PR's head holds on chain, in one proved request.
 *
 * Since RC1 a member's approve / request-changes review is verdict 1 / 2 and must carry
 * `asMember` (consensus checked the signer was a maintainer or writer when it was written); a
 * non-member's is 4 / 5. So the collab `review` index `verdicts (patchId, commitOid, verdict)`
 * (`countable`) counts member verdicts on one head directly: `patchId ==, commitOid ==,
 * verdict in [1, 2]` grouped by `verdict`, one `documents.count` (the same `== … in` shape as
 * `perRepoKind` in `transitions.ts`).
 *
 * **It is an upper bound, and it never gates a merge.** It counts documents, not reviewers: a
 * member who approved twice counts twice, one who approved and then requested changes counts on
 * both sides, a dismissed review still counts, and so does a member removed since. The approval
 * fold (`countApprovals` over the PR's readable reviews, then `meetsPolicy`) resolves all of
 * that, and it alone decides whether a writer may merge (`pullActions`). The merge box shows the
 * fold's number and names the proved one "on chain" only where the two differ
 * (`verdictSummary`, `lib/view/pull-actions.ts`).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { isRc1OidHex } from '../rules'
import { countDocumentsGrouped, hexToBase64, uintOfGroupKey, type GroupedQuery } from '../sdk'
import { DOC, type RepoRef } from './contract'
import { repoSource } from './source'
import { VERDICT_INT } from './writes'

/** The member verdicts on one PR head, as consensus proves them (an upper bound; see the module doc). */
export interface ProvedVerdicts {
  /** Head the count is for (lowercase hex). */
  readonly headOid: string
  /** Verdict-1 reviews on the head: member approvals. */
  readonly approvals: number
  /** Verdict-2 reviews on the head: member change requests. */
  readonly changesRequested: number
}

/** The grouped count query for `patchId`'s member verdicts on `headOid` (the `verdicts` index). */
export function verdictsQuery(repo: RepoRef, patchId: string, headOid: string): GroupedQuery {
  return {
    ...repoSource(repo).targetQuery(DOC.review, {
      where: [
        ['patchId', '==', patchId],
        // A byteArray operand is base64 (`lib/sdk/query.ts`).
        ['commitOid', '==', hexToBase64(headOid)],
        ['verdict', 'in', [VERDICT_INT.approve, VERDICT_INT.requestChanges]],
      ],
      orderBy: [['verdict', 'asc']],
    }),
    groupBy: ['verdict'],
  }
}

/**
 * The proved member verdict counts on `headOid` (one request), or null when the PR records no
 * head a review could name (the contract's `oidWidth`: 20 or 32 bytes).
 */
export async function readProvedVerdicts(sdk: EvoSDK, repo: RepoRef, patchId: string, headOid: string): Promise<ProvedVerdicts | null> {
  const head = headOid.toLowerCase()
  if (patchId === '' || !isRc1OidHex(head)) return null
  const counts = await countDocumentsGrouped(sdk, verdictsQuery(repo, patchId, head))
  let approvals = 0
  let changesRequested = 0
  // Decoded at any width, like `readKindCounts`: the key's width follows the integer's sizing.
  for (const [key, n] of counts) {
    const verdict = uintOfGroupKey(key)
    if (verdict === VERDICT_INT.approve) approvals += n
    else if (verdict === VERDICT_INT.requestChanges) changesRequested += n
  }
  return { headOid: head, approvals, changesRequested }
}
