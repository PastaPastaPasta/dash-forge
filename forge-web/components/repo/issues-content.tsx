'use client'

/**
 * IssuesContent — the issue list with open/closed fold + filter, and the compose flow.
 * State is the FORGE_RULES fold of each issue's event log (via core listIssues); composing an
 * issue is an ungated author-owned write, still shown with its pre-sign cost + confirm.
 */

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { CircleDot, CheckCircle2, MessageSquarePlus } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import type { IssueView, Listed } from '@/lib/repo'
import { createIssue, listIssuesCached, repoContractIds, repoKey } from '@/lib/repo'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { useRepoWriteGeneration } from '@/hooks/use-repo-chrome'
import { useIntent } from '@/hooks/use-intent'
import { writeErrorMessage } from '@/lib/view/write-errors'
import { ARCHIVED_REASON, timeAgo } from '@/lib/view'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useAuth } from '@/contexts/auth-context'
import { Author } from '@/components/author'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input, Textarea } from '@/components/ui/input'
import { SealedLimit, composeCost, privateComposeBlock } from '@/components/repo/private-compose'
import { CostPreview } from '@/components/ui/cost-preview'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { HiddenNote } from '@/components/repo/hidden-note'
import type { RepoAddress } from '@/hooks/use-query-param'
import { repoHref } from '@/hooks/use-query-param'
import { cn } from '@/lib/utils'

type Filter = 'open' | 'closed' | 'all'

export function IssuesContent({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  const { sdk, ready } = useSdk(repoContractIds(home.repo))
  const [filter, setFilter] = useState<Filter>('open')
  const [composing, setComposing] = useState(false)
  const archived = home.config?.archived === true
  const router = useRouter()
  const generation = useRepoWriteGeneration(home.repo)
  // A private repo's issues are sealed on write (`lib/repo/private-writes.ts`); only a member
  // holding the current key can open one, and non-members see no button (ux-dx-spec §9).
  const canCompose = privateComposeBlock(home) === null

  const { data, loading, error, reload } = useAsync<Listed<IssueView>>(
    // Through the session cache the header's open count reads, and re-read after each
    // count-changing write the header refolds on, so the two agree.
    () => listIssuesCached(sdk!, home.repo),
    [ready, repoKey(home.repo), generation],
    { enabled: ready && sdk !== null },
  )

  const counts = useMemo(() => {
    const open = data?.filter((i) => i.state.open).length ?? 0
    const closed = (data?.length ?? 0) - open
    return { open, closed }
  }, [data])

  const filtered = useMemo(() => {
    if (!data) return []
    if (filter === 'all') return data
    return data.filter((i) => (filter === 'open' ? i.state.open : !i.state.open))
  }, [data, filter])

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="inline-flex rounded-md border border-anvil-200 p-0.5 dark:border-anvil-750">
          <FilterTab active={filter === 'open'} onClick={() => setFilter('open')}>
            <CircleDot className="h-3.5 w-3.5" aria-hidden /> {counts.open} Open
          </FilterTab>
          <FilterTab active={filter === 'closed'} onClick={() => setFilter('closed')}>
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> {counts.closed} Closed
          </FilterTab>
          <FilterTab active={filter === 'all'} onClick={() => setFilter('all')}>
            All
          </FilterTab>
        </div>
        {canCompose ? (
          <Button variant="primary" size="sm" onClick={() => setComposing(true)} disabled={archived} title={archived ? ARCHIVED_REASON : undefined}>
            <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden /> New issue
          </Button>
        ) : null}
      </div>

      {loading ? (
        <LoadingBlock label="Folding issue state" />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={CircleDot}
          title={filter === 'closed' ? 'No closed issues' : 'No open issues'}
          body={filter === 'closed' ? 'Nothing has been closed yet.' : 'Everything is quiet. Open the first issue to start the conversation.'}
          action={canCompose && !archived ? <Button variant="primary" onClick={() => setComposing(true)}><MessageSquarePlus className="h-4 w-4" aria-hidden /> New issue</Button> : undefined}
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
          {filtered.map((issue) => (
            <Link
              key={issue.id}
              href={repoHref('/repo/issue', addr, { number: String(issue.number) })}
              className="flex items-start gap-3 border-b border-anvil-100 px-4 py-3 last:border-b-0 hover:bg-anvil-50 dark:border-anvil-850 dark:hover:bg-anvil-900"
            >
              {issue.state.open ? (
                <CircleDot className="mt-0.5 h-4 w-4 shrink-0 text-verify-700 dark:text-verify-400" aria-hidden />
              ) : (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-forge-500" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <span className="text-dense font-medium text-anvil-900 dark:text-anvil-50">{issue.title || '(untitled)'}</span>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-anvil-500 dark:text-anvil-400">
                  <span className="font-mono">#{issue.number}</span>
                  <span>opened {timeAgo(issue.createdAt)} by</span>
                  <Author identityId={issue.author} link={false} />
                  {/* The event log for this issue could not be read to completion, so the
                      open/closed marker beside it is a guess. Say so rather than showing a
                      fold over a partial history as fact. */}
                  {!issue.stateComplete ? (
                    <span
                      className="rounded-full bg-danger/10 px-2 py-0.5 text-[11px] text-danger-700 dark:text-danger-400"
                      title="This issue's event log could not be read completely, so its open/closed state is unverified."
                    >
                      state unverified
                    </span>
                  ) : null}
                  {issue.state.labels.map((l) => (
                    <span key={l} className="rounded-full bg-forge-500/10 px-2 py-0.5 text-[11px] text-forge-800 dark:text-forge-400">{l}</span>
                  ))}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      <HiddenNote hidden={data?.hidden ?? 0} what={data?.hidden === 1 ? 'issue' : 'issues'} home={home} by={data?.hiddenBy} />

      <ComposeIssueDialog
        open={composing}
        onClose={() => setComposing(false)}
        repo={home.repo}
        home={home}
        onCreated={(n) => router.push(repoHref('/repo/issue', addr, { number: String(n), created: '1' }))}
        addr={addr}
      />
    </div>
  )
}

function FilterTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-dense font-medium transition-colors',
        active ? 'bg-anvil-100 text-anvil-900 dark:bg-anvil-800 dark:text-anvil-50' : 'text-anvil-500 hover:text-anvil-800 dark:text-anvil-400 dark:hover:text-anvil-100',
      )}
    >
      {children}
    </button>
  )
}

function ComposeIssueDialog({
  open,
  onClose,
  repo,
  home,
  onCreated,
  addr,
}: {
  open: boolean
  onClose: () => void
  repo: RepoHome['repo']
  home: RepoHome
  onCreated: (number: number) => void
  addr: RepoAddress
}): JSX.Element {
  const { sdk } = useSdk(repoContractIds(repo))
  const { identity, signer } = useAuth()
  const guard = useWriteGuard()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const draft = useIntent()

  const cost = composeCost(repo, 'issue', { title: title.trim(), body })

  const submit = async (): Promise<void> => {
    if (pending || !guard.check(cost.credits, 'collab')) return
    if (!sdk || !signer || title.trim() === '') return
    setPending(true)
    setError(null)
    setNote(null)
    try {
      const created = await createIssue(sdk, signer, repo, { title: title.trim(), body, intent: draft.intent }, (taken, next) =>
        setNote(`Someone claimed #${taken} a moment ago; retrying as #${next}.`),
      )
      setTitle('')
      setBody('')
      draft.renew()
      onCreated(created.number)
      onClose()
    } catch (e) {
      setError(writeErrorMessage(e).message)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Open an issue"
      description={`In ${addr.owner}/${addr.name}. Anyone can open one.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={pending}
            disabled={title.trim() === '' || guard.disabledReason !== null}
            title={guard.disabledReason ?? undefined}
          >
            {identity ? 'Submit issue' : 'Sign in to submit'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Title" htmlFor="issue-title">
          <Input id="issue-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Something is broken…" autoFocus />
        </Field>
        <Field label="Description" htmlFor="issue-body" hint="Markdown supported.">
          <Textarea id="issue-body" value={body} onChange={(e) => setBody(e.target.value)} placeholder="What happened, and how to reproduce it." className="min-h-[140px]" />
          <SealedLimit repo={home.repo} kind="issue" text={title.trim() + body} />
        </Field>
        <CostPreview cost={cost} />
        {note ? <p className="text-dense text-caution-700 dark:text-caution-400">{note}</p> : null}
        {error ? (
          <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger-700 dark:text-danger-400 break-words">{error}</div>
        ) : null}
      </div>
    </Dialog>
  )
}
