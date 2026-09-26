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
import { useUiStore } from '@/hooks/use-ui-store'
import { useInboxPoller, useUnreadCount } from '@/hooks/use-inbox'
import { addressFromParams, repoHref } from '@/hooks/use-query-param'
import { Button } from '@/components/ui/button'
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

/** The mirror guide (the `/mirror` wizard does not exist yet). */
export const MIRROR_GUIDE_URL = 'https://github.com/PastaPastaPasta/dash-forge/blob/master/docs/guides/mirror-a-github-repo.md'

export function AppHeader(): JSX.Element {
  const openLogin = useUiStore((s) => s.openLogin)
  const { identity, balance, logout } = useAuth()
  useInboxPoller()

  return (
    <header className="sticky top-0 z-40 border-b border-anvil-200 bg-anvil-50/85 backdrop-blur dark:border-anvil-800 dark:bg-anvil-950/85">
      <div className="mx-auto flex h-14 max-w-[1280px] items-center gap-2 px-3 sm:gap-3 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2" aria-label="Dash Forge home">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-forge-500/15">
            <Hammer className="h-4 w-4 text-forge-500" aria-hidden />
          </span>
          <span className="hidden text-prose font-semibold tracking-tight text-anvil-900 dark:text-anvil-50 md:inline">Dash Forge</span>
        </Link>

        <NetworkBadge className="hidden sm:inline" />

        <div className="ml-1 hidden max-w-xs flex-1 sm:block">
          <Suspense fallback={null}>
            <JumpBox />
          </Suspense>
        </div>

        <div className="ml-auto flex items-center gap-1">
          <Link
            href="/explore"
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
            <Button variant="primary" size="sm" onClick={() => openLogin()}>
              Sign in
            </Button>
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
  const here = addressFromParams(params)
  const inRepo = pathname.startsWith('/repo') && here.owner !== '' && here.name !== ''
  const id = compact ? 'jump-compact' : 'jump'

  const goNumber = async (addr: typeof here, n: number): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      const sdk = await ensureSdk(DEFAULT_NETWORK)
      const resolved = await resolveAnyRepo(sdk, { network: DEFAULT_NETWORK, ...addr })
      if (resolved === null) {
        setNote(`No repo ${addr.owner}/${addr.name} here.`)
        return
      }
      const found = await numberTargets(sdk, resolved.repo, n)
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
      setNote(errorMessage(e))
    } finally {
      setBusy(false)
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
        router.push(`/u?name=${encodeURIComponent(jump.name)}`)
    }
  }

  return (
    <form onSubmit={onSubmit} className="relative" role="search">
      <label htmlFor={id} className="sr-only">
        Jump to a repo, a profile, or an issue or PR number
      </label>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-anvil-500" aria-hidden />
      <input
        id={id}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setNote(null)
        }}
        placeholder={inRepo ? 'owner/name, @name or #n' : 'owner/name or @name'}
        aria-describedby={note ? `${id}-note` : undefined}
        aria-busy={busy}
        className="h-8 w-full rounded-md border border-anvil-300 bg-white pl-8 pr-2 text-dense placeholder:text-anvil-500 focus-visible:border-forge-400 dark:border-anvil-700 dark:bg-anvil-900 dark:placeholder:text-anvil-400"
      />
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

/** Close a popover on an outside click or Escape (focus returns to its trigger). */
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
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return { open, setOpen, ref, trigger }
}

const MENU_ITEM = 'flex w-full items-start gap-2 rounded-md px-3 py-2 text-left text-dense hover:bg-anvil-100 focus-visible:bg-anvil-100 dark:hover:bg-anvil-800 dark:focus-visible:bg-anvil-800'

function NewMenu(): JSX.Element | null {
  const { open, setOpen, ref, trigger } = usePopover()
  // No "New" on a network without Forge (spec §6.3: no New repo button in that state).
  if (ACTIVE_NETWORK.v2 === null && ACTIVE_NETWORK.registryContractId === null) return null
  return (
    <div ref={ref} className="relative">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-dense text-anvil-700 hover:bg-anvil-100 dark:text-anvil-200 dark:hover:bg-anvil-800"
      >
        <Plus className="h-4 w-4" aria-hidden />
        <span className="sr-only sm:not-sr-only">New</span>
        <ChevronDown className="h-3 w-3" aria-hidden />
      </button>
      {open ? (
        <div role="menu" aria-label="New" className="absolute right-0 z-50 mt-2 w-64 animate-fade-in rounded-lg border border-anvil-200 bg-white p-1 shadow-xl dark:border-anvil-750 dark:bg-anvil-900">
          <Link href="/new" role="menuitem" className={MENU_ITEM} onClick={() => setOpen(false)}>
            <Plus className="mt-0.5 h-4 w-4 shrink-0 text-forge-500" aria-hidden />
            <span>
              Repository
              <span className="block text-[12px] text-anvil-500 dark:text-anvil-400">Create a repo on {ACTIVE_NETWORK.key}</span>
            </span>
          </Link>
          <a href={MIRROR_GUIDE_URL} role="menuitem" target="_blank" rel="noopener noreferrer" className={MENU_ITEM} onClick={() => setOpen(false)}>
            <GitFork className="mt-0.5 h-4 w-4 shrink-0 text-forge-500" aria-hidden />
            <span>
              Mirror a GitHub repo
              <span className="block text-[12px] text-anvil-500 dark:text-anvil-400">Guide on GitHub (opens a new tab)</span>
            </span>
          </a>
        </div>
      ) : null}
    </div>
  )
}

function NotificationsBell(): JSX.Element {
  const unread = useUnreadCount()
  const label = unread === 0 ? 'Notifications, none unread' : `Notifications, ${unread} unread`
  return (
    <Link
      href="/notifications"
      aria-label={label}
      title={label}
      data-testid="notifications-bell"
      data-unread={unread}
      className="relative inline-flex h-8 w-8 items-center justify-center rounded-md text-anvil-700 hover:bg-anvil-100 dark:text-anvil-200 dark:hover:bg-anvil-800"
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
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="flex items-center gap-2 rounded-full py-0.5 pl-0.5 pr-1 hover:bg-anvil-100 dark:hover:bg-anvil-800"
      >
        <IdentityPill identityId={identity} className="max-w-[9rem] overflow-hidden sm:max-w-none" />
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 z-50 mt-2 w-60 animate-fade-in rounded-lg border border-anvil-200 bg-white p-1 shadow-xl dark:border-anvil-750 dark:bg-anvil-900">
          <div className="rounded-md px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[12px] text-anvil-500 dark:text-anvil-400">
              <Wallet className="h-3.5 w-3.5" aria-hidden /> Balance
            </div>
            <div className="mt-0.5 font-mono text-prose text-dash-600 dark:text-dash-400">{dash} DASH</div>
            <div className="font-mono text-[12px] text-anvil-500 dark:text-anvil-400">
              {credits.toLocaleString()} credits · ≈ {dashToUsd(creditsToDash(credits))}
            </div>
          </div>
          <Link href="/notifications" role="menuitem" className={MENU_ITEM} onClick={() => setOpen(false)}>
            Notifications
          </Link>
          <Link href="/explore" role="menuitem" className={MENU_ITEM} onClick={() => setOpen(false)}>
            Explore
          </Link>
          <Link href="/settings" role="menuitem" className={MENU_ITEM} onClick={() => setOpen(false)}>
            Settings &amp; spend
          </Link>
          <Link href={`/u?name=${encodeURIComponent(identity)}`} role="menuitem" className={MENU_ITEM} onClick={() => setOpen(false)}>
            Your profile
          </Link>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onLogout(false)
            }}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-dense text-danger hover:bg-danger/5"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden /> Lock &amp; sign out
          </button>
        </div>
      ) : null}
    </div>
  )
}
