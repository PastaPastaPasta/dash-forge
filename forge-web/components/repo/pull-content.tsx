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
import { useCallback, useMemo, useRef, useState, type ReactNode, type SetStateAction } from 'react'
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

import type { PullThread, RepoHome, TimelineItem } from '@/lib/view'
import { ACL_NAME, ARCHIVED_REASON, loadPullThread, plural, policyOf, pullActions, type CommentView } from '@/lib/view'
import { bypassValue, deleteBranchOffer, deleteBranchProblem, prLinkedIssues, requiredChecksLine } from '@/lib/view/pull-actions'
import {
  createComment,
  recordPolicyBypass,
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
import { linkedIssues, RoleOracle, type ChecksState, type Policy, type PolicyStatus } from '@/lib/rules/v2'
import { checksState } from '@/lib/rules/parity'
import { SupersededWriteError, previewCreate, previewCredits, previewDelete, previewReplace, sumPreviews, type CostPreview as Cost } from '@/lib/sdk'
import { commentEditDrops, pullSinceYourReview } from '@/lib/view/issues-view'
import { totalHidden } from '@/lib/repo/private-content'
import { firstPushers, headUpdatePhrases, type HeadUpdatePhrase } from '@/lib/view/head-updates'
import { inlineCommentIds, lineKey, repliesByRoot } from '@/lib/view/inline-threads'
import { appliedSuggestions, prCommits, prHaveSet } from '@/lib/view/pr-commits'
import { anchorOnHead } from '@/lib/view/inline-threads'
import { snippetKey, snippetSource } from '@/lib/view/anchor-snippet'
import { AnchorContext, useSnippetTexts } from '@/components/repo/anchor-snippet'
import { WALK_COMMIT_CAP } from '@/lib/merge/objects'
import { commentsShown, draftIsEmpty, draftWhereabouts, reviewShows, SUBMIT_WAIT } from '@/lib/view/pending-review'
import { tipOidOf } from '@/lib/view/refs'
import { importedReviewers, type ReviewerCardRow } from '@/lib/view/review-fold'
import { foldMirroredReviews, mirroredCommentText } from '@/lib/view/mirror-review-fold'
import { BODY_MAX, utf8Length } from '@/lib/view/issue-query'
import { readUntil, retryWhileMissing } from '@/lib/view/retry'
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
import { BodyCounter, PrivateComposeNote, SealedLimit, composeCost, composeTooLong, privateComposeBlock } from '@/components/repo/private-compose'
import { numberLabel, resolveUpstreamNumber, shownUpstreamNumber } from '@/lib/view/upstream'
import { MarkdownView, type MarkdownLinks } from '@/components/markdown-view'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Oid } from '@/components/ui/oid'
import { CopyLinkButton } from '@/components/ui/copy-link'
import { TabStrip } from '@/components/ui/tab-strip'
import { CopyRow } from '@/components/ui/copy-row'
import { Field, Input } from '@/components/ui/input'
import { CostPreview } from '@/components/ui/cost-preview'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { InlineCommentsProvider, type ThreadActions } from '@/components/repo/inline-comments'
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
import { cn } from '@/lib/utils'

/** No pending review comments (a stable empty list). */
const NO_DRAFTS: readonly DraftComment[] = []

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
  const isMember = holdings.data !== null && (holdings.data.write || holdings.data.maintain)
  const isAuthor = viewer !== null && viewer === pull.author
  const archived = home.config?.archived === true
  // A locked PR takes comments and reviews from members only (RC1: consensus refuses the rest).
  const postContext = { isMember, locked: thread.locked }
  const composeBlock = archived ? ARCHIVED_REASON : lockedOut(postContext) ? LOCKED_REASON : privateComposeBlock(home)
  const writeBlocked = composeBlock !== null
  // Who the composer's lock banner speaks to (a member keeps the composer).
  const lockViewer = lockViewerOf(viewer, holdings)
  const open = pull.state.open
  const { slot: mergeSlot, onRunning: setMergeRunning } = useMergeSlot(tab, open && pull.state.draft)
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
    const tip = await readBranchTip(sdk, src, refName)
    const problem = deleteBranchProblem({ refName, sameRepo: src.repoId === repo.repoId, baseRefName: pull.baseRefName, defaultBranch, headOid, tip })
    if (problem !== null) throw new Error(problem)
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
  // The repo holding the PR's source branch: this one for a same-repo PR, else the fork once read.
  const sourceRefOf = (): RepoRef | null =>
    pull.sourceId === '' || pull.sourceId === repo.repoId ? repo : comparison.source.kind === 'found' ? comparison.source.repo : null
  // Who pushed each head (QW3-048): the source branch's ref updates (one read, both update
  // types), on the Conversation tab only, where the timeline words each head update.
  const wantPhrases = tab === 'conversation' && review.headUpdates.length > 0
  const pushers = useAsync(
    async () => firstPushers(await readBranchUpdates(sdk!, sourceRefOf()!, pull.sourceRefName!)),
    [ready, pull.sourceId, pull.sourceRefName ?? '', review.headUpdates.length, comparison.source.kind],
    { enabled: ready && sdk !== null && wantPhrases && pull.sourceRefName !== null && sourceRefOf() !== null },
  )
  const pushersSettled = pull.sourceRefName === null || sourceRefOf() === null || pushers.settled
  // Commits the base already had (an "Update branch" merge brings them in) are not counted as pushed.
  const comparedBase = cmp === null || cmp.fellBack === true ? '' : cmp.comparedBaseOid
  const phrases = useAsync(
    () => headUpdatePhrases(headReader!, pull.initialHeadOid, review.headUpdates, pushers.data ?? undefined, comparedBase),
    [comparison.sidesKey, review.headUpdates.map((u) => u.id).join(','), headReader === null, pushers.data === null ? 0 : pushers.data.size, comparedBase],
    { enabled: headReader !== null && wantPhrases && pushersSettled && cmp !== null },
  )

  // ---- checks on the head ---------------------------------------------------------------------
  // Trust is by the current member set: keyed on the set itself (a swap of members re-reads).
  const membersKnown = thread.approvals !== null
  const memberKey = thread.members.map((m) => m.identity).sort().join(',')
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
  const sync = branchShown(readSync, branchWrite, pull.sourceRefName, pull.headOid)
  // The PR's author or a maintainer/writer: who may move the head, mark draft/ready, resolve and request.
  const authorOrMember = identity !== null && (isAuthor || isMember)
  const canMoveHead = authorOrMember && open && !writeBlocked
  const since = pullSinceYourReview(thread, identity)
  // A review this page just submitted: until every comment it wrote shows, say how many have.
  const [arriving, setArriving] = useState<{ reviewId: string; commentIds: readonly string[] } | null>(null)
  const arrivedAll = arriving !== null && reviewShows(thread, arriving)
  if (arrivedAll) setArriving(null)
  const stillArriving = arriving !== null && !arrivedAll && !refreshing ? { shown: commentsShown(thread, arriving.commentIds), total: arriving.commentIds.length } : null

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
        : checksState(checks.data.rows, pull.headOid, new RoleOracle(thread.members), checks.data.runners, policyNow)
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
  const base = shortBranch(pull.baseRefName) || 'the base branch'
  const canAuthorOrMember = authorOrMember && !archived
  const canMember = identity !== null && isMember && !archived && guard.disabledReason === null

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
  const stateType = isMember ? 'event' : 'authorEvent'
  const eventFirst = useFirstWrite(() => eventFirsts(sdk!, repo, stateType, pull.id, identity!), [pull.id, identity ?? '', stateType], firstsReady)
  const transitionFirst = useFirstWrite(() => eventFirsts(sdk!, repo, 'transition', pull.id, identity!), [pull.id, identity ?? ''], firstsReady)
  const transitionCost = previewCreate('transition', {}, transitionFirst)


  const links: MarkdownLinks = useRepoLinks(addr, home.description)

  const eventCost = previewCreate(stateType, {}, eventFirst)
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
  // The code each inline comment was left on, for Conversation (QW2-049): read on that tab only.
  const snippetSources = useMemo(() => thread.comments.flatMap((c) => (c.anchor === null ? [] : [snippetSource(c.anchor)].filter((s) => s !== null))), [thread.comments])
  const snippetTexts = useSnippetTexts(tab === 'conversation' ? headReader : null, snippetSources)
  const anchorContext = (c: CommentView, label = true): JSX.Element | null => {
    if (c.anchor === null) return null
    const source = snippetSource(c.anchor)
    return (
      <AnchorContext
        anchor={c.anchor}
        text={source === null ? null : snippetTexts.get(snippetKey(source))}
        outdated={!anchorOnHead(c.anchor, pull.headOid)}
        applied={applied.get(c.id) ?? null}
        label={label}
      />
    )
  }
  const suggest = useSuggestions({
    repo,
    source: sourceRef,
    pull,
    comments: thread.comments,
    drafts: reviewDraft.draft?.comments ?? NO_DRAFTS,
    headReader,
    headOnly: comparison.headOnly,
    applied,
    isMember,
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
  const canResolve = authorOrMember && !writeBlocked && guard.disabledReason === null
  // Stable across renders (the diff's lines re-render only when these change): the handler
  // reads the latest confirm (cost and guard) through a ref.
  const confirmResolve = useRef(confirmEvent)
  confirmResolve.current = confirmEvent
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
    }),
    [canResolve, resolvedKey, identity, setPending],
  )
  const commentCost = composeCost(repo, 'comment', { body: comment.trim() }, commentFirst)
  const commentTooLong = composeTooLong(repo, 'comment', { body: comment.trim() })
  // "Close with comment" (QW2-008): the composer's text goes with a close or reopen when it could be posted.
  const withComment = comment.trim() !== '' && !writeBlocked && !commentTooLong ? comment.trim() : null
  // The repo's milestones, for the picker (QW2-050): read for members only (only they can set one).
  const milestones = useAsync(
    () => readMilestones(sdk!, repo),
    [ready, repoKey(repo), canMember ? 1 : 0],
    { enabled: ready && sdk !== null && canMember },
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
    const r = await postTargetEvent(sdk, signer, repo, { target, kind, author: pull.author, isMember, payload, intent })
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
          await setTargetState(sdk, signer, repo, { target: stateTarget, action: p.to, isMember, intent })
        } catch (e) {
          // The comment is posted: show it while the close is retried.
          if (posted !== null) refresh((t) => t.comments.some((c) => c.id === posted))
          throw e
        }
        refresh((t) => t.pull.state.open === (p.to === 'reopen') && (posted === null || t.comments.some((c) => c.id === posted)))
        return
      }
      case 'mark-merged':
        await setTargetState(sdk, signer, repo, { target: stateTarget, action: 'merge', isMember, oidHex: pull.headOid, intent })
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
        setComment('')
        commentIntent.renew()
        refresh((t) => t.reviews.some((x) => x.id === r.documentId))
        return
      }
      case 'draft':
        await setTargetState(sdk, signer, repo, { target: stateTarget, action: p.to, isMember, intent })
        refresh((t) => t.pull.state.draft === (p.to === 'draft'))
        return
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
            current: { title: pull.title, body: pull.body, baseRefName: pull.baseRefName, sourceRefName: pull.sourceRefName ?? undefined },
            bind: { number: pull.number },
            ...(pull.epoch !== null ? { patchEpoch: pull.epoch } : {}),
            imported: pull.importedRaw ?? null,
          },
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
        await setLock(sdk, signer, repo, { target: stateTarget, lock: p.on, isMember, intent })
        refresh((t) => t.locked === p.on)
        return
      case 'edit-comment': {
        const c = thread.comments.find((x) => x.id === p.id)
        await updateComment(sdk, signer, repo, {
          id: p.id,
          body: p.body,
          ...(c ? commentEditDrops(c, thread.comments, { isMember, allReadable: totalHidden(thread.hidden) === 0 }) : {}),
          ...(c?.revision !== undefined ? { expectedRevision: BigInt(c.revision) } : {}),
          seal: { current: { body: c?.body ?? '', path: c?.anchor?.path }, bind: { targetId: pull.id }, imported: c?.importedRaw ?? null },
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
      case 'labels':
      case 'assignees':
        return sumPreviews([...pending.change.add, ...pending.change.remove].map((value) => previewCreate('event', { value })))
      case 'milestone':
        return previewCreate('event', pending.title === null ? {} : { value: pending.title })
      case 'delete-branch':
      case 'restore-branch':
        return previewCreate('refUpdate')
      case 'dismiss':
        return previewCreate('event', { value: pending.reason })
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
  const confirm = confirmText(pending, pull.number, isMember, pull.headOid, base)

  // ---- conversation ------------------------------------------------------------------------------
  // Replies to an inline thread show under its root, not on their own.
  const inlineIds = useMemo(() => new Set(inlineCommentIds(thread.comments)), [thread.comments])
  // Under the thread's root (a reply to a reply belongs to the same thread).
  const repliesOf = useMemo(() => repliesByRoot(thread.comments), [thread.comments])
  // A mirrored PR's review comments under the review they were submitted with (QW2-010).
  const conversation = useMemo(
    () =>
      foldMirroredReviews(
        timeline.filter((t) => !(t.kind === 'comment' && t.comment.replyTo !== null && inlineIds.has(t.comment.id))),
        (it) => (it.kind === 'review' ? trustedOrigin(it.review.origin, it.review.reviewer, trust) : trustedOrigin(it.comment.origin, it.comment.author, trust)),
      ),
    [timeline, inlineIds, trust],
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
    ? { label: 'Merged', icon: <GitMerge className="h-4 w-4" aria-hidden />, bg: 'bg-dash-700' }
    : !open
      ? { label: 'Closed', icon: <GitPullRequestClosed className="h-4 w-4" aria-hidden />, bg: 'bg-danger' }
      : pull.state.draft
        ? { label: 'Draft', icon: <GitPullRequestDraft className="h-4 w-4" aria-hidden />, bg: 'bg-anvil-600' }
        : { label: 'Open', icon: <GitPullRequest className="h-4 w-4" aria-hidden />, bg: 'bg-verify-700' }
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
    const label = `${crossRepo ? `${closedSource.name}:` : ''}${shortBranch(name)}`
    if (sync.kind === 'deleted') {
      // Who could delete it may restore it: the head is still stored there (only the ref moved).
      const restorable = closedWrite.known && closedWrite.can && closedSource.visibility === 'public' && pull.headOid !== '' && !(closedSource.repoId === repo.repoId && name === pull.baseRefName)
      if (!restorable) return null
      const head = pull.headOid
      return { label, restore: true, run: () => restoreSourceBranch(closedSource, name, head) }
    }
    const offer = deleteBranchOffer({
      refName: name,
      source: { visibility: closedSource.visibility, sameRepo: closedSource.repoId === repo.repoId },
      canWrite: closedWrite.known ? closedWrite.can : null,
      baseRefName: pull.baseRefName,
      defaultBranch: sourceDefault.data,
      headOid: pull.headOid,
    })
    if (offer.kind !== 'offer') return null
    const head = pull.headOid
    return { label, restore: false, run: () => deleteSourceBranch(closedSource, name, head) }
  })()
  // A closed PR whose branch is gone reopens once the branch is restored, as on GitHub (QW3-052).
  const reopenBlocked = !open && !merged && sync?.kind === 'deleted' ? `Restore the ${shortBranch(pull.sourceRefName ?? '')} branch first: a pull request reopens with its branch.` : null
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
  // A merge running in the merge box (it deletes the branch last): no second "Delete branch" meanwhile.
  const [mergeBusy, setMergeBusy] = useState(false)
  const onMergeRunning = useCallback(
    (running: boolean) => {
      setMergeRunning(running)
      setMergeBusy(running)
    },
    [setMergeRunning],
  )
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
                disabled={editing.title.trim() === '' || (editing.title.trim() === pull.title && editing.body === pull.body) || utf8Length(editing.body) > BODY_MAX || guard.disabledReason !== null}
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
              <Button variant="outline" size="sm" onClick={() => setEditing({ title: pull.title, body: pull.body })} disabled={writeBlocked} title={composeBlock ?? undefined}>
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
            <span className="font-mono">{shortBranch(pull.state.baseRef ?? pull.baseRefName) || '?'}</span>
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
                from <span className="font-mono">{crossRepo && sourceRef ? `${sourceRef.name}:` : ''}{shortBranch(pull.sourceRefName)}</span>
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
          <RefreshCw className="h-4 w-4 text-forge-700 dark:text-forge-400" aria-hidden />
          <span className="min-w-0 flex-1">
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
              stays on screen on every tab, not only where it was started. */}
          {suggest.runner.busy && !(tab === 'files' || (tab === 'conversation' && !(open && pull.state.draft))) ? suggest.runner.view : null}
          {tab === 'conversation' ? (
            <>
              {/* Description */}
              <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
                <div className="flex items-center gap-2 border-b border-anvil-200 bg-anvil-50 px-4 py-2 text-dense coarse:min-h-12 dark:border-anvil-800 dark:bg-anvil-900">
                  <Byline author={pull.author} createdAt={pull.createdAt} origin={origin} verb="opened this" />
                  <EditedMarker createdAt={pull.createdAt} updatedAt={pull.updatedAt} />
                </div>
                <div className="px-4 py-3">
                  {editing ? (
                    <MarkdownEditor id="edit-pr-body" label="Description" value={editing.body} onChange={(body) => setEditing({ ...editing, body })} links={links} />
                  ) : pull.body ? (
                    <MarkdownView source={pull.body} links={links} imported={pull.importedUrl} />
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
                  eventText={eventText}
                  anchorContext={anchorContext}
                  renderComment={(item) =>
                    commentSlots({
                      item,
                      viewer: identity,
                      editing: editingComment,
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
                    })
                  }
                />
              ) : null}
              <HiddenNote hidden={0} what="comments and reviews" home={home} by={thread.hidden} />
              <EventValuesNote counts={thread.eventValues} />

              {closedBranch !== null && guard.disabledReason === null && !archived && !mergeBusy ? (
                <section aria-label="Source branch" className="flex flex-wrap items-center gap-3 rounded-lg border border-anvil-200 px-4 py-3 dark:border-anvil-800" data-testid="closed-branch-box">
                  {merged ? <GitMerge className="h-5 w-5 shrink-0 text-dash" aria-hidden /> : <GitPullRequestClosed className="h-5 w-5 shrink-0 text-danger-700 dark:text-danger-400" aria-hidden />}
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
                          <BranchCommitCost isMember={isMember} storage="" />
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
                  {tab === 'conversation' ? suggest.runner.view : null}
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
                  onRunning: onMergeRunning,
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
                      baseRefName: pull.baseRefName,
                      defaultBranch: sourceDefault.data,
                      headOid: pull.headOid,
                    })
                    if (offer.kind === 'hide' || src === null || name === null) return null
                    const label = `${crossRepo ? `${src.name}:` : ''}${name.replace(/^refs\/heads\//, '')}`
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
                <BranchRules base={pull.baseRefName} baseProtected={actions.baseProtected} policy={rules.policy} status={rules.status} checks={requiredChecks} />
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
                      <SealedLimit repo={repo} kind="comment" text={comment.trim()} />
                      <BodyCounter repo={repo} text={comment.trim()} field="comment" />
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
                        {open ? <GitPullRequestClosed className="h-3.5 w-3.5 text-danger-700 dark:text-danger-400" aria-hidden /> : <GitPullRequest className="h-3.5 w-3.5 text-verify-700 dark:text-verify-400" aria-hidden />}
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
                    ) : !isMember && holdings.settled ? (
                      <span className="text-[12px] text-anvil-500 dark:text-anvil-400">Only approvals from maintainers and writers count.</span>
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
            </>
          ) : tab === 'commits' ? (
            <CommitsTab
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
                  comments={thread.comments}
                  changedPaths={new Set(c.changes.flatMap((x) => (x.oldPath !== undefined ? [x.path, x.oldPath] : [x.path])))}
                  onPosted={onInlinePosted}
                  actions={threadActions}
                  onLinesKnown={rememberLines}
                  suggestions={suggest.actions}
                  {...(identity !== null && open && !writeBlocked && reviewDraft.pending ? { pending: reviewDraft.pending } : {})}
                >
                  {diff}
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
                canRequest={canAuthorOrMember && open && guard.disabledReason === null}
                canDismiss={canMember && open}
                onRequest={(who, remove) => {
                  confirmEvent({ kind: 'request', who, remove })
                }}
                onDismiss={(row, reason) => {
                  confirmEvent({ kind: 'dismiss', row, reason }, previewCreate('event', { value: reason }, eventFirst))
                }}
              />
            </SidebarSection>
            <SidebarSection title="Assignees" icon={UserPlus}>
              <AssigneePicker
                assignees={pull.state.assignees}
                members={thread.members.map((m) => m.identity)}
                canEdit={canMember}
                onApply={(change) => setPending({ kind: 'assignees', change })}
              />
            </SidebarSection>
            <SidebarSection title="Labels" icon={Tag}>
              <LabelPicker
                applied={pull.state.labels}
                defs={thread.labels}
                byName={new Map(thread.labels.map((l) => [l.name, l]))}
                canEdit={canMember}
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
                canEdit={canMember}
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
                    <Link href={repoHref('/repo', sourceAddr)} className="text-forge-700 underline underline-offset-2 dark:text-forge-400">
                      {sourceRef.name}
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
                    {merged ? `, in ${shortBranch(pull.state.baseRef ?? pull.baseRefName)}'s history:` : '.'}
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
                {canMember ? (
                  <div className="mt-2">
                    <LockToggle locked={thread.locked} onToggle={(on) => confirmEvent({ kind: 'lock', on }, transitionCost)} />
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
    case 'lock':
      return lockConfirm(pending.on, `PR #${number}`, 'pull')
    default:
      return { title: '', description: '', label: 'Confirm' }
  }
}

/** A comment's slots on the PR page: the author's Edit and Delete, the inline editor, an inline thread's anchor and replies. */
function commentSlots({
  item,
  viewer,
  editing,
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
}: {
  item: Extract<TimelineItem, { kind: 'comment' }>
  viewer: string | null
  editing: { id: string; body: string } | null
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
      <CommentOwnActions onEdit={() => onEdit({ id: c.id, body: c.body })} onDelete={() => onDelete(c.id)} disabled={disabled} deleteDisabled={deleteDisabled} />
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
          <div className="flex gap-2">
            <Button variant="primary" size="sm" disabled={editing.body.trim() === '' || editing.body === c.body || utf8Length(editing.body) > BODY_MAX} onClick={() => onSave(c.id, editing.body)}>
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
        <MarkdownView source={trustedOrigin(c.origin, c.author, trust ?? null) !== null ? mirroredCommentText(c.body, c.anchor).text : c.body} links={links} imported={importedUrlOf(c.importedRaw)} />
        {replies.map((r) => (
          <div key={r.id} className="border-l-2 border-anvil-200 pl-3 dark:border-anvil-750">
            <div className="flex items-center gap-2 text-[12px] text-anvil-600 dark:text-anvil-400">
              <Byline author={r.author} createdAt={r.createdAt} origin={trustedOrigin(r.origin, r.author, trust ?? null)} link={false} />
            </div>
            <MarkdownView source={r.body} links={links} imported={importedUrlOf(r.importedRaw)} />
          </div>
        ))}
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
        <p className="mt-1 flex items-center gap-2" data-testid="policy-status">
          {status.met ? <Check className="h-4 w-4 text-verify" aria-hidden /> : <X className="h-4 w-4 text-danger" aria-hidden />}
          <span>
            {status.have} of {plural(status.need, 'required approval')}
            {policy.approverRole === 1 ? ' (maintainers)' : ''}
          </span>
        </p>
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
