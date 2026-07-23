'use client'

/**
 * App header — the persistent foundry chrome: wordmark, global repo jump, network badge, theme
 * toggle, and the auth surface (sign-in trigger, or balance + identity + logout when signed in).
 */

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { Hammer, LogOut, Search, Wallet } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { Button } from '@/components/ui/button'
import { IdentityPill } from '@/components/ui/identity-pill'
import { ThemeToggle } from '@/components/theme-toggle'
import { DEFAULT_NETWORK } from '@/lib/constants'
import { creditsToDash } from '@/lib/sdk'
import { balanceToDash, dashToUsd } from '@/lib/view/format'

export function AppHeader(): JSX.Element {
  const openLogin = useUiStore((s) => s.openLogin)
  const { identity, balance, logout } = useAuth()
  const router = useRouter()
  const [query, setQuery] = useState('')

  const onSearch = (e: React.FormEvent): void => {
    e.preventDefault()
    const q = query.trim()
    if (!q) return
    // Accept "owner/name" jump; otherwise treat as an owner profile lookup.
    if (q.includes('/')) {
      const [owner, name] = q.split('/')
      router.push(`/repo?owner=${encodeURIComponent(owner ?? '')}&name=${encodeURIComponent(name ?? '')}`)
    } else {
      router.push(`/u?name=${encodeURIComponent(q)}`)
    }
  }

  return (
    <header className="sticky top-0 z-40 border-b border-anvil-200 bg-anvil-50/85 backdrop-blur dark:border-anvil-800 dark:bg-anvil-950/85">
      <div className="mx-auto flex h-14 max-w-[1280px] items-center gap-3 px-4 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-forge-500/15">
            <Hammer className="h-4 w-4 text-forge-500" aria-hidden />
          </span>
          <span className="hidden text-prose font-semibold tracking-tight text-anvil-900 dark:text-anvil-50 sm:inline">
            Dash Forge
          </span>
        </Link>

        <span className="hidden rounded bg-dash/10 px-1.5 py-0.5 font-mono text-[11px] uppercase text-dash sm:inline">
          {DEFAULT_NETWORK}
        </span>

        <form onSubmit={onSearch} className="relative ml-2 hidden max-w-xs flex-1 sm:block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-anvil-400" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to owner/name…"
            aria-label="Jump to a repo or profile"
            className="h-8 w-full rounded-md border border-anvil-300 bg-white pl-8 pr-2 text-dense placeholder:text-anvil-400 focus-visible:border-forge-400 dark:border-anvil-700 dark:bg-anvil-900"
          />
        </form>

        <div className="ml-auto flex items-center gap-1.5">
          <ThemeToggle />
          {identity ? (
            <AccountMenu identity={identity} balance={balance} onLogout={logout} />
          ) : (
            <Button variant="primary" size="sm" onClick={openLogin}>
              Sign in
            </Button>
          )}
        </div>
      </div>
    </header>
  )
}

function AccountMenu({
  identity,
  balance,
  onLogout,
}: {
  identity: string
  balance: string | null
  onLogout: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const credits = balance ? Number(balance) : 0
  const dash = balanceToDash(balance ?? '0')

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-full py-0.5 pl-0.5 pr-1 hover:bg-anvil-100 dark:hover:bg-anvil-800"
      >
        <IdentityPill identityId={identity} />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-60 animate-fade-in rounded-lg border border-anvil-200 bg-white p-1 shadow-xl dark:border-anvil-750 dark:bg-anvil-900"
        >
          <div className="rounded-md px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[12px] text-anvil-500 dark:text-anvil-400">
              <Wallet className="h-3.5 w-3.5" aria-hidden /> Balance
            </div>
            <div className="mt-0.5 font-mono text-prose text-dash">{dash} DASH</div>
            <div className="font-mono text-[12px] text-anvil-400">
              {credits.toLocaleString()} credits · ≈ {dashToUsd(creditsToDash(credits))}
            </div>
          </div>
          <Link
            href={`/u?name=${encodeURIComponent(identity)}`}
            role="menuitem"
            className="block rounded-md px-3 py-2 text-dense hover:bg-anvil-100 dark:hover:bg-anvil-800"
            onClick={() => setOpen(false)}
          >
            Your profile
          </Link>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onLogout()
            }}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-dense text-danger hover:bg-danger/5"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden /> Sign out
          </button>
        </div>
      ) : null}
    </div>
  )
}
