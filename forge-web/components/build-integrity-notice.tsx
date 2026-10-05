'use client'

import { useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'

import { checkThisBuild, type BuildCheck } from '@/lib/build-check'
import { verifyGuideUrl } from '@/lib/build-info'
import { cn } from '@/lib/utils'

/**
 * Shown where a private repository is unlocked, when this copy of the app is not a build this
 * repository published (lib/build-check.ts): unpublished code could read what is unlocked.
 * Renders nothing while checking, for a published build, or when the check could not run.
 */
export function BuildIntegrityNotice({ className }: { className?: string }): JSX.Element | null {
  const [state, setState] = useState<BuildCheck | null>(null)
  useEffect(() => {
    let live = true
    void checkThisBuild().then((s) => live && setState(s))
    return () => {
      live = false
    }
  }, [])
  if (state !== 'unpublished') return null
  return (
    <p role="note" data-testid="build-integrity-notice" className={cn('flex items-start gap-2 text-[12px] text-caution-700 dark:text-caution-400', className)}>
      <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        This copy of Forge isn&apos;t a published build, so it could read anything you unlock here.{' '}
        <a href={verifyGuideUrl()} target="_blank" rel="noreferrer" className="hit-area underline">
          How to verify a copy
        </a>
      </span>
    </p>
  )
}
