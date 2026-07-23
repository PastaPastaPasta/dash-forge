'use client'

/**
 * Oid — a git object id / hash / identity id rendered as a struck-metal serial: monospace,
 * 7-char abbreviated, click-to-copy the full value. The signature treatment of identifiers
 * throughout the forge (style guide: "OIDs always mono, 7-char abbreviated, click-to-copy").
 */

import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'

export interface OidProps {
  value: string
  /** Abbreviation length (default 7). */
  chars?: number
  /** Show the copy affordance (default true). */
  copyable?: boolean
  className?: string
}

export function Oid({ value, chars = 7, copyable = true, className }: OidProps): JSX.Element {
  const [copied, setCopied] = useState(false)
  const shown = value.length > chars ? value.slice(0, chars) : value

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // Clipboard unavailable (insecure context) — the value is still visible on hover.
    }
  }

  if (!copyable) {
    return (
      <code
        title={value}
        className={cn(
          'rounded bg-anvil-100 px-1.5 py-0.5 font-mono text-anvil-700 dark:bg-anvil-800 dark:text-anvil-200',
          className,
        )}
      >
        {shown}
      </code>
    )
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={`${value}\n(click to copy)`}
      className={cn(
        'group inline-flex items-center gap-1 rounded bg-anvil-100 px-1.5 py-0.5 font-mono ' +
          'text-anvil-700 transition-colors hover:bg-anvil-200 ' +
          'dark:bg-anvil-800 dark:text-anvil-200 dark:hover:bg-anvil-750',
        className,
      )}
    >
      <span>{shown}</span>
      {copied ? (
        <Check className="h-3 w-3 text-verify" aria-hidden />
      ) : (
        <Copy className="h-3 w-3 text-anvil-400 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
      )}
      <span className="sr-only">{copied ? 'Copied' : 'Copy full identifier'}</span>
    </button>
  )
}
