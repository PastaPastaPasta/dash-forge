'use client'

/**
 * usePrivateHome — how the signed-in viewer reads a private repo (`docs/security/private-repos.md`
 * §5, §8; `ux-dx-spec.md` §6.3, §9), folded into the {@link RepoHome} every repo page renders.
 *
 * - Public repo: the home as it is.
 * - Private repo: signed out → `signed-out`; not a member → `outsider`; a member whose browser
 *   holds no encryption key → `no-key`; a member with one → the home re-read through their
 *   decryption session (`member`), whose `repo.session` every read of the page then decrypts
 *   through.
 *
 * The decrypted home lives in memory only (a per-tab map for warm navigations, dropped when
 * the vault locks or the encryption key changes).
 */

import { useEffect, useRef, useState } from 'react'

import { useAuth } from '@/contexts/auth-context'
import { useAsync } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { encryptionOps } from '@/lib/auth/encryption-key'
import { readMembershipsCached, repoContractIds } from '@/lib/repo'
import {
  invalidatePrivateSession,
  loadPrivateSessionCached,
  onPrivateSessionsClosed,
  privateSessionGeneration,
  sessionUnwrapper,
} from '@/lib/repo/private-session'
import { loadPrivateHome, type RepoHome } from '@/lib/view'
import { forgetPrivateNav, sealRepoUrls } from '@/lib/view/private-nav'
import type { RepoAddress } from '@/hooks/use-query-param'

export interface PrivateHomeState {
  /** The home to render (the plain one until access is known). */
  readonly home: RepoHome
  /** Access is still being worked out: render a loading state, never the plain home's content. */
  readonly pending: boolean
  readonly error: string | null
  readonly retry: () => void
}

/** Decrypted homes of this tab, by (network, repo, viewer): warm navigations paint at once. */
const warm = new Map<string, RepoHome>()
onPrivateSessionsClosed(() => {
  warm.clear()
  forgetPrivateNav()
})

const refreshListeners = new Set<(repoId: string) => void>()

/** Forget a repo's decrypted home and session (Retry / reload: read everything again). */
export function forgetPrivateHome(repo: RepoHome['repo']): void {
  for (const k of warm.keys()) if (k.includes(`:${repo.repoId}:`)) warm.delete(k)
  invalidatePrivateSession(repo)
}

/**
 * Re-read a private repo after a write that changed its members or keys: the page keeps showing
 * what it has until the new session is ready (the old one is retired shortly after).
 */
export function refreshPrivateHome(repo: RepoHome['repo']): void {
  forgetPrivateHome(repo)
  for (const l of refreshListeners) l(repo.repoId)
}

/** A number that changes whenever `home` is a new object (the plain home was re-read). */
function useRevision(home: RepoHome | null): number {
  const last = useRef<{ home: RepoHome | null; rev: number }>({ home, rev: 0 })
  if (last.current.home !== home) last.current = { home, rev: last.current.rev + 1 }
  return last.current.rev
}

export function usePrivateHome(home: RepoHome | null, addr: RepoAddress): PrivateHomeState | null {
  const repo = home?.repo ?? null
  const isPrivate = repo?.visibility === 'private'
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const { identity } = useAuth()
  // Re-resolve once every session closed (the vault locked, or the encryption key changed).
  const [epoch, setEpoch] = useState(0)
  useEffect(() => onPrivateSessionsClosed(() => setEpoch((n) => n + 1)), [])
  const repoId = repo?.repoId ?? ''
  const reloadRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    const l = (id: string): void => {
      if (id === repoId) reloadRef.current()
    }
    refreshListeners.add(l)
    return () => {
      refreshListeners.delete(l)
    }
  }, [repoId])
  const key = repo === null ? '' : `${network}:${repo.repoId}:${identity ?? ''}`
  // Re-derive when the plain home is re-read (revalidation, Retry); the session itself is re-read
  // once its view-session TTL runs out, so new pushes and rotations show up.
  const revision = useRevision(home)
  const state = useAsync<RepoHome>(
    async () => {
      const base = home as RepoHome
      const generation = privateSessionGeneration()
      if (identity === null) return { ...base, private: { access: 'signed-out' } }
      const members = await readMembershipsCached(sdk!, base.repo, network)
      if (!members.some((m) => m.identity === identity)) return { ...base, private: { access: 'outsider' } }
      const ops = await encryptionOps(sdk!, network, identity, base.repo.forge.core)
      if (ops === null) return { ...base, private: { access: 'no-key' } }
      const session = await loadPrivateSessionCached(sdk!, base.repo, network, identity, sessionUnwrapper(ops))
      const decrypted = await loadPrivateHome(sdk!, base, session)
      // A lock while this ran ended the session: nothing decrypted may be kept or shown.
      if (generation !== privateSessionGeneration()) throw new Error('the vault locked; unlock to read this private repo')
      // From here on, this repo's links carry tokens instead of decrypted names.
      sealRepoUrls(addr)
      warm.set(key, decrypted)
      return decrypted
    },
    [key, ready, epoch, revision],
    {
      enabled: isPrivate && ready && sdk !== null && home !== null,
      initial: () => {
        const hit = warm.get(key)
        return hit !== undefined && hit.private?.access === 'member' && !hit.private.session.closed ? hit : undefined
      },
    },
  )
  reloadRef.current = state.reload
  if (home === null) return null
  if (!isPrivate) return { home, pending: false, error: null, retry: state.reload }
  if (state.error !== null) return { home, pending: false, error: state.error, retry: state.reload }
  if (state.data === null) return { home, pending: true, error: null, retry: state.reload }
  return { home: state.data, pending: false, error: null, retry: state.reload }
}
