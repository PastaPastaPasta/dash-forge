'use client'

/**
 * The frame every repo Settings page shares: a grouped section nav (a column beside the content
 * on a wide screen, one scrolling row above it on a phone) and one section at a time. The
 * sections of `/repo/settings` are picked by the URL hash (`#storage`), so a link to one opens
 * it; Environments and Bots and runners are their own routes, shown in the same frame.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { AlertTriangle, Ban, Bot, GitBranch, HardDrive, KeyRound, Settings2, Users, Webhook } from 'lucide-react'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { cn } from '@/lib/utils'

/** The sections of `/repo/settings` itself, each a hash. */
const SECTIONS = ['general', 'collaborators', 'bans', 'branches', 'storage', 'webhooks', 'danger'] as const

export type SettingsSection = (typeof SECTIONS)[number]

/** Where the nav is: a section of `/repo/settings`, or one of the pages beside it. */
export type SettingsPlace = SettingsSection | 'environments' | 'bots'

interface NavItem {
  readonly id: SettingsPlace
  readonly label: string
  readonly icon: typeof Settings2
  /** A page of its own; otherwise a hash of `/repo/settings`. */
  readonly page?: string
}

const GROUPS: readonly { readonly label: string | null; readonly items: readonly NavItem[] }[] = [
  { label: null, items: [{ id: 'general', label: 'General', icon: Settings2 }] },
  {
    label: 'Access',
    items: [
      { id: 'collaborators', label: 'Members', icon: Users },
      { id: 'bans', label: 'Bans', icon: Ban },
    ],
  },
  {
    label: 'Code',
    items: [
      { id: 'branches', label: 'Branches', icon: GitBranch },
      { id: 'storage', label: 'Storage', icon: HardDrive },
    ],
  },
  {
    label: 'Automation',
    items: [
      { id: 'environments', label: 'Environments', icon: KeyRound, page: '/repo/settings/environments' },
      { id: 'bots', label: 'Bots and runners', icon: Bot, page: '/repo/settings/bots' },
      { id: 'webhooks', label: 'Webhooks', icon: Webhook },
    ],
  },
  { label: null, items: [{ id: 'danger', label: 'Danger zone', icon: AlertTriangle }] },
]

/** Anchors inside a section: a link to one opens its section, then scrolls to it. */
const ANCHORS: Readonly<Record<string, SettingsSection>> = {
  members: 'collaborators',
  'members-unlock': 'collaborators',
  'platform-details': 'general',
}

/** The section a URL hash (without `#`) opens, or null for none of them. */
export function sectionOfHash(hash: string): SettingsSection | null {
  let id = hash.replace(/^#/, '')
  try {
    id = decodeURIComponent(id)
  } catch {
    // A malformed escape (`#%`) names no section.
  }
  return (SECTIONS as readonly string[]).includes(id) ? (id as SettingsSection) : (ANCHORS[id] ?? null)
}

/**
 * The section the hash names, or `fallback` (also for a section `allowed` leaves out, such as the
 * Danger zone for a writer). Follows the hash as links change it: a plain hash link fires
 * `hashchange`, Back fires `popstate`, and a router link to this same page changes the URL by
 * `pushState` (no event), so a click on any link is followed by a look at the hash too. A hash
 * that names no section (the skip link's `#main`) keeps the section shown.
 */
export function useSettingsSection(fallback: SettingsSection, allowed: (s: SettingsSection) => boolean = () => true): SettingsSection {
  const [named, setNamed] = useState<SettingsSection | null>(null)
  const [anchor, setAnchor] = useState<{ id: string } | null>(null)
  useEffect(() => {
    const read = (): void => {
      const hash = window.location.hash
      const section = sectionOfHash(hash)
      if (section === null) return
      setNamed(section)
      const id = hash.replace(/^#/, '')
      if (id in ANCHORS) setAnchor({ id })
    }
    const afterClick = (e: MouseEvent): void => {
      if (e.target instanceof Element && e.target.closest('a[href*="#"]') !== null) window.setTimeout(read, 0)
    }
    read()
    window.addEventListener('hashchange', read)
    window.addEventListener('popstate', read)
    document.addEventListener('click', afterClick)
    return () => {
      window.removeEventListener('hashchange', read)
      window.removeEventListener('popstate', read)
      document.removeEventListener('click', afterClick)
    }
  }, [])
  // An anchor inside the section: bring it into view once the section shows it.
  useEffect(() => {
    if (anchor === null) return
    const t = window.setTimeout(() => document.getElementById(anchor.id)?.scrollIntoView?.({ block: 'start' }), 0)
    return () => window.clearTimeout(t)
  }, [anchor])
  return named !== null && allowed(named) ? named : fallback
}

/** One section of `/repo/settings`: kept mounted (a dialog or an edit in it survives a switch), shown only while picked. */
export function SettingsPane({ id, active, children }: { id: SettingsSection; active: SettingsSection; children: ReactNode }): JSX.Element {
  return (
    <div hidden={id !== active} data-settings-pane={id}>
      {children}
    </div>
  )
}

export function SettingsShell({
  addr,
  active,
  showDanger,
  children,
}: {
  addr: RepoAddress
  active: SettingsPlace
  showDanger: boolean
  children: ReactNode
}): JSX.Element {
  const frame = useRef<HTMLDivElement>(null)
  const nav = useRef<HTMLElement>(null)
  const first = useRef(true)
  // A section picked further down a long one starts at its top, not where the last one was.
  useEffect(() => {
    if (first.current) {
      first.current = false
    } else {
      const top = frame.current?.getBoundingClientRect().top ?? 0
      if (top < 0) frame.current?.scrollIntoView?.({ block: 'start' })
    }
    // A phone's nav row keeps the picked item in view.
    nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [active])
  const onSettingsPage = active !== 'environments' && active !== 'bots'
  const settings = repoHref('/repo/settings', addr)
  return (
    <div ref={frame} className="scroll-mt-20 md:grid md:grid-cols-[12.5rem_minmax(0,1fr)] md:gap-10" data-testid="settings-shell">
      <nav
        ref={nav}
        aria-label="Settings sections"
        className={cn(
          '-mx-4 mb-6 flex gap-1 overflow-x-auto border-b border-anvil-200 px-4 pb-2 text-dense [scrollbar-width:thin] dark:border-anvil-800',
          'md:sticky md:top-20 md:mx-0 md:mb-0 md:flex-col md:gap-4 md:self-start md:overflow-visible md:border-b-0 md:px-0 md:pb-0',
        )}
      >
        {GROUPS.map((group, gi) => {
          const items = group.items.filter((i) => showDanger || i.id !== 'danger')
          if (items.length === 0) return null
          return (
            <div key={gi} className="contents md:block">
              {group.label !== null ? (
                <p className="hidden px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-anvil-500 md:block dark:text-anvil-400">{group.label}</p>
              ) : null}
              <ul role="list" className="contents md:flex md:flex-col md:gap-0.5">
                {items.map((item) => {
                  const current = item.id === active
                  const Icon = item.icon
                  const className = cn(
                    'hit-area flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-1.5 coarse:min-h-11',
                    current
                      ? 'bg-anvil-100 font-medium text-anvil-900 dark:bg-anvil-800 dark:text-anvil-50'
                      : 'text-anvil-600 hover:bg-anvil-100 hover:text-anvil-900 dark:text-anvil-300 dark:hover:bg-anvil-850 dark:hover:text-anvil-50',
                  )
                  let href = `${settings}#${item.id}`
                  if (item.page !== undefined) href = repoHref(item.page, addr)
                  else if (onSettingsPage) href = `#${item.id}`
                  // A plain hash link on this page: it fires `hashchange`, which a router push would not.
                  const Anchor = item.page === undefined && onSettingsPage ? 'a' : Link
                  return (
                    <li key={item.id} role="listitem" className="contents md:block">
                      <Anchor href={href} className={className} aria-current={current ? 'page' : undefined}>
                        <Icon className={cn('h-4 w-4 shrink-0', current ? 'text-forge-700 dark:text-forge-400' : 'text-anvil-400 dark:text-anvil-500')} aria-hidden />
                        {item.label}
                      </Anchor>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </nav>
      <div className="min-w-0 max-w-3xl">{children}</div>
    </div>
  )
}
