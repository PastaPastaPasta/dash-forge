'use client'

/**
 * How many of each listed thread's comments are members-only (DESIGN §4.1: "3 comments (2
 * members-only)"), read once per distinct set of threads and counts. The rows paint with their
 * plain count first; the label arrives with the read, and a repo without members-only content
 * (the usual one) reads nothing. A failed read leaves the plain counts.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { useAsync } from '@/hooks/use-async'
import { repoKey, type RepoRef } from '@/lib/repo/contract'
import { membersOnlyCommentCounts, type CommentedThread } from '@/lib/repo/members-only-comments'

const NONE: ReadonlyMap<string, number> = new Map()

export function useMembersOnlyComments(sdk: EvoSDK | null, ready: boolean, repo: RepoRef, rows: readonly CommentedThread[] | undefined): ReadonlyMap<string, number> {
  const commented = (rows ?? []).filter((r) => (r.comments ?? 0) > 0)
  const key = commented.map((r) => `${r.id}:${r.comments}`).join(',')
  const read = useAsync(() => membersOnlyCommentCounts(sdk!, repo, commented).catch(() => NONE), [ready, repoKey(repo), key], {
    enabled: ready && sdk !== null && key !== '',
  })
  return key === '' ? NONE : read.data ?? NONE
}
