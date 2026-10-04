'use client'

/**
 * "Repo not found", with somewhere to go (L-61). `dashpay/dash` names a GitHub repo, not a Forge
 * one: its mirror lives under the importer's identity. So the state looks up repos with the same
 * name (one read of the `repo.name` index) and offers them, mirrors of
 * `github.com/<owner>/<name>` first, as their owner-written description says
 * (`mirrorSourceOfDescription`, the same rule the issue lists use). When exactly one repo claims to
 * mirror it (or the showcase vouches for one), `/dashpay/dash` simply opens that mirror (CJ-3).
 */

import { useEffect } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { GitBranch } from 'lucide-react'
import { Author } from '@/components/author'
import { Button } from '@/components/ui/button'
import { EmptyState, LoadingBlock } from '@/components/ui/states'
import { useAsync } from '@/hooks/use-async'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { useSdk } from '@/hooks/use-sdk'
import { reposNamed, type DiscoveredRepo } from '@/lib/view/discovery'
import { mirrorSourceOfDescription } from '@/lib/view/mirror-source'
import { showcaseFor } from '@/lib/view/showcase'
import { mirrorsOf, mirrorToOpen } from '@/lib/view/upstream-alias'
import { ACTIVE_NETWORK } from '@/lib/constants'

/**
 * Repos named like `addr.name`, with the source each mirrors; `exact`: it mirrors
 * `github.com/<owner>/<name>` itself (those first).
 */
function rankSuggestions(addr: RepoAddress, repos: readonly DiscoveredRepo[]): { repo: DiscoveredRepo; mirrorOf: string | null; exact: boolean }[] {
  const wanted = `github.com/${addr.owner}/${addr.name}`.toLowerCase()
  return repos
    .map((repo) => {
      const mirrorOf = mirrorSourceOfDescription(repo.description, 'issue')?.label ?? null
      return { repo, mirrorOf, exact: mirrorOf?.toLowerCase() === wanted }
    })
    .sort((a, b) => Number(b.exact) - Number(a.exact))
}

export function RepoNotFound({ addr }: { addr: RepoAddress }): JSX.Element {
  const { sdk, ready, network } = useSdk()
  const name = addr.name.trim().toLowerCase()
  const found = useAsync(() => reposNamed(sdk!, name, { network }), [ready, name, network], { enabled: ready && sdk !== null && name !== '' })
  const suggestions = found.data ? rankSuggestions(addr, found.data.repos) : []
  // A GitHub address with one clear Forge mirror opens it, as the obvious URL should. Not for a
  // pinned address (`?repo=`), which names one exact repo.
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const showcase = new Set(showcaseFor(ACTIVE_NETWORK.key).map((e) => e.repoId))
  const mirror = found.data && !addr.repoId ? mirrorToOpen(mirrorsOf(addr.owner, addr.name, found.data.repos, showcase), showcase) : null
  useEffect(() => {
    if (mirror === null) return
    // The same page of the mirror (`/dashpay/dash/issues/12` opens the mirror's issue 12).
    const q = new URLSearchParams(params.toString())
    q.set('owner', mirror.ownerId)
    q.set('name', mirror.slug)
    q.set('repo', mirror.key)
    router.replace(`${pathname}?${q.toString()}`)
    // Once per resolved mirror.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mirror?.key])
  // Until the names are read, an unpinned address may still turn out to be a GitHub one: say
  // nothing is missing only once there is no mirror to open.
  if (!addr.repoId && name !== '' && (!found.settled || mirror !== null)) {
    return <LoadingBlock label={mirror !== null ? `Opening the mirror of github.com/${addr.owner}/${addr.name}` : 'Reading from Platform'} />
  }
  return (
    <div className="space-y-4">
      <EmptyState
        icon={GitBranch}
        title="Repo not found"
        body={`No repo ${addr.owner}/${addr.name} exists on this network.`}
        action={
          <Link href={`/explore/?q=${encodeURIComponent(name)}`}>
            <Button variant="primary">Search repos for “{name}”</Button>
          </Link>
        }
      />
      {suggestions.length > 0 ? (
        <section aria-label="Repos with this name" data-testid="repo-suggestions" className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
          <h2 className="mb-2 text-prose">Repos named {name}</h2>
          <ul className="space-y-2">
            {suggestions.map(({ repo, mirrorOf, exact }) => (
              <li key={repo.key} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-dense">
                <Author identityId={repo.ownerId} link={false} />
                <span aria-hidden className="text-anvil-400">/</span>
                <Link
                  href={repoHref('/repo', { owner: repo.ownerId, name: repo.slug, repoId: repo.key })}
                  className="font-mono font-semibold text-forge-800 underline coarse:min-h-11 dark:text-forge-400"
                >
                  {repo.slug}
                </Link>
                {mirrorOf !== null ? (
                  <span className={exact ? 'font-medium text-anvil-800 dark:text-anvil-100' : 'text-anvil-500 dark:text-anvil-400'}>
                    mirror of {mirrorOf}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {found.data?.more ? (
            <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">More owners have a repo with this name; search to see them all.</p>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
