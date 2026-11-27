'use client'

/**
 * The recovery-phrase sheet for settings sync's key (#751): "Move sync to a new key" (the owner
 * leaves a key a site they approved may have kept) and "Add the new key" (this browser takes the
 * key sync moved to). One line of why, the phrase, one button; the phrase is dropped after use.
 */

import Link from 'next/link'
import { useRef, useState } from 'react'

import { PhraseWarning } from '@/components/auth/phrase-warning'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Textarea } from '@/components/ui/input'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/hooks/use-sdk'
import { addSyncKeyWithPhrase, moveSyncKeyWithPhrase } from '@/lib/auth/sync-key-move'
import { ACTIVE_NETWORK, DEFAULT_NETWORK } from '@/lib/constants'
import { DOCS } from '@/lib/docs-links'
import { namedAction, spendAction } from '@/lib/spend-toast'
import { errorMessage } from '@/lib/utils'

export type SyncKeyMode = 'move' | 'add'

export const MOVE_ACTION = 'Move sync to a new key'
export const ADD_ACTION = 'Add the new key'
/** The same action where nothing moved: this browser lacks the identity's sync key. */
export const ADD_SYNC_KEY = 'Add the sync key'
export const MOVED_LINE = 'Your synced settings moved to a new key.'
export const BEHIND_LINE = 'Some of your synced settings are still on an older key.'
export const FINISH_ACTION = 'Finish the move'
export const FINISH_WHY = 'A move to a new key stopped part-way. Enter your recovery phrase to finish it; no second key is registered.'
export const MOVE_WHY = 'A site you approved in your wallet may have kept your sync key. A new key, made from your recovery phrase, shuts the old one out of your synced settings and shared storage.'
export const ADD_WHY = 'Your settings sync with a key made from your recovery phrase. Enter it once to add that key to this browser.'
export const ADDED = 'Done. Your settings sync in this browser.'
export const MOVED_DONE = 'Done. Your settings sync with a new key.'
export const ROTATE_NOW = 'Rotate your storage credentials now: the old key saw them. Update each profile here and the change syncs under the new key.'
export const OTHER_DEVICES = 'Your other devices need the new key once: Settings → Storage → Add the new key, with your recovery phrase.'
export const WALLET_NOTE = 'Wallet sign-ins no longer carry the sync key.'
export const ALREADY_NEWEST = 'Your synced settings already use your newest key.'

const BUTTON: Record<SyncKeyMode, string> = { move: 'Move to a new key', add: 'Add the key' }

export function SyncKeySheet({ mode, open, onClose, title, why }: { readonly mode: SyncKeyMode; readonly open: boolean; readonly onClose: () => void; readonly title?: string; readonly why?: string }): JSX.Element | null {
  const { identity, signer, controller } = useAuth()
  const { sdk, ready } = useSdk()
  const contractId = ACTIVE_NETWORK.v2?.user
  const phrase = useRef<HTMLTextAreaElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<'added' | 'moved' | 'unchanged' | null>(null)

  const close = (): void => {
    if (busy) return
    setError(null)
    setDone(null)
    onClose()
  }

  const submit = async (): Promise<void> => {
    const mnemonic = phrase.current?.value ?? ''
    if (phrase.current) phrase.current.value = ''
    if (identity === null || contractId === undefined || !ready || sdk === null) {
      setError('Still connecting to Platform; try again in a moment.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const input = { sdk, network: DEFAULT_NETWORK, networkKey: ACTIVE_NETWORK.key, identityId: identity, contractId, mnemonic }
      if (mode === 'add') {
        await addSyncKeyWithPhrase(input)
        setDone('added')
      } else {
        if (signer === null) throw new Error('Sign in again to change your sync key.')
        const out = await spendAction(namedAction('Sync moved to a new key'), (tag) =>
          moveSyncKeyWithPhrase({
            ...input,
            auth: tag(signer),
            charged: async (update) => {
              await controller.chargedUpdate(identity, 'key:encryption', async () => {
                await update()
                return true
              })
            },
          }),
        )
        setDone(!out.created && out.written === 0 ? 'unchanged' : 'moved')
      }
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={title ?? (mode === 'move' ? MOVE_ACTION : ADD_ACTION)}
      footer={
        done ? (
          <Button variant="primary" onClick={close}>
            Close
          </Button>
        ) : (
          <Button variant="primary" loading={busy} onClick={() => void submit()} data-testid="sync-key-submit">
            {BUTTON[mode]}
          </Button>
        )
      }
    >
      {done ? (
        <div className="space-y-2 text-dense" data-testid="sync-key-done">
          {done === 'added' ? (
            <p>{ADDED}</p>
          ) : done === 'unchanged' ? (
            <p>{ALREADY_NEWEST}</p>
          ) : (
            <>
              <p>{MOVED_DONE}</p>
              <p>
                {ROTATE_NOW}{' '}
                <Link prefetch={false} href={DOCS.rotateStorage} className="text-forge-700 underline dark:text-forge-400" target="_blank" rel="noreferrer noopener">
                  How to rotate them
                </Link>
              </p>
              <p>{OTHER_DEVICES}</p>
              <p>{WALLET_NOTE}</p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-dense text-anvil-600 dark:text-anvil-300">{why ?? (mode === 'move' ? MOVE_WHY : ADD_WHY)}</p>
          <PhraseWarning />
          <Field label="Recovery phrase (12 or 24 words)" htmlFor="sync-key-phrase">
            <Textarea id="sync-key-phrase" ref={phrase} autoFocus className="min-h-[64px] font-mono" spellCheck={false} autoComplete="off" />
          </Field>
          {error ? (
            <p role="alert" className="text-[12px] text-danger-700 dark:text-danger-400 break-words">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Dialog>
  )
}
