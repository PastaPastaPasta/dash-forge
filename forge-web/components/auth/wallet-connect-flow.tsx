'use client'

/**
 * "Use my Dash wallet" (`ux-dx-spec.md` §2.2 tile 1): shows the App Connect request as a QR
 * and a deep link, waits for the wallet's `loginKeyResponse`, verifies the granted key on chain
 * (live, HIGH, bound to the dash-forge group, budgeted, expiring), then stores it in the vault.
 */

import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { Qr } from '@/components/ui/qr'
import { useProtection } from '@/components/auth/protection-fields'
import { ACTIVE_NETWORK, DEFAULT_NETWORK } from '@/lib/constants'
import { BROWSER_KEY_DEFAULTS, type LimitedKey } from '@/lib/auth'
import { errorMessage } from '@/lib/utils'

export function WalletConnectFlow({ onDone }: { onDone: () => void }): JSX.Element {
  const { adoptLimitedKey } = useAuth()
  const [uri, setUri] = useState<string | null>(null)
  const [pairing, setPairing] = useState('')
  const [slow, setSlow] = useState(false)
  const [granted, setGranted] = useState<{ identityId: string; key: LimitedKey } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { fields, protection, problem } = useProtection(granted?.identityId ?? '')
  const abort = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    abort.current = controller
    const timer = setTimeout(() => setSlow(true), 3 * 60 * 1000)
    void (async () => {
      try {
        const v2 = ACTIVE_NETWORK.v2
        if (!v2) throw new Error('forge-v2 is not deployed here')
        const { ensureSdk } = await import('@/lib/sdk')
        const { newRequest, awaitWalletLogin } = await import('@/lib/auth/app-connect')
        const req = newRequest(DEFAULT_NETWORK, v2.core)
        setUri(req.uri)
        setPairing(req.pairingCode)
        const login = await awaitWalletLogin(await ensureSdk(DEFAULT_NETWORK), req, { network: DEFAULT_NETWORK, group: v2.group, signal: controller.signal })
        setGranted({ identityId: login.identityId, key: { keyId: login.keyId, wif: login.wif, limits: login.limits } })
      } catch (e) {
        if (!controller.signal.aborted) setError(errorMessage(e))
      }
    })()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [])

  if (granted) {
    return (
      <div className="space-y-3">
        <p className="text-dense">
          Your wallet granted a key to <span className="font-mono">{granted.identityId.slice(0, 10)}…</span>, verified on Platform.
        </p>
        {fields}
        <Button
          variant="primary"
          className="w-full"
          disabled={protection === null}
          onClick={async () => {
            if (!protection) return
            try {
              await adoptLimitedKey(granted.identityId, granted.key, protection)
              onDone()
            } catch (e) {
              setError(errorMessage(e))
            }
          }}
        >
          Finish signing in
        </Button>
        {problem ? <p className="text-[12px] text-anvil-500">{problem}</p> : null}
        {error ? <p role="alert" className="text-dense text-danger">{error}</p> : null}
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
        {BROWSER_KEY_DEFAULTS.days} days. Check the wallet shows code <span className="font-mono font-semibold">{pairing}</span>.
      </p>
      {slow ? <p className="text-dense text-caution">No response yet. Keep this tab open, or choose another method.</p> : null}
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">Needs a wallet with Platform login (App Connect).</p>
      {error ? <p role="alert" className="text-dense text-danger">{error}</p> : null}
    </div>
  )
}
