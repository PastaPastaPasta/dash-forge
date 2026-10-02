/**
 * RoleLimitNote — the one-line explanation beside a control a triage member or reader does not
 * get (RC2 member roles; `roleLimit` in `lib/rules/roles.ts`). It names the capability the
 * control needs and renders only when the role lacks it (QW4-009: the Labels page told triage,
 * who define labels, that they couldn't), and nothing for anyone but triage and readers.
 */

import { roleLimit, type Capabilities } from '@/lib/rules/roles'
import type { Role } from '@/lib/rules/v2'

export function RoleLimitNote({
  role,
  cap,
  what,
  className = '',
}: {
  role: Role | null | undefined
  /** What the control needs: no note for a role that has it. */
  cap: keyof Capabilities
  what: string
  className?: string
}): JSX.Element | null {
  const text = roleLimit(role, cap, what)
  if (text === null) return null
  return (
    <p role="note" data-testid="role-limit" className={`text-[12px] text-anvil-500 dark:text-anvil-400 ${className}`}>
      {text}
    </p>
  )
}
