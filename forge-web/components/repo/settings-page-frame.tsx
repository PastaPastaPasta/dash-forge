'use client'

import type { ReactNode } from 'react'
import type { RepoHome } from '@/lib/view'
import type { RepoAddress } from '@/hooks/use-query-param'
import { useViewerRole } from '@/hooks/use-repo-chrome'
import { useAuth } from '@/contexts/auth-context'
import { useOrgRequester } from '@/components/org/use-org-requester'
import { SettingsShell, type SettingsPlace } from '@/components/repo/settings-shell'

/** A Settings page of its own (Environments, Bots and runners) in the frame `/repo/settings` uses. */
export function SettingsPageFrame({ home, addr, active, children }: { home: RepoHome; addr: RepoAddress; active: SettingsPlace; children: ReactNode }): JSX.Element {
  const { role } = useViewerRole(home.repo)
  const { identity } = useAuth()
  // As on /repo/settings: an organization's member may ask for its Danger zone changes.
  const org = useOrgRequester(home.repo.ownerId)
  const orgOwned = org.record !== null && home.repo.visibility === 'public'
  // A private repo's outsider gets its private-repo state alone, as on /repo/settings.
  const access = home.private?.access ?? 'outsider'
  if (home.repo.visibility === 'private' && (access === 'signed-out' || access === 'outsider' || access === 'bot')) return <>{children}</>
  return (
    <SettingsShell addr={addr} active={active} showDanger={role === 'maintainer' || identity === home.repo.ownerId || orgOwned}>
      {children}
    </SettingsShell>
  )
}
