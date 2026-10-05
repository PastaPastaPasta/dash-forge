'use client'

/**
 * "Repo not found", with somewhere to go (L-61). `dashpay/dash` names a GitHub repo, not a Forge
 * one: its mirror lives under the importer's identity. So the state looks up repos with the same
 * name (one read of the `repo.name` index, with their proved star counts) and offers them.
 *
 * A repo description that says it mirrors `github.com/<owner>/<name>` is its owner's own word,
 * and anyone can write it for the price of a repo (TS-01). So a claim never ranks a repo higher
 * and is shown as "says it mirrors", plainly. The viewer can check the claims with GitHub
 * (`lib/view/mirror-check.ts`): a repo the source's `.dash-forge.json` lists then reads "mirror
 * of", and comes first when that source is the address asked for (`github.com/<owner>/<name>`);
 * anyone can list their own repo in a look-alike source. Otherwise the order is stars, then age
 * (the older first).
 *
 * When the owner is no Forge identity (not an id, not a DPNS name) and one mirror is clear
 * (`matchUpstream`: the only claim among every repo of that name, or the one the showcase vouches
 * for), `/dashpay/dash` simply opens it, on the same page (CJ-3). A real Forge user's address is
 * never handed to a repo that merely claims to mirror a GitHub repo of the same name.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { CheckCircle2, GitBranch, Star } from 'lucide-react'
import { Author } from '@/components/author'
import { Button } from '@/components/ui/button'
import { EmptyState, LoadingBlock } from '@/components/ui/states'
import { useAsync } from '@/hooks/use-async'
import { isIdentityId } from '@/lib/utils'
import { resolveDpnsId } from '@/lib/view/dpns'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { useSdk } from '@/hooks/use-sdk'
import { reposNamed, type DiscoveredRepo } from '@/lib/view/discovery'
import { checkMirrorClaim, githubRepoOf, type MirrorCheck } from '@/lib/view/mirror-check'
import { mirrorSourceOfDescription, type MirrorSource } from '@/lib/view/mirror-source'
import { matchUpstream } from '@/lib/view/upstream-alias'

/** Claims checked at most, per click: each is one request to GitHub. */
const CHECK_MAX = 10

const NO_CHECKS: ReadonlyMap<string, MirrorCheck> = new Map()

export interface Suggestion {
  readonly repo: DiscoveredRepo
  readonly source: MirrorSource | null
  /** The source lists it (checked with GitHub). */
  readonly vouched: boolean
  /** Vouched for by the very source the address names: these come first. */
  readonly vouchedForAddress: boolean
}

/**
 * Repos named like the address, with the source each says it mirrors: the ones the address's
 * own GitHub repo lists first (once checked), then by stars, then the oldest. A claim alone, or
 * a look-alike source that lists its own repo, moves nothing.
 */
export function rankSuggestions(addr: RepoAddress, repos: readonly DiscoveredRepo[], checks: ReadonlyMap<string, MirrorCheck>): Suggestion[] {
  const wanted = `github.com/${addr.owner}/${addr.name}`.toLowerCase()
  return repos
    .map((repo) => {
      const source = mirrorSourceOfDescription(repo.description, 'issue')
      const vouched = checks.get(repo.key)?.backlink.kind === 'listed'
      return { repo, source, vouched, vouchedForAddress: vouched && source?.label.toLowerCase() === wanted }
    })
    .sort(
      (a, b) =>
        Number(b.vouchedForAddress) - Number(a.vouchedForAddress) ||
        (b.repo.stars ?? -1) - (a.repo.stars ?? -1) ||
        a.repo.createdAt - b.repo.createdAt ||
        a.repo.key.localeCompare(b.repo.key),
    )
}

function ClaimText({ s, check }: { s: Suggestion; check: MirrorCheck | undefined }): JSX.Element | null {
  if (s.source === null) return null
  if (s.vouched) {
    return (
      <span className="inline-flex items-center gap-1 text-verify-700 dark:text-verify-400" data-testid="suggestion-claim" data-vouched="true">
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
        mirror of {s.source.label}, listed there
      </span>
    )
  }
  const note = check === undefined ? '' : check.backlink.kind === 'failed' ? ' (couldn\u2019t check)' : ' (not listed there)'
  return (
    <span className="text-anvil-500 dark:text-anvil-400" data-testid="suggestion-claim" data-vouched="false">
      says it mirrors {s.source.label}
      {note}
    </span>
  )
}

export function RepoNotFound({ addr }: { addr: RepoAddress }): JSX.Element {
  const { sdk, ready, network } = useSdk()
  const name = addr.name.trim().toLowerCase()
  const found = useAsync(() => reposNamed(sdk!, name, { network }), [ready, name, network], { enabled: ready && sdk !== null && name !== '' })
  // The answers for this address only: another missing address starts unchecked.
  const [checked, setChecked] = useState<{ readonly name: string; readonly checks: ReadonlyMap<string, MirrorCheck> }>({ name, checks: new Map() })
  const checks = checked.name === name ? checked.checks : NO_CHECKS
  const [checking, setChecking] = useState(false)
  const suggestions = found.data ? rankSuggestions(addr, found.data.repos, checks) : []
  const claims = suggestions.filter((s) => s.source !== null && githubRepoOf(s.source) !== null).slice(0, CHECK_MAX)
  // Offered until every claim has an answer: a failed check can be asked again.
  const unanswered = claims.some((s) => {
    const c = checks.get(s.repo.key)
    return c === undefined || c.backlink.kind === 'failed'
  })

  // A GitHub address with one clear Forge mirror opens it, as the obvious URL should: only when
  // the owner is no Forge identity (an id, or a DPNS name that resolves, is a Forge user's own
  // address), and never for a pinned address (`?repo=`), which names one exact repo. The repo read
  // already resolved the name, so the DPNS answer is cached.
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const githubLike = !addr.repoId && name !== '' && !isIdentityId(addr.owner)
  const forgeOwner = useAsync(() => resolveDpnsId(sdk!, addr.owner, network), [ready, addr.owner, network], { enabled: githubLike && ready && sdk !== null })
  const mirror = githubLike && found.data && forgeOwner.settled && forgeOwner.data === null ? matchUpstream(addr.owner, addr.name, found.data).open : null
  useEffect(() => {
    if (mirror === null) return
    // The same page of the mirror (`/dashpay/dash/issues/12` opens the mirror's issue 12), with
    // its fragment (`#L10`).
    const q = new URLSearchParams(params.toString())
    q.set('owner', mirror.ownerId)
    q.set('name', mirror.slug)
    q.set('repo', mirror.key)
    router.replace(`${pathname.endsWith('/') ? pathname : `${pathname}/`}?${q.toString()}${window.location.hash}`)
    // Once per resolved mirror.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mirror?.key])
  // Until the names are read, an unpinned address may still turn out to be a GitHub one: say
  // nothing is missing only once there is no mirror to open.
  if (githubLike && (!found.settled || !forgeOwner.settled || mirror !== null)) {
    return <LoadingBlock label={mirror !== null ? `Opening the mirror of github.com/${addr.owner}/${addr.name}` : 'Reading from Platform'} />
  }

  const checkClaims = (): void => {
    const asked = name
    setChecking(true)
    void Promise.all(
      claims.map(async (s) => {
        const c = await checkMirrorClaim(s.source as MirrorSource, s.repo.key, null)?.catch(() => null)
        return c === null || c === undefined ? null : ([s.repo.key, c] as const)
      }),
    )
      .then((done) => setChecked({ name: asked, checks: new Map(done.filter((d) => d !== null)) }))
      .finally(() => setChecking(false))
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
            {suggestions.map((s) => (
              <li key={s.repo.key} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-dense">
                <Author identityId={s.repo.ownerId} link={false} />
                <span aria-hidden className="text-anvil-400">/</span>
                <Link
                  href={repoHref('/repo', { owner: s.repo.ownerId, name: s.repo.slug, repoId: s.repo.key })}
                  className="font-mono font-semibold text-forge-800 underline coarse:min-h-11 dark:text-forge-400"
                >
                  {s.repo.slug}
                </Link>
                {typeof s.repo.stars === 'number' && s.repo.stars > 0 ? (
                  <span className="inline-flex items-center gap-0.5 text-anvil-500 dark:text-anvil-400" title={`${s.repo.stars} stars`}>
                    <Star className="h-3 w-3" aria-hidden />
                    {s.repo.stars}
                    <span className="sr-only"> stars</span>
                  </span>
                ) : null}
                <ClaimText s={s} check={checks.get(s.repo.key)} />
              </li>
            ))}
          </ul>
          {unanswered ? (
            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-anvil-500 dark:text-anvil-400">
              <Button variant="outline" size="sm" onClick={checkClaims} loading={checking} data-testid="suggestions-check">
                Check mirror claims with GitHub
              </Button>
              <span>Anyone can say their repo is a mirror. A source confirms it by listing the repo in its {'.dash-forge.json'}. Optional; your browser asks github.com.</span>
            </div>
          ) : null}
          {found.data?.more ? (
            <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">More owners have a repo with this name; search to see them all.</p>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
