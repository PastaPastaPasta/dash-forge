'use client'

/**
 * Settings → This browser's key (`ux-dx-spec.md` §2.3): which key signs here, what is left of
 * its budget, when it expires, and how to extend it. **Top up** raises this key's budget and
 * expiry in place (`IdentityKeyLimitsUpdate`; same key). **Renew** registers a fresh limited key
 * and disables this one. Both need the master key once (identity file or phrase), which is not
 * stored. Also: lock now, and sign out + forget.
 */

import { useRef, useState } from 'react'
import { BatteryCharging, Lock, LogOut, RefreshCw, ShieldOff, Wallet } from 'lucide-react'
import { UnlimitedKeyWarning } from '@/components/auth/wallet-connect-flow'
import { errorMessage } from '@/lib/utils'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { creditsAsDash, formatDate } from '@/lib/view/format'
import { INSIGHT_OVERRIDE_KEY } from '@/lib/auth/asset-lock'
import { KeyTopUpDialog } from '@/components/key-top-up-dialog'

/** Shown before deleting a stored key: for a wallet-granted key this is the only copy. */
export const FORGET_CONFIRM =
  "Delete this browser's key from this device? This does not revoke it: the key stays valid on chain until it expires (use \"Revoke on chain\" for that). You will need your identity file, recovery phrase or wallet to sign in again here."

export function KeysPanel(): JSX.Element {
  const { identity, keyLimits, storage, funds, logout, forget, revokeStored, isLoading, grants, unlimitedKey, unboundedKey } = useAuth()
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
  const [topUpOpen, setTopUpOpen] = useState(false)
  // Only a stored Forge browser key (a budget on a group-bound key) can be topped up here.
  const canTopUp = storage === 'vault' && keyLimits?.total != null

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
      {storage === 'vault' && unlimitedKey ? (
        <div className="space-y-2">
          <UnlimitedKeyWarning unbounded={unboundedKey} />
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
            Platform cannot add limits to a key that was registered without them. Replace it with a limited key (your identity file or recovery phrase,
            once: the wallet keys this browser holds are disabled in the same update), or disable it on chain.
          </p>
        </div>
      ) : null}
      {storage === 'vault' && grants && !grants.collab ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-anvil-200 px-3 py-2 dark:border-anvil-800" data-testid="grant-collab">
          <span>This sign-in covers repositories and pushes. Issues, pull requests and stars need one more wallet approval.</span>
          <Button variant="outline" size="sm" onClick={() => openLogin('grant')}>
            <Wallet className="h-3.5 w-3.5" aria-hidden /> Approve in wallet
          </Button>
        </div>
      ) : null}
      {low ? (
        <p className="text-caution">This browser&apos;s key is nearly used up. Top it up or renew it (uses your master key once).</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canTopUp ? (
          <Button variant="primary" size="sm" onClick={() => setTopUpOpen(true)}>
            <BatteryCharging className="h-3.5 w-3.5" aria-hidden /> Top up key budget
          </Button>
        ) : null}
        <Button variant={unlimitedKey ? 'primary' : 'outline'} size="sm" onClick={() => openLogin('import')}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden /> {unlimitedKey ? 'Replace with a limited key' : 'Renew key'}
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
              <ShieldOff className="h-3.5 w-3.5" aria-hidden /> {unlimitedKey ? 'Disable key on chain' : 'Revoke on chain'}
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
        Top-up keeps this key and adds budget (or a later expiry). Renew replaces it with a new key and disables this one.
        Both use your master key once and do not store it.
      </p>
      {topUpOpen ? <KeyTopUpDialog onClose={() => setTopUpOpen(false)} /> : null}
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
