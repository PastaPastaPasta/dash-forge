import { ShieldAlert, ShieldCheck, ShieldEllipsis, ShieldHalf, ShieldX } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TRUST_LABEL, type TrustState } from '@/lib/view'

/**
 * Verification chip — signature element (style guide §A). A compact chip row stating what
 * was checked. Semantic colors are meaningful and always paired with an icon and a word:
 * green Verified = the check ran and passed; amber Partly verified / Couldn't verify = partial,
 * or the check could not run; red Failed = the check ran and the data was wrong; neutral Not
 * checked yet. Callers pass states derived from checks that actually ran (`deriveTrust`).
 */

/** Word, color and icon for each trust state — shared with the Verification card. */
export const TRUST_META: Readonly<
  Record<TrustState, { label: string; klass: string; Icon: typeof ShieldCheck }>
> = {
  // The base green is under AA as text on light surfaces; -700 carries the word there.
  verified: { label: TRUST_LABEL.verified, klass: 'text-verify-700 dark:text-verify-400', Icon: ShieldCheck },
  partial: { label: TRUST_LABEL.partial, klass: 'text-caution-700 dark:text-caution-400', Icon: ShieldHalf },
  unverified: { label: TRUST_LABEL.unverified, klass: 'text-caution-700 dark:text-caution-400', Icon: ShieldAlert },
  pending: { label: TRUST_LABEL.pending, klass: 'text-anvil-500 dark:text-anvil-400', Icon: ShieldEllipsis },
  failed: { label: TRUST_LABEL.failed, klass: 'text-danger-700 dark:text-danger-400', Icon: ShieldX },
}

export interface ChipSegment {
  readonly label: string
  readonly state: TrustState
  /** Short text after the icon; defaults to the state's label. */
  readonly detail?: string
}

function Segment({ label, state, detail }: ChipSegment): JSX.Element {
  const meta = TRUST_META[state]
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-anvil-500 dark:text-anvil-400">{label}</span>
      <meta.Icon className={cn('h-3 w-3', meta.klass)} aria-hidden />
      <span className={cn('font-mono', meta.klass)}>{detail ?? meta.label}</span>
    </span>
  )
}

export function VerificationChip({
  segments,
  source,
  className,
}: {
  segments: readonly ChipSegment[]
  /** Where bytes came from, when any were read. */
  source?: string
  className?: string
}): JSX.Element {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-md border px-2 py-1 text-dense',
        'border-anvil-200 bg-anvil-50 dark:border-anvil-750 dark:bg-anvil-850',
        className,
      )}
      role="group"
      aria-label="Verification status"
    >
      {segments.map((s, i) => (
        <span key={s.label} className="inline-flex items-center gap-2">
          {i > 0 ? (
            <span className="text-anvil-300 dark:text-anvil-600" aria-hidden>
              ·
            </span>
          ) : null}
          <Segment {...s} />
        </span>
      ))}
      {source ? (
        <>
          <span className="text-anvil-300 dark:text-anvil-600" aria-hidden>
            ·
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="text-anvil-500 dark:text-anvil-400">src</span>
            <span className="rounded bg-anvil-200 px-1 font-mono text-anvil-700 dark:bg-anvil-800 dark:text-anvil-200">
              {source}
            </span>
          </span>
        </>
      ) : null}
    </div>
  )
}
