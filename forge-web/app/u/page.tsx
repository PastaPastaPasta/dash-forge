import { QueryPage } from '@/components/route-loading'
import { ProfileClient } from './client'

/** `/u?name=` — identity profile (repos, followers, follow). `name` is an identity id. */
export default function ProfilePage(): JSX.Element {
  return (
    <QueryPage>
      <ProfileClient />
    </QueryPage>
  )
}
