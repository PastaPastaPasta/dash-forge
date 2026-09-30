'use client'

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'

/** One copyable monospace line (a command, an address). `display`: what to show instead (a masked secret). */
export function CopyRow({ text, display, label, className }: { text: string; display?: string; label?: string; className?: string }): JSX.Element {
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
      <code className="min-w-0 flex-1 break-all font-mono text-dense text-anvil-800 dark:text-anvil-200">{display ?? text}</code>
      <button
        type="button"
        onClick={copy}
        aria-label={label ?? 'Copy to clipboard'}
        className="flex shrink-0 items-center justify-center rounded p-1 text-anvil-500 dark:text-anvil-400 hover:bg-anvil-200 hover:text-anvil-700 coarse:-my-2.5 coarse:h-11 coarse:w-11 dark:hover:bg-anvil-800"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-verify-700 dark:text-verify-400" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      </button>
    </div>
  )
}
