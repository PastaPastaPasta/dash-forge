'use client'

/**
 * Settings → Private repos (`docs/security/private-repos.md` §5.2,
 * `ux-dx-spec.md` §2.3): keep this identity's ENCRYPTION key in the browser vault, beside the
 * limited key and protected the same way (passkey PRF or passphrase), dropped on lock.
 *
 * Four ways in, each checked against the identity before anything is stored: the recovery phrase
 * (derives the identity's existing encryption key, free: QW3-032, an identity created in this
 * browser has no file and was offered only a paid "Register"), an identity file (its encryption
 * key, or one derived from its recovery phrase), a pasted private key, or, for an identity with
 * no encryption key yet, registering one from the recovery phrase (one master-key signature).
 * The key never reaches React state: file text, words and pasted keys are held in refs and
 * dropped after use.
 */

import { useEffect, useRef, useState } from 'react'
import { KeyRound, Trash2 } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/hooks/use-sdk'
import { NETWORKS } from '@/lib/constants'
import {
  ENCRYPTION_KEY_BLAST_RADIUS,
  adoptEncryptionKey,
  fetchIdentityKeys,
  encryptionMaterialFromFile,
  importEncryptionKey,
  parseEncryptionKeyInput,
  registerEncryptionKey,
  usableEncryptionKey,
  wipeMaterial,
} from '@/lib/auth/encryption-key'
import { onEncryptionKeyChange, removeEncryptionKey, storedEncryptionKeyId } from '@/lib/auth/vault'
import { errorMessage } from '@/lib/utils'
import { otherIdentityFileMessage } from '@/lib/auth/controller'
import { PRIVATE_REPOS_ANCHOR } from '@/lib/settings-links'
import { Button } from '@/components/ui/button'
import { UnlockMore } from '@/components/auth/unlock-more'
import { Field, Input, Textarea } from '@/components/ui/input'
import { useConfirmAction } from '@/components/ui/confirm-action'
import { PhraseWarning } from '@/components/auth/phrase-warning'

type Mode = 'phrase' | 'file' | 'paste' | 'register'

/** An identity update adding one key (measured like the limited-key registration). */
const REGISTER_COST = '~0.0005 DASH'

export function EncryptionKeyPanel(): JSX.Element | null {
  const { identity, storage, controller, unlockScope } = useAuth()
  const { sdk, ready, network } = useSdk()
  const core = NETWORKS[network].v2?.core ?? null
  const [keyId, setKeyId] = useState<number | null | undefined>(undefined)
  const [mode, setMode] = useState<Mode>('phrase')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  // Secrets: refs only, dropped after use and on unmount.
  const pasted = useRef<HTMLInputElement>(null)
  const phrase = useRef<HTMLTextAreaElement>(null)
  const [confirm, confirmDialog] = useConfirmAction()

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

  // Opened from a "Settings → Private repos" link (`#private-repos`): the card renders once the
  // session is known, after the browser's own jump to the fragment found nothing, so scroll here.
  const sectionRef = useRef<HTMLElement>(null)
  const shown = identity !== null && core !== null
  useEffect(() => {
    if (shown && window.location.hash === `#${PRIVATE_REPOS_ANCHOR}`) sectionRef.current?.scrollIntoView({ block: 'start' })
  }, [shown])

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
        setError('This identity has no encryption key that opens with that. Register one (Register a new key), or run `dg auth keys add --encryption`.')
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
        if (material.identityId !== identity) throw new Error(otherIdentityFileMessage(material.identityId, identity, file.name))
        return await importEncryptionKey(sdk!, network, identity, core, material)
      } finally {
        wipeMaterial(material)
      }
    })
  }

  // The identity's existing encryption key, derived from its words: nothing is signed or paid.
  // Words that open none of its keys are named as such, not as a missing key to register.
  const fromPhrase = (): void => {
    const mnemonic = phrase.current?.value ?? ''
    void run(async () => {
      const id = await importEncryptionKey(sdk!, network, identity, core, { mnemonic })
      if (id !== null) return id
      const existing = usableEncryptionKey((await fetchIdentityKeys(sdk!, identity)) ?? [], core)
      if (existing !== null) {
        throw new Error(`These recovery words don't open this identity's encryption key (key ${existing.keyId}). Check the words, or use your identity file.`)
      }
      return null
    })
  }

  const fromPaste = (): void => {
    const value = pasted.current?.value ?? ''
    void run(() => adoptEncryptionKey(sdk!, network, identity, core, parseEncryptionKeyInput(value)))
  }

  const register = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Register a new encryption key?',
      body: `This adds an encryption key to your identity (${REGISTER_COST}): your recovery phrase signs one identity update and is not stored. If your identity already has an encryption key, it is added here instead and nothing is registered.`,
      confirmLabel: 'Register key',
      tone: 'primary',
    })
    if (!ok) return
    // Read after the confirm: the field keeps its value while the dialog is open.
    const mnemonic = phrase.current?.value ?? ''
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
    <section
      ref={sectionRef}
      id={PRIVATE_REPOS_ANCHOR}
      aria-labelledby="enc-key-title"
      className="scroll-mt-20 rounded-lg border border-anvil-200 p-4 dark:border-anvil-800"
      data-testid="encryption-key-panel"
    >
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
              : `Encryption key ${keyId} is stored in this browser and unlocked now: private repos you're a member of open here. It locks again with this browser's key (Lock, or after 12 hours).`}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void confirm({
                title: 'Remove the encryption key from this browser?',
                body: 'Private repos stop opening here until you add it again (from your identity file, the key itself or your recovery phrase). The key stays on your identity.',
                confirmLabel: 'Remove key',
              }).then((ok) => {
                if (ok) removeEncryptionKey(network, identity).catch((e: unknown) => setError(errorMessage(e)))
              })
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
                ['phrase', 'Recovery phrase'],
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
                className={'rounded px-3 py-1.5 text-dense font-medium coarse:min-h-11 ' + (mode === m ? 'bg-forge-500/15 text-forge-800 dark:text-forge-400' : 'text-anvil-500 dark:text-anvil-400')}
              >
                {label}
              </button>
            ))}
          </div>
          {mode === 'phrase' ? (
            <div className="space-y-2">
              <PhraseWarning />
              <Field
                label="Recovery phrase (12 or 24 words)"
                htmlFor="enc-phrase"
                hint="Derives your identity's encryption key, checks it against the identity, and stores it here. Nothing is signed or paid; the words are not stored."
              >
                <Textarea id="enc-phrase" ref={phrase} className="min-h-[64px] font-mono" spellCheck={false} autoComplete="off" />
              </Field>
              <Button variant="primary" loading={busy} onClick={fromPhrase}>
                Use my encryption key
              </Button>
            </div>
          ) : null}
          {mode === 'file' ? (
            <Field label="Identity file" htmlFor="enc-file" hint="Its encryption key (or one derived from its recovery phrase) is checked against your identity, then stored.">
              <input
                id="enc-file"
                type="file"
                accept="application/json,.json,.txt"
                disabled={busy}
                className="max-w-full text-dense coarse:min-h-11"
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
              <p className="text-[12px] text-anvil-600 dark:text-anvil-300">
                Only for an identity with no encryption key yet. If yours has one, use Recovery phrase above: it is free.
              </p>
              <PhraseWarning />
              <Field
                label="Recovery phrase (12 or 24 words)"
                htmlFor="enc-phrase"
                hint={`Derives the new key and your master key, which signs one identity update (${REGISTER_COST}, one master-key signature). Neither is stored. An existing encryption key is used instead, at no cost.`}
              >
                <Textarea id="enc-phrase" ref={phrase} className="min-h-[64px] font-mono" spellCheck={false} autoComplete="off" />
              </Field>
              <Button variant="primary" loading={busy} onClick={() => void register()}>
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
      {confirmDialog}
    </section>
  )
}
