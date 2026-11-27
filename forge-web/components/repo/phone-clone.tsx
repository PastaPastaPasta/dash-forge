'use client'

/**
 * The Clone card on phones. The rail drops under the content below `lg`, which on the repo home
 * puts Clone under the whole README; the home claims it instead ({@link PhoneCloneBox}, above
 * the README) and the rail leaves it out. Desktop keeps it in the rail.
 */

import { createContext, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { CloneBox } from '@/components/repo/clone-box'
import { useMinWidth } from '@/hooks/use-prefs'
import { useViewerRole } from '@/hooks/use-repo-chrome'
import type { RepoAddress } from '@/hooks/use-query-param'
import type { RepoHome, SelectedRef } from '@/lib/view'

/** Tailwind's `lg`: where the rail sits beside the content. */
const RAIL_BESIDE = 1024

interface Claim {
  readonly claimed: boolean
  readonly setClaimed: (claimed: boolean) => void
}

const ClaimContext = createContext<Claim | null>(null)

/** Lets the repo home claim Clone on a phone; the rail reads it ({@link useRailClone}). */
export function PhoneCloneProvider({ children }: { children: ReactNode }): JSX.Element {
  const [claimed, setClaimed] = useState(false)
  const value = useMemo(() => ({ claimed, setClaimed }), [claimed])
  return <ClaimContext.Provider value={value}>{children}</ClaimContext.Provider>
}

/** Whether the rail shows Clone: always on a wide screen, and on a phone unless the page claimed it. */
export function useRailClone(): boolean {
  const wide = useMinWidth(RAIL_BESIDE)
  const claim = useContext(ClaimContext)
  return wide || claim === null || !claim.claimed
}

/** Clone, in the content column, on a phone-width screen inside a {@link PhoneCloneProvider}. */
export function PhoneCloneBox({ home, addr, selected }: { home: RepoHome; addr: RepoAddress; selected: SelectedRef }): JSX.Element | null {
  const wide = useMinWidth(RAIL_BESIDE)
  const setClaimed = useContext(ClaimContext)?.setClaimed ?? null
  const { role } = useViewerRole(home.repo)
  const shown = !wide && setClaimed !== null && !(home.repo.visibility === 'private' && role === null)
  // Before paint, so the rail's copy is never drawn beside this one.
  useLayoutEffect(() => {
    if (!shown || setClaimed === null) return
    setClaimed(true)
    return () => setClaimed(false)
  }, [shown, setClaimed])
  return shown ? <CloneBox home={home} addr={addr} selected={selected} /> : null
}
