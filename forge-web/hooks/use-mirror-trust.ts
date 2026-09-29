'use client'

/**
 * The identities whose `imported` records a repo page believes (FG-6): the repo owner and its
 * current maintainers, the trust set of the mirror note and issue numbering
 * (`readNumberTrust`). Anyone may write an imported author or date into their own issue, so
 * only these are shown as the original author and date; everything else shows its signer.
 *
 * `null` while unknown: callers then show the signer and the chain time, as before.
 */

import { useMemo } from 'react'
import { useAsync } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { readNumberTrust, repoContractIds, repoKey, type RepoRef } from '@/lib/repo'

export function useMirrorTrust(repo: RepoRef): ReadonlySet<string> | null {
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const { data } = useAsync(() => readNumberTrust(sdk!, repo, network), [ready, repoKey(repo), network], {
    enabled: ready && sdk !== null,
  })
  return useMemo(() => (data ? new Set(data) : null), [data])
}
