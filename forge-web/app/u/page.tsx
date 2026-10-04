import { QueryPage } from '@/components/route-loading'
import { ProfileClient } from './client'

/** `/u?id=` (an identity id) or `/u?name=` (a DPNS name) — an identity's profile, follows and repos (D-222). */
export default function ProfilePage(): JSX.Element {
  return (
    <QueryPage>
      <ProfileClient />
    </QueryPage>
  )
}
