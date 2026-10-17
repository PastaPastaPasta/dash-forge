'use client'

/**
 * The operator's banner (`lib/pages-notice.ts`): one strip under the header on every page while
 * the build carries `NEXT_PUBLIC_PAGES_NOTICE`. It cannot be dismissed in either mode, and it is
 * in the static HTML. A polite `status`, so it does not interrupt a screen reader on every
 * navigation. In `paused` mode the write guard says why on every write button.
 */

import { Info } from 'lucide-react'
import { PAGES_NOTICE, pagesNoticeCopy, type PagesNotice } from '@/lib/pages-notice'
import { cn } from '@/lib/utils'

export function PagesNoticeBanner({ notice = PAGES_NOTICE }: { notice?: PagesNotice | null }): JSX.Element | null {
  if (notice === null) return null
  const copy = pagesNoticeCopy(notice)
  const paused = notice.mode === 'paused'
  return (
    <div
      role="status"
      data-testid="pages-notice-banner"
      data-notice={notice.mode}
      className={cn('border-b', paused ? 'border-danger/40 bg-danger/10' : 'border-caution/40 bg-caution/10')}
    >
      <div className="mx-auto flex max-w-[1280px] items-start gap-3 px-4 py-2 text-dense sm:px-6">
        <Info
          className={cn('mt-0.5 h-4 w-4 shrink-0', paused ? 'text-danger-700 dark:text-danger-400' : 'text-caution-700 dark:text-caution-400')}
          aria-hidden
        />
        <p className="min-w-0 flex-1 text-anvil-800 dark:text-anvil-100">
          <span className="font-medium">{copy.lead}</span> {copy.body}{' '}
          <a
            href={notice.url}
            target="_blank"
            rel="noreferrer noopener"
            className="whitespace-nowrap text-forge-700 underline dark:text-forge-400 coarse:inline-flex coarse:min-h-11 coarse:items-center"
          >
            {copy.link}
          </a>
        </p>
      </div>
    </div>
  )
}
