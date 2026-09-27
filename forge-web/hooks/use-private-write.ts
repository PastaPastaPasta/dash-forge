'use client'

/**
 * usePrivateWrite — what a private-repo write needs from this browser: the signer, and the
 * vault's encryption operations (null while locked, signed out, or with no key stored). The
 * raw key never reaches React: only the operations object does.
 */

import { useAuth } from '@/contexts/auth-context'
import { useAsync } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { encryptionOps } from '@/lib/auth/encryption-key'
import type { RepoRef } from '@/lib/repo'
import type { PrivateWriteContext } from '@/lib/repo/private-members'
import { refreshPrivateHome } from '@/hooks/use-private-home'

export function usePrivateWrite(repo: RepoRef): {
  readonly context: PrivateWriteContext | null
  /** After a membership or key change: re-read this repo (the page stays up meanwhile). */
  readonly done: () => void
} {
  const { sdk, ready, network } = useSdk([repo.forge.core, repo.forge.collab])
  const { identity, signer } = useAuth()
  const ops = useAsync(
    () => encryptionOps(sdk!, network, identity!, repo.forge.core),
    [ready, network, identity ?? '', repo.forge.core, repo.session?.id ?? ''],
    { enabled: ready && sdk !== null && identity !== null },
  )
  const context: PrivateWriteContext | null =
    sdk !== null && signer !== null && ops.data !== null ? { sdk, auth: signer, repo, network, ops: ops.data } : null
  return { context, done: () => refreshPrivateHome(repo) }
}
