'use client'

/**
 * FollowListContent — who follows an identity (`/u/followers?name=`) or whom it follows
 * (`/u/following?name=`), from forge-collab `follow` (L-36). `follow` is indexOnly: each page
 * is one proof-verified keyset read (`readFollowPage`), "Load more" continues after the last
 * id, and the list is in identity-id order (a follow carries no time). Each page's DPNS names
 * are read in one batch before it shows, so the pills render with names.
 */

import { useState } from 'react'
import Link from 'next/link'
import { Users } from 'lucide-react'

import { plural, prefetchDpnsNames, resolveDpnsName } from '@/lib/view'
import { readFollowCounts, readFollowPage, resolveOwner, type FollowPage, type FollowSide } from '@/lib/repo'
import { NETWORKS } from '@/lib/constants'
import { cn, errorMessage } from '@/lib/utils'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { Author } from '@/components/author'
import { Button } from '@/components/ui/button'
import { IdentityPill } from '@/components/ui/identity-pill'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { NotDeployedState, isForgeDeployed } from '@/components/ui/network-badge'

/** Each list's words: its title, its count's noun, and its empty state. */
const SIDE: Readonly<Record<FollowSide, { title: string; one: string; many?: string; emptyTitle: string; emptyBody: string }>> = {
  followers: { title: 'Followers', one: 'follower', emptyTitle: 'No followers yet', emptyBody: 'Nobody follows this identity on this network.' },
  following: { title: 'Following', one: 'following', many: 'following', emptyTitle: 'Not following anyone yet', emptyBody: 'This identity follows nobody on this network.' },
}

interface FirstPage extends FollowPage {
  readonly identityId: string
  readonly name: string | null
  readonly counts: { readonly followers: number | null; readonly following: number | null }
}

/** The pages "Load more" read, and its last failure, for one network and address. */
interface More {
  readonly key: string
  readonly pages: readonly FollowPage[]
  readonly error: string | null
}

export function FollowListContent({ address, side }: { address: string; side: FollowSide }): JSX.Element {
  const { sdk, ready, network } = useSdk()
  const forge = NETWORKS[network].v2
  // Each side is its own route, so a side change remounts this: the key needs no side.
  const key = `${network}:${address}`
  const [stored, setMore] = useState<More>({ key, pages: [], error: null })
  const more: More = stored.key === key ? stored : { key, pages: [], error: null }
  const [loadingMore, setLoadingMore] = useState(false)

  const withNames = async (page: FollowPage): Promise<FollowPage> => {
    await prefetchDpnsNames(sdk!, page.ids, network)
    return page
  }

  const { data, loading, error, reload } = useAsync<FirstPage | null>(
    async () => {
      // The address may be a DPNS name or an identity id, as on the profile.
      const identityId = await resolveOwner(sdk!, address)
      if (identityId === null) return null
      const [name, counts, page] = await Promise.all([
        resolveDpnsName(sdk!, identityId, network),
        readFollowCounts(sdk!, forge!, identityId),
        readFollowPage(sdk!, forge!, identityId, side).then(withNames),
      ])
      return { identityId, name, counts, ...page }
    },
    [ready, address, side, network],
    { enabled: isForgeDeployed() && forge !== null && ready && sdk !== null && address !== '' },
  )

  const next = more.pages.length > 0 ? more.pages[more.pages.length - 1]!.next : data?.next ?? null
  const loadMore = async (): Promise<void> => {
    if (!data || next === null || loadingMore) return
    setLoadingMore(true)
    try {
      const page = await withNames(await readFollowPage(sdk!, forge!, data.identityId, side, next))
      setMore({ key, pages: [...more.pages, page], error: null })
    } catch (e) {
      setMore({ ...more, error: errorMessage(e) })
    } finally {
      setLoadingMore(false)
    }
  }

  const words = SIDE[side]
  if (!address) return <EmptyState icon={Users} title="No profile addressed" body="Add ?name= (an identity id or DPNS name) to the URL." />
  if (!isForgeDeployed() || forge === null) return <NotDeployedState />
  if (loading && !data) return <LoadingBlock label={`Reading ${words.title.toLowerCase()}`} />
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (data === null && ready) {
    return <EmptyState icon={Users} title="No such identity" body={`"${address}" is not an identity id or a registered DPNS name on this network.`} />
  }
  if (!data) return <LoadingBlock />

  const ids = [...data.ids, ...more.pages.flatMap((p) => p.ids)]
  const tab = (s: FollowSide): JSX.Element => {
    const count = data.counts[s]
    return (
      <Link
        href={`/u/${s}?name=${encodeURIComponent(data.identityId)}`}
        aria-current={s === side ? 'page' : undefined}
        className={cn(
          'hit-area rounded-md px-3 py-1.5 text-dense',
          s === side ? 'bg-anvil-100 font-medium text-anvil-900 dark:bg-anvil-800 dark:text-anvil-50' : 'text-anvil-600 hover:text-forge-700 dark:text-anvil-300 dark:hover:text-forge-400',
        )}
      >
        {count === null ? SIDE[s].title : plural(count, SIDE[s].one, SIDE[s].many)}
      </Link>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/u?name=${encodeURIComponent(data.identityId)}`} className="hit-area rounded-full">
          <IdentityPill identityId={data.identityId} name={data.name ?? undefined} className="text-prose" />
        </Link>
        <h1 className="text-prose">{words.title}</h1>
        <nav aria-label="Follow lists" className="ml-auto flex items-center gap-1">
          {tab('followers')}
          {tab('following')}
        </nav>
      </div>

      {ids.length === 0 ? (
        <EmptyState icon={Users} title={words.emptyTitle} body={words.emptyBody} />
      ) : (
        <ul aria-label={words.title} className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800" data-testid="follow-list">
          {ids.map((id) => (
            <li key={id} className="flex items-center gap-3 border-b border-anvil-100 px-4 py-2.5 last:border-b-0 dark:border-anvil-850" data-testid="follow-row" data-identity={id}>
              <Author identityId={id} link />
            </li>
          ))}
        </ul>
      )}

      {next !== null ? (
        <div className="flex flex-col items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void loadMore()} loading={loadingMore}>
            Load more
          </Button>
          {more.error ? (
            <p role="alert" className="text-dense text-danger-700 dark:text-danger-400">
              {more.error}
            </p>
          ) : null}
        </div>
      ) : null}
      {ids.length > 0 ? <p className="text-[12px] text-anvil-500 dark:text-anvil-400">In identity-id order: a follow records no time.</p> : null}
    </div>
  )
}
