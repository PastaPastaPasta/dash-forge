'use client'

/**
 * ProfileContent — an identity's profile: the identity pill (DPNS-resolved), follower/following
 * counts (O(1) registry count trees), a follow/unfollow toggle, and the repos it owns. The
 * `name` address is an identity id (what authors + search resolve to).
 */

import { useState } from 'react'
import { GitBranch, UserPlus, Users } from 'lucide-react'
import type { DiscoveredRepo } from '@/lib/view'
import { listReposByOwner, resolveDpnsName } from '@/lib/view'
import { readFollowerCount, readFollowingCount, followIdentity, unfollowIdentity } from '@/lib/repo'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { IdentityPill } from '@/components/ui/identity-pill'
import { RepoCard } from '@/components/repo-card'
import { Button } from '@/components/ui/button'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'

interface ProfileData {
  readonly name: string | null
  readonly repos: DiscoveredRepo[]
  readonly followers: number
  readonly following: number
}

export function ProfileContent({ identityId }: { identityId: string }): JSX.Element {
  const { sdk, ready, network } = useSdk()
  const { identity, signer } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)
  const [following, setFollowing] = useState(false)
  const [busy, setBusy] = useState(false)

  const { data, loading, error, reload } = useAsync<ProfileData>(
    async () => {
      const [name, repos, followers, followingCount] = await Promise.all([
        resolveDpnsName(sdk!, identityId, network),
        listReposByOwner(sdk!, identityId, { network }),
        readFollowerCount(sdk!, identityId, { network }).catch(() => 0),
        readFollowingCount(sdk!, identityId, { network }).catch(() => 0),
      ])
      return { name, repos, followers, following: followingCount }
    },
    [ready, identityId, network],
    { enabled: ready && sdk !== null && identityId !== '' },
  )

  const toggleFollow = async (): Promise<void> => {
    if (!identity || !signer) {
      openLogin()
      return
    }
    if (!sdk) return
    setBusy(true)
    try {
      if (following) {
        await unfollowIdentity(sdk, signer, identityId)
        setFollowing(false)
      } else {
        await followIdentity(sdk, signer, identityId)
        setFollowing(true)
      }
    } catch {
      /* count simply doesn't move on failure */
    } finally {
      setBusy(false)
    }
  }

  if (!identityId) return <EmptyState icon={Users} title="No profile addressed" body="Add ?name= (an identity id) to the URL." />
  if (loading) return <LoadingBlock label="Reading profile" />
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (!data) return <LoadingBlock />

  const isSelf = identity === identityId

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-anvil-200 bg-white p-5 dark:border-anvil-750 dark:bg-anvil-900">
        <IdentityPill identityId={identityId} name={data.name ?? undefined} className="text-prose" />
        <div className="flex items-center gap-4 text-dense text-anvil-500 dark:text-anvil-400">
          <span><span className="font-semibold text-anvil-900 dark:text-anvil-50">{data.followers}</span> followers</span>
          <span><span className="font-semibold text-anvil-900 dark:text-anvil-50">{data.following}</span> following</span>
          <span><span className="font-semibold text-anvil-900 dark:text-anvil-50">{data.repos.length}</span> repos</span>
        </div>
        {!isSelf ? (
          <Button variant={following ? 'subtle' : 'primary'} onClick={toggleFollow} loading={busy} className="ml-auto">
            <UserPlus className="h-3.5 w-3.5" aria-hidden />
            {following ? 'Following' : 'Follow'}
          </Button>
        ) : null}
      </div>

      <div>
        <h2 className="mb-3 text-prose">Repositories</h2>
        {data.repos.length === 0 ? (
          <EmptyState icon={GitBranch} title="No repos yet" body="This identity has not published any repos to the registry." />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {data.repos.map((r) => (
              <RepoCard key={r.listingId} repo={r} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
