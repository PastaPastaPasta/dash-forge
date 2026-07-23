'use client'

/**
 * IssuesContent — the issue list with open/closed fold + filter, and the compose flow.
 * State is the FORGE_RULES fold of each issue's event log (via core listIssues); composing an
 * issue is an ungated author-owned write, still shown with its pre-sign cost + confirm.
 */

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { CircleDot, CheckCircle2, MessageSquarePlus } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import type { IssueView } from '@/lib/repo'
import { createIssue, listIssues } from '@/lib/repo'
import { previewDocumentCreate } from '@/lib/sdk'
import { timeAgo } from '@/lib/view'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { Author } from '@/components/author'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input, Textarea } from '@/components/ui/input'
import { CostPreview } from '@/components/ui/cost-preview'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import type { RepoAddress } from '@/hooks/use-query-param'
import { repoHref } from '@/hooks/use-query-param'
import { cn } from '@/lib/utils'

type Filter = 'open' | 'closed' | 'all'

export function IssuesContent({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  const { sdk, ready } = useSdk([home.repo.contractId])
  const [filter, setFilter] = useState<Filter>('open')
  const [composing, setComposing] = useState(false)

  const { data, loading, error, reload } = useAsync<IssueView[]>(
    () => listIssues(sdk!, home.repo, undefined, 100),
    [ready, home.repo.contractId],
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
        <Button variant="primary" size="sm" onClick={() => setComposing(true)}>
          <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden /> New issue
        </Button>
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
          action={<Button variant="primary" onClick={() => setComposing(true)}><MessageSquarePlus className="h-4 w-4" aria-hidden /> New issue</Button>}
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
                <CircleDot className="mt-0.5 h-4 w-4 shrink-0 text-verify" aria-hidden />
              ) : (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-forge-500" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <span className="text-dense font-medium text-anvil-900 dark:text-anvil-50">{issue.title || '(untitled)'}</span>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-anvil-400">
                  <span className="font-mono">#{issue.number}</span>
                  <span>opened {timeAgo(issue.createdAt)} by</span>
                  <Author identityId={issue.author} link={false} />
                  {issue.state.labels.map((l) => (
                    <span key={l} className="rounded-full bg-forge-500/10 px-2 py-0.5 text-[11px] text-forge-600 dark:text-forge-400">{l}</span>
                  ))}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      <ComposeIssueDialog
        open={composing}
        onClose={() => setComposing(false)}
        repo={home.repo}
        onCreated={reload}
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
  onCreated,
  addr,
}: {
  open: boolean
  onClose: () => void
  repo: RepoHome['repo']
  onCreated: () => void
  addr: RepoAddress
}): JSX.Element {
  const { sdk } = useSdk([repo.contractId])
  const { identity, signer } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cost = previewDocumentCreate('issue')

  const submit = async (): Promise<void> => {
    if (!identity || !signer) {
      openLogin()
      return
    }
    if (!sdk || title.trim() === '') return
    setPending(true)
    setError(null)
    try {
      await createIssue(sdk, signer, repo, { title: title.trim(), body })
      setTitle('')
      setBody('')
      onCreated()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Open an issue"
      description={`In ${addr.owner}/${addr.name}. Anyone can open one — no token needed.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={pending} disabled={title.trim() === ''}>
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
        </Field>
        <CostPreview cost={cost} />
        {error ? (
          <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger break-words">{error}</div>
        ) : null}
      </div>
    </Dialog>
  )
}
