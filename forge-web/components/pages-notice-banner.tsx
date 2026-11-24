'use client'

/**
 * The operator's banner (`lib/pages-notice.ts`): one strip under the header on every page while
 * the build carries `NEXT_PUBLIC_PAGES_NOTICE`. It cannot be dismissed in either mode, and it is
 * in the static HTML. A polite `status`, so it does not interrupt a screen reader on every
 * navigation. In `paused` mode the write guard says why on every write button.
 */

import { useEffect, useRef, useState } from 'react'
import { Info } from 'lucide-react'
import { PAGES_NOTICE, pagesNoticeCopy, type PagesNotice } from '@/lib/pages-notice'
import { cn } from '@/lib/utils'

export function PagesNoticeBanner({ notice = PAGES_NOTICE }: { notice?: PagesNotice | null }): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const bodyRef = useRef<HTMLParagraphElement>(null)
  const bodyText = notice === null ? '' : pagesNoticeCopy(notice).body

  useEffect(() => {
    if (notice === null) return
    const check = (): void => {
      const el = bodyRef.current
      if (!el) return
      setOverflows(el.scrollHeight > el.clientHeight + 1)
    }
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [notice, bodyText])

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
        <div className="min-w-0 flex-1 text-anvil-800 dark:text-anvil-100">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="font-medium">{copy.lead}</span>
            <a
              href={notice.url}
              target="_blank"
              rel="noreferrer noopener"
              className="whitespace-nowrap text-forge-700 underline dark:text-forge-400 coarse:inline-flex coarse:min-h-11 coarse:items-center"
            >
              {copy.link}
            </a>
          </div>
          <p ref={bodyRef} data-testid="pages-notice-body" className={cn('mt-0.5 text-anvil-700 dark:text-anvil-200', !expanded && 'line-clamp-2')}>
            {copy.body}
          </p>
          {overflows || expanded ? (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
              className="mt-0.5 text-[12px] font-medium text-anvil-600 underline hover:text-anvil-900 coarse:inline-flex coarse:min-h-11 coarse:items-center dark:text-anvil-300 dark:hover:text-anvil-100"
            >
              {expanded ? 'Show less' : 'Show full notice'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
