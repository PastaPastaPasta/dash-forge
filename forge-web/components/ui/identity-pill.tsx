import { avatarFill, avatarHue } from '@/lib/design/avatar'
import { abbreviate, cn } from '@/lib/utils'

/**
 * Identity pill — signature element (style guide §A). DPNS name + avatar +
 * abbreviated identity id (base58), consistent everywhere an owner/author appears.
 * The dash-blue accent is reserved for platform identity. The real dicebear avatar
 * (yappr generator) drops in later; this stub renders a deterministic initial swatch.
 * Collaborators may carry a token-role badge (WRITE / MAINTAIN).
 */

export type TokenRole = 'WRITE' | 'MAINTAIN'

export interface IdentityPillProps {
  /** base58-encoded identity id. */
  identityId: string
  /** Resolved DPNS name, when known. */
  name?: string
  role?: TokenRole
  className?: string
}

export function IdentityPill({
  identityId,
  name,
  role,
  className,
}: IdentityPillProps): JSX.Element {
  const initial = (name ?? identityId).charAt(0).toUpperCase()
  const fill = avatarFill(avatarHue(identityId))

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2 text-dense',
        'bg-anvil-100 text-anvil-700 dark:bg-anvil-800 dark:text-anvil-200',
        className,
      )}
    >
      <span
        className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold text-white"
        style={{ backgroundColor: fill }}
        aria-hidden
      >
        {initial}
      </span>
      {name ? (
        <span className="font-medium text-dash-600 dark:text-dash-400">{name}</span>
      ) : null}
      <span className="font-mono text-anvil-500 dark:text-anvil-400">
        {abbreviate(identityId)}
      </span>
      {role ? (
        <span
          className={cn(
            'rounded px-1 text-[10px] font-semibold uppercase tracking-wide',
            'bg-forge-500/15 text-forge-600 dark:text-forge-400',
          )}
        >
          {role}
        </span>
      ) : null}
    </span>
  )
}
