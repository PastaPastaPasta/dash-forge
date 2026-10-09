/**
 * The member role picker and badge (Settings → Members, RC2 member roles): Read, Triage, Write
 * and Maintain on every repo, each with what it may do (DESIGN §10); the owner's chip is "Owner".
 */

import { OWNER_LABEL, ROLE_LABEL, ROLE_SUMMARY, grantableRoles } from '@/lib/rules/roles'
import type { Role } from '@/lib/rules/v2'
import { onRadioGroupKeyDown, radioTabIndex } from '@/components/ui/radio-group'

export function RolePicker({
  value,
  onChange,
  visibility,
  disabled = false,
  exclude = [],
  action = false,
}: {
  value: Role
  onChange: (role: Role) => void
  visibility: 'public' | 'private'
  disabled?: boolean
  /** Roles not to offer (a role change leaves out the current one). */
  exclude?: readonly Role[]
  /**
   * Each role is an action, not a choice (a role change: picking one opens its confirmation):
   * a group of buttons, each a Tab stop, rather than a radio group whose arrow keys would pick,
   * and so open the confirmation, as focus moves.
   */
  action?: boolean
}): JSX.Element {
  const roles = grantableRoles(visibility).filter((r) => !exclude.includes(r))
  const anyChecked = !action && roles.includes(value)
  return (
    <div
      role={action ? 'group' : 'radiogroup'}
      aria-label={action ? 'Change role to' : 'Role'}
      data-testid="role-picker"
      // QW4-037: one Tab stop, and the arrows move the selection (the WAI-ARIA radio group).
      onKeyDown={action ? undefined : onRadioGroupKeyDown}
      className="inline-flex flex-wrap rounded-md border border-anvil-200 p-0.5 dark:border-anvil-750"
    >
      {roles.map((r, i) => (
        <button
          key={r}
          type="button"
          role={action ? undefined : 'radio'}
          aria-checked={action ? undefined : value === r}
          tabIndex={action ? undefined : radioTabIndex(value === r, i, anyChecked)}
          title={ROLE_SUMMARY[r]}
          disabled={disabled}
          data-role={r}
          onClick={() => onChange(r)}
          className={
            'rounded px-3 py-1.5 text-dense font-medium coarse:min-h-11 disabled:opacity-50 ' +
            (!action && value === r ? 'bg-forge-500/15 text-forge-800 dark:text-forge-400' : 'text-anvil-500 dark:text-anvil-400')
          }
        >
          {ROLE_LABEL[r]}
        </button>
      ))}
    </div>
  )
}

/** What the picked role may do, under the picker. */
export function RoleSummary({ role }: { role: Role }): JSX.Element {
  return (
    <p className="mt-1 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="role-summary">
      <span className="font-medium">{ROLE_LABEL[role]}:</span> {ROLE_SUMMARY[role]}
    </p>
  )
}

/** A member's chip: their role's word, or "Owner" for the repo owner's own maintainer row (`owner`). */
export function RoleBadge({ role, owner = false }: { role: Role; owner?: boolean }): JSX.Element {
  const isOwner = owner && role === 'maintainer'
  return (
    <span
      title={isOwner ? 'Owner of this repository' : ROLE_SUMMARY[role]}
      data-testid="role-badge"
      className="rounded bg-forge-500/15 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-forge-800 dark:text-forge-400"
    >
      {isOwner ? OWNER_LABEL : ROLE_LABEL[role]}
    </span>
  )
}
