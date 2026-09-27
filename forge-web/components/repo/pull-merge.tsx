'use client'

/**
 * PullMerge — the merge panel wired to a PR: both repos' readers (the base, and the fork the
 * head lives in), the base branch's tip, and the repo's protected patterns.
 */

import type { PullView, RepoRef } from '@/lib/repo'
import type { RepoHome } from '@/lib/view'
import { MergePanel } from '@/components/repo/merge-panel'
import { pullBase, useComparisonSides } from '@/components/repo/pull-diff'

export function PullMerge({
  repo,
  home,
  pull,
  canMerge,
  isMaintainer,
  checkout,
  onMerged,
}: {
  repo: RepoRef
  home: RepoHome
  pull: PullView
  canMerge: boolean
  isMaintainer: boolean
  checkout: string
  onMerged: () => void
}): JSX.Element | null {
  const { sides, sidesKey } = useComparisonSides(repo, pull.sourceId)
  if (!canMerge) return null
  return (
    <MergePanel
      repo={repo}
      pull={pull}
      sides={sides}
      sidesKey={sidesKey}
      baseTipOid={pullBase(pull, home).baseTipOid}
      protectedPatterns={home.config?.protectedPatterns ?? []}
      canMerge={canMerge}
      isMaintainer={isMaintainer}
      checkout={checkout}
      onMerged={onMerged}
    />
  )
}
