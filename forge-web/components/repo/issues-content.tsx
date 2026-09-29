'use client'

/**
 * IssuesContent — the issue list (`platform-parity-spec.md` §1.2): Open / Closed tabs with exact
 * counts, filters for label, author, assignee and "mentions me", sort, a search box with
 * GitHub's qualifiers, pages of 50 past the first 100 issues, label chips and assignee avatars.
 * Everything the list shows is in the URL (D-913), so a reload or a shared link shows the same.
 *
 * Reads go through the issue index (`lib/repo/issue-index`): one composite for the first 100
 * issues, their comment counts and author names, the first feed and label pages; the rest of
 * the feed only when it is larger; keyset composites of 100 for later pages. State is the
 * FORGE_RULES fold of each issue's events. Composing an issue is an ungated author-owned write,
 * shown with its cost before signing.
 */

import { Byline } from '@/components/repo/byline'
import { useMirrorTrust } from '@/hooks/use-mirror-trust'
import { trustedOrigin } from '@/lib/repo/provenance'
import { useMemo, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { CheckCircle2, ChevronLeft, ChevronRight, CircleDot, MessageSquare, MessageSquarePlus, Pin, Search, X } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { ARCHIVED_REASON, resolveDpnsName } from '@/lib/view'
import {
  DEFAULT_ISSUE_QUERY,
  ISSUE_PAGE_SIZE,
  emptyIssuesBody,
  hasFilters,
  issueQueryParams,
  parseIssueQuery,
  parseSearchText,
  searchText,
  unresolvedQualifiers,
  withQuery,
  BODY_MAX,
  utf8Length,
  type IssueListQuery,
} from '@/lib/view/issue-query'
import { createIssue, issueFirsts, queryIssues, repoContractIds, repoKey, type IssueListPage, type IssueSelection, type LabelDef } from '@/lib/repo'
import { SupersededWriteError } from '@/lib/sdk'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { useRepoWriteGeneration } from '@/hooks/use-repo-chrome'
import { useIntent } from '@/hooks/use-intent'
import { useFirstWrite } from '@/hooks/use-first-write'
import { plural } from '@/lib/view'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/input'
import { CostPreview } from '@/components/ui/cost-preview'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { HiddenNote } from '@/components/repo/hidden-note'
import { MirrorComposeHint, MirrorNote } from '@/components/repo/mirror-note'
import { useRepoLinks } from '@/components/repo/target-href'
import { AssigneeAvatars, LabelChip, MarkdownEditor } from '@/components/repo/issue-bits'
import { IssueTemplatePicker } from '@/components/repo/issue-templates'
import { useRepoTotals } from '@/components/repo/use-repo-totals'
import { BodyCounter, SealedLimit, composeCost, privateComposeBlock } from '@/components/repo/private-compose'
import type { RepoAddress } from '@/hooks/use-query-param'
import { repoHref } from '@/hooks/use-query-param'
import { cn } from '@/lib/utils'
import type { IssueTemplate } from '@/lib/view/issue-templates'

export function IssuesContent({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  const { sdk, ready, network } = useSdk(repoContractIds(home.repo))
  const { identity } = useAuth()
  const [composing, setComposing] = useState(false)
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const generation = useRepoWriteGeneration(home.repo)
  const trust = useMirrorTrust(home.repo)
  const totals = useRepoTotals(home.repo)
  // A private repo's issues are sealed on write (`lib/repo/private-writes.ts`); only a member
  // holding the current key can open one, and non-members see no button (ux-dx-spec §9).
  const canCompose = privateComposeBlock(home) === null
  const archived = home.config?.archived === true

  // The list query lives in the URL: parse it on every render, write it with router.replace.
  const query = useMemo(() => parseIssueQuery(params), [params])
  const setQuery = (next: IssueListQuery): void => {
    const q = new URLSearchParams({ owner: addr.owner, name: addr.name })
    if (addr.repoId) q.set('repo', addr.repoId)
    for (const [k, v] of issueQueryParams(next)) q.append(k, v)
    router.replace(`${pathname}?${q.toString()}`, { scroll: false })
  }
  const change = (c: Partial<IssueListQuery>): void => setQuery(withQuery(query, c))

  // `me` needs a signed-in viewer; signed out, a `me` filter shows nothing rather than everything.
  const needsViewer = query.author === 'me' || query.assignee === 'me' || query.mentions
  const { data, loading, error, reload } = useAsync<IssueListPage>(
    async () => {
      const me = identity ?? ''
      const who = (v: string | null): string | null => (v === 'me' ? me : v)
      const selection: IssueSelection = {
        state: query.state,
        labels: query.labels,
        author: who(query.author),
        assignee: who(query.assignee),
        mentions: query.mentions ? { id: me, name: await resolveDpnsName(sdk!, me, network) } : null,
        sort: query.sort,
        text: query.q,
        page: query.page,
        pageSize: ISSUE_PAGE_SIZE,
      }
      return queryIssues(sdk!, home.repo, selection, totals, network)
    },
    [ready, repoKey(home.repo), generation, JSON.stringify(query), identity ?? '', totals ?? -1],
    { enabled: ready && sdk !== null && (!needsViewer || identity !== null) },
  )

  const labelDefs = useMemo(() => new Map((data?.labels ?? []).map((l) => [l.name, l])), [data])
  const [search, setSearch] = useState<string | null>(null)
  const searchValue = search ?? searchText(query)
  // Qualifiers typed (or linked in `?q=`) that could not be used: said, not silently dropped.
  const [dropped, setDropped] = useState<string[]>(() => unresolvedQualifiers(params.get('q') ?? ''))
  const submitSearch = (e: FormEvent): void => {
    e.preventDefault()
    setDropped(unresolvedQualifiers(searchValue))
    setQuery(parseSearchText(searchValue))
    setSearch(null)
  }

  const count = (n: number | null | undefined): string => (n == null ? '' : `${n} `)
  const empty = data !== null && data.rows.length === 0
  const filtered = hasFilters(query)

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <form onSubmit={submitSearch} className="flex min-w-[16rem] flex-1 items-center gap-2" role="search">
          <label htmlFor="issue-search" className="sr-only">Search issues</label>
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden />
            <Input id="issue-search" value={searchValue} onChange={(e) => setSearch(e.target.value)} className="pl-8 font-mono text-[13px]" placeholder="is:open label:bug author:@me" />
          </div>
        </form>
        {canCompose ? (
          <Button variant="primary" size="sm" onClick={() => setComposing(true)} disabled={archived} title={archived ? ARCHIVED_REASON : undefined}>
            <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden /> New issue
          </Button>
        ) : null}
      </div>
      {dropped.length > 0 ? (
        <p role="note" className="mb-3 text-[12px] text-caution-700 dark:text-caution-400" data-testid="issue-search-dropped">
          Not applied: {dropped.join(' ')}. Authors and assignees take an identity id or @me.
        </p>
      ) : null}

      <MirrorNote home={home} kind="issue" />

      {data && data.pinned.length > 0 ? (
        <ul aria-label="Pinned issues" className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3" data-testid="pinned-issues">
          {data.pinned.map((issue) => (
            <li key={issue.id} className="rounded-lg border border-anvil-200 px-3 py-2 dark:border-anvil-800" data-testid="pinned-issue" data-number={issue.number}>
              <p className="flex items-center gap-1 text-[11px] text-anvil-500 dark:text-anvil-400">
                <Pin className="h-3 w-3" aria-hidden /> Pinned · <span className="font-mono">#{issue.number}</span> · {issue.state.open ? 'open' : 'closed'}
              </p>
              <Link href={repoHref('/repo/issue', addr, { number: String(issue.number) })} className="hit-area line-clamp-2 text-dense font-medium text-anvil-900 hover:text-forge-700 dark:text-anvil-50 dark:hover:text-forge-400">
                {issue.title || '(untitled)'}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      {filtered ? (
        <button
          type="button"
          onClick={() => setQuery({ ...DEFAULT_ISSUE_QUERY, state: query.state })}
          className="mb-3 inline-flex items-center gap-1 text-dense text-anvil-500 dark:text-anvil-400 hover:text-forge-700 dark:hover:text-forge-400"
        >
          <X className="h-3.5 w-3.5" aria-hidden /> Clear filters
        </button>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-anvil-200 bg-anvil-50 px-4 py-2 dark:border-anvil-800 dark:bg-anvil-900">
          <div className="flex items-center gap-3" role="tablist" aria-label="Issue state">
            <StateTab active={query.state === 'open'} onClick={() => change({ state: 'open' })}>
              <CircleDot className="h-3.5 w-3.5" aria-hidden /> {count(data?.openCount)}Open
            </StateTab>
            <StateTab active={query.state === 'closed'} onClick={() => change({ state: 'closed' })}>
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> {count(data?.closedCount)}Closed
            </StateTab>
            <StateTab active={query.state === 'all'} onClick={() => change({ state: 'all' })}>
              All
            </StateTab>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <LabelFilter labels={data?.labels ?? []} selected={query.labels} onChange={(labels) => change({ labels })} />
            <PersonFilter
              label="Author"
              value={query.author}
              signedIn={identity !== null}
              onChange={(author) => change({ author })}
            />
            <PersonFilter
              label="Assignee"
              value={query.assignee}
              signedIn={identity !== null}
              allowNone
              onChange={(assignee) => change({ assignee })}
            />
            <label className="inline-flex items-center gap-1.5 text-dense text-anvil-600 dark:text-anvil-300 coarse:min-h-11 coarse:min-w-11">
              <input
                type="checkbox"
                checked={query.mentions}
                disabled={identity === null}
                onChange={(e) => change({ mentions: e.target.checked })}
                className="accent-forge-600"
              />
              Mentions me
            </label>
            <label className="sr-only" htmlFor="issue-sort">Sort</label>
            <select
              id="issue-sort"
              value={query.sort}
              onChange={(e) => change({ sort: e.target.value as IssueListQuery['sort'] })}
              className="rounded-md border border-anvil-300 bg-white px-2 py-1 text-dense dark:border-anvil-700 dark:bg-anvil-950 coarse:h-11"
            >
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="comments">Most commented</option>
            </select>
          </div>
        </div>

        {needsViewer && identity === null ? (
          <p className="px-4 py-6 text-dense text-anvil-500 dark:text-anvil-400">Sign in to filter by your own issues, assignments and mentions.</p>
        ) : loading && !data ? (
          <LoadingBlock label="Reading issues" />
        ) : error ? (
          <div className="p-4"><ErrorState message={error} onRetry={reload} /></div>
        ) : empty ? (
          <EmptyState
            icon={CircleDot}
            title={filtered ? 'No issues match' : query.state === 'closed' ? 'No closed issues' : query.state === 'all' ? 'No issues yet' : 'No open issues'}
            body={emptyIssuesBody(filtered, query.state, data?.closedCount ?? null)}
            action={filtered || !canCompose || archived ? undefined : <Button variant="primary" onClick={() => setComposing(true)}><MessageSquarePlus className="h-4 w-4" aria-hidden /> New issue</Button>}
          />
        ) : (
          <ul aria-label="Issues" aria-busy={loading}>
            {data?.rows.map((issue) => (
              <li key={issue.id} className="flex items-start gap-3 border-b border-anvil-100 px-4 py-3 last:border-b-0 hover:bg-anvil-50 dark:border-anvil-850 dark:hover:bg-anvil-900" data-testid="issue-row" data-number={issue.number}>
                {issue.state.open ? (
                  <><CircleDot className="mt-0.5 h-4 w-4 shrink-0 text-verify-700 dark:text-verify-400" aria-hidden /><span className="sr-only">Open</span></>
                ) : (
                  <><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-forge-500" aria-hidden /><span className="sr-only">Closed</span></>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Link href={repoHref('/repo/issue', addr, { number: String(issue.number) })} className="hit-area text-dense font-medium text-anvil-900 hover:text-forge-700 dark:hover:text-forge-400 dark:text-anvil-50">
                      {issue.title || '(untitled)'}
                    </Link>
                    {issue.state.labels.map((l) => (
                      <button key={l} type="button" onClick={() => change({ labels: query.labels.includes(l) ? query.labels : [...query.labels, l] })} aria-label={`Filter by label ${l}`} className="hit-area">
                        <LabelChip name={l} def={labelDefs.get(l)} />
                      </button>
                    ))}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-anvil-500 dark:text-anvil-400">
                    <span className="font-mono">#{issue.number}</span>
                    <Byline author={issue.author} createdAt={issue.createdAt} origin={trustedOrigin(issue.origin, issue.author, trust)} verb="opened" link={false} />
                    {!issue.stateComplete ? (
                      <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[11px] text-danger-700 dark:text-danger-400" title="This repository's event history could not be read completely, so the open/closed state, labels and assignees are unverified.">
                        state unverified
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3 pt-0.5">
                  <AssigneeAvatars ids={issue.state.assignees} />
                  {issue.comments ? (
                    <span className="inline-flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400" aria-label={plural(issue.comments, 'comment')}>
                      <MessageSquare className="h-3.5 w-3.5" aria-hidden /> {issue.comments}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {data?.searchedOf ? (
        <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">
          Searched the newest {data.searchedOf.searched}
          {data.searchedOf.total !== null ? ` of ${data.searchedOf.total}` : ''} issues; older ones were not read for this search.
        </p>
      ) : null}

      <Pager
        page={query.page}
        hasNext={data?.hasNext ?? false}
        pages={data?.matching != null ? Math.max(1, Math.ceil(data.matching / ISSUE_PAGE_SIZE)) : null}
        onPage={(page) => change({ page })}
      />

      <HiddenNote hidden={data?.hidden ?? 0} what={data?.hidden === 1 ? 'issue' : 'issues'} home={home} by={data?.hiddenBy} />

      <ComposeIssueDialog
        open={composing}
        onClose={() => setComposing(false)}
        home={home}
        onCreated={(n) => router.push(repoHref('/repo/issue', addr, { number: String(n), created: '1' }))}
        addr={addr}
      />
    </div>
  )
}

function StateTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap text-dense font-medium transition-colors coarse:min-h-11 coarse:min-w-11',
        active ? 'text-anvil-900 dark:text-anvil-50' : 'text-anvil-500 hover:text-anvil-800 dark:text-anvil-400 dark:hover:text-anvil-100',
      )}
    >
      {children}
    </button>
  )
}

/** Label filter: a multi-select of the repo's defined labels (every selected label must match). */
function LabelFilter({ labels, selected, onChange }: { labels: readonly LabelDef[]; selected: readonly string[]; onChange: (l: string[]) => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const names = [...new Set([...labels.filter((l) => !l.retired).map((l) => l.name), ...selected])]
  const byName = new Map(labels.map((l) => [l.name, l]))
  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((o) => !o)}
        className="rounded-md border border-anvil-300 px-2 py-1 text-dense dark:border-anvil-700 coarse:min-h-11 coarse:px-3"
      >
        Label{selected.length ? ` (${selected.length})` : ''}
      </button>
      {open ? (
        <div role="listbox" aria-label="Filter by label" aria-multiselectable className="absolute right-0 z-20 mt-1 max-h-72 w-60 overflow-auto rounded-md border border-anvil-200 bg-white p-1 shadow-lg dark:border-anvil-750 dark:bg-anvil-950">
          {names.length === 0 ? <p className="px-2 py-1.5 text-dense text-anvil-500 dark:text-anvil-400">No labels defined.</p> : null}
          {names.map((n) => {
            const on = selected.includes(n)
            return (
              <button
                key={n}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => onChange(on ? selected.filter((x) => x !== n) : [...selected, n])}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-dense hover:bg-anvil-100 dark:hover:bg-anvil-850 coarse:min-h-11"
              >
                <input type="checkbox" readOnly checked={on} tabIndex={-1} aria-hidden className="accent-forge-600" />
                <LabelChip name={n} def={byName.get(n)} />
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

/** Author / assignee filter: anyone, me, an identity id, or (assignee) nobody. */
function PersonFilter({
  label,
  value,
  signedIn,
  allowNone,
  onChange,
}: {
  label: string
  value: string | null
  signedIn: boolean
  allowNone?: boolean
  onChange: (v: string | null) => void
}): JSX.Element {
  const choice = value === null ? '' : value === 'me' || value === 'none' ? value : 'id'
  const [id, setId] = useState(choice === 'id' ? value ?? '' : '')
  const selectId = `filter-${label.toLowerCase()}`
  return (
    <span className="inline-flex items-center gap-1">
      <label htmlFor={selectId} className="text-dense text-anvil-600 dark:text-anvil-300">{label}</label>
      <select
        id={selectId}
        value={choice}
        onChange={(e) => {
          const v = e.target.value
          if (v === 'id') setId('')
          else onChange(v === '' ? null : v)
        }}
        className="rounded-md border border-anvil-300 bg-white px-2 py-1 text-dense dark:border-anvil-700 dark:bg-anvil-950 coarse:h-11"
      >
        <option value="">anyone</option>
        <option value="me" disabled={!signedIn}>me</option>
        {allowNone ? <option value="none">nobody</option> : null}
        <option value="id">identity id…</option>
      </select>
      {choice === 'id' || (choice === '' && id !== '') ? (
        <Input
          aria-label={`${label} identity id`}
          value={id}
          onChange={(e) => setId(e.target.value)}
          onBlur={() => onChange(id.trim() === '' ? null : id.trim())}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onChange(id.trim() === '' ? null : id.trim())
          }}
          className="h-7 w-44 py-0 font-mono text-[12px]"
          placeholder="base58 id"
        />
      ) : null}
    </span>
  )
}

function Pager({ page, hasNext, pages, onPage }: { page: number; hasNext: boolean; pages: number | null; onPage: (p: number) => void }): JSX.Element | null {
  if (page === 1 && !hasNext) return null
  return (
    <nav aria-label="Issue pages" className="mt-4 flex items-center justify-center gap-3 text-dense">
      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden /> Previous
      </Button>
      <span className="text-anvil-500 dark:text-anvil-400" data-testid="page-indicator">
        Page {page}
        {pages !== null ? ` of ${pages}` : ''}
      </span>
      <Button variant="outline" size="sm" disabled={!hasNext} onClick={() => onPage(page + 1)}>
        Next <ChevronRight className="h-3.5 w-3.5" aria-hidden />
      </Button>
    </nav>
  )
}

function ComposeIssueDialog({
  open,
  onClose,
  home,
  onCreated,
  addr,
}: {
  open: boolean
  onClose: () => void
  home: RepoHome
  onCreated: (number: number) => void
  addr: RepoAddress
}): JSX.Element {
  const repo = home.repo
  const { sdk } = useSdk(repoContractIds(repo))
  const { identity, signer, locked } = useAuth()
  const guard = useWriteGuard()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [template, setTemplate] = useState<IssueTemplate | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const draft = useIntent()
  const links = useRepoLinks(addr, home.description)

  // Whether this issue is the repo's (or the author's) first, for a tight preview (D-011).
  const first = useFirstWrite(() => issueFirsts(sdk!, repo, identity!), [open, repoKey(repo), identity ?? ''], open && sdk !== null && identity !== null)
  const cost = composeCost(repo, 'issue', { title: title.trim(), body }, first)
  const bodyBytes = utf8Length(body)

  const pick = (t: IssueTemplate | null): void => {
    setTemplate(t)
    if (t === null) return
    if (title.trim() === '') setTitle(t.title)
    if (body.trim() === '') setBody(t.body)
  }

  const submit = async (): Promise<void> => {
    if (pending || bodyBytes > BODY_MAX || !guard.check(cost, 'collab')) return
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
      setTemplate(null)
      draft.renew()
      onCreated(created.number)
      onClose()
    } catch (e) {
      if (e instanceof SupersededWriteError) {
        // The earlier version was posted: this draft is done (never post it a second time).
        setTitle('')
        setBody('')
        setTemplate(null)
        draft.renew()
        onClose()
        return
      }
      setError(guard.failed(e))
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
            disabled={title.trim() === '' || bodyBytes > BODY_MAX || guard.disabledReason !== null}
            title={guard.disabledReason ?? undefined}
          >
            {identity ? 'Submit issue' : locked ? 'Unlock to submit' : 'Sign in to submit'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {open ? <MirrorComposeHint home={home} /> : null}
        {open ? <IssueTemplatePicker home={home} selected={template} onPick={pick} /> : null}
        <Field label="Title" htmlFor="issue-title">
          <Input id="issue-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Something is broken…" autoFocus maxLength={256} />
        </Field>
        <MarkdownEditor
          id="issue-body"
          label="Description"
          value={body}
          onChange={setBody}
          placeholder="What happened, and how to reproduce it."
          links={links}
        />
        <SealedLimit repo={repo} kind="issue" text={title.trim() + body} />
        <BodyCounter repo={repo} text={body} field="description" />
        {template !== null && template.labels.length > 0 ? (
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
            This template suggests the labels {template.labels.join(', ')}. A maintainer or writer applies labels after the issue is opened.
          </p>
        ) : null}
        <CostPreview cost={cost} />
        {note ? <p className="text-dense text-caution-700 dark:text-caution-400">{note}</p> : null}
        {error ? (
          <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger-700 dark:text-danger-400 break-words">{error}</div>
        ) : null}
      </div>
    </Dialog>
  )
}
