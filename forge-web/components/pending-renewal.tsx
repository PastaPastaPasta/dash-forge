'use client'

/**
 * An unfinished key renewal on this device (D-016): a key that was stored, and may already be
 * registered on Platform, but was never made this browser's signing key (the tab closed, or
 * storing failed, mid-renewal). Settings → Keys shows it with the ways out: finish it by
 * unlocking with the passphrase or passkey chosen for it, or discard it. Discarding with that
 * passphrase or passkey keeps its key beside this one, never to sign, so the next renewal or
 * revoke disables it; without it, a registered key stays valid, unused, until it expires.
 */

import { useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useAsync } from '@/hooks/use-async'
import { useUiStore } from '@/hooks/use-ui-store'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { formatDate } from '@/lib/view/format'
import { errorMessage } from '@/lib/utils'

export function PendingRenewal({ identityId }: { identityId: string }): JSX.Element | null {
  const { controller, logout } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)
  const [error, setError] = useState<string | null>(null)
  const [discarding, setDiscarding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const { data, reload } = useAsync(() => controller.pendingRenewal(identityId), [identityId])
  if (!data) return null
  const discard = async (unlockWith?: { passphrase: string } | 'passkey'): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      await controller.abandonPendingRenewal(identityId, unlockWith)
      setPassphrase('')
      setDiscarding(false)
      reload()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      role="status"
      className="space-y-2 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-caution-700 dark:text-caution-400"
      data-testid="pending-renewal"
      data-key-id={data.keyId}
    >
      <p>
        Unfinished key renewal: key #{data.keyId}, started {formatDate(data.createdAt)}, protected with a{' '}
        {data.methods.join(' or a ')}. It may already be registered on Platform. Finish it by unlocking with that passphrase or passkey.
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
        <Button variant="danger" size="sm" onClick={() => setDiscarding((d) => !d)} aria-expanded={discarding}>
          Discard
        </Button>
      </div>
      {discarding ? (
        <div className="space-y-2 border-t border-caution/30 pt-2" data-testid="pending-renewal-discard">
          <p>
            With the renewal&apos;s passphrase or passkey, this browser keeps its key (never to sign) so your next renewal or &quot;Revoke on chain&quot;
            disables it. Without it, a registered key stays valid on Platform, unused, until it expires.
          </p>
          {data.methods.includes('passphrase') ? (
            <Field label="The renewal's passphrase" htmlFor="discard-renewal-passphrase">
              <Input id="discard-renewal-passphrase" type="password" autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            </Field>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {data.methods.includes('passphrase') ? (
              <Button variant="outline" size="sm" loading={busy} disabled={passphrase === ''} onClick={() => void discard({ passphrase })}>
                Keep its key and discard
              </Button>
            ) : null}
            {data.methods.includes('passkey') ? (
              <Button variant="outline" size="sm" loading={busy} onClick={() => void discard('passkey')}>
                Use its passkey and discard
              </Button>
            ) : null}
            <Button variant="danger" size="sm" loading={busy} onClick={() => void discard()}>
              Discard without it
            </Button>
          </div>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-[12px] text-danger-700 dark:text-danger-400">{error}</p> : null}
    </div>
  )
}
