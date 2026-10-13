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

import { useMemo } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useAsync, type AsyncState } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { encryptionKeyState, withLetterReader } from '@/lib/auth/encryption-key'
import { readEnvironments, type EnvBook, type EnvKeys } from '@/lib/env/loader'
import type { MemberEnvIO } from '@/lib/env/member-change'
import { sdkEnvSaver } from '@/lib/env/saver'
import type { EnvSaver } from '@/lib/env/write'
import type { Network } from '@/lib/constants'
import type { PeopleView } from '@/lib/env/view'
import { sdkEnvSources } from '@/lib/env/sources'
import { privateId } from '@/lib/private'
import { readMembershipsCached, readMembershipsFresh, repoContractIds } from '@/lib/repo'
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

/** `enabled` false: nothing is read (a dialog not open yet). */
export function useEnvironments(home: RepoHome, enabled = true): EnvironmentsState {
  const repo = home.repo
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const { identity, unlockScope } = useAuth()
  const session = membersSessionOf(home)
  const state = useAsync<EnvironmentsRead>(
    async () => {
      const { keys, encryption } = await envKeysOf(home, network, identity)
      return { book: await readEnvironments(sdkEnvSources(sdk!, repo), keys), encryption }
    },
    [ready, network, repo.repoId, identity ?? '', unlockScope ?? '', session?.id ?? ''],
    { enabled: enabled && ready && sdk !== null },
  )
  return { state, locked: asksToUnlock(home, state.data?.encryption ?? null), viewer: identity }
}

/**
 * What `identity` opens `home`'s environments with: the members key this tab holds, and this
 * browser's encryption keys while they are unlocked (`encryption`).
 */
export async function envKeysOf(home: RepoHome, network: Network, identity: string | null): Promise<{ readonly keys: EnvKeys; readonly encryption: EnvironmentsRead['encryption'] }> {
  const session = membersSessionOf(home)
  const encryption = identity === null ? 'none' : await encryptionKeyState(network, identity)
  const reader = encryption === 'open' && identity !== null ? identity : null
  const keys: EnvKeys = {
    repoId: privateId(home.repo.repoId),
    members: session === null ? null : { keys: session.resolution.keys, resolution: session.resolution },
    withReader: (use) => (reader === null ? use(null) : withLetterReader(network, reader, use)),
    hasReader: reader !== null,
  }
  return { keys, encryption }
}

/**
 * The reads and writes a maintainer's environment change makes in this tab ({@link EnvSaver},
 * {@link MemberEnvIO}), or `null` while signed out or before the SDK is ready. Reads are fresh
 * every time: a plan never decides from a cached member list.
 */
export function useEnvWriter(home: RepoHome): { readonly saver: EnvSaver; readonly io: MemberEnvIO } | null {
  const repo = home.repo
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const { identity, signer } = useAuth()
  return useMemo(() => {
    if (!ready || sdk === null || signer === null || identity === null) return null
    const saver = sdkEnvSaver(sdk, signer, repo, network)
    const io: MemberEnvIO = {
      read: async (asMaintainer) => {
        const sources = sdkEnvSources(sdk, repo)
        const withExtra = asMaintainer === undefined ? sources : { ...sources, maintainers: async () => [...new Set([...(await sources.maintainers()), asMaintainer])] }
        return readEnvironments(withExtra, (await envKeysOf(home, network, identity)).keys)
      },
      members: () => readMembershipsFresh(sdk, repo, network),
      keys: async (ids) => {
        const got = await saver.keysOf(ids)
        return new Map([...got].map(([id, k]) => [id, k === null ? null : k.keyId]))
      },
    }
    return { saver, io }
    // `home` changes identity on every repo read; what the writer uses of it is the repo and its key session
  }, [ready, sdk, signer, identity, network, repo.repoId, membersSessionOf(home)?.id ?? '']) // eslint-disable-line react-hooks/exhaustive-deps
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
