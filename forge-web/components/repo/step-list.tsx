/**
 * One row of a run's step list (the browser merge, a commit to a PR branch). A row with a
 * `question` is waiting on the merger ("Waiting for your choice"), and renders it inline.
 */

import { Check, CirclePause, Loader2, Minus, X } from 'lucide-react'

import { cn } from '@/lib/utils'

export type StepState = 'todo' | 'running' | 'done' | 'skipped' | 'failed'

export function StepRow({
  id,
  label,
  state,
  detail,
  question = null,
}: {
  id: string
  label: string
  state: StepState
  detail?: string
  question?: JSX.Element | null
}): JSX.Element {
  const waiting = question !== null
  return (
    <li className={cn('text-dense', state === 'todo' && 'text-anvil-500 dark:text-anvil-400')} data-step={id} data-state={waiting ? 'waiting' : state}>
      <span className="flex items-center gap-2">
        {waiting ? <CirclePause className="h-4 w-4 text-caution-700 dark:text-caution-400" aria-hidden /> : <StepIcon state={state} />}
        {label}
        {waiting ? (
          <span className="text-[12px] font-medium text-caution-700 dark:text-caution-400">Waiting for your choice</span>
        ) : detail ? (
          <span className="text-[12px] text-anvil-600 dark:text-anvil-400">({detail})</span>
        ) : null}
      </span>
      {question}
    </li>
  )
}

function StepIcon({ state }: { state: StepState }): JSX.Element {
  switch (state) {
    case 'done':
      return <Check className="h-4 w-4 text-verify-700 dark:text-verify-400" aria-hidden />
    case 'running':
      return <Loader2 className="h-4 w-4 animate-spin text-anvil-500 dark:text-anvil-400" aria-hidden />
    case 'skipped':
      return <Minus className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden />
    case 'failed':
      return <X className="h-4 w-4 text-danger-700 dark:text-danger-400" aria-hidden />
    default:
      return <span className="h-4 w-4 rounded-full border border-anvil-300 dark:border-anvil-700" aria-hidden />
  }
}
