'use client'

/**
 * The read-only note at the top of a repo's Settings for anyone who can't change them (QW3-055):
 * settings are a maintainer's. A viewer whose session is locked is told to unlock, not to sign
 * in as a maintainer (QW4-035: a locked owner read "Sign in as one of its maintainers").
 */

import { Lock } from 'lucide-react'

import type { Role } from '@/lib/rules/v2'
import { ROLE_NOUN } from '@/lib/rules/roles'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { Button } from '@/components/ui/button'

/** Who is looking: signed in (with their role here, null for none), locked, or signed out. */
export type SettingsViewer =
  | { readonly kind: 'signedIn'; readonly role: Role | null }
  | { readonly kind: 'locked'; readonly owner: boolean }
  | { readonly kind: 'signedOut' }

/** The note's text, or null for a maintainer (who can change them). */
export function settingsReadOnlyText(viewer: SettingsViewer): string | null {
  switch (viewer.kind) {
    case 'locked':
      return viewer.owner
        ? 'Your session is locked, so these settings are read-only for now. Unlock to change them.'
        : "Your session is locked, so you're viewing this repo's settings read-only. Unlock to change them if you're one of its maintainers."
    case 'signedOut':
      return "You're viewing this repo's settings read-only. Sign in as one of its maintainers to change them."
    case 'signedIn':
      switch (viewer.role) {
        case 'maintainer':
          return null
        case 'writer':
          return "You're a writer here: only maintainers can change the repo's settings. Where your own browser stores what you push (Storage) is yours to set."
        case 'triage':
        case 'reader':
          return `You're ${ROLE_NOUN[viewer.role]} here: only maintainers can change the repo's settings.`
        case null:
          return "You're viewing this repo's settings read-only: only its maintainers can change them."
      }
  }
}

export function SettingsReadOnly({ ownerId, role }: { ownerId: string; role: Role | null }): JSX.Element | null {
  const { identity, locked, lockedIdentity } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)
  const viewer: SettingsViewer =
    identity !== null ? { kind: 'signedIn', role } : locked ? { kind: 'locked', owner: lockedIdentity === ownerId } : { kind: 'signedOut' }
  const text = settingsReadOnlyText(viewer)
  if (text === null) return null
  return (
    <div
      role="note"
      className="flex gap-2 rounded-md border border-anvil-200 bg-anvil-50 px-3 py-2 text-dense text-anvil-700 dark:border-anvil-800 dark:bg-anvil-900 dark:text-anvil-200"
      data-testid="settings-read-only"
      data-viewer={viewer.kind}
    >
      <Lock className="mt-0.5 h-4 w-4 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
      <div className="min-w-0 flex-1">
        <p>{text}</p>
        {viewer.kind !== 'signedIn' ? (
          <Button size="sm" variant="outline" className="mt-2" onClick={() => openLogin()} data-testid="settings-read-only-sign-in">
            {viewer.kind === 'locked' ? 'Unlock' : 'Sign in'}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
