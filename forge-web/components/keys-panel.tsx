'use client'

/**
 * Settings → This browser's key (`ux-dx-spec.md` §2.3): which key signs here, what is left of
 * its budget, when it expires, and how to extend it. **Top up** raises this key's budget and
 * expiry in place (`IdentityKeyLimitsUpdate`; same key). **Renew** registers a fresh limited key
 * and disables this one. Both need the master key once (identity file or phrase), which is not
 * stored. Also: lock now, and sign out + forget.
 */

import { useState } from 'react'
import { GRANT_COPY, nextGrant } from '@/lib/auth/key-registration'
import { BatteryCharging, Lock, LogOut, RefreshCw, ShieldOff, Wallet } from 'lucide-react'
import { UnlimitedKeyWarning } from '@/components/auth/wallet-connect-flow'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { creditsAsDash, formatDate } from '@/lib/view/format'
import { keyBudgetWords } from '@/lib/view/funds'
import { INSIGHT_OVERRIDE_KEY, coreEndpoints } from '@/lib/auth/asset-lock'
import { hasTopUpNote } from '@/lib/auth/identity-top-up'
import { ACTIVE_NETWORK } from '@/lib/constants'
import { KeyTopUpDialog } from '@/components/key-top-up-dialog'
import { KeyRevokeDialog } from '@/components/key-revoke-dialog'
import { PendingRenewal } from '@/components/pending-renewal'
import { useConfirmAction, type ConfirmActionOptions } from '@/components/ui/confirm-action'

/** Shown before deleting a stored key: for a wallet-granted key this is the only copy. */
export const FORGET_CONFIRM: ConfirmActionOptions = {
  title: "Forget this browser's key?",
  body: "This deletes the key from this device. It does not revoke it: the key stays valid on chain until it expires, and a wallet key never expires (use \"Revoke on chain\" or \"Disable key on chain\" for that). You will need your identity file, recovery phrase or wallet to sign in here again.",
  confirmLabel: 'Forget key',
}

/**
 * What stays after a forget or a revoke, for an identity topped up in this browser (QW3-034):
 * the note of where its next top-up starts. Said rather than silently kept.
 */
export const TOP_UP_NOTE_STAYS =
  'One note about this identity stays in this browser because you topped it up here: which top-up address comes next (no keys, no words), so a later top-up never reuses an address or misses a deposit left at one.'

/** {@link FORGET_CONFIRM}, saying what stays when the identity was topped up here. */
export async function forgetConfirm(identityId: string): Promise<ConfirmActionOptions> {
  const note = await hasTopUpNote(ACTIVE_NETWORK.network, identityId).catch(() => false)
  return note ? { ...FORGET_CONFIRM, body: `${FORGET_CONFIRM.body} ${TOP_UP_NOTE_STAYS}` } : FORGET_CONFIRM
}

export function KeysPanel(): JSX.Element {
  const { identity, keyId, heldOnly, keyLimits, storage, funds, balance, logout, forget, isLoading, grants, unlimitedKey, unboundedKey } = useAuth()
  // What is left of the key's budget, and when the balance is lower, that it caps it (QW3-033).
  const budget = keyLimits === null ? null : keyBudgetWords(keyLimits, balance === null ? null : BigInt(balance), creditsAsDash)
  // Revoke opens a dialog that explains it and takes the identity file or the recovery phrase
  // (QW2-017): a browser-created identity has no file.
  const [revokeOpen, setRevokeOpen] = useState(false)
  const [confirm, confirmDialog] = useConfirmAction()
  const openLogin = useUiStore((s) => s.openLogin)
  const missingGrant = nextGrant(grants)
  const [explorer, setExplorer] = useState(() =>
    typeof window === 'undefined' ? '' : window.localStorage.getItem(INSIGHT_OVERRIDE_KEY) ?? '',
  )
  // What the field accepts: an https URL (http would let a network observer answer for it).
  const explorerProblem = explorer.trim() !== '' && !/^https:\/\/[^\s/]+/.test(explorer.trim()) ? 'Use an https:// address. Not saved.' : null
  const low = funds?.reason === 'key-budget' || funds?.reason === 'key-expiry'
  const [topUpOpen, setTopUpOpen] = useState(false)
  // Only a stored Forge browser key (a budget on a group-bound key) can be topped up here.
  const canTopUp = storage === 'vault' && keyLimits?.total != null
  // A pasted key is not Forge's to renew (it may be a wallet's, and has no Forge limits): the
  // offer is a limited key from the identity file or phrase instead, and signing out forgets it.
  const pasted = storage === 'session'

  return (
    <div className="space-y-4 text-dense" data-testid="keys-panel">
      {identity ? <PendingRenewal identityId={identity} /> : null}
      {storage === 'session' ? (
        <p className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-danger-700 dark:text-danger-400">
          This tab signs with a pasted key that has no Forge limits. It is forgotten on reload.
        </p>
      ) : keyLimits ? (
        <dl className="grid grid-cols-2 gap-2">
          {keyId !== null ? (
            <>
              <dt className="text-anvil-500 dark:text-anvil-400">Key</dt>
              <dd data-testid="key-id" data-key-id={keyId} className="font-mono">
                #{keyId}
              </dd>
            </>
          ) : null}
          <dt className="text-anvil-500 dark:text-anvil-400">Budget left</dt>
          <dd data-testid="key-budget">
            {budget === null ? (
              <span className="font-mono">—</span>
            ) : (
              <>
                <span className="font-mono">{budget.left}</span>
                {budget.cap !== null ? (
                  <span className="block text-[12px] text-caution-700 dark:text-caution-400" data-testid="key-budget-cap">
                    {budget.cap}
                  </span>
                ) : null}
              </>
            )}
          </dd>
          <dt className="text-anvil-500 dark:text-anvil-400">Expires</dt>
          <dd data-testid="key-expiry">{keyLimits.expiresAt === null ? 'never' : formatDate(keyLimits.expiresAt)}</dd>
          <dt className="text-anvil-500 dark:text-anvil-400">Scope</dt>
          <dd>dash-forge contracts only</dd>
        </dl>
      ) : (
        <p className="text-anvil-500 dark:text-anvil-400">This key has no budget or expiry.</p>
      )}
      {heldOnly.length > 0 ? (
        <p className="rounded-md border border-anvil-200 px-3 py-2 dark:border-anvil-800" data-testid="held-only-keys" data-key-ids={heldOnly.join(',')}>
          Also held, never used to sign: key{heldOnly.length > 1 ? 's' : ''} {heldOnly.map((k) => `#${k}`).join(', ')}, from a key renewal you gave up.
          Your next renewal or &quot;Revoke on chain&quot; disables {heldOnly.length > 1 ? 'them' : 'it'}.
        </p>
      ) : null}
      {storage === 'vault' && unlimitedKey ? (
        <div className="space-y-2">
          <UnlimitedKeyWarning unbounded={unboundedKey} />
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
            Platform cannot add limits to a key that was registered without them. Replace it with a limited key (your identity file or recovery phrase,
            once: the wallet keys this browser holds are disabled in the same update), or disable it on chain.
          </p>
        </div>
      ) : null}
      {storage === 'vault' && missingGrant !== null ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-anvil-200 px-3 py-2 dark:border-anvil-800" data-testid="grant-collab">
          <span>This sign-in covers repositories and pushes. {GRANT_COPY[missingGrant].what} need one more wallet approval.</span>
          <Button variant="outline" size="sm" onClick={() => openLogin('grant', missingGrant)}>
            <Wallet className="h-3.5 w-3.5" aria-hidden /> Approve in wallet
          </Button>
        </div>
      ) : null}
      {low ? (
        <p className="text-caution-700 dark:text-caution-400">This browser&apos;s key is nearly used up. Top it up or renew it (uses your master key once).</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canTopUp ? (
          <Button variant="primary" size="sm" onClick={() => setTopUpOpen(true)}>
            <BatteryCharging className="h-3.5 w-3.5" aria-hidden /> Top up key budget
          </Button>
        ) : null}
        <Button variant={unlimitedKey || pasted ? 'primary' : 'outline'} size="sm" onClick={() => openLogin('import')}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden /> {pasted ? 'Use a limited key instead' : unlimitedKey ? 'Replace with a limited key' : 'Renew key'}
        </Button>
        {pasted ? (
          <Button variant="danger" size="sm" onClick={() => logout()}>
            <LogOut className="h-3.5 w-3.5" aria-hidden /> Sign out
          </Button>
        ) : (
          <>
            <Button variant="outline" size="sm" onClick={() => logout()}>
              <Lock className="h-3.5 w-3.5" aria-hidden /> Lock
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                if (identity) void forgetConfirm(identity).then(confirm).then((ok) => (ok ? forget(identity) : undefined))
              }}
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden /> Sign out &amp; forget key
            </Button>
          </>
        )}
        {storage === 'vault' ? (
          <>
            <Button variant="danger" size="sm" loading={isLoading} onClick={() => setRevokeOpen(true)} data-testid="key-revoke">
              <ShieldOff className="h-3.5 w-3.5" aria-hidden /> {unlimitedKey ? 'Disable key on chain' : 'Revoke on chain'}
            </Button>
          </>
        ) : null}
      </div>
      {pasted ? (
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
          Importing your identity file or recovery phrase gives this browser its own key, limited to Forge, a budget and an expiry. The pasted key
          is left as it is: Forge did not register it, so it does not renew or revoke it.
        </p>
      ) : (
        <>
          {unlimitedKey ? null : (
            <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
              {canTopUp ? 'Top-up keeps this key and adds budget (or a later expiry). ' : ''}Renew replaces it with a new key and disables this one.
              {canTopUp ? ' Both use' : ' It uses'} your master key once and {canTopUp ? 'do' : 'does'} not store it.
            </p>
          )}
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
            Forgetting deletes the key from this device only. Revoking disables it on chain (needs your identity file or recovery phrase once).
          </p>
        </>
      )}
      {topUpOpen ? <KeyTopUpDialog onClose={() => setTopUpOpen(false)} /> : null}
      {revokeOpen ? <KeyRevokeDialog unlimited={unlimitedKey} onClose={() => setRevokeOpen(false)} /> : null}
      {confirmDialog}
      <Field
        label="Fallback block explorer (asked only if the network's nodes cannot see an identity deposit)"
        htmlFor="explorer-url"
        hint={`Insight API base URL. Leave empty for this network's default (${coreEndpoints().insight}). It can delay you but cannot take funds or keys.`}
      >
        <Input
          id="explorer-url"
          value={explorer}
          aria-invalid={explorerProblem !== null}
          placeholder={coreEndpoints().insight}
          onChange={(e) => {
            setExplorer(e.target.value)
            const v = e.target.value.trim()
            if (v === '') window.localStorage.removeItem(INSIGHT_OVERRIDE_KEY)
            else if (/^https:\/\//.test(v)) window.localStorage.setItem(INSIGHT_OVERRIDE_KEY, v.replace(/\/+$/, ''))
          }}
        />
        {explorerProblem ? (
          <p role="alert" className="text-[12px] text-danger-700 dark:text-danger-400">
            {explorerProblem}
          </p>
        ) : null}
      </Field>
    </div>
  )
}
