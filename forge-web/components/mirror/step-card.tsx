'use client'

import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type StepState = 'done' | 'active' | 'todo'

/**
 * One wizard step: its number (a check once done), title, and either its body (active), a
 * one-line summary with "Change" (done), or nothing (not reached yet).
 */
export function StepCard({
  n,
  id,
  title,
  state,
  summary,
  onChange,
  children,
}: {
  n: number
  id: string
  title: string
  state: StepState
  summary?: React.ReactNode
  onChange?: () => void
  children?: React.ReactNode
}): JSX.Element {
  return (
    <li
      data-testid={`mirror-step-${id}`}
      data-state={state}
      aria-current={state === 'active' ? 'step' : undefined}
      className={cn(
        'rounded-lg border bg-white dark:bg-anvil-900',
        state === 'active' ? 'border-forge-500/60 shadow-sm' : 'border-anvil-200 dark:border-anvil-800',
      )}
    >
      <div className="flex items-start gap-3 px-3 py-3 sm:px-4">
        <span
          aria-hidden
          className={cn(
            'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold',
            state === 'done' && 'bg-verify-700 text-white dark:bg-verify-600',
            state === 'active' && 'bg-forge-700 text-white',
            state === 'todo' && 'border border-anvil-300 text-anvil-500 dark:border-anvil-700 dark:text-anvil-400',
          )}
        >
          {state === 'done' ? <Check className="h-3.5 w-3.5" /> : n}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className={cn('text-prose', state === 'todo' ? 'text-anvil-500 dark:text-anvil-400' : 'text-anvil-900 dark:text-anvil-50')}>
            <span className="sr-only">Step {n}: </span>
            {title}
          </h2>
          {state === 'done' && summary ? <div className="mt-0.5 break-words text-dense text-anvil-600 dark:text-anvil-300">{summary}</div> : null}
        </div>
        {state === 'done' && onChange ? (
          <Button variant="ghost" size="sm" onClick={onChange} aria-label={`Change: ${title}`}>
            Change
          </Button>
        ) : null}
      </div>
      {state === 'active' ? <div className="space-y-4 border-t border-anvil-100 px-3 py-4 dark:border-anvil-850 sm:px-4">{children}</div> : null}
    </li>
  )
}

/** A link styled as a button (GitHub pages open in a new tab). */
export function LinkButton({ href, children, primary = false, testId }: { href: string; children: React.ReactNode; primary?: boolean; testId?: string }): JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={testId}
      className={cn(
        'inline-flex h-9 items-center justify-center gap-1.5 rounded-md px-3.5 text-dense font-medium transition-colors coarse:min-h-11',
        primary
          ? 'bg-forge-700 text-white hover:bg-forge-800'
          : 'border border-anvil-300 text-anvil-800 hover:bg-anvil-100 dark:border-anvil-700 dark:text-anvil-100 dark:hover:bg-anvil-800',
      )}
    >
      {children}
    </a>
  )
}

/** Small print under a control. */
export function Hint({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'caution' | 'danger' | 'ok' }): JSX.Element {
  return (
    <p
      role={tone === 'danger' ? 'alert' : undefined}
      className={cn(
        'text-[12px]',
        tone === 'muted' && 'text-anvil-500 dark:text-anvil-400',
        tone === 'caution' && 'text-caution-700 dark:text-caution-400',
        tone === 'danger' && 'text-danger-700 dark:text-danger-400',
        tone === 'ok' && 'text-verify-700 dark:text-verify-400',
      )}
    >
      {children}
    </p>
  )
}
