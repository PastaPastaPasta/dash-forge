'use client'

/**
 * Settings → Keys → Enable private repos (`docs/security/private-repos.md` §5.2,
 * `ux-dx-spec.md` §2.3): keep this identity's ENCRYPTION key in the browser vault, beside the
 * limited key and protected the same way (passkey PRF or passphrase), dropped on lock.
 *
 * Three ways in, each checked against the identity before anything is stored: an identity file
 * (its encryption key, or one derived from its recovery phrase), a pasted private key, or, for
 * an identity with no encryption key yet, registering one from the recovery phrase (one
 * master-key signature). The key never reaches React state: file text and pasted keys are held
 * in refs and dropped after use.
 */

import { useEffect, useRef, useState } from 'react'
import { KeyRound, Trash2 } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/hooks/use-sdk'
import { NETWORKS } from '@/lib/constants'
import {
  ENCRYPTION_KEY_BLAST_RADIUS,
  adoptEncryptionKey,
  encryptionMaterialFromFile,
  importEncryptionKey,
  parseEncryptionKeyInput,
  registerEncryptionKey,
  wipeMaterial,
} from '@/lib/auth/encryption-key'
import { onEncryptionKeyChange, removeEncryptionKey, storedEncryptionKeyId } from '@/lib/auth/vault'
import { errorMessage } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { UnlockMore } from '@/components/auth/unlock-more'
import { Field, Input, Textarea } from '@/components/ui/input'

type Mode = 'file' | 'paste' | 'register'

/** An identity update adding one key (measured like the limited-key registration). */
const REGISTER_COST = '~0.0005 DASH'

export function EncryptionKeyPanel(): JSX.Element | null {
  const { identity, storage, controller, unlockScope } = useAuth()
  const { sdk, ready, network } = useSdk()
  const core = NETWORKS[network].v2?.core ?? null
  const [keyId, setKeyId] = useState<number | null | undefined>(undefined)
  const [mode, setMode] = useState<Mode>('file')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  // Secrets: refs only, dropped after use and on unmount.
  const pasted = useRef<HTMLInputElement>(null)
  const phrase = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (identity === null) return
    let live = true
    const read = (): void => {
      storedEncryptionKeyId(network, identity).then(
        (k) => live && setKeyId(k),
        () => live && setKeyId(null),
      )
    }
    read()
    const off = onEncryptionKeyChange(read)
    return () => {
      live = false
      off()
    }
  }, [identity, network])

  if (identity === null || core === null) return null

  const run = async (work: () => Promise<number | null>): Promise<void> => {
    if (!ready || sdk === null) {
      setError('Still connecting to Platform; try again in a moment.')
      return
    }
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const id = await work()
      if (id === null) {
        setError('This identity has no encryption key that opens with that. Register one below (Register), or run `dg auth keys add --encryption`.')
      } else {
        setNote(`Private repos enabled: encryption key ${id} is stored in this browser.`)
      }
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
      if (pasted.current) pasted.current.value = ''
      if (phrase.current) phrase.current.value = ''
    }
  }

  const fromFile = (file: File): void => {
    void run(async () => {
      const material = encryptionMaterialFromFile(await file.text())
      try {
        if (material.identityId !== identity) throw new Error('that identity file is for another identity')
        return await importEncryptionKey(sdk!, network, identity, core, material)
      } finally {
        wipeMaterial(material)
      }
    })
  }

  const fromPaste = (): void => {
    const value = pasted.current?.value ?? ''
    void run(() => adoptEncryptionKey(sdk!, network, identity, core, parseEncryptionKeyInput(value)))
  }

  const register = (): void => {
    const mnemonic = phrase.current?.value ?? ''
    if (!window.confirm(`Register a new encryption key on your identity (${REGISTER_COST})? Your recovery phrase signs one identity update and is not stored. If your identity already has an encryption key, it is added here instead and nothing is registered.`)) return
    void run(async () => {
      // A paid IdentityUpdate: recorded in the spend ledger like the other key updates.
      let keyId = 0
      await controller.chargedUpdate(identity, 'key:encryption', async () => {
        const r = await registerEncryptionKey(sdk!, network, identity, core, { mnemonic })
        keyId = r.keyId
        return r.registered
      })
      return keyId
    })
  }

  return (
    <section aria-labelledby="enc-key-title" className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800" data-testid="encryption-key-panel">
      <h2 id="enc-key-title" className="mb-2 flex items-center gap-2 text-dense font-medium text-anvil-500 dark:text-anvil-400">
        <KeyRound className="h-3.5 w-3.5" aria-hidden /> Private repos
      </h2>
      <p className="text-[12px] text-anvil-600 dark:text-anvil-300">{ENCRYPTION_KEY_BLAST_RADIUS}</p>
      {unlockScope === 'signing' ? (
        <div className="mt-3">
          <UnlockMore title="Unlock this tab to manage your encryption key" testId="encryption-unlock" />
        </div>
      ) : keyId !== null && keyId !== undefined ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <span className="text-dense" data-testid="encryption-key-stored">
            {storage === 'session'
              ? `Encryption key ${keyId} is held for this tab only; it is forgotten on reload or lock.`
              : `Encryption key ${keyId} is stored in this browser, locked with the rest of the vault.`}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (window.confirm('Remove the encryption key from this browser? You can add it again from your identity file.')) {
                removeEncryptionKey(network, identity).catch((e: unknown) => setError(errorMessage(e)))
              }
            }}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove from this browser
          </Button>
        </div>
      ) : keyId === null ? (
        <div className="mt-3 space-y-3">
          <p className="text-dense font-medium">Enable private repos</p>
          <div role="tablist" className="inline-flex rounded-md border border-anvil-200 p-0.5 dark:border-anvil-750">
            {(
              [
                ['file', 'Identity file'],
                ['paste', 'Paste key'],
                ['register', 'Register a new key'],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                type="button"
                onClick={() => setMode(m)}
                className={'rounded px-3 py-1.5 text-dense font-medium ' + (mode === m ? 'bg-forge-500/15 text-forge-800 dark:text-forge-400' : 'text-anvil-500 dark:text-anvil-400')}
              >
                {label}
              </button>
            ))}
          </div>
          {mode === 'file' ? (
            <Field label="Identity file" htmlFor="enc-file" hint="Its encryption key (or one derived from its recovery phrase) is checked against your identity, then stored.">
              <input
                id="enc-file"
                type="file"
                accept="application/json,.json,.txt"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) fromFile(f)
                  e.target.value = ''
                }}
              />
            </Field>
          ) : null}
          {mode === 'paste' ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1">
                <Field label="Encryption private key (WIF or hex)" htmlFor="enc-paste">
                  <Input id="enc-paste" ref={pasted} type="password" autoComplete="off" spellCheck={false} className="font-mono" />
                </Field>
              </div>
              <Button variant="primary" loading={busy} onClick={fromPaste}>
                Store key
              </Button>
            </div>
          ) : null}
          {mode === 'register' ? (
            <div className="space-y-2">
              <Field
                label="Recovery phrase (12 or 24 words)"
                htmlFor="enc-phrase"
                hint={`Derives the new key and your master key, which signs one identity update (${REGISTER_COST}, one master-key signature). Neither is stored.`}
              >
                <Textarea id="enc-phrase" ref={phrase} className="min-h-[64px] font-mono" spellCheck={false} autoComplete="off" />
              </Field>
              <Button variant="primary" loading={busy} onClick={register}>
                Register and store
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {note ? <p className="mt-2 text-[12px] text-verify-700 dark:text-verify-400">{note}</p> : null}
      {error ? (
        <p role="alert" className="mt-2 text-[12px] text-danger-700 dark:text-danger-400 break-words">
          {error}
        </p>
      ) : null}
    </section>
  )
}
