'use client'

import { useState } from 'react'

/** Copy `text` to the clipboard: `[copied, copy]`, `copied` true for a moment after a copy. */
export function useCopy(text: string): [boolean, () => Promise<void>] {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* insecure context: nothing to copy to */
    }
  }
  return [copied, copy]
}
