/**
 * "Compare & pull request" (#451, qa5 stream C): the branches the signed-in identity pushed in the
 * last hour, as GitHub offers them on a repository's home and its pull request list.
 *
 * Everything here comes from the repo home the page already holds: every branch's resolved tip
 * carries the update that set it, its pusher (`$ownerId`) and its consensus time (`$createdAt`;
 * `lib/rules/resolveRef.ts`). So finding the candidates costs no request. Whether one already has
 * an open PR is the one read the banner makes, and only when there is a candidate
 * (`lib/repo/branch-pulls.ts`).
 *
 * Not offered: the default branch, tags, deleted or diverged branches, a branch whose tip is the
 * default branch's (nothing to compare), a branch someone else moved last, an archived repo (it
 * takes no new PR), a private repo (its PRs' branch hashes are keyed, so the open-PR check cannot
 * read them), and a home that holds the default branch alone (`refsPartial`: a PR list whose
 * repo's ref updates are past one page; reading them all would cost the list requests).
 */

import { isNullOid } from '../rules'
import type { ResolvedRef } from '../repo'
import type { RepoHome } from './repo-view'
import { branchName } from './format'

/** How long after a push its branch is offered: GitHub's "recent pushes" hour. */
export const RECENT_PUSH_MS = 60 * 60_000

/** Branches offered at most, newest push first (each is a banner; their open PRs are one read). */
export const RECENT_PUSH_MAX = 3

/** A branch the viewer pushed recently. */
export interface RecentPush {
  /** `refs/heads/…` */
  readonly refName: string
  /** The short name shown, `feature/x`. */
  readonly branch: string
  /** The tip the viewer pushed: a dismissal holds for this tip only. */
  readonly tip: string
  /** When (consensus `$createdAt`, ms). */
  readonly pushedAt: number
}

/** The branches of `home` that `viewer` pushed within {@link RECENT_PUSH_MS} of `now`, newest first. */
export function recentPushes(
  home: Pick<RepoHome, 'repo' | 'branches' | 'defaultBranch' | 'config' | 'refsPartial'>,
  viewer: string | null,
  now: number,
): RecentPush[] {
  if (viewer === null || home.repo.visibility !== 'public' || home.refsPartial === true || home.config?.archived === true) return []
  const defaultRef = `refs/heads/${home.defaultBranch}`
  const defaultTip = tipOf(home.branches.find((b) => b.refName === defaultRef))
  const out: RecentPush[] = []
  for (const b of home.branches) {
    const st = b.state
    if (!b.refName.startsWith('refs/heads/') || b.refName === defaultRef || st.state !== 'resolved') continue
    if (st.author !== viewer || isNullOid(st.oid) || st.oid === defaultTip) continue
    // A time slightly in the future (clock skew) is recent; one past the hour is not.
    if (now - st.createdAt > RECENT_PUSH_MS) continue
    out.push({ refName: b.refName, branch: branchName(b.refName), tip: st.oid, pushedAt: st.createdAt })
  }
  return out.sort((a, b) => b.pushedAt - a.pushedAt || (a.refName < b.refName ? -1 : 1)).slice(0, RECENT_PUSH_MAX)
}

function tipOf(ref: ResolvedRef | undefined): string | null {
  return ref?.state.state === 'resolved' ? ref.state.oid : null
}

/** The key a dismissal is kept under: this repo's branch at this tip (a new push offers it again). */
export function recentPushKey(repoId: string, push: Pick<RecentPush, 'refName' | 'tip'>): string {
  return `${repoId}:${push.refName}@${push.tip}`
}

/** Dismissals kept at most (oldest dropped first): one per push, and pushes are an hour's news. */
export const DISMISSED_MAX = 100

/** `kept` with `key` added last, each once, at most {@link DISMISSED_MAX}. */
export function withDismissed(kept: readonly string[], key: string): string[] {
  return [...kept.filter((k) => k !== key), key].slice(-DISMISSED_MAX)
}
