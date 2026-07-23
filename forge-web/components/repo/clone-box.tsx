'use client'

/**
 * Clone box — the `dash://owner/name` remote with a one-click copy, the backend badge, and the
 * git-native hint. The `dash://` scheme is served by the git-remote-dash helper (CLI); the web
 * app browses the same repo without cloning.
 */

import { useState } from 'react'
import { Check, Copy, TerminalSquare } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { BackendBadge } from '@/components/ui/backend-badge'
import { Oid } from '@/components/ui/oid'
import type { RepoAddress } from '@/hooks/use-query-param'

export function CloneBox({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  const remote = `dash://${addr.owner}/${addr.name}`
  const [copied, setCopied] = useState(false)

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(remote)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* insecure context */
    }
  }

  return (
    <div className="rounded-lg border border-anvil-200 bg-white dark:border-anvil-750 dark:bg-anvil-900">
      <div className="flex items-center justify-between border-b border-anvil-200 px-3 py-2 dark:border-anvil-800">
        <span className="flex items-center gap-1.5 text-dense font-medium">
          <TerminalSquare className="h-3.5 w-3.5 text-anvil-400" aria-hidden /> Clone
        </span>
        <BackendBadge backend={home.backend} />
      </div>
      <div className="p-3">
        <div className="flex items-center gap-2 rounded-md border border-anvil-200 bg-anvil-50 px-2 py-1.5 dark:border-anvil-800 dark:bg-anvil-950">
          <code className="min-w-0 flex-1 truncate font-mono text-dense text-anvil-800 dark:text-anvil-200">
            {remote}
          </code>
          <button onClick={copy} aria-label="Copy clone URL" className="shrink-0 rounded p-1 text-anvil-400 hover:bg-anvil-200 hover:text-anvil-700 dark:hover:bg-anvil-800">
            {copied ? <Check className="h-3.5 w-3.5 text-verify" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
          </button>
        </div>
        <p className="mt-2 text-[12px] leading-snug text-anvil-500 dark:text-anvil-400">
          Push and pull with the <span className="font-mono">git-remote-dash</span> helper. Contract{' '}
          <Oid value={home.repo.contractId} chars={8} />
        </p>
      </div>
    </div>
  )
}
