import { Check, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Verification chip — signature element (style guide §A). Every repo view carries a
 * compact chip row: `refs ✓ proof · packs ✓ sha256 · src: platform|ipfs|s3`.
 * Semantic colors are meaningful: verify green = cryptographically verified,
 * caution amber = availability risk, danger red = failed verification.
 * Clicking (wired later) opens the trust panel explaining the verification chain.
 */

export type VerifyState = 'verified' | 'degraded' | 'failed'
export type Source = 'platform' | 'ipfs' | 's3' | 'https'

const STATE_CLASS: Readonly<Record<VerifyState, string>> = {
  verified: 'text-verify',
  degraded: 'text-caution',
  failed: 'text-danger',
}

interface SegmentProps {
  label: string
  detail: string
  state: VerifyState
}

function Segment({ label, detail, state }: SegmentProps): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-anvil-500 dark:text-anvil-400">{label}</span>
      <Check className={cn('h-3 w-3', STATE_CLASS[state])} aria-hidden />
      <span className={cn('font-mono', STATE_CLASS[state])}>{detail}</span>
    </span>
  )
}

export interface VerificationChipProps {
  refs?: VerifyState
  packs?: VerifyState
  source?: Source
  className?: string
}

export function VerificationChip({
  refs = 'verified',
  packs = 'verified',
  source = 'platform',
  className,
}: VerificationChipProps): JSX.Element {
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
      <ShieldCheck className="h-3.5 w-3.5 text-verify" aria-hidden />
      <Segment label="refs" detail="proof" state={refs} />
      <span className="text-anvil-300 dark:text-anvil-600" aria-hidden>
        ·
      </span>
      <Segment label="packs" detail="sha256" state={packs} />
      <span className="text-anvil-300 dark:text-anvil-600" aria-hidden>
        ·
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="text-anvil-500 dark:text-anvil-400">src</span>
        <span
          className={cn(
            'rounded px-1 font-mono',
            'bg-anvil-200 text-anvil-700 dark:bg-anvil-800 dark:text-anvil-200',
          )}
        >
          {source}
        </span>
      </span>
    </div>
  )
}
