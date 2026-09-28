'use client'

import { ProfileContent } from '@/components/profile-content'
import { useParam } from '@/hooks/use-query-param'

export function ProfileClient(): JSX.Element {
  const name = useParam('name')
  return <ProfileContent identityId={name} />
}
