/**
 * RoleLimitNote — the one-line explanation beside a control a triage member or reader does not
 * get (RC2 member roles; `roleLimit` in `lib/rules/roles.ts`). Renders nothing for anyone else.
 */

import { roleLimit } from '@/lib/rules/roles'
import type { Role } from '@/lib/rules/v2'

export function RoleLimitNote({ role, what, className = '' }: { role: Role | null | undefined; what: string; className?: string }): JSX.Element | null {
  const text = roleLimit(role, what)
  if (text === null) return null
  return (
    <p role="note" data-testid="role-limit" className={`text-[12px] text-anvil-500 dark:text-anvil-400 ${className}`}>
      {text}
    </p>
  )
}
