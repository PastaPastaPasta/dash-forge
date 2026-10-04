/**
 * Backend badge — signature element (style guide §A.4). Shows where a repo's pack bytes
 * physically live: Platform (blocks), IPFS (a globe), S3 or HTTPS (a drive), or a mix.
 * Rendered on repo headers and the clone box. The label comes from the config-derived
 * {@link BackendInfo}; the icons are Lucide line icons, the same on every OS (an emoji was not).
 */

import { Blocks, Globe, HardDrive, type LucideIcon } from 'lucide-react'
import type { BackendInfo } from '@/lib/view'
import { cn } from '@/lib/utils'

/** Not Link2: the file list draws a symlink with it. */
const PLATFORM: readonly [LucideIcon, string] = [Blocks, 'platform']
const GLOBE: readonly [LucideIcon, string] = [Globe, 'globe']
const DRIVE: readonly [LucideIcon, string] = [HardDrive, 'drive']
const ICONS: Readonly<Record<BackendInfo['kind'], readonly (readonly [LucideIcon, string])[]>> = {
  platform: [PLATFORM],
  ipfs: [GLOBE],
  s3: [DRIVE],
  https: [DRIVE],
  mixed: [PLATFORM, GLOBE],
}

const WHERE: Readonly<Record<BackendInfo['kind'], string>> = {
  platform: 'on Dash Platform itself',
  ipfs: "on IPFS (the owner's own storage)",
  s3: "in the owner's own S3 storage",
  https: "on the owner's own web server",
  mixed: "partly on Dash Platform, partly in the owner's own storage",
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
      title={`Where this repo's files are stored: ${WHERE[backend.kind]}. Every file you see is checked against its git hash either way.`}
    >
      {ICONS[backend.kind].map(([Icon, name]) => (
        <Icon key={name} className="h-3 w-3 shrink-0" aria-hidden data-icon={name} />
      ))}
      <span className="font-mono">{backend.kind}</span>
    </span>
  )
}
