'use client'

/**
 * Where an identity with no DPNS username learns how to get one (QW3-035): /start says a name is
 * optional, but Settings and the own profile showed only "DhRR5hs…" with no way to a readable
 * name. Registering one is a master-key write the browser's limited key cannot sign, so this
 * points at `dg auth name register`, the guide's path.
 */

import { Copy } from 'lucide-react'

import { DOCS } from '@/lib/docs-links'
import { useCopy } from '@/hooks/use-copy'

export const NAME_REGISTER_COMMAND = 'dg auth name register <label>'

export function UsernameHint({ className }: { className?: string }): JSX.Element {
  const [copied, copy] = useCopy(NAME_REGISTER_COMMAND)
  return (
    <div className={className} data-testid="username-hint">
      <p className="text-dense text-anvil-700 dark:text-anvil-200">
        No username yet. A DPNS username makes your addresses readable (<span className="font-mono">forge.dashhq.org/alice/project</span>,{' '}
        <span className="font-mono">@alice</span>).
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-anvil-600 dark:text-anvil-300">
        Register one with
        <span className="inline-flex items-center gap-1 rounded bg-anvil-100 px-1.5 py-0.5 font-mono text-anvil-800 dark:bg-anvil-800 dark:text-anvil-100">
          {NAME_REGISTER_COMMAND}
          <button
            type="button"
            onClick={() => void copy()}
            className="hit-area text-anvil-500 hover:text-anvil-800 dark:text-anvil-400 dark:hover:text-anvil-100"
            aria-label="Copy the command"
          >
            <Copy className="h-3 w-3" aria-hidden />
          </button>
        </span>
        <span>{copied ? 'Copied.' : 'It signs once with your identity’s master key (its file or 12 words); this browser’s limited key cannot.'}</span>
        <a href={`${DOCS.identity}#what-an-identity-is`} target="_blank" rel="noreferrer noopener" className="hit-area text-forge-700 underline dark:text-forge-400">
          How usernames work →
        </a>
      </p>
    </div>
  )
}
