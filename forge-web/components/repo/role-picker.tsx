/**
 * The member role picker and badge (Settings → Collaborators, RC2 member roles): Writer, Triage,
 * Reader (private repos only) and Maintainer, each with what it may do.
 */

import { ROLE_LABEL, ROLE_SUMMARY, grantableRoles } from '@/lib/rules/roles'
import type { Role } from '@/lib/rules/v2'

export function RolePicker({
  value,
  onChange,
  visibility,
  disabled = false,
  exclude = [],
}: {
  value: Role
  onChange: (role: Role) => void
  visibility: 'public' | 'private'
  disabled?: boolean
  /** Roles not to offer (a role change leaves out the current one). */
  exclude?: readonly Role[]
}): JSX.Element {
  const roles = grantableRoles(visibility).filter((r) => !exclude.includes(r))
  return (
    <div role="radiogroup" aria-label="Role" data-testid="role-picker" className="inline-flex flex-wrap rounded-md border border-anvil-200 p-0.5 dark:border-anvil-750">
      {roles.map((r) => (
        <button
          key={r}
          type="button"
          role="radio"
          aria-checked={value === r}
          title={ROLE_SUMMARY[r]}
          disabled={disabled}
          data-role={r}
          onClick={() => onChange(r)}
          className={
            'rounded px-3 py-1.5 text-dense font-medium coarse:min-h-11 disabled:opacity-50 ' +
            (value === r ? 'bg-forge-500/15 text-forge-800 dark:text-forge-400' : 'text-anvil-500 dark:text-anvil-400')
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

export function RoleBadge({ role }: { role: Role }): JSX.Element {
  return (
    <span
      title={ROLE_SUMMARY[role]}
      data-testid="role-badge"
      className="rounded bg-forge-500/15 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-forge-800 dark:text-forge-400"
    >
      {role.toUpperCase()}
    </span>
  )
}
