'use client'

import { FollowListContent } from '@/components/follow-list-content'
import { useProfileAddress } from '@/hooks/use-query-param'

export function FollowersClient(): JSX.Element {
  const { address, byId } = useProfileAddress()
  return <FollowListContent address={address} byId={byId} side="followers" />
}
