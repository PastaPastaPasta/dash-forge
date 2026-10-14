'use client'

/**
 * useBotRole — whether the deployment's forge-core admits the Bot role (`writer.role` up to 4,
 * the mainnet registration; `lib/repo/contract-shape.ts` `contractAdmitsBots`). False while it is
 * read, when the read fails, and on sakura's live contracts: Bot is offered only where it can be
 * granted.
 */

import type { ForgeIds } from '@/lib/deployments'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { contractAdmitsBots } from '@/lib/repo/contract-shape'

export function useBotRole(forge: ForgeIds | null): boolean {
  const { sdk, ready } = useSdk()
  const { data } = useAsync<boolean>(() => contractAdmitsBots(sdk!, forge!.core), [forge?.core ?? ''], { enabled: ready && sdk !== null && forge !== null })
  return data === true
}
