'use client'

/**
 * The one line Settings → Storage shows about settings that follow the identity
 * (docs/design/identity-synced-state.md §5), collapsed. Nothing where forge-user is not deployed.
 * Synced: it also holds "Move sync to a new key". Moved (this browser holds a key the identity left):
 * one action, "Add the new key"; a browser that lacks the identity's sync key: "Add the sync key".
 */

import { useState } from 'react'

import { ADD_ACTION, ADD_SYNC_KEY, MOVED_LINE, MOVE_ACTION, SyncKeySheet, type SyncKeyMode } from '@/components/storage/sync-key-sheet'
import { useUserSyncStatus } from '@/hooks/use-user-sync'
import type { UserSyncStatus } from '@/lib/user-sync/session'
import { formatDate } from '@/lib/view/format'

export const ADD_KEY_LINE = "Your identity syncs its settings with a key this browser doesn't have yet."

function noteText(status: UserSyncStatus, synced: boolean): string {
  if (synced) {
    const last = 'syncedAt' in status && status.syncedAt !== null ? ` Last synced ${formatDate(status.syncedAt)}.` : ''
    return `Your storage and display settings follow your identity to every device where you sign in with your Dash wallet.${last}`
  }
  if (status.kind === 'error') return `Your settings could not sync just now (${status.message}). They stay on this device and sync again later.`
  if (status.kind === 'local' && status.addKey === true) return ADD_KEY_LINE
  return 'To share these settings with your other devices, sign in with your Dash wallet and unlock this browser.'
}

const ACTION = 'text-forge-700 underline hover:no-underline dark:text-forge-400 coarse:py-2'

export function SyncNote(): JSX.Element | null {
  const status = useUserSyncStatus()
  const [sheet, setSheet] = useState<{ readonly mode: SyncKeyMode; readonly title: string } | null>(null)
  if (status.kind === 'off') return null
  const synced = status.kind === 'synced' || (status.kind === 'syncing' && status.syncedAt !== null)
  const sheetEl = sheet === null ? null : <SyncKeySheet mode={sheet.mode} title={sheet.title} open onClose={() => setSheet(null)} />
  if (status.kind === 'moved') {
    return (
      <>
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="sync-note">
          {MOVED_LINE}{' '}
          <button type="button" className={ACTION} onClick={() => setSheet({ mode: 'add', title: ADD_ACTION })} data-testid="sync-add-key">
            {ADD_ACTION}
          </button>
        </p>
        {sheetEl}
      </>
    )
  }
  const addKey = status.kind === 'local' && status.addKey === true
  return (
    <>
      <details className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="sync-note">
        <summary className="cursor-pointer coarse:py-2">{synced ? 'Synced with your identity' : 'On this device only'}</summary>
        <p className="max-w-2xl pt-1">{noteText(status, synced)}</p>
        {addKey ? (
          <button type="button" className={`mt-1 ${ACTION}`} onClick={() => setSheet({ mode: 'add', title: ADD_SYNC_KEY })} data-testid="sync-add-key">
            {ADD_SYNC_KEY}
          </button>
        ) : null}
        {status.kind === 'synced' ? (
          <button type="button" className={`mt-1 ${ACTION}`} onClick={() => setSheet({ mode: 'move', title: MOVE_ACTION })} data-testid="sync-move-key">
            {MOVE_ACTION}
          </button>
        ) : null}
      </details>
      {sheetEl}
    </>
  )
}
