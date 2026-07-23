'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { SettingsContent } from '@/components/repo/settings-content'
import { useRepoAddress } from '@/hooks/use-query-param'

export function SettingsClient(): JSX.Element {
  const addr = useRepoAddress()
  return (
    <RepoScaffold addr={addr} rail={false}>
      {(home) => <SettingsContent home={home} />}
    </RepoScaffold>
  )
}
