/**
 * Mirrors keep dense native numbers and record the source forge's number in `upstreamNumber`
 * (`forge-v2.md` §6, WIPE-DECISIONS D-2): the page shows "#12 · upstream #7761", and a `#7761`
 * in a mirrored body means the source's #7761, found through the sparse `upstream (repoId,
 * upstreamNumber)` index.
 *
 * `upstreamNumber` is a free field anyone can write on their own issue, so it is trusted only
 * from the repo owner (the mirror signer) or a current maintainer or writer (ISS-02,
 * `trustedUpstreamNumber`). An item a stranger labelled `upstreamNumber: 7761` neither shows the
 * label nor answers `#7761`.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { DOC, num, repoSource, str, type RepoRef } from '../repo'
import { RoleOracle, trustedUpstreamNumber, type Membership } from '../rules/v2'
import { queryDocumentsWithProof } from '../sdk'

/** The upstream number to show beside `#number`, or null (none, or not from a trusted writer). */
export function shownUpstreamNumber(
  item: { readonly upstreamNumber: number | null; readonly author: string; readonly number: number },
  repo: Pick<RepoRef, 'ownerId'>,
  members: readonly Membership[],
): number | null {
  const n = trustedUpstreamNumber(item.upstreamNumber, item.author, repo.ownerId, new RoleOracle([...members]))
  // Numbering identically (a fresh mirror of a source with no gaps) needs no label.
  return n === null || n === item.number ? null : n
}

/** The "#12 · upstream #7761" title suffix, or `#12` alone. */
export function numberLabel(number: number, upstream: number | null): string {
  return upstream === null ? `#${number}` : `#${number} · upstream #${upstream}`
}

/**
 * The native number of the issue or PR a mirror recorded as the source's `upstream`, or null:
 * one read per type on the `upstream` index, keeping only rows written by the owner or a
 * current member (the oldest such row, should there be more than one).
 */
export async function resolveUpstreamNumber(
  sdk: EvoSDK,
  repo: RepoRef,
  upstream: number,
  members: readonly Membership[],
): Promise<{ readonly type: 'issue' | 'patch'; readonly number: number } | null> {
  if (!Number.isInteger(upstream) || upstream <= 0) return null
  const oracle = new RoleOracle([...members])
  const source = repoSource(repo)
  const found = await Promise.all(
    (['issue', 'patch'] as const).map(async (type) => {
      const { documents } = await queryDocumentsWithProof(
        sdk,
        source.repoQuery(DOC[type], { where: [['upstreamNumber', '==', upstream]], orderBy: [['upstreamNumber', 'asc']], limit: 10 }),
      )
      return documents
        .filter((d) => trustedUpstreamNumber(num(d, 'upstreamNumber'), str(d, '$ownerId'), repo.ownerId, oracle) !== null)
        .map((d) => ({ type, number: num(d, 'number'), createdAt: num(d, '$createdAt') }))
    }),
  )
  const best = found.flat().sort((a, b) => a.createdAt - b.createdAt || a.number - b.number)[0]
  return best === undefined ? null : { type: best.type, number: best.number }
}

/**
 * Whether `#N` in a body means the source forge's `#N`: text copied from the source (it carries
 * `imported` provenance) by the repo owner (the mirror signer) or a current member. Anyone
 * else's text, and anything written here, uses this repo's own numbers.
 */
export function bodyRefsUpstream(
  item: { readonly imported: boolean; readonly author: string },
  repo: Pick<RepoRef, 'ownerId'>,
  members: readonly Membership[],
): boolean {
  if (!item.imported) return false
  return item.author === repo.ownerId || new RoleOracle([...members]).currentRole(item.author) !== null
}
