'use client'

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { ScrollRegion } from '@/components/ui/scroll-region'

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
    // The Copy button sits in a bar above the text, never over it (QW4-045: on a phone it
    // covered the first YAML line, which scrolls sideways under an overlaid button).
    <div className="overflow-hidden rounded-md border border-anvil-200 bg-white dark:border-anvil-800 dark:bg-anvil-950">
      <div className="flex justify-end border-b border-anvil-200 px-1 py-0.5 dark:border-anvil-800">
        <button
          type="button"
          onClick={copy}
          aria-label={label}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[12px] text-anvil-600 hover:bg-anvil-100 hover:text-anvil-800 coarse:min-h-11 dark:text-anvil-300 dark:hover:bg-anvil-800 dark:hover:text-anvil-100"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-verify-700 dark:text-verify-400" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
          <span aria-hidden>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <ScrollRegion as="pre" label={label} className="max-h-72 overflow-auto p-3 font-mono text-[12px] leading-relaxed text-anvil-800 dark:text-anvil-200">
        {text}
      </ScrollRegion>
    </div>
  )
}
