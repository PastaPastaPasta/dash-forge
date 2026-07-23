'use client'

/**
 * useRepoHome — resolve + compose a repo's home view-model from `(owner, name)`.
 *
 * Connects the SDK (registry + DPNS preloaded), resolves the repo through the registry with
 * listing-authenticity verification, and loads config + refs + star count. Returns the async
 * state the repo chrome renders. `notFound` distinguishes an unresolved repo from a read error.
 */

import { useSdk } from '@/hooks/use-sdk'
import { useAsync, type AsyncState } from '@/hooks/use-async'
import { loadRepoHome, type RepoHome } from '@/lib/view'
import type { Network } from '@/lib/constants'

export interface UseRepoResult extends AsyncState<RepoHome | null> {
  readonly ready: boolean
  readonly sdkError: string | null
  readonly network: Network
}

export function useRepoHome(owner: string, name: string): UseRepoResult {
  const { sdk, ready, error: sdkError, network } = useSdk()
  const enabled = ready && sdk !== null && owner !== '' && name !== ''
  const state = useAsync<RepoHome | null>(
    () => loadRepoHome(sdk!, { network, ownerId: owner, name }),
    [ready, owner, name, network],
    { enabled },
  )
  return { ...state, ready, sdkError, network }
}
