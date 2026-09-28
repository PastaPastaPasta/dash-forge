'use client'

/**
 * App header (`ux-dx-spec.md` §5.2): wordmark · network badge (every network except mainnet) ·
 * jump box (`owner/name`, `@name`, `#n` in a repo) · New ▾ (Repository, Mirror a GitHub repo) ·
 * notifications bell with the unread count · identity pill. Below `sm` the jump box moves to a
 * second row so the bar fits 360 px.
 */

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { Bell, ChevronDown, Compass, GitFork, Hammer, LogOut, Plus, Search, Wallet } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { signInRequestOutcome, useUiStore } from '@/hooks/use-ui-store'
import { useUnreadCount } from '@/hooks/use-inbox'
import { addressFromParams, repoHref } from '@/hooks/use-query-param'
import { SignInButton } from '@/components/sign-in-button'
import { IdentityPill } from '@/components/ui/identity-pill'
import { ThemeToggle } from '@/components/theme-toggle'
import { NetworkBadge } from '@/components/ui/network-badge'
import { ACTIVE_NETWORK, DEFAULT_NETWORK } from '@/lib/constants'
import { resolveAnyRepo } from '@/lib/repo'
import { creditsToDash, ensureSdk } from '@/lib/sdk'
import { errorMessage } from '@/lib/utils'
import { numberTargets, parseJump } from '@/lib/view/jump'
import { balanceToDash, dashToUsd } from '@/lib/view/format'
import { FundsPill } from '@/components/funds-pill'
import { consumePrehydrationIntent } from '@/lib/prehydration'

/** The mirror guide (the `/mirror` wizard does not exist yet). */
export const MIRROR_GUIDE_URL = 'https://github.com/PastaPastaPasta/dash-forge/blob/master/docs/guides/mirror-a-github-repo.md'

/** Whether a key press is typing into a field (where `/` must stay a character). */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
}

/** `/` focuses the jump box (the visible one: the header's, or the phone row's). */
function useSlashToSearch(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || isTyping(e.target)) return
      // An open modal keeps the keyboard.
      if (document.querySelector('[aria-modal="true"]') !== null) return
      const box = [...document.querySelectorAll<HTMLInputElement>('input[data-jump-box]')].find(
        (el) => el.getClientRects().length > 0,
      )
      if (box === undefined) return
      e.preventDefault()
      box.focus()
      box.select()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
}

export function AppHeader(): JSX.Element {
  const { identity, balance, logout, resuming, vaultsLoaded, vaultsError } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)
  useSlashToSearch()
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
    <header className="sticky top-0 z-40 border-b border-anvil-200 bg-anvil-50/85 backdrop-blur dark:border-anvil-800 dark:bg-anvil-950/85">
      <div className="mx-auto flex h-14 max-w-[1280px] items-center gap-2 px-3 sm:gap-3 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2 coarse:min-h-11 coarse:min-w-11" aria-label="Dash Forge home">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-forge-500/15">
            <Hammer className="h-4 w-4 text-forge-500" aria-hidden />
          </span>
          <span className="hidden text-prose font-semibold tracking-tight text-anvil-900 dark:text-anvil-50 md:inline">Dash Forge</span>
        </Link>

        {/* A devnet (resettable, test funds only) is flagged at every width. */}
        <NetworkBadge compact className={ACTIVE_NETWORK.network === 'devnet' ? undefined : 'hidden sm:inline'} />

        <div className="ml-1 hidden max-w-xs flex-1 sm:block">
          <Suspense fallback={null}>
            <JumpBox />
          </Suspense>
        </div>

        <div className="ml-auto flex items-center sm:gap-1">
          <Link
            href="/explore/"
            className="hidden h-8 items-center gap-1.5 rounded-md px-2 text-dense text-anvil-700 hover:bg-anvil-100 dark:text-anvil-200 dark:hover:bg-anvil-800 lg:inline-flex"
          >
            <Compass className="h-4 w-4" aria-hidden /> Explore
          </Link>
          <NewMenu />
          {identity ? <NotificationsBell /> : null}
          <ThemeToggle />
          {identity ? (
            <>
              <FundsPill />
              <AccountMenu identity={identity} balance={balance} onLogout={logout} />
            </>
          ) : (
            <SignInButton size="sm" label="long" />
          )}
        </div>
      </div>
      <div className="border-t border-anvil-200 px-3 py-1.5 dark:border-anvil-800 sm:hidden">
        <Suspense fallback={null}>
          <JumpBox compact />
        </Suspense>
      </div>
    </header>
  )
}

/**
 * The jump box. `#n` resolves against the repo the page shows (from its query string): issue
 * first, then PR; both existing opens a choice. `owner/name#n` does the same for that repo.
 */
function JumpBox({ compact = false }: { compact?: boolean }): JSX.Element {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [query, setQuery] = useState('')
  const [note, setNote] = useState<ReactNode>(null)
  const [busy, setBusy] = useState(false)
  // Only the newest #n lookup may act: a slow one must not navigate after the query changed.
  const request = useRef(0)
  const here = addressFromParams(params)
  const inRepo = pathname.startsWith('/repo') && here.owner !== '' && here.name !== ''
  const id = compact ? 'jump-compact' : 'jump'

  const goNumber = async (addr: typeof here, n: number): Promise<void> => {
    const mine = ++request.current
    const current = (): boolean => request.current === mine
    setBusy(true)
    setNote(null)
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
        setQuery('')
        setNote(null)
        router.push(repoHref('/repo', { owner: jump.owner, name: jump.name }))
        return
      case 'profile':
        setQuery('')
        setNote(null)
        router.push(`/u/?name=${encodeURIComponent(jump.name)}`)
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
          setNote(null)
          // Typing supersedes a lookup still in flight.
          request.current++
          setBusy(false)
        }}
        placeholder={inRepo ? 'owner/name, @name or #n' : 'owner/name or @name'}
        aria-describedby={note ? `${id}-note` : undefined}
        aria-busy={busy}
        onKeyDown={(e) => {
          if (e.key === 'Escape') e.currentTarget.blur()
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
      {note ? (
        <p
          id={`${id}-note`}
          role="status"
          className="absolute left-0 right-0 top-full z-50 mt-1 rounded-md border border-anvil-200 bg-white px-2.5 py-1.5 text-[12px] text-anvil-700 shadow-lg dark:border-anvil-750 dark:bg-anvil-900 dark:text-anvil-200"
        >
          {note}
        </p>
      ) : null}
    </form>
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

const MENU_ITEM = 'flex w-full items-start gap-2 rounded-md px-3 py-2 text-left text-dense hover:bg-anvil-100 focus-visible:bg-anvil-100 dark:hover:bg-anvil-800 dark:focus-visible:bg-anvil-800'

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
          <a href={MIRROR_GUIDE_URL} target="_blank" rel="noopener noreferrer" className={MENU_ITEM} onClick={() => setOpen(false)}>
            <GitFork className="mt-0.5 h-4 w-4 shrink-0 text-forge-500" aria-hidden />
            <span>
              Mirror a GitHub repo
              <span className="block text-[12px] text-anvil-500 dark:text-anvil-400">Guide on GitHub (opens a new tab)</span>
            </span>
          </a>
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
  onLogout,
}: {
  identity: string
  balance: string | null
  onLogout: (forget?: boolean) => void
}): JSX.Element {
  const { open, setOpen, ref, trigger } = usePopover()
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
        <IdentityPill identityId={identity} className="max-sm:bg-transparent max-sm:p-0 max-sm:dark:bg-transparent [&>*:not(:first-child)]:max-sm:hidden" />
      </button>
      {open ? (
        <div id="account-panel" className="absolute right-0 z-50 mt-2 w-60 animate-fade-in rounded-lg border border-anvil-200 bg-white p-1 shadow-xl dark:border-anvil-750 dark:bg-anvil-900">
          <div className="rounded-md px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[12px] text-anvil-500 dark:text-anvil-400">
              <Wallet className="h-3.5 w-3.5" aria-hidden /> Balance
            </div>
            <div className="mt-0.5 font-mono text-prose text-dash-600 dark:text-dash-400">{dash} DASH</div>
            <div className="font-mono text-[12px] text-anvil-500 dark:text-anvil-400">
              {credits.toLocaleString()} credits · ≈ {dashToUsd(creditsToDash(credits))}
            </div>
          </div>
          <Link href="/notifications/" className={MENU_ITEM} onClick={() => setOpen(false)}>
            Notifications
          </Link>
          <Link href="/explore/" className={MENU_ITEM} onClick={() => setOpen(false)}>
            Explore
          </Link>
          <Link href="/settings/" className={MENU_ITEM} onClick={() => setOpen(false)}>
            Settings &amp; spend
          </Link>
          <Link href={`/u/?name=${encodeURIComponent(identity)}`} className={MENU_ITEM} onClick={() => setOpen(false)}>
            Your profile
          </Link>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onLogout(false)
            }}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-dense text-danger-700 dark:text-danger-400 hover:bg-danger/5"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden /> Lock &amp; sign out
          </button>
        </div>
      ) : null}
    </div>
  )
}
