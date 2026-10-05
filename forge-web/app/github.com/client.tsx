'use client'

/**
 * The Forge mirror of `github.com/<owner>/<name>` (CJ-3). One read of the `repo.name` index finds
 * the repos with that name; the ones whose owner describes them as that repo's mirror are the
 * candidates (`lib/view/upstream-alias.ts`). One clear mirror opens straight away (with the rest
 * of a GitHub path, the same view of it); several are listed; none explains how to mirror it.
 */

import { useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { CopyPlus, ExternalLink, GitBranch } from 'lucide-react'
import { Author } from '@/components/author'
import { Button } from '@/components/ui/button'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { NotDeployedState, isForgeDeployed } from '@/components/ui/network-badge'
import { UnreachableBanner } from '@/components/ui/platform-status'
import { useAsync } from '@/hooks/use-async'
import { repoHref, useParam } from '@/hooks/use-query-param'
import { useSdk } from '@/hooks/use-sdk'
import { BASE_PATH, shortRepoPath } from '@/lib/short-url'
import { NAMED_MAX, reposNamed, type DiscoveredRepo } from '@/lib/view/discovery'
import { mapsToRepoPage, matchUpstream, SHOWCASE_IDS } from '@/lib/view/upstream-alias'

/** The short-URL shim is not in the IPFS variant, so a GitHub sub-path opens the mirror's home there. */
const SHIM = process.env.FORGE_IPFS_BUILD !== '1'

function open(router: ReturnType<typeof useRouter>, repo: DiscoveredRepo, rest: string): void {
  if (rest !== '' && SHIM && mapsToRepoPage(rest)) {
    // The shim maps the GitHub-style rest (`issues/12`, `tree/main/src`) onto the mirror's page,
    // pinned to this repo, with the GitHub URL's own query (`?q=…`) and fragment (`#L120`).
    const query = new URLSearchParams(window.location.search)
    for (const k of ['owner', 'name', 'rest']) query.delete(k)
    query.set('repo', repo.key)
    window.location.replace(`${BASE_PATH}${shortRepoPath({ owner: repo.ownerId, name: repo.slug })}/${rest}?${query.toString()}${window.location.hash}`)
    return
  }
  router.replace(repoHref('/repo', { owner: repo.ownerId, name: repo.slug, repoId: repo.key }))
}

export function UpstreamAliasClient(): JSX.Element {
  const owner = useParam('owner').trim()
  const name = useParam('name').trim()
  const rest = useParam('rest').replace(/^\/+|\/+$/g, '')
  const router = useRouter()
  const { sdk, ready, network, status, retry } = useSdk()
  const deployed = isForgeDeployed()
  const valid = owner !== '' && name !== ''
  const found = useAsync(() => reposNamed(sdk!, name.toLowerCase(), { network }), [ready, name, network], {
    enabled: deployed && valid && ready && sdk !== null,
  })
  const match = found.data ? matchUpstream(owner, name, found.data) : null
  const mirrors = match?.mirrors ?? null
  const target = match?.open ?? null
  const source = `github.com/${owner}/${name}`

  useEffect(() => {
    if (target !== null) open(router, target, rest)
    // Once per resolved target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.key])

  if (!valid) {
    return (
      <EmptyState
        icon={GitBranch}
        heading="h1"
        title="Open a GitHub repo’s mirror"
        body="Put a GitHub address after this site’s, as in /github.com/dashpay/dash, to open its mirror on Forge."
        action={
          <Link href="/mirror/">
            <Button variant="primary">
              <CopyPlus className="h-4 w-4" aria-hidden /> Mirror a GitHub repo
            </Button>
          </Link>
        }
      />
    )
  }
  if (!deployed) return <NotDeployedState />
  if (status.phase === 'error' && found.data === null) return <UnreachableBanner status={status} onRetry={retry} />
  if (found.error) return <ErrorState message={found.error} onRetry={found.reload} />
  if (mirrors === null || target !== null) return <LoadingBlock label={target !== null ? `Opening the mirror of ${source}` : `Looking for a mirror of ${source}`} />

  if (mirrors.length === 0 && match?.partial) {
    // More repos share the name than one read holds: a mirror could be among the rest.
    return (
      <EmptyState
        icon={GitBranch}
        heading="h1"
        title={`No mirror of ${source} found yet`}
        body={`None of the first ${NAMED_MAX} repos named ${name.toLowerCase()} mirrors it. Search to see the rest.`}
        action={
          <Link href={`/explore/?q=${encodeURIComponent(name.toLowerCase())}`}>
            <Button variant="primary">Search repos named {name.toLowerCase()}</Button>
          </Link>
        }
      />
    )
  }

  if (mirrors.length === 0) {
    return (
      <EmptyState
        icon={GitBranch}
        heading="h1"
        title={`${source} isn’t mirrored here yet`}
        body="A mirror is a copy on Forge that nobody can take down, kept in sync by a GitHub Action on every push."
        action={
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link href={`/mirror/?repo=${encodeURIComponent(`${owner}/${name}`)}`} data-testid="alias-mirror">
              <Button variant="primary">
                <CopyPlus className="h-4 w-4" aria-hidden /> Mirror {owner}/{name}
              </Button>
            </Link>
            <a href={`https://${source}`} target="_blank" rel="noreferrer noopener" className="hit-area inline-flex items-center gap-1 text-dense text-forge-700 underline dark:text-forge-400">
              Open it on GitHub <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          </div>
        }
      />
    )
  }

  return (
    <section aria-labelledby="alias-heading" className="mx-auto max-w-3xl space-y-3" data-testid="alias-mirrors">
      <h1 id="alias-heading" className="text-2xl">
        Repos that say they mirror {source}
      </h1>
      <p className="text-dense text-anvil-600 dark:text-anvil-300">
        Anyone can describe a repo as a mirror, so check who owns one before you rely on it.
      </p>
      <ul className="divide-y divide-anvil-200 rounded-lg border border-anvil-200 dark:divide-anvil-800 dark:border-anvil-800">
        {mirrors.map((m) => (
          <li key={m.key} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 text-dense">
            <Author identityId={m.ownerId} link={false} />
            <span aria-hidden className="text-anvil-400">/</span>
            <Link
              href={repoHref('/repo', { owner: m.ownerId, name: m.slug, repoId: m.key })}
              className="font-mono font-semibold text-forge-800 underline coarse:min-h-11 dark:text-forge-400"
            >
              {m.slug}
            </Link>
            {SHOWCASE_IDS.has(m.key) ? <span className="text-anvil-500 dark:text-anvil-400">featured on this site</span> : null}
          </li>
        ))}
      </ul>
      {found.data?.more ? (
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
          More owners have a repo named {name.toLowerCase()};{' '}
          <Link href={`/explore/?q=${encodeURIComponent(name.toLowerCase())}`} className="underline">
            search them all
          </Link>
          .
        </p>
      ) : null}
    </section>
  )
}
