'use client'

/**
 * IssueContent — the issue detail (`platform-parity-spec.md` §1.2): folded state header, the
 * author's body, the merged comment/event timeline, a comment composer with Write / Preview,
 * close / reopen, the label picker, the assignee picker, and edits of the title, the body and
 * one's own comments (marked "edited"). Every write shows its pre-sign cost and a confirm.
 *
 * Who may do what (`forge-v2.md` §3): the author closes and reopens their own issue with an
 * `authorEvent` and edits their own documents (a replace); maintainers and writers close,
 * reopen, label and assign with an `event`. Consensus refuses anyone else, so the controls are
 * offered only to them. An assignment names the assignee in `value` (the fold) and `refId` (the
 * sparse `addressee` index that answers "assigned to me").
 *
 * The page is one composite read (`loadIssueThread`): the issue, its comments and events, the
 * label definitions, the members and the authors' names under one proof.
 */

import { Byline } from '@/components/repo/byline'
import { useMirrorTrust } from '@/hooks/use-mirror-trust'
import { trustedOrigin } from '@/lib/repo/provenance'
import { useCallback, useRef, useState, type SetStateAction } from 'react'
import { CheckCircle2, CircleDot, CircleSlash, GitPullRequest, Milestone, Pencil, Pin, Tag, UserPlus } from 'lucide-react'
import { STATE_FILL, STATE_TEXT } from '@/lib/design/state'
import { threadAuthorIds } from '@/lib/repo/bots'
import { LinkedPulls, namedClosingPull, useIssueBacklinks, useNamedClosingPulls, type IssueBacklinks } from '@/components/repo/linked-pulls'
import type { ClosingPr } from '@/lib/rules/transition'
import { closedIn } from '@/lib/view/cross-refs'
import { readDuplicatesOf } from '@/lib/view/issues-view'
import type { LinkingPulls, RepoRef, TransitionView } from '@/lib/repo'
import type { RepoHome, IssueThread, TimelineItem } from '@/lib/view'
import { commentDraftKey, useDraftText } from '@/lib/view/draft-text'
import { ACL_NAME, ARCHIVED_REASON, issueWriteShows, loadIssueThread } from '@/lib/view'
import { readDuplicateTargets } from '@/lib/view/issues-view'
import { closeWhyOf, closedAsWords, closedSkipped } from '@/lib/view/close-reason'
import type { ClosedAs } from '@/lib/rules/transition'
import { CloseIssueButton } from '@/components/repo/close-issue-button'
import { commentEditDrops } from '@/lib/view/issues-view'
import { totalHidden } from '@/lib/repo/private-content'
import { ISSUE_LOCK, ISSUE_UNLOCK } from '@/lib/rules/transition'
import { RoleOracle, trustedUpstreamNumber } from '@/lib/rules/v2'
import {
  commentFirsts,
  createComment,
  defineLabel,
  deleteComment,
  eventFirsts,
  readViewerPermissions,
  repoContractIds,
  repoKey,
  setAssignee,
  setLabel,
  setMilestone,
  setThreadFlag,
  setLock,
  LOCKED_REASON,
  lockedOut,
  setTargetState,
  updateComment,
  updateTarget,
} from '@/lib/repo'
import type { Holdings } from '@/lib/rules'
import { capabilitiesOf } from '@/lib/rules/roles'
import { RoleLimitNote } from '@/components/repo/role-limit-note'
import { SupersededWriteError, UnconfirmedWriteError, previewCreate, previewDelete, previewReplace, sumPreviews, withAddressee, type CostPreview as Cost } from '@/lib/sdk'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useIntent } from '@/hooks/use-intent'
import { useFirstWrite } from '@/hooks/use-first-write'
import { repoHref, useParam, type RepoAddress } from '@/hooks/use-query-param'
import { pullHref, useRepoLinks } from '@/components/repo/target-href'
import { importedUrlOf } from '@/lib/view/ref-targets'
import { CopyLinkButton } from '@/components/ui/copy-link'
import { readUntil, retryWhileMissing } from '@/lib/view/retry'
import { useAuth } from '@/contexts/auth-context'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { TargetNotFound } from '@/components/repo/number-content'
import { CommentOwnActions, Timeline, type CommentSlots, type CrossRefItem, type TimelineRef } from '@/components/repo/timeline'
import { MarkdownView, type MarkdownLinks } from '@/components/markdown-view'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { CostPreview } from '@/components/ui/cost-preview'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { EditedMarker, MarkdownEditor } from '@/components/repo/issue-bits'
import { AssigneePicker, LabelPicker, MilestonePicker, SidebarSection, applySetChange, assigneesConfirm, labelsConfirm, setChangeShows, stateToggleLabel, type SetChange } from '@/components/repo/target-rail'
import { readMilestones } from '@/lib/repo/milestones'
import { EventValuesNote, HiddenNote } from '@/components/repo/hidden-note'
import { LockToggle, LockedBanner, lockConfirm, lockStateText, lockViewerOf } from '@/components/repo/locked-banner'
import { BodyCounter, PrivateComposeNote, SealedLimit, composeCost, privateComposeBlock } from '@/components/repo/private-compose'
import { LongBodyNote, longEditBlock, useLongCompose, type LongCompose } from '@/components/repo/long-body'
import { BODY_MAX, utf8Length } from '@/lib/view/issue-query'
import { numberLabel, shownUpstreamNumber } from '@/lib/view/upstream'
import { HiddenBanner, HideMenu, HideThreadControl, hideConfirm, hideCost } from '@/components/repo/moderation'
import { setHidden } from '@/lib/repo/moderation'
import { moderationBlocked } from '@/lib/repo/moderation-fold'
import { isHidden } from '@/lib/view/issues-view'
import type { HideReason } from '@/lib/rules/moderation'
import { AuthorRolesProvider } from '@/components/repo/author-roles'

/** The write the confirm dialog is about to sign. */
type Pending =
  /**
   * Close or reopen; with `comment`, the composer's text is posted first ("Close with comment",
   * QW2-008); a close says why (`closedAs`, QW-069: completed unless the menu said otherwise).
   */
  | { kind: 'state'; comment?: string; closedAs?: ClosedAs }
  /** The label picker's change, applied together behind one confirm (QW2-046). */
  | { kind: 'labels'; change: SetChange }
  | { kind: 'assignees'; change: SetChange }
  | { kind: 'flag'; flag: 'pin' | 'lock'; on: boolean }
  | { kind: 'milestone'; title: string | null }
  | { kind: 'defineLabel'; name: string; color: string; description: string; apply: boolean }
  | { kind: 'editIssue'; title: string; body: string }
  | { kind: 'editComment'; id: string; body: string }
  | { kind: 'deleteComment'; id: string }
  /**
   * A maintainer hides (or unhides) a comment, or with `item` null the issue (RC2 MOD); hiding the
   * issue may also close and lock it, as separate writes after the hide.
   */
  | { kind: 'hide'; item: string | null; what: 'comment' | 'issue'; reason: HideReason | null; hide: boolean; closeAndLock?: boolean }
  | null

/** Bytes a body may hold (the `body` schema: 5,120). */

export function IssueContent({ home, addr, number }: { home: RepoHome; addr?: RepoAddress; number: number }): JSX.Element {
  const { sdk, ready, network } = useSdk(repoContractIds(home.repo))
  const { identity, signer, locked } = useAuth()
  const guard = useWriteGuard()

  // Just created here: a node that has not applied the block yet answers "not found", so keep
  // asking for a few seconds rather than telling the author their issue does not exist.
  const justCreated = useParam('created') === '1'
  // After a write the page re-reads until the write shows (`refresh(expect)`), as the PR page does
  // (L-77): a node a block behind answers without it, and one plain re-read would drop it from
  // view (a posted comment missing until a reload). Expectations accumulate until one read
  // satisfies them all; a newer read aborts the older one's polling.
  const expectations = useRef<((t: IssueThread) => boolean)[]>([])
  const current = useRef<{ aborted: boolean }>({ aborted: false })
  const { data, loading, error, reload } = useAsync<IssueThread | null>(
    async (stop) => {
      current.current.aborted = true
      const own = { aborted: false }
      current.current = own
      // Stopped by a newer read, or by useAsync (deps changed, or the page unmounted).
      const signal = { get aborted() { return own.aborted || stop.aborted } }
      const want = [...expectations.current]
      const load = (): Promise<IssueThread | null> => loadIssueThread(sdk!, home.repo, number, network)
      const first = await retryWhileMissing(load, justCreated ? 8 : 0, undefined, signal)
      if (first === null || want.length === 0) return first
      // A re-read that fails keeps the thread just read rather than replacing the page with an error.
      const reread = (): Promise<IssueThread | null> => load().catch(() => first)
      const t = await readUntil(reread, want, { signal, first })
      if (!signal.aborted && t !== null) expectations.current = expectations.current.filter((w) => !w(t))
      return t
    },
    [ready, repoKey(home.repo), number, network],
    { enabled: ready && sdk !== null && Number.isFinite(number) },
  )
  const refresh = useCallback(
    (want?: (t: IssueThread) => boolean) => {
      if (want) expectations.current.push(want)
      reload()
    },
    [reload],
  )

  // Who may mirror: an imported item of theirs shows its original author and date (FG-6).
  const trust = useMirrorTrust(home.repo)
  // A current maintainer/writer document (seeded by the composite above: no extra read).
  const holdings = useAsync<Holdings | null>(
    () => readViewerPermissions(sdk!, home.repo, identity!, network),
    [ready, repoKey(home.repo), identity ?? '', network, data === null ? 0 : 1],
    { enabled: ready && sdk !== null && identity !== null && data !== null },
  )

  // What this viewer may do as a member (RC2 roles: a triage member labels, assigns, closes and
  // locks; a reader none of it). An author keeps the author's own abilities whatever the role.
  const caps = capabilitiesOf(holdings.data?.role ?? null)
  // The repo's milestones, for the picker: read for those who can set one.
  const canSetMilestone = caps.canMilestone
  const milestones = useAsync(
    () => readMilestones(sdk!, home.repo),
    [ready, repoKey(home.repo), canSetMilestone ? 1 : 0],
    { enabled: ready && sdk !== null && canSetMilestone },
  )

  // The unsent comment survives a reload (never stored for a private repo).
  const [comment, setComment, holdDraft] = useDraftText(commentDraftKey(home.repo, data?.issue.id ?? '', identity))
  const draft = useIntent()
  const [posting, setPosting] = useState(false)
  const [commentError, setCommentError] = useState<string | null>(null)
  const [pending, setPendingState] = useState<Pending>(null)
  // One confirm at a time: a write asked for while one is open (a picker applying on the same
  // click that opens another action) never silently replaces it.
  const setPending = useCallback((p: SetStateAction<Pending>) => setPendingState((cur) => (typeof p === 'function' ? p(cur) : p === null ? null : cur ?? p)), [])
  // "Close with comment": the comment a close already posted, by the confirm's intent, so a retry
  // of a close that failed after it never posts the comment twice.
  const closeComment = useRef<{ intent: string; id: string } | null>(null)
  const [editing, setEditing] = useState<{ title: string; body: string } | null>(null)
  const [editingComment, setEditingComment] = useState<{ id: string; body: string } | null>(null)
  // A hidden issue's body and timeline show only after "Show it anyway" (RC2 MOD).
  const [threadRevealed, setThreadRevealed] = useState(false)

  // The PRs that close or mention this issue (the Development box, and the timeline's "closed this
  // in #3" and "mentioned this issue in #4", QW2-048). The trusted upstream number needs the thread.
  const upstream = data ? trustedUpstreamNumber(data.issue.upstreamNumber, data.issue.author, home.repo.ownerId, new RoleOracle([...data.members])) : null
  const backlinks = useIssueBacklinks(home, number, upstream, data != null)
  // The PRs this issue's closes name, read by number when the backlinks do not hold them.
  const namedCloses = (data?.timeline ?? []).flatMap((it) => (it.kind === 'transition' && it.transition.closedByPr !== undefined ? [it.transition.closedByPr] : []))
  const namedPulls = useNamedClosingPulls(home, backlinks, namedCloses, data != null)
  // Issues closed as a duplicate of this one (QW4-024), read once the thread shows.
  const duplicatesOf = useAsync(() => readDuplicatesOf(sdk!, home.repo, number), [ready, repoKey(home.repo), number, data === null ? 0 : 1], {
    enabled: ready && sdk !== null && data !== null,
  })

  const repoLinks = useRepoLinks(addr ?? { owner: '', name: '' }, home.description)
  const links: MarkdownLinks | undefined = addr ? repoLinks : undefined

  // Which subtrees this viewer's comment or event would create, for tight previews (D-011).
  // Read only once the viewer turns to a write (typing a comment, or a confirm opening): the
  // previews are upper bounds meanwhile, and a page view costs no reads.
  const issueId = data?.issue.id ?? ''
  const hasComments = data ? data.timeline.some((t) => t.kind === 'comment') : undefined
  const viewerMember = caps.canLabel || caps.canAssign || caps.canPin
  const firstsReady = (comment !== '' || pending !== null) && ready && sdk !== null && identity !== null && issueId !== ''
  const commentFirst = useFirstWrite(() => commentFirsts(sdk!, home.repo, issueId, identity!, hasComments), [issueId, identity ?? '', hasComments ?? ''], firstsReady)
  const stateFirst = useFirstWrite(() => eventFirsts(sdk!, home.repo, 'transition', issueId, identity!), [issueId, identity ?? ''], firstsReady)
  const eventFirst = useFirstWrite(() => eventFirsts(sdk!, home.repo, 'event', issueId, identity!), [issueId, identity ?? ''], firstsReady && viewerMember)

  // A text over its field: stored whole by a maintainer or writer (forge-v2.md §6.3).
  const commentLong = useLongCompose(home.repo, 'comment', comment.trim())
  const editLong = useLongCompose(home.repo, 'issue', editing?.body ?? '', { title: editing?.title ?? '' })
  const commentEditLong = useLongCompose(home.repo, 'comment', editingComment?.body ?? '')
  const commentTooLong = commentLong.long ? commentLong.problem !== null : utf8Length(comment) > BODY_MAX

  if (!Number.isFinite(number)) return <EmptyState icon={CircleDot} title="No issue addressed" body="Add &number= to the URL." />
  if (loading && !data) return <LoadingBlock label="Loading issue" />
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (!data) return <TargetNotFound home={home} addr={addr} number={number} kind="issue" icon={CircleDot} title={`Issue #${number} not found`} body="No issue or pull request with that number in this repo." />

  const { issue, timeline, labels, members, hidden, eventValues, meta } = data
  const origin = trustedOrigin(issue.origin, issue.author, trust)
  const whileLocked = commentsWhileLocked(timeline, new Set(members.map((m) => m.identity)))
  const open = issue.state.open
  // Closed as not planned or as a duplicate: GitHub's grey badge (QW-069).
  const skipped = !open && closedSkipped(data.closedAs)
  // Any membership document (a reader's too) proves membership on comments and edits.
  const isMember = holdings.data?.member === true
  // RC2 MOD: only a maintainer hides (consensus refuses a writer where the contract proves it).
  const isMaintainer = holdings.data !== null && holdings.data.maintain
  const moderation = data.moderation
  const threadHidden = moderation?.thread ?? null
  const threadCollapsed = threadHidden !== null && !threadRevealed
  const postContext = { isMember, locked: meta.locked }
  const isAuthor = identity !== null && identity === issue.author
  const canToggle = identity !== null && (isAuthor || caps.canCloseReopen)
  // A private repo is written sealed (issues, comments and edits: `private-writes.ts`); only a
  // member holding the current key can, so everyone else sees why not instead of a composer.
  // An archived repo takes no writes (client-side gate: consensus cannot enforce it).
  const archived = home.config?.archived === true
  // Locked to members: the banner speaks to this viewer, and replaces a non-member's composer (an
  // archived repo's own note wins: nobody can comment there).
  const lockApplies = meta.locked && !archived
  const lockedOutNow = lockApplies && lockedOut(postContext)
  const lockViewer = lockViewerOf(identity, holdings)
  const composeBlock = archived ? ARCHIVED_REASON : lockedOutNow ? LOCKED_REASON : privateComposeBlock(home)
  const isPrivate = home.repo.visibility === 'private'
  const toggleHint =
    !canToggle && identity !== null && holdings.settled && holdings.data === null
      ? `Couldn't read this repo's ${ACL_NAME}, so close/reopen permission is unknown.`
      : null
  const target = { id: issue.id, number: issue.number }
  const commentCost = composeCost(home.repo, 'comment', { body: comment.trim() }, commentFirst)
  // A close or reopen is one `transition`, by a member or by the author.
  const stateCost = previewCreate('transition', {}, stateFirst)
  // "Close with comment" (QW2-008): the composer's text goes with a close or reopen, as on GitHub,
  // when this viewer could post it (not locked out, nothing blocking the composer, within the limit).
  const withComment = comment.trim() !== '' && composeBlock === null && !lockedOutNow && !commentTooLong ? comment.trim() : null
  const labelDefs = new Map(labels.map((l) => [l.name, l]))

  const postComment = async (): Promise<void> => {
    if (posting || comment.trim() === '' || commentTooLong || !guard.check(commentCost, 'collab', 'comment')) return
    if (!sdk || !signer) return
    setPosting(true)
    setCommentError(null)
    // Until the outcome is known, a reload must not bring the text back to be posted again.
    holdDraft(true, comment)
    try {
      const posted = await createComment(sdk, signer, home.repo, { targetId: issue.id, body: comment.trim(), intent: draft.intent, post: postContext })
      setComment('')
      holdDraft(false, '')
      draft.renew()
      refresh((t) => issueWriteShows(t, { kind: 'comment', id: posted.documentId }))
    } catch (e) {
      if (e instanceof SupersededWriteError) {
        // The earlier version was posted: show it, and never post this draft a second time.
        setComment('')
        holdDraft(false, '')
        draft.renew()
        refresh((t) => issueWriteShows(t, { kind: 'comment', id: e.documentId }))
      } else if (e instanceof UnconfirmedWriteError) {
        // Sent, not yet visible: keep reading until it shows (the draft stays, as the error says).
        refresh((t) => issueWriteShows(t, { kind: 'comment', id: e.documentId }))
      } else {
        // Nothing was sent: keep the draft again.
        holdDraft(false, comment)
      }
      setCommentError(guard.failed(e))
    } finally {
      setPosting(false)
    }
  }

  const runPending = async (intent: string): Promise<void> => {
    if (!sdk || !signer || pending === null) throw new Error('sign in to continue')
    const write = pending
    switch (pending.kind) {
      case 'state': {
        // The comment first, as GitHub posts it: it is part of why the issue closes.
        if (pending.comment !== undefined && closeComment.current?.intent !== intent) {
          const posted = await createComment(sdk, signer, home.repo, { targetId: issue.id, body: pending.comment, intent: `${intent}:comment`, post: postContext }).catch((e: unknown) => {
            if (e instanceof SupersededWriteError) return { documentId: e.documentId }
            throw e
          })
          closeComment.current = { intent, id: posted.documentId }
          setComment('')
          draft.renew()
          expectations.current.push((t) => issueWriteShows(t, { kind: 'comment', id: posted.documentId }))
        }
        try {
          const closed = open ? pending.closedAs ?? { reason: 'completed' as const, duplicateOf: null } : undefined
          await setTargetState(sdk, signer, home.repo, { target: { ...target, type: 'issue', author: issue.author }, action: open ? 'close' : 'reopen', isMember: caps.canCloseReopen, intent, ...(closed ? { closed } : {}) })
        } catch (e) {
          // The comment is posted: show it while the close is retried.
          if (closeComment.current?.intent === intent) refresh()
          throw e
        }
        break
      }
      case 'labels':
        // One event per label (the contract's shape), one confirm for all of them.
        await applySetChange(pending.change, intent, (label, add, i) => setLabel(sdk, signer, home.repo, { target, label, add, intent: i }))
        break
      case 'assignees':
        await applySetChange(pending.change, intent, (who, add, i) => setAssignee(sdk, signer, home.repo, { target, assignee: who, assign: add, intent: i }))
        break
      case 'flag':
        // A lock is a member transition since RC1 (consensus then refuses non-members' comments).
        if (pending.flag === 'lock') await setLock(sdk, signer, home.repo, { target: { ...target, type: 'issue', author: issue.author }, lock: pending.on, isMember: caps.canLock, intent })
        else await setThreadFlag(sdk, signer, home.repo, { target, on: pending.on, intent })
        break
      case 'milestone':
        await setMilestone(sdk, signer, home.repo, { target, title: pending.title, intent })
        break
      case 'defineLabel':
        await defineLabel(sdk, signer, home.repo, { name: pending.name, color: pending.color, description: pending.description, intent: `${intent}:def` })
        if (pending.apply) await setLabel(sdk, signer, home.repo, { target, label: pending.name, add: true, intent: `${intent}:apply` })
        break
      case 'editIssue': {
        const changes: { title?: string; body?: string } = {}
        if (pending.title !== issue.title) changes.title = pending.title
        if (pending.body !== issue.body) changes.body = pending.body
        await updateTarget(sdk, signer, home.repo, {
          type: 'issue',
          id: issue.id,
          ...changes,
          expectedRevision: BigInt(issue.revision),
          seal: { current: { title: issue.title, body: issue.long?.field ?? issue.body }, bind: { number: issue.number }, imported: issue.importedRaw ?? null },
          intent,
        })
        setEditing(null)
        break
      }
      case 'editComment':
        await updateComment(sdk, signer, home.repo, {
          id: pending.id,
          body: pending.body,
          ...commentEditDropsOf(timeline, pending.id, { isMember, allReadable: totalHidden(hidden) === 0 }),
          ...(timelineComment(timeline, pending.id)?.revision !== undefined ? { expectedRevision: BigInt(timelineComment(timeline, pending.id)?.revision as number) } : {}),
          seal: { current: { body: timelineComment(timeline, pending.id)?.body ?? '' }, bind: { targetId: issue.id }, imported: timelineComment(timeline, pending.id)?.importedRaw ?? null },
          intent,
        })
        setEditingComment(null)
        break
      case 'deleteComment':
        await deleteComment(sdk, signer, home.repo, pending.id)
        if (editingComment?.id === pending.id) setEditingComment(null)
        break
      case 'hide':
        await setHidden(sdk, signer, home.repo, { target, item: pending.item, reason: pending.reason, hide: pending.hide, intent })
        if (pending.closeAndLock) {
          // Separate writes (a batch holds one transition): close, then lock, each skipped when done.
          if (open) await setTargetState(sdk, signer, home.repo, { target: { ...target, type: 'issue', author: issue.author }, action: 'close', isMember: caps.canCloseReopen, intent: `${intent}:close`, closed: { reason: 'not_planned', duplicateOf: null } })
          if (!meta.locked) await setLock(sdk, signer, home.repo, { target: { ...target, type: 'issue', author: issue.author }, lock: true, isMember: caps.canLock, intent: `${intent}:lock` })
        }
        break
    }
    refresh((t) => {
      switch (write.kind) {
        case 'state':
          return issueWriteShows(t, { kind: 'state', open: !open })
        case 'labels':
          return setChangeShows(t.issue.state.labels, write.change)
        case 'assignees':
          return setChangeShows(t.issue.state.assignees, write.change)
        case 'hide':
          // With "also close and lock", until the close and the lock show as well.
          return issueWriteShows(t, write) && (!write.closeAndLock || (!t.issue.state.open && t.meta.locked))
        default:
          return issueWriteShows(t, write)
      }
    })
  }

  const pendingCost = ((): Cost => {
    switch (pending?.kind) {
      case 'state':
        return pending.comment === undefined ? stateCost : sumPreviews([composeCost(home.repo, 'comment', { body: pending.comment }, commentFirst), stateCost])
      case 'labels':
        return sumPreviews([...pending.change.add, ...pending.change.remove].map((value) => composeCost(home.repo, 'event', { value }, eventFirst)))
      case 'assignees':
        // An assignee is also the event's `refId` (QW4-039).
        return sumPreviews([...pending.change.add, ...pending.change.remove].map((value) => withAddressee(composeCost(home.repo, 'event', { value }, eventFirst))))
      case 'flag':
        // A lock is a transition; a pin an event.
        return pending.flag === 'lock' ? stateCost : composeCost(home.repo, 'event', {}, eventFirst)
      case 'milestone':
        return composeCost(home.repo, 'event', pending.title === null ? {} : { value: pending.title }, eventFirst)
      case 'defineLabel': {
        const def = previewCreate('label', { name: pending.name, color: pending.color, description: pending.description })
        const apply = composeCost(home.repo, 'event', { value: pending.name }, eventFirst)
        return pending.apply ? sumPreviews([def, apply]) : def
      }
      case 'editIssue':
        return previewReplace('issue', { title: pending.title, body: pending.body })
      case 'editComment':
        return previewReplace('comment', { body: pending.body })
      case 'deleteComment':
        return previewDelete('comment')
      case 'hide': {
        const hide = hideCost(home.repo, pending, eventFirst)
        const extra = pending.closeAndLock ? [...(open ? [stateCost] : []), ...(meta.locked ? [] : [stateCost])] : []
        return extra.length > 0 ? sumPreviews([hide, ...extra]) : hide
      }
      default:
        return stateCost
    }
  })()

  const confirm = confirmText(pending, issue.number, open, caps.canCloseReopen)
  const canModerate = isMaintainer && !archived && guard.disabledReason === null

  return (
    <AuthorRolesProvider owner={home.repo.ownerId} members={members} authors={threadAuthorIds(issue.author, timeline)}>
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <div className="min-w-0 space-y-5">
        {/* Header */}
        <div>
          {editing ? (
            <div className="space-y-2">
              <Field label="Title" htmlFor="edit-title">
                <Input id="edit-title" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} maxLength={256} />
              </Field>
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={editing.title.trim() === '' || (editing.title === issue.title && editing.body === issue.body) || (editLong.long ? editLong.problem !== null : utf8Length(editing.body) > BODY_MAX) || guard.disabledReason !== null}
                  onClick={() => setPending({ kind: 'editIssue', title: editing.title.trim(), body: editing.body })}
                >
                  Save
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3">
              <h1 className="flex-1 text-2xl">
                {issue.title || '(untitled)'} <span className="font-mono font-normal text-anvil-500 dark:text-anvil-400" data-testid="issue-number">{numberLabel(issue.number, shownUpstreamNumber(issue, home.repo, members))}</span>
              </h1>
              {isAuthor ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditing({ title: issue.title, body: issue.body })}
                  disabled={composeBlock !== null || longEditBlock(issue.long) !== null}
                  title={composeBlock ?? longEditBlock(issue.long) ?? undefined}
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
                </Button>
              ) : null}
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-dense">
            <span
              data-testid="issue-state"
              data-reason={open ? undefined : data.closedAs?.reason}
              title={open || !data.closedAs ? undefined : closedTitle(data.closedAs)}
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium text-white ${STATE_FILL[open ? 'open' : skipped ? 'skipped' : 'done']}`}
            >
              {open ? <CircleDot className="h-3.5 w-3.5" aria-hidden /> : skipped ? <CircleSlash className="h-3.5 w-3.5" aria-hidden /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
              {open ? 'Open' : 'Closed'}
            </span>
            <span className="inline-flex flex-wrap items-center gap-1.5 text-anvil-500 dark:text-anvil-400">
              <Byline author={issue.author} createdAt={issue.createdAt} origin={origin} verb="opened this" link={false} />
            </span>
            {addr ? <CopyLinkButton repo={addr} target={{ kind: 'issue', number: issue.number }} className="ml-auto" /> : null}
          </div>
        </div>

        {threadHidden !== null ? <HiddenBanner hidden={threadHidden} noun="issue" revealed={threadRevealed} onReveal={() => setThreadRevealed(true)} /> : null}

        {/* Body */}
        {threadCollapsed ? null : (
        <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-anvil-200 bg-anvil-50 px-4 py-2 text-dense coarse:min-h-12 dark:border-anvil-800 dark:bg-anvil-900">
            <Byline author={issue.author} createdAt={issue.createdAt} origin={origin} verb="authored" />
            <EditedMarker createdAt={issue.createdAt} updatedAt={issue.updatedAt} />
          </div>
          <div className="px-4 py-3">
            {editing ? (
              <>
                <MarkdownEditor id="edit-body" label="Description" value={editing.body} onChange={(body) => setEditing({ ...editing, body })} links={links} />
                <BodyCounter repo={home.repo} text={editing.body} field="description" long={editLong} />
              </>
            ) : issue.body ? (
              <>
                <MarkdownView source={issue.body} links={links} imported={importedUrlOf(issue.importedRaw)} />
                <LongBodyNote long={issue.long} />
              </>
            ) : (
              <p className="italic text-anvil-500 dark:text-anvil-400">No description.</p>
            )}
          </div>
        </div>
        )}

        {/* Timeline */}
        {!threadCollapsed && (timeline.length > 0 || (backlinks.linking.data?.mentioning.length ?? 0) > 0 || (duplicatesOf.data?.length ?? 0) > 0) ? (
          <Timeline
            items={timeline}
            links={links}
            trust={trust}
            {...(moderation ? { moderation } : {})}
            {...(canModerate
              ? {
                  moderate: ({ id }: { readonly kind: 'comment' | 'review'; readonly id: string }) => (
                    <HideMenu
                      hidden={isHidden(moderation, id)}
                      blocked={moderationBlocked(data.moderationInput, identity, id, !isHidden(moderation, id))}
                      disabled={false}
                      onHide={(reason) => setPending({ kind: 'hide', item: id, what: 'comment', reason, hide: true })}
                      onUnhide={() => setPending({ kind: 'hide', item: id, what: 'comment', reason: null, hide: false })}
                    />
                  ),
                }
              : {})}
            closedIn={(t) => closedInRef(t, backlinks, namedPulls, addr, home.repo.visibility === 'public' ? issue.number : null)}
            closeWhy={(t) => closeWhyOf(t, issue.number, data.duplicates ?? NO_DUPLICATES, (n) => (addr ? repoHref('/repo/issue', addr, { number: String(n) }) : ''))}
            crossRefs={crossRefsOf(backlinks.linking.data, addr)}
            imported={origin === null ? null : { origin, signer: issue.author, createdAt: issue.createdAt }}
            duplicateRefs={(duplicatesOf.data ?? []).map((d) => ({ id: d.id, actor: d.actor, at: d.createdAt, imported: d.imported, number: d.number, title: d.title, href: addr ? repoHref('/repo/issue', addr, { number: String(d.number) }) : '' }))}
            renderComment={(item) => {
              const slots = commentSlots({
                item,
                viewer: identity,
                editing: editingComment,
                editLong: commentEditLong,
                repo: home.repo,
                disabled: composeBlock !== null || guard.disabledReason !== null,
                deleteDisabled: archived || guard.disabledReason !== null,
                onEdit: setEditingComment,
                onSave: (id, body) => setPending({ kind: 'editComment', id, body }),
                onDelete: (id) => setPending({ kind: 'deleteComment', id }),
                links,
              })
              if (!whileLocked.has(item.comment.id)) return slots
              return {
                ...slots,
                header: (
                  <>
                    <span className="rounded-full bg-anvil-100 px-2 py-0.5 text-[11px] text-anvil-600 dark:bg-anvil-800 dark:text-anvil-300" data-testid="posted-while-locked" title="Posted by a non-member while the conversation was locked.">
                      posted while locked
                    </span>
                    {slots.header}
                  </>
                ),
              }
            }}
          />
        ) : null}

        <HiddenNote hidden={0} what="comments" home={home} by={hidden} />
        <EventValuesNote counts={eventValues} />

        {/* Composer */}
        <div className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800" data-testid="issue-composer">
          {/* Locked: a non-member's composer is replaced by the banner (consensus would refuse the post). */}
          <LockedBanner locked={lockApplies} viewer={lockViewer} target="issue">
            <h3 className="mb-2 text-dense font-medium">Add a comment</h3>
            {composeBlock !== null ? <PrivateComposeNote reason={composeBlock} /> : null}
            <MarkdownEditor id="comment-body" label="Comment" value={comment} onChange={setComment} placeholder="Leave a comment (markdown supported)…" links={links} onSubmit={composeBlock === null ? () => void postComment() : undefined} />
            <SealedLimit repo={home.repo} kind="comment" text={comment.trim()} long={commentLong} />
          </LockedBanner>
          {lockedOutNow && !canToggle ? null : (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            {lockedOutNow ? <span /> : <CostPreview cost={commentCost} />}
            <div className="flex items-center gap-2">
              {canToggle && open ? (
                <CloseIssueButton
                  number={issue.number}
                  label={stateToggleLabel(open, withComment !== null, 'issue')}
                  disabled={!signer || guard.disabledReason !== null || archived}
                  {...(guard.disabledReason ? { title: guard.disabledReason } : {})}
                  onClose={(closedAs) => setPending(withComment === null ? { kind: 'state', closedAs } : { kind: 'state', comment: withComment, closedAs })}
                  checkDuplicate={async (n) => ((await readDuplicateTargets(sdk!, home.repo, [n])).has(n) ? null : `#${n} is not an issue of this repo`)}
                />
              ) : canToggle ? (
                <Button
                  variant="outline"
                  onClick={() => setPending(withComment === null ? { kind: 'state' } : { kind: 'state', comment: withComment })}
                  disabled={!signer || guard.disabledReason !== null || archived}
                  title={guard.disabledReason ?? undefined}
                  data-testid="issue-state-toggle"
                >
                  <CircleDot className={`h-3.5 w-3.5 ${STATE_TEXT.open}`} aria-hidden />
                  {stateToggleLabel(open, withComment !== null, 'issue')}
                </Button>
              ) : null}
              {lockedOutNow ? null : (
                <Button
                  variant="primary"
                  onClick={postComment}
                  loading={posting}
                  disabled={composeBlock !== null || comment.trim() === '' || commentTooLong || guard.disabledReason !== null}
                  title={guard.disabledReason ?? undefined}
                >
                  {identity ? 'Comment' : locked ? 'Unlock to comment' : 'Sign in to comment'}
                </Button>
              )}
            </div>
          </div>
          )}
          {lockedOutNow ? null : <BodyCounter repo={home.repo} text={comment} field="comment" long={commentLong} />}
          {toggleHint !== null ? <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">{toggleHint}</p> : null}
          {commentError ? (
            <div role="alert" className="mt-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger-700 dark:text-danger-400 break-words">{commentError}</div>
          ) : null}
        </div>
      </div>

      {/* Sidebar: assignees and labels */}
      <aside className="space-y-5 text-dense" aria-label="Issue details">
        <SidebarSection title="Assignees" icon={UserPlus}>
          <AssigneePicker
            assignees={issue.state.assignees}
            members={members.map((m) => m.identity)}
            canEdit={caps.canAssign && !archived && guard.disabledReason === null}
            onApply={(change) => setPending({ kind: 'assignees', change })}
          />
        </SidebarSection>
        <SidebarSection title="Milestone" icon={Milestone}>
          <MilestonePicker
            current={meta.milestone}
            choices={milestones.data ?? []}
            loading={milestones.data === null && milestones.error === null}
            canDefine={!isPrivate}
            canEdit={caps.canMilestone && !archived && guard.disabledReason === null}
            onChoose={(title) => setPending({ kind: 'milestone', title })}
            {...(addr ? { manageHref: repoHref('/repo/milestones', addr) } : {})}
          />
        </SidebarSection>
        {isMember || meta.pinned || meta.locked ? (
          <SidebarSection title="Conversation" icon={Pin}>
            <p className="text-anvil-600 dark:text-anvil-300" data-testid="thread-flags">
              {meta.pinned ? 'Pinned' : 'Not pinned'} · {lockStateText(meta.locked)}
            </p>
            {(caps.canPin || caps.canLock) && !archived && guard.disabledReason === null ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {caps.canPin ? (
                  <Button size="sm" variant="outline" onClick={() => setPending({ kind: 'flag', flag: 'pin', on: !meta.pinned })} data-testid="pin-toggle">
                    {meta.pinned ? 'Unpin' : 'Pin'}
                  </Button>
                ) : null}
                {caps.canLock ? <LockToggle locked={meta.locked} onToggle={(on) => setPending({ kind: 'flag', flag: 'lock', on })} /> : null}
              </div>
            ) : null}
            {!archived ? <RoleLimitNote role={holdings.data?.role} cap="canPin" what={caps.canLock ? 'pin conversations' : 'pin, lock, label, assign or set milestones as a member'} className="mt-2" /> : null}
            {canModerate ? (
              <div className="mt-2">
                <HideThreadControl
                  hidden={threadHidden !== null}
                  blocked={moderationBlocked(data.moderationInput, identity, null, threadHidden === null)}
                  noun="issue"
                  offerClose={open}
                  offerLock={!meta.locked}
                  onHide={(reason, closeAndLock) => setPending({ kind: 'hide', item: null, what: 'issue', reason, hide: true, closeAndLock })}
                  onUnhide={() => setPending({ kind: 'hide', item: null, what: 'issue', reason: null, hide: false })}
                />
              </div>
            ) : null}
          </SidebarSection>
        ) : null}
        <SidebarSection title="Labels" icon={Tag}>
          <LabelPicker
            applied={issue.state.labels}
            defs={labels}
            byName={labelDefs}
            canEdit={caps.canLabel && !archived && guard.disabledReason === null}
            onApply={(change) => setPending({ kind: 'labels', change })}
            onDefine={(name, color, description) => setPending({ kind: 'defineLabel', name, color, description, apply: true })}
            {...(addr ? { manageHref: repoHref('/repo/labels', addr) } : {})}
          />
          {isPrivate ? <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">The labels on this issue are encrypted; the label definitions (names, colours, descriptions) are not.</p> : null}
        </SidebarSection>
        <SidebarSection title="Development" icon={GitPullRequest}>
          <LinkedPulls addr={addr} number={issue.number} backlinks={backlinks.linking} />
        </SidebarSection>
      </aside>

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={confirm.title}
        description={confirm.description}
        cost={pendingCost}
        confirmLabel={confirm.label}
        onConfirm={runPending}
      />
    </div>
    </AuthorRolesProvider>
  )
}

const NO_DUPLICATES: ReadonlyMap<number, { readonly number: number; readonly title: string }> = new Map()

/** The header badge's tooltip: "Closed as not planned". */
function closedTitle(c: ClosedAs): string {
  return `Closed as ${closedAsWords(c)}`
}

/** " as not planned": a close's reason in the confirm dialog's title (completed says nothing). */
function closeWords(c: ClosedAs | undefined): string {
  return c === undefined || c.reason === 'completed' ? '' : ` as ${closedAsWords(c)}`
}

/** The confirm dialog's words for each pending write. */
function confirmText(pending: Pending, number: number, open: boolean, isMember: boolean): { title: string; description: string; label: string } {
  switch (pending?.kind) {
    case 'hide':
      return hideConfirm(pending, `issue #${number}`)
    case 'labels':
      return labelsConfirm(pending.change)
    case 'assignees':
      return assigneesConfirm(pending.change)
    case 'flag':
      if (pending.flag === 'lock') return lockConfirm(pending.on, `issue #${number}`, 'issue')
      return pending.on
        ? { title: `Pin issue #${number}`, description: 'Appends a pin event: the issue is listed first on the repo\'s issues page (and in dg issue list).', label: 'Sign & pin' }
        : { title: `Unpin issue #${number}`, description: 'Appends an unpin event.', label: 'Sign & unpin' }
    case 'milestone':
      return pending.title === null
        ? { title: 'Clear the milestone', description: 'Appends a milestone-clear event.', label: 'Sign & clear' }
        : { title: `Set milestone "${pending.title}"`, description: 'Appends a milestone event naming it.', label: 'Sign & set' }
    case 'defineLabel':
      return {
        title: `Create label "${pending.name}"`,
        description: pending.apply ? 'Creates the label for this repo and adds it here.' : 'Creates the label for this repo.',
        label: 'Sign & create',
      }
    case 'editIssue':
      return { title: `Edit issue #${number}`, description: 'You pay only for what changed. Earlier versions stay in its history.', label: 'Sign & save' }
    case 'editComment':
      return { title: 'Edit comment', description: 'You pay only for what changed. Earlier versions stay in its history.', label: 'Sign & save' }
    case 'deleteComment':
      return {
        title: 'Delete comment',
        description: 'Part of its storage fee is refunded, and replies stay. The original stays in Platform history, so rotate any secret it held.',
        label: 'Sign & delete',
      }
    default: {
      const state = isMember ? 'a state event, as a member of this repo' : 'an author event: you opened this issue, so you can close and reopen it'
      const withComment = pending?.kind === 'state' && pending.comment !== undefined
      const why = open && pending?.kind === 'state' ? closeWords(pending.closedAs) : ''
      return {
        title: withComment ? `${open ? 'Close' : 'Reopen'} issue #${number}${why} with your comment` : open ? `Close issue #${number}${why}` : `Reopen issue #${number}`,
        description: withComment ? `Two writes: your comment, then ${state}.` : `Appends ${state}.`,
        label: stateToggleLabel(open, withComment, 'issue'),
      }
    }
  }
}

/** "closed this as completed in #3": the merged PR that closes this issue whose merge made `t` (QW2-048). */
function closedInRef(
  t: TransitionView,
  backlinks: IssueBacklinks,
  named: ReadonlyMap<number, ClosingPr | null>,
  addr: RepoAddress | undefined,
  issue: number | null,
): TimelineRef | null {
  if (addr === undefined) return null
  // A close naming its merge is judged by that alone, on a public repo (`issue` null otherwise).
  const pull = closedIn(t, backlinks.merges, issue === null ? undefined : () => namedClosingPull(backlinks, named, issue, t))
  return pull === null ? null : { number: pull.number, title: pull.title, href: pullHref(addr, pull.number) }
}

/** "mentioned this issue in #4": the PRs whose description names this issue without closing it. */
function crossRefsOf(backlinks: LinkingPulls | null, addr: RepoAddress | undefined): CrossRefItem[] {
  if (backlinks === null || addr === undefined) return []
  return backlinks.mentioning.map((p) => ({
    id: p.id,
    actor: p.author,
    at: p.createdAt,
    number: p.number,
    title: p.title,
    href: pullHref(addr, p.number),
    state: p.state.merged ? 'merged' : !p.state.open ? 'closed' : p.state.draft ? 'draft' : 'open',
  }))
}

/** A comment's Edit and Delete (its author only) in the header, and its inline editor as the body. */
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
  links?: MarkdownLinks
}): CommentSlots {
  const c = item.comment
  if (editing?.id === c.id) {
    return { body: (
      <div className="space-y-2 px-4 py-3">
        <MarkdownEditor id={`edit-comment-${c.id}`} label="Edit comment" value={editing.body} onChange={(body) => onEdit({ id: c.id, body })} links={links} autoFocus />
        <BodyCounter repo={repo} text={editing.body} field="comment" long={editLong} />
        <div className="flex gap-2">
          <Button variant="primary" size="sm" disabled={editing.body.trim() === '' || editing.body === c.body || (editLong.long ? editLong.problem !== null : utf8Length(editing.body) > BODY_MAX)} onClick={() => onSave(c.id, editing.body)}>
            Save
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onEdit(null)}>Cancel</Button>
        </div>
      </div>
    ) }
  }
  if (viewer === null || viewer !== c.author) return {}
  // A long comment whose rest could not be read is not edited here: the edit would drop the rest.
  const editBlock = longEditBlock(c.long)
  return { header: <CommentOwnActions onEdit={() => onEdit({ id: c.id, body: c.body })} onDelete={() => onDelete(c.id)} disabled={disabled || editBlock !== null} deleteDisabled={deleteDisabled} /> }
}

/**
 * The comments a non-member posted while the conversation was locked (the lock and unlock
 * `transition`s, kinds 3/4, in timeline order). Consensus refuses such a comment since RC1, so
 * this only marks one the timeline order cannot tell apart (a comment in the lock's own block).
 */
function commentsWhileLocked(items: readonly TimelineItem[], members: ReadonlySet<string>): Set<string> {
  const out = new Set<string>()
  let locked = false
  for (const it of [...items].sort((a, b) => a.at - b.at)) {
    if (it.kind === 'transition' && (it.transition.kind === ISSUE_LOCK || it.transition.kind === ISSUE_UNLOCK)) locked = it.transition.kind === ISSUE_LOCK
    else if (it.kind === 'comment' && locked && !members.has(it.comment.author)) out.add(it.comment.id)
  }
  return out
}

/** What an edit of the comment `id` must drop (`commentEditDrops`), or nothing when it is not on the timeline. */
function commentEditDropsOf(items: readonly TimelineItem[], id: string, opts: { isMember: boolean; allReadable: boolean }): ReturnType<typeof commentEditDrops> {
  const comments = items.flatMap((it) => (it.kind === 'comment' ? [it.comment] : []))
  const c = comments.find((x) => x.id === id)
  return c === undefined ? {} : commentEditDrops(c, comments, opts)
}

/** A comment of the timeline by id (the text an edit re-seals from). */
function timelineComment(items: readonly TimelineItem[], id: string): { body: string; revision?: number; importedRaw?: Readonly<Record<string, unknown>> | null } | undefined {
  for (const it of items) {
    if (it.kind === 'comment' && it.comment.id === id) return it.comment
  }
  return undefined
}
