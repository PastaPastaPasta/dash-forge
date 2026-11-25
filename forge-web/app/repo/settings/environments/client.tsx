'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { EnvironmentsContent } from '@/components/repo/environments-content'
import { SettingsPageFrame } from '@/components/repo/settings-page-frame'
import { useRepoAddress } from '@/hooks/use-query-param'

export function EnvironmentsClient(): JSX.Element {
  const addr = useRepoAddress()
  return (
    <RepoScaffold addr={addr} rail={false} sealedOk>
      {(home) => (
        <SettingsPageFrame home={home} addr={addr} active="environments">
          <EnvironmentsContent home={home} addr={addr} />
        </SettingsPageFrame>
      )}
    </RepoScaffold>
  )
}
