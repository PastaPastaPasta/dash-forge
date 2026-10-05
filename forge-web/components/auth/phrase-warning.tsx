/**
 * The fixed warning before every recovery-phrase prompt (TS-06). One text, everywhere: the web
 * app and `dg` show the same words (`RECOVERY_PHRASE_WARNING`, vector `copy__recovery_phrase_warning`),
 * so a page that asks for the phrase without them stands out.
 */

import { ShieldAlert } from 'lucide-react'
import { RECOVERY_PHRASE_WARNING } from '@/lib/auth/key-handoff'
import { cn } from '@/lib/utils'

export function PhraseWarning({ className }: { readonly className?: string }): JSX.Element {
  return (
    <p
      role="note"
      data-testid="phrase-warning"
      className={cn('flex items-start gap-2 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-[12px] text-caution-800 dark:text-caution-300', className)}
    >
      <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{RECOVERY_PHRASE_WARNING}</span>
    </p>
  )
}
