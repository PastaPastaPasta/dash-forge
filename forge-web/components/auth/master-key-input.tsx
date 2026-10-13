'use client'

/**
 * "Master key, used once": the identity file or recovery phrase a master-key update signs with
 * (a key top-up, a CI runner key, a revoke). Neither enters React state: the file's text lives in
 * a ref, the phrase in an uncontrolled textarea, both read by `take()` at submit and cleared by
 * it, unless the caller keeps them for a correction (`take({ keep: true })`: words that turn out
 * to be another identity's stay in the field to fix, QW3-028) and clears them on success.
 * Only "something was given" is state.
 */

import { useRef, useState } from 'react'
import { KeyRound, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Field, Textarea } from '@/components/ui/input'
import { masterMaterialFromFile, type MasterInput } from '@/lib/auth'
import { otherIdentityFileMessage } from '@/lib/auth/controller'
import { cn, errorMessage } from '@/lib/utils'
import { PhraseWarning } from '@/components/auth/phrase-warning'

export interface MasterKeyInput {
  /** The fieldset to render. */
  readonly element: JSX.Element
  /** A file or a phrase was given. */
  readonly ready: boolean
  /** Why the chosen file was refused, or null. */
  readonly error: string | null
  /** What was given, cleared from the page as it is returned (unless `keep`). */
  take: (opts?: { readonly keep?: boolean }) => MasterInput
  /** Clear what was given. */
  clear: () => void
}

/**
 * `identityId`: a file for another identity is refused as it is chosen. `id` keeps element ids
 * unique; `fileLabel` names the file input for assistive tech; `legend` names what the file or
 * phrase is for (a username signs with the identity's CRITICAL key, not its master key: #452).
 */
export function useMasterKeyInput(
  identityId: string | null,
  { id, fileLabel, legend = 'Master key, used once' }: { readonly id: string; readonly fileLabel: string; readonly legend?: string },
): MasterKeyInput {
  const [mode, setMode] = useState<'file' | 'mnemonic'>('file')
  const fileRef = useRef<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState('')
  const phraseRef = useRef<HTMLTextAreaElement>(null)
  const [phraseTyped, setPhraseTyped] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onFile = async (f: File): Promise<void> => {
    setError(null)
    const text = await f.text()
    try {
      const m = masterMaterialFromFile(text)
      if (m.identityId !== identityId) throw new Error(identityId === null ? 'Sign in first.' : otherIdentityFileMessage(m.identityId, identityId, f.name))
      fileRef.current = text
      setFileName(f.name)
    } catch (e) {
      fileRef.current = null
      setFileName('')
      setError(errorMessage(e))
    }
  }

  const clear = (): void => {
    fileRef.current = null
    setFileName('')
    if (phraseRef.current) phraseRef.current.value = ''
    setPhraseTyped(false)
    setError(null)
  }
  const take = (opts: { readonly keep?: boolean } = {}): MasterInput => {
    const input = mode === 'file' ? { fileText: fileRef.current ?? '' } : { mnemonic: phraseRef.current?.value ?? '' }
    if (opts.keep !== true) clear()
    return input
  }

  const element = (
    <fieldset className="space-y-2 rounded-md border border-anvil-200 p-3 dark:border-anvil-750">
      <legend className="px-1 text-[12px] font-medium text-anvil-600 dark:text-anvil-300">
        <KeyRound className="mr-1 inline h-3.5 w-3.5" aria-hidden /> {legend}
      </legend>
      <div role="group" aria-label="Master key source" className="inline-flex rounded-md border border-anvil-200 p-0.5 dark:border-anvil-750">
        {(['file', 'mnemonic'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => {
              // The textarea remounts empty: nothing typed stays counted, and a refused file's
              // error does not stand in for what the other source says.
              setPhraseTyped(false)
              setError(null)
              setMode(m)
            }}
            className={cn('rounded px-3 py-1 text-dense font-medium coarse:min-h-11', mode === m ? 'bg-forge-500/15 text-forge-800 dark:text-forge-300' : 'text-anvil-600 dark:text-anvil-300')}
          >
            {m === 'file' ? 'Identity file' : 'Recovery phrase'}
          </button>
        ))}
      </div>
      {mode === 'file' ? (
        <>
          <Button type="button" variant="outline" className="w-full" onClick={() => fileInput.current?.click()}>
            <Upload className="h-4 w-4" aria-hidden /> {fileName || 'Choose the identity file'}
          </Button>
          <input
            ref={fileInput}
            type="file"
            aria-label={fileLabel}
            accept="application/json,.json,.txt"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void onFile(f)
              e.target.value = ''
            }}
          />
        </>
      ) : (
        <>
          <PhraseWarning />
          <Field label="Recovery phrase (12 or 24 words)" htmlFor={`${id}-mnemonic`}>
            <Textarea
              id={`${id}-mnemonic`}
              ref={phraseRef}
              defaultValue=""
              onChange={(e) => setPhraseTyped(e.target.value.trim() !== '')}
              className="min-h-[64px] font-mono"
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
        </>
      )}
    </fieldset>
  )

  return { element, ready: mode === 'file' ? fileName !== '' : phraseTyped, error, take, clear }
}
