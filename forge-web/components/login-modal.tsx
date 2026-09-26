'use client'

/**
 * The sign-in sheet (`ux-dx-spec.md` §2.2). Three tiles plus an Advanced disclosure:
 *
 *   1. Use my Dash wallet — App Connect (shown only when the system contract exists here);
 *   2. Create a new identity — mnemonic + backup quiz + deposit QR, registered with a limited
 *      key inside the IdentityCreate;
 *   3. Import an identity file (or mnemonic) — the master key signs one IdentityUpdate that
 *      registers a limited key for this browser, and is not stored;
 *   Advanced: paste a raw key (developer path; this tab only; red warning).
 *
 * When this device already holds an encrypted key, the sheet opens on "Unlock" instead
 * (callers can open it on a view directly: Renew opens Import). On a network without forge-v2
 * (no contract group to bind a key to, testnet today) only the v1 path exists: the identity
 * file signs with its HIGH/CRITICAL key for this tab.
 */

import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Fingerprint, KeyRound, Lock, Plus, Upload, Wallet } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore, type LoginView } from '@/hooks/use-ui-store'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/input'
import { ErrorBox, useProtection } from '@/components/auth/protection-fields'
import { CreateIdentityFlow } from '@/components/auth/create-identity-flow'
import { WalletConnectFlow } from '@/components/auth/wallet-connect-flow'
import { FORGET_CONFIRM } from '@/components/keys-panel'
import { ACTIVE_NETWORK } from '@/lib/constants'
import { BROWSER_KEY_DEFAULTS, masterMaterialFromFile, parseIdentityFileText } from '@/lib/auth'
import { appConnectAvailable } from '@/lib/auth/app-connect'
import { ensureSdk } from '@/lib/sdk'
import { formatDate } from '@/lib/view/format'
import { cn, errorMessage } from '@/lib/utils'

type View = 'choose' | 'unlock' | 'advanced' | LoginView

export function LoginModal(): JSX.Element {
  const open = useUiStore((s) => s.loginOpen)
  const requested = useUiStore((s) => s.loginView)
  const close = useUiStore((s) => s.closeLogin)
  const { vaults, limitedKeys } = useAuth()
  const [view, setView] = useState<View>('choose')
  const [unlockFor, setUnlockFor] = useState<string | null>(null)
  const hasVault = vaults.length > 0

  // Pick the view when the sheet opens. If the stored-key list arrives after it opened (the
  // /login route opens it on load), move from the untouched tile list to Unlock — never
  // away from a flow the user already started.
  const opened = useRef<{ hasVault: boolean } | null>(null)
  useEffect(() => {
    if (!open) {
      opened.current = null
      return
    }
    if (opened.current === null) {
      opened.current = { hasVault }
      setView(requested ?? (hasVault ? 'unlock' : 'choose'))
      setUnlockFor(null)
      return
    }
    if (!opened.current.hasVault && hasVault && requested === null) {
      opened.current = { hasVault }
      setView((v) => (v === 'choose' ? 'unlock' : v))
    }
  }, [open, requested, hasVault])

  const back = view === 'choose' || view === 'unlock' ? null : () => setView('choose')
  const description =
    view === 'advanced'
      ? 'A pasted key signs for this tab only, with whatever power it has.'
      : limitedKeys
        ? `Forge signs with a limited key: at most ${BROWSER_KEY_DEFAULTS.budgetDash} DASH, only on Forge, for ${BROWSER_KEY_DEFAULTS.days} days.`
        : `Your key signs writes on ${ACTIVE_NETWORK.key}. It stays in this tab, never sent anywhere.`

  return (
    <Dialog open={open} onClose={close} title="Sign in to Dash Forge" description={description} className="max-w-lg">
      {back ? (
        <button type="button" onClick={back} className="mb-3 inline-flex items-center gap-1 text-dense text-anvil-500 hover:text-anvil-800 dark:hover:text-anvil-100">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> All options
        </button>
      ) : null}
      {view === 'unlock' ? <UnlockView initial={unlockFor} onDone={close} onOther={() => setView('choose')} onRenew={() => setView('import')} /> : null}
      {view === 'choose' ? <ChooseView onPick={setView} /> : null}
      {view === 'import' ? (
        limitedKeys ? (
          <ImportView
            onDone={close}
            onStored={(id) => {
              setUnlockFor(id)
              setView('unlock')
            }}
          />
        ) : (
          <V1FileView onDone={close} />
        )
      ) : null}
      {view === 'create' ? <CreateIdentityFlow onDone={close} /> : null}
      {view === 'wallet' ? <WalletConnectFlow onDone={close} /> : null}
      {view === 'advanced' ? <AdvancedView onDone={close} /> : null}
    </Dialog>
  )
}

function Tile({ icon: Icon, title, body, onClick, testId }: { icon: typeof Wallet; title: string; body: string; onClick: () => void; testId: string }): JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="flex w-full items-start gap-3 rounded-lg border border-anvil-200 px-3 py-3 text-left transition-colors hover:border-forge-400 hover:bg-anvil-50 dark:border-anvil-750 dark:hover:bg-anvil-850"
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-forge-500" aria-hidden />
      <span>
        <span className="block text-dense font-medium text-anvil-900 dark:text-anvil-50">{title}</span>
        <span className="block text-[12px] text-anvil-500 dark:text-anvil-400">{body}</span>
      </span>
    </button>
  )
}

function ChooseView({ onPick }: { onPick: (v: View) => void }): JSX.Element {
  const { limitedKeys } = useAuth()
  const walletAvailable = useWalletAvailability(limitedKeys)
  const [advanced, setAdvanced] = useState(false)
  return (
    <div className="space-y-2">
      {limitedKeys && walletAvailable ? (
        <Tile testId="tile-wallet" icon={Wallet} title="Use my Dash wallet" body="Scan a QR with a wallet that supports Platform login. It grants Forge a limited key." onClick={() => onPick('wallet')} />
      ) : null}
      {limitedKeys ? (
        <Tile testId="tile-create" icon={Plus} title="Create a new identity" body="12 words you write down, then fund it from any Dash wallet. ~0.0005 DASH per issue or push." onClick={() => onPick('create')} />
      ) : null}
      <Tile
        testId="tile-import"
        icon={Upload}
        title={limitedKeys ? 'Import an identity file or recovery phrase' : 'Import an identity file'}
        body={
          limitedKeys
            ? 'Your master key is used once, right now, to create a limited key for this browser. It is not stored.'
            : 'The bridge / dg JSON export. Its signing key stays in this tab only.'
        }
        onClick={() => onPick('import')}
      />
      <div className="pt-2">
        <button type="button" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)} className="text-[12px] text-anvil-500 underline hover:text-anvil-800 dark:hover:text-anvil-100">
          Advanced
        </button>
        {advanced ? (
          <div className="mt-2">
            <Tile testId="tile-advanced" icon={KeyRound} title="Paste a private key" body="Developer path. The key is held in this tab only and is lost on reload." onClick={() => onPick('advanced')} />
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** Whether the App Connect tile applies here (protocol 14 + the system contract present). */
function useWalletAvailability(limitedKeys: boolean): boolean {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    if (!limitedKeys) return
    let cancelled = false
    ensureSdk(ACTIVE_NETWORK.network)
      .then(appConnectAvailable)
      .then(
        (ok) => !cancelled && setAvailable(ok),
        () => undefined,
      )
    return () => {
      cancelled = true
    }
  }, [limitedKeys])
  return available
}

/** A dashed "choose a file" button over a hidden file input. */
function FilePicker({ label, detail, onFile, disabled }: { label: string; detail?: string; onFile: (f: File) => void; disabled?: boolean }): JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => ref.current?.click()}
        className="flex w-full flex-col items-center gap-1 rounded-lg border border-dashed border-anvil-300 px-4 py-5 text-center hover:border-forge-400 dark:border-anvil-700"
      >
        <Upload className="h-5 w-5 text-forge-500" aria-hidden />
        <span className="text-dense font-medium">{label}</span>
        {detail ? <span className="font-mono text-[12px] text-anvil-500">{detail}</span> : null}
      </button>
      <input
        ref={ref}
        type="file"
        aria-label="Identity file"
        accept="application/json,.json,.txt"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onFile(f)
          e.target.value = ''
        }}
      />
    </>
  )
}

function UnlockView({ initial, onDone, onOther, onRenew }: { initial: string | null; onDone: () => void; onOther: () => void; onRenew: () => void }): JSX.Element {
  const { vaults, unlock, forget, isLoading } = useAuth()
  const [pick, setPick] = useState(() => Math.max(0, vaults.findIndex((v) => v.identityId === initial)))
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState<string | null>(null)
  const v = vaults[pick] ?? vaults[0]
  if (!v) {
    return (
      <div className="space-y-3">
        <p className="text-dense">No key is stored on this device.</p>
        <Button variant="primary" className="w-full" onClick={onOther}>
          Sign-in options
        </Button>
      </div>
    )
  }
  const go = async (method: { passphrase: string } | 'passkey'): Promise<void> => {
    if (isLoading) return
    setError(null)
    try {
      await unlock(v.identityId, method)
      setPassphrase('')
      onDone()
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  const expired = error !== null && /no longer usable|renew/i.test(error)
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-dense">
        <Lock className="h-4 w-4 text-anvil-400" aria-hidden />
        This browser holds a key for{' '}
        {vaults.length > 1 ? (
          <select aria-label="Identity" value={pick} onChange={(e) => setPick(Number(e.target.value))} className="rounded border border-anvil-300 bg-transparent px-1 font-mono dark:border-anvil-700">
            {vaults.map((x, i) => (
              <option key={x.identityId} value={i}>
                {x.identityId.slice(0, 10)}…
              </option>
            ))}
          </select>
        ) : (
          <span className="font-mono">{v.identityId.slice(0, 10)}…</span>
        )}
      </div>
      {v.methods.includes('passkey') ? (
        <Button variant="primary" className="w-full" onClick={() => go('passkey')} loading={isLoading} disabled={isLoading}>
          <Fingerprint className="h-4 w-4" aria-hidden /> Unlock with passkey
        </Button>
      ) : null}
      {v.methods.includes('passphrase') ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            void go({ passphrase })
          }}
        >
          <Field label="Passphrase" htmlFor="unlock-passphrase">
            <Input id="unlock-passphrase" type="password" autoComplete="current-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoFocus />
          </Field>
          <Button type="submit" variant={v.methods.includes('passkey') ? 'outline' : 'primary'} className="w-full" loading={isLoading} disabled={passphrase === '' || isLoading}>
            Unlock
          </Button>
        </form>
      ) : null}
      <ErrorBox error={error} />
      {expired ? (
        <Button variant="outline" className="w-full" onClick={onRenew}>
          Renew this browser&apos;s key
        </Button>
      ) : null}
      <div className="flex justify-between pt-1 text-[12px]">
        <button type="button" onClick={onOther} className="text-anvil-500 underline">
          Other sign-in options
        </button>
        <button
          type="button"
          onClick={() => {
            if (window.confirm(FORGET_CONFIRM)) void forget(v.identityId).then(() => setPick(0))
          }}
          className="text-danger underline"
        >
          Forget this key
        </button>
      </div>
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
        Stored {formatDate(v.createdAt)} · key #{v.keyId}
      </p>
    </div>
  )
}

function ImportView({ onDone, onStored }: { onDone: () => void; onStored: (identityId: string) => void }): JSX.Element {
  const { importIdentity, isLoading, vaults, identity } = useAuth()
  const [mode, setMode] = useState<'file' | 'mnemonic'>('file')
  // The identity file holds every private key: a ref (not React state), dropped on unmount
  // and after use; state only records that one was chosen.
  const fileRef = useRef<string | null>(null)
  const [fileChosen, setFileChosen] = useState(false)
  useEffect(
    () => () => {
      fileRef.current = null
    },
    [],
  )
  const [fileName, setFileName] = useState('')
  const [fileIdentity, setFileIdentity] = useState('')
  const [mnemonic, setMnemonic] = useState('')
  const [identityId, setIdentityId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const { fields, protection, problem } = useProtection()
  const who = mode === 'file' ? fileIdentity : identityId.trim()
  // Offer Unlock for a key this device already holds, unless this is a renewal of the
  // signed-in identity (then the old key is disabled in the same update).
  const alreadyStored = who !== '' && who !== identity && vaults.some((v) => v.identityId === who)

  const onFile = async (file: File): Promise<void> => {
    setError(null)
    const text = await file.text()
    try {
      setFileIdentity(masterMaterialFromFile(text).identityId)
    } catch (e) {
      fileRef.current = null
      setFileChosen(false)
      setFileIdentity('')
      setError(errorMessage(e))
      return
    }
    fileRef.current = text
    setFileChosen(true)
    setFileName(file.name)
  }

  const ready = protection !== null && !isLoading && (mode === 'file' ? fileChosen : mnemonic.trim() !== '' && identityId.trim() !== '')
  const submit = async (): Promise<void> => {
    if (!protection || isLoading) return
    setError(null)
    try {
      const text = fileRef.current
      if (mode === 'file' && text === null) return
      await importIdentity(mode === 'file' ? { fileText: text as string } : { mnemonic, identityId }, protection)
      fileRef.current = null
      setMnemonic('')
      onDone()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <div className="space-y-3">
      <div role="tablist" className="inline-flex rounded-md border border-anvil-200 p-0.5 dark:border-anvil-750">
        {(['file', 'mnemonic'] as const).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            type="button"
            onClick={() => setMode(m)}
            className={cn('rounded px-3 py-1.5 text-dense font-medium', mode === m ? 'bg-forge-500/15 text-forge-600 dark:text-forge-400' : 'text-anvil-500')}
          >
            {m === 'file' ? 'Identity file' : 'Recovery phrase'}
          </button>
        ))}
      </div>
      {mode === 'file' ? (
        <FilePicker label={fileName || 'Choose an identity file (.json)'} detail={fileIdentity || undefined} onFile={(f) => void onFile(f)} />
      ) : (
        <>
          <Field label="Identity ID" htmlFor="import-id">
            <Input id="import-id" value={identityId} onChange={(e) => setIdentityId(e.target.value)} className="font-mono" spellCheck={false} autoComplete="off" />
          </Field>
          <Field label="Recovery phrase (12 or 24 words)" htmlFor="import-mnemonic" hint="Used once to derive the master key; not stored.">
            <Textarea id="import-mnemonic" value={mnemonic} onChange={(e) => setMnemonic(e.target.value)} className="min-h-[72px] font-mono" spellCheck={false} autoComplete="off" />
          </Field>
        </>
      )}
      {alreadyStored ? (
        <div className="rounded-md border border-anvil-200 px-3 py-2 text-dense dark:border-anvil-800">
          This device already holds a key for this identity.{' '}
          <button type="button" className="text-forge-600 underline dark:text-forge-400" onClick={() => onStored(who)}>
            Unlock it instead
          </button>{' '}
          or continue to replace it (the old key is disabled in the same update).
        </div>
      ) : null}
      {fields}
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
        Registers a key that can spend at most {BROWSER_KEY_DEFAULTS.budgetDash} DASH, only on Forge, for {BROWSER_KEY_DEFAULTS.days} days (~0.0005 DASH, one master-key signature).
      </p>
      <Button variant="primary" className="w-full" onClick={submit} loading={isLoading} disabled={!ready}>
        Create this browser&apos;s key
      </Button>
      {problem && (fileChosen || mnemonic !== '') ? <p className="text-[12px] text-anvil-500">{problem}</p> : null}
      <ErrorBox error={error} />
    </div>
  )
}

/** Networks without forge-v2 (testnet): an identity file's HIGH/CRITICAL key, this tab only. */
function V1FileView({ onDone }: { onDone: () => void }): JSX.Element {
  const { loginWithRawKey, isLoading, controller } = useAuth()
  const [error, setError] = useState<string | null>(null)
  const onFile = async (file: File): Promise<void> => {
    setError(null)
    try {
      const parsed = parseIdentityFileText(await file.text())
      controller.checkFileNetwork(parsed.networkKey)
      await loginWithRawKey(parsed.identityId, parsed.signingKeyWif)
      onDone()
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return (
    <div className="space-y-3">
      <FilePicker label="Choose an identity file" onFile={(f) => void onFile(f)} disabled={isLoading} />
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
        {ACTIVE_NETWORK.key} has no Forge contract group yet, so there are no limited keys here: the file&apos;s signing key is held in this tab and forgotten on reload.
      </p>
      <ErrorBox error={error} />
    </div>
  )
}

function AdvancedView({ onDone }: { onDone: () => void }): JSX.Element {
  const { loginWithRawKey, isLoading } = useAuth()
  const [identityId, setIdentityId] = useState('')
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = async (): Promise<void> => {
    if (isLoading) return
    setError(null)
    try {
      await loginWithRawKey(identityId, key)
      setKey('')
      onDone()
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return (
    <div className="space-y-3">
      <div role="note" className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-dense text-danger">
        A pasted key has no limits Forge set: anything it can sign, this tab can sign. Never paste a master key. Prefer importing
        your identity once so Forge gets a limited key instead.
      </div>
      <Field label="Identity ID" htmlFor="adv-id">
        <Input id="adv-id" value={identityId} onChange={(e) => setIdentityId(e.target.value)} className="font-mono" spellCheck={false} autoComplete="off" />
      </Field>
      <Field label="Private key (WIF or hex)" htmlFor="adv-key" hint="HIGH or CRITICAL authentication key. Held in this tab only.">
        <Input id="adv-key" type="password" value={key} onChange={(e) => setKey(e.target.value)} className="font-mono" spellCheck={false} autoComplete="off" />
      </Field>
      <Button variant="danger" className="w-full" onClick={submit} loading={isLoading} disabled={identityId.trim() === '' || key.trim() === '' || isLoading}>
        Sign in for this tab
      </Button>
      <ErrorBox error={error} />
    </div>
  )
}
