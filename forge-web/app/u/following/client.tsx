'use client'

import { AppShell } from '@/components/app-shell'
import { FollowListContent } from '@/components/follow-list-content'
import { useParam } from '@/hooks/use-query-param'

export function FollowingClient(): JSX.Element {
  const name = useParam('name')
  return (
    <AppShell>
      <FollowListContent address={name} side="following" />
    </AppShell>
  )
}
