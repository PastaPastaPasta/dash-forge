'use client'

/**
 * useEnvironments — a repo's environments as this viewer can read them ({@link readEnvironments}),
 * for Settings → Environments and the member-removal confirmation. Members snapshots open with
 * the members key this tab already holds (a public repo's `home.lane` session, or a private
 * repo's session); Maintainers snapshots open with this browser's encryption keys, only while
 * the tab is unlocked. The book lives in this hook's state only: nothing decrypted is stored
 * (no IndexedDB, localStorage or service-worker copy), and it is dropped when the tab locks or
 * the members-key session changes.
 */

import { useAuth } from '@/contexts/auth-context'
import { useAsync, type AsyncState } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { encryptionKeyState, withLetterReader } from '@/lib/auth/encryption-key'
import { readEnvironments, type EnvBook, type EnvKeys } from '@/lib/env/loader'
import { sdkEnvSources } from '@/lib/env/sources'
import { privateId } from '@/lib/private'
import { repoContractIds } from '@/lib/repo'
import type { PrivateSession } from '@/lib/repo/private-session'
import type { RepoHome } from '@/lib/view'

/** The members-key session this tab holds for `home` (a public repo's members-only content, or a private repo). */
export function membersSessionOf(home: RepoHome): PrivateSession | null {
  if (home.lane?.access === 'member') return home.lane.session
  if (home.private?.access === 'member') return home.private.session
  return null
}

export interface EnvironmentsRead {
  readonly book: EnvBook
  /** This browser's encryption key for the viewer: `locked` asks for the tab's unlock. */
  readonly encryption: 'open' | 'locked' | 'none'
}

export interface EnvironmentsState {
  readonly state: AsyncState<EnvironmentsRead>
  /** This tab holds a key it could open environments with, once unlocked. */
  readonly locked: boolean
}

/** `enabled: false` reads nothing (a closed dialog). */
export function useEnvironments(home: RepoHome, enabled = true): EnvironmentsState {
  const repo = home.repo
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const { identity, unlockScope } = useAuth()
  const session = membersSessionOf(home)
  const state = useAsync<EnvironmentsRead>(
    async () => {
      const encryption = identity === null ? 'none' : await encryptionKeyState(network, identity)
      const reader = encryption === 'open' && identity !== null ? identity : null
      const keys: EnvKeys = {
        repoId: privateId(repo.repoId),
        members: session === null ? null : { keys: session.resolution.keys, resolution: session.resolution },
        withReader: (use) => (reader === null ? use(null) : withLetterReader(network, reader, use)),
        hasReader: reader !== null,
      }
      return { book: await readEnvironments(sdkEnvSources(sdk!, repo), keys), encryption }
    },
    [ready, network, repo.repoId, identity ?? '', unlockScope ?? '', session?.id ?? ''],
    { enabled: enabled && ready && sdk !== null },
  )
  const locked = home.lane?.access === 'locked' || home.private?.access === 'locked' || state.data?.encryption === 'locked'
  return { state, locked }
}
