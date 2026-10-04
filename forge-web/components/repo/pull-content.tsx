'use client'

/**
 * PullContent — a PR (review-parity spec §2.2, §4.4, §4.6, §4.7), laid out as GitHub's:
 *
 * - a header (title with the author's Edit, the state pill, "wants to merge", the head);
 * - tabs with counts — Conversation · Commits · Checks · Files changed — kept in `?tab=`
 *   (short URL `/<owner>/<repo>/pull/<n>/files`);
 * - a right rail: Reviewers (request, re-request, dismiss), Assignees, Labels, Linked issues,
 *   where the objects live and the checkout line;
 * - the head-sync banner: the PR's source branch moved past the PR head → "Update PR head" (a
 *   `headUpdate`); "new commits since your review" for a reviewer whose verdict is on an older head;
 * - draft ↔ ready (author or member), and a draft's merge box replaced by "Ready for review".
 *
 * Every write names its price in a confirm dialog before it is signed, and the page re-reads the
 * PR until the write shows (a node one block behind would otherwise hide it). Who may do what is
 * consensus's (forge-v2.md §3): members post `event`s; the author posts `authorEvent`s of the
 * author kinds (close/reopen, draft/ready, resolve, review requests, head updates) and edits
 * their own PR and comments. In a private repo every edit is re-sealed (`sealEdit`); events are
 * plaintext by design.
 */

import { Byline, ItemAuthor, Time } from '@/components/repo/byline'
import { useMirrorTrust } from '@/hooks/use-mirror-trust'
import { pullOriginOf, trustedOrigin } from '@/lib/repo/provenance'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type SetStateAction } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  AlertTriangle,
  Check,
  Eye,
  FileDiff,
  GitCommit,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  HardDrive,
  Link2,
  ListChecks,
  Lock,
  LockOpen,
  MessageSquare,
  Milestone as MilestoneIcon,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Tag,
  UserPlus,
  X,
  MessageSquareDashed,
} from 'lucide-react'
import { STATE_FILL, STATE_TEXT } from '@/lib/design/state'

import type { PullThread, RepoHome, TimelineItem } from '@/lib/view'
import { ACL_NAME, ARCHIVED_REASON, forkSourcePrefix, loadPullThread, plural, policyOf, pullActions, type CommentView } from '@/lib/view'
import { HiddenBanner, HideMenu, HideThreadControl, hideConfirm, hideCost } from '@/components/repo/moderation'
import { setHidden } from '@/lib/repo/moderation'
import { moderationBlocked } from '@/lib/repo/moderation-fold'
import { isHidden } from '@/lib/view/issues-view'
import type { HideReason } from '@/lib/rules/moderation'
import { bypassValue, deleteBranchOffer, deleteBranchProblem, prLinkedIssues, requiredChecksLine } from '@/lib/view/pull-actions'
import {
  createComment,
  recordPolicyBypass,
  requestRerun,
  commentFirsts,
  createReview,
  LOCKED_REASON,
  lockedOut,
  eventFirsts,
  reviewFirsts,
  deleteComment,
  readDefaultBranch,
  shortBranch,
  MERGE_METHODS,
  writeRefUpdate,
  defineLabel,
  EVENT_KIND_CODE,
  postTargetEvent,
  readViewerPermissions,
  repoContractIds,
  repoKey,
  setAssignee,
  setLabel,
  setLock,
  setMilestone,
  setTargetState,
  updateComment,
  updateTarget,
  type DraftComment,
  type RepoRef,
  type VerdictInput,
} from '@/lib/repo'
import { checksPhrase, expectedChecks, readCheckRuns, requiredSources, summarizeChecks, type ChecksSummary } from '@/lib/repo/checks'
import { branchShown, headSync, readBranchState, readBranchTip, readBranchUpdates, type BranchWrite } from '@/lib/repo/source-branch'
import type { Event, EventKind, Holdings, RefState } from '@/lib/rules'
import { ROLE_NOUN, capabilitiesOf, memberMayWriteEvent } from '@/lib/rules/roles'
import { RoleLimitNote } from '@/components/repo/role-limit-note'
import { isApprover, linkedIssues, RoleOracle, type ChecksState, type Policy, type PolicyStatus } from '@/lib/rules/v2'
import { checksState } from '@/lib/rules/parity'
import { pendingReruns, rerunCounts } from '@/lib/rules/ci-rerun'
import { SupersededWriteError, previewCreate, previewCredits, previewDelete, previewReplace, sumPreviews, withAddressee, type CostPreview as Cost } from '@/lib/sdk'
import { commentEditDrops, pullSinceYourReview } from '@/lib/view/issues-view'
import { totalHidden } from '@/lib/repo/private-content'
import { firstPushers, headUpdatePhrases, sourceBranchEvents, type HeadUpdatePhrase } from '@/lib/view/head-updates'
import { inlineCommentIds, lineKey, repliesByRoot } from '@/lib/view/inline-threads'
import { appliedSuggestions, prCommits, prHaveSet } from '@/lib/view/pr-commits'
import { anchorOnHead } from '@/lib/view/inline-threads'
import { snippetKey, snippetSource } from '@/lib/view/anchor-snippet'
import { carryAnchor, carryFrom, lineMap, type LineMap } from '@/lib/view/carry-anchor'
import type { Anchor } from '@/lib/rules/v2'
import { AnchorContext, useSnippetTexts } from '@/components/repo/anchor-snippet'
import { WALK_COMMIT_CAP } from '@/lib/merge/objects'
import { commentsShown, draftIsEmpty, draftWhereabouts, reviewShows, SUBMIT_WAIT } from '@/lib/view/pending-review'
import { tipOidOf } from '@/lib/view/refs'
import { importedReviewers, type ReviewerCardRow } from '@/lib/view/review-fold'
import { foldMirroredReviews, mirroredCommentText, nestThreadReplies } from '@/lib/view/mirror-review-fold'
import { shownHunk } from '@/lib/view/diff-hunk'
import { BODY_MAX, utf8Length } from '@/lib/view/issue-query'
import { readUntil, retryWhileMissing } from '@/lib/view/retry'
import { forgetShownOwnReviews, ownReviewScope, rememberOwnReview, unshownOwnReviews, type OwnReview } from '@/lib/view/own-reviews'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useIntent } from '@/hooks/use-intent'
import { useFirstWrite } from '@/hooks/use-first-write'
import { useParam, repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { mirrorRepo, useRepoLinks } from '@/components/repo/target-href'
import { importedHost, importedUrlOf } from '@/lib/view/ref-targets'
import { useAuth } from '@/contexts/auth-context'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { TargetNotFound } from '@/components/repo/number-content'
import { CommentOwnActions, Timeline, type CommentSlots } from '@/components/repo/timeline'
import { ComparisonView, pullBase, pullSpec, usePullComparison } from '@/components/repo/pull-diff'
import { CodeOwnersProvider } from '@/components/repo/code-owners'
import { BodyCounter, PrivateComposeNote, SealedLimit, composeCost, composeTooLong, privateComposeBlock } from '@/components/repo/private-compose'
import { LongBodyNote, longEditBlock, useLongCompose, type LongCompose } from '@/components/repo/long-body'
import { numberLabel, resolveUpstreamNumber, shownUpstreamNumber } from '@/lib/view/upstream'
import { MarkdownView, type MarkdownLinks } from '@/components/markdown-view'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Oid } from '@/components/ui/oid'
import { checkMerge } from '@/lib/view/merge-check'
import { headAt, type MergeContent } from '@/lib/rules/merge-content'
import { CopyLinkButton } from '@/components/ui/copy-link'
import { TabStrip } from '@/components/ui/tab-strip'
import { CopyRow } from '@/components/ui/copy-row'
import { Field, Input } from '@/components/ui/input'
import { CostPreview } from '@/components/ui/cost-preview'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { InlineCommentsProvider, SuggestedBody, type SuggestionActions, type ThreadActions } from '@/components/repo/inline-comments'
import { LockToggle, LockedBanner, lockConfirm, lockStateText, lockViewerOf } from '@/components/repo/locked-banner'
import { ReviewDrawer, useReviewDraft } from '@/components/repo/review-drawer'
import { BranchCommitCost, BranchRunContext, CommitIdentityPrompt, buildUpdateBranch, useSourceWrite, useSuggestions } from '@/components/repo/branch-commit-panel'
import { PullMerge, useMergeSlot } from '@/components/repo/pull-merge'
import type { CloseIssuesOption } from '@/components/repo/merge-panel'
import { LINKED_ISSUES_MAX, linkedIssueTargets } from '@/lib/view/jump'
import { EventValuesNote, HiddenNote } from '@/components/repo/hidden-note'
import { EditedMarker, MarkdownEditor } from '@/components/repo/issue-bits'
import { AssigneePicker, LabelPicker, MilestonePicker, SidebarSection, applySetChange, assigneesConfirm, labelsConfirm, setChangeShows, stateToggleLabel, type SetChange } from '@/components/repo/target-rail'
import { readMilestones } from '@/lib/repo/milestones'
import { ReviewersCard } from '@/components/repo/reviewers-card'
import { Approvals, VerdictLine } from '@/components/repo/approvals'
import { ChecksTab, CommitsTab } from '@/components/repo/pull-tabs'
import { abbreviate, cn } from '@/lib/utils'
import { useDpnsName } from '@/hooks/use-dpns-name'

/** No pending review comments (a stable empty list). */
const NO_DRAFTS: readonly DraftComment[] = []
const NO_RUNNERS: ReadonlySet<string> = new Set()

/**
 * While a CI re-run request is pending on the Checks tab, the runs are read again this often, at
 * most {@link RERUN_POLLS} times (a runner polls every 2 minutes by default, or is woken within
 * seconds): the new run then shows without a reload.
 */
const RERUN_POLL_MS = 30_000
const RERUN_POLLS = 20

/** The PR page's tabs (`?tab=`; absent: conversation). */
export const PR_TABS = ['conversation', 'commits', 'checks', 'files'] as const
export type PrTab = (typeof PR_TABS)[number]

/** The tab a `?tab=` value names (anything else: the conversation). */
export function prTabOf(value: string): PrTab {
  return (PR_TABS as readonly string[]).includes(value) ? (value as PrTab) : 'conversation'
}

const VERDICT_TEXT: Readonly<Record<VerdictInput, string>> = {
  approve: 'Approve',
  requestChanges: 'Request changes',
  comment: 'Comment only',
}

/** What the confirm dialog says each verdict records: "Records an approval on …". */
const VERDICT_RECORDS: Readonly<Record<VerdictInput, string>> = {
  approve: 'an approval',
  requestChanges: 'a request for changes',
  comment: 'a comment-only review',
}

/** How the "your review is on Platform" note names a review this tab submitted. */
const OWN_VERDICT: Readonly<Record<OwnReview['verdict'], string>> = { approve: 'approval', requestChanges: 'request for changes', comment: 'review', review: 'review' }

/** The write the confirm dialog is about to sign. */
type Pending =
  /** Close or reopen; with `comment`, the composer's text is posted first ("Close with comment", QW2-008). */
  | { kind: 'state'; to: 'close' | 'reopen'; comment?: string }
  | { kind: 'mark-merged'; bypass: readonly string[] }
  | { kind: 'review'; verdict: VerdictInput; body: string }
  | { kind: 'draft'; to: 'draft' | 'ready' }
  | { kind: 'head'; oid: string }
  | { kind: 'request'; who: string; remove: boolean }
  | { kind: 'dismiss'; row: ReviewerCardRow; reason: string }
  /** A picker's change, applied together behind one confirm (QW2-046). */
  | { kind: 'labels'; change: SetChange }
  | { kind: 'assignees'; change: SetChange }
  | { kind: 'milestone'; title: string | null }
  /** Delete the source branch of a closed PR (QW2-057). */
  | { kind: 'delete-branch'; label: string; run: () => Promise<void> }
  /** Point a closed PR's deleted source branch at its head again (QW3-052). */
  | { kind: 'restore-branch'; label: string; run: () => Promise<void> }
  | { kind: 'define-label'; name: string; color: string; description: string }
  | { kind: 'edit-pull'; title: string; body: string }
  | { kind: 'edit-comment'; id: string; body: string }
  | { kind: 'delete-comment'; id: string }
  | { kind: 'resolve'; root: string; resolve: boolean }
  | { kind: 'lock'; on: boolean }
  /** Ask the runners to re-run one check of the head, or with `check` null every check (event kind 26). */
  | { kind: 'rerun'; check: string | null }
  /** A maintainer hides (or unhides) a comment, a review, or with `item` null the PR (RC2 MOD). */
  | { kind: 'hide'; item: string | null; what: 'comment' | 'review' | 'pull request'; reason: HideReason | null; hide: boolean; closeAndLock?: boolean }

export function PullContent({
  home,
  addr,
  number,
  reloadHome,
}: {
  home: RepoHome
  addr: RepoAddress
  number: number
  /** Re-read the repo home (its refs) and drop its browse context: a browser merge moved a branch. */
  reloadHome?: () => void
}): JSX.Element {
  const { sdk, ready, network } = useSdk(repoContractIds(home.repo))
  // Just opened here: a node one block behind answers "not found"; keep asking briefly.
  const justCreated = useParam('created') === '1'
  // After a write the page re-reads until the write shows (`refresh(expect)`). Expectations
  // accumulate until one read satisfies them all, so two quick writes are both waited for; a newer
  // read aborts the older one's polling (useAsync discards its result anyway).
  const expectations = useRef<((t: PullThread) => boolean)[]>([])
  // A longer wait asked for by the newest write (a submitted review), used for its reads.
  const waitFor = useRef<{ attempts: number; delayMs: number; backoff: number; maxDelayMs: number } | null>(null)
  const current = useRef<{ aborted: boolean }>({ aborted: false })
  // Set by a refresh: from then on the base ref's history is read afresh, not the repo chrome's.
  const refreshed = useRef(false)
  const { data, loading, error, reload } = useAsync<PullThread | null>(
    async () => {
      current.current.aborted = true
      const signal = { aborted: false }
      current.current = signal
      const want = [...expectations.current]
      let latest: PullThread | null = null
      const load = async (): Promise<PullThread | null> => {
        if (signal.aborted) return latest
        latest = await loadPullThread(sdk!, home.repo, number, network, { fresh: refreshed.current })
        return latest
      }
      const first = await retryWhileMissing(load, justCreated ? 8 : 0, undefined, signal)
      // One read on a cold load; re-reads only while a write this page made has not shown (L-77).
      const t = first === null ? null : await readUntil(load, want, { ...(waitFor.current ?? {}), signal, first })
      if (!signal.aborted && t !== null) {
        expectations.current = expectations.current.filter((w) => !w(t))
        if (expectations.current.length === 0) waitFor.current = null
      }
      return t
    },
    [ready, repoKey(home.repo), number, network],
    { enabled: ready && sdk !== null && Number.isFinite(number) },
  )
  const refresh = useCallback(
    (want?: (t: PullThread) => boolean, wait?: { attempts: number; delayMs: number; backoff: number; maxDelayMs: number }) => {
      if (want) expectations.current.push(want)
      if (wait) waitFor.current = wait
      refreshed.current = true
      reload()
    },
    [reload],
  )

  if (!Number.isFinite(number)) return <EmptyState icon={GitPullRequest} title="No PR addressed" body="Add &number= to the URL." />
  if (loading && !data) return <LoadingBlock label="Folding PR" />
  if (error && !data) return <ErrorState message={error} onRetry={reload} />
  if (!data) return <TargetNotFound home={home} addr={addr} number={number} kind="pull" icon={GitPullRequest} title={`PR #${number} not found`} body="No pull request or issue with that number in this repo." />
  return <PullPage home={home} addr={addr} thread={data} refresh={refresh} refreshing={loading} reloadHome={reloadHome} />
}

function PullPage({
  home,
  addr,
  thread,
  refresh,
  refreshing,
  reloadHome,
}: {
  home: RepoHome
  addr: RepoAddress
  thread: PullThread
  refresh: (want?: (t: PullThread) => boolean, wait?: { attempts: number; delayMs: number; backoff: number; maxDelayMs: number }) => void
  refreshing: boolean
  reloadHome?: () => void
}): JSX.Element {
  const { sdk, ready, network } = useSdk(repoContractIds(home.repo))
  const { identity, signer, locked, lockedIdentity } = useAuth()
  // A locked session is still that member (QW2-033): permissions, the merge box and the review
  // controls are read for the identity Unlock would open, and each write opens Unlock (the
  // guard), as the header's "Session locked — Unlock" says. Signed out, there is none.
  const viewer = identity ?? lockedIdentity
  const guard = useWriteGuard()
  // A hidden PR's conversation shows only after "Show it anyway" (RC2 MOD).
  const [threadRevealed, setThreadRevealed] = useState(false)
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const tab = prTabOf(params.get('tab') ?? '')
  const setTab = (t: PrTab): void => {
    const q = new URLSearchParams(params.toString())
    if (t === 'conversation') q.delete('tab')
    else q.set('tab', t)
    router.replace(`${pathname}?${q.toString()}`, { scroll: false })
  }

  const { pull, timeline, review } = thread
  const repo = home.repo
  // Who may mirror: an imported PR of theirs shows its original author, date, base and head (FG-6).
  const trust = useMirrorTrust(repo)
  // A mirrored PR's reviewers as they reviewed on the source forge (QW-017), not the mirror identity.
  const sourceReviewers = useMemo(() => importedReviewers(thread.reviews, trust), [thread.reviews, trust])
  const origin = trustedOrigin(pull.origin, pull.author, trust)
  const pullOrigin = origin !== null ? pullOriginOf(pull.body) : null
  const holdings = useAsync<Holdings | null>(
    () => readViewerPermissions(sdk!, repo, viewer!, network),
    [ready, repoKey(repo), viewer ?? '', network],
    { enabled: ready && sdk !== null && viewer !== null },
  )
  // Any membership document (a reader's too) proves membership on comments and reviews.
  const isMember = holdings.data?.member === true
  // What this viewer may do as a member (RC2 roles: a triage member closes, labels, assigns,
  // locks, requests reviews and resolves threads; a reader none of it; merging, draft and ready,
  // head updates and dismissals are a maintainer's or writer's). The author keeps the author's own.
  const viewerRole = holdings.data?.role ?? null
  const caps = capabilitiesOf(viewerRole)
  const isAuthor = viewer !== null && viewer === pull.author
  const archived = home.config?.archived === true
  // A locked PR takes comments and reviews from members only (RC1: consensus refuses the rest).
  const postContext = { isMember, locked: thread.locked }
  const composeBlock = archived ? ARCHIVED_REASON : lockedOut(postContext) ? LOCKED_REASON : privateComposeBlock(home)
  const writeBlocked = composeBlock !== null
  // Who the composer's lock banner speaks to (a member keeps the composer).
  const lockViewer = lockViewerOf(viewer, holdings)
  const open = pull.state.open
  const { slot: mergeSlot, running: mergeBusy, onRunning: setMergeRunning } = useMergeSlot(tab, open && pull.state.draft)
  const merged = pull.state.merged
  const target = { id: pull.id, number: pull.number }
  const stateTarget = { ...target, type: 'patch' as const, author: pull.author }
  /**
   * Delete the PR's source branch in its repo (M7): a ref update to the null oid from the merged
   * head. Refused (`deleteBranchProblem`) for the base or default branch, and when the branch
   * moved past the head that was merged.
   */
  const deleteSourceBranch = async (src: RepoRef, refName: string, headOid: string): Promise<void> => {
    if (!sdk || !signer) throw new Error('sign in to continue')
    // Read again now (the config may have changed since the page loaded); a failed read refuses.
    const defaultBranch = await readDefaultBranch(sdk, src).catch(() => null)
    const state = await readBranchState(sdk, src, refName)
    // Diverged: no single tip to delete from, and nothing is written (never reported as deleted).
    if (state?.state === 'diverged') throw new Error(`${shortBranch(refName)} has diverged heads; delete it with git`)
    const tip = state?.state === 'resolved' ? state.oid : null
    const problem = deleteBranchProblem({ refName, sameRepo: src.repoId === repo.repoId, baseRefName: pull.mergeBaseRefName, defaultBranch, headOid, tip })
    if (problem !== null) throw new Error(problem)
    // Already gone (or never recorded): nothing to write, and it is deleted.
    if (tip === null) return
    await writeRefUpdate(sdk, signer, src, { refName, newOid: '0'.repeat(headOid.length), prevOid: headOid }, { intent: `delete-branch:${src.repoId}:${refName}:${headOid}` })
  }
  /**
   * Restore a deleted source branch at the PR's head (GitHub's "Restore branch", QW3-052): a ref
   * update naming the head, read again first so a branch pushed meanwhile is never overwritten.
   * The head's objects are still stored in the source repo: deleting a branch deletes no pack.
   */
  const restoreSourceBranch = async (src: RepoRef, refName: string, headOid: string): Promise<void> => {
    if (!sdk || !signer) throw new Error('sign in to continue')
    const now = await readBranchState(sdk, src, refName)
    if (now !== null && now.state !== 'unborn') throw new Error(`${shortBranch(refName)} exists again; reload to see where it points`)
    await writeRefUpdate(sdk, signer, src, { refName, newOid: headOid }, { intent: `restore-branch:${src.repoId}:${refName}:${headOid}` })
  }

  // ---- the comparison (Files changed, the tab counts, the commit list) -----------------------
  const spec = pullSpec(pull, home, pullOrigin?.baseOid ?? '')
  const comparison = usePullComparison(repo, pull.sourceId, spec)
  const cmp = comparison.data
  const headReader = cmp?.sides.head ?? null
  const { baseTipOid } = pullBase(pull, home)
  const commits = useAsync(
    () => prCommits(headReader!, prHaveSet({ baseTipOid, comparedBaseOid: cmp!.comparedBaseOid, fellBack: cmp!.fellBack === true, merged: pull.state.merged }), pull.headOid),
    [cmp === null ? '' : `${cmp.comparedBaseOid}:${comparison.sidesKey}`, pull.headOid, baseTipOid],
    { enabled: headReader !== null && cmp !== null },
  )
  // Merge integrity: whether the recorded merge commit contains this PR (a squash or a rebase of
  // it counts), read through the comparison's readers once it has loaded. Git objects only: no
  // Platform reads beyond the page's own.
  const mergeHead = merged && pull.mergedAt !== undefined ? headAt(pull.review.headUpdates, pull.initialHeadOid, pull.mergedAt) : ''
  const mergeCheck = useAsync(
    () => checkMerge(cmp!.sides, { headOid: mergeHead, mergeOid: pull.mergeOid!, tipBefore: pull.baseOidAtMerge ?? '' }),
    [pull.mergeOid ?? '', mergeHead, pull.baseOidAtMerge ?? '', comparison.sidesKey],
    { enabled: merged && cmp !== null && (pull.mergeOid ?? '') !== '' && mergeHead !== '' && pull.state.mergeOnBase !== false },
  )
  // The repo holding the PR's source branch: this one for a same-repo PR, else the fork once read.
  const sourceRefOf = (): RepoRef | null =>
    pull.sourceId === '' || pull.sourceId === repo.repoId ? repo : comparison.source.kind === 'found' ? comparison.source.repo : null

  // ---- checks on the head ---------------------------------------------------------------------
  // Trust is by the current approvers (maintainers and role-1 writers; never a triage member or
  // reader) and runners: keyed on the set itself (a swap of members re-reads).
  const membersKnown = thread.approvals !== null
  const memberKey = [...new Set(thread.members.filter((m) => isApprover(m.role)).map((m) => m.identity))].sort().join(',')
  const rules = policyOf(thread.approvals)
  const policyNow = rules.policy === 'unknown' ? null : rules.policy
  // The policy's pinned check sources (RC1 R-08): a pinned check lists and counts its source's run.
  const pins = requiredSources(policyNow)
  const pinKey = JSON.stringify([...pins])
  const checks = useAsync(
    async () => {
      const members = new Set(memberKey === '' ? [] : memberKey.split(','))
      return readCheckRuns(sdk!, repo, pull.headOid, members, pins)
    },
    [ready, repoKey(repo), pull.headOid, memberKey, pinKey],
    { enabled: ready && sdk !== null && pull.headOid !== '' },
  )
  const checkSummary = checks.data === null ? null : summarizeChecks(checks.data.runs, membersKnown)
  // CI re-run requests no newer run answers yet: the owner's, maintainers' and writers' only (a
  // triage member's is not counted, so runners ignore it).
  const roleOracle = useMemo(() => new RoleOracle(thread.members), [thread.members])
  const rerunPending = useMemo(() => {
    const counted = thread.ciReruns.filter((r) => rerunCounts(r, repo.ownerId, roleOracle))
    return pendingReruns(counted, checks.data?.runs ?? [], pull.headOid)
  }, [thread.ciReruns, roleOracle, repo.ownerId, checks.data, pull.headOid])
  const rerunWaiting = tab === 'checks' && rerunPending.size > 0
  const reloadChecks = checks.reload
  useEffect(() => {
    if (!rerunWaiting) return
    let polls = 0
    const timer = setInterval(() => {
      polls += 1
      if (polls > RERUN_POLLS) clearInterval(timer)
      else reloadChecks()
    }, RERUN_POLL_MS)
    return () => clearInterval(timer)
  }, [rerunWaiting, reloadChecks])

  // ---- the source branch (head sync) ----------------------------------------------------------
  const crossRepo = pull.sourceId !== '' && pull.sourceId !== repo.repoId
  const source = comparison.source
  const sourceRef = source.kind === 'found' ? source.repo : null
  // A same-repo source reads from the page's resolved branches (a branch never pushed there has
  // no entry: unknown, not deleted); a fork's branch is resolved in the fork.
  const sameRepoBranches = crossRepo ? '' : home.branches.map((b) => `${b.refName}:${tipOidOf(b) ?? ''}`).join(',')
  // A closed or merged PR offers to delete its source branch, as GitHub does (QW2-057): the
  // viewer's write access to it, read only once the PR is closed.
  // The source repo as the suggestions' own write check picks it (a same-repo PR's is this repo).
  const closedSource = open ? null : sourceRef ?? (pull.sourceId === repo.repoId ? repo : null)
  const closedWrite = useSourceWrite(closedSource, pull.sourceRefName)
  // A fork's head is named by its owner, as GitHub's `user:branch` (QW4-030): "from qa4-proj:feature"
  // reads as this repo when the fork kept the parent's name.
  const forkRef = crossRepo ? sourceRef : null
  const forkOwnerName = useDpnsName(forkRef?.ownerId ?? '')
  // The owner as the page's identity pills show one: the DPNS name, else the id's first characters.
  const forkOwnerLabel = forkRef === null ? '' : forkOwnerName ?? abbreviate(forkRef.ownerId)
  const sourcePrefix = forkSourcePrefix(forkRef === null ? null : { ownerId: forkRef.ownerId, ownerLabel: forkOwnerLabel, name: forkRef.name }, repo)
  const sourceState = useAsync<RefState | null>(
    () =>
      crossRepo
        ? readBranchState(sdk!, sourceRef!, pull.sourceRefName!)
        : Promise.resolve(repo.visibility === 'private' ? null : home.branches.find((b) => b.refName === pull.sourceRefName)?.state ?? null),
    [ready, crossRepo ? sourceRef?.repoId ?? '' : repoKey(repo), pull.sourceRefName ?? '', pull.headOid, sameRepoBranches],
    // Read for a merged or closed PR too: its sidebar says whether the branch still exists (QW2-053).
    { enabled: ready && sdk !== null && pull.sourceRefName !== null && (!crossRepo || sourceRef !== null) },
  )
  const readSync = sourceState.settled && !sourceState.error && pull.sourceRefName !== null ? headSync(pull.headOid, sourceState.data) : null
  // A branch this page just deleted or restored, until a read of it catches up (QW3-053: right
  // after "Delete … after merging" the node may still answer with the old tip).
  const [branchWrite, setBranchWrite] = useState<BranchWrite | null>(null)
  // Once a read shows the write, the read alone speaks again (later changes by others included).
  if (branchWrite !== null && readSync !== null && readSync.kind === (branchWrite.to === 'deleted' ? 'deleted' : 'in-sync')) setBranchWrite(null)
  const sync = branchShown(readSync, branchWrite, pull.sourceRefName, pull.headOid)
  // The source branch's ref updates (one read, both update types), on the Conversation tab only:
  // who pushed each head (QW3-048), and, once the PR is closed, when its branch was deleted or
  // restored (QW4-025). Read once the branch's state is read, and again when a read of it shows
  // a change (this page's delete or restore, once the node has it).
  const wantPhrases = tab === 'conversation' && review.headUpdates.length > 0
  const wantBranchEvents = tab === 'conversation' && !open
  const branchUpdates = useAsync(
    () => readBranchUpdates(sdk!, sourceRefOf()!, pull.sourceRefName!),
    [ready, pull.sourceId, pull.sourceRefName ?? '', review.headUpdates.length, comparison.source.kind, open, readSync?.kind ?? ''],
    { enabled: ready && sdk !== null && (wantPhrases || wantBranchEvents) && pull.sourceRefName !== null && sourceRefOf() !== null && sourceState.settled },
  )
  const pushers = useMemo(() => (branchUpdates.data === null ? null : firstPushers(branchUpdates.data)), [branchUpdates.data])
  const branchEvents = useMemo(
    () => (!wantBranchEvents || branchUpdates.data === null || pull.sourceRefName === null ? [] : sourceBranchEvents(branchUpdates.data, pull.sourceRefName, pull.headOid, pull.createdAt)),
    [wantBranchEvents, branchUpdates.data, pull.sourceRefName, pull.headOid, pull.createdAt],
  )
  const pushersSettled = pull.sourceRefName === null || sourceRefOf() === null || branchUpdates.settled
  // Commits the base already had (an "Update branch" merge brings them in) are not counted as pushed.
  const comparedBase = cmp === null || cmp.fellBack === true ? '' : cmp.comparedBaseOid
  const phrases = useAsync(
    () => headUpdatePhrases(headReader!, pull.initialHeadOid, review.headUpdates, pushers ?? undefined, comparedBase),
    [comparison.sidesKey, review.headUpdates.map((u) => u.id).join(','), headReader === null, pushers === null ? 0 : pushers.size, comparedBase],
    { enabled: headReader !== null && wantPhrases && pushersSettled && cmp !== null },
  )
  // The PR's author or a maintainer/writer: who may move the head (event kind 16: role 1) and mark
  // draft or ready (transition kinds 14/15: role 1).
  const authorOrMember = identity !== null && (isAuthor || caps.canPush)
  const canMoveHead = authorOrMember && open && !writeBlocked
  const since = pullSinceYourReview(thread, identity)
  // A review this page just submitted: until every comment it wrote shows, say how many have.
  const [arriving, setArriving] = useState<{ reviewId: string; commentIds: readonly string[] } | null>(null)
  const arrivedAll = arriving !== null && reviewShows(thread, arriving)
  if (arrivedAll) setArriving(null)
  const stillArriving = arriving !== null && !arrivedAll && !refreshing ? { shown: commentsShown(thread, arriving.commentIds), total: arriving.commentIds.length } : null
  // A review this tab submitted that the node read does not show yet, kept across a reload (QW3-047).
  const ownScope = identity === null ? null : ownReviewScope(network, repo.repoId, pull.number, identity)
  // Only while everything the page read is readable: a review hidden as unreadable (a locked
  // private repo) is not one the node lacks.
  const shownReviewKey = thread.reviews.map((r) => r.id).join(',')
  const allReadable = totalHidden(thread.hidden) === 0
  // Bumped when this tab records a review, so the note re-reads the record.
  const [ownTick, setOwnTick] = useState(0)
  const ownWaiting = useMemo(
    () => (ownScope === null || !allReadable || ownTick < 0 ? null : unshownOwnReviews(ownScope, new Set(shownReviewKey === '' ? [] : shownReviewKey.split(',')))[0] ?? null),
    [ownScope, allReadable, shownReviewKey, ownTick],
  )
  useEffect(() => {
    if (ownScope !== null && allReadable) forgetShownOwnReviews(ownScope, new Set(shownReviewKey === '' ? [] : shownReviewKey.split(',')))
  }, [ownScope, allReadable, shownReviewKey])

  // ---- controls ---------------------------------------------------------------------------------
  // `requireChecks`: the newest trusted run per name on the head passed, and at least one was
  // reported; named `requiredChecks` (set by `dg`) must each pass, from their pinned source when
  // the policy names one (`checksState`, forge-core `checks_state`: `dg pr merge` applies the same rule).
  const checksRequired = policyNow !== null && (policyNow.requireChecks === true || (policyNow.requiredChecks?.length ?? 0) > 0)
  // The required checks as they stand ('unknown' until the runs and the members are read: the
  // merge stays disabled meanwhile, fail closed).
  const requiredChecks =
    !checksRequired || policyNow === null
      ? null
      : checks.data === null || !membersKnown
        ? ('unknown' as const)
        : checksState(checks.data.rows, pull.headOid, roleOracle, checks.data.runners, policyNow)
  const actions = pullActions({
    pull,
    viewer,
    holdings: viewer !== null && !holdings.settled ? 'loading' : holdings.data,
    protectedPatterns: home.config?.protectedPatterns ?? [],
    policy: rules.status,
    maintainersOnly: policyNow?.approverRole === 1,
    checks: requiredChecks,
  })
  // "Mark as merged (done elsewhere)" is offered on a ready PR whose head is on the base already.
  const showMarkMerged = actions.canMarkMerged && !pull.state.draft
  const base = shortBranch(pull.mergeBaseRefName) || 'the base branch'
  const canAuthorOrMember = authorOrMember && !archived
  // Who may request reviews (the author, or a member down to triage).
  const canRequestReview = identity !== null && (isAuthor || caps.canRequestReview) && !archived
  const canMember = identity !== null && isMember && !archived && guard.disabledReason === null
  // RC2 MOD: maintainers hide; readers see collapsed rows, and a hidden PR opens behind a banner.
  const canModerate = canMember && holdings.data?.maintain === true
  const moderation = thread.moderation
  const threadHidden = moderation?.thread ?? null
  const threadCollapsed = threadHidden !== null && !threadRevealed

  const [comment, setComment] = useState('')
  const commentIntent = useIntent()
  const [posting, setPosting] = useState(false)
  const [commentError, setCommentError] = useState<string | null>(null)
  const [pending, setPendingState] = useState<Pending | null>(null)
  // One confirm at a time: a write asked for while one is open (a picker applying on the same
  // click that opens another action) never silently replaces it.
  const setPending = useCallback((p: SetStateAction<Pending | null>) => setPendingState((cur) => (typeof p === 'function' ? p(cur) : p === null ? null : cur ?? p)), [])
  // "Close with comment": the comment a close already posted, by the confirm's intent, so a retry
  // of a close that failed after it never posts the comment twice.
  const closeComment = useRef<{ intent: string; id: string } | null>(null)
  const [editing, setEditing] = useState<{ title: string; body: string } | null>(null)
  const [editingComment, setEditingComment] = useState<{ id: string; body: string } | null>(null)

  // Which subtrees this viewer's comment, review or event would create (D-011). Read only once
  // the viewer turns to a write (typing, or a confirm opening); the previews are upper bounds
  // meanwhile, and a page view costs no reads.
  const hasComments = thread.comments.length > 0
  const hasReviews = thread.reviews.length > 0
  const firstsReady = (comment !== '' || pending !== null) && ready && sdk !== null && identity !== null
  const commentFirst = useFirstWrite(() => commentFirsts(sdk!, repo, pull.id, identity!, hasComments), [pull.id, identity ?? '', hasComments], firstsReady)
  const reviewFirst = useFirstWrite(() => reviewFirsts(sdk!, repo, identity!, hasReviews), [pull.id, identity ?? '', hasReviews], firstsReady)
  // Review kinds are a member `event` or the author's `authorEvent`; state changes a `transition`.
  const stateType = caps.canLabel ? 'event' : 'authorEvent'
  const eventFirst = useFirstWrite(() => eventFirsts(sdk!, repo, stateType, pull.id, identity!), [pull.id, identity ?? '', stateType], firstsReady)
  const transitionFirst = useFirstWrite(() => eventFirsts(sdk!, repo, 'transition', pull.id, identity!), [pull.id, identity ?? ''], firstsReady)
  const transitionCost = previewCreate('transition', {}, transitionFirst)


  const links: MarkdownLinks = useRepoLinks(addr, home.description)

  const eventCost = previewCreate(stateType, {}, eventFirst)
  /** A CI re-run request: a member event naming the repository in `refId`, and the check in `value`. */
  const rerunCost = (check: string | null): Cost => withAddressee(previewCreate('event', check === null ? {} : { value: check }, eventFirst))
  /** Confirm an event write (the route's price checked against the balance first). */
  const confirmEvent = (p: Pending, cost: Cost = eventCost): void => {
    if (guard.check(cost, 'collab')) setPending(p)
  }
  const reviewDraft = useReviewDraft(repo, pull.id, pull.headOid)
  // The diff's lines, as the inline comments saw them load (re-anchoring a pending review).
  const knownLines = useRef<ReadonlyMap<string, ReadonlySet<string>>>(new Map())
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const onInlinePosted = useCallback((id?: string) => refreshRef.current(id === undefined ? undefined : (t) => t.comments.some((x) => x.id === id)), [])
  const rememberLines = useCallback((lines: ReadonlyMap<string, ReadonlySet<string>>) => {
    knownLines.current = lines
  }, [])
  // Suggestions and "Update branch": commits to the PR's source branch (the fork).
  const applied = useMemo(() => appliedSuggestions(commits.data?.commits ?? []), [commits.data])
  // Comments left on an older head whose lines the head kept unchanged (QW3-015): carried to the
  // head at those lines' new numbers, so they stay current (inline in Files changed, not Outdated
  // in Conversation) and their suggestions stay appliable, as on GitHub.
  const carryPairs = useMemo(() => {
    const out = new Map<string, { readonly from: string; readonly path: string }>()
    for (const c of thread.comments) {
      const from = c.anchor === null ? null : carryFrom(c.anchor, pull.headOid)
      if (from !== null && c.anchor !== null) out.set(`${from}\0${c.anchor.path}`, { from, path: c.anchor.path })
    }
    return [...out.values()]
  }, [thread.comments, pull.headOid])
  // The code each inline comment was left on, for Conversation (QW2-049), and the files a carry
  // compares: one cache, read on Conversation and (to carry) on Files changed.
  const snippetSources = useMemo(
    () => [
      ...thread.comments.flatMap((c) => (c.anchor === null ? [] : [snippetSource(c.anchor)].filter((s) => s !== null))),
      ...carryPairs.flatMap((p) => [
        { commit: p.from, path: p.path },
        { commit: pull.headOid.toLowerCase(), path: p.path },
      ]),
    ],
    [thread.comments, carryPairs, pull.headOid],
  )
  const snippetTexts = useSnippetTexts(tab === 'conversation' || (tab === 'files' && carryPairs.length > 0) ? headReader : null, snippetSources)
  // One line diff per file and older head, however many comments sit on it.
  const lineMaps = useMemo(() => {
    const out = new Map<string, LineMap | null>()
    for (const p of carryPairs) {
      const before = snippetTexts.get(snippetKey({ commit: p.from, path: p.path }))
      const after = snippetTexts.get(snippetKey({ commit: pull.headOid.toLowerCase(), path: p.path }))
      if (typeof before === 'string' && typeof after === 'string') out.set(`${p.from}\0${p.path}`, lineMap(before, after))
    }
    return out
  }, [carryPairs, snippetTexts, pull.headOid])
  const carried = useMemo(() => {
    const out = new Map<string, Anchor>()
    if (lineMaps.size === 0) return out
    for (const c of thread.comments) {
      const a = c.anchor === null ? null : carryAnchor(c.anchor, pull.headOid, lineMaps.get(`${c.anchor.commitOid}\0${c.anchor.path}`))
      if (a !== null) out.set(c.id, a)
    }
    return out
  }, [thread.comments, pull.headOid, lineMaps])
  const withCarried = useCallback((c: CommentView): CommentView => {
    const a = carried.get(c.id)
    return a === undefined ? c : { ...c, anchor: a }
  }, [carried])
  const comments = useMemo(() => (carried.size === 0 ? thread.comments : thread.comments.map(withCarried)), [thread.comments, carried, withCarried])
  const anchorContext = (c: CommentView, label = true): JSX.Element | null => {
    // A carried comment shows where it is on the head now.
    const anchor = carried.get(c.id) ?? c.anchor
    if (anchor === null) return null
    const source = snippetSource(anchor)
    return (
      <AnchorContext
        anchor={anchor}
        text={source === null ? null : snippetTexts.get(snippetKey(source))}
        outdated={!anchorOnHead(anchor, pull.headOid)}
        applied={applied.get(c.id) ?? null}
        label={label}
        // The source hunk is numbered at the comment's own commit: a comment carried to the head
        // shows the head's lines instead.
        hunk={carried.has(c.id) ? null : shownHunk(c, trust)}
      />
    )
  }
  const suggest = useSuggestions({
    repo,
    source: sourceRef,
    pull,
    comments,
    drafts: reviewDraft.draft?.comments ?? NO_DRAFTS,
    headReader,
    headOnly: comparison.headOnly,
    applied,
    // The head update's member route is role 1's (event kind 16); anyone else updates as the author.
    isMember: caps.canPush,
    isAuthor,
    signedIn: identity !== null && guard.disabledReason === null && !archived,
    branchAhead: sync?.kind === 'ahead',
    onCommitted: (c) => refresh((t) => t.pull.headOid === c),
  })
  const sourceWrite = suggest.branchWrite
  const branchRun = useMemo(() => ({ at: suggest.runner.at, view: suggest.runner.view }), [suggest.runner.at, suggest.runner.view])
  // The source repo's default branch (never deleted after a merge): the base repo's own config
  // for a same-repo PR, else read once the merger could delete there.
  const sourceDefault = useAsync(
    async () => (sourceRef === null ? home.config?.defaultBranch ?? 'main' : await readDefaultBranch(sdk!, sourceRef)),
    [ready, sourceRef?.repoId ?? '', home.config?.defaultBranch ?? '', sourceWrite.can],
    { enabled: ready && sdk !== null && (open ? sourceWrite.can : closedWrite.can) },
  )
  const canResolve = identity !== null && (isAuthor || caps.canResolve) && !writeBlocked && guard.disabledReason === null
  // Stable across renders (the diff's lines re-render only when these change): the handler
  // reads the latest confirm (cost and guard) through a ref.
  // A resolve names the thread's root in `refId` (QW4-039).
  const confirmResolve = useRef((p: Pending): void => confirmEvent(p, withAddressee(eventCost)))
  confirmResolve.current = (p: Pending): void => confirmEvent(p, withAddressee(eventCost))
  const resolvedKey = review.resolvedThreads.join(',')
  const threadActions = useMemo<ThreadActions>(
    () => ({
      canResolve,
      resolved: new Set(resolvedKey === '' ? [] : resolvedKey.split(',')),
      onResolve: (root, resolve) => {
        confirmResolve.current({ kind: 'resolve', root, resolve })
      },
      viewer: identity,
      onEdit: (c, body) => setPending({ kind: 'edit-comment', id: c.id, body }),
      onDelete: (c) => setPending({ kind: 'delete-comment', id: c.id }),
      ...(thread.moderation ? { hidden: thread.moderation } : {}),
    }),
    [canResolve, resolvedKey, identity, setPending, thread.moderation],
  )
  const commentCost = composeCost(repo, 'comment', { body: comment.trim() }, commentFirst)
  // A text over its field: stored whole by a maintainer or writer (forge-v2.md §6.3).
  const commentLong = useLongCompose(repo, 'comment', comment.trim())
  const commentTooLong = composeTooLong(repo, 'comment', { body: comment.trim() }, commentLong)
  const editLong = useLongCompose(repo, 'patch', editing?.body ?? '', {
    title: editing?.title ?? '',
    baseRefName: pull.baseRefName,
    sourceRefName: pull.sourceRefName ?? '',
  })
  // an inline comment's path shares a private comment's room (as `updateComment` reads it)
  const editedPath = thread.comments.find((x) => x.id === editingComment?.id)?.anchor?.path
  const commentEditLong = useLongCompose(repo, 'comment', editingComment?.body ?? '', editedPath === undefined ? {} : { path: editedPath })
  // "Close with comment" (QW2-008): the composer's text goes with a close or reopen when it could be posted.
  const withComment = comment.trim() !== '' && !writeBlocked && !commentTooLong ? comment.trim() : null
  // The repo's milestones, for the picker (QW2-050): read for members only (only they can set one).
  const milestones = useAsync(
    () => readMilestones(sdk!, repo),
    [ready, repoKey(repo), canMember && caps.canMilestone ? 1 : 0],
    { enabled: ready && sdk !== null && canMember && caps.canMilestone },
  )

  const postComment = async (): Promise<void> => {
    if (posting || comment.trim() === '' || commentTooLong || !guard.check(commentCost, 'collab', 'comment')) return
    if (!sdk || !signer) return
    setPosting(true)
    setCommentError(null)
    try {
      const r = await createComment(sdk, signer, repo, { targetId: pull.id, body: comment.trim(), intent: commentIntent.intent, post: postContext })
      setComment('')
      commentIntent.renew()
      refresh((t) => t.comments.some((c) => c.id === r.documentId))
    } catch (e) {
      // Another tab of this identity wrote it: the composer's text is on chain, clear it.
      if (e instanceof SupersededWriteError) {
        setComment('')
        commentIntent.renew()
        refresh()
      }
      setCommentError(guard.failed(e))
    } finally {
      setPosting(false)
    }
  }

  /** Post a review-parity event by whichever route the viewer holds. */
  const post = async (kind: EventKind, intent: string, payload: { value?: string; oidHex?: string; refId?: string } = {}): Promise<string> => {
    if (!sdk || !signer) throw new Error('sign in to continue')
    // The member route only for a kind this viewer's role may write as a member (else the author's).
    const r = await postTargetEvent(sdk, signer, repo, { target, kind, author: pull.author, isMember: memberMayWriteEvent(viewerRole, EVENT_KIND_CODE[kind]), payload, intent })
    return r.documentId
  }

  const runPending = async (intent: string): Promise<void> => {
    if (!sdk || !signer || pending === null) throw new Error('sign in to continue')
    const p = pending
    switch (p.kind) {
      case 'state': {
        // The comment first, as GitHub posts it.
        if (p.comment !== undefined && closeComment.current?.intent !== intent) {
          const r = await createComment(sdk, signer, repo, { targetId: pull.id, body: p.comment, intent: `${intent}:comment`, post: postContext }).catch((e: unknown) => {
            if (e instanceof SupersededWriteError) return { documentId: e.documentId }
            throw e
          })
          closeComment.current = { intent, id: r.documentId }
          setComment('')
          commentIntent.renew()
        }
        const posted = closeComment.current?.intent === intent ? closeComment.current.id : null
        try {
          await setTargetState(sdk, signer, repo, { target: stateTarget, action: p.to, isMember: caps.canCloseReopen, intent })
        } catch (e) {
          // The comment is posted: show it while the close is retried.
          if (posted !== null) refresh((t) => t.comments.some((c) => c.id === posted))
          throw e
        }
        refresh((t) => t.pull.state.open === (p.to === 'reopen') && (posted === null || t.comments.some((c) => c.id === posted)))
        return
      }
      case 'mark-merged':
        await setTargetState(sdk, signer, repo, { target: stateTarget, action: 'merge', isMember: caps.canMerge, oidHex: pull.headOid, intent })
        // A maintainer recording it past unmet branch rules: the bypass is recorded on the PR,
        // as the merge box and `dg pr merge --event-only --override-policy` record theirs.
        if (p.bypass.length > 0) {
          try {
            await recordPolicyBypass(sdk, signer, repo, { target, rules: p.bypass, mergeOid: pull.headOid, intent: `${intent}:bypass` })
          } catch (e) {
            // The merge is recorded (final); a retry of this same action re-uses it and writes only the record.
            throw new Error(`The merge is recorded, but recording the rules bypass failed: ${guard.failed(e)} Retry to record it.`)
          }
        }
        refresh((t) => t.pull.state.merged)
        return
      case 'review': {
        const r = await createReview(sdk, signer, repo, { patchId: pull.id, verdict: p.verdict, commitOid: pull.headOid, body: p.body, intent, post: postContext })
        // On Platform now; remembered until a read shows it, so a reload before then still says so.
        if (ownScope !== null) rememberOwnReview(ownScope, { id: r.documentId, verdict: p.verdict, at: Date.now() })
        setOwnTick((n) => n + 1)
        setComment('')
        commentIntent.renew()
        refresh((t) => t.reviews.some((x) => x.id === r.documentId), SUBMIT_WAIT)
        return
      }
      case 'draft':
        await setTargetState(sdk, signer, repo, { target: stateTarget, action: p.to, isMember: caps.canDraftReady, intent })
        refresh((t) => t.pull.state.draft === (p.to === 'draft'))
        return
      case 'rerun': {
        const r = await requestRerun(sdk, signer, repo, { target, sha: pull.headOid, check: p.check, intent })
        refresh((t) => t.ciReruns.some((x) => x.id === r.documentId))
        return
      }
      case 'head':
        await post('headUpdate', intent, { oidHex: p.oid })
        refresh((t) => t.pull.headOid === p.oid)
        return
      case 'request':
        await post(p.remove ? 'reviewRequestRemove' : 'reviewRequest', intent, { refId: p.who })
        refresh((t) => t.review.requestedReviewers.some((r) => r.identity === p.who) !== p.remove)
        return
      case 'dismiss':
        if (p.row.dismissId === null) throw new Error('no review of theirs counts on this head')
        await post('reviewDismiss', intent, { refId: p.row.dismissId, ...(p.reason ? { value: p.reason } : {}) })
        refresh((t) => t.review.dismissedReviews.some((d) => d.reviewId === p.row.dismissId))
        return
      case 'labels':
        // One event per label (the contract's shape), one confirm for all of them.
        await applySetChange(p.change, intent, (label, add, i) => setLabel(sdk, signer, repo, { target, label, add, intent: i }))
        refresh((t) => setChangeShows(t.pull.state.labels, p.change))
        return
      case 'assignees':
        await applySetChange(p.change, intent, (who, add, i) => setAssignee(sdk, signer, repo, { target, assignee: who, assign: add, intent: i }))
        refresh((t) => setChangeShows(t.pull.state.assignees, p.change))
        return
      case 'milestone':
        await setMilestone(sdk, signer, repo, { target, title: p.title, intent })
        refresh((t) => t.review.milestone === p.title)
        return
      case 'delete-branch':
      case 'restore-branch':
        await p.run()
        if (pull.sourceRefName !== null) setBranchWrite({ ref: pull.sourceRefName, head: pull.headOid, to: p.kind === 'delete-branch' ? 'deleted' : 'restored' })
        sourceState.reload()
        // The branch list moved (a same-repo branch is read from the repo home).
        reloadHome?.()
        return
      case 'define-label':
        await defineLabel(sdk, signer, repo, { name: p.name, color: p.color, description: p.description, intent: `${intent}:def` })
        await setLabel(sdk, signer, repo, { target, label: p.name, add: true, intent: `${intent}:apply` })
        refresh((t) => t.pull.state.labels.includes(p.name))
        return
      case 'edit-pull': {
        const changes: { title?: string; body?: string } = {}
        if (p.title !== pull.title) changes.title = p.title
        if (p.body !== pull.body) changes.body = p.body
        await updateTarget(sdk, signer, repo, {
          type: 'patch',
          id: pull.id,
          ...changes,
          expectedRevision: BigInt(pull.revision),
          seal: {
            current: { title: pull.title, body: pull.long?.field ?? pull.body, baseRefName: pull.baseRefName, sourceRefName: pull.sourceRefName ?? undefined },
            bind: { number: pull.number },
            ...(pull.epoch !== null ? { patchEpoch: pull.epoch } : {}),
            imported: pull.importedRaw ?? null,
          },
          intent,
        })
        setEditing(null)
        refresh((t) => t.pull.title === p.title && t.pull.body === p.body)
        return
      }
      case 'delete-comment':
        await deleteComment(sdk, signer, repo, p.id)
        refresh((t) => !t.comments.some((x) => x.id === p.id))
        return
      case 'resolve':
        await post(p.resolve ? 'threadResolve' : 'threadUnresolve', intent, { refId: p.root })
        refresh((t) => t.review.resolvedThreads.includes(p.root) === p.resolve)
        return
      case 'lock':
        // A member transition (18/19): from then on consensus refuses non-members' comments and reviews.
        await setLock(sdk, signer, repo, { target: stateTarget, lock: p.on, isMember: caps.canLock, intent })
        refresh((t) => t.locked === p.on)
        return
      case 'hide':
        await setHidden(sdk, signer, repo, { target, item: p.item, reason: p.reason, hide: p.hide, intent })
        if (p.closeAndLock) {
          // Separate writes (a batch holds one transition): close, then lock, each skipped when done.
          if (open) await setTargetState(sdk, signer, repo, { target: stateTarget, action: 'close', isMember: caps.canCloseReopen, intent: `${intent}:close` })
          if (!thread.locked) await setLock(sdk, signer, repo, { target: stateTarget, lock: true, isMember: caps.canLock, intent: `${intent}:lock` })
        }
        // With "also close and lock", until the close and the lock show as well.
        refresh((t) => isHidden(t.moderation, p.item) === p.hide && (!p.closeAndLock || (!t.pull.state.open && t.locked)))
        return
      case 'edit-comment': {
        const c = thread.comments.find((x) => x.id === p.id)
        await updateComment(sdk, signer, repo, {
          id: p.id,
          body: p.body,
          ...(c ? commentEditDrops(c, thread.comments, { isMember, allReadable: totalHidden(thread.hidden) === 0 }) : {}),
          ...(c?.revision !== undefined ? { expectedRevision: BigInt(c.revision) } : {}),
          seal: { current: { body: c?.body ?? '', path: c?.anchor?.path }, bind: { targetId: pull.id }, imported: c?.importedRaw ?? null },
          intent,
        })
        setEditingComment(null)
        refresh((t) => t.comments.some((x) => x.id === p.id && x.body === p.body))
        return
      }
    }
  }

  const pendingCost = ((): Cost => {
    if (pending === null) return eventCost
    switch (pending.kind) {
      case 'review':
        return composeCost(repo, 'review', { body: pending.body }, reviewFirst)
      case 'mark-merged':
        return pending.bypass.length > 0
          ? previewCredits(transitionCost.credits + previewCreate('event', { value: bypassValue(pending.bypass) }).credits)
          : transitionCost
      case 'state':
        return pending.comment === undefined ? transitionCost : previewCredits(transitionCost.credits + composeCost(repo, 'comment', { body: pending.comment }, commentFirst).credits)
      case 'draft':
      case 'lock':
        return transitionCost
      case 'hide': {
        const hide = hideCost(repo, pending)
        const extra = pending.closeAndLock ? (open ? 1 : 0) + (thread.locked ? 0 : 1) : 0
        return previewCredits(hide.credits + extra * transitionCost.credits)
      }
      case 'labels':
        return sumPreviews([...pending.change.add, ...pending.change.remove].map((value) => previewCreate('event', { value })))
      // These name an identity, a review or a thread in `refId` (QW4-039: previewed without it).
      case 'assignees':
        return sumPreviews([...pending.change.add, ...pending.change.remove].map((value) => withAddressee(previewCreate('event', { value }))))
      case 'request':
      case 'resolve':
        return withAddressee(eventCost)
      case 'rerun':
        return rerunCost(pending.check)
      case 'milestone':
        return previewCreate('event', pending.title === null ? {} : { value: pending.title })
      case 'delete-branch':
      case 'restore-branch':
        return previewCreate('refUpdate')
      case 'dismiss':
        return withAddressee(previewCreate('event', { value: pending.reason }, eventFirst))
      case 'define-label':
        return previewCredits(
          previewCreate('label', { name: pending.name, color: pending.color, description: pending.description }).credits + previewCreate('event', { value: pending.name }).credits,
        )
      case 'edit-pull':
        return previewReplace('patch', { title: pending.title, body: pending.body })
      case 'edit-comment':
        return previewReplace('comment', { body: pending.body })
      case 'delete-comment':
        return previewDelete('comment')
      default:
        return eventCost
    }
  })()
  const confirm = confirmText(pending, pull.number, caps.canLabel, pull.headOid, base)

  // ---- conversation ------------------------------------------------------------------------------
  // Replies to an inline thread show under its root, not on their own.
  const inlineIds = useMemo(() => new Set(inlineCommentIds(thread.comments)), [thread.comments])
  // Under the thread's root (a reply to a reply belongs to the same thread).
  const repliesOf = useMemo(() => repliesByRoot(thread.comments), [thread.comments])
  // A mirrored PR's review comments under the review they were submitted with (QW2-010).
  const conversation = useMemo(
    () =>
      nestThreadReplies(
        foldMirroredReviews(
          timeline
            .filter((t) => !(t.kind === 'comment' && t.comment.replyTo !== null && inlineIds.has(t.comment.id)))
            // A comment carried to the head (QW3-015) names its place there.
            .map((t) => (t.kind === 'comment' && carried.has(t.comment.id) ? { ...t, comment: withCarried(t.comment) } : t)),
          (it) => (it.kind === 'review' ? trustedOrigin(it.review.origin, it.review.reviewer, trust) : trustedOrigin(it.comment.origin, it.comment.author, trust)),
        ),
        inlineIds,
      ),
    [timeline, inlineIds, trust, carried, withCarried],
  )
  const resolved = new Set(review.resolvedThreads)
  const eventText = (e: Event): HeadUpdatePhrase | null => (e.kind === 'headUpdate' && e.id ? phrases.data?.get(e.id) ?? null : null)

  const counts = {
    conversation: thread.comments.length + thread.reviews.length,
    // A walk that stopped at its limit has no exact count: "many".
    commits: commits.data === null ? null : commits.data.total ?? ('many' as const),
    // The runs that count (the summary's total), as the checks row says.
    checks: checkSummary?.total ?? null,
    files: cmp?.changes.length ?? null,
  }
  const status = merged
    ? { label: 'Merged', icon: <GitMerge className="h-4 w-4" aria-hidden />, bg: STATE_FILL.done }
    : !open
      ? { label: 'Closed', icon: <GitPullRequestClosed className="h-4 w-4" aria-hidden />, bg: STATE_FILL.closed }
      : pull.state.draft
        ? { label: 'Draft', icon: <GitPullRequestDraft className="h-4 w-4" aria-hidden />, bg: STATE_FILL.draft }
        : { label: 'Open', icon: <GitPullRequest className="h-4 w-4" aria-hidden />, bg: STATE_FILL.open }
  const linkedUpstream = importedHost(pull.importedUrl, mirrorRepo(home.description)) !== null
  // A mirrored description's #n are the source forge's numbers, not this PR's (QW2-054 applies here only).
  const linked = linkedUpstream ? linkedIssues(pull.body) : prLinkedIssues(pull.body, pull.number)
  // The open issues "Fixes #n" names, for the merge box's "Close #n after merging" (QW-015): read
  // only for a viewer who can merge an open PR. An imported description's #n is the source
  // forge's (as it renders): the native issue a trusted mirror recorded with that upstream number.
  const linkedKey = linked.join(',')
  const linkedOpen = useAsync(
    async () => {
      if (!linkedUpstream) return linkedIssueTargets(sdk!, repo, linked)
      const hits = await Promise.all(linked.slice(0, LINKED_ISSUES_MAX).map((n) => resolveUpstreamNumber(sdk!, repo, n, thread.members)))
      return linkedIssueTargets(sdk!, repo, hits.flatMap((h) => (h?.type === 'issue' ? [h.number] : [])))
    },
    [ready, repoKey(repo), linkedKey, linkedUpstream],
    { enabled: ready && sdk !== null && linked.length > 0 && open && actions.canMerge && !archived },
  )
  const closeLinked: CloseIssuesOption | null = useMemo(() => {
    const issues = (linkedOpen.data ?? []).filter((i) => i.open)
    if (issues.length === 0 || !sdk || !signer) return null
    return {
      issues: issues.map((i) => ({ number: i.number, title: i.title })),
      omitted: Math.max(0, linked.length - LINKED_ISSUES_MAX),
      close: async (n: number) => {
        const i = issues.find((x) => x.number === n)
        if (i === undefined) throw new Error(`#${n} is not an open issue here`)
        await setTargetState(sdk, signer, repo, {
          target: { id: i.id, number: i.number, type: 'issue', author: i.author },
          action: 'close',
          isMember: true,
          intent: `close-linked:${repo.repoId}:${pull.number}:${i.number}`,
        })
      },
    }
  }, [linkedOpen.data, sdk, signer, repo, pull.number, linked.length])
  // D-104: a merged PR's header says what happened ("2 commits merged into main"), not "wants to".
  // Who recorded the merge is in the timeline. A count only from a real comparison (not the
  // first-parent fallback).
  const mergedLead = counts.commits === null || cmp?.fellBack === true ? 'Merged' : `${plural(counts.commits, 'commit')} merged`
  const checkout = checkoutCommand(repo, pull.number)
  // A closed or merged PR's source branch, still at its head, and the viewer may delete it (QW2-057);
  // or deleted, and the viewer may restore it at the head (QW3-052).
  const closedBranch = ((): { label: string; restore: boolean; run: () => Promise<void> } | null => {
    const name = pull.sourceRefName
    if (open || closedSource === null || name === null || (sync?.kind !== 'in-sync' && sync?.kind !== 'deleted')) return null
    const label = `${sourcePrefix}${shortBranch(name)}`
    if (sync.kind === 'deleted') {
      // Who could delete it may restore it: the head is still stored there (only the ref moved).
      const restorable = closedWrite.known && closedWrite.can && closedSource.visibility === 'public' && pull.headOid !== '' && !(closedSource.repoId === repo.repoId && name === pull.mergeBaseRefName)
      if (!restorable) return null
      const head = pull.headOid
      return { label, restore: true, run: () => restoreSourceBranch(closedSource, name, head) }
    }
    const offer = deleteBranchOffer({
      refName: name,
      source: { visibility: closedSource.visibility, sameRepo: closedSource.repoId === repo.repoId },
      canWrite: closedWrite.known ? closedWrite.can : null,
      baseRefName: pull.mergeBaseRefName,
      defaultBranch: sourceDefault.data,
      headOid: pull.headOid,
    })
    if (offer.kind !== 'offer') return null
    const head = pull.headOid
    return { label, restore: false, run: () => deleteSourceBranch(closedSource, name, head) }
  })()
  // A closed PR whose branch is gone reopens once the branch is restored, as on GitHub (QW3-052).
  const reopenBlocked = !open && !merged && closedBranch?.restore === true ? `Restore the ${shortBranch(pull.sourceRefName ?? '')} branch first: a pull request reopens with its branch.` : null
  // The repo holding the source branch, for the merge box's last-moment re-read (QW3-013).
  const branchRepo = sourceRef ?? (crossRepo ? null : repo)
  const checkSourceBranch = async (): Promise<string | null> => {
    const name = pull.sourceRefName
    if (!sdk || name === null || branchRepo === null) return null
    const tip = await readBranchTip(sdk, branchRepo, name)
    if (tip === null || tip.toLowerCase() === pull.headOid.toLowerCase()) return null
    // Show the banner with its "Update PR head" (a same-repo branch is read from the repo home).
    if (crossRepo) sourceState.reload()
    else reloadHome?.()
    return `${shortBranch(name)} moved to ${tip.slice(0, 7)} since this page read it, ahead of this PR's head ${pull.headOid.slice(0, 7)}. Update the PR head first, so the merge includes those commits.`
  }

  const sourceAddr = sourceRef === null ? null : { owner: sourceRef.ownerId, name: sourceRef.name }

  return (
    <div className="mx-auto max-w-6xl space-y-4" data-testid="pull-page">
      {/* Header */}
      <div>
        {editing ? (
          <div className="space-y-2">
            <Field label="Title" htmlFor="edit-pr-title">
              <Input id="edit-pr-title" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} maxLength={256} />
            </Field>
            <div className="flex gap-2">
              <Button
                variant="primary"
                size="sm"
                disabled={editing.title.trim() === '' || (editing.title.trim() === pull.title && editing.body === pull.body) || (editLong.long ? editLong.problem !== null : utf8Length(editing.body) > BODY_MAX) || guard.disabledReason !== null}
                onClick={() => setPending({ kind: 'edit-pull', title: editing.title.trim(), body: editing.body })}
              >
                Save
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3">
            <h1 className="min-w-0 flex-1 break-words text-2xl">
              {pull.title || '(untitled)'} <span className="font-mono font-normal text-anvil-500 dark:text-anvil-400" data-testid="pull-number">{numberLabel(pull.number, shownUpstreamNumber(pull, repo, thread.members))}</span>
            </h1>
            {isAuthor ? (
              <Button variant="outline" size="sm" onClick={() => setEditing({ title: pull.title, body: pull.body })} disabled={writeBlocked || longEditBlock(pull.long) !== null} title={composeBlock ?? longEditBlock(pull.long) ?? undefined}>
                <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
              </Button>
            ) : null}
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2 text-dense">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium text-white ${status.bg}`} data-testid="pr-state">
            {status.icon}
            {status.label}
          </span>
          <span className="text-anvil-500 dark:text-anvil-400">
            {merged ? (
              `${mergedLead} into`
            ) : (
              <>
                <ItemAuthor author={pull.author} origin={origin} link={false} />{' '}
                {/* A closed PR no longer wants anything (L-76). */}
                {open ? 'wants to merge into' : 'wanted to merge into'}
              </>
            )}{' '}
            <span className="font-mono">{shortBranch(pull.mergeBaseRefName) || '?'}</span>
            {pullOrigin?.headLabel ? (
              // A mirrored PR's head branch at the source, a fork's as `owner:branch` (L-37); the
              // mirror's own `refs/mirror/pull/<n>/head` names no branch anyone knows.
              <>
                {' '}
                from <span className="font-mono" data-testid="pr-origin-head">{pullOrigin.headLabel}</span>
              </>
            ) : pull.sourceRefName ? (
              <>
                {' '}
                from{' '}
                <span className="break-all font-mono" data-testid="pr-source">
                  {sourcePrefix}
                  {shortBranch(pull.sourceRefName)}
                </span>
              </>
            ) : null}{' '}
            · <Time ms={origin?.createdAt || pull.createdAt} prefix={merged || !open ? 'opened ' : ''} />
          </span>
          {pull.state.mergeOnBase === false ? (
            // D-9: merged is what a maintainer recorded; the recorded commit never became a tip
            // of the base branch here (a mirror whose base was not imported, or a mistaken mark).
            <span className="text-[12px] text-forge-700 dark:text-forge-400" data-testid="pr-merge-not-on-base" title="The merge was recorded by a maintainer or writer; its commit is not a tip the base branch ever had in this repo.">
              merge commit not found on the base
            </span>
          ) : null}
          {mergeCheck.data ? <MergeContentNote content={mergeCheck.data} mergeOid={pull.mergeOid ?? ''} /> : null}
          {pull.headOid ? (
            <span className="flex items-center gap-1 text-anvil-500 dark:text-anvil-400" data-testid="pr-head">
              head <Oid value={pull.headOid} chars={9} />
            </span>
          ) : null}
          {refreshing ? <span className="text-[12px] text-anvil-500 dark:text-anvil-400">Refreshing…</span> : null}
          <CopyLinkButton repo={addr} target={{ kind: 'pull', number: pull.number }} className="ml-auto" />
        </div>
      </div>

      {/* Banners */}
      {open && sync?.kind === 'ahead' ? (
        // Every reader is told the PR shows an older head than its branch (QW2-007: an
        // interrupted browser commit, or a push with auto-sync off); who can move it gets the button.
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-forge-500/40 bg-forge-500/5 px-4 py-3 text-dense" data-testid="head-sync-banner">
          <RefreshCw className="h-4 w-4 shrink-0 text-forge-700 dark:text-forge-400" aria-hidden />
          {/* At least 16rem: on a phone the text keeps the row and the cost and button wrap below it,
              instead of squeezing it into a narrow column beside them (QW3-054). */}
          <span className="min-w-[min(16rem,calc(100%-1.75rem))] flex-1">
            {isAuthor ? 'Your branch' : 'The source branch'} <span className="font-mono">{shortBranch(pull.sourceRefName ?? '')}</span> is at{' '}
            <Oid value={sync.tip} chars={7} copyable={false} />, but this PR is at <Oid value={pull.headOid} chars={7} copyable={false} />.
            {authorOrMember ? null : (
              <span className="text-anvil-600 dark:text-anvil-400"> Its commits, files and checks are the PR head&apos;s until the author or a maintainer or writer updates it.</span>
            )}
          </span>
          {canMoveHead ? (
            <>
              <CostPreview cost={eventCost} />
              <Button
                variant="primary"
                size="sm"
                disabled={guard.disabledReason !== null}
                onClick={() => {
                  confirmEvent({ kind: 'head', oid: sync.tip })
                }}
              >
                Update PR head
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {open && sync?.kind === 'deleted' && pull.sourceRefName ? (
        <p className="rounded-lg border border-caution/40 bg-caution/5 px-4 py-2 text-dense text-anvil-700 dark:text-anvil-200" data-testid="source-deleted">
          <AlertTriangle className="mr-1.5 inline h-4 w-4 text-caution-700 dark:text-caution-400" aria-hidden />
          The source branch <span className="font-mono">{shortBranch(pull.sourceRefName)}</span> no longer exists; the PR keeps its head.
        </p>
      ) : null}
      {open && reviewDraft.draft !== null && !draftIsEmpty(reviewDraft.draft) ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-caution/40 bg-caution/5 px-4 py-2 text-dense" data-testid="pending-review-banner">
          <MessageSquareDashed className="h-4 w-4 text-caution-700 dark:text-caution-400" aria-hidden />
          <span className="min-w-0 flex-1">
            You have a pending review ({plural(reviewDraft.draft.comments.length, 'comment')}), not yet submitted.{' '}
            <span className="text-anvil-600 dark:text-anvil-400">{draftWhereabouts(repo.visibility === 'private')}</span>
          </span>
          {tab !== 'files' ? (
            <Button size="sm" variant="outline" onClick={() => setTab('files')}>
              Continue review
            </Button>
          ) : null}
        </div>
      ) : null}
      {stillArriving !== null ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-caution/40 bg-caution/5 px-4 py-2 text-dense" role="status" data-testid="review-arriving">
          <span className="min-w-0 flex-1">
            Your review is on Platform; {stillArriving.total - stillArriving.shown} of {stillArriving.total} of its comments are still arriving at the node this page reads.
          </span>
          <Button size="sm" variant="outline" onClick={() => arriving !== null && refresh((t) => reviewShows(t, arriving), SUBMIT_WAIT)}>
            Refresh
          </Button>
        </div>
      ) : null}
      {ownWaiting !== null && stillArriving === null && !refreshing ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-caution/40 bg-caution/5 px-4 py-2 text-dense" role="status" data-testid="own-review-pending">
          <span className="min-w-0 flex-1">
            Your {OWN_VERDICT[ownWaiting.verdict] ?? 'review'} is on Platform (submitted <Time ms={ownWaiting.at} />), but the node this page reads doesn&apos;t show it yet.
            {isApprover(viewerRole) ? '' : ' It shows here, marked as not counted, once it does.'}
          </span>
          <Button size="sm" variant="outline" onClick={() => refresh((t) => t.reviews.some((x) => x.id === ownWaiting.id), SUBMIT_WAIT)}>
            Refresh
          </Button>
        </div>
      ) : null}
      {since !== null && open ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-anvil-300 bg-anvil-50 px-4 py-3 text-dense dark:border-anvil-700 dark:bg-anvil-900" data-testid="since-your-review">
          <Eye className="h-4 w-4 text-anvil-600 dark:text-anvil-300" aria-hidden />
          <span className="min-w-0 flex-1">
            New commits since your review: you reviewed <Oid value={since.reviewedOid} chars={7} copyable={false} />
            {since.headUpdates > 0 ? `, and the head moved ${plural(since.headUpdates, 'time')} since` : ''}; it is now{' '}
            <Oid value={since.headOid} chars={7} copyable={false} />.
          </span>
          <Button size="sm" variant="outline" onClick={() => setTab('files')}>
            Re-review
          </Button>
        </div>
      ) : null}

      {/* Tabs */}
      <TabStrip role="tablist" label="Pull request" activeKey={tab}>
        <TabButton id="conversation" current={tab} onSelect={setTab} icon={<MessageSquare className="h-4 w-4" aria-hidden />} label="Conversation" count={counts.conversation} />
        <TabButton id="commits" current={tab} onSelect={setTab} icon={<GitCommit className="h-4 w-4" aria-hidden />} label="Commits" count={counts.commits} />
        <TabButton id="checks" current={tab} onSelect={setTab} icon={<ListChecks className="h-4 w-4" aria-hidden />} label="Checks" count={counts.checks} />
        <TabButton id="files" current={tab} onSelect={setTab} icon={<FileDiff className="h-4 w-4" aria-hidden />} label="Files changed" count={counts.files} />
      </TabStrip>

      <div className={cn('grid gap-6', tab !== 'files' && 'lg:grid-cols-[minmax(0,1fr)_16rem]')}>
        <div role="tabpanel" aria-label={tab} className="min-w-0 space-y-4">
          {/* A commit to the PR branch that is running (it may be waiting for a storage choice)
              stays on screen on every tab, not only where it was started. On Conversation a batch's
              shows in the batch bar (QW4-026) and any other above the merge box. */}
          {suggest.runner.busy && !(tab === 'files' || (tab === 'conversation' && (suggest.runner.at === 'batch' || !(open && pull.state.draft)))) ? suggest.runner.view : null}
          {tab === 'conversation' ? (
            <>
              {threadHidden !== null ? <HiddenBanner hidden={threadHidden} noun="pull request" revealed={threadRevealed} onReveal={() => setThreadRevealed(true)} /> : null}
              {threadCollapsed ? null : (
              <>
              {/* Description */}
              <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-anvil-200 bg-anvil-50 px-4 py-2 text-dense coarse:min-h-12 dark:border-anvil-800 dark:bg-anvil-900">
                  <Byline author={pull.author} createdAt={pull.createdAt} origin={origin} verb="opened this" />
                  <EditedMarker createdAt={pull.createdAt} updatedAt={pull.updatedAt} />
                </div>
                <div className="px-4 py-3">
                  {editing ? (
                    <>
                      <MarkdownEditor id="edit-pr-body" label="Description" value={editing.body} onChange={(body) => setEditing({ ...editing, body })} links={links} />
                      <BodyCounter repo={repo} text={editing.body} field="description" long={editLong} />
                    </>
                  ) : pull.body ? (
                    <>
                      <MarkdownView source={pull.body} links={links} imported={pull.importedUrl} />
                      <LongBodyNote long={pull.long} />
                    </>
                  ) : (
                    <p className="italic text-anvil-500 dark:text-anvil-400">No description.</p>
                  )}
                </div>
              </div>

              {timeline.length > 0 ? (
                <Timeline
                  items={conversation}
                  links={links}
                  trust={trust}
                  imported={origin === null ? null : { origin, signer: pull.author, createdAt: pull.createdAt }}
                  branchEvents={branchEvents}
                  {...(moderation ? { moderation } : {})}
                  {...(canModerate
                    ? {
                        moderate: ({ kind, id }: { readonly kind: 'comment' | 'review'; readonly id: string }) => (
                          <HideMenu
                            hidden={isHidden(moderation, id)}
                            blocked={moderationBlocked(thread.moderationInput, identity, id, !isHidden(moderation, id))}
                            what={kind}
                            disabled={false}
                            onHide={(reason) => confirmEvent({ kind: 'hide', item: id, what: kind, reason, hide: true })}
                            onUnhide={() => confirmEvent({ kind: 'hide', item: id, what: kind, reason: null, hide: false })}
                          />
                        ),
                      }
                    : {})}
                  eventText={eventText}
                  anchorContext={anchorContext}
                  renderComment={(item) =>
                    commentSlots({
                      item,
                      viewer: identity,
                      editing: editingComment,
                      editLong: commentEditLong,
                      repo,
                      disabled: writeBlocked || guard.disabledReason !== null,
                      deleteDisabled: archived || guard.disabledReason !== null,
                      onEdit: setEditingComment,
                      onSave: (id, body) => setPending({ kind: 'edit-comment', id, body }),
                      onDelete: (id) => setPending({ kind: 'delete-comment', id }),
                      links,
                      replies: repliesOf.get(item.comment.id) ?? [],
                      trust,
                      resolved: resolved.has(item.comment.id),
                      // The header already says where it points ("commented on …").
                      context: anchorContext(item.comment, false),
                      onShowFiles: () => setTab('files'),
                      suggestions: suggest.actions,
                      carry: withCarried,
                    })
                  }
                />
              ) : null}
              </>
              )}
              <HiddenNote hidden={0} what="comments and reviews" home={home} by={thread.hidden} />
              <EventValuesNote counts={thread.eventValues} />

              {closedBranch !== null && guard.disabledReason === null && !archived && !mergeBusy ? (
                <section aria-label="Source branch" className="flex flex-wrap items-center gap-3 rounded-lg border border-anvil-200 px-4 py-3 dark:border-anvil-800" data-testid="closed-branch-box">
                  {merged ? <GitMerge className={`h-5 w-5 shrink-0 ${STATE_TEXT.done}`} aria-hidden /> : <GitPullRequestClosed className={`h-5 w-5 shrink-0 ${STATE_TEXT.closed}`} aria-hidden />}
                  <div className="min-w-0 flex-1 text-dense">
                    <p className="font-medium">{merged ? 'Pull request merged and closed' : closedBranch.restore ? 'Closed, and its branch was deleted' : 'Closed with unmerged commits'}</p>
                    <p className="break-words text-anvil-500 dark:text-anvil-400">
                      {closedBranch.restore ? (
                        <>
                          The <span className="font-mono">{closedBranch.label}</span> branch was deleted.{merged ? '' : ' Restore it to reopen this pull request.'}
                        </>
                      ) : (
                        <>
                          {merged ? 'The ' : 'This pull request is closed, but the '}
                          <span className="font-mono">{closedBranch.label}</span>
                          {merged ? ' branch can be deleted.' : ' branch still has its commits.'}
                        </>
                      )}
                    </p>
                  </div>
                  {closedBranch.restore ? (
                    <Button variant="outline" size="sm" onClick={() => setPending({ kind: 'restore-branch', label: closedBranch.label, run: closedBranch.run })} data-testid="restore-branch">
                      Restore branch
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => setPending({ kind: 'delete-branch', label: closedBranch.label, run: closedBranch.run })} data-testid="delete-branch">
                      Delete branch
                    </Button>
                  )}
                </section>
              ) : null}

              {/* Merge box */}
              {open && pull.state.draft ? (
                <section aria-label="Draft" className="flex flex-wrap items-center gap-3 rounded-lg border border-anvil-300 px-4 py-3 dark:border-anvil-700" data-testid="draft-box">
                  <GitPullRequestDraft className="h-5 w-5 text-anvil-500 dark:text-anvil-400" aria-hidden />
                  <div className="min-w-0 flex-1 text-dense">
                    <p className="font-medium">This pull request is still a draft</p>
                    <p className="text-anvil-500 dark:text-anvil-400">It can be reviewed, but not merged until it is marked ready.</p>
                  </div>
                  {canAuthorOrMember ? (
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={guard.disabledReason !== null}
                      onClick={() => {
                        confirmEvent({ kind: 'draft', to: 'ready' }, transitionCost)
                      }}
                    >
                      Ready for review
                    </Button>
                  ) : null}
                </section>
              ) : (
                <>
                  {thread.approvals !== null ? (
                    <Approvals approvals={thread.approvals} proved={thread.verdicts} headOid={pull.headOid} />
                  ) : thread.verdicts !== null ? (
                    // The members could not be read (no fold): the proved count alone, said to be an upper bound.
                    <section aria-label="Approvals" className="rounded-lg border border-anvil-200 px-4 py-3 text-dense dark:border-anvil-800">
                      <VerdictLine approvals={null} proved={thread.verdicts} headOid={pull.headOid} />
                    </section>
                  ) : null}
                  <ChecksRow summary={checkSummary} headOid={pull.headOid} onOpen={() => setTab('checks')} />
                  {open && baseTipOid !== '' && cmp !== null && cmp.upToDate !== true && cmp.comparedBaseOid !== baseTipOid && (suggest.write.can || isAuthor) ? (
                    <section aria-label="Update branch" className="flex flex-wrap items-center gap-3 rounded-lg border border-anvil-200 px-4 py-2 text-dense dark:border-anvil-800" data-testid="update-branch">
                      <RefreshCw className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden />
                      <span className="min-w-0 flex-1">
                        This branch is behind <span className="font-mono">{base.replace(/^refs\/heads\//, '')}</span>. Merge the latest changes into it.
                      </span>
                      {suggest.write.can && suggest.who !== null && repo.visibility === 'public' ? (
                        <>
                          <BranchCommitCost isMember={caps.canPush} storage="" />
                          <Button
                            size="sm"
                            variant="outline"
                            loading={suggest.runner.busy}
                            // The branch is past the head: its ref update would be refused (QW2-007); the banner above moves the head first.
                            disabled={headReader === null || comparison.headOnly === null || guard.disabledReason !== null || sync?.kind === 'ahead'}
                            onClick={() => {
                              const who = suggest.who
                              if (headReader !== null && who !== null) void suggest.runner.run(`update:${pull.headOid}:${baseTipOid}`, 'Update branch', () => buildUpdateBranch(headReader, pull, baseTipOid, who))
                            }}
                          >
                            Update branch
                          </Button>
                        </>
                      ) : suggest.write.can && suggest.who === null ? (
                        <CommitIdentityPrompt what="update the branch" />
                      ) : (
                        <span className="text-[12px] text-anvil-500 dark:text-anvil-400">{repo.visibility === 'private' ? 'Use `dg pr update-branch` for a private repo.' : 'Only the PR author or a maintainer, with write access to the source branch, can update it.'}</span>
                      )}
                    </section>
                  ) : null}
                  {/* Every run but the batch's (the batch bar shows that one): Conversation does not
                      render every comment (hidden, collapsed, being edited), so a suggestion's run
                      shows here rather than under its comment. */}
                  {tab === 'conversation' && suggest.runner.at !== 'batch' ? suggest.runner.view : null}
                </>
              )}
            </>
          ) : null}
          {/* The merge box: one slot for every tab, so a merge running in it (maybe waiting for a
              storage choice) survives a tab switch and can be finished (mergeBoxSlot). */}
          {mergeSlot === 'none' ? null : (
            <div hidden={mergeSlot === 'kept'} className="space-y-4 empty:hidden" data-testid="merge-slot">
              <PullMerge
                repo={repo}
                home={home}
                pull={pull}
                canMerge={actions.canMerge && !archived}
                isMaintainer={holdings.data?.maintain === true}
                checkout={checkout}
                onMerged={() => {
                  refresh((t) => t.pull.state.merged)
                  // The base branch moved and a pack was stored: the repo's refs and its
                  // browse context are out of date too (L-09).
                  reloadHome?.()
                }}
                extras={{
                  onRunning: setMergeRunning,
                  branchAhead: sync?.kind === 'ahead' ? { branch: shortBranch(pull.sourceRefName ?? ''), tip: sync.tip } : null,
                  checkSourceBranch,
                  onBranchDeleted: () => {
                    if (pull.sourceRefName !== null) setBranchWrite({ ref: pull.sourceRefName, head: pull.headOid, to: 'deleted' })
                    sourceState.reload()
                  },
                  active: mergeSlot === 'shown',
                  unmetRules: actions.unmetRules,
                  canBypass: actions.canBypass,
                  allowedMethods: policyNow?.mergeMethods ?? 0,
                  squashAuthors: commits.error
                    ? { error: commits.error }
                    : commits.data === null
                      ? null
                      : { authors: commitAuthors(commits.data.commits), complete: !commits.data.truncated },
                  closeIssues: closeLinked,
                  deleteBranch: (() => {
                    const src = sourceRef ?? (crossRepo ? null : repo)
                    const name = pull.sourceRefName
                    // `sourceDefault.data` is null until the default branch has been read (and after a failed read).
                    const offer = deleteBranchOffer({
                      refName: name,
                      source: src === null ? null : { visibility: src.visibility, sameRepo: src.repoId === repo.repoId },
                      canWrite: sourceWrite.known ? sourceWrite.can : null,
                      baseRefName: pull.mergeBaseRefName,
                      defaultBranch: sourceDefault.data,
                      headOid: pull.headOid,
                    })
                    if (offer.kind === 'hide' || src === null || name === null) return null
                    const label = `${sourcePrefix}${name.replace(/^refs\/heads\//, '')}`
                    if (offer.kind === 'explain') return { label, disabled: offer.reason }
                    const head = pull.headOid
                    return { label, run: () => deleteSourceBranch(src, name, head) }
                  })(),
                }}
              />
            </div>
          )}
          {tab === 'conversation' ? (
            <>
              {!(open && pull.state.draft) && open && (actions.baseProtected || rules.status !== null) ? (
                <BranchRules base={pull.mergeBaseRefName} baseProtected={actions.baseProtected} policy={rules.policy} status={rules.status} checks={requiredChecks} />
              ) : null}

              {/* Composer */}
              <div className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800" data-testid="pr-composer">
                {/* Locked: a non-member's composer is replaced by the banner (consensus would refuse the post). */}
                <LockedBanner locked={thread.locked && !archived} viewer={lockViewer} target="pull">
                  <h3 className="mb-2 text-dense font-medium">Add a comment</h3>
                  {composeBlock !== null ? (
                    <PrivateComposeNote reason={composeBlock} />
                  ) : (
                    <>
                      <MarkdownEditor id="pr-comment" label="Comment" value={comment} onChange={setComment} placeholder="Leave a comment (markdown supported)…" links={links} />
                      <SealedLimit repo={repo} kind="comment" text={comment.trim()} long={commentLong} />
                      <BodyCounter repo={repo} text={comment.trim()} field="comment" long={commentLong} />
                    </>
                  )}
                </LockedBanner>
                <div className={cn('mt-3 flex flex-wrap items-center justify-between gap-3', writeBlocked && !actions.canCloseReopen && !showMarkMerged && 'hidden')}>
                  {writeBlocked ? <span /> : <CostPreview cost={commentCost} />}
                  <div className="flex flex-wrap items-center gap-2">
                    {actions.canCloseReopen ? (
                      <Button
                        variant="outline"
                        onClick={() => setPending(withComment === null ? { kind: 'state', to: open ? 'close' : 'reopen' } : { kind: 'state', to: open ? 'close' : 'reopen', comment: withComment })}
                        disabled={!signer || guard.disabledReason !== null || archived || reopenBlocked !== null}
                        title={reopenBlocked ?? undefined}
                        data-testid="pull-state-toggle"
                      >
                        {open ? <GitPullRequestClosed className={`h-3.5 w-3.5 ${STATE_TEXT.closed}`} aria-hidden /> : <GitPullRequest className={`h-3.5 w-3.5 ${STATE_TEXT.open}`} aria-hidden />}
                        {stateToggleLabel(open, withComment !== null, 'pull request')}
                      </Button>
                    ) : null}
                    {showMarkMerged ? (
                      <Button
                        variant="outline"
                        onClick={() => setPending({ kind: 'mark-merged', bypass: actions.unmetRules })}
                        disabled={!signer || guard.disabledReason !== null || archived}
                        title={archived ? ARCHIVED_REASON : 'Records a merge done elsewhere; it moves no code'}
                      >
                        <GitMerge className="h-3.5 w-3.5" aria-hidden /> Mark as merged (done elsewhere)
                      </Button>
                    ) : null}
                    {writeBlocked ? null : (
                      <Button
                        variant="primary"
                        onClick={postComment}
                        loading={posting}
                        disabled={comment.trim() === '' || commentTooLong || guard.disabledReason !== null}
                        title={guard.disabledReason ?? undefined}
                      >
                        {identity ? 'Comment' : locked ? 'Unlock to comment' : 'Sign in to comment'}
                      </Button>
                    )}
                  </div>
                </div>
                {open && viewer !== null && pull.headOid && !writeBlocked ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-anvil-100 pt-3 dark:border-anvil-850">
                    <span className="text-dense text-anvil-500 dark:text-anvil-400">
                      Review head <span className="font-mono">{pull.headOid.slice(0, 9)}</span>:
                    </span>
                    {(Object.keys(VERDICT_TEXT) as VerdictInput[]).filter((v) => !isAuthor || v === 'comment').map((v) => (
                      <Button
                        key={v}
                        size="sm"
                        variant={v === 'approve' ? 'primary' : 'outline'}
                        // Until the viewer's membership is read, a verdict would be recorded as a non-member's.
                        disabled={guard.disabledReason !== null || (v !== 'comment' && !holdings.settled)}
                        onClick={() => {
                          if (!commentTooLong && guard.check(composeCost(repo, 'review', { body: comment.trim() }, reviewFirst), 'collab')) setPending({ kind: 'review', verdict: v, body: comment.trim() })
                        }}
                      >
                        {VERDICT_TEXT[v]}
                      </Button>
                    ))}
                    {isAuthor ? (
                      <span className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="author-review-note">
                        You opened this PR: your own approval would never count, so only a comment-only review is offered.
                      </span>
                    ) : !isApprover(viewerRole) && holdings.settled ? (
                      <span className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="approval-not-counted-note">
                        {viewerRole === 'triage' || viewerRole === 'reader'
                          ? `You're ${ROLE_NOUN[viewerRole]} here: your review is recorded, but only approvals from maintainers and writers count.`
                          : 'Only approvals from maintainers and writers count.'}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {showMarkMerged ? (
                  <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">
                    {`The head commit is already on ${base}: "Mark as merged (done elsewhere)" records that merge. It moves no code, and it is final.`}
                    {actions.unmetRules.length > 0 ? ' The branch rules are not met, so recording it is a bypass, recorded on the PR.' : ''}
                  </p>
                ) : actions.mergeHint !== null ? (
                  <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">{actions.mergeHint}</p>
                ) : null}
                {reopenBlocked !== null && actions.canCloseReopen ? (
                  <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="reopen-blocked">
                    {reopenBlocked}
                  </p>
                ) : null}
                {commentError ? (
                  <div role="alert" className="mt-2 break-words rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger-700 dark:text-danger-400">
                    {commentError}
                  </div>
                ) : null}
              </div>
              {suggest.bar}
            </>
          ) : tab === 'commits' ? (
            <CommitsTab
              signing={{ repo, author: pull.author }}
              commits={commits.data}
              error={comparison.error ?? commits.error}
              loading={commits.loading}
              addr={addr}
              sourceAddr={sourceAddr}
              unavailable={
                pull.headOid === ''
                  ? 'This PR does not record a head commit.'
                  : comparison.waiting === null && comparison.sides === null
                    ? "Neither the base repo nor the repo holding the PR's head could be loaded, so there are no commits to list."
                    : null
              }
              onRetry={() => (comparison.error ? comparison.tryAgain() : commits.reload())}
            />
          ) : tab === 'checks' ? (
            <ChecksTab
              runs={checks.data?.runs ?? null}
              summary={checkSummary}
              headOid={pull.headOid}
              error={checks.error}
              onRetry={checks.reload}
              expected={expectedChecks(checks.data?.runs ?? [], policyNow)}
              rerun={{
                runners: checks.data?.runners ?? NO_RUNNERS,
                pending: rerunPending,
                canRequest: identity !== null && open && caps.canRerunChecks && !writeBlocked,
                onRerun: (check) => confirmEvent({ kind: 'rerun', check }, rerunCost(check)),
              }}
            />
          ) : (
            <BranchRunContext.Provider value={branchRun}>
            {/* A suggestion's run shows under its comment, the batch's in the batch bar (QW-007);
                only an "Update branch" run started on the conversation shows here. */}
            {suggest.runner.at === 'update' ? suggest.runner.view : null}
            <ComparisonView
              state={comparison}
              noHead="This PR does not record a head commit."
              action={
                identity !== null && open && !writeBlocked ? (
                  <ReviewDrawer
                    repo={repo}
                    pullId={pull.id}
                    headOid={pull.headOid}
                    draft={reviewDraft.draft}
                    loaded={reviewDraft.loaded}
                    update={reviewDraft.update}
                    ensure={reviewDraft.ensure}
                    isMember={isMember}
                    isAuthor={isAuthor}
                    locked={thread.locked}
                    lineExists={(path, side, line) => knownLines.current.get(path)?.has(lineKey(path, side, line)) ?? false}
                    onSubmitted={(s) => {
                      if (ownScope !== null) rememberOwnReview(ownScope, { id: s.reviewId, verdict: 'review', at: Date.now() })
                      setOwnTick((n) => n + 1)
                      setArriving(s)
                      refresh((t) => reviewShows(t, s), SUBMIT_WAIT)
                    }}
                  />
                ) : null
              }
              wrap={(c, diff) => (
                <InlineCommentsProvider
                  repo={repo}
                  post={postContext}
                  writeBlock={composeBlock}
                  pullId={pull.id}
                  headOid={pull.headOid}
                  comments={comments}
                  changedPaths={new Set(c.changes.flatMap((x) => (x.oldPath !== undefined ? [x.path, x.oldPath] : [x.path])))}
                  onPosted={onInlinePosted}
                  actions={threadActions}
                  onLinesKnown={rememberLines}
                  suggestions={suggest.actions}
                  {...(identity !== null && open && !writeBlocked && reviewDraft.pending ? { pending: reviewDraft.pending } : {})}
                >
                  {/* Code owners from the base branch's file, as GitHub reads them. */}
                  <CodeOwnersProvider reader={c.sides.base} readerKey={comparison.sidesKey} commitOid={comparison.spec.baseTipOid || c.comparedBaseOid || ''}>
                    {diff}
                  </CodeOwnersProvider>
                </InlineCommentsProvider>
              )}
            />
            {suggest.bar}
            </BranchRunContext.Provider>
          )}
        </div>

        {tab !== 'files' ? (
          <aside className="space-y-4 text-dense" aria-label="Pull request details">
            <SidebarSection title="Reviewers" icon={Eye}>
              <ReviewersCard
                rows={thread.reviewers}
                imported={sourceReviewers.reviewers}
                mirrorOnly={sourceReviewers.mirrorOnly}
                members={thread.members}
                author={pull.author}
                headOid={pull.headOid}
                membersKnown={thread.approvals !== null}
                canRequest={canRequestReview && open && guard.disabledReason === null}
                canDismiss={canMember && caps.canDismiss && open}
                onRequest={(who, remove) => {
                  confirmEvent({ kind: 'request', who, remove }, withAddressee(eventCost))
                }}
                onDismiss={(row, reason) => {
                  confirmEvent({ kind: 'dismiss', row, reason }, withAddressee(previewCreate('event', { value: reason }, eventFirst)))
                }}
              />
            </SidebarSection>
            <SidebarSection title="Assignees" icon={UserPlus}>
              <AssigneePicker
                assignees={pull.state.assignees}
                members={thread.members.map((m) => m.identity)}
                canEdit={canMember && caps.canAssign}
                onApply={(change) => setPending({ kind: 'assignees', change })}
              />
            </SidebarSection>
            <SidebarSection title="Labels" icon={Tag}>
              <LabelPicker
                applied={pull.state.labels}
                defs={thread.labels}
                byName={new Map(thread.labels.map((l) => [l.name, l]))}
                canEdit={canMember && caps.canLabel}
                onApply={(change) => setPending({ kind: 'labels', change })}
                onDefine={(name, color, description) => setPending({ kind: 'define-label', name, color, description })}
                manageHref={repoHref('/repo/labels', addr)}
              />
            </SidebarSection>
            {/* Milestone, as on an issue (QW2-050): a member event naming it. */}
            <SidebarSection title="Milestone" icon={MilestoneIcon}>
              <MilestonePicker
                current={review.milestone}
                choices={milestones.data ?? []}
                loading={milestones.data === null && milestones.error === null}
                canDefine={repo.visibility !== 'private'}
                canEdit={canMember && caps.canMilestone}
                onChoose={(title) => setPending({ kind: 'milestone', title })}
                manageHref={repoHref('/repo/milestones', addr)}
              />
            </SidebarSection>
            <SidebarSection title="Linked issues" icon={Link2}>
              {linked.length === 0 ? (
                <p className="text-anvil-500 dark:text-anvil-400">None. &ldquo;Fixes #12&rdquo; in the description links one.</p>
              ) : (
                <ul className="space-y-1" data-testid="linked-issues">
                  {linked.map((n) => (
                    <li key={n}>
                      {/* An imported description's #n is the source forge's: resolved to the native issue (`upstream=`). */}
                      <Link href={repoHref('/repo/issue', addr, linkedUpstream ? { upstream: String(n) } : { number: String(n) })} className="text-forge-700 underline underline-offset-2 dark:text-forge-400">
                        #{n}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </SidebarSection>
            {open && canAuthorOrMember && !pull.state.draft ? (
              <button
                type="button"
                onClick={() => {
                  confirmEvent({ kind: 'draft', to: 'draft' }, transitionCost)
                }}
                className="text-[12px] text-anvil-500 underline-offset-2 hover:text-forge-700 hover:underline dark:text-anvil-400 dark:hover:text-forge-400"
              >
                Convert to draft
              </button>
            ) : null}
            <SidebarSection title="Where it lives" icon={HardDrive}>
              <p className="text-anvil-500 dark:text-anvil-400">
                {!crossRepo ? (
                  <>Objects live in this repo</>
                ) : sourceRef && sourceAddr ? (
                  <>
                    Objects live in{' '}
                    <Link href={repoHref('/repo', sourceAddr)} className="break-all text-forge-700 underline underline-offset-2 dark:text-forge-400" data-testid="pr-source-repo">
                      {forkOwnerLabel}/{sourceRef.name}
                    </Link>
                  </>
                ) : (
                  <>
                    Objects live in repo <span className="break-all font-mono">{pull.sourceId}</span>
                  </>
                )}
                {pull.sourceRefName ? (
                  <>
                    {' '}
                    on <span className="font-mono">{shortBranch(pull.sourceRefName)}</span>
                    {sync?.kind === 'deleted' ? <span data-testid="source-branch-deleted"> (deleted)</span> : null}
                  </>
                ) : null}
              </p>
              {sync?.kind === 'deleted' ? (
                // `dg pr checkout` fetches the source's branches, so with the branch gone it has
                // nothing to fetch: a merged head is in the base's history, checked out by id.
                <>
                  <p className="mt-1 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="source-branch-deleted-note">
                    The branch was deleted. The PR&apos;s head is <Oid value={pull.headOid} chars={7} copyable={false} />
                    {merged ? `, in ${shortBranch(pull.mergeBaseRefName)}'s history:` : '.'}
                  </p>
                  {merged ? <CopyRow text={`git switch --detach ${pull.headOid}`} label="Copy the checkout command" className="mt-2" /> : null}
                </>
              ) : (
                <CopyRow text={checkout} label="Copy the checkout command" className="mt-2" />
              )}
            </SidebarSection>
            {/* Lock conversation (GitHub: the rail's last entry): a member transition, for maintainers and writers. */}
            {isMember || thread.locked ? (
              <SidebarSection title="Conversation" icon={thread.locked ? Lock : LockOpen}>
                <p className="text-anvil-600 dark:text-anvil-300" data-testid="thread-lock-state">
                  {lockStateText(thread.locked)}
                </p>
                {canMember && caps.canLock ? (
                  <div className="mt-2">
                    <LockToggle locked={thread.locked} onToggle={(on) => confirmEvent({ kind: 'lock', on }, transitionCost)} />
                  </div>
                ) : null}
                {!archived ? (
                  <RoleLimitNote
                    role={viewerRole}
                    cap="canMerge"
                    what={caps.canLock ? 'merge, mark drafts ready, update heads or dismiss reviews' : 'lock, label, assign or set milestones as a member'}
                    className="mt-2"
                  />
                ) : null}
                {canModerate ? (
                  <div className="mt-2">
                    <HideThreadControl
                      hidden={threadHidden !== null}
                      blocked={moderationBlocked(thread.moderationInput, identity, null, threadHidden === null)}
                      noun="pull request"
                      offerClose={open}
                      offerLock={!thread.locked}
                      onHide={(reason, closeAndLock) => confirmEvent({ kind: 'hide', item: null, what: 'pull request', reason, hide: true, closeAndLock })}
                      onUnhide={() => confirmEvent({ kind: 'hide', item: null, what: 'pull request', reason: null, hide: false })}
                    />
                  </div>
                ) : null}
              </SidebarSection>
            ) : null}
            {holdings.settled && holdings.data === null && identity !== null ? (
              <p className="text-[12px] text-anvil-500 dark:text-anvil-400">Couldn&apos;t read this repo&apos;s {ACL_NAME}, so your permissions are unknown.</p>
            ) : null}
          </aside>
        ) : null}
      </div>

      <ConfirmDialog open={pending !== null} onClose={() => setPending(null)} title={confirm.title} description={confirm.description} cost={pendingCost} confirmLabel={confirm.label} onConfirm={runPending} />
    </div>
  )
}

function TabButton({
  id,
  current,
  onSelect,
  icon,
  label,
  count,
}: {
  id: PrTab
  current: PrTab
  onSelect: (t: PrTab) => void
  icon: ReactNode
  label: string
  count: number | 'many' | null
}): JSX.Element {
  const on = id === current
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      data-testid={`pr-tab-${id}`}
      onClick={() => onSelect(id)}
      className={cn(
        '-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-dense font-medium coarse:min-h-11',
        on ? 'border-forge-600 text-anvil-900 dark:text-anvil-50' : 'border-transparent text-anvil-600 hover:text-anvil-900 dark:text-anvil-400 dark:hover:text-anvil-100',
      )}
    >
      {icon}
      {label}
      <span className="rounded-full bg-anvil-100 px-1.5 text-[11px] text-anvil-700 dark:bg-anvil-800 dark:text-anvil-300" data-testid={`pr-tab-${id}-count`}>
        {count === null ? '…' : count === 'many' ? `${WALK_COMMIT_CAP.toLocaleString('en-US')}+` : count}
      </span>
    </button>
  )
}

/** The checks row of the merge box (review-parity §4.8 row 2). */
function ChecksRow({ summary, headOid, onOpen }: { summary: ChecksSummary | null; headOid: string; onOpen: () => void }): JSX.Element | null {
  if (summary === null) return null
  const icon =
    summary.total === 0 ? (
      <ListChecks className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden />
    ) : summary.failing > 0 ? (
      <X className="h-4 w-4 text-danger-700 dark:text-danger-400" aria-hidden />
    ) : summary.pending > 0 ? (
      <RefreshCw className="h-4 w-4 text-caution-700 dark:text-caution-400" aria-hidden />
    ) : (
      <Check className="h-4 w-4 text-verify-700 dark:text-verify-400" aria-hidden />
    )
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-anvil-200 px-4 py-2 text-dense dark:border-anvil-800" data-testid="checks-row">
      {icon}
      <span className="flex-1">
        {checksPhrase(summary)}
        {summary.total === 0 && summary.membersKnown ? (
          <>
            {' '}
            for <Oid value={headOid} chars={7} copyable={false} />
          </>
        ) : null}
      </span>
      {summary.total + summary.untrusted > 0 ? (
        <button type="button" onClick={onOpen} className="hit-area text-[12px] text-forge-700 underline-offset-2 hover:underline dark:text-forge-400">
          Details
        </button>
      ) : null}
    </div>
  )
}

/** The confirm dialog's words for each pending write. */
function confirmText(pending: Pending | null, number: number, isMember: boolean, head: string, base: string): { title: string; description: string; label: string } {
  const via = isMember ? 'a member event' : 'an author event (you opened this PR)'
  const move = isMember ? 'a state change as a member' : 'a state change as the PR author'
  switch (pending?.kind) {
    case 'state': {
      const still = `Platform accepts it only if the PR is still ${pending.to === 'close' ? 'open' : 'closed'}.`
      return pending.comment !== undefined
        ? {
            title: `${pending.to === 'close' ? 'Close' : 'Reopen'} PR #${number} with your comment`,
            description: `Two writes: your comment, then ${move}. ${still}`,
            label: stateToggleLabel(pending.to === 'close', true, 'pull request'),
          }
        : { title: `${pending.to === 'close' ? 'Close' : 'Reopen'} PR #${number}`, description: `Records ${move}. ${still}`, label: pending.to === 'close' ? 'Close PR' : 'Reopen PR' }
    }
    case 'mark-merged':
      return pending.bypass.length > 0
        ? {
            title: `Bypass the branch rules and mark PR #${number} as merged`,
            description: `Records the merge of ${head.slice(0, 9)}, already on ${base}, done elsewhere. It moves no code, and it is final. These branch rules are not met, so this is a bypass, recorded on the PR as an event nobody can delete: ${pending.bypass.join('; ')}.`,
            label: 'Sign & record (bypass rules)',
          }
        : {
            title: `Mark PR #${number} as merged (done elsewhere)`,
            description: `Records the merge of ${head.slice(0, 9)}, already on ${base}, done elsewhere. It moves no code, and it is final.`,
            label: 'Sign & mark merged',
          }
    case 'review':
      return {
        title: `${VERDICT_TEXT[pending.verdict]} PR #${number}`,
        description: `Records ${VERDICT_RECORDS[pending.verdict]} on ${head.slice(0, 9)}${pending.body ? ', with your comment as its body' : ''}. New commits make it stale. Reviews can't be edited; a maintainer can dismiss one.`,
        label: 'Sign & submit review',
      }
    case 'draft':
      return pending.to === 'ready'
        ? { title: `Mark PR #${number} ready for review`, description: `Records ${move}. Reviewers see it as ready; it can be merged.`, label: 'Sign & mark ready' }
        : { title: `Convert PR #${number} to a draft`, description: `Records ${move}. A draft can be reviewed but not merged.`, label: 'Sign & convert' }
    case 'head':
      return {
        title: `Update PR #${number}'s head`,
        description: `Appends a head update naming ${pending.oid.slice(0, 9)}, ${via}. The diff, the commits and the approvals then follow the new head; approvals on the old head become stale.`,
        label: 'Sign & update head',
      }
    case 'request':
      return pending.remove
        ? { title: 'Remove the review request', description: `Appends ${via} naming ${pending.who.slice(0, 10)}….`, label: 'Sign & remove' }
        : {
            title: 'Request a review',
            description: `Appends ${via} naming ${pending.who.slice(0, 10)}… as a requested reviewer. They see it under "review requested"; nothing notifies them otherwise.`,
            label: 'Sign & request',
          }
    case 'dismiss':
      return {
        title: 'Dismiss this review',
        description: `Appends a member event: the review no longer counts for or against the PR.${pending.reason ? ` The reason "${pending.reason}" is public, even in a private repo.` : ''}`,
        label: 'Sign & dismiss',
      }
    case 'labels':
      return labelsConfirm(pending.change)
    case 'assignees':
      return assigneesConfirm(pending.change)
    case 'milestone':
      return pending.title === null
        ? { title: 'Clear the milestone', description: 'Appends a milestone-clear event.', label: 'Sign & clear' }
        : { title: `Set milestone "${pending.title}"`, description: 'Appends a milestone event naming it.', label: 'Sign & set' }
    case 'restore-branch':
      return {
        title: `Restore branch ${pending.label}`,
        description: `Records a ref update that points the branch at this PR's head, ${head.slice(0, 9)}, again. Its commits are still stored in the repo.`,
        label: 'Sign & restore branch',
      }
    case 'delete-branch':
      return {
        title: `Delete branch ${pending.label}`,
        description: 'Records a ref update that deletes the branch. Its commits stay reachable from this PR by their ids, and anyone who has them can push the branch again.',
        label: 'Sign & delete branch',
      }
    case 'define-label':
      return { title: `Create label "${pending.name}"`, description: 'Two documents: the label definition (for the whole repo), then a label event on this PR.', label: 'Sign & create' }
    case 'edit-pull':
      return { title: `Edit PR #${number}`, description: 'Replaces your PR document; you pay only for the changed bytes. Earlier versions stay readable on Platform.', label: 'Sign & save' }
    case 'edit-comment':
      return { title: 'Edit comment', description: 'Replaces your comment document; you pay only for the changed bytes.', label: 'Sign & save' }
    case 'delete-comment':
      return { title: 'Delete comment', description: 'Deletes your comment document (its storage fee is partly refunded). Replies to it stay.', label: 'Sign & delete' }
    case 'resolve':
      return pending.resolve
        ? { title: 'Resolve conversation', description: `Appends ${via} naming the thread. It collapses for everyone; anyone who can resolve it can unresolve it.`, label: 'Sign & resolve' }
        : { title: 'Unresolve conversation', description: `Appends ${via} naming the thread.`, label: 'Sign & unresolve' }
    case 'rerun':
      return {
        title: pending.check === null ? `Re-run all checks on PR #${number}` : `Re-run ${pending.check}`,
        description: `Appends a member event asking this repository's runners to run ${pending.check === null ? 'every check' : 'this check'} on ${head.slice(0, 9)} again. A forge-runner watching the repository picks it up at its next poll, or within seconds when its relay wakes it, and its new run replaces the one shown. If the PR's head moves first, nothing re-runs: the new head runs by itself.`,
        label: 'Sign & request re-run',
      }
    case 'lock':
      return lockConfirm(pending.on, `PR #${number}`, 'pull')
    case 'hide':
      return hideConfirm(pending, `PR #${number}`)
    default:
      return { title: '', description: '', label: 'Confirm' }
  }
}

/** A comment's slots on the PR page: the author's Edit and Delete, the inline editor, an inline thread's anchor and replies. */
function commentSlots({
  item,
  viewer,
  editing,
  editLong,
  repo,
  disabled,
  deleteDisabled,
  onEdit,
  onSave,
  onDelete,
  links,
  replies,
  trust,
  resolved,
  context,
  onShowFiles,
  suggestions,
  carry,
}: {
  item: Extract<TimelineItem, { kind: 'comment' }>
  viewer: string | null
  editing: { id: string; body: string } | null
  /** The edited text over its field (`useLongCompose`). */
  editLong: LongCompose
  repo: RepoRef
  disabled: boolean
  /** Delete's own gate: a delete carries no content (see `CommentOwnActions`). */
  deleteDisabled: boolean
  onEdit: (e: { id: string; body: string } | null) => void
  onSave: (id: string, body: string) => void
  onDelete: (id: string) => void
  links: MarkdownLinks
  replies: readonly CommentView[]
  /** Who may mirror: an imported reply of theirs shows its original author and date (FG-6). */
  trust?: ReadonlySet<string> | null
  resolved: boolean
  /** An inline comment's heading: its place, markers and code (`AnchorContext`). */
  context: ReactNode
  onShowFiles: () => void
  /** Apply / Add to batch on a comment's suggestions, as in Files changed (QW4-026). */
  suggestions: SuggestionActions
  /** The comment where it is on the head now (carried past an unchanged-lines head move). */
  carry: (c: CommentView) => CommentView
}): CommentSlots {
  const c = item.comment
  const tags =
    c.anchor !== null ? (
      <span className="flex items-center gap-1.5">
        {resolved ? <span className="rounded-full bg-verify/10 px-2 py-0.5 text-[11px] text-verify-700 dark:text-verify-400" data-testid="thread-resolved">Resolved</span> : null}
      </span>
    ) : null
  const edit =
    viewer !== null && viewer === c.author && editing?.id !== c.id ? (
      // A long comment whose rest could not be read is not edited here: the edit would drop the rest.
      <CommentOwnActions onEdit={() => onEdit({ id: c.id, body: c.body })} onDelete={() => onDelete(c.id)} disabled={disabled || longEditBlock(c.long) !== null} deleteDisabled={deleteDisabled} />
    ) : null
  const header = (
    <>
      {tags}
      {edit}
    </>
  )
  if (editing?.id === c.id) {
    return {
      header: tags,
      body: (
        <div className="space-y-2 px-4 py-3">
          <MarkdownEditor id={`edit-comment-${c.id}`} label="Edit comment" value={editing.body} onChange={(body) => onEdit({ id: c.id, body })} links={links} autoFocus />
          <BodyCounter repo={repo} text={editing.body} field="comment" long={editLong} />
          <div className="flex gap-2">
            <Button variant="primary" size="sm" disabled={editing.body.trim() === '' || editing.body === c.body || (editLong.long ? editLong.problem !== null : utf8Length(editing.body) > BODY_MAX)} onClick={() => onSave(c.id, editing.body)}>
              Save
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onEdit(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ),
    }
  }
  if (c.anchor === null) return { header }
  return {
    header,
    body: (
      <div className="space-y-2 px-4 py-3">
        {context}
        <SuggestedBody
          comment={carry(c)}
          suggestions={suggestions}
          source={trustedOrigin(c.origin, c.author, trust ?? null) !== null ? mirroredCommentText(c.body, c.anchor).text : c.body}
          links={links}
          imported={importedUrlOf(c.importedRaw)}
        />
        {replies.map((r) => {
          const origin = trustedOrigin(r.origin, r.author, trust ?? null)
          return (
            <div key={r.id} className="border-l-2 border-anvil-200 pl-3 dark:border-anvil-750" data-testid="thread-reply">
              <div className="flex items-center gap-2 text-[12px] text-anvil-600 dark:text-anvil-400">
                <Byline author={r.author} createdAt={r.createdAt} origin={origin} link={false} />
              </div>
              {/* A mirrored reply, like its root, without the provenance quote and the file line
                  the import repeats on every comment (QW4-029): the byline and the thread say both. */}
              <SuggestedBody
                comment={carry(r)}
                suggestions={suggestions}
                source={origin !== null ? mirroredCommentText(r.body, r.anchor ?? c.anchor).text : r.body}
                links={links}
                imported={importedUrlOf(r.importedRaw)}
              />
            </div>
          )
        })}
        <button type="button" onClick={onShowFiles} className="hit-area text-[12px] text-forge-700 underline-offset-2 hover:underline dark:text-forge-400">
          View in Files changed
        </button>
      </div>
    ),
  }
}

/** The copy-to-shell checkout line, from the resolved repo (never the URL's own text). */
export function checkoutCommand(repo: { readonly ownerId: string; readonly name: string }, number: number): string {
  return `dg pr checkout ${repo.ownerId}/${repo.name} ${number}`
}

/**
 * The base branch's rules (review-parity spec §4.8): protection (consensus-backed: only a
 * maintainer's `protectedRefUpdate` can move it) and the branch policy (a client rule).
 */
function BranchRules({
  base,
  baseProtected,
  policy,
  status,
  checks,
}: {
  base: string
  baseProtected: boolean
  policy: Policy | null | 'unknown'
  status: PolicyStatus | null | 'unknown'
  /** The head's required checks (`checksState`); null: none required; 'unknown': not read yet. */
  checks: ChecksState | null | 'unknown'
}): JSX.Element {
  const short = shortBranch(base)
  // The checks the policy requires: by name, or (none named) every reported one. Null: no policy read.
  const known = policy !== null && policy !== 'unknown' ? policy : null
  const named = known?.requiredChecks ?? []
  const line = requiredChecksLine(checks, named)
  return (
    <section aria-label="Branch rules" className="rounded-lg border border-anvil-200 px-4 py-3 text-dense dark:border-anvil-800">
      {baseProtected ? (
        <p className="flex items-center gap-2" data-testid="protected-base">
          <ShieldCheck className="h-4 w-4 text-forge-500" aria-hidden />
          <span>
            <span className="font-mono">{short}</span> is protected: only maintainers can merge into it. Enforced by Platform (a writer&apos;s update of it is refused or
            inert).
          </span>
        </p>
      ) : null}
      {policy === 'unknown' || status === 'unknown' ? (
        <p className="mt-1 flex items-center gap-2" data-testid="policy-status">
          <X className="h-4 w-4 text-caution" aria-hidden />
          <span>Couldn&apos;t read the branch policy; merging is blocked until it loads (a maintainer can bypass it).</span>
        </p>
      ) : policy !== null && status !== null ? (
        <>
          <p className="mt-1 flex items-center gap-2" data-testid="policy-status">
            {status.have >= status.need ? <Check className="h-4 w-4 text-verify" aria-hidden /> : <X className="h-4 w-4 text-danger" aria-hidden />}
            <span>
              {status.have} of {plural(status.need, 'required approval')}
              {policy.approverRole === 1 ? ' (maintainers)' : ''}
            </span>
          </p>
          {status.blockedBy.length > 0 ? (
            <p className="mt-1 flex items-center gap-2" data-testid="policy-changes-requested">
              <X className="h-4 w-4 shrink-0 text-danger" aria-hidden />
              <span>Changes requested by {plural(status.blockedBy.length, 'reviewer')}. Merging waits until they approve or the review is dismissed.</span>
            </p>
          ) : null}
        </>
      ) : null}
      {known !== null && (named.length > 0 || known.requireChecks === true) ? (
        <p className="mt-1 flex items-center gap-2" data-testid="policy-checks">
          {line.ok ? <Check className="h-4 w-4 shrink-0 text-verify" aria-hidden /> : <X className="h-4 w-4 shrink-0 text-danger" aria-hidden />}
          <span className="min-w-0 [overflow-wrap:anywhere]">{line.text}</span>
        </p>
      ) : null}
      {policy !== null && policy !== 'unknown' && (policy.mergeMethods ?? 0) !== 0 ? (
        <p className="mt-1 text-[12px] text-anvil-600 dark:text-anvil-400" data-testid="policy-methods">
          Allowed merge methods: {MERGE_METHODS.filter((m) => ((policy.mergeMethods ?? 0) & m.bit) !== 0).map((m) => m.label).join(', ')}
        </p>
      ) : null}
      {policy !== null ? (
        <p className="mt-2 text-[12px] text-anvil-600 dark:text-anvil-400">
          Policy is a client rule; a maintainer can bypass it, and the bypass is recorded on the PR. The PR author&apos;s own approval never counts. Nothing at consensus requires
          approvals.
        </p>
      ) : null}
    </section>
  )
}

/** `Name <email>` of each commit's author, oldest first, each once (the squash's Co-authored-by, as `dg`'s `git::authors`). */
function commitAuthors(commits: readonly { readonly commit: { readonly author: { readonly name: string; readonly email: string } } }[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of [...commits].reverse()) {
    const a = `${c.commit.author.name} <${c.commit.author.email}>`
    if (!seen.has(a)) {
      seen.add(a)
      out.push(a)
    }
  }
  return out
}

/** What a merged PR's recorded merge commit holds (`merge-content.ts`), next to its state. */
function MergeContentNote({ content, mergeOid }: { content: MergeContent; mergeOid: string }) {
  const combined = content.combined.length > 0 ? `, combined with base changes in ${plural(content.combined.length, 'file')}` : ''
  const words: Record<MergeContent['verdict'], string> = {
    contains: 'contains this PR',
    squash: `squash of this PR${combined}`,
    rebase: `rebase of this PR${combined}`,
    missing: "does not contain this PR's commits",
    unknown: "couldn't check: its commits could not be read",
  }
  const missing = content.verdict === 'missing'
  return (
    <span
      className={`flex items-center gap-1 text-[12px] ${missing ? 'font-medium text-danger-700 dark:text-danger-400' : 'text-anvil-500 dark:text-anvil-400'}`}
      data-testid="pr-merge-content"
      data-verdict={content.verdict}
      title={missing ? 'A maintainer or writer recorded this merge, but the commit it names neither contains the PR head nor makes its changes.' : undefined}
    >
      {missing ? <X className="h-3.5 w-3.5" aria-hidden /> : content.verdict === 'unknown' ? null : <Check className="h-3.5 w-3.5 text-verify" aria-hidden />}
      merge <Oid value={mergeOid} chars={7} copyable={false} /> {words[content.verdict]}
    </span>
  )
}
