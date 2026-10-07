'use client'

/**
 * The "bot" badge beside an identity. It shows only when both sides agree: the bot's profile names
 * its operator, and the operator's profile lists the bot (`lib/repo/bots.ts`). Reading profiles
 * costs a request, so badges are on only inside a {@link BotBadgeScope} (an issue thread, a pull
 * request's conversation), which reads the thread's participants in one batch. Outside a scope
 * nothing is read and no badge shows.
 */

import { createContext, useContext, useRef } from 'react'
import { useAsync } from '@/hooks/use-async'
import { Bot } from 'lucide-react'
import { useDpnsName } from '@/hooks/use-dpns-name'
import { useSdk } from '@/hooks/use-sdk'
import { NETWORKS } from '@/lib/constants'
import { readBotOperators } from '@/lib/repo/bots'
import { shortId } from '@/lib/utils'

const BotScope = createContext<ReadonlyMap<string, string> | null>(null)

/**
 * Turn bot badges on for every {@link Author} inside: `ids` are the thread's participants, read in
 * one batch once (`readBotOperators` keeps what it read, so a new comment's author is the only
 * read a later change makes).
 */
export function BotBadgeScope({ ids, children }: { ids: readonly string[]; children: React.ReactNode }): JSX.Element {
  const { sdk, ready, network } = useSdk()
  const forge = NETWORKS[network].v2
  const key = ids.join(',')
  const { data } = useAsync(() => readBotOperators(sdk!, forge!.community, ids), [ready, network, key], {
    enabled: ready && sdk !== null && forge !== null && ids.length > 0,
  })
  // A participant joining re-reads the set: the badges already shown stay until it answers.
  const last = useRef<ReadonlyMap<string, string>>(NONE)
  if (data !== null) last.current = data
  return <BotScope.Provider value={data ?? last.current}>{children}</BotScope.Provider>
}

const NONE: ReadonlyMap<string, string> = new Map()

/** The verified operator of `identityId` inside a {@link BotBadgeScope}, else undefined. */
export function useBotOperator(identityId: string): string | undefined {
  return useContext(BotScope)?.get(identityId)
}

/** "bot", titled with its operator. */
export function BotBadge({ operator }: { operator: string }): JSX.Element {
  const name = useDpnsName(operator)
  const label = `Bot operated by ${name ?? shortId(operator)}`
  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-anvil-300 px-1.5 text-[11px] font-medium leading-[18px] text-anvil-600 dark:border-anvil-700 dark:text-anvil-300"
      title={label}
      aria-label={label}
      data-testid="bot-badge"
    >
      <Bot className="h-3 w-3" aria-hidden />
      bot
    </span>
  )
}
