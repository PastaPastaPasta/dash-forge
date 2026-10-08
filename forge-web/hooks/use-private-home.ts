'use client'

/**
 * usePrivateHome — how the signed-in viewer reads a private repo (`docs/security/private-repos.md`
 * §5, §8; `ux-dx-spec.md` §6.3, §9), folded into the {@link RepoHome} every repo page renders.
 *
 * - Public repo: the home as it is, at once. For a signed-in member of one with members-only
 *   content, its members-key session is loaded beside it and the home re-rendered with it on
 *   `repo.lane` / `home.lane` ({@link withMembersSession}): only the content gate reads it, so the
 *   public config, branches and packs stay exactly what everyone sees (DESIGN §4.1). A repository
 *   made public whose owner published keys of its earlier history (`private-repos.md` §18): every
 *   reader, signed in or not, gets those keys on `repo.published` (its packs) and, without a
 *   members-key session of their own, on `repo.lane` (its earlier discussion).
 * - Private repo: signed out → `signed-out`; not a member → `outsider`; a member whose browser
 *   holds no encryption key → `no-key`; a member with one → the home re-read through their
 *   decryption session (`member`), whose `repo.session` every read of the page then decrypts
 *   through.
 *
 * The decrypted home lives in memory only (a per-tab map for warm navigations, dropped when
 * the vault locks or the encryption key changes).
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { useAuth } from '@/contexts/auth-context'
import { useAsync } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { encryptionOps } from '@/lib/auth/encryption-key'
import { readMembershipsCached, repoContractIds } from '@/lib/repo'
import {
  invalidatePrivateSession,
  loadPrivateSessionCached,
  loadPublishedSessionCached,
  onPrivateSessionsClosed,
  privateSessionGeneration,
  sessionUnwrapper,
} from '@/lib/repo/private-session'
import { hasMembersKey } from '@/lib/repo/writes'
import { repoHasMembersKey } from '@/lib/repo/members-writes'
import { membersAccessOf } from '@/lib/repo/members-access'
import { knownConversion } from '@/lib/repo/converted'
import { DOC } from '@/lib/repo/contract'
import { repoSource } from '@/lib/repo/source'
import { queryDocuments } from '@/lib/sdk'
import { loadPrivateHome, withMembersSession, type RepoHome } from '@/lib/view'
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
  // Made public with earlier epochs its owner may publish: the page's config read said so (it ran
  // before this hook).
  const converted = repo !== null && !isPrivate && knownConversion(repo.repoId)?.sealOffEpoch != null
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const { identity, resuming, controller, unlockScope, lockedIdentity } = useAuth()
  // A locked session is still that member (QW2-033): on a public repo the viewer is the identity the
  // Unlock would open, so a member sees "Unlock to read" over members-only content, not an outsider's
  // placeholders. Private repos wait for the unlock as before.
  const viewer = identity ?? lockedIdentity
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
  const key = repo === null ? '' : `${network}:${repo.repoId}:${(isPrivate ? identity : viewer) ?? ''}`
  // Re-derive when the plain home is re-read (revalidation, Retry); the session itself is re-read
  // once its view-session TTL runs out, so new pushes and rotations show up.
  const revision = useRevision(home)
  /**
   * A public repo's home for this viewer: with their members-key session when they hold one (a
   * current member, or a member removed since who holds earlier key shares: `former`).
   */
  const membersHome = async (plainHome: RepoHome, generation: number): Promise<RepoHome> => {
    // A repository made public: the keys its owner published, for everyone; none read, none kept.
    const published = converted ? await loadPublishedSessionCached(sdk!, plainHome.repo, network).catch(() => null) : null
    const keys = published !== null && published.resolution.keys.size > 0 ? published : null
    const base: RepoHome = keys === null ? plainHome : { ...plainHome, repo: { ...plainHome.repo, published: keys } }
    // Without a members-key session of their own, a reader opens the earlier history with them.
    const outsider = (): RepoHome => (keys === null ? base : { ...base, repo: { ...base.repo, lane: keys } })
    if (viewer === null) return outsider()
    const members = await readMembershipsCached(sdk!, base.repo, network)
    const isMember = members.some((m) => m.identity === viewer)
    const lane = await membersAccessOf({
      identity: viewer,
      isMember,
      // A non-member's answer comes from the page's own config read (no read of its own).
      hasMembersKey: () => (isMember ? hasMembersKey(sdk!, base.repo) : repoHasMembersKey(sdk!, base.repo)),
      ops: () => encryptionOps(sdk!, network, viewer, base.repo.forge.collab),
      // No session at all (the vault locked), or one resumed with the signing key only.
      locked: () => identity === null || controller.unlockScope() === 'signing',
      holdsShare: async () =>
        (await queryDocuments(sdk!, repoSource(base.repo).repoQuery(DOC.repoKey, { where: [['memberId', '==', viewer]], orderBy: [['memberId', 'asc']], limit: 1 }))).length > 0,
      session: async (ops) => {
        const session = await loadPrivateSessionCached(sdk!, base.repo, network, viewer, sessionUnwrapper(ops))
        if (generation !== privateSessionGeneration()) throw new Error('the vault locked; unlock to read members-only content')
        return session
      },
    })
    if (lane === null) return outsider()
    if (lane.access !== 'member' && lane.access !== 'former') return { ...outsider(), lane }
    const out = withMembersSession(base, lane.session, lane.access)
    warm.set(key, out)
    return out
  }
  const state = useAsync<RepoHome>(
    async () => {
      const base = home as RepoHome
      const generation = privateSessionGeneration()
      if (!isPrivate) return membersHome(base, generation)
      if (identity === null) return { ...base, private: { access: 'signed-out' } }
      const members = await readMembershipsCached(sdk!, base.repo, network)
      if (!members.some((m) => m.identity === identity)) return { ...base, private: { access: 'outsider' } }
      const ops = await encryptionOps(sdk!, network, identity, base.repo.forge.collab)
      if (ops === null) return { ...base, private: { access: 'no-key' } }
      // A session picked up after a reload holds the signing key only: the encryption key needs
      // an interactive unlock in this tab first.
      if (controller.unlockScope() === 'signing') return { ...base, private: { access: 'locked' } }
      const session = await loadPrivateSessionCached(sdk!, base.repo, network, identity, sessionUnwrapper(ops))
      const decrypted = await loadPrivateHome(sdk!, base, session)
      // A lock while this ran ended the session: nothing decrypted may be kept or shown.
      if (generation !== privateSessionGeneration()) throw new Error('the vault locked; unlock to read this private repo')
      // From here on, this repo's links carry tokens instead of decrypted names.
      sealRepoUrls(addr)
      warm.set(key, decrypted)
      return decrypted
    },
    // An unlock in this tab (inline, or from the sign-in sheet) re-resolves the repo.
    [key, ready, epoch, revision, unlockScope, converted],
    {
      // A kept session is still being picked up: wait, rather than show the signed-out state. A
      // public repo's members-only content is looked up for a signed-in viewer only.
      enabled: (isPrivate || viewer !== null || converted) && ready && sdk !== null && home !== null && !resuming,
      initial: () => {
        const hit = warm.get(key)
        if (hit === undefined) return undefined
        if (hit.private?.access === 'member') return hit.private.session.closed ? undefined : hit
        return (hit.lane?.access === 'member' || hit.lane?.access === 'former') && !hit.lane.session.closed ? hit : undefined
      },
    },
  )
  reloadRef.current = state.reload
  // A public repo read for a signed-in viewer before their members access is known: marked, so
  // members-only placeholders wait rather than speak to an outsider (one object per home).
  const laneUnknown = !isPrivate && home !== null && viewer !== null && state.error === null && (state.data === null || state.data.repo.repoId !== home.repo.repoId)
  const loadingHome = useMemo<RepoHome | null>(() => (laneUnknown && home !== null ? { ...home, laneLoading: true } : null), [laneUnknown, home])
  if (home === null) return null
  // A public repo renders at once; once a member's members-key session is ready the page re-reads
  // its discussion through it (`contentKey`). A failed lookup leaves the public view as it is.
  if (!isPrivate) {
    const data = state.data
    const fresh = data !== null && state.error === null && data.repo.repoId === home.repo.repoId ? data : loadingHome ?? home
    return { home: fresh, pending: false, error: null, retry: state.reload }
  }
  if (state.error !== null) return { home, pending: false, error: state.error, retry: state.reload }
  if (state.data === null) return { home, pending: true, error: null, retry: state.reload }
  // Before anything renders a link: whatever address form reached this repo (a pinned id, a DPNS
  // owner), its links carry tokens, including on a warm seed (idempotent).
  if (state.data.private?.access === 'member') sealRepoUrls(addr)
  return { home: state.data, pending: false, error: null, retry: state.reload }
}
