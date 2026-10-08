'use client'

/**
 * Settings → Environments (DESIGN §4.5, §10; `docs/guides/environments.md`): a repo's
 * environments as this viewer can read them, read-only. Changes are made with `dg env`.
 *
 * - Only environments this viewer can open are named. The rest are counted ("2 environments",
 *   "1 more environment you can't read"), never named; a viewer who isn't a maintainer is told
 *   one hasn't been shared with them. A maintainer also sees who each environment misses.
 * - Each card names its audience and the people it was last saved to; one saved in the old
 *   format says so, with the `dg` step to take.
 * - Values are masked until asked for, one at a time. A shown value lives in this page's memory
 *   only: never logged, never stored, and gone when the page is left.
 * - A conflict lists every version and how to keep one with `dg`; a change by someone who isn't
 *   a maintainer now is ignored, with one warning naming it (D24).
 *
 * {@link EnvironmentsRemoval} is the member-removal hook: what a removed member could read.
 */

import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import Link from 'next/link'
import { AlertTriangle, ChevronLeft, Eye, EyeOff, KeyRound, Lock, Users } from 'lucide-react'

import type { RepoHome } from '@/lib/view'
import { ACCESS_SENTENCE } from '@/lib/env'
import { shortHead, type Head } from '@/lib/env/loader'
import {
  environmentsView,
  exposureLine,
  hiddenLine,
  ignoredLine,
  ignoredWarning,
  keptAccessLine,
  NOT_SHARED_TEXT,
  removalView,
  resaveCommand,
  staleLine,
  unreadableLine,
  utc,
  type EntryView,
  type EnvCardView,
  type EnvPageView,
  type RemovalView,
  type StaleItem,
} from '@/lib/env/view'
import { useEnvironments, useRepoPeople } from '@/hooks/use-environments'
import { useDpnsName } from '@/hooks/use-dpns-name'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { Author } from '@/components/author'
import { Button } from '@/components/ui/button'
import { ErrorState, LoadingBlock } from '@/components/ui/states'
import { PrivateRepoState } from '@/components/repo/private-repo-state'
import { UNLOCK_MEMBERS_ONLY, UnlockMore } from '@/components/auth/unlock-more'
import { shortId } from '@/lib/utils'

/** The empty state (DESIGN §10). */
export const EMPTY_TEXT =
  "No environments yet. Secrets stored here are encrypted for the people you choose and injected with `dg env run`. They're never committed to git."

/** Always the same width, so the mask does not give away a value's length. */
const MASK = '•'.repeat(16)

export function EnvironmentsContent({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  // A private repo's environments are its members' (as its settings are): anyone else sees what
  // every other tab shows them.
  const access = home.private?.access ?? 'outsider'
  if (home.repo.visibility === 'private' && (access === 'signed-out' || access === 'outsider')) {
    return <PrivateRepoState repo={home.repo} addr={addr} access={access} />
  }
  return <Environments home={home} addr={addr} />
}

function Environments({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  const { state, locked, viewer } = useEnvironments(home)
  const book = state.data?.book ?? null
  // A maintainer's precise list of who an environment misses needs the repo's people.
  const people = useRepoPeople(home, viewer !== null && book?.maintainers.has(viewer) === true)
  // A locked tab opens nothing, so it is told to unlock rather than that nothing was shared.
  const view = book === null ? null : environmentsView(book, { viewer: locked ? null : viewer, people })
  return (
    <div className="max-w-3xl space-y-5" data-testid="environments">
      <Link
        href={repoHref('/repo/settings', addr)}
        className="hit-area inline-flex items-center gap-1 text-dense text-anvil-600 hover:text-anvil-900 dark:text-anvil-300 dark:hover:text-anvil-50"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden /> Settings
      </Link>
      <div>
        <h2 id="environments-title" className="flex items-center gap-2 text-prose">
          <KeyRound className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden /> Environments
        </h2>
        <p className="mt-1 text-dense text-anvil-600 dark:text-anvil-300">
          Edit with dg: <code className="font-mono text-[12px]">dg env set NAME --env production</code>
        </p>
      </div>
      {locked ? <UnlockMore title={UNLOCK_MEMBERS_ONLY} testId="environments-unlock" /> : null}
      {state.error !== null ? (
        <ErrorState message={state.error} cause={state.cause} onRetry={state.reload} />
      ) : view === null ? (
        <LoadingBlock label="Reading environments" />
      ) : (
        // A lock, an unlock or another repo resets the read, which unmounts this and every value shown.
        <EnvironmentsView view={view} onRetry={state.reload} />
      )}
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="env-access-sentence">
        {ACCESS_SENTENCE}
      </p>
    </div>
  )
}

/** The list itself, from a {@link EnvPageView} (pure props: the component tests render it). */
export function EnvironmentsView({ view, onRetry }: { view: EnvPageView; onRetry?: () => void }): JSX.Element {
  // `env|version|name` of the one value shown now (showing another hides it). Page state only:
  // leaving the page clears it.
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set())
  const toggle = (k: string): void => setShown((s) => (s.has(k) ? new Set() : new Set([k])))
  // A page kept for Back (the back/forward cache) or a hidden tab shows nothing it showed: hidden
  // synchronously, before the browser snapshots the page.
  useEffect(() => {
    const hide = (): void => flushSync(() => setShown(new Set()))
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') hide()
    }
    window.addEventListener('pagehide', hide)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', hide)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])
  if (view.empty) {
    return (
      <div className="rounded-lg border border-dashed border-anvil-300 px-4 py-8 text-center text-dense text-anvil-600 dark:border-anvil-700 dark:text-anvil-300" data-testid="env-empty">
        <EmptyText />
      </div>
    )
  }
  return (
    <div className="space-y-4">
      {view.cards.map((card) => (
        <EnvCard key={card.env} card={card} shown={shown} toggle={toggle} onRetry={onRetry} />
      ))}
      {view.hidden > 0 ? (
        <p className="flex items-center gap-2 text-dense text-anvil-600 dark:text-anvil-300" data-testid="env-hidden">
          <Lock className="h-3.5 w-3.5 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
          {hiddenLine(view.hidden, view.cards.length)}
        </p>
      ) : null}
      {view.notShared ? (
        <p role="note" className="text-dense text-anvil-600 dark:text-anvil-300" data-testid="env-not-shared">
          {NOT_SHARED_TEXT}
        </p>
      ) : null}
      {view.ignored > 0 ? (
        <p className="text-dense text-anvil-600 dark:text-anvil-300" data-testid="env-ignored-count">
          {ignoredLine(view.ignored)}
        </p>
      ) : null}
    </div>
  )
}

/** {@link EMPTY_TEXT} with its command as code. */
function EmptyText(): JSX.Element {
  const [before, cmd, after] = EMPTY_TEXT.split('`') as [string, string, string]
  return (
    <p>
      {before}
      <code className="font-mono text-[12px]">{cmd}</code>
      {after}
    </p>
  )
}

function EnvCard({ card, shown, toggle, onRetry }: { card: EnvCardView; shown: ReadonlySet<string>; toggle: (k: string) => void; onRetry?: () => void }): JSX.Element {
  const titleId = `env-${card.env}-title`
  return (
    <section aria-labelledby={titleId} className="rounded-lg border border-anvil-200 dark:border-anvil-800" data-testid="env-card">
      <header className="flex flex-wrap items-center gap-2 border-b border-anvil-100 px-4 py-2.5 dark:border-anvil-850">
        <h3 id={titleId} className="min-w-0 break-all font-mono text-dense font-semibold">
          {card.env}
        </h3>
        {card.audienceLabel !== null ? <AudienceChip label={card.audienceLabel} everyone={card.membersKey} /> : null}
      </header>
      <div className="space-y-3 px-4 py-3">
        {card.audience !== null ? <WhoCanRead card={card} /> : null}
        {card.oldFormat !== null ? <OldFormatNote env={card.env} old={card.oldFormat} /> : null}
        {card.stale.length > 0 ? <StaleList env={card.env} items={card.stale} /> : null}
        {card.ignored !== null ? <IgnoredNote env={card.env} ignored={card.ignored} /> : null}
        {card.kind === 'current' ? (
          <>
            <Entries entries={card.entries} prefix={`${card.env}|${card.updated?.id ?? ''}`} shown={shown} toggle={toggle} />
            {card.updated !== null ? <Updated head={card.updated} savedFor={card.savedFor} /> : null}
          </>
        ) : card.kind === 'conflict' && card.conflict !== null ? (
          <Conflict env={card.env} conflict={card.conflict} shown={shown} toggle={toggle} />
        ) : card.unreadable !== null ? (
          <div role="note" className="space-y-1 text-dense text-anvil-700 dark:text-anvil-200" data-testid="env-unreadable">
            <p>
              The latest change to {card.env} can&apos;t be read here{card.unreadable.reason === '' ? '.' : `: ${card.unreadable.reason}.`}
            </p>
            <Updated head={card.unreadable.head} savedFor={null} />
            {card.unreadable.unfetched && onRetry ? (
              <Button size="sm" variant="outline" onClick={onRetry}>
                Try again
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}

function AudienceChip({ label, everyone }: { label: string; everyone: boolean }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-anvil-200 px-2 py-0.5 text-[12px] text-anvil-700 dark:border-anvil-700 dark:text-anvil-200" data-testid="env-audience">
      {everyone ? <Users className="h-3 w-3" aria-hidden /> : <Lock className="h-3 w-3" aria-hidden />}
      {label}
    </span>
  )
}

function WhoCanRead({ card }: { card: EnvCardView }): JSX.Element {
  return (
    <div className="text-dense">
      <p className="text-anvil-600 dark:text-anvil-300">Who can read this</p>
      {card.membersKey ? (
        <p className="mt-1" data-testid="env-readers">
          Every member of this repo
        </p>
      ) : (
        <p className="mt-1 flex flex-wrap items-center gap-1.5" data-testid="env-readers">
          {card.readers.map((id) => (
            <Author key={id} identityId={id} link={false} />
          ))}
          <span className="text-[12px] text-anvil-500 dark:text-anvil-400">(when last saved)</span>
        </p>
      )}
    </div>
  )
}

/** The old-format banner (DESIGN §10): what is readable by anyone who joins later, and the `dg` step. */
function OldFormatNote({ env, old }: { env: string; old: NonNullable<EnvCardView['oldFormat']> }): JSX.Element {
  return (
    <div role="note" className="space-y-1 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense text-anvil-700 dark:text-anvil-200" data-testid="env-old-format" data-env={env}>
      <p className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-caution-700 dark:text-caution-400" aria-hidden />
        <span className="min-w-0 break-words">{old.sentence}</span>
      </p>
      {old.unmarked.length > 0 ? (
        <p className="break-words pl-6" data-testid="env-old-format-unmarked">
          Not marked yet: {old.unmarked.join(', ')}
        </p>
      ) : null}
      <p className="pl-6">
        <code className="break-words font-mono text-[12px]">{old.command}</code>
      </p>
    </div>
  )
}

/** A maintainer's precise list (DESIGN §10): who an environment's latest save misses or still includes. */
function StaleList({ env, items }: { env: string; items: readonly StaleItem[] }): JSX.Element {
  return (
    <div role="note" className="space-y-1 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense text-anvil-700 dark:text-anvil-200" data-testid="env-stale">
      {items.map((item) => (
        <StaleLineText key={`${item.kind}:${item.who}`} env={env} item={item} />
      ))}
      <p>
        Save it again: <code className="break-words font-mono text-[12px]">{resaveCommand(env)}</code>
      </p>
    </div>
  )
}

function StaleLineText({ env, item }: { env: string; item: StaleItem }): JSX.Element {
  const name = useIdentityText(item.who)
  return (
    <p className="break-words" data-testid="env-stale-line">
      {staleLine(env, item, name)}
    </p>
  )
}

/** One entry's value: masked until asked for. */
function Entries({ entries, prefix, shown, toggle }: { entries: readonly EntryView[]; prefix: string; shown: ReadonlySet<string>; toggle: (k: string) => void }): JSX.Element {
  if (entries.length === 0) return <p className="text-dense text-anvil-600 dark:text-anvil-300">No entries.</p>
  return (
    <ul className="divide-y divide-anvil-100 rounded-md border border-anvil-100 dark:divide-anvil-850 dark:border-anvil-850" data-testid="env-entries">
      {entries.map((e) => {
        const k = `${prefix}|${e.name}`
        const open = shown.has(k)
        return (
          <li key={e.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" data-testid="env-entry">
            <span className="min-w-0 break-all font-mono text-[12px] font-semibold">{e.name}</span>
            <span className="rounded bg-anvil-100 px-1.5 text-[11px] text-anvil-700 dark:bg-anvil-800 dark:text-anvil-200">{e.type === 'secret' ? 'secret' : 'variable'}</span>
            <span className="ml-auto flex min-w-0 max-w-full items-center gap-1">
              <code className="min-w-0 break-all font-mono text-[12px] text-anvil-800 dark:text-anvil-100" data-testid="env-value">
                {open ? (
                  e.value
                ) : (
                  <>
                    <span aria-hidden>{MASK}</span>
                    <span className="sr-only">hidden</span>
                  </>
                )}
              </code>
              <Button variant="ghost" size="icon" aria-label={`Show ${e.name}`} aria-pressed={open} onClick={() => toggle(k)}>
                {open ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
              </Button>
            </span>
            {e.note !== '' ? <span className="w-full text-[12px] text-anvil-600 dark:text-anvil-300">{e.note}</span> : null}
          </li>
        )
      })}
    </ul>
  )
}

function Updated({ head, savedFor }: { head: Head; savedFor: string | null }): JSX.Element {
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-anvil-600 dark:text-anvil-300" data-testid="env-updated">
      Updated by <Author identityId={head.author} link={false} /> at {utc(head.createdAt)}
      {savedFor !== null ? (
        <>
          , saved again for <Author identityId={savedFor} link={false} />
        </>
      ) : null}
    </p>
  )
}

/** How the page names an identity in a sentence: its DPNS name, else a short id. */
function useIdentityText(id: string): string {
  return useDpnsName(id) ?? shortId(id)
}

function IgnoredNote({ env, ignored }: { env: string; ignored: NonNullable<EnvCardView['ignored']> }): JSX.Element {
  const author = useIdentityText(ignored.head.author)
  return (
    <p role="note" className="flex items-start gap-2 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense text-anvil-700 dark:text-anvil-200" data-testid="env-ignored">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-caution-700 dark:text-caution-400" aria-hidden />
      <span className="min-w-0 break-words">{ignoredWarning(env, ignored, author)}</span>
    </p>
  )
}

function Conflict({
  env,
  conflict,
  shown,
  toggle,
}: {
  env: string
  conflict: NonNullable<EnvCardView['conflict']>
  shown: ReadonlySet<string>
  toggle: (k: string) => void
}): JSX.Element {
  return (
    <div className="space-y-3" data-testid="env-conflict">
      <p role="note" className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-anvil-700 dark:text-anvil-200">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger-700 dark:text-danger-400" aria-hidden />
        <span>{conflict.headline}, so its values can&apos;t be used until a maintainer keeps one.</span>
      </p>
      <ol className="space-y-3">
        {conflict.versions.map((v) => (
          <li key={v.head.id} className="space-y-1.5" data-testid="env-version">
            <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-anvil-600 dark:text-anvil-300">
              Version <code className="font-mono">{shortHead(v.head)}</code> by <Author identityId={v.head.author} link={false} /> at {utc(v.head.createdAt)}
            </p>
            {v.entries === null ? (
              <p className="text-dense text-anvil-600 dark:text-anvil-300">You can&apos;t read this version here.</p>
            ) : (
              <Entries entries={v.entries} prefix={`${env}|${v.head.id}`} shown={shown} toggle={toggle} />
            )}
          </li>
        ))}
      </ol>
      <p className="text-dense text-anvil-700 dark:text-anvil-200">
        Compare them with <code className="font-mono text-[12px]">dg env history --env {env}</code>, then a maintainer keeps one:{' '}
        <code className="break-words font-mono text-[12px]">dg env edit --env {env} --keep &lt;id&gt;</code>
      </p>
    </div>
  )
}

/**
 * The member-removal hook (DESIGN §10, `dg collab remove`'s checklist): the environments and
 * current value names `member` could read, to change where they're used. Reads only while shown.
 */
export function EnvironmentsRemoval({
  home,
  member,
  heldMembersKey,
  staysMaintainer = false,
}: {
  home: RepoHome
  member: string
  heldMembersKey: boolean
  /** They keep a maintainer role (only another role goes): nothing to change, they still read them. */
  staysMaintainer?: boolean
}): JSX.Element | null {
  const { state } = useEnvironments(home)
  const name = useIdentityText(member)
  if (state.error !== null) {
    return <p className="text-[12px] text-caution-700 dark:text-caution-400">Couldn&apos;t list the environments {name} could read: {state.error}</p>
  }
  if (state.data === null) return <p className="text-[12px] text-anvil-500 dark:text-anvil-400">Checking which environments {name} could read…</p>
  return <RemovalLines view={removalView(state.data.book, member, heldMembersKey)} name={name} staysMaintainer={staysMaintainer} />
}

/** The checklist's lines (pure props: the component tests render it). */
export function RemovalLines({ view, name, staysMaintainer = false }: { view: RemovalView; name: string; staysMaintainer?: boolean }): JSX.Element | null {
  if (view.exposures.length === 0 && view.unreadable === 0) return null
  if (staysMaintainer) {
    return (
      <p className="text-dense text-anvil-700 dark:text-anvil-200" data-testid="env-removal-kept">
        {keptAccessLine(name)}
      </p>
    )
  }
  return (
    <div className="space-y-1 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense text-anvil-700 dark:text-anvil-200" data-testid="env-removal">
      {view.exposures.map((e) => (
        <p key={e.env} className="break-words">
          {exposureLine(name, e)}
        </p>
      ))}
      {view.unreadable > 0 ? <p>{unreadableLine(name, view.unreadable)}</p> : null}
      <p className="text-[12px] text-anvil-600 dark:text-anvil-300">Removing someone can&apos;t take back what they could already read.</p>
    </div>
  )
}
