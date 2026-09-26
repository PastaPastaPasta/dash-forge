'use client'

import { CheckCircle2, AlertTriangle, X } from 'lucide-react'
import { useToasts } from '@/hooks/use-toasts'
import { creditsAsDash } from '@/lib/view/format'
import { cn } from '@/lib/utils'

/** Renders the toast queue (bottom-right, polite live region). */
export function Toaster(): JSX.Element {
  const { toasts, dismiss } = useToasts()
  return (
    <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cn(
            'pointer-events-auto flex items-start gap-2 rounded-lg border bg-white px-3 py-2.5 text-dense shadow-lg dark:bg-anvil-900',
            t.tone === 'error' ? 'border-danger/40' : t.tone === 'warn' ? 'border-caution/40' : 'border-anvil-200 dark:border-anvil-750',
          )}
        >
          {t.tone === 'error' || t.tone === 'warn' ? (
            <AlertTriangle className={cn('mt-0.5 h-4 w-4 shrink-0', t.tone === 'error' ? 'text-danger' : 'text-caution')} aria-hidden />
          ) : (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-verify" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-anvil-900 dark:text-anvil-50">
              {t.title}
              {t.credits != null ? (
                <span className="font-mono text-anvil-500 dark:text-anvil-400">
                  {' · '}
                  {t.credits < 0 ? `+${creditsAsDash(-t.credits)} DASH refunded` : `${creditsAsDash(t.credits)} DASH`}
                </span>
              ) : null}
            </div>
            {t.detail ? <div className="mt-0.5 break-words text-[12px] text-anvil-500 dark:text-anvil-400">{t.detail}</div> : null}
          </div>
          <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="text-anvil-400 hover:text-anvil-700">
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  )
}
