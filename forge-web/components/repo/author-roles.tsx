'use client'

/**
 * Role badges on a conversation (`lib/view/author-role.ts`): an issue or pull request page
 * provides its repository's roles once, and every byline under it shows its author's badge.
 * Lists and other pages provide none, so their bylines show none.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { AUTHOR_ROLE_LABEL, AUTHOR_ROLE_TITLE, authorRoles } from '@/lib/view/author-role'
import type { Membership } from '@/lib/rules/v2'
import { BotBadgeScope } from '@/components/bot-badge'

const Roles = createContext<ReturnType<typeof authorRoles> | null>(null)

export function AuthorRolesProvider({ owner, members, children }: { owner: string; members: readonly Membership[]; children: ReactNode }): JSX.Element {
  const roles = useMemo(() => authorRoles(owner, members), [owner, members])
  // A thread names its authors' roles, and their bot badges (read once for the thread).
  return (
    <Roles.Provider value={roles}>
      <BotBadgeScope>{children}</BotBadgeScope>
    </Roles.Provider>
  )
}

/** `identity`'s role badge, when the page provides roles and it holds one. */
export function RoleBadge({ identity }: { identity: string }): JSX.Element | null {
  const role = useContext(Roles)?.get(identity)
  if (role === undefined) return null
  return (
    <span
      className="shrink-0 rounded-full border border-anvil-300 px-1.5 text-[11px] font-medium leading-[18px] text-anvil-600 dark:border-anvil-700 dark:text-anvil-300"
      title={AUTHOR_ROLE_TITLE[role]}
      data-testid="role-badge"
    >
      <span aria-hidden>{AUTHOR_ROLE_LABEL[role]}</span>
      <span className="sr-only">{AUTHOR_ROLE_TITLE[role]}</span>
    </span>
  )
}
