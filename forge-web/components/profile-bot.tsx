'use client'

/**
 * A profile's bot facts: "Bot operated by …" when this identity is a bot both sides vouch for,
 * and "Operates …" with each bot that names this identity back. A one-sided claim shows nothing.
 * Read only when the profile carries a claim: no request otherwise.
 */

import { Bot } from 'lucide-react'
import { Author } from '@/components/author'
import { useAsync } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { NETWORKS } from '@/lib/constants'
import { readBotOperators } from '@/lib/repo/bots'
import type { Profile } from '@/lib/repo/profile'

export function ProfileBot({ identityId, profile }: { identityId: string; profile: Profile }): JSX.Element | null {
  const { sdk, ready, network } = useSdk()
  const forge = NETWORKS[network].v2
  const claim = profile.bot
  const ids = claim === undefined ? [] : [...(claim.operator ? [identityId] : []), ...(claim.operates ?? [])]
  const { data } = useAsync(() => readBotOperators(sdk!, forge!.community, ids), [ready, network, identityId, ids.join(',')], {
    enabled: ready && sdk !== null && forge !== null && ids.length > 0,
  })
  if (data === null) return null
  const operator = data.get(identityId)
  const operated = (claim?.operates ?? []).filter((b) => data.get(b) === identityId)
  if (operator === undefined && operated.length === 0) return null
  return (
    <ul className="space-y-1.5 text-dense text-anvil-700 dark:text-anvil-200" data-testid="profile-bot">
      {operator !== undefined ? (
        <li className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Bot className="h-4 w-4 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
          Bot operated by <Author identityId={operator} />
        </li>
      ) : null}
      {operated.length > 0 ? (
        <li className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Bot className="h-4 w-4 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
          Operates
          {operated.map((b) => (
            <Author key={b} identityId={b} />
          ))}
        </li>
      ) : null}
    </ul>
  )
}
