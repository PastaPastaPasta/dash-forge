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
import { useCallback, useRef, useState } from 'react'
import { CheckCircle2, CircleDot, GitPullRequest, Milestone, Pencil, Pin, Tag, UserPlus } from 'lucide-react'
import { LinkedPulls } from '@/components/repo/linked-pulls'
import type { RepoHome, IssueThread, TimelineItem } from '@/lib/view'
import { ACL_NAME, ARCHIVED_REASON, issueWriteShows, loadIssueThread } from '@/lib/view'
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
import { SupersededWriteError, UnconfirmedWriteError, previewCreate, previewDelete, previewReplace, sumPreviews, type CostPreview as Cost } from '@/lib/sdk'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useIntent } from '@/hooks/use-intent'
import { useFirstWrite } from '@/hooks/use-first-write'
import { repoHref, useParam, type RepoAddress } from '@/hooks/use-query-param'
import { useRepoLinks } from '@/components/repo/target-href'
import { importedUrlOf } from '@/lib/view/ref-targets'
import { CopyLinkButton } from '@/components/ui/copy-link'
import { readUntil, retryWhileMissing } from '@/lib/view/retry'
import { useAuth } from '@/contexts/auth-context'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { TargetNotFound } from '@/components/repo/number-content'
import { CommentOwnActions, Timeline, type CommentSlots } from '@/components/repo/timeline'
import { MarkdownView, type MarkdownLinks } from '@/components/markdown-view'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { CostPreview } from '@/components/ui/cost-preview'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { EditedMarker, MarkdownEditor } from '@/components/repo/issue-bits'
import { AssigneePicker, LabelPicker, MilestonePicker, SidebarSection } from '@/components/repo/target-rail'
import { readMilestones } from '@/lib/repo/milestones'
import { EventValuesNote, HiddenNote } from '@/components/repo/hidden-note'
import { LockToggle, LockedBanner, lockConfirm, lockStateText, lockViewerOf } from '@/components/repo/locked-banner'
import { BodyCounter, PrivateComposeNote, SealedLimit, composeCost, privateComposeBlock } from '@/components/repo/private-compose'
import { BODY_MAX, utf8Length } from '@/lib/view/issue-query'
import { numberLabel, shownUpstreamNumber } from '@/lib/view/upstream'

/** The write the confirm dialog is about to sign. */
type Pending =
  | { kind: 'state' }
  | { kind: 'label'; label: string; remove: boolean }
  | { kind: 'assign'; who: string; remove: boolean }
  | { kind: 'flag'; flag: 'pin' | 'lock'; on: boolean }
  | { kind: 'milestone'; title: string | null }
  | { kind: 'defineLabel'; name: string; color: string; description: string; apply: boolean }
  | { kind: 'editIssue'; title: string; body: string }
  | { kind: 'editComment'; id: string; body: string }
  | { kind: 'deleteComment'; id: string }
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

  // The repo's milestones, for the picker: read for members only (only they can set one).
  const canSetMilestone = holdings.data !== null && (holdings.data.write || holdings.data.maintain)
  const milestones = useAsync(
    () => readMilestones(sdk!, home.repo),
    [ready, repoKey(home.repo), canSetMilestone ? 1 : 0],
    { enabled: ready && sdk !== null && canSetMilestone },
  )

  const [comment, setComment] = useState('')
  const draft = useIntent()
  const [posting, setPosting] = useState(false)
  const [commentError, setCommentError] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending>(null)
  const [editing, setEditing] = useState<{ title: string; body: string } | null>(null)
  const [editingComment, setEditingComment] = useState<{ id: string; body: string } | null>(null)

  const repoLinks = useRepoLinks(addr ?? { owner: '', name: '' }, home.description)
  const links: MarkdownLinks | undefined = addr ? repoLinks : undefined

  // Which subtrees this viewer's comment or event would create, for tight previews (D-011).
  // Read only once the viewer turns to a write (typing a comment, or a confirm opening): the
  // previews are upper bounds meanwhile, and a page view costs no reads.
  const issueId = data?.issue.id ?? ''
  const hasComments = data ? data.timeline.some((t) => t.kind === 'comment') : undefined
  const viewerMember = holdings.data !== null && (holdings.data.write || holdings.data.maintain)
  const firstsReady = (comment !== '' || pending !== null) && ready && sdk !== null && identity !== null && issueId !== ''
  const commentFirst = useFirstWrite(() => commentFirsts(sdk!, home.repo, issueId, identity!, hasComments), [issueId, identity ?? '', hasComments ?? ''], firstsReady)
  const stateFirst = useFirstWrite(() => eventFirsts(sdk!, home.repo, 'transition', issueId, identity!), [issueId, identity ?? ''], firstsReady)
  const eventFirst = useFirstWrite(() => eventFirsts(sdk!, home.repo, 'event', issueId, identity!), [issueId, identity ?? ''], firstsReady && viewerMember)

  if (!Number.isFinite(number)) return <EmptyState icon={CircleDot} title="No issue addressed" body="Add &number= to the URL." />
  if (loading && !data) return <LoadingBlock label="Folding issue" />
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (!data) return <TargetNotFound home={home} addr={addr} number={number} kind="issue" icon={CircleDot} title={`Issue #${number} not found`} body="No issue or pull request with that number in this repo." />

  const { issue, timeline, labels, members, hidden, eventValues, meta } = data
  const origin = trustedOrigin(issue.origin, issue.author, trust)
  const whileLocked = commentsWhileLocked(timeline, new Set(members.map((m) => m.identity)))
  const open = issue.state.open
  const isMember = holdings.data !== null && (holdings.data.write || holdings.data.maintain)
  const postContext = { isMember, locked: meta.locked }
  const isAuthor = identity !== null && identity === issue.author
  const canToggle = identity !== null && (isAuthor || isMember)
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
  const labelDefs = new Map(labels.map((l) => [l.name, l]))

  const postComment = async (): Promise<void> => {
    if (posting || comment.trim() === '' || utf8Length(comment) > BODY_MAX || !guard.check(commentCost, 'collab', 'comment')) return
    if (!sdk || !signer) return
    setPosting(true)
    setCommentError(null)
    try {
      const posted = await createComment(sdk, signer, home.repo, { targetId: issue.id, body: comment.trim(), intent: draft.intent, post: postContext })
      setComment('')
      draft.renew()
      refresh((t) => issueWriteShows(t, { kind: 'comment', id: posted.documentId }))
    } catch (e) {
      if (e instanceof SupersededWriteError) {
        // The earlier version was posted: show it, and never post this draft a second time.
        setComment('')
        draft.renew()
        refresh((t) => issueWriteShows(t, { kind: 'comment', id: e.documentId }))
      } else if (e instanceof UnconfirmedWriteError) {
        // Sent, not yet visible: keep reading until it shows (the draft stays, as the error says).
        refresh((t) => issueWriteShows(t, { kind: 'comment', id: e.documentId }))
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
      case 'state':
        await setTargetState(sdk, signer, home.repo, { target: { ...target, type: 'issue', author: issue.author }, action: open ? 'close' : 'reopen', isMember, intent })
        break
      case 'label':
        await setLabel(sdk, signer, home.repo, { target, label: pending.label, add: !pending.remove, intent })
        break
      case 'assign':
        await setAssignee(sdk, signer, home.repo, { target, assignee: pending.who, assign: !pending.remove, intent })
        break
      case 'flag':
        // A lock is a member transition since RC1 (consensus then refuses non-members' comments).
        if (pending.flag === 'lock') await setLock(sdk, signer, home.repo, { target: { ...target, type: 'issue', author: issue.author }, lock: pending.on, isMember, intent })
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
          seal: { current: { title: issue.title, body: issue.body }, bind: { number: issue.number }, imported: issue.importedRaw ?? null },
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
        })
        setEditingComment(null)
        break
      case 'deleteComment':
        await deleteComment(sdk, signer, home.repo, pending.id)
        if (editingComment?.id === pending.id) setEditingComment(null)
        break
    }
    refresh((t) => issueWriteShows(t, write.kind === 'state' ? { kind: 'state', open: !open } : write))
  }

  const pendingCost = ((): Cost => {
    switch (pending?.kind) {
      case 'label':
        return composeCost(home.repo, 'event', { value: pending.label }, eventFirst)
      case 'assign':
        return composeCost(home.repo, 'event', { value: pending.who }, eventFirst)
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
      default:
        return stateCost
    }
  })()

  const confirm = confirmText(pending, issue.number, open, isMember)

  return (
    <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
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
                  disabled={editing.title.trim() === '' || (editing.title === issue.title && editing.body === issue.body) || utf8Length(editing.body) > BODY_MAX || guard.disabledReason !== null}
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
                  disabled={composeBlock !== null}
                  title={composeBlock ?? undefined}
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
                </Button>
              ) : null}
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-dense">
            <span
              data-testid="issue-state"
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium text-white ${open ? 'bg-verify-700' : 'bg-forge-700'}`}
            >
              {open ? <CircleDot className="h-3.5 w-3.5" aria-hidden /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
              {open ? 'Open' : 'Closed'}
            </span>
            <span className="inline-flex flex-wrap items-center gap-1.5 text-anvil-500 dark:text-anvil-400">
              <Byline author={issue.author} createdAt={issue.createdAt} origin={origin} verb="opened this" link={false} />
            </span>
            {addr ? <CopyLinkButton repo={addr} target={{ kind: 'issue', number: issue.number }} className="ml-auto" /> : null}
          </div>
        </div>

        {/* Body */}
        <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
          <div className="flex items-center gap-2 border-b border-anvil-200 bg-anvil-50 px-4 py-2 text-dense coarse:min-h-12 dark:border-anvil-800 dark:bg-anvil-900">
            <Byline author={issue.author} createdAt={issue.createdAt} origin={origin} verb="authored" />
            <EditedMarker createdAt={issue.createdAt} updatedAt={issue.updatedAt} />
          </div>
          <div className="px-4 py-3">
            {editing ? (
              <MarkdownEditor id="edit-body" label="Description" value={editing.body} onChange={(body) => setEditing({ ...editing, body })} links={links} />
            ) : issue.body ? (
              <MarkdownView source={issue.body} links={links} imported={importedUrlOf(issue.importedRaw)} />
            ) : (
              <p className="italic text-anvil-500 dark:text-anvil-400">No description.</p>
            )}
          </div>
        </div>

        {/* Timeline */}
        {timeline.length > 0 ? (
          <Timeline
            items={timeline}
            links={links}
            trust={trust}
            renderComment={(item) => {
              const slots = commentSlots({
                item,
                viewer: identity,
                editing: editingComment,
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
                    <span className="rounded-full bg-anvil-100 px-2 py-0.5 text-[11px] text-anvil-600 dark:bg-anvil-800 dark:text-anvil-300" data-testid="posted-while-locked" title="A non-member posted this while the conversation was locked to members (consensus cannot refuse it; Forge clients do not offer it).">
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
            <MarkdownEditor id="comment-body" label="Comment" value={comment} onChange={setComment} placeholder="Leave a comment (markdown supported)…" links={links} />
            <SealedLimit repo={home.repo} kind="comment" text={comment.trim()} />
          </LockedBanner>
          {lockedOutNow && !canToggle ? null : (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            {lockedOutNow ? <span /> : <CostPreview cost={commentCost} />}
            <div className="flex items-center gap-2">
              {canToggle ? (
                <Button
                  variant="outline"
                  onClick={() => setPending({ kind: 'state' })}
                  disabled={!signer || guard.disabledReason !== null || archived}
                  title={guard.disabledReason ?? undefined}
                >
                  {open ? 'Close issue' : 'Reopen issue'}
                </Button>
              ) : null}
              {lockedOutNow ? null : (
                <Button
                  variant="primary"
                  onClick={postComment}
                  loading={posting}
                  disabled={composeBlock !== null || comment.trim() === '' || utf8Length(comment) > BODY_MAX || guard.disabledReason !== null}
                  title={guard.disabledReason ?? undefined}
                >
                  {identity ? 'Comment' : locked ? 'Unlock to comment' : 'Sign in to comment'}
                </Button>
              )}
            </div>
          </div>
          )}
          {lockedOutNow ? null : <BodyCounter repo={home.repo} text={comment} field="comment" />}
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
            canEdit={isMember && !archived && guard.disabledReason === null}
            onToggle={(who, remove) => setPending({ kind: 'assign', who, remove })}
          />
        </SidebarSection>
        <SidebarSection title="Milestone" icon={Milestone}>
          <MilestonePicker
            current={meta.milestone}
            choices={milestones.data ?? []}
            loading={milestones.data === null && milestones.error === null}
            canDefine={!isPrivate}
            canEdit={isMember && !archived && guard.disabledReason === null}
            onChoose={(title) => setPending({ kind: 'milestone', title })}
            {...(addr ? { manageHref: repoHref('/repo/milestones', addr) } : {})}
          />
        </SidebarSection>
        {isMember || meta.pinned || meta.locked ? (
          <SidebarSection title="Conversation" icon={Pin}>
            <p className="text-anvil-600 dark:text-anvil-300" data-testid="thread-flags">
              {meta.pinned ? 'Pinned' : 'Not pinned'} · {lockStateText(meta.locked)}
            </p>
            {isMember && !archived && guard.disabledReason === null ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setPending({ kind: 'flag', flag: 'pin', on: !meta.pinned })} data-testid="pin-toggle">
                  {meta.pinned ? 'Unpin' : 'Pin'}
                </Button>
                <LockToggle locked={meta.locked} onToggle={(on) => setPending({ kind: 'flag', flag: 'lock', on })} />
              </div>
            ) : null}
          </SidebarSection>
        ) : null}
        <SidebarSection title="Labels" icon={Tag}>
          <LabelPicker
            applied={issue.state.labels}
            defs={labels}
            byName={labelDefs}
            canEdit={isMember && !archived && guard.disabledReason === null}
            onToggle={(label, remove) => setPending({ kind: 'label', label, remove })}
            onDefine={(name, color, description) => setPending({ kind: 'defineLabel', name, color, description, apply: true })}
            {...(addr ? { manageHref: repoHref('/repo/labels', addr) } : {})}
          />
          {isPrivate ? <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">The labels on this issue are encrypted; the label definitions (names, colours, descriptions) are not.</p> : null}
        </SidebarSection>
        <SidebarSection title="Development" icon={GitPullRequest}>
          <LinkedPulls home={home} addr={addr} number={issue.number} upstream={trustedUpstreamNumber(issue.upstreamNumber, issue.author, home.repo.ownerId, new RoleOracle([...members]))} />
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
  )
}

/** The confirm dialog's words for each pending write. */
function confirmText(pending: Pending, number: number, open: boolean, isMember: boolean): { title: string; description: string; label: string } {
  switch (pending?.kind) {
    case 'label':
      return { title: `${pending.remove ? 'Remove' : 'Add'} label "${pending.label}"`, description: 'Appends a label event. Only maintainers and writers can label.', label: 'Sign & label' }
    case 'assign':
      return {
        title: pending.remove ? 'Remove assignee' : 'Assign',
        description: `${pending.remove ? 'Unassigns' : 'Assigns'} ${pending.who.slice(0, 10)}… with a member event, which also names them as its addressee so it shows up under "assigned to me".`,
        label: pending.remove ? 'Sign & unassign' : 'Sign & assign',
      }
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
        description: pending.apply ? 'Two documents: the label definition (for the whole repo), then a label event on this issue.' : 'One label definition for the whole repo.',
        label: 'Sign & create',
      }
    case 'editIssue':
      return { title: `Edit issue #${number}`, description: 'Replaces your issue document; you pay only for the changed bytes. Earlier versions stay readable on Platform.', label: 'Sign & save' }
    case 'editComment':
      return { title: 'Edit comment', description: 'Replaces your comment document; you pay only for the changed bytes.', label: 'Sign & save' }
    case 'deleteComment':
      return {
        title: 'Delete comment',
        description: 'Deletes your comment document (its storage fee is partly refunded). Replies to it stay. The write that posted it stays in the chain history, so rotate any secret it held.',
        label: 'Sign & delete',
      }
    default:
      return {
        title: open ? `Close issue #${number}` : `Reopen issue #${number}`,
        description: isMember ? 'Appends a state event, as a maintainer or writer of this repo.' : 'Appends an author event: you opened this issue, so you can close and reopen it.',
        label: open ? 'Close issue' : 'Reopen issue',
      }
  }
}

/** A comment's Edit and Delete (its author only) in the header, and its inline editor as the body. */
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
  links?: MarkdownLinks
}): CommentSlots {
  const c = item.comment
  if (editing?.id === c.id) {
    return { body: (
      <div className="space-y-2 px-4 py-3">
        <MarkdownEditor id={`edit-comment-${c.id}`} label="Edit comment" value={editing.body} onChange={(body) => onEdit({ id: c.id, body })} links={links} autoFocus />
        <div className="flex gap-2">
          <Button variant="primary" size="sm" disabled={editing.body.trim() === '' || editing.body === c.body || utf8Length(editing.body) > BODY_MAX} onClick={() => onSave(c.id, editing.body)}>
            Save
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onEdit(null)}>Cancel</Button>
        </div>
      </div>
    ) }
  }
  if (viewer === null || viewer !== c.author) return {}
  return { header: <CommentOwnActions onEdit={() => onEdit({ id: c.id, body: c.body })} onDelete={() => onDelete(c.id)} disabled={disabled} deleteDisabled={deleteDisabled} /> }
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
