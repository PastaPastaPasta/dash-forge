'use client'

/**
 * Settings → This browser's key (`ux-dx-spec.md` §2.3): which key signs here, what is left of
 * its budget, when it expires, and how to renew it. Renewal registers a fresh limited key (it
 * needs the master key once: import the identity file or phrase again); raising an existing
 * key's limits (`IdentityKeyLimitsUpdate`) is P1. Also: lock now, and sign out + forget.
 */

import { useRef, useState } from 'react'
import { Lock, LogOut, RefreshCw, ShieldOff } from 'lucide-react'
import { errorMessage } from '@/lib/utils'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { creditsAsDash, formatDate } from '@/lib/view/format'
import { INSIGHT_OVERRIDE_KEY } from '@/lib/auth/asset-lock'

/** Shown before deleting a stored key: for a wallet-granted key this is the only copy. */
export const FORGET_CONFIRM =
  "Delete this browser's key from this device? This does not revoke it: the key stays valid on chain until it expires (use \"Revoke on chain\" for that). You will need your identity file, recovery phrase or wallet to sign in again here."

export function KeysPanel(): JSX.Element {
  const { identity, keyLimits, storage, funds, logout, forget, revokeStored, isLoading } = useAuth()
  const revokeRef = useRef<HTMLInputElement>(null)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  const revoke = async (file: File): Promise<void> => {
    if (!identity) return
    setRevokeError(null)
    try {
      await revokeStored(identity, { fileText: await file.text() })
    } catch (e) {
      setRevokeError(errorMessage(e))
    }
  }
  const openLogin = useUiStore((s) => s.openLogin)
  const [explorer, setExplorer] = useState(() =>
    typeof window === 'undefined' ? '' : window.localStorage.getItem(INSIGHT_OVERRIDE_KEY) ?? '',
  )
  const low = funds?.reason === 'key-budget' || funds?.reason === 'key-expiry'

  return (
    <div className="space-y-4 text-dense" data-testid="keys-panel">
      {storage === 'session' ? (
        <p className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-danger">
          This tab signs with a pasted key that has no Forge limits. It is forgotten on reload.
        </p>
      ) : keyLimits ? (
        <dl className="grid grid-cols-2 gap-2">
          <dt className="text-anvil-500 dark:text-anvil-400">Budget left</dt>
          <dd data-testid="key-budget" className="font-mono">
            {keyLimits.remaining === null ? '—' : `${creditsAsDash(Number(keyLimits.remaining))} of ${creditsAsDash(Number(keyLimits.total ?? 0n))} DASH`}
          </dd>
          <dt className="text-anvil-500 dark:text-anvil-400">Expires</dt>
          <dd data-testid="key-expiry">{keyLimits.expiresAt === null ? 'never' : formatDate(keyLimits.expiresAt)}</dd>
          <dt className="text-anvil-500 dark:text-anvil-400">Scope</dt>
          <dd>dash-forge contracts only</dd>
        </dl>
      ) : (
        <p className="text-anvil-500 dark:text-anvil-400">This key has no budget or expiry.</p>
      )}
      {low ? (
        <p className="text-caution">This browser&apos;s key is nearly used up. Renew it (uses your master key once).</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => openLogin('import')}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Renew key
        </Button>
        <Button variant="outline" size="sm" onClick={() => logout()}>
          <Lock className="h-3.5 w-3.5" aria-hidden /> Lock
        </Button>
        <Button
          variant="danger"
          size="sm"
          onClick={() => {
            if (identity && window.confirm(FORGET_CONFIRM)) void forget(identity)
          }}
        >
          <LogOut className="h-3.5 w-3.5" aria-hidden /> Sign out &amp; forget key
        </Button>
        {storage === 'vault' ? (
          <>
            <Button variant="danger" size="sm" loading={isLoading} onClick={() => revokeRef.current?.click()}>
              <ShieldOff className="h-3.5 w-3.5" aria-hidden /> Revoke on chain
            </Button>
            <input
              ref={revokeRef}
              type="file"
              aria-label="Identity file to revoke with"
              accept="application/json,.json,.txt"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f && window.confirm('Disable this browser\'s key on chain? Your identity file\'s master key signs it once and is not stored.')) void revoke(f)
                e.target.value = ''
              }}
            />
          </>
        ) : null}
      </div>
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
        Forgetting deletes the key from this device only. Revoking disables it on chain (needs your identity file once).
      </p>
      {revokeError ? <p role="alert" className="text-[12px] text-danger">{revokeError}</p> : null}
      <Field
        label="Block explorer (used only to watch identity deposits)"
        htmlFor="explorer-url"
        hint="Insight API base URL. Leave empty for the network default. It can delay you but cannot take funds or keys."
      >
        <Input
          id="explorer-url"
          value={explorer}
          placeholder="https://insight.dash.org/insight-api"
          onChange={(e) => {
            setExplorer(e.target.value)
            const v = e.target.value.trim()
            if (v === '') window.localStorage.removeItem(INSIGHT_OVERRIDE_KEY)
            else if (/^https:\/\//.test(v)) window.localStorage.setItem(INSIGHT_OVERRIDE_KEY, v.replace(/\/+$/, ''))
          }}
        />
      </Field>
    </div>
  )
}
