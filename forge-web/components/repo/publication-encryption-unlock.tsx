'use client'

import { UnlockMore } from '@/components/auth/unlock-more'
import { useAuth } from '@/contexts/auth-context'
import { EncryptionKeyLockedError } from '@/lib/auth/vault'

/** A signing-only session can open its encryption key with the existing inline vault unlock. */
export function PublicationEncryptionUnlock({ error, then }: { error: unknown; then?: () => void }): JSX.Element | null {
  const { unlockScope } = useAuth()
  if (!(error instanceof EncryptionKeyLockedError) || unlockScope !== 'signing') return null
  return <UnlockMore title="Unlock this tab to use your encryption key" testId="make-public-encryption-unlock" forgot={false} then={then} />
}
