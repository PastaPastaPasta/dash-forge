'use client'

/**
 * The intent token of a composer's current draft: one per draft, kept across retries of its
 * submission (a retry finishes the first attempt instead of posting twice), renewed once the
 * draft is posted.
 */

import { useCallback, useState } from 'react'
import { newIntent } from '@/lib/sdk'

export function useIntent(): { readonly intent: string; readonly renew: () => void } {
  const [intent, setIntent] = useState(newIntent)
  const renew = useCallback(() => setIntent(newIntent()), [])
  return { intent, renew }
}
