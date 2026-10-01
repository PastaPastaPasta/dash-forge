'use client'

/**
 * PullMerge — the merge panel wired to a PR: both repos' readers (the base, and the fork the
 * head lives in), the base branch's tip, and the repo's protected patterns.
 */

import { useState } from 'react'

import type { PullView, RepoRef } from '@/lib/repo'
import { tipOidOf, type RepoHome } from '@/lib/view'
import { mergeBaseTip, mergeBoxShown, mergeBoxSlot } from '@/lib/view/pull-actions'
import type { SquashAuthors } from '@/lib/merge/engine'
import { MergePanel, type CloseIssuesOption, type DeleteBranchOption } from '@/components/repo/merge-panel'
import { pullBase, useComparisonSides } from '@/components/repo/pull-diff'

/**
 * Where the PR page puts the merge box on `tab` ({@link mergeBoxSlot}), and the callback that
 * tells it a merge is running (pass it as `extras.onRunning`).
 */
export function useMergeSlot(tab: string, draft: boolean): { slot: 'shown' | 'kept' | 'none'; running: boolean; onRunning: (running: boolean) => void } {
  const [running, setRunning] = useState(false)
  // The tab a merge last ran on: its outcome stays on screen there until the merger moves on.
  const [ranOn, setRanOn] = useState<string | null>(null)
  if (running && ranOn !== tab) setRanOn(tab)
  return {
    slot: mergeBoxSlot({ onConversation: tab === 'conversation', draft, running, ranOnPage: ranOn !== null, ranOnThisTab: ranOn === tab }),
    running,
    onRunning: setRunning,
  }
}

export function PullMerge({
  repo,
  home,
  pull,
  canMerge,
  isMaintainer,
  checkout,
  onMerged,
  extras = {},
}: {
  repo: RepoRef
  home: RepoHome
  pull: PullView
  canMerge: boolean
  isMaintainer: boolean
  checkout: string
  onMerged: () => void
  /** Review-parity additions: allowed methods, squash authors, delete the branch after merging. */
  extras?: MergeExtras
}): JSX.Element | null {
  // Once shown, the panel stays for the rest of this page view: a merge in it refreshes the PR,
  // which then reads Merged (and `canMerge` turns false) while the panel still has its last steps
  // to report and the branch to delete. Unmounting it there would drop both silently.
  const [shownBefore, setShownBefore] = useState(canMerge)
  const shown = mergeBoxShown(canMerge, shownBefore)
  if (shown && !shownBefore) setShownBefore(true)
  // Only a maintainer or writer resolves the readers the merge needs.
  if (!shown) return null
  return <MergeReaders repo={repo} home={home} pull={pull} isMaintainer={isMaintainer} checkout={checkout} onMerged={onMerged} extras={extras} />
}

/** What the PR page adds to the merge panel. */
export interface MergeExtras {
  readonly allowedMethods?: number
  readonly squashAuthors?: SquashAuthors
  readonly deleteBranch?: DeleteBranchOption | null
  /** Close the open issues the description links ("Fixes #12") after merging. */
  readonly closeIssues?: CloseIssuesOption | null
  readonly onRunning?: (running: boolean) => void
  /** False while the page keeps the box mounted but hidden (no merge check runs then). */
  readonly active?: boolean
  /** The branch rules the PR does not meet; the merge stays disabled unless bypassed. */
  readonly unmetRules?: readonly string[]
  /** The merger may bypass them (a maintainer). */
  readonly canBypass?: boolean
  /** The source branch is past the PR head: the merge waits for "Update PR head" (QW3-013). */
  readonly branchAhead?: { readonly branch: string; readonly tip: string } | null
  /** Re-read the source branch right before merging: why not to, or null. */
  readonly checkSourceBranch?: () => Promise<string | null>
  /** "Delete the branch after merging" deleted it. */
  readonly onBranchDeleted?: () => void
}

function MergeReaders({
  repo,
  home,
  pull,
  isMaintainer,
  checkout,
  onMerged,
  extras,
}: {
  repo: RepoRef
  home: RepoHome
  pull: PullView
  isMaintainer: boolean
  checkout: string
  onMerged: () => void
  extras: MergeExtras
}): JSX.Element | null {
  const { sides, baseOnly, sidesKey } = useComparisonSides(repo, pull.sourceId)
  // Build only on the base as it stands now, and only on a base the PR could merge into (D-501);
  // `pullBase` falls back to the PR's historical tip, which is right for the diff only.
  const { baseRefName } = pullBase(pull, home)
  const current = tipOidOf(home.branches.find((b) => b.refName === baseRefName))
  return (
    <MergePanel
      repo={repo}
      pull={pull}
      sides={sides}
      baseOnly={baseOnly}
      sidesKey={sidesKey}
      baseTipOid={mergeBaseTip(pull, baseRefName, current)}
      protectedPatterns={home.config?.protectedPatterns ?? []}
      canMerge
      isMaintainer={isMaintainer}
      checkout={checkout}
      onMerged={onMerged}
      {...(extras.allowedMethods !== undefined ? { allowedMethods: extras.allowedMethods } : {})}
      {...(extras.squashAuthors !== undefined ? { squashAuthors: extras.squashAuthors } : {})}
      {...(extras.deleteBranch !== undefined ? { deleteBranch: extras.deleteBranch } : {})}
      {...(extras.closeIssues !== undefined ? { closeIssues: extras.closeIssues } : {})}
      {...(extras.onRunning !== undefined ? { onRunning: extras.onRunning } : {})}
      {...(extras.active !== undefined ? { active: extras.active } : {})}
      {...(extras.unmetRules !== undefined ? { unmetRules: extras.unmetRules } : {})}
      {...(extras.canBypass !== undefined ? { canBypass: extras.canBypass } : {})}
      {...(extras.branchAhead !== undefined ? { branchAhead: extras.branchAhead } : {})}
      {...(extras.checkSourceBranch !== undefined ? { checkSourceBranch: extras.checkSourceBranch } : {})}
      {...(extras.onBranchDeleted !== undefined ? { onBranchDeleted: extras.onBranchDeleted } : {})}
    />
  )
}
