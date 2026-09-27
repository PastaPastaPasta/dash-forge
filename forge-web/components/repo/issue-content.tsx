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

import { useMemo, useState } from 'react'
import { CheckCircle2, CircleDot, Pencil, Plus, Settings2, Tag, UserPlus, X } from 'lucide-react'
import type { RepoHome, IssueThread, TimelineItem } from '@/lib/view'
import { ACL_NAME, loadIssueThread, timeAgo } from '@/lib/view'
import {
  createComment,
  defineLabel,
  LABEL_COLORS,
  LABEL_LIMITS,
  readViewerPermissions,
  repoContractIds,
  repoKey,
  setAssignee,
  setLabel,
  setTargetState,
  updateComment,
  updateTarget,
  type LabelDef,
} from '@/lib/repo'
import type { Holdings } from '@/lib/rules'
import { previewCreate, previewReplace, type CostPreview as Cost } from '@/lib/sdk'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useIntent } from '@/hooks/use-intent'
import { writeErrorMessage } from '@/lib/view/write-errors'
import { useParam, repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { CopyLinkButton } from '@/components/ui/copy-link'
import { retryWhileMissing } from '@/lib/view/retry'
import { useAuth } from '@/contexts/auth-context'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { Author } from '@/components/author'
import { Timeline, type CommentSlots } from '@/components/repo/timeline'
import { MarkdownView, type MarkdownLinks } from '@/components/markdown-view'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { CostPreview } from '@/components/ui/cost-preview'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { AssigneeAvatars, EditedMarker, LabelChip, MarkdownEditor } from '@/components/repo/issue-bits'
import { HiddenNote } from '@/components/repo/hidden-note'
import { PrivateComposeNote, SealedLimit, composeCost, privateComposeBlock } from '@/components/repo/private-compose'
import { cn } from '@/lib/utils'
import { BODY_MAX, isIdentityId, utf8Length } from '@/lib/view/issue-query'

/** The write the confirm dialog is about to sign. */
type Pending =
  | { kind: 'state' }
  | { kind: 'label'; label: string; remove: boolean }
  | { kind: 'assign'; who: string; remove: boolean }
  | { kind: 'defineLabel'; name: string; color: string; description: string; apply: boolean }
  | { kind: 'editIssue'; title: string; body: string }
  | { kind: 'editComment'; id: string; body: string }
  | null

/** Bytes a body may hold (the `body` schema: 5,120). */

export function IssueContent({ home, addr, number }: { home: RepoHome; addr?: RepoAddress; number: number }): JSX.Element {
  const { sdk, ready, network } = useSdk(repoContractIds(home.repo))
  const { identity, signer } = useAuth()
  const guard = useWriteGuard()

  // Just created here: a node that has not applied the block yet answers "not found", so keep
  // asking for a few seconds rather than telling the author their issue does not exist.
  const justCreated = useParam('created') === '1'
  const { data, loading, error, reload } = useAsync<IssueThread | null>(
    () => retryWhileMissing(() => loadIssueThread(sdk!, home.repo, number, network), justCreated ? 8 : 0),
    [ready, repoKey(home.repo), number, network],
    { enabled: ready && sdk !== null && Number.isFinite(number) },
  )

  // A current maintainer/writer document (seeded by the composite above: no extra read).
  const holdings = useAsync<Holdings | null>(
    () => readViewerPermissions(sdk!, home.repo, identity!, network),
    [ready, repoKey(home.repo), identity ?? '', network, data === null ? 0 : 1],
    { enabled: ready && sdk !== null && identity !== null && data !== null },
  )

  const [comment, setComment] = useState('')
  const draft = useIntent()
  const [posting, setPosting] = useState(false)
  const [commentError, setCommentError] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending>(null)
  const [editing, setEditing] = useState<{ title: string; body: string } | null>(null)
  const [editingComment, setEditingComment] = useState<{ id: string; body: string } | null>(null)

  const links: MarkdownLinks | undefined = useMemo(
    () => (addr ? { issueHref: (n: number) => repoHref('/repo/issue', addr, { number: String(n) }) } : undefined),
    [addr],
  )

  if (!Number.isFinite(number)) return <EmptyState icon={CircleDot} title="No issue addressed" body="Add &number= to the URL." />
  if (loading && !data) return <LoadingBlock label="Folding issue" />
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (!data) return <EmptyState icon={CircleDot} title={`Issue #${number} not found`} body="No issue with that number in this repo." />

  const { issue, timeline, labels, members, hidden } = data
  const open = issue.state.open
  const isMember = holdings.data !== null && (holdings.data.write || holdings.data.maintain)
  const isAuthor = identity !== null && identity === issue.author
  const canToggle = identity !== null && (isAuthor || isMember)
  // A private repo is written sealed (issues, comments and edits: `private-writes.ts`); only a
  // member holding the current key can, so everyone else sees why not instead of a composer.
  const composeBlock = privateComposeBlock(home)
  const isPrivate = home.repo.visibility === 'private'
  const toggleHint =
    !canToggle && identity !== null && holdings.settled && holdings.data === null
      ? `Couldn't read this repo's ${ACL_NAME}, so close/reopen permission is unknown.`
      : null
  const target = { id: issue.id, number: issue.number }
  const commentCost = composeCost(home.repo, 'comment', { body: comment.trim() })
  // A member's close is an `event`; the author who is not a member uses `authorEvent`.
  const stateCost = previewCreate(isMember ? 'event' : 'authorEvent')
  const labelDefs = new Map(labels.map((l) => [l.name, l]))

  const postComment = async (): Promise<void> => {
    if (posting || comment.trim() === '' || !guard.check(commentCost.credits, 'collab')) return
    if (!sdk || !signer) return
    setPosting(true)
    setCommentError(null)
    try {
      await createComment(sdk, signer, home.repo, { targetId: issue.id, body: comment.trim(), intent: draft.intent })
      setComment('')
      draft.renew()
      reload()
    } catch (e) {
      setCommentError(writeErrorMessage(e).message)
    } finally {
      setPosting(false)
    }
  }

  const runPending = async (intent: string): Promise<void> => {
    if (!sdk || !signer || pending === null) throw new Error('sign in to continue')
    switch (pending.kind) {
      case 'state':
        await setTargetState(sdk, signer, home.repo, { target, kind: open ? 'close' : 'reopen', author: issue.author, isMember, intent })
        break
      case 'label':
        await setLabel(sdk, signer, home.repo, { target, label: pending.label, add: !pending.remove, intent })
        break
      case 'assign':
        await setAssignee(sdk, signer, home.repo, { target, assignee: pending.who, assign: !pending.remove, intent })
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
          seal: { current: { title: issue.title, body: issue.body }, bind: { number: issue.number } },
        })
        setEditing(null)
        break
      }
      case 'editComment':
        await updateComment(sdk, signer, home.repo, {
          id: pending.id,
          body: pending.body,
          seal: { current: { body: timelineComment(timeline, pending.id)?.body ?? '' }, bind: { targetId: issue.id } },
        })
        setEditingComment(null)
        break
    }
    reload()
  }

  const pendingCost = ((): Cost => {
    switch (pending?.kind) {
      case 'label':
        return previewCreate('event', { value: pending.label })
      case 'assign':
        return previewCreate('event', { value: pending.who })
      case 'defineLabel': {
        const def = previewCreate('label', { name: pending.name, color: pending.color, description: pending.description })
        const apply = previewCreate('event', { value: pending.name })
        return pending.apply ? { ...def, credits: def.credits + apply.credits } : def
      }
      case 'editIssue':
        return previewReplace('issue', { title: pending.title, body: pending.body })
      case 'editComment':
        return previewReplace('comment', { body: pending.body })
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
                {issue.title || '(untitled)'} <span className="font-mono font-normal text-anvil-500 dark:text-anvil-400">#{issue.number}</span>
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
            <span className="text-anvil-500 dark:text-anvil-400">
              <Author identityId={issue.author} link={false} /> opened this {timeAgo(issue.createdAt)}
            </span>
            {addr ? <CopyLinkButton repo={addr} target={{ kind: 'issue', number: issue.number }} className="ml-auto" /> : null}
          </div>
        </div>

        {/* Body */}
        <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
          <div className="flex items-center gap-2 border-b border-anvil-200 bg-anvil-50 px-4 py-2 text-dense dark:border-anvil-800 dark:bg-anvil-900">
            <Author identityId={issue.author} />
            <span className="text-anvil-500 dark:text-anvil-400">authored {timeAgo(issue.createdAt)}</span>
            <EditedMarker createdAt={issue.createdAt} updatedAt={issue.updatedAt} />
          </div>
          <div className="px-4 py-3">
            {editing ? (
              <MarkdownEditor id="edit-body" label="Description" value={editing.body} onChange={(body) => setEditing({ ...editing, body })} links={links} />
            ) : issue.body ? (
              <MarkdownView source={issue.body} links={links} />
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
            renderComment={(item) =>
              commentSlots({
                item,
                viewer: identity,
                editing: editingComment,
                disabled: composeBlock !== null || guard.disabledReason !== null,
                onEdit: setEditingComment,
                onSave: (id, body) => setPending({ kind: 'editComment', id, body }),
                links,
              })
            }
          />
        ) : null}

        <HiddenNote hidden={0} what="comments" home={home} by={hidden} />

        {/* Composer */}
        <div className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
          <h3 className="mb-2 text-dense font-medium">Add a comment</h3>
          {composeBlock !== null ? <PrivateComposeNote reason={composeBlock} /> : null}
          <MarkdownEditor id="comment-body" label="Comment" value={comment} onChange={setComment} placeholder="Leave a comment (markdown supported)…" links={links} />
          <SealedLimit repo={home.repo} kind="comment" text={comment.trim()} />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <CostPreview cost={commentCost} />
            <div className="flex items-center gap-2">
              {canToggle ? (
                <Button
                  variant="outline"
                  onClick={() => setPending({ kind: 'state' })}
                  disabled={!signer || guard.disabledReason !== null}
                  title={guard.disabledReason ?? undefined}
                >
                  {open ? 'Close issue' : 'Reopen issue'}
                </Button>
              ) : null}
              <Button
                variant="primary"
                onClick={postComment}
                loading={posting}
                disabled={composeBlock !== null || comment.trim() === '' || utf8Length(comment) > BODY_MAX || guard.disabledReason !== null}
                title={guard.disabledReason ?? undefined}
              >
                {identity ? 'Comment' : 'Sign in to comment'}
              </Button>
            </div>
          </div>
          {utf8Length(comment) > BODY_MAX ? <p className="mt-2 text-dense text-danger-700 dark:text-danger-400">A comment holds 5,120 bytes; this one is {utf8Length(comment)}.</p> : null}
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
            canEdit={isMember && guard.disabledReason === null}
            onToggle={(who, remove) => setPending({ kind: 'assign', who, remove })}
          />
        </SidebarSection>
        <SidebarSection title="Labels" icon={Tag}>
          <LabelPicker
            applied={issue.state.labels}
            defs={labels}
            byName={labelDefs}
            canEdit={isMember && guard.disabledReason === null}
            onToggle={(label, remove) => setPending({ kind: 'label', label, remove })}
            onDefine={(name, color, description) => setPending({ kind: 'defineLabel', name, color, description, apply: true })}
          />
          {isPrivate ? <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">Labels are not encrypted in private repositories.</p> : null}
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
    default:
      return {
        title: open ? `Close issue #${number}` : `Reopen issue #${number}`,
        description: isMember ? 'Appends a state event, as a maintainer or writer of this repo.' : 'Appends an author event: you opened this issue, so you can close and reopen it.',
        label: open ? 'Close issue' : 'Reopen issue',
      }
  }
}

function SidebarSection({ title, icon: Icon, children }: { title: string; icon: typeof Tag; children: React.ReactNode }): JSX.Element {
  return (
    <section className="border-b border-anvil-200 pb-4 dark:border-anvil-800">
      <h2 className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-anvil-500 dark:text-anvil-400">
        <Icon className="h-3.5 w-3.5" aria-hidden /> {title}
      </h2>
      {children}
    </section>
  )
}

/** A comment's edit affordance (its author only) in the header, and its inline editor as the body. */
function commentSlots({
  item,
  viewer,
  editing,
  disabled,
  onEdit,
  onSave,
  links,
}: {
  item: Extract<TimelineItem, { kind: 'comment' }>
  viewer: string | null
  editing: { id: string; body: string } | null
  disabled: boolean
  onEdit: (e: { id: string; body: string } | null) => void
  onSave: (id: string, body: string) => void
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
  return { header: (
    <button
      type="button"
      onClick={() => onEdit({ id: c.id, body: c.body })}
      disabled={disabled}
      className="ml-auto inline-flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400 hover:text-forge-700 dark:hover:text-forge-400 disabled:opacity-50"
      aria-label="Edit comment"
    >
      <Pencil className="h-3 w-3" aria-hidden /> Edit
    </button>
  ) }
}

/** The assignees, and for members a picker of the repo's members (assign / unassign). */
function AssigneePicker({
  assignees,
  members,
  canEdit,
  onToggle,
}: {
  assignees: readonly string[]
  members: readonly string[]
  canEdit: boolean
  onToggle: (who: string, remove: boolean) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [other, setOther] = useState('')
  const candidates = [...new Set([...assignees, ...members])]
  return (
    <div>
      {assignees.length === 0 ? <p className="text-anvil-500 dark:text-anvil-400">No one assigned</p> : null}
      <ul className="space-y-1.5" aria-label="Assignees">
        {assignees.map((a) => (
          <li key={a} className="flex items-center gap-2">
            <AssigneeAvatars ids={[a]} />
            <Author identityId={a} />
          </li>
        ))}
      </ul>
      {canEdit ? (
        <div className="mt-2">
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400 hover:text-forge-700 dark:hover:text-forge-400">
            <Settings2 className="h-3.5 w-3.5" aria-hidden /> Edit assignees
          </button>
          {open ? (
            <div className="mt-2 space-y-1 rounded-md border border-anvil-200 p-2 dark:border-anvil-750" role="group" aria-label="Choose assignees">
              {candidates.map((m) => {
                const on = assignees.includes(m)
                return (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={on}
                    onClick={() => onToggle(m, on)}
                    className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-anvil-100 dark:hover:bg-anvil-850"
                    data-testid="assignee-option"
                    data-identity={m}
                  >
                    <input type="checkbox" readOnly checked={on} tabIndex={-1} aria-hidden className="accent-forge-600" />
                    <Author identityId={m} link={false} />
                  </button>
                )
              })}
              <div className="flex gap-1 pt-1">
                <Input aria-label="Assign identity id" value={other} onChange={(e) => setOther(e.target.value)} placeholder="identity id" className="h-7 py-0 font-mono text-[12px]" />
                <Button variant="outline" size="sm" disabled={!isIdentityId(other.trim())} onClick={() => onToggle(other.trim(), false)}>
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** The applied labels, and for members a picker of the defined labels plus a create form. */
function LabelPicker({
  applied,
  defs,
  byName,
  canEdit,
  onToggle,
  onDefine,
}: {
  applied: readonly string[]
  defs: readonly LabelDef[]
  byName: ReadonlyMap<string, LabelDef>
  canEdit: boolean
  onToggle: (label: string, remove: boolean) => void
  onDefine: (name: string, color: string, description: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [color, setColor] = useState(LABEL_COLORS[5] ?? '#1d76db')
  const [description, setDescription] = useState('')
  const names = [...new Set([...defs.filter((d) => !d.retired).map((d) => d.name), ...applied])]
  const shown = names.filter((n) => n.toLowerCase().includes(filter.trim().toLowerCase()))
  const newName = filter.trim()
  const canCreate = newName !== '' && [...newName].length <= LABEL_LIMITS.name && !names.some((n) => n.toLowerCase() === newName.toLowerCase())
  return (
    <div>
      {applied.length === 0 ? <p className="text-anvil-500 dark:text-anvil-400">None yet</p> : null}
      <div className="flex flex-wrap gap-1.5" aria-label="Applied labels">
        {applied.map((l) => (
          <LabelChip key={l} name={l} def={byName.get(l)}>
            {canEdit ? (
              <button type="button" aria-label={`Remove label ${l}`} onClick={() => onToggle(l, true)} className="opacity-70 hover:opacity-100">
                <X className="h-3 w-3" aria-hidden />
              </button>
            ) : null}
          </LabelChip>
        ))}
      </div>
      {canEdit ? (
        <div className="mt-2">
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400 hover:text-forge-700 dark:hover:text-forge-400">
            <Settings2 className="h-3.5 w-3.5" aria-hidden /> Edit labels
          </button>
          {open ? (
            <div className="mt-2 space-y-2 rounded-md border border-anvil-200 p-2 dark:border-anvil-750">
              <Input aria-label="Filter or create a label" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter or new label" className="h-7 py-0 text-[12px]" maxLength={LABEL_LIMITS.name} />
              <div className="max-h-56 space-y-0.5 overflow-auto" role="group" aria-label="Choose labels">
                {shown.map((n) => {
                  const on = applied.includes(n)
                  const def = byName.get(n)
                  return (
                    <button
                      key={n}
                      type="button"
                      aria-pressed={on}
                      onClick={() => onToggle(n, on)}
                      className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-anvil-100 dark:hover:bg-anvil-850"
                      data-testid="label-option"
                    >
                      <input type="checkbox" readOnly checked={on} tabIndex={-1} aria-hidden className="accent-forge-600" />
                      <LabelChip name={n} def={def} />
                      {def?.description ? <span className="truncate text-[11px] text-anvil-500 dark:text-anvil-400">{def.description}</span> : null}
                    </button>
                  )
                })}
              </div>
              {canCreate ? (
                <div className="space-y-2 border-t border-anvil-200 pt-2 dark:border-anvil-750">
                  <p className="text-[12px] text-anvil-500 dark:text-anvil-400">Create “{newName}” for this repo:</p>
                  <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Label colour">
                    {LABEL_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        role="radio"
                        aria-checked={color === c}
                        aria-label={`Colour ${c}`}
                        onClick={() => setColor(c)}
                        className={cn('h-5 w-5 rounded-full border', color === c ? 'border-anvil-900 ring-2 ring-forge-500 dark:border-white' : 'border-transparent')}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                  <Input aria-label="Label description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" className="h-7 py-0 text-[12px]" maxLength={LABEL_LIMITS.description} />
                  <div className="flex items-center gap-2">
                    <LabelChip name={newName} def={{ name: newName, color, description, retired: false, createdAt: 0, id: '' }} />
                    <Button variant="outline" size="sm" onClick={() => onDefine(newName, color, description)}>
                      Create label
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** A comment of the timeline by id (the text an edit re-seals from). */
function timelineComment(items: readonly TimelineItem[], id: string): { body: string } | undefined {
  for (const it of items) {
    if (it.kind === 'comment' && it.comment.id === id) return it.comment
  }
  return undefined
}
