'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Hash } from 'lucide-react'

import { EmptyState, LoadingBlock } from '@/components/ui/states'
import { useAsync } from '@/hooks/use-async'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { useSdk } from '@/hooks/use-sdk'
import { readMembershipsCached, repoContractIds, repoKey } from '@/lib/repo'
import type { RepoHome } from '@/lib/view'
import { resolveUpstreamNumber } from '@/lib/view/upstream'

/**
 * `?upstream=7761`: a `#7761` in a mirrored body names the source's item. Find the issue or PR
 * a trusted writer recorded with that `upstreamNumber` and go to it; say so when none is here.
 */
export function UpstreamRedirect({ home, addr, upstream }: { home: RepoHome; addr?: RepoAddress; upstream: number }): JSX.Element {
  const { sdk, ready, network } = useSdk(repoContractIds(home.repo))
  const router = useRouter()
  const { data, settled, error } = useAsync(
    async () => resolveUpstreamNumber(sdk!, home.repo, upstream, await readMembershipsCached(sdk!, home.repo, network)),
    [ready, repoKey(home.repo), upstream, network],
    { enabled: ready && sdk !== null },
  )
  const [went, setWent] = useState(false)
  useEffect(() => {
    if (data == null || addr === undefined || went) return
    setWent(true)
    router.replace(repoHref(data.type === 'issue' ? '/repo/issue' : '/repo/pull', addr, { number: String(data.number) }))
  }, [data, addr, router, went])
  if (error) return <EmptyState icon={Hash} title={`Upstream #${upstream}`} body="Couldn't look it up here. Try again later." />
  if (!settled || (data !== null && !went)) return <LoadingBlock label={`Finding upstream #${upstream}`} />
  if (data === null) return <EmptyState icon={Hash} title={`Upstream #${upstream} is not mirrored here`} body="No issue or pull request in this repo records that source number." />
  return <LoadingBlock label={`Opening #${data.number}`} />
}
