'use client'

/**
 * Settings → Devices & keys → Passkeys: the passkeys that hold this browser's key on Platform, so
 * another device signs in with one. List them (this device or another, the key each holds and its
 * state), add one (two prompts), update one that holds an older key, remove one, and finish or
 * discard one that was made but not yet seen on Platform ("Check again").
 *
 * Every device shares the same key and budget: disabling the key signs all of them out. A passkey
 * moves a session. It does not recover an account: when the key expires, the identity file or
 * recovery phrase renews it. Entries stay public on Platform for good, so a passkey holds only keys
 * with a spending limit and an expiry, and the encryption key only when asked.
 *
 * Hidden while `platformPasskeyProblem` is not null, and for a key that is not kept in this
 * browser. A resumed tab asks for an unlock (`UnlockNeededError`), then carries on.
 */

import { useCallback, useEffect, useState } from 'react'
import { Fingerprint, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { CostPreview } from '@/components/ui/cost-preview'
import { useConfirmAction } from '@/components/ui/confirm-action'
import { ErrorBox } from '@/components/auth/protection-fields'
import { UnlockMore } from '@/components/auth/unlock-more'
import { Spinner } from '@/components/ui/states'
import { UnlockNeededError } from '@/lib/auth/controller'
import type { PlatformPasskeyRow } from '@/lib/auth/passkey-vault/service'
import { DOCS } from '@/lib/docs-links'
import { previewCreate, previewDelete } from '@/lib/sdk/cost'
import { formatDate } from '@/lib/view/format'
import { cn, errorMessage } from '@/lib/utils'

/** The anchor the one-time offer links to. */
export const PASSKEYS_ANCHOR = 'passkeys'

export function PasskeysSection(): JSX.Element | null {
  const { identity, storage, platformPasskeyProblem } = useAuth()
  if (identity === null || storage !== 'vault' || platformPasskeyProblem !== null) return null
  return <PasskeysPanel />
}

/** Words for the key a passkey holds and its state. */
function keyWords(row: PlatformPasskeyRow): string {
  switch (row.keyState) {
    case 'disabled':
      return `key #${row.keyId}, which was disabled`
    case 'expired':
      return `key #${row.keyId}, which has expired`
    case 'missing':
      return `key #${row.keyId}, which your identity no longer shows`
    default:
      return row.current ? `this browser's key, #${row.keyId}` : `key #${row.keyId}`
  }
}

function PasskeysPanel(): JSX.Element {
  const auth = useAuth()
  const { listPlatformPasskeys, pendingPlatformPasskey, platformPasskeyLeftOut, removePlatformPasskey, resealPlatformPasskeys, finishPlatformPasskey, abandonPlatformPasskey } = auth
  const [rows, setRows] = useState<PlatformPasskeyRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [leftOut, setLeftOut] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  // A passkey action that found this tab holding only its signing key: unlock, then run it again.
  const [unlockThen, setUnlockThen] = useState<(() => void) | null>(null)
  const [confirm, confirmDialog] = useConfirmAction()

  const load = useCallback(() => {
    setLoadError(null)
    listPlatformPasskeys().then(setRows, (e: unknown) => setLoadError(errorMessage(e)))
    pendingPlatformPasskey().then((p) => setPending(p?.id ?? null), () => undefined)
    platformPasskeyLeftOut().then(setLeftOut, () => undefined)
  }, [listPlatformPasskeys, pendingPlatformPasskey, platformPasskeyLeftOut])
  useEffect(load, [load])

  /** Run one passkey action; true when it finished. */
  const attempt = async (key: string, run: () => Promise<unknown>): Promise<boolean> => {
    setBusy(key)
    setError(null)
    try {
      await run()
      return true
    } catch (e) {
      if (e instanceof UnlockNeededError) setUnlockThen(() => () => void attempt(key, run))
      else setError(errorMessage(e))
      return false
    } finally {
      setBusy(null)
      load()
    }
  }

  const remove = async (row: PlatformPasskeyRow): Promise<void> => {
    const ok = await confirm({
      title: 'Remove this passkey?',
      body: row.thisDevice
        ? 'It stops signing in on other devices. The key it held keeps working, and so does anything already copied from it. Its deposit comes back.'
        : "It stops signing in on the device that made it. The key it held keeps working, and so does anything already copied from it. Its deposit comes back.",
      confirmLabel: 'Remove passkey',
    })
    if (ok) await attempt(`remove:${row.id}`, () => removePlatformPasskey(row.id))
  }

  const discard = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Discard the unfinished passkey?',
      body: "If Platform already has its entry, that entry is deleted first. The passkey then stays in your passkey provider's list until you delete it there.",
      confirmLabel: 'Discard',
    })
    if (ok) await attempt('discard', () => abandonPlatformPasskey())
  }

  return (
    <section
      id={PASSKEYS_ANCHOR}
      aria-labelledby="passkeys-title"
      className="scroll-mt-20 space-y-3 rounded-lg border border-anvil-200 p-4 text-dense dark:border-anvil-800"
      data-testid="passkeys-section"
    >
      <h2 id="passkeys-title" className="flex items-center gap-2 font-medium text-anvil-500 dark:text-anvil-400">
        <Fingerprint className="h-4 w-4" aria-hidden /> Passkeys for other devices
      </h2>
      <p className="text-anvil-700 dark:text-anvil-200" data-testid="passkeys-explain">
        A passkey moves this sign-in to another device. It doesn&apos;t recover an account: when the key expires, renew it with your identity file or recovery phrase.
      </p>
      <p className="text-anvil-700 dark:text-anvil-200" data-testid="passkeys-shared">
        Every device shares the same key and budget, so disabling the key signs them all out.{' '}
        <a href={`${DOCS.identity}#passkeys`} target="_blank" rel="noreferrer noopener" className="text-forge-700 underline dark:text-forge-400">
          How passkeys work →
        </a>
      </p>
      {leftOut > 0 ? (
        <p className="text-[12px] text-anvil-600 dark:text-anvil-300" data-testid="passkeys-left-out">
          Keys without a spending limit stay on this device only. {leftOut === 1 ? '1 key here has' : `${leftOut} keys here have`} no limit or no expiry, so no passkey holds {leftOut === 1 ? 'it' : 'them'}.
        </p>
      ) : null}

      {loadError !== null ? <ErrorBox error={`Couldn't read your passkeys: ${loadError}`} className="mt-0" /> : null}
      {rows === null && loadError === null ? <Spinner label="Reading your passkeys" /> : null}
      {rows !== null && rows.length === 0 && pending === null ? (
        <p className="text-anvil-500 dark:text-anvil-400" data-testid="passkeys-empty">
          No passkeys yet.
        </p>
      ) : null}

      {pending !== null ? (
        <div className="space-y-2 rounded-md border border-caution/40 bg-caution/5 p-3" data-testid="passkey-pending">
          <p>A passkey you added isn&apos;t on Platform yet. Check again in a minute, or discard it.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" loading={busy === 'check'} disabled={busy !== null} onClick={() => void attempt('check', () => finishPlatformPasskey())} data-testid="passkey-check-again">
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Check again
            </Button>
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void discard()} data-testid="passkey-discard">
              Discard
            </Button>
          </div>
        </div>
      ) : null}

      {rows !== null && rows.length > 0 ? (
        <ul className="divide-y divide-anvil-200 rounded-lg border border-anvil-200 dark:divide-anvil-800 dark:border-anvil-800" data-testid="passkey-rows">
          {rows.map((row) => (
            <li key={row.id} className="space-y-1 px-3 py-3" data-testid="passkey-row" data-passkey-id={row.id} data-this-device={row.thisDevice || undefined}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{row.thisDevice ? 'This device' : 'Another device'}</span>
                {row.needsUpdate ? <Chip tone="caution">Needs update</Chip> : null}
                {row.encryptionKey ? <Chip tone="muted">Holds your encryption key</Chip> : null}
              </div>
              <p className="text-[12px] text-anvil-600 dark:text-anvil-300">
                {row.addedAt !== null ? `Added ${formatDate(row.addedAt)}. ` : ''}Holds {keyWords(row)}.
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                {row.needsUpdate ? (
                  <Button
                    size="sm"
                    variant="primary"
                    loading={busy === `update:${row.id}`}
                    disabled={busy !== null}
                    onClick={() => void attempt(`update:${row.id}`, () => resealPlatformPasskeys({ id: row.id }))}
                    data-testid="passkey-update"
                  >
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Update with this passkey
                  </Button>
                ) : null}
                <Button size="sm" variant="outline" loading={busy === `remove:${row.id}`} disabled={busy !== null} onClick={() => void remove(row)} data-testid="passkey-remove">
                  <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {rows?.some((r) => r.needsUpdate) ? (
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="passkeys-update-note">
          Update asks for that passkey once, then saves this browser&apos;s current keys into it.
        </p>
      ) : null}

      {unlockThen !== null ? (
        <UnlockMore
          forgot={false}
          title="Unlock this tab to manage passkeys"
          testId="passkeys-unlock"
          then={() => {
            const again = unlockThen
            setUnlockThen(null)
            again()
          }}
        />
      ) : null}
      <ErrorBox error={error} className="mt-0" />

      <Button variant="outline" size="sm" disabled={busy !== null || pending !== null} onClick={() => setAdding(true)} data-testid="passkey-add">
        <Plus className="h-3.5 w-3.5" aria-hidden /> Add a passkey
      </Button>
      {pending !== null ? <p className="text-[12px] text-anvil-500 dark:text-anvil-400">Finish or discard the passkey above first.</p> : null}

      {adding ? (
        <AddPasskeyDialog
          leftOut={leftOut}
          onClose={() => {
            setAdding(false)
            load()
          }}
        />
      ) : null}
      {confirmDialog}
    </section>
  )
}

function Chip({ tone, children }: { tone: 'caution' | 'muted'; children: React.ReactNode }): JSX.Element {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[11px] font-medium',
        tone === 'caution' && 'bg-caution/15 text-caution-700 dark:text-caution-400',
        tone === 'muted' && 'bg-anvil-100 text-anvil-700 dark:bg-anvil-800 dark:text-anvil-200',
      )}
    >
      {children}
    </span>
  )
}

/**
 * Add a passkey: what it holds, the choice of the encryption key (off, with the warning that a
 * written entry cannot be taken back), what it costs, then the two prompts. A resumed tab unlocks
 * first and carries on; a passkey made but not yet seen on Platform closes the dialog and shows
 * "Check again" in the section.
 */
function AddPasskeyDialog({ leftOut, onClose }: { leftOut: number; onClose: () => void }): JSX.Element {
  const { identity, vaults, addPlatformPasskey, isLoading } = useAuth()
  const holdsEncryption = vaults.find((v) => v.identityId === identity)?.encryptionKey === true
  const [withEncryption, setWithEncryption] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [needsUnlock, setNeedsUnlock] = useState(false)

  const add = async (): Promise<void> => {
    if (working) return
    setWorking(true)
    setError(null)
    try {
      await addPlatformPasskey({ includeEncryptionKey: withEncryption })
      onClose()
    } catch (e) {
      if (e instanceof UnlockNeededError) setNeedsUnlock(true)
      else if ((e as { code?: unknown } | null)?.code === 'pending') {
        // Made, not seen yet: the section offers "Check again".
        onClose()
        return
      } else setError(errorMessage(e))
    } finally {
      setWorking(false)
    }
  }

  return (
    <Dialog open onClose={onClose} title="Add a passkey" description="Your other devices sign in with it. It holds this browser's key.">
      <div className="space-y-4 text-dense">
        {/* Outside the form: nested in it, the unlock's button would submit the add instead. */}
        {needsUnlock ? (
          <UnlockMore
            forgot={false}
            title="Unlock this tab to add a passkey"
            testId="passkey-add-unlock"
            then={() => {
              setNeedsUnlock(false)
              void add()
            }}
          />
        ) : null}
        <form
          className="space-y-4"
          data-testid="passkey-add-dialog"
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <p className="text-anvil-600 dark:text-anvil-300">You approve twice: once to make the passkey, once to confirm it. It works only on Forge&apos;s own address.</p>
          <label className="flex items-start gap-2 rounded-md border border-anvil-200 p-3 dark:border-anvil-800">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={withEncryption}
              disabled={!holdsEncryption}
              onChange={(e) => setWithEncryption(e.target.checked)}
              data-testid="passkey-include-encryption"
            />
            <span>
              <span className="font-medium">Also keep my encryption key</span>
              <span className="block text-[12px] text-anvil-500 dark:text-anvil-400">
                {holdsEncryption
                  ? 'The new device then opens private repos too.'
                  : "This browser doesn't hold your encryption key. Add it in Settings → Members-only and private content first."}
              </span>
            </span>
          </label>
          {withEncryption ? (
            <p className="rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-caution-700 dark:text-caution-400" data-testid="passkey-encryption-warning">
              Removing the passkey later can&apos;t take the encryption key back. Anyone who has the passkey keeps it until you replace that key.
            </p>
          ) : null}
          {leftOut > 0 ? (
            <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="passkey-add-left-out">
              Keys without a spending limit stay on this device only.
            </p>
          ) : null}
          <div className="space-y-1">
            <CostPreview cost={previewCreate('vaultEntry')} />
            <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
              Paid from this browser&apos;s key budget. Removing the passkey refunds about {Math.abs(previewDelete('vaultEntry').dash).toFixed(4)} DASH.
            </p>
          </div>
          <ErrorBox error={error} className="mt-0" />
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" className="flex-1" loading={working} disabled={working || isLoading || needsUnlock} data-testid="passkey-add-confirm">
              <Fingerprint className="h-3.5 w-3.5" aria-hidden /> Add passkey
            </Button>
          </div>
        </form>
      </div>
    </Dialog>
  )
}
