'use client'

/**
 * useEnvironments — a repo's environments as this viewer can read them ({@link readEnvironments}),
 * for Settings → Environments and the member-removal confirmation. An old-format Members snapshot
 * opens with the members key this tab already holds (a public repo's `home.lane` session, or a
 * private repo's session); every other snapshot is a letter that opens with this browser's
 * encryption keys, only while the tab is unlocked. The book lives in this hook's state only:
 * nothing decrypted is stored (no IndexedDB, localStorage or service-worker copy), and it is
 * dropped when the tab locks or the members-key session changes.
 */

import { useAuth } from '@/contexts/auth-context'
import { useAsync, type AsyncState } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { encryptionKeyState, withLetterReader } from '@/lib/auth/encryption-key'
import { readEnvironments, type EnvBook, type EnvKeys } from '@/lib/env/loader'
import type { PeopleView } from '@/lib/env/view'
import { sdkEnvSources } from '@/lib/env/sources'
import { privateId } from '@/lib/private'
import { readMembershipsCached, repoContractIds } from '@/lib/repo'
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
  /** The signed-in identity (base58), or `null`. */
  readonly viewer: string | null
}

export function useEnvironments(home: RepoHome): EnvironmentsState {
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
    { enabled: ready && sdk !== null },
  )
  return { state, locked: asksToUnlock(home, state.data?.encryption ?? null), viewer: identity }
}

/**
 * The repo's owner and current members, for a maintainer's precise list of who an environment
 * misses (DESIGN §10). Read only when `enabled`; `null` until read or when the read fails (the
 * list is left out then, the rest of the page stands).
 */
export function useRepoPeople(home: RepoHome, enabled: boolean): PeopleView | null {
  const repo = home.repo
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const state = useAsync<PeopleView>(
    async () => ({ owner: repo.ownerId, members: await readMembershipsCached(sdk!, repo, network) }),
    [ready, network, repo.repoId],
    { enabled: enabled && ready && sdk !== null },
  )
  return state.data
}

/**
 * Whether the page asks this viewer to unlock: a member whose tab holds the key locked, or whose
 * browser's encryption key is locked. Never an outsider (of a public repo: no `home.lane`):
 * environments go to the repo's members, so unlocking would open nothing for them.
 */
export function asksToUnlock(home: RepoHome, encryption: EnvironmentsRead['encryption'] | null): boolean {
  if ((home.repo.visibility === 'public' && home.lane === undefined) || home.private?.access === 'outsider') return false
  return home.lane?.access === 'locked' || home.private?.access === 'locked' || encryption === 'locked'
}
