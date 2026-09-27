'use client'

/**
 * An unfinished key renewal on this device (D-016): a key that was stored, and may already be
 * registered on Platform, but was never made this browser's signing key (the tab closed, or
 * storing failed, mid-renewal). Settings → Keys shows it with the two ways out: finish it by
 * unlocking with the passphrase or passkey chosen for it, or discard it (its key then stays
 * registered, unused, until the next renewal or a revoke disables it).
 */

import { useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useAsync } from '@/hooks/use-async'
import { useUiStore } from '@/hooks/use-ui-store'
import { Button } from '@/components/ui/button'
import { formatDate } from '@/lib/view/format'
import { errorMessage } from '@/lib/utils'

export function PendingRenewal({ identityId }: { identityId: string }): JSX.Element | null {
  const { controller, logout } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)
  const [error, setError] = useState<string | null>(null)
  const { data, reload } = useAsync(() => controller.pendingRenewal(identityId), [identityId])
  if (!data) return null
  const discard = async (): Promise<void> => {
    setError(null)
    try {
      await controller.abandonPendingRenewal(identityId)
      reload()
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return (
    <div role="status" className="space-y-2 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-caution-700 dark:text-caution-400" data-testid="pending-renewal">
      <p>
        Unfinished key renewal: key {data.keyId}, started {formatDate(data.createdAt)}, protected with a{' '}
        {data.methods.join(' or a ')}. It may already be registered on Platform. Finish it by unlocking with that passphrase or passkey, or discard it (its key
        then stays registered but unused until you revoke it or renew again).
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            logout()
            openLogin()
          }}
        >
          Finish it (lock and unlock)
        </Button>
        <Button variant="danger" size="sm" onClick={() => void discard()}>
          Discard
        </Button>
      </div>
      {error ? <p role="alert" className="text-[12px] text-danger-700 dark:text-danger-400">{error}</p> : null}
    </div>
  )
}
