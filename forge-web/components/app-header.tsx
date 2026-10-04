'use client'

/**
 * App header (`ux-dx-spec.md` §5.2): wordmark · network badge (every network except mainnet) ·
 * jump box (`owner/name`, `@name`, `#n` in a repo) · New ▾ (Repository, Mirror a GitHub repo) ·
 * notifications bell with the unread count · identity pill. Below `sm` the jump box moves to a
 * second row so the bar fits 360 px, and the header scrolls away with the page (as GitHub's
 * does) rather than pinning ~114 px of a phone's screen; from `sm` up it stays pinned. Below `lg`
 * the wordmark and the account name give way to their icons so a tablet's bar fits too; signed
 * in, below `xl`, the jump box is a search button that opens that second row (QW2-073).
 */

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Bell, BookOpen, ChevronDown, Compass, GitFork, Hammer, Lock, Menu, Plus, Search, Settings, Wallet, X } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { signInRequestOutcome, useUiStore } from '@/hooks/use-ui-store'
import { useUnreadCount } from '@/hooks/use-inbox'
import { addressFromParams, repoHref } from '@/hooks/use-query-param'
import { identityHref } from '@/lib/view/profile-links'
import { SignInButton } from '@/components/sign-in-button'
import { IdentityPill } from '@/components/ui/identity-pill'
import { ThemeToggle } from '@/components/theme-toggle'
import { NetworkBadge } from '@/components/ui/network-badge'
import { ACTIVE_NETWORK, DEFAULT_NETWORK } from '@/lib/constants'
import { resolveAnyRepo } from '@/lib/repo'
import { creditsToDash, ensureSdk } from '@/lib/sdk'
import { cn, errorMessage } from '@/lib/utils'
import type { DiscoveredRepo } from '@/lib/view/discovery'
import { numberTargets, parseJump, resolveWord, wordTarget, type WordMatches } from '@/lib/view/jump'
import { Author } from '@/components/author'
import { balanceToDash, dashValueNote } from '@/lib/view/format'
import { KeyFundsLine } from '@/components/funds-summary'
import { FundsPill } from '@/components/funds-pill'
import { consumePrehydrationIntent } from '@/lib/prehydration'
import { isPageShortcut } from '@/lib/focus'
import { bareRoute, pageTitle } from '@/lib/page-title'
import { useDpnsName } from '@/hooks/use-dpns-name'

const shown = (el: Element | null): boolean => el !== null && el.getClientRects().length > 0

/**
 * `/` focuses the jump box (the visible one: the header's, or the row's); with neither on
 * screen but the search button showing (signed in, below `xl`), it opens the row, which
 * focuses its box. Otherwise `/` is left to the browser.
 */
function useSlashToSearch(openRow: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isPageShortcut(e, '/')) return
      const box = [...document.querySelectorAll<HTMLInputElement>('input[data-jump-box]')].find(shown)
      if (box === undefined) {
        if (!shown(document.querySelector('[data-testid="jump-toggle"]'))) return
        e.preventDefault()
        openRow()
        return
      }
      e.preventDefault()
      box.focus()
      box.select()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [openRow])
}

export function AppHeader(): JSX.Element {
  const { identity, balance, logout, resuming, vaultsLoaded, vaultsError, storage } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)
  const signedIn = identity !== null
  // Signed in, the bar also holds the bell, the funds pill and the account, and below `xl` the
  // jump box was squeezed to ~220 px with its placeholder cut (QW2-073). There it folds to a
  // search button that opens the jump row under the bar, as the phone layout has it.
  const [searchOpen, setSearchOpen] = useState(false)
  const openSearch = useCallback(() => setSearchOpen(true), [])
  const toggleRef = useRef<HTMLButtonElement>(null)
  // Escape in the opened row: back to the button that opened it (if it still shows at this width).
  const dismissSearch = (): void => {
    if (!searchOpen) return
    setSearchOpen(false)
    if (shown(toggleRef.current)) toggleRef.current?.focus()
  }
  const closeSearch = useCallback(() => setSearchOpen(false), [])
  // A jump (routes differ only by query string, so this is told, not read off the pathname), a
  // new page, or signing out closes it.
  const pathname = usePathname()
  useEffect(() => setSearchOpen(false), [pathname, signedIn])
  useEffect(() => {
    if (searchOpen) document.getElementById('jump-compact')?.focus()
  }, [searchOpen])
  useSlashToSearch(openSearch)
  // "Sign in" asked for before it was known whether this browser's kept session resumes: a tap
  // before hydration (lib/prehydration.ts, taken on mount), or on the session-check placeholder.
  // The request is kept in the store (a second mount effect in StrictMode, or a remount, cannot
  // drop it) and acted on once the session check settles: a session that resumed needs no sheet.
  const signInPending = useUiStore((s) => s.signInPending)
  const requestSignIn = useUiStore((s) => s.requestSignIn)
  const clearSignInRequest = useUiStore((s) => s.clearSignInRequest)
  useEffect(() => {
    if (consumePrehydrationIntent('sign-in')) requestSignIn()
  }, [requestSignIn])
  const settled = !resuming && (vaultsLoaded || vaultsError !== null)
  useEffect(() => {
    const outcome = signInRequestOutcome({ pending: signInPending, settled, signedIn: identity !== null })
    if (outcome === 'none' || outcome === 'wait') return
    clearSignInRequest()
    if (outcome === 'open') openLogin()
  }, [settled, signInPending, identity, openLogin, clearSignInRequest])

  return (
    <header className="relative z-40 border-b border-anvil-200 bg-anvil-50 dark:border-anvil-800 dark:bg-anvil-950 sm:sticky sm:top-0 sm:bg-anvil-50/85 sm:backdrop-blur sm:dark:bg-anvil-950/85">
      <div className="mx-auto flex h-14 max-w-[1280px] items-center gap-2 px-3 sm:gap-3 sm:px-6">
        <NavDrawer signedIn={identity !== null} />
        <Link href="/" className="flex shrink-0 items-center gap-2 coarse:min-h-11 coarse:min-w-11" aria-label="Dash Forge home">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-forge-500/15">
            <Hammer className="h-4 w-4 text-forge-500" aria-hidden />
          </span>
          <span className="hidden text-prose font-semibold tracking-tight text-anvil-900 dark:text-anvil-50 lg:inline">Dash Forge</span>
        </Link>

        {/* A devnet (resettable, test funds only) is flagged at every width. */}
        <NetworkBadge compact className={ACTIVE_NETWORK.network === 'devnet' ? undefined : 'hidden sm:inline'} />

        <div className={cn('ml-1 hidden min-w-0 max-w-xs flex-1', signedIn ? 'xl:block' : 'sm:block')}>
          <Suspense fallback={null}>
            <JumpBox />
          </Suspense>
        </div>

        <div className="ml-auto flex shrink-0 items-center sm:gap-1">
          {signedIn ? (
            <button
              type="button"
              ref={toggleRef}
              onClick={() => setSearchOpen((o) => !o)}
              aria-expanded={searchOpen}
              aria-controls="jump-row"
              aria-label="Jump to a repo, a profile, or an issue or PR number"
              title="Jump to… (/)"
              data-testid="jump-toggle"
              className="hidden h-8 w-8 items-center justify-center rounded-md text-anvil-700 hover:bg-anvil-100 dark:text-anvil-200 dark:hover:bg-anvil-800 coarse:h-11 coarse:w-11 sm:inline-flex xl:hidden"
            >
              <Search className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
          <Link
            href="/explore/"
            className="hidden h-8 items-center gap-1.5 rounded-md px-2 text-dense text-anvil-700 hover:bg-anvil-100 coarse:h-11 dark:text-anvil-200 dark:hover:bg-anvil-800 lg:inline-flex"
          >
            <Compass className="h-4 w-4" aria-hidden /> Explore
          </Link>
          {/* What Forge is and how identities and credits work (QW-013), as GitHub links Docs. */}
          <Link
            href="/start/"
            className="hidden h-8 items-center gap-1.5 rounded-md px-2 text-dense text-anvil-700 hover:bg-anvil-100 coarse:h-11 dark:text-anvil-200 dark:hover:bg-anvil-800 lg:inline-flex"
          >
            <BookOpen className="h-4 w-4" aria-hidden /> Docs
          </Link>
          <NewMenu />
          {identity ? <NotificationsBell /> : null}
          <ThemeToggle />
          {identity ? (
            <>
              <FundsPill />
              <AccountMenu identity={identity} balance={balance} pasted={storage === 'session'} onLogout={logout} />
            </>
          ) : (
            <SignInButton size="sm" label="long" />
          )}
        </div>
      </div>
      <div
        id="jump-row"
        className={cn('border-t border-anvil-200 px-3 py-1.5 dark:border-anvil-800 sm:px-6', signedIn && searchOpen ? 'xl:hidden' : 'sm:hidden')}
      >
        {/* A link picked in the box's note or choices is a jump too. */}
        <div className="mx-auto max-w-[1280px]" onClickCapture={(e) => (e.target as Element).closest('a[href]') && closeSearch()}>
          <Suspense fallback={null}>
            <JumpBox compact onDismiss={dismissSearch} onJump={closeSearch} />
          </Suspense>
        </div>
      </div>
      <Suspense fallback={null}>
        <DocumentTitle />
      </Suspense>
    </header>
  )
}

/**
 * Keeps `document.title` in step with the route (L-59): the static export's `<title>` is the
 * same on every page. A repo's or profile's owner id is shown by its DPNS name once resolved
 * (one cached lookup, shared with the owner chip).
 */
function DocumentTitle(): null {
  const pathname = usePathname()
  const params = useSearchParams()
  const owner = params.get('owner') ?? (pathname.startsWith('/u') ? params.get('id') || params.get('name') : null) ?? ''
  const name = useDpnsName(owner)
  const title = pageTitle(pathname, params, name)
  useEffect(() => {
    document.title = title
  }, [title])
  return null
}

/**
 * The jump box. `#n` resolves against the repo the page shows (from its query string): issue
 * first, then PR; both existing opens a choice. `owner/name#n` does the same for that repo. A
 * bare word is looked up as a repo name and as a DPNS name: one match goes straight there,
 * several offer each (repos by owner, then the profile), none says so and offers a search.
 */
function JumpBox({ compact = false, onDismiss, onJump }: { compact?: boolean; onDismiss?: () => void; onJump?: () => void }): JSX.Element {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [query, setQuery] = useState('')
  const [note, setNote] = useState<ReactNode>(null)
  // A word's choices: a list of links, kept out of the status line so it is not announced whole.
  const [choices, setChoices] = useState<{ word: string; matches: WordMatches } | null>(null)
  const [busy, setBusy] = useState(false)
  // Only the newest lookup may act: a slow one must not navigate after the query changed, nor
  // after the header unmounted (the user went somewhere else).
  const request = useRef(0)
  useEffect(() => () => void request.current++, [])
  const clear = (): void => {
    setNote(null)
    setChoices(null)
  }
  const here = addressFromParams(params)
  const inRepo = pathname.startsWith('/repo') && here.owner !== '' && here.name !== ''
  const id = compact ? 'jump-compact' : 'jump'

  const goNumber = async (addr: typeof here, n: number): Promise<void> => {
    const mine = ++request.current
    const current = (): boolean => request.current === mine
    setBusy(true)
    clear()
    try {
      const sdk = await ensureSdk(DEFAULT_NETWORK)
      const resolved = await resolveAnyRepo(sdk, { network: DEFAULT_NETWORK, ...addr })
      if (!current()) return
      if (resolved === null) {
        setNote(`No repo ${addr.owner}/${addr.name} here.`)
        return
      }
      const found = await numberTargets(sdk, resolved.repo, n)
      if (!current()) return
      const issue = repoHref('/repo/issue', addr, { number: String(n) })
      const pull = repoHref('/repo/pull', addr, { number: String(n) })
      if (found.issue && found.pull) {
        setNote(
          <span>
            #{n} is both:{' '}
            <Link className="underline" href={issue} onClick={() => setNote(null)}>issue #{n}</Link> ·{' '}
            <Link className="underline" href={pull} onClick={() => setNote(null)}>PR #{n}</Link>
          </span>,
        )
      } else if (found.issue || found.pull) {
        setQuery('')
        onJump?.()
        router.push(found.issue ? issue : pull)
      } else {
        setNote(`No issue or PR #${n} in ${addr.name}.`)
      }
    } catch (e) {
      if (current()) setNote(errorMessage(e))
    } finally {
      if (current()) setBusy(false)
    }
  }

  const go = (href: string): void => {
    setQuery('')
    clear()
    onJump?.()
    router.push(href)
  }

  const goWord = async (word: string): Promise<void> => {
    const mine = ++request.current
    const current = (): boolean => request.current === mine
    setBusy(true)
    clear()
    try {
      const sdk = await ensureSdk(DEFAULT_NETWORK)
      const matches = await resolveWord(sdk, word, DEFAULT_NETWORK)
      if (!current()) return
      const target = wordTarget(matches)
      if (target.kind === 'repo') go(discoveredRepoHref(target.repo))
      else if (target.kind === 'profile') go(identityHref(target.identityId))
      else if (target.kind === 'choose') {
        const n = matches.repos.length + (matches.profile === null ? 0 : 1)
        setNote(n === 0 ? `Could not check everything named ${word}.` : `${n} match${n === 1 ? '' : 'es'} for ${word}.`)
        setChoices({ word, matches: target.matches })
      } else {
        setNote(
          <span>
            No repo or profile named {word}.{' '}
            <Link
              className="underline"
              href={`/explore/?q=${encodeURIComponent(word)}`}
              onClick={() => {
                setQuery('')
                clear()
              }}
            >
              Search repos for “{word}”
            </Link>
          </span>,
        )
      }
    } catch (e) {
      if (current()) setNote(errorMessage(e))
    } finally {
      if (current()) setBusy(false)
    }
  }

  const onSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    const jump = parseJump(query, inRepo)
    if (jump === null) return
    switch (jump.kind) {
      case 'invalid':
        setNote(jump.message)
        return
      case 'number':
        void goNumber(here, jump.number)
        return
      case 'repo':
        if (jump.number !== undefined) {
          void goNumber({ owner: jump.owner, name: jump.name }, jump.number)
          return
        }
        go(repoHref('/repo', { owner: jump.owner, name: jump.name }))
        return
      case 'profile':
        go(profileHref(jump.name))
        return
      case 'word':
        void goWord(jump.word)
    }
  }

  return (
    <form onSubmit={onSubmit} className="relative" role="search">
      <label htmlFor={id} className="sr-only">
        Jump to a repo, a profile, or an issue or PR number
      </label>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-anvil-500 dark:text-anvil-400" aria-hidden />
      <input
        id={id}
        data-jump-box
        aria-keyshortcuts="/"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          clear()
          // Typing supersedes a lookup still in flight.
          request.current++
          setBusy(false)
        }}
        placeholder={inRepo ? 'owner/name, @name or #42' : 'repo, owner/name or @name'}
        aria-describedby={note ? `${id}-note` : undefined}
        aria-busy={busy}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          if (note !== null || choices !== null) clear()
          else {
            e.currentTarget.blur()
            onDismiss?.()
          }
        }}
        className="peer h-8 w-full rounded-md border border-anvil-300 bg-white pl-8 pr-7 text-dense placeholder:text-anvil-500 focus-visible:border-forge-400 coarse:h-11 coarse:text-base dark:border-anvil-700 dark:bg-anvil-900 dark:placeholder:text-anvil-400"
      />
      {compact ? null : (
        <kbd
          aria-hidden
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-anvil-300 px-1 font-mono text-[11px] leading-4 text-anvil-500 peer-focus:hidden dark:border-anvil-700 dark:text-anvil-400"
        >
          /
        </kbd>
      )}
      {note || choices ? (
        <div
          className="absolute left-0 right-0 top-full z-50 mt-1 rounded-md border border-anvil-200 bg-white px-2.5 py-1.5 text-[12px] text-anvil-700 shadow-lg dark:border-anvil-750 dark:bg-anvil-900 dark:text-anvil-200"
          onKeyDown={(e) => {
            if (e.key === 'Escape') clear()
          }}
        >
          {note ? (
            <div id={`${id}-note`} role="status">
              {note}
            </div>
          ) : null}
          {choices ? (
            <WordChoices
              word={choices.word}
              matches={choices.matches}
              onPick={() => {
                setQuery('')
                clear()
              }}
            />
          ) : null}
        </div>
      ) : null}
    </form>
  )
}

/**
 * The site navigation below `lg`, where the header has no room for its links (L-57): a menu
 * button that opens a drawer with Explore and the rest. A disclosure, like the other menus:
 * Escape, an outside tap and following a link close it.
 */
function NavDrawer({ signedIn }: { signedIn: boolean }): JSX.Element {
  const { open, setOpen, ref, trigger } = usePopover()
  const pathname = usePathname()
  // A navigation closes it (the header stays mounted across pages).
  useEffect(() => setOpen(false), [pathname, setOpen])
  const close = (): void => setOpen(false)
  const item = (href: string, label: string, Icon: typeof Compass): JSX.Element => {
    const current = bareRoute(pathname) === bareRoute(href)
    return (
      <Link key={href} href={href} className={cn(ITEM, current && 'bg-anvil-100 dark:bg-anvil-800')} aria-current={current ? 'page' : undefined} onClick={close}>
        <Icon className="h-4 w-4 shrink-0 text-forge-500" aria-hidden /> {label}
      </Link>
    )
  }
  return (
    <div ref={ref} className="lg:hidden">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="nav-drawer"
        aria-label={open ? 'Close menu' : 'Open menu'}
        data-testid="nav-drawer-toggle"
        className="-ml-1 inline-flex h-8 w-8 items-center justify-center rounded-md text-anvil-700 hover:bg-anvil-100 coarse:h-11 coarse:w-11 dark:text-anvil-200 dark:hover:bg-anvil-800"
      >
        {open ? <X className="h-5 w-5" aria-hidden /> : <Menu className="h-5 w-5" aria-hidden />}
      </button>
      {open ? (
        <nav
          id="nav-drawer"
          aria-label="Site"
          data-testid="nav-drawer"
          className="absolute inset-x-0 top-full z-50 max-h-[calc(100vh-3.5rem)] animate-fade-in overflow-y-auto border-b border-anvil-200 bg-white p-2 shadow-xl dark:border-anvil-800 dark:bg-anvil-900"
        >
          {item('/explore/', 'Explore', Compass)}
          {ACTIVE_NETWORK.v2 !== null ? item('/new/', 'New repository', Plus) : null}
          {ACTIVE_NETWORK.v2 !== null ? item('/mirror/', 'Mirror a GitHub repo', GitFork) : null}
          {signedIn ? item('/notifications/', 'Notifications', Bell) : null}
          {signedIn ? item('/settings/', 'Settings & spend', Settings) : null}
          {/* What Forge is, and the guides (QW-013). */}
          {item('/start/', 'Getting started & docs', BookOpen)}
        </nav>
      ) : null}
    </div>
  )
}


function profileHref(name: string): string {
  return `/u/?name=${encodeURIComponent(name)}`
}

/** A found repo's page, pinned by its repo id. */
function discoveredRepoHref(r: DiscoveredRepo): string {
  return repoHref('/repo', { owner: r.ownerId, name: r.slug, repoId: r.key })
}

/**
 * What a bare word may be: each repo (with its owner), then the profile, then what could not
 * be checked, and a search when more owners use the name than were read.
 */
function WordChoices({ word, matches, onPick }: { word: string; matches: WordMatches; onPick: () => void }): JSX.Element {
  const search = `/explore/?q=${encodeURIComponent(word)}`
  return (
    <div data-testid="jump-choices" className="mt-1">
      <ul className="space-y-1">
        {matches.repos.map((r) => (
          <li key={r.key} className="flex flex-wrap items-center gap-1">
            <Link className="hit-area font-mono underline" href={discoveredRepoHref(r)} onClick={onPick} data-owner={r.ownerId}>
              repo {r.slug}
            </Link>
            <span>by</span>
            <Author identityId={r.ownerId} link={false} />
          </li>
        ))}
        {matches.profile !== null ? (
          <li>
            <Link className="hit-area underline" href={identityHref(matches.profile)} onClick={onPick}>
              profile @{word}
            </Link>
          </li>
        ) : null}
      </ul>
      {matches.moreRepos ? (
        <p className="mt-1">
          More owners have a repo called {word}.{' '}
          <Link className="underline" href={search} onClick={onPick}>
            Search repos
          </Link>
        </p>
      ) : null}
      {matches.reposFailed ? (
        <p className="mt-1 text-caution-700 dark:text-caution-400">
          Couldn&apos;t check repos named {word}.{' '}
          <Link className="underline" href={search} onClick={onPick}>
            Search repos
          </Link>
        </p>
      ) : null}
      {matches.profileFailed ? <p className="mt-1 text-caution-700 dark:text-caution-400">Couldn&apos;t check profiles named {word}.</p> : null}
    </div>
  )
}

/**
 * A disclosure popover (button with `aria-expanded` + a panel of plain links): closes on an
 * outside click, on Escape (focus returns to the trigger), and when focus leaves it (Tab).
 */
function usePopover(): { open: boolean; setOpen: (v: boolean) => void; ref: React.RefObject<HTMLDivElement>; trigger: React.RefObject<HTMLButtonElement> } {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false)
        trigger.current?.focus()
      }
    }
    const onFocus = (e: FocusEvent): void => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    document.addEventListener('focusin', onFocus)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('focusin', onFocus)
    }
  }, [open])
  return { open, setOpen, ref, trigger }
}

/** A menu row, at least 44 px tall on a touch screen (QW4-043: the account menu's were 36 px). */
const MENU_ITEM =
  'flex w-full items-start gap-2 rounded-md px-3 py-2 text-left text-dense hover:bg-anvil-100 focus-visible:bg-anvil-100 coarse:min-h-11 dark:hover:bg-anvil-800 dark:focus-visible:bg-anvil-800'

/** A one-line menu or drawer row: its text centred in the finger-sized row. */
const ITEM = cn(MENU_ITEM, 'items-center')

function NewMenu(): JSX.Element | null {
  const { open, setOpen, ref, trigger } = usePopover()
  // No "New" on a network without Forge (spec §6.3: no New repo button in that state).
  if (ACTIVE_NETWORK.v2 === null) return null
  return (
    <div ref={ref} className="relative">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="new-panel"
        className="inline-flex h-8 items-center justify-center gap-1 rounded-md px-2 text-dense text-anvil-700 hover:bg-anvil-100 coarse:h-11 coarse:min-w-11 dark:text-anvil-200 dark:hover:bg-anvil-800"
      >
        <Plus className="h-4 w-4" aria-hidden />
        <span className="sr-only sm:not-sr-only">New</span>
        <ChevronDown className="hidden h-3 w-3 sm:block" aria-hidden />
      </button>
      {open ? (
        <nav id="new-panel" aria-label="New" className="absolute right-0 z-50 mt-2 w-64 animate-fade-in rounded-lg border border-anvil-200 bg-white p-1 shadow-xl dark:border-anvil-750 dark:bg-anvil-900">
          <Link href="/new/" className={MENU_ITEM} onClick={() => setOpen(false)}>
            <Plus className="mt-0.5 h-4 w-4 shrink-0 text-forge-500" aria-hidden />
            <span>
              Repository
              <span className="block text-[12px] text-anvil-500 dark:text-anvil-400">Create a repo on {ACTIVE_NETWORK.key}</span>
            </span>
          </Link>
          <Link href="/mirror/" className={MENU_ITEM} onClick={() => setOpen(false)}>
            <GitFork className="mt-0.5 h-4 w-4 shrink-0 text-forge-500" aria-hidden />
            <span>
              Mirror a GitHub repo
              <span className="block text-[12px] text-anvil-500 dark:text-anvil-400">Set up in your browser, about 10 minutes</span>
            </span>
          </Link>
        </nav>
      ) : null}
    </div>
  )
}

function NotificationsBell(): JSX.Element {
  const unread = useUnreadCount()
  const label = unread === 0 ? 'Notifications, none unread' : `Notifications, ${unread} unread`
  return (
    <Link
      href="/notifications/"
      aria-label={label}
      title={label}
      data-testid="notifications-bell"
      data-unread={unread}
      className="relative inline-flex h-8 w-8 items-center justify-center rounded-md text-anvil-700 coarse:h-11 coarse:w-11 hover:bg-anvil-100 dark:text-anvil-200 dark:hover:bg-anvil-800"
    >
      <Bell className="h-4 w-4" aria-hidden />
      {unread > 0 ? (
        <span aria-hidden className="absolute -right-0.5 -top-0.5 min-w-[16px] rounded-full bg-forge-700 px-1 text-center font-mono text-[10px] leading-4 text-white">
          {unread > 99 ? '99+' : unread}
        </span>
      ) : null}
    </Link>
  )
}

function AccountMenu({
  identity,
  balance,
  pasted,
  onLogout,
}: {
  identity: string
  balance: string | null
  /** Signed in with a pasted key (tab only): locking forgets it. */
  pasted: boolean
  onLogout: (forget?: boolean) => void
}): JSX.Element {
  const { open, setOpen, ref, trigger } = usePopover()
  const { funds } = useAuth()
  const openTopUp = useUiStore((s) => s.openTopUp)
  const credits = balance ? Number(balance) : 0
  const dash = balanceToDash(balance ?? '0')

  return (
    <div ref={ref} className="relative">
      <button
        ref={trigger}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="account-panel"
        aria-label="Account menu"
        className="flex items-center justify-center gap-2 rounded-full py-0.5 pl-0.5 pr-1 hover:bg-anvil-100 coarse:min-h-11 coarse:min-w-11 dark:hover:bg-anvil-800"
      >
        <IdentityPill identityId={identity} className="max-lg:bg-transparent max-lg:p-0 max-lg:dark:bg-transparent [&>*:not(:first-child)]:max-lg:hidden" />
      </button>
      {open ? (
        <div id="account-panel" className="absolute right-0 z-50 mt-2 w-60 animate-fade-in rounded-lg border border-anvil-200 bg-white p-1 shadow-xl dark:border-anvil-750 dark:bg-anvil-900">
          <div className="rounded-md px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[12px] text-anvil-500 dark:text-anvil-400">
              <Wallet className="h-3.5 w-3.5" aria-hidden /> Balance
            </div>
            <div className="mt-0.5 font-mono text-prose text-dash-600 dark:text-dash-400">{dash} DASH</div>
            <div className="font-mono text-[12px] text-anvil-500 dark:text-anvil-400">
              {credits.toLocaleString()} credits · {dashValueNote(creditsToDash(credits), ACTIVE_NETWORK.network)}
            </div>
            {/* The key's budget and expiry, which the pill only shows on hover (QW-048). */}
            <KeyFundsLine className="mt-1.5" />
          </div>
          <div className="px-3 pb-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                openTopUp({ blocker: funds?.reason ?? 'balance', proactive: true })
              }}
              className="hit-area text-[12px] text-forge-700 underline dark:text-forge-400"
            >
              Add credits
            </button>
          </div>
          <Link href="/notifications/" className={ITEM} onClick={() => setOpen(false)}>
            Notifications
          </Link>
          <Link href="/explore/" className={ITEM} onClick={() => setOpen(false)}>
            Explore
          </Link>
          <Link href="/settings/" className={ITEM} onClick={() => setOpen(false)}>
            Settings &amp; spend
          </Link>
          <Link href={identityHref(identity)} className={ITEM} onClick={() => setOpen(false)}>
            Your profile
          </Link>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onLogout(false)
            }}
            className="flex w-full items-start gap-2 rounded-md px-3 py-2 text-left text-dense text-danger-700 dark:text-danger-400 hover:bg-danger/5"
          >
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {/* What Lock does (QW-044): the pages then say "Session locked", not "Sign in to …". */}
            <span>
              Lock
              <span className="block text-[12px] text-anvil-500 dark:text-anvil-400">
                {pasted ? 'Signs you out and forgets the pasted key.' : 'Signs you out; your key stays in this browser until you forget it in Settings.'}
              </span>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  )
}
