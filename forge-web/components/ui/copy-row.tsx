'use client'

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'

/** One copyable monospace line (a command, an address). */
export function CopyRow({ text, label, className }: { text: string; label?: string; className?: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* insecure context: the text is still selectable */
    }
  }
  return (
    <div
      className={cn(
        'mb-1.5 flex items-center gap-2 rounded-md border border-anvil-200 bg-anvil-50 px-2 py-1.5 dark:border-anvil-800 dark:bg-anvil-950',
        className,
      )}
    >
      <code className="min-w-0 flex-1 break-all font-mono text-dense text-anvil-800 dark:text-anvil-200">{text}</code>
      <button
        type="button"
        onClick={copy}
        aria-label={label ?? `Copy ${text}`}
        className="shrink-0 rounded p-1 text-anvil-400 hover:bg-anvil-200 hover:text-anvil-700 dark:hover:bg-anvil-800"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-verify" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      </button>
    </div>
  )
}
