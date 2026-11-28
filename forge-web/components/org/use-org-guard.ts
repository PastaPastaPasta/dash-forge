'use client'

import { useCallback } from 'react'

import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { DEFAULT_NETWORK, NETWORKS } from '@/lib/constants'
import type { CostPreview } from '@/lib/sdk'
import { orgWriteScope } from '@/lib/org/transport'

/**
 * The write guard for a member's own forge-org writes: one held key must cover the whole Forge
 * group, since a forge-org write is signed by a single key (keys bound to single Forge contracts
 * each cover only theirs). Without one, the sign-in sheet offers to replace the key.
 */
export function useOrgWriteGuard(): (need: CostPreview, action: string) => boolean {
  const guard = useWriteGuard()
  const { groupKey, unlockScope } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)
  return useCallback(
    (need, action) => {
      if (!guard.check(need, orgWriteScope(NETWORKS[DEFAULT_NETWORK].v2), action)) return false
      if (groupKey !== false) return true
      openLogin(unlockScope === 'signing' ? 'unlock' : 'wallet-replace')
      return false
    },
    [guard, groupKey, unlockScope, openLogin],
  )
}
