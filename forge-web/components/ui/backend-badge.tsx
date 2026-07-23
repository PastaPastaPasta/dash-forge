/**
 * Backend badge — signature element (style guide §A.4). Shows where a repo's pack bytes
 * physically live: `⛓ platform` / `🌐 ipfs|s3|https` / `⛓+🌐 mixed`. Rendered on repo headers
 * and the clone box. The glyph + label come from the config-derived {@link BackendInfo}.
 */

import type { BackendInfo } from '@/lib/view'
import { cn } from '@/lib/utils'

export function BackendBadge({
  backend,
  className,
}: {
  backend: BackendInfo
  className?: string
}): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[12px]',
        'border-anvil-200 bg-anvil-100 text-anvil-600 dark:border-anvil-750 dark:bg-anvil-800 dark:text-anvil-300',
        className,
      )}
      title={`Storage backend: ${backend.label}`}
    >
      <span aria-hidden>{backend.glyph}</span>
      <span className="font-mono">{backend.label}</span>
    </span>
  )
}
