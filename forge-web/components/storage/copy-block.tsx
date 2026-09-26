'use client'

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

/** A multi-line copyable block (a CORS policy, a few shell lines). */
export function CopyBlock({ text, label }: { text: string; label: string }): JSX.Element {
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
    <div className="relative">
      <pre className="max-h-72 overflow-auto rounded-md border border-anvil-200 bg-white p-3 pr-10 font-mono text-[12px] leading-relaxed text-anvil-800 dark:border-anvil-800 dark:bg-anvil-950 dark:text-anvil-200">
        {text}
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label={label}
        className="absolute right-2 top-2 rounded p-1 text-anvil-500 hover:bg-anvil-100 hover:text-anvil-800 dark:text-anvil-400 dark:hover:bg-anvil-800 dark:hover:text-anvil-100"
      >
        {copied ? <Check className="h-4 w-4 text-verify" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
      </button>
    </div>
  )
}
