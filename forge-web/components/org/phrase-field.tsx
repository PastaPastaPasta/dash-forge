'use client'

import { Eye, EyeOff } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { isValidMnemonic, mnemonicProblem } from '@/lib/auth/hd'
import { NotAMemberError, unlockPhrase, type Unlocked } from '@/lib/org/store'

export interface PhraseState {
  readonly phrase: string
  readonly passphrase: string
}

export const EMPTY_PHRASE: PhraseState = { phrase: '', passphrase: '' }

/** The multisig seed phrase, masked as typed with a Show button (§11.2), and its optional passphrase. */
export function PhraseField({ value, onChange, autoFocus = false }: { value: PhraseState; onChange: (v: PhraseState) => void; autoFocus?: boolean }): JSX.Element {
  const [shown, setShown] = useState(false)
  return (
    <div className="space-y-2">
      <Field label="Multisig seed phrase" htmlFor="org-phrase">
        <div className="flex items-center gap-1">
          <Input
            id="org-phrase"
            type={shown ? 'text' : 'password'}
            autoFocus={autoFocus}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="font-mono"
            value={value.phrase}
            onChange={(e) => onChange({ ...value, phrase: e.target.value })}
            data-testid="org-phrase"
          />
          <Button variant="ghost" size="icon" type="button" aria-label={shown ? 'Hide phrase' : 'Show phrase'} aria-pressed={shown} onClick={() => setShown(!shown)} data-testid="org-phrase-show">
            {shown ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
          </Button>
        </div>
      </Field>
      <details className="text-dense">
        <summary className="cursor-pointer text-anvil-600 dark:text-anvil-300">Passphrase</summary>
        <div className="mt-2">
          <Input type="password" aria-label="Passphrase" autoComplete="off" value={value.passphrase} onChange={(e) => onChange({ ...value, passphrase: e.target.value })} />
        </div>
      </details>
    </div>
  )
}

/** Unlocks `value` for one of `members`, or throws the message to show. */
export async function unlockFrom(value: PhraseState, members: readonly string[], label: string): Promise<Unlocked> {
  if (!(await isValidMnemonic(value.phrase))) throw new Error(mnemonicProblem(value.phrase))
  try {
    return unlockPhrase(value.phrase, value.passphrase, members)
  } catch (e) {
    if (e instanceof NotAMemberError) throw new Error(`This seed phrase isn't the one you use in ${label}. Check the words and the passphrase.`)
    throw e
  }
}
