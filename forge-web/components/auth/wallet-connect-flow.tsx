'use client'

/**
 * "Use my Dash wallet" (`ux-dx-spec.md` §2.2 tile 1): shows the App Connect request as a QR
 * and a deep link, waits for the wallet's `loginKeyResponse`, verifies the granted key on chain
 * (live, HIGH, bound to the dash-forge group, budgeted, expiring), then — after the user
 * confirms the full identity id (and DPNS name) is theirs — stores it in the vault.
 *
 * The response does not prove who answered: anyone who saw the QR could answer from their own
 * identity. So the user confirms the identity, and more than one valid answer is refused.
 * The granted key is held in a ref, never React state, and dropped when the sheet closes.
 */

import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { Qr } from '@/components/ui/qr'
import { ErrorBox, useProtection } from '@/components/auth/protection-fields'
import { ACTIVE_NETWORK } from '@/lib/constants'
import { BROWSER_KEY_DEFAULTS, type LimitedKey } from '@/lib/auth'
import { awaitWalletLogin, newRequest } from '@/lib/auth/app-connect'
import { ensureSdk } from '@/lib/sdk'
import { isAbort } from '@/lib/sdk/facade'
import { resolveDpnsName } from '@/lib/view/dpns'
import { errorMessage } from '@/lib/utils'

export function WalletConnectFlow({ onDone }: { onDone: () => void }): JSX.Element {
  const { adoptLimitedKey, isLoading } = useAuth()
  const [uri, setUri] = useState<string | null>(null)
  const [pairing, setPairing] = useState('')
  const [slow, setSlow] = useState(false)
  const [who, setWho] = useState<{ identityId: string; name: string | null } | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const grant = useRef<LimitedKey | null>(null)
  const { fields, protection, problem } = useProtection()

  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => setSlow(true), 3 * 60 * 1000)
    void (async () => {
      try {
        const v2 = ACTIVE_NETWORK.v2
        if (!v2) throw new Error('forge-v2 is not deployed here')
        const req = newRequest(ACTIVE_NETWORK.network, v2.group)
        setUri(req.uri)
        setPairing(req.pairingCode)
        const sdk = await ensureSdk(ACTIVE_NETWORK.network)
        const login = await awaitWalletLogin(sdk, req, { network: ACTIVE_NETWORK.network, group: v2.group, signal: controller.signal })
        grant.current = { keyId: login.keyId, wif: login.wif, limits: login.limits }
        const name = await resolveDpnsName(sdk, login.identityId, ACTIVE_NETWORK.network).catch(() => null)
        setWho({ identityId: login.identityId, name: name ?? null })
      } catch (e) {
        if (!isAbort(e)) setError(errorMessage(e))
      }
    })()
    return () => {
      controller.abort()
      clearTimeout(timer)
      grant.current = null
    }
  }, [])

  if (who) {
    return (
      <div className="space-y-3">
        <p className="text-dense">A wallet granted a key, verified on Platform, for this identity:</p>
        <div className="rounded-md border border-anvil-200 px-3 py-2 dark:border-anvil-800">
          {who.name ? <div className="text-dense font-medium">{who.name}</div> : null}
          <div data-testid="granted-identity" className="break-all font-mono text-dense">
            {who.identityId}
          </div>
        </div>
        <label className="flex items-start gap-2 text-dense">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1" />
          <span>This is my identity. (If it is not, someone else answered the QR code: close this and start again.)</span>
        </label>
        {fields}
        <Button
          variant="primary"
          className="w-full"
          loading={isLoading}
          disabled={!confirmed || protection === null || isLoading}
          onClick={async () => {
            const key = grant.current
            if (!protection || !key) return
            try {
              await adoptLimitedKey(who.identityId, key, protection)
              grant.current = null
              onDone()
            } catch (e) {
              setError(errorMessage(e))
            }
          }}
        >
          Finish signing in
        </Button>
        {problem ? <p className="text-[12px] text-anvil-500">{problem}</p> : null}
        <ErrorBox error={error} />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {uri ? <Qr value={uri} label="Wallet login request" size={200} /> : <Loader2 className="mx-auto h-5 w-5 animate-spin text-anvil-400" aria-hidden />}
      {uri ? (
        <a href={uri} className="block text-center text-dense text-forge-600 underline dark:text-forge-400">
          Open in a wallet on this device
        </a>
      ) : null}
      <p className="text-dense">
        Approve in your wallet. Forge gets a key that can spend at most {BROWSER_KEY_DEFAULTS.budgetDash} DASH, only here, for{' '}
        {BROWSER_KEY_DEFAULTS.days} days. Check the wallet shows code <span className="font-mono font-semibold">{pairing}</span>. Keep
        this QR code private: anyone who scans it can answer it.
      </p>
      {slow ? <p className="text-dense text-caution">No response yet. Keep this tab open, or choose another method.</p> : null}
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">Needs a wallet with Platform login (App Connect).</p>
      <ErrorBox error={error} />
    </div>
  )
}
