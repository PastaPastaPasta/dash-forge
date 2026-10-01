'use client'

/**
 * useStarShape — the deployment's star shape (`lib/repo/star-shape.ts`, RC2 C1), or null while
 * it is read or when the read fails (then a caller offers what both shapes share).
 */

import type { ForgeIds } from '@/lib/deployments'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { starShape, type StarShape } from '@/lib/repo/star-shape'

export function useStarShape(forge: ForgeIds | null): StarShape | null {
  const { sdk, ready } = useSdk()
  const { data } = useAsync<StarShape>(() => starShape(sdk!, forge!), [forge?.community ?? ''], { enabled: ready && sdk !== null && forge !== null })
  return data
}
