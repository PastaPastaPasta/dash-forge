'use client'

/**
 * The one line Settings → Storage shows about settings that follow the identity
 * (docs/design/identity-synced-state.md §5), collapsed. Nothing where forge-user is not deployed.
 */

import { useUserSyncStatus } from '@/hooks/use-user-sync'
import type { UserSyncStatus } from '@/lib/user-sync/session'
import { formatDate } from '@/lib/view/format'

function noteText(status: UserSyncStatus, synced: boolean): string {
  if (synced) {
    const last = 'syncedAt' in status && status.syncedAt !== null ? ` Last synced ${formatDate(status.syncedAt)}.` : ''
    return `Your storage and display settings follow your identity to every device where you sign in with your Dash wallet.${last}`
  }
  if (status.kind === 'error') return `Your settings could not sync just now (${status.message}). They stay on this device and sync again later.`
  return 'To share these settings with your other devices, sign in with your Dash wallet and unlock this browser.'
}

export function SyncNote(): JSX.Element | null {
  const status = useUserSyncStatus()
  if (status.kind === 'off') return null
  const synced = status.kind === 'synced' || (status.kind === 'syncing' && status.syncedAt !== null)
  return (
    <details className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="sync-note">
      <summary className="cursor-pointer coarse:py-2">{synced ? 'Synced with your identity' : 'On this device only'}</summary>
      <p className="max-w-2xl pt-1">{noteText(status, synced)}</p>
    </details>
  )
}
