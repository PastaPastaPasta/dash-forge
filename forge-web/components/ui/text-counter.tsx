/**
 * A live byte counter under a composer's text field (D-049): grey while it fits, amber near
 * the contract's limit, red with the fix once over it. The composer disables its submit on
 * `textUse(...).over`, so an over-long write is never signed.
 */

import { cn } from '@/lib/utils'
import { formatCount, overLimitMessage, textUse, type TextLimit, type TextUse } from '@/lib/view/text-limits'

function toneClass(use: TextUse): string {
  if (use.over) return 'text-danger-700 dark:text-danger-400'
  if (use.near) return 'text-caution-700 dark:text-caution-400'
  return 'text-anvil-500 dark:text-anvil-400'
}

export function TextCounter({ text, limit, field, id }: { text: string; limit: TextLimit; field: string; id?: string }): JSX.Element {
  const use = textUse(text, limit)
  const message = overLimitMessage(field, use, limit)
  return (
    <p
      id={id}
      data-testid="text-counter"
      data-over={use.over ? 'true' : 'false'}
      aria-live="polite"
      className={cn('text-right font-mono text-[11px]', toneClass(use))}
    >
      {message ?? `${formatCount(use.bytes)} / ${formatCount(limit.bytes)} bytes`}
    </p>
  )
}
