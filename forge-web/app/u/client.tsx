'use client'

import { ProfileContent } from '@/components/profile-content'
import { useProfileAddress } from '@/hooks/use-query-param'

export function ProfileClient(): JSX.Element {
  const { address, byId } = useProfileAddress()
  return <ProfileContent identityId={address} byId={byId} />
}
