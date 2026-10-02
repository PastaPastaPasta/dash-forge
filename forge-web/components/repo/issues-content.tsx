'use client'

/**
 * IssuesContent — the issue list (`platform-parity-spec.md` §1.2): Open / Closed tabs with exact
 * counts, filters for label, milestone, author, assignee and "mentions me", sort, a search box
 * with GitHub's qualifiers (`lib/view/issue-query`), pages of 50 past the first 100 issues, label
 * chips and assignee avatars.
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
import { useMemo, useRef, useState } from 'react'
import { HiddenThreadsToggle, useHiddenThreads } from '@/components/repo/moderation'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { CheckCircle2, CircleDot, CircleSlash, MessageSquarePlus, Pin, X } from 'lucide-react'
import { readCloseReasons } from '@/lib/repo/transitions'
import { closedSkipped } from '@/lib/view/close-reason'
import type { RepoHome } from '@/lib/view'
import { ARCHIVED_REASON, resolveDpnsName } from '@/lib/view'
import {
  ISSUE_PAGE_SIZE,
  droppedQualifiersReason,
  emptyIssuesBody,
  hasFilters,
  issueQueryParams,
  parseIssueQuery,
  parseSearchText,
  pastLastPage,
  searchSubmitBase,
  searchText,
  unresolvedQualifiers,
  BODY_MAX,
  utf8Length,
  type IssueListQuery,
} from '@/lib/view/issue-query'
import { createIssue, issueFirsts, queryIssues, repoContractIds, repoKey, rowFiltersOf, type IssueListPage, type IssueSelection } from '@/lib/repo'
import { SupersededWriteError } from '@/lib/sdk'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { useRepoWriteGeneration } from '@/hooks/use-repo-chrome'
import { useIntent } from '@/hooks/use-intent'
import { useFirstWrite } from '@/hooks/use-first-write'
import { useSdk } from '@/hooks/use-sdk'
import { useDpnsName } from '@/hooks/use-dpns-name'
import { ownerLabel } from '@/lib/page-title'
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
import { AssigneeAvatars, MarkdownEditor } from '@/components/repo/issue-bits'
import {
  AuthorLoginNote,
  CommentCount,
  DroppedNote,
  FilterBar,
  filterCount,
  LabelChipFilter,
  LabelFilter,
  MilestoneFilter,
  Pager,
  PastLastPage,
  PersonFilter,
  RowLink,
  SearchBox,
  SearchedNote,
  SortSelect,
  StateTab,
  StateTabs,
  budgetEmptyTitle,
  readingLabel,
  tabCount,
  useAutoReadOn,
  useListQuery,
  useReadProgress,
  type ListGrammar,
} from '@/components/repo/list-controls'
import { IssueTemplatePicker } from '@/components/repo/issue-templates'
import { useRepoTotals } from '@/components/repo/use-repo-totals'
import { useMilestones } from '@/components/repo/use-milestones'
import { TriageNav } from '@/components/repo/triage-nav'
import { BodyCounter, SealedLimit, composeCost, privateComposeBlock } from '@/components/repo/private-compose'
import type { RepoAddress } from '@/hooks/use-query-param'
import { repoHref, useParam, withTrailingSlash } from '@/hooks/use-query-param'
import type { IssueTemplate } from '@/lib/view/issue-templates'
import { whoCan } from '@/lib/rules/roles'

/** The Issues list's search grammar (`lib/view/issue-query`). */
const ISSUE_GRAMMAR: ListGrammar<IssueListQuery> = { text: searchText, parse: parseSearchText, unresolved: unresolvedQualifiers, submitBase: searchSubmitBase }

export function IssuesContent({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  const { sdk, ready, network } = useSdk(repoContractIds(home.repo))
  const { identity } = useAuth()
  const router = useRouter()
  // The composer has a URL, as GitHub's /issues/new (QW3-063): `?new=1` opens it, prefilled from
  // `title` and `body` as GitHub's are; opening and closing it change the URL.
  const composing = useParam('new') === '1'
  const prefill = { title: useParam('title'), body: useParam('body') }
  const searchParams = useSearchParams()
  // Set once a created issue opens: the composer's close must not replace that navigation.
  const leaving = useRef(false)
  const setComposing = (open: boolean): void => {
    if (leaving.current) return
    const q = new URLSearchParams(searchParams.toString())
    if (open) q.set('new', '1')
    else for (const k of ['new', 'title', 'body']) q.delete(k)
    const href = `${withTrailingSlash('/repo/issues')}?${q.toString()}`
    if (open) router.push(href, { scroll: false })
    else router.replace(href, { scroll: false })
  }
  const generation = useRepoWriteGeneration(home.repo)
  const trust = useMirrorTrust(home.repo)
  const totals = useRepoTotals(home.repo)
  const milestones = useMilestones(home.repo)
  // A private repo's issues are sealed on write (`lib/repo/private-writes.ts`); only a member
  // holding the current key can open one, and non-members see no button (ux-dx-spec §9).
  const canCompose = privateComposeBlock(home) === null
  const archived = home.config?.archived === true

  // The list query lives in the URL (a reload or a shared link shows the same list).
  const { query, search } = useListQuery({ addr, parse: parseIssueQuery, toParams: issueQueryParams, grammar: ISSUE_GRAMMAR, sdk, ready, network })
  const change = search.change

  // `me` needs a signed-in viewer; signed out, a `me` filter shows nothing rather than everything.
  const needsViewer = query.author === 'me' || query.assignee === 'me' || query.mentions
  // `author:<login>` matches only what a trusted mirror signed: until the trust set is read, every
  // row would fail it (an empty list, after walking every chunk), so the read waits for it.
  const awaitingTrust = query.authorLogin !== null && trust === null
  // How many issues a walk (a search, or "look through older") has read so far, while it reads.
  const { progress, track } = useReadProgress()
  // Pinned issues on a repo whose member-event feed is long are read when asked (QW3-003).
  const [pinsAsked, setPinsAsked] = useState(false)
  // Read by the list's read itself: asking re-reads with the list kept on screen, not reset.
  const pinsAskedRef = useRef(false)
  const { data, loading, error, reload } = useAsync<IssueListPage>(
    async (signal) => {
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
        ...rowFiltersOf(query, trust),
      }
      return track(signal, (options) => queryIssues(sdk!, home.repo, selection, totals, network, { ...options, pins: pinsAskedRef.current }))
    },
    // Not `totals`: it arrives while page 1 reads, and the same query again reads on a load (a sort
    // or search would read two loads cold). The page's own proved count fills in for it.
    [ready, repoKey(home.repo), generation, JSON.stringify(query), identity ?? '', query.authorLogin !== null && trust !== null ? [...trust].sort().join(',') : null],
    { enabled: ready && sdk !== null && (!needsViewer || identity !== null) && !awaitingTrust },
  )

  // A sparse tab finding its older rows through the state scan reads on by itself (QW3-002).
  useAutoReadOn(data?.searchedOf, loading, reload)

  const labelDefs = useMemo(() => new Map((data?.labels ?? []).map((l) => [l.name, l])), [data])
  // Why each closed row was closed (QW-069): the grey "not planned" icon. One read of their
  // transitions; until it lands (or on a page of more than 100 closed rows) the plain icon shows.
  const closedRows = (data?.rows ?? []).filter((r) => !r.state.open).map((r) => ({ id: r.id, number: r.number }))
  const closedKey = closedRows.map((r) => r.id).join(',')
  const reasons = useAsync(() => readCloseReasons(sdk!, home.repo, closedRows), [ready, repoKey(home.repo), closedKey], {
    enabled: ready && sdk !== null && closedRows.length > 0,
  })
  // RC2 MOD: issues a maintainer hid are left out of the list behind a toggle (counts stay as proved).
  const [showHidden, setShowHidden] = useState(false)
  const hiddenIds = useHiddenThreads(sdk, ready, home.repo, network, data?.rows)
  const rows = (data?.rows ?? []).filter((r) => showHidden || !hiddenIds.has(r.id))
  const hiddenOnPage = (data?.rows ?? []).filter((r) => hiddenIds.has(r.id)).length
  const empty = data !== null && data.rows.length === 0
  const filtered = hasFilters(query)
  const lastPage = empty ? pastLastPage(query.page, data?.matching ?? null, ISSUE_PAGE_SIZE) : null

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <SearchBox id="issue-search" label="Search issues" search={search} placeholder="is:open label:bug author:@me" />
        <TriageNav addr={addr} />
        {canCompose ? (
          <Button variant="primary" size="sm" onClick={() => setComposing(true)} disabled={archived} title={archived ? ARCHIVED_REASON : undefined}>
            <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden /> New issue
          </Button>
        ) : null}
      </div>
      <DroppedNote search={search} reason={droppedQualifiersReason(search.dropped, search.notFound)} testId="issue-search-dropped" />
      <AuthorLoginNote login={query.authorLogin} notFound={search.notFound} />

      <MirrorNote home={home} kind="issue" />

      {data && data.pinsUnread && query.page === 1 ? (
        <p className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="pins-unread">
          <Pin className="h-3.5 w-3.5" aria-hidden />
          <span>
            {!pinsAsked
              ? "This repository's activity log is long, so pinned issues are not checked on every load."
              : loading
                ? 'Checking for pinned issues…'
                : "This repository's activity log is too long to find its pinned issues."}
          </span>
          {pinsAsked ? null : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                pinsAskedRef.current = true
                setPinsAsked(true)
                reload()
              }}
            >
              Check for pinned issues
            </Button>
          )}
        </p>
      ) : null}

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
          onClick={search.clear}
          className="mb-3 inline-flex items-center gap-1 text-dense text-anvil-500 dark:text-anvil-400 hover:text-forge-700 dark:hover:text-forge-400"
        >
          <X className="h-3.5 w-3.5" aria-hidden /> Clear filters
        </button>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-anvil-200 bg-anvil-50 px-4 py-2 dark:border-anvil-800 dark:bg-anvil-900">
          <StateTabs label="Issue state">
            <StateTab active={query.state === 'open'} onClick={() => change({ state: 'open' })}>
              <CircleDot className="h-3.5 w-3.5" aria-hidden /> {tabCount(data?.openCount)}Open
            </StateTab>
            <StateTab active={query.state === 'closed'} onClick={() => change({ state: 'closed' })}>
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> {tabCount(data?.closedCount)}Closed
            </StateTab>
            <StateTab active={query.state === 'all'} onClick={() => change({ state: 'all' })}>
              All
            </StateTab>
          </StateTabs>
          <FilterBar active={filterCount(query) + (query.mentions ? 1 : 0)}>
            <LabelFilter labels={data?.labels ?? []} selected={query.labels} onChange={(labels) => change({ labels })} />
            <MilestoneFilter milestones={milestones.data} value={query.milestone} none={query.noMilestone} onChange={(c) => change(c)} />
            <PersonFilter
              label="Author"
              value={query.author}
              signedIn={identity !== null}
              onChange={(author) => change({ author, authorLogin: null })}
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
            <SortSelect id="issue-sort" value={query.sort} onChange={(sort) => change({ sort })} />
          </FilterBar>
        </div>

        {needsViewer && identity === null ? (
          <p className="px-4 py-6 text-dense text-anvil-500 dark:text-anvil-400">Sign in to filter by your own issues, assignments and mentions.</p>
        ) : ((loading || awaitingTrust) && !data) || (empty && data?.searchedOf?.auto) ? (
          <LoadingBlock label={readingLabel('issues', progress ?? data?.searchedOf?.searched ?? null, totals)} />
        ) : error ? (
          <div className="p-4"><ErrorState message={error} onRetry={reload} /></div>
        ) : lastPage !== null ? (
          <PastLastPage page={query.page} last={lastPage} onPage={(page) => change({ page })} />
        ) : empty && data?.searchedOf?.more ? (
          // The page stopped at its read budget before reaching any: there are older ones to read.
          <EmptyState icon={CircleDot} title={budgetEmptyTitle(query.page, data.searchedOf.searched, 'issues', query.sort === 'oldest')} body={query.sort === 'oldest' ? 'Newer ones are not read yet.' : 'Older ones are not read yet.'} />
        ) : empty ? (
          <EmptyState
            icon={CircleDot}
            title={filtered ? 'No issues match' : query.state === 'closed' ? 'No closed issues' : query.state === 'all' ? 'No issues yet' : 'No open issues'}
            body={emptyIssuesBody(filtered, query.state, data?.closedCount ?? null, data?.openCount ?? null)}
            action={
              filtered ? (
                query.state === 'all' ? undefined : <Button onClick={() => change({ state: 'all' })} data-testid="issues-search-all">Search all issues</Button>
              ) : !canCompose || archived ? undefined : (
                <Button variant="primary" onClick={() => setComposing(true)}><MessageSquarePlus className="h-4 w-4" aria-hidden /> New issue</Button>
              )
            }
          />
        ) : (
          <>
          <HiddenThreadsToggle count={hiddenOnPage} shown={showHidden} onToggle={() => setShowHidden((s) => !s)} noun="issue" />
          <ul aria-label="Issues" aria-busy={loading}>
            {rows.map((issue) => (
              <li key={issue.id} className="flex items-start gap-3 border-b border-anvil-100 px-4 py-3 last:border-b-0 hover:bg-anvil-50 dark:border-anvil-850 dark:hover:bg-anvil-900" data-testid="issue-row" data-number={issue.number}>
                {issue.state.open ? (
                  <><CircleDot className="mt-0.5 h-4 w-4 shrink-0 text-verify-700 dark:text-verify-400" aria-hidden /><span className="sr-only">Open</span></>
                ) : closedSkipped(reasons.data?.get(issue.id)) ? (
                  <><CircleSlash className="mt-0.5 h-4 w-4 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden data-icon="closed-skipped" /><span className="sr-only">{reasons.data?.get(issue.id)?.reason === 'duplicate' ? 'Closed as a duplicate' : 'Closed as not planned'}</span></>
                ) : (
                  <><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-forge-500" aria-hidden /><span className="sr-only">Closed</span></>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <RowLink href={repoHref('/repo/issue', addr, { number: String(issue.number) })} title={issue.title} />
                    {issue.state.labels.map((l) => (
                      <LabelChipFilter key={l} name={l} def={labelDefs.get(l)} selected={query.labels} onChange={(labels) => change({ labels })} />
                    ))}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-anvil-500 dark:text-anvil-400">
                    <span className="font-mono">#{issue.number}</span>
                    <Byline author={issue.author} createdAt={issue.createdAt} origin={trustedOrigin(issue.origin, issue.author, trust)} verb="opened" link={false} />
                    {!issue.stateComplete ? (
                      <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[11px] text-danger-700 dark:text-danger-400" title="This issue's events could not be read completely, so its labels and assignees are unverified. Open or closed is proved.">
                        labels unverified
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3 pt-0.5">
                  <AssigneeAvatars ids={issue.state.assignees} />
                  <CommentCount n={issue.comments} />
                </div>
              </li>
            ))}
          </ul>
          </>
        )}
      </div>

      <SearchedNote searchedOf={data?.searchedOf} noun="issues" onMore={reload} oldest={query.sort === 'oldest'} reading={loading ? progress ?? data?.searchedOf?.searched ?? 0 : null} />

      <Pager label="Issue pages" page={query.page} hasNext={data?.hasNext ?? false} matching={data?.matching ?? null} pageSize={ISSUE_PAGE_SIZE} onPage={(page) => change({ page })} />

      <HiddenNote hidden={data?.hidden ?? 0} what={data?.hidden === 1 ? 'issue' : 'issues'} home={home} by={data?.hiddenBy} />

      <ComposeIssueDialog
        // A new prefill (another /issues/new?title=… link) starts the form afresh.
        key={`${prefill.title}\0${prefill.body}`}
        open={composing && canCompose && !archived}
        prefill={prefill}
        onClose={() => setComposing(false)}
        home={home}
        onCreated={(n) => {
          leaving.current = true
          // In place of the composer's entry: Back does not reopen it, prefilled, for a duplicate.
          router.replace(repoHref('/repo/issue', addr, { number: String(n), created: '1' }))
        }}
        addr={addr}
      />
    </div>
  )
}

function ComposeIssueDialog({
  open,
  prefill,
  onClose,
  home,
  onCreated,
  addr,
}: {
  open: boolean
  /** A title and body the URL gave (`?title=&body=`, as GitHub's /issues/new takes). */
  prefill: { readonly title: string; readonly body: string }
  onClose: () => void
  home: RepoHome
  onCreated: (number: number) => void
  addr: RepoAddress
}): JSX.Element {
  const repo = home.repo
  const { sdk } = useSdk(repoContractIds(repo))
  const { identity, signer, locked } = useAuth()
  const guard = useWriteGuard()
  const [title, setTitle] = useState(prefill.title)
  const [body, setBody] = useState(prefill.body)
  const [template, setTemplate] = useState<IssueTemplate | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const draft = useIntent()
  const links = useRepoLinks(addr, home.description)
  // The owner by name, not a raw identity id (L-73).
  const ownerName = useDpnsName(repo.ownerId)

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
    if (pending || bodyBytes > BODY_MAX || !guard.check(cost, 'collab', 'open an issue')) return
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
      description={`In ${ownerLabel(addr.owner, ownerName)}/${addr.name}. Anyone can open one.`}
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
            This template suggests the labels {template.labels.join(', ')}. Labels are applied after the issue is opened, by {whoCan('canLabel', 'one')}.
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
