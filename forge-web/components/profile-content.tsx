'use client'

/**
 * ProfileContent — an identity's profile: the identity pill (DPNS-resolved), follower/following
 * counts (O(1) registry count trees), a follow/unfollow toggle, and the repos it owns. The
 * `name` address is an identity id (what authors + search resolve to).
 *
 * The follow toggle reads whether the viewer already follows this identity before offering an
 * action, and shows read/write failures instead of swallowing them.
 */

import { GitBranch, UserPlus, Users } from 'lucide-react'
import type { DiscoveredRepo } from '@/lib/view'
import { listReposByOwner, resolveDpnsName } from '@/lib/view'
import {
  followRelation,
  readFollowerCount,
  readFollowingCount,
  readV2FollowCounts,
  resolveOwner,
} from '@/lib/repo'
import { NETWORKS } from '@/lib/constants'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useRelationToggle } from '@/hooks/use-relation-toggle'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { IdentityPill } from '@/components/ui/identity-pill'
import { RepoCard } from '@/components/repo-card'
import { Button } from '@/components/ui/button'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { NotDeployedState, isForgeDeployed, isRegistryDeployed } from '@/components/ui/network-badge'

interface ProfileData {
  /** The identity id the address resolved to (it may have been a DPNS name). */
  readonly identityId: string
  readonly name: string | null
  readonly repos: DiscoveredRepo[]
  /** forge-v2 repos this identity is a maintainer or writer of (and does not own). */
  readonly memberOf: DiscoveredRepo[]
  /** `null` when the count read failed — shown as unknown, never as a false 0. */
  readonly followers: number | null
  readonly following: number | null
}

/** A count, or a dash (with the reason on hover) when it could not be read. */
function Count({ value }: { value: number | null }): JSX.Element {
  return value === null ? (
    <span className="font-semibold text-anvil-900 dark:text-anvil-50" title="Couldn't read this count from Platform">–</span>
  ) : (
    <span className="font-semibold text-anvil-900 dark:text-anvil-50">{value}</span>
  )
}

export function ProfileContent({ identityId: address }: { identityId: string }): JSX.Element {
  const { sdk, ready, network } = useSdk()
  const { identity, signer } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)

  const { data, loading, error, reload } = useAsync<ProfileData | null>(
    async () => {
      // The address may be a DPNS name (`/u?name=alice`) or an identity id.
      const identityId = await resolveOwner(sdk!, address)
      if (identityId === null) return null
      const forge = NETWORKS[network].v2
      // Follows live in forge-collab where forge-v2 is deployed, else in the v1 registry.
      const noCounts = { followers: null, following: null }
      const follows = forge !== null
        ? readV2FollowCounts(sdk!, forge, identityId).catch(() => noCounts)
        : Promise.all([
            readFollowerCount(sdk!, identityId, { network }).catch(() => null),
            readFollowingCount(sdk!, identityId, { network }).catch(() => null),
          ]).then(([followers, following]) => ({ followers, following }))
      const [name, repos, counts] = await Promise.all([
        resolveDpnsName(sdk!, identityId, network),
        listReposByOwner(sdk!, identityId, { network }),
        follows,
      ])
      return { identityId, name, repos: repos.owned, memberOf: repos.member, ...counts }
    },
    [ready, address, network],
    { enabled: isForgeDeployed() && ready && sdk !== null && address !== '' },
  )
  const identityId = data?.identityId ?? address
  // forge-v2 follows live in forge-collab; networks without it use the v1 registry.
  const forge = NETWORKS[network].v2
  const canFollow = forge !== null || isRegistryDeployed()

  const isSelf = identity === identityId
  const follow = useRelationToggle({
    enabled: canFollow && ready && sdk !== null && identity !== null && identityId !== '' && !isSelf,
    key: `${network}:${identity ?? ''}:${identityId}`,
    ...followRelation(sdk!, signer, identity ?? '', forge, identityId, network),
  })

  const toggleFollow = (): void => {
    if (!identity || !signer) {
      openLogin()
      return
    }
    void follow.toggle()
  }
  const following = follow.on === true
  // Signed in but whether you already follow is not known yet (or unreadable): no action.
  const followUnknown = identity !== null && signer !== null && follow.on === null

  if (!address) return <EmptyState icon={Users} title="No profile addressed" body="Add ?name= (an identity id or DPNS name) to the URL." />
  if (!isForgeDeployed()) return <NotDeployedState />
  if (loading) return <LoadingBlock label="Reading profile" />
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (data === null && ready) {
    return <EmptyState icon={Users} title="No such identity" body={`"${address}" is not an identity id or a registered DPNS name on this network.`} />
  }
  if (!data) return <LoadingBlock />

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-anvil-200 bg-white p-5 dark:border-anvil-750 dark:bg-anvil-900">
        <IdentityPill identityId={identityId} name={data.name ?? undefined} className="text-prose" />
        <div className="flex items-center gap-4 text-dense text-anvil-500 dark:text-anvil-400">
          <span><Count value={data.followers === null ? null : Math.max(0, data.followers + follow.delta)} /> followers</span>
          <span><Count value={data.following} /> following</span>
          <span><span className="font-semibold text-anvil-900 dark:text-anvil-50">{data.repos.length}</span> repos</span>
        </div>
        {!isSelf && canFollow ? (
          <div className="ml-auto flex items-center gap-2">
            {follow.error ? (
              <span role="alert" className="max-w-[18rem] text-[12px] text-danger">{follow.error}</span>
            ) : null}
            <Button
              variant={following ? 'subtle' : 'primary'}
              onClick={toggleFollow}
              loading={follow.busy || (followUnknown && follow.error === null)}
              disabled={followUnknown && follow.error !== null}
            >
              <UserPlus className="h-3.5 w-3.5" aria-hidden />
              {following ? 'Following' : 'Follow'}
            </Button>
          </div>
        ) : null}
      </div>

      <div>
        <h2 className="mb-3 text-prose">Repositories</h2>
        {data.repos.length === 0 ? (
          <EmptyState icon={GitBranch} title="No repos yet" body="This identity has not created any repos on this network." />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {data.repos.map((r) => (
              <RepoCard key={r.key} repo={r} />
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
