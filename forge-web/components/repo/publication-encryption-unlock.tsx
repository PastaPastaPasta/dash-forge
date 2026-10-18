'use client'

import { UnlockMore } from '@/components/auth/unlock-more'
import { VaultLockedError } from '@/lib/auth/vault'

/** Only the locked-key failures from withEncryptionKey(s) can be fixed by unlocking here. */
export function PublicationEncryptionUnlock({ error, then }: { error: unknown; then: () => void }): JSX.Element | null {
  if (!(error instanceof VaultLockedError) || !['unlock to use your encryption key in this tab', 'unlock this browser to read private repos'].includes(error.message)) return null
  return <UnlockMore title="Unlock this tab to use your encryption key" testId="make-public-encryption-unlock" forgot={false} then={then} />
}
