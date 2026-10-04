/**
 * Backend badge — signature element (style guide §A.4). Shows where a repo's pack bytes
 * physically live: Platform (a chain link), IPFS (a globe), S3 or HTTPS (a drive), or a mix.
 * Rendered on repo headers and the clone box. The label comes from the config-derived
 * {@link BackendInfo}; the icons are Lucide line icons, the same on every OS (an emoji was not).
 */

import { Globe, HardDrive, Link2, type LucideIcon } from 'lucide-react'
import type { BackendInfo } from '@/lib/view'
import { cn } from '@/lib/utils'

const ICONS: Readonly<Record<BackendInfo['kind'], readonly LucideIcon[]>> = {
  platform: [Link2],
  ipfs: [Globe],
  s3: [HardDrive],
  https: [HardDrive],
  mixed: [Link2, Globe],
}

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
      title={
        backend.kind === 'platform'
          ? "Where this repo's files are stored: on Dash Platform itself. Every file you see is checked against its git hash either way."
          : `Where this repo's files are stored: ${backend.label} (the owner's own storage). Every file you see is checked against its git hash either way.`
      }
    >
      {ICONS[backend.kind].map((Icon, i) => (
        <Icon key={i} className="h-3 w-3 shrink-0" aria-hidden data-icon={backend.kind} />
      ))}
      <span className="font-mono">{backend.label}</span>
    </span>
  )
}
