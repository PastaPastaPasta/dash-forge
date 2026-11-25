'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { BotsContent } from '@/components/repo/bots-content'
import { SettingsPageFrame } from '@/components/repo/settings-page-frame'
import { useRepoAddress } from '@/hooks/use-query-param'

export function BotsClient(): JSX.Element {
  const addr = useRepoAddress()
  return (
    <RepoScaffold addr={addr} rail={false} sealedOk>
      {(home) => (
        <SettingsPageFrame home={home} addr={addr} active="bots">
          <BotsContent home={home} addr={addr} />
        </SettingsPageFrame>
      )}
    </RepoScaffold>
  )
}
