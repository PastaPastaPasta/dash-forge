'use client'

import { FollowListContent } from '@/components/follow-list-content'
import { useParam } from '@/hooks/use-query-param'

export function FollowersClient(): JSX.Element {
  const name = useParam('name')
  return <FollowListContent address={name} side="followers" />
}
