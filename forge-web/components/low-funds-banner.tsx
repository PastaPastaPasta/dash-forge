'use client'

/**
 * The low-balance banner (`ux-dx-spec.md` §4, low-balance states): when funds are low or empty,
 * one banner under the header with the specific fix — top up the identity, or renew this
 * browser's key — dismissible once per state per session (sessionStorage). It shows at every
 * width, so a phone, whose header only has room for the icon-sized funds cue, still says what is
 * wrong and how to fix it.
 */

import { useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { Button } from '@/components/ui/button'
import { fundsNotice } from '@/lib/view/funds'
import { cn } from '@/lib/utils'

function storageKey(identity: string): string {
  return `forge.funds-banner.dismissed:${identity}`
}

/** The states dismissed this session for `identity` (e.g. `low:balance`). */
function readDismissed(identity: string): readonly string[] {
  try {
    const v: unknown = JSON.parse(window.sessionStorage.getItem(storageKey(identity)) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function LowFundsBanner(): JSX.Element | null {
  const { identity, funds } = useAuth()
  const openTopUp = useUiStore((s) => s.openTopUp)
  const openLogin = useUiStore((s) => s.openLogin)
  const notice = funds ? fundsNotice(funds) : null
  // Read after mount (sessionStorage is browser-only), per identity; until then nothing shows,
  // so neither a flash nor another identity's dismissals.
  const [dismissed, setDismissed] = useState<{ identity: string; keys: readonly string[] } | null>(null)
  useEffect(() => {
    setDismissed(identity ? { identity, keys: readDismissed(identity) } : null)
  }, [identity])

  if (!identity || !funds || !notice || dismissed?.identity !== identity || dismissed.keys.includes(notice.key)) return null
  const empty = funds.level === 'empty'
  const topUp = notice.fix === 'top-up'
  const dismiss = (): void => {
    const keys = [...dismissed.keys, notice.key]
    try {
      window.sessionStorage.setItem(storageKey(identity), JSON.stringify(keys))
    } catch {
      /* storage disabled: dismissed for this page only */
    }
    setDismissed({ identity, keys })
  }
  return (
    <div
      role="status"
      data-testid="low-funds-banner"
      data-level={funds.level}
      className={cn(
        'border-b',
        empty ? 'border-danger/40 bg-danger/10' : 'border-caution/40 bg-caution/10',
      )}
    >
      <div className="mx-auto flex max-w-[1280px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 text-dense sm:px-6">
        <AlertTriangle className={cn('h-4 w-4 shrink-0', empty ? 'text-danger' : 'text-caution')} aria-hidden />
        <p className="min-w-0 flex-1 text-anvil-800 dark:text-anvil-100">{notice.message}</p>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="primary"
            onClick={() => (topUp ? openTopUp({ blocker: 'balance' }) : openLogin('import'))}
          >
            {topUp ? 'Top up' : 'Renew key'}
          </Button>
          <Button size="icon" variant="ghost" onClick={dismiss} aria-label="Dismiss for this session">
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  )
}
