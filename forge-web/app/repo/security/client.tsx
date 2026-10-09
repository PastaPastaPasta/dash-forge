'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { SecurityPolicyContent } from '@/components/repo/security-policy'
import { useRepoAddress } from '@/hooks/use-query-param'

export function SecurityClient(): JSX.Element {
  const addr = useRepoAddress()
  return (
    <RepoScaffold addr={addr} browse rail={false}>
      {(home) => <SecurityPolicyContent home={home} addr={addr} />}
    </RepoScaffold>
  )
}
