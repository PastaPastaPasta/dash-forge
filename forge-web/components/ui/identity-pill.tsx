import { Identicon } from '@/components/ui/identicon'
import { cn, shortId } from '@/lib/utils'

/**
 * Identity pill — signature element (style guide §A): identicon, DPNS name and short identity
 * id, the same everywhere an owner or author appears. The dash-blue accent is reserved for
 * platform identity.
 *
 * Two things here resist impersonation (TS-02). The identicon is drawn from the whole id, and the
 * id shows its first 7 and last 5 characters ({@link shortId}). An identity id is a hash, so an
 * attacker can grind one whose first characters match a maintainer's; matching the last five and
 * the picture as well is out of reach. The full id is in the title.
 */

export interface IdentityPillProps {
  /** base58-encoded identity id. */
  identityId: string
  /** Resolved DPNS name, when known. */
  name?: string
  className?: string
}

export function IdentityPill({ identityId, name, className }: IdentityPillProps): JSX.Element {
  return (
    <span
      className={cn(
        // One line, never a 2-4-line pill on a phone: the name ellipsizes, the id and the
        // avatar keep their width (L-58). The full name is in the title.
        'inline-flex min-w-0 max-w-full items-center gap-1.5 whitespace-nowrap rounded-full py-0.5 pl-0.5 pr-2 text-dense',
        'bg-anvil-100 text-anvil-700 dark:bg-anvil-800 dark:text-anvil-200',
        className,
      )}
    >
      <Identicon seed={identityId} size={20} />
      {name ? (
        <span className="min-w-0 truncate font-medium text-dash-600 dark:text-dash-400" title={name}>{name}</span>
      ) : null}
      <span className="shrink-0 font-mono text-anvil-500 dark:text-anvil-400" title={identityId} data-testid="identity-id">
        {shortId(identityId)}
      </span>
    </span>
  )
}
