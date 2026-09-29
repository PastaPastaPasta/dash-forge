'use client'

/**
 * "Repo not found", with somewhere to go (L-61). `dashpay/dash` names a GitHub repo, not a Forge
 * one: its mirror lives under the importer's identity. So the state looks up repos with the same
 * name (one read of the `repo.name` index) and offers them, mirrors of
 * `github.com/<owner>/<name>` first, as their owner-written description says
 * (`mirrorSourceOfDescription`, the same rule the issue lists use).
 */

import Link from 'next/link'
import { GitBranch } from 'lucide-react'
import { Author } from '@/components/author'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/states'
import { useAsync } from '@/hooks/use-async'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { useSdk } from '@/hooks/use-sdk'
import { reposNamed, type DiscoveredRepo } from '@/lib/view/discovery'
import { mirrorSourceOfDescription } from '@/lib/view/mirror-source'

/** Repos named like `addr.name`, mirrors of `github.com/<owner>/<name>` first, with which is which. */
export function rankSuggestions(addr: RepoAddress, repos: readonly DiscoveredRepo[]): { repo: DiscoveredRepo; mirrorOf: string | null }[] {
  const wanted = `github.com/${addr.owner}/${addr.name}`.toLowerCase()
  return repos
    .map((repo) => ({ repo, mirrorOf: mirrorSourceOfDescription(repo.description, 'issue')?.label ?? null }))
    .sort((a, b) => Number(b.mirrorOf?.toLowerCase() === wanted) - Number(a.mirrorOf?.toLowerCase() === wanted))
}

export function RepoNotFound({ addr }: { addr: RepoAddress }): JSX.Element {
  const { sdk, ready, network } = useSdk()
  const name = addr.name.trim().toLowerCase()
  const found = useAsync(() => reposNamed(sdk!, name, { network }), [ready, name, network], { enabled: ready && sdk !== null && name !== '' })
  const suggestions = found.data ? rankSuggestions(addr, found.data.repos) : []
  const wanted = `github.com/${addr.owner}/${addr.name}`.toLowerCase()
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
            {suggestions.map(({ repo, mirrorOf }) => (
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
                  <span className={mirrorOf.toLowerCase() === wanted ? 'font-medium text-anvil-800 dark:text-anvil-100' : 'text-anvil-500 dark:text-anvil-400'}>
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
