'use client'

import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CopyRow } from '@/components/ui/copy-row'

/**
 * A secret value (a runner key, a webhook secret): masked until the person asks to see it, so a
 * screen share or a screenshot of the page does not carry it (QW2-001, the web side of `dg`'s
 * rule that a secret is never shown by default). Copy copies the real value without revealing it.
 */
export function SecretValue({ label, value }: { label: string; value: string }): JSX.Element {
  const [shown, setShown] = useState(false)
  return (
    <div className="flex items-center gap-1" data-testid="secret-value">
      <CopyRow text={value} display={shown ? value : '•'.repeat(Math.min(24, value.length))} label={`Copy ${label}`} className="mb-0 min-w-0 flex-1" />
      <Button variant="ghost" size="icon" aria-label={shown ? `Hide ${label}` : `Show ${label}`} aria-pressed={shown} onClick={() => setShown(!shown)}>
        {shown ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
      </Button>
    </div>
  )
}
