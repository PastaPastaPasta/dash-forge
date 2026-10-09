'use client'

/**
 * Where an identity with no DPNS username learns how to get one (QW3-035): /start says a name is
 * optional, but Settings and the own profile showed only "DhRR5hs…" with no way to a readable
 * name. "Choose a username" opens the flow that checks a name and registers it here, or hands
 * over the `dg auth name register` command (#452: `./username-dialog`).
 *
 * The caller renders this whatever the name, with `show` while the identity has none: the
 * dialog outlives the hint, which goes as soon as the registered name is known, so the dialog's
 * "is your username" step is still seen.
 */

import { useState } from 'react'
import { AtSign } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { UsernameDialog } from '@/components/username-dialog'
import { DOCS } from '@/lib/docs-links'

export function UsernameHint({ show, className }: { show: boolean; className?: string }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const dialog = open ? <UsernameDialog onClose={() => setOpen(false)} /> : null
  if (!show) return dialog
  return (
    <div className={className} data-testid="username-hint">
      <p className="text-dense text-anvil-700 dark:text-anvil-200">
        No username yet. A DPNS username makes your addresses readable (<span className="font-mono">forge.dashhq.org/alice/project</span>,{' '}
        <span className="font-mono">@alice</span>).
      </p>
      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="username-choose">
          <AtSign className="h-3.5 w-3.5" aria-hidden /> Choose a username
        </Button>
        <a href={`${DOCS.identity}#what-an-identity-is`} target="_blank" rel="noreferrer noopener" className="hit-area text-[12px] text-forge-700 underline dark:text-forge-400">
          How usernames work →
        </a>
      </p>
      {dialog}
    </div>
  )
}
