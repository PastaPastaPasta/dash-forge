'use client'

/**
 * ProfileContent — an identity's profile, laid out as GitHub's: a side column with the avatar,
 * the display name, DPNS name and id, the bio, the follow toggle, follower/following counts (O(1)
 * forge-community count trees), company, location and links; the repos it owns and is a member
 * of beside it (below it on a phone). The profile fields are its forge-community `profile`
 * document (P1-7: one more query, in parallel with the rest), all public; the avatar follows its
 * `avatarConfig` ({@link ProfileAvatar}). Addressed by `?id=` (an identity id exactly, D-222) or
 * `?name=` (a DPNS name, or an identity id as before).
 *
 * The follow toggle reads whether the viewer already follows this identity before offering an
 * action, and shows read/write failures instead of swallowing them. A follow is a signed, paid
 * write, so it goes through the standard write flow (D-048, `ux-dx-spec.md` §4): its cost on the
 * button, the write guard (sign-in, grant, the funds check with the top-up sheet), then the
 * confirm dialog; an unfollow confirms its refund the same way.
 */

import { useState } from 'react'
import Link from 'next/link'

import { Building2, GitBranch, Link2, MapPin, Pencil, UserPlus, Users } from 'lucide-react'
import type { DiscoveredRepo } from '@/lib/view'
import { listReposByOwner, resolveDpnsName } from '@/lib/view'
import { followFirsts, followRelation, isIdentifier, readFollowCounts, resolveOwner } from '@/lib/repo'
import { readProfile, type Profile } from '@/lib/repo/profile'
import type { ProfileFields } from '@/lib/rules/profile'
import { firstWriteRead, previewCreate, previewDelete } from '@/lib/sdk'
import { priceLabel, refundLabel } from '@/lib/view/format'
import { identityHref, linkLabel } from '@/lib/view/profile-links'
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
import { Oid } from '@/components/ui/oid'
import { ProfileAvatar } from '@/components/ui/profile-avatar'
import { RepoCard } from '@/components/repo-card'
import { Button, buttonClass } from '@/components/ui/button'
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
  /** Its `profile` document; null when it has none, `'unread'` when the read failed. */
  readonly profile: Profile | null | 'unread'
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

const FACT_ICON = 'h-4 w-4 shrink-0 text-anvil-500 dark:text-anvil-400'

/** The profile's company, location and links, each with its icon (GitHub's side column). */
function ProfileFacts({ fields }: { fields: ProfileFields }): JSX.Element | null {
  const rows: { key: string; icon: JSX.Element; body: JSX.Element | string }[] = []
  if (fields.company) rows.push({ key: 'company', icon: <Building2 className={FACT_ICON} aria-label="Company" />, body: fields.company })
  if (fields.location) rows.push({ key: 'location', icon: <MapPin className={FACT_ICON} aria-label="Location" />, body: fields.location })
  for (const url of fields.links ?? []) {
    rows.push({
      key: url,
      icon: <Link2 className={FACT_ICON} aria-label="Link" />,
      body: (
        <a
          href={url}
          rel="nofollow noopener noreferrer"
          referrerPolicy="no-referrer"
          target="_blank"
          className="hit-area text-anvil-800 hover:text-forge-700 hover:underline dark:text-anvil-100 dark:hover:text-forge-400"
          title={url}
        >
          {linkLabel(url)}
        </a>
      ),
    })
  }
  if (rows.length === 0) return null
  return (
    <ul className="space-y-1.5 text-dense text-anvil-700 dark:text-anvil-200" data-testid="profile-facts">
      {rows.map((r) => (
        <li key={r.key} className="flex min-w-0 items-center gap-2">
          {r.icon}
          <span className="min-w-0 truncate">{r.body}</span>
        </li>
      ))}
    </ul>
  )
}

export function ProfileContent({ identityId: address, byId = false }: { identityId: string; byId?: boolean }): JSX.Element {
  const { sdk, ready, network } = useSdk()
  const { identity, signer } = useAuth()
  const guard = useWriteGuard()
  const [confirming, setConfirming] = useState(false)
  // First-write reads only once the viewer points at Follow (a page view costs no reads).
  const [interested, setInterested] = useState(false)

  const { data, loading, error, reload } = useAsync<ProfileData | null>(
    async () => {
      // `?id=` is an identity id exactly; `?name=` a DPNS name (`/u?name=alice`) or an identity id.
      const identityId = byId ? (isIdentifier(address) ? address : null) : await resolveOwner(sdk!, address)
      if (identityId === null) return null
      const forge = NETWORKS[network].v2
      const noCounts = { followers: null, following: null }
      const follows = forge !== null ? readFollowCounts(sdk!, forge, identityId).catch(() => noCounts) : noCounts
      // An unreadable profile leaves the page as it was before profiles: never an error.
      const profile = forge !== null ? readProfile(sdk!, forge, identityId).catch(() => 'unread' as const) : null
      const [name, repos, counts, stored] = await Promise.all([
        resolveDpnsName(sdk!, identityId, network),
        listReposByOwner(sdk!, identityId, { network, counts: true }),
        follows,
        profile,
      ])
      return { identityId, name, repos: repos.owned, memberOf: repos.member, ...counts, profile: stored }
    },
    [ready, address, byId, network],
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

  if (!address) return <EmptyState heading="h1" icon={Users} title="No profile addressed" body="Add ?id= (an identity id) or ?name= (a DPNS name) to the URL." />
  if (!isForgeDeployed()) return <NotDeployedState />
  if (loading) return <LoadingBlock label="Reading profile" />
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (data === null && ready) {
    return (
      <EmptyState
        heading="h1"
        icon={Users}
        title="No such identity"
        body={byId ? `"${address}" is not an identity id.` : `"${address}" is not an identity id or a registered DPNS name on this network.`}
      />
    )
  }
  if (!data) return <LoadingBlock />

  const profile = data.profile === 'unread' ? null : data.profile
  const fields = profile?.fields ?? {}
  const heading = fields.displayName ?? data.name ?? identityId

  return (
    <div className="space-y-6 md:grid md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] md:gap-8 md:space-y-0">
      <aside aria-label="Profile" className="min-w-0 space-y-4" data-testid="profile-card">
        <div className="flex items-center gap-4 md:flex-col md:items-start">
          {/* A phone shows the avatar beside the name; from `md` it heads the column, full width. */}
          <ProfileAvatar identityId={identityId} config={fields.avatarConfig} className="[--avatar:72px] md:[--avatar:256px]" />
          {/* The page's one h1: whose profile this is (QW4-044: its only heading was "Repositories"). */}
          <div className="min-w-0 flex-1 md:w-full">
            <h1 className="min-w-0 max-w-full font-normal">
              <span className="sr-only">Profile of {heading}</span>
              <span aria-hidden className="flex min-w-0 flex-col items-start gap-1">
                {fields.displayName ? (
                  <span className="max-w-full truncate text-xl font-semibold text-anvil-900 dark:text-anvil-50" data-testid="profile-display-name" title={fields.displayName}>
                    {fields.displayName}
                  </span>
                ) : null}
                <IdentityPill identityId={identityId} name={data.name ?? undefined} className="text-prose" />
              </span>
            </h1>
          </div>
        </div>
        {/* Your own profile, with no username: how to get one (QW3-035). */}
        {isSelf && data.name === null && ownName === null ? <UsernameHint className="border-t border-anvil-100 pt-3 dark:border-anvil-850" /> : null}
        {fields.bio ? (
          <p className="whitespace-pre-line text-prose text-anvil-800 [overflow-wrap:anywhere] dark:text-anvil-100" data-testid="profile-bio">
            {fields.bio}
          </p>
        ) : null}
        {!isSelf && canFollow ? (
          <div className="flex flex-col gap-2">
            <Button
              variant={following ? 'subtle' : 'primary'}
              onClick={toggleFollow}
              onPointerEnter={() => setInterested(true)}
              onFocus={() => setInterested(true)}
              loading={follow.busy || (followUnknown && follow.error === null)}
              disabled={followUnknown && follow.error !== null}
              className="w-full"
            >
              <UserPlus className="h-3.5 w-3.5" aria-hidden />
              {following ? 'Following' : 'Follow'}
              {identity !== null && follow.on !== null ? (
                <span className="ml-1 font-mono text-[11px]" data-testid="follow-cost" aria-hidden>
                  {following ? refundLabel('unfollow', unfollowRefund.credits) : priceLabel(followCost.credits, !firstWriteRead(first))} DASH
                </span>
              ) : null}
            </Button>
            {follow.error ? (
              <span role="alert" className="text-[12px] text-danger-700 dark:text-danger-400">{follow.error}</span>
            ) : null}
          </div>
        ) : null}
        {isSelf ? (
          <Link href="/settings/profile/" className={cn(buttonClass({ variant: 'outline' }), 'w-full')} data-testid="profile-edit">
            <Pencil className="h-3.5 w-3.5" aria-hidden />
            {data.profile === null ? 'Add profile details' : 'Edit profile'}
          </Link>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-dense text-anvil-500 dark:text-anvil-400">
          <Count
            value={data.followers === null ? null : Math.max(0, data.followers + follow.delta)}
            one="follower"
            href={identityHref(identityId, 'followers')}
          />
          <Count value={data.following} one="following" many="following" href={identityHref(identityId, 'following')} />
          <Count value={data.repos.length} one="repo" />
        </div>
        <ProfileFacts fields={fields} />
        <p className="flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400">
          Identity <Oid value={identityId} label="identity id" />
        </p>
        {data.profile === 'unread' ? (
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="profile-unread">
            Couldn&apos;t read this identity&apos;s profile details from Platform.
          </p>
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
      </aside>

      <div className="min-w-0 space-y-6">
        <div>
          <h2 className="mb-3 text-prose">Repositories</h2>
          {data.repos.length === 0 ? (
            <EmptyState icon={GitBranch} title="No repos yet" body="This identity has not created any repos on this network." />
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {data.repos.map((r) => (
                <RepoCard key={r.key} repo={r} showOwner={false} />
              ))}
            </div>
          )}
        </div>

        {data.memberOf.length > 0 ? (
          <div>
            <h2 className="mb-3 text-prose">Member of</h2>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {data.memberOf.map((r) => (
                <RepoCard key={r.key} repo={r} />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
