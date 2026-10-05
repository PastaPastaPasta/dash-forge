'use client'

/**
 * The "bot" badge beside an identity. It shows only when both sides agree: the bot's profile names
 * its operator, and the operator's profile lists the bot (`lib/repo/bots.ts`). Reading profiles
 * costs a request, so badges are on only inside a {@link BotBadgeScope} (an issue or pull request
 * thread): every {@link Author} inside registers its identity, and the scope reads them all at
 * once after the thread renders. Outside a scope nothing is read and no badge shows.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Bot } from 'lucide-react'
import { useDpnsName } from '@/hooks/use-dpns-name'
import { useSdk } from '@/hooks/use-sdk'
import { NETWORKS } from '@/lib/constants'
import { readBotOperators } from '@/lib/repo/bots'
import { shortId } from '@/lib/utils'

interface Scope {
  readonly register: (id: string) => void
  readonly operators: ReadonlyMap<string, string>
}

const BotScope = createContext<Scope | null>(null)

/** Turn bot badges on for every {@link Author} inside, read in one batch. */
export function BotBadgeScope({ children }: { children: React.ReactNode }): JSX.Element {
  const { sdk, ready, network } = useSdk()
  const forge = NETWORKS[network].v2
  const [ids, setIds] = useState<readonly string[]>([])
  const [operators, setOperators] = useState<ReadonlyMap<string, string>>(new Map())
  const seen = useRef(new Set<string>())
  const register = useCallback((id: string) => {
    if (seen.current.has(id)) return
    seen.current.add(id)
    setIds([...seen.current])
  }, [])
  useEffect(() => {
    if (!ready || sdk === null || forge === null || ids.length === 0) return
    let live = true
    // Authors register as they mount: wait for the thread to settle, then read once.
    const t = setTimeout(() => {
      readBotOperators(sdk, forge.community, ids)
        .then((m) => live && setOperators(m))
        .catch(() => undefined)
    }, 150)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [ready, sdk, forge, ids])
  const value = useMemo(() => ({ register, operators }), [register, operators])
  return <BotScope.Provider value={value}>{children}</BotScope.Provider>
}

/** The verified operator of `identityId` inside a {@link BotBadgeScope}, else undefined. */
export function useBotOperator(identityId: string): string | undefined {
  const scope = useContext(BotScope)
  useEffect(() => {
    scope?.register(identityId)
  }, [scope, identityId])
  return scope?.operators.get(identityId)
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
