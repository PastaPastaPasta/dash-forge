'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { BoardSettings } from '@/components/repo/boards/board-settings'
import { useParam, useRepoAddress } from '@/hooks/use-query-param'

export function BoardSettingsClient(): JSX.Element {
  const addr = useRepoAddress()
  const key = Number(useParam('b'))
  return (
    <RepoScaffold addr={addr} rail={false} refs="default">
      {(home) => <BoardSettings home={home} addr={addr} boardKey={key} />}
    </RepoScaffold>
  )
}
