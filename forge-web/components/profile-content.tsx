'use client'

/**
 * ProfileContent — an identity's profile: the identity pill (DPNS-resolved), follower/following
 * counts (O(1) forge-collab count trees), a follow/unfollow toggle, and the repos it owns. The
 * `name` address is an identity id (what authors + search resolve to).
 *
 * The follow toggle reads whether the viewer already follows this identity before offering an
 * action, and shows read/write failures instead of swallowing them. A follow is a signed, paid
 * write, so it goes through the standard write flow (D-048, `ux-dx-spec.md` §4): its cost on the
 * button, the write guard (sign-in, grant, the funds check with the top-up sheet), then the
 * confirm dialog; an unfollow confirms its refund the same way.
 */

import { useState } from 'react'
import Link from 'next/link'

import { GitBranch, UserPlus, Users } from 'lucide-react'
import type { DiscoveredRepo } from '@/lib/view'
import { listReposByOwner, resolveDpnsName } from '@/lib/view'
import { followFirsts, followRelation, readFollowCounts, resolveOwner } from '@/lib/repo'
import { firstWriteRead, previewCreate, previewDelete } from '@/lib/sdk'
import { priceLabel, refundLabel } from '@/lib/view/format'
import { UsernameHint } from '@/components/username-hint'
import { useDpnsLookup } from '@/hooks/use-dpns-name'
import { cn } from '@/lib/utils'
import { NETWORKS } from '@/lib/constants'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useRelationToggle } from '@/hooks/use-relation-toggle'
import { useAuth } from '@/contexts/auth-context'
import { useFirstWrite } from '@/hooks/use-first-write'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { IdentityPill } from '@/components/ui/identity-pill'
import { RepoCard } from '@/components/repo-card'
import { Button } from '@/components/ui/button'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { NotDeployedState, isForgeDeployed } from '@/components/ui/network-badge'

interface ProfileData {
  /** The identity id the address resolved to (it may have been a DPNS name). */
  readonly identityId: string
  readonly name: string | null
  readonly repos: DiscoveredRepo[]
  /** Repos this identity is a maintainer or writer of (and does not own). */
  readonly memberOf: DiscoveredRepo[]
  /** `null` when the count read failed — shown as unknown, never as a false 0. */
  readonly followers: number | null
  readonly following: number | null
}

/**
 * A count and its noun (`1 follower`, `3 repos`), or a dash (with the reason on hover) and the
 * plural noun when it could not be read. With `href`, the whole phrase links to its list.
 */
function Count({ value, one, many, href }: { value: number | null; one: string; many?: string; href?: string }): JSX.Element {
  const phrase = (
    <>
      <span className="font-semibold text-anvil-900 dark:text-anvil-50" title={value === null ? "Couldn't read this count from Platform" : undefined}>
        {value === null ? '–' : value.toLocaleString('en-US')}
      </span>{' '}
      {value === 1 ? one : (many ?? `${one}s`)}
    </>
  )
  if (href === undefined) return <span>{phrase}</span>
  return (
    <Link href={href} className="hit-area rounded hover:text-forge-700 dark:hover:text-forge-400">
      {phrase}
    </Link>
  )
}

export function ProfileContent({ identityId: address }: { identityId: string }): JSX.Element {
  const { sdk, ready, network } = useSdk()
  const { identity, signer } = useAuth()
  const guard = useWriteGuard()
  const [confirming, setConfirming] = useState(false)
  // First-write reads only once the viewer points at Follow (a page view costs no reads).
  const [interested, setInterested] = useState(false)

  const { data, loading, error, reload } = useAsync<ProfileData | null>(
    async () => {
      // The address may be a DPNS name (`/u?name=alice`) or an identity id.
      const identityId = await resolveOwner(sdk!, address)
      if (identityId === null) return null
      const forge = NETWORKS[network].v2
      const noCounts = { followers: null, following: null }
      const follows = forge !== null ? readFollowCounts(sdk!, forge, identityId).catch(() => noCounts) : noCounts
      const [name, repos, counts] = await Promise.all([
        resolveDpnsName(sdk!, identityId, network),
        listReposByOwner(sdk!, identityId, { network, counts: true }),
        follows,
      ])
      return { identityId, name, repos: repos.owned, memberOf: repos.member, ...counts }
    },
    [ready, address, network],
    { enabled: isForgeDeployed() && ready && sdk !== null && address !== '' },
  )
  const identityId = data?.identityId ?? address
  // Follows live in forge-community.
  const forge = NETWORKS[network].v2
  const canFollow = forge !== null

  const isSelf = identity === identityId
  // Your own name, read so that a failed read is not taken for none (the hint below).
  const ownName = useDpnsLookup(isSelf ? identityId : '')
  const follow = useRelationToggle({
    enabled: canFollow && ready && sdk !== null && identity !== null && identityId !== '' && !isSelf,
    key: `${network}:${identity ?? ''}:${identityId}`,
    ...followRelation(sdk!, signer, identity ?? '', forge, identityId),
    onError: guard.failed,
  })

  const following = follow.on === true
  const first = useFirstWrite(
    () => followFirsts(sdk!, forge!.community, identity!, identityId, data?.followers),
    [identity ?? '', network, identityId],
    interested && canFollow && ready && sdk !== null && identity !== null && !following && data !== undefined && data !== null,
  )
  const followCost = previewCreate('follow', {}, first)
  const unfollowRefund = previewDelete('follow')
  const toggleFollow = (): void => {
    // Unfollowing refunds, so only a follow needs the funds check; both sign in first.
    if (!guard.check(following ? 0 : followCost, 'community', following ? 'unfollow' : 'follow this identity')) return
    setConfirming(true)
  }
  // Signed in but whether you already follow is not known yet (or unreadable): no action.
  const followUnknown = identity !== null && signer !== null && follow.on === null

  if (!address) return <EmptyState heading="h1" icon={Users} title="No profile addressed" body="Add ?name= (an identity id or DPNS name) to the URL." />
  if (!isForgeDeployed()) return <NotDeployedState />
  if (loading) return <LoadingBlock label="Reading profile" />
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (data === null && ready) {
    return <EmptyState heading="h1" icon={Users} title="No such identity" body={`"${address}" is not an identity id or a registered DPNS name on this network.`} />
  }
  if (!data) return <LoadingBlock />

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-anvil-200 bg-white p-5 dark:border-anvil-750 dark:bg-anvil-900">
        {/* The page's one h1: whose profile this is (QW4-044: its only heading was "Repositories"). */}
        <h1 className="min-w-0 max-w-full font-normal">
          <span className="sr-only">Profile of {data.name ?? identityId}</span>
          <span aria-hidden>
            <IdentityPill identityId={identityId} name={data.name ?? undefined} className="text-prose" />
          </span>
        </h1>
        {/* Your own profile, with no username: how to get one (QW3-035). */}
        {isSelf && data.name === null && ownName === null ? <UsernameHint className="order-last w-full border-t border-anvil-100 pt-3 dark:border-anvil-850" /> : null}
        <div className="flex items-center gap-4 text-dense text-anvil-500 dark:text-anvil-400">
          <Count
            value={data.followers === null ? null : Math.max(0, data.followers + follow.delta)}
            one="follower"
            href={`/u/followers?name=${encodeURIComponent(identityId)}`}
          />
          <Count value={data.following} one="following" many="following" href={`/u/following?name=${encodeURIComponent(identityId)}`} />
          <Count value={data.repos.length} one="repo" />
        </div>
        {!isSelf && canFollow ? (
          <div className="ml-auto flex items-center gap-2">
            {follow.error ? (
              <span role="alert" className="max-w-[18rem] text-[12px] text-danger-700 dark:text-danger-400">{follow.error}</span>
            ) : null}
            <Button
              variant={following ? 'subtle' : 'primary'}
              onClick={toggleFollow}
              onPointerEnter={() => setInterested(true)}
              onFocus={() => setInterested(true)}
              loading={follow.busy || (followUnknown && follow.error === null)}
              disabled={followUnknown && follow.error !== null}
            >
              <UserPlus className="h-3.5 w-3.5" aria-hidden />
              {following ? 'Following' : 'Follow'}
              {identity !== null && follow.on !== null ? (
                <span className={cn('ml-1 font-mono text-[11px]', following && 'hidden sm:inline')} data-testid="follow-cost" aria-hidden>
                  {following ? refundLabel('unfollow', unfollowRefund.credits) : priceLabel(followCost.credits, !firstWriteRead(first))} DASH
                </span>
              ) : null}
            </Button>
          </div>
        ) : null}
        <ConfirmDialog
          open={confirming}
          onClose={() => setConfirming(false)}
          title={following ? 'Unfollow this identity?' : 'Follow this identity?'}
          description={
            following
              ? 'Removes your follow from Platform and returns part of its storage fee.'
              : 'Your follow is a public document on Platform, signed by this browser\'s key.'
          }
          cost={following ? unfollowRefund : followCost}
          refund={following}
          confirmLabel={following ? 'Sign & unfollow' : 'Sign & follow'}
          successNote={following ? 'Unfollowed' : 'Following'}
          onConfirm={follow.run}
        />
      </div>

      <div>
        <h2 className="mb-3 text-prose">Repositories</h2>
        {data.repos.length === 0 ? (
          <EmptyState icon={GitBranch} title="No repos yet" body="This identity has not created any repos on this network." />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {data.repos.map((r) => (
              <RepoCard key={r.key} repo={r} showOwner={false} />
            ))}
          </div>
        )}
      </div>

      {data.memberOf.length > 0 ? (
        <div>
          <h2 className="mb-3 text-prose">Member of</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {data.memberOf.map((r) => (
              <RepoCard key={r.key} repo={r} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
