'use client'

/**
 * useFirstWrite — which index subtrees a write the page offers would create
 * (`lib/repo/first-write.ts`), read once per page and key. Until the answer is in, or when a
 * read fails, it is `{}`: every surcharge counted, so the preview is an upper bound from the
 * first paint and only tightens (D-011).
 */

import type { FirstWrite } from '@/lib/sdk'
import { useAsync } from '@/hooks/use-async'

export function useFirstWrite(read: () => Promise<FirstWrite>, key: readonly unknown[], enabled: boolean): FirstWrite {
  const { data } = useAsync<FirstWrite>(read, key, { enabled })
  return data ?? {}
}
