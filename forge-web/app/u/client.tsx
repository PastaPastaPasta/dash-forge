'use client'

import { AppShell } from '@/components/app-shell'
import { ProfileContent } from '@/components/profile-content'
import { useParam } from '@/hooks/use-query-param'

export function ProfileClient(): JSX.Element {
  const name = useParam('name')
  return (
    <AppShell>
      <ProfileContent identityId={name} />
    </AppShell>
  )
}
