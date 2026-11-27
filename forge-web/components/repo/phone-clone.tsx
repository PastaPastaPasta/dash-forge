'use client'

/**
 * The Clone card on phones. The rail drops under the content below `lg`, which on the repo home
 * puts Clone under the whole README; the home claims it instead ({@link PhoneCloneBox}, above
 * the README) and the rail leaves it out. Desktop keeps it in the rail.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { CloneBox } from '@/components/repo/clone-box'
import { useMinWidth } from '@/hooks/use-prefs'
import { useViewerRole } from '@/hooks/use-repo-chrome'
import type { RepoAddress } from '@/hooks/use-query-param'
import type { RepoHome, SelectedRef } from '@/lib/view'

/** Tailwind's `lg`: where the rail sits beside the content. */
const RAIL_BESIDE = 1024

const ClaimContext = createContext<((claimed: boolean) => void) | null>(null)

/** Provides the claim, and whether the rail should still show Clone (`railClone`). */
export function PhoneCloneProvider({ children }: { children: (railClone: boolean) => ReactNode }): JSX.Element {
  const wide = useMinWidth(RAIL_BESIDE)
  const [claimed, setClaimed] = useState(false)
  return <ClaimContext.Provider value={setClaimed}>{children(wide || !claimed)}</ClaimContext.Provider>
}

/** Clone, in the content column, on a phone-width screen inside a {@link PhoneCloneProvider}. */
export function PhoneCloneBox({ home, addr, selected }: { home: RepoHome; addr: RepoAddress; selected: SelectedRef }): JSX.Element | null {
  const wide = useMinWidth(RAIL_BESIDE)
  const claim = useContext(ClaimContext)
  const { role } = useViewerRole(home.repo)
  const shown = !wide && claim !== null && !(home.repo.visibility === 'private' && role === null)
  useEffect(() => {
    if (!shown || claim === null) return
    claim(true)
    return () => claim(false)
  }, [shown, claim])
  return shown ? <CloneBox home={home} addr={addr} selected={selected} /> : null
}
