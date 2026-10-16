'use client'

/**
 * Whether a mirror's claim to its source is verified, for the leaves that show an imported
 * item's original author (ABU-05). A repo's description is its owner's word, and so is the
 * `imported` record of every item its owner or a maintainer wrote, so "@bob on github.com" is
 * the mirror's claim until the source's back-link file lists the repo (`lib/view/mirror-check.ts`).
 * The repo scaffold provides the answer; outside it (no provider) nothing is verified.
 */

import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import type { RepoHome } from '@/lib/view'
import { isMirrorVerified, subscribeMirrorVerified } from '@/lib/view/mirror-check'
import { mirrorSourceOfRepo } from '@/lib/view/mirror-source'
import { SHOWCASE_IDS } from '@/lib/view/upstream-alias'

const VerifiedContext = createContext(false)

/**
 * Whether `label`'s claim on `repoId` is verified: the source's back-link file listed it this
 * session (follows the check as it lands), or this site's showcase vouches for the repo, as
 * `/github.com/<owner>/<repo>` already treats it. A claim to a source that is not on GitHub
 * cannot be checked, so it stays unverified.
 */
export function useMirrorVerified(label: string | null, repoId: string): boolean {
  const checked = useSyncExternalStore(
    subscribeMirrorVerified,
    () => isMirrorVerified(label, repoId),
    () => false,
  )
  return checked || (label !== null && SHOWCASE_IDS.has(repoId))
}

/**
 * Provides whether the repo's claim (the source its description names: the one the rail's check
 * can verify) is verified. No read: a repo whose description names no source is never verified.
 */
export function MirrorTrustProvider({ home, children }: { home: RepoHome; children: ReactNode }): JSX.Element {
  const source = mirrorSourceOfRepo(home.v2, 'issue')
  const verified = useMirrorVerified(source?.label ?? null, home.repo.repoId)
  return <VerifiedContext.Provider value={verified}>{children}</VerifiedContext.Provider>
}

/** Whether the mirror this subtree belongs to is verified. */
export function useOriginVerified(): boolean {
  return useContext(VerifiedContext)
}
