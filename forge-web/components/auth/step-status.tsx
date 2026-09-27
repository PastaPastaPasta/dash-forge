'use client'

/**
 * The sign-in sheet's two in-between states: a named wait with its elapsed time (never a bare
 * spinner), and a named failure with "Try again".
 */

import { useEffect, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ErrorBox } from '@/components/auth/protection-fields'

/** What is being waited for, and for how long so far. `hint` explains a long wait. */
export function Waiting({ label, hint }: { label: string; hint?: string }): JSX.Element {
  const [since, setSince] = useState(() => Date.now())
  const [now, setNow] = useState(since)
  // A new step restarts the clock.
  useEffect(() => {
    const start = Date.now()
    setSince(start)
    setNow(start)
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [label])
  const secs = Math.floor((now - since) / 1000)
  return (
    <div className="space-y-1" role="status" aria-live="polite" data-testid="signin-waiting">
      <div className="flex items-center gap-2 text-dense text-anvil-600 dark:text-anvil-300">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
        <span>{label}…</span>
        {secs >= 3 ? <span className="font-mono text-[12px] text-anvil-500 dark:text-anvil-400">{secs} s</span> : null}
      </div>
      {hint && secs >= 5 ? <p className="text-[12px] text-anvil-500 dark:text-anvil-400">{hint}</p> : null}
    </div>
  )
}

/** A step that failed or timed out: what, and a way to try again. */
export function StepFailed({ error, onRetry, retryLabel = 'Try again' }: { error: string; onRetry: () => void; retryLabel?: string }): JSX.Element {
  return (
    <div className="space-y-3" data-testid="signin-failed">
      <ErrorBox error={error} />
      <Button variant="outline" className="w-full" onClick={onRetry}>
        <RefreshCw className="h-4 w-4" aria-hidden /> {retryLabel}
      </Button>
    </div>
  )
}
