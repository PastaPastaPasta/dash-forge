'use client'

/**
 * The sign-in sheet (`ux-dx-spec.md` §2.2). Three tiles plus an Advanced disclosure:
 *
 *   1. Use my Dash wallet — the DashConnect key exchange (shown only when a response contract
 *      exists here; first only where Dash Wallet answers, i.e. testnet, else last);
 *   2. Create a new identity — mnemonic + backup quiz + deposit QR, registered with a limited
 *      key inside the IdentityCreate;
 *   3. Import an identity file (or mnemonic) — the master key signs one IdentityUpdate that
 *      registers a limited key for this browser, and is not stored;
 *   Advanced: paste a raw key (developer path; this tab only; red warning).
 *
 * When this device already holds an encrypted key, the sheet opens on "Unlock" instead
 * (callers can open it on a view directly: Renew opens Import). On a network without forge-v2
 * (no contract group to bind a key to) there is nothing to sign for: Import shows "not
 * deployed".
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Fingerprint, KeyRound, Lock, Plus, RotateCw, Upload, Wallet } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore, type LoginView } from '@/hooks/use-ui-store'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/input'
import { ErrorBox, GroupNotice, useProtection } from '@/components/auth/protection-fields'
import { CreateIdentityFlow } from '@/components/auth/create-identity-flow'
import { WalletConnectFlow } from '@/components/auth/wallet-connect-flow'
import { StepFailed } from '@/components/auth/step-status'
import { forgetConfirm } from '@/components/keys-panel'
import { otherIdentityFileMessage } from '@/lib/auth/controller'
import { useConfirmAction } from '@/components/ui/confirm-action'
import { ACTIVE_NETWORK, networkName } from '@/lib/constants'
import { GRANT_COPY } from '@/lib/auth/key-registration'
import { NotDeployedState } from '@/components/ui/network-badge'
import { BROWSER_KEY_DEFAULTS, masterMaterialFromFile } from '@/lib/auth'
import { AlreadyStoredError, UnlockNeededError } from '@/lib/auth/controller'
import { UnlockMore } from '@/components/auth/unlock-more'
import { Spinner } from '@/components/ui/states'
import { walletLoginAvailable, walletSignInSupported } from '@/lib/auth/app-connect'
import { ENCRYPTION_KEY_BLAST_RADIUS } from '@/lib/auth/encryption-key'
import { lockedIdentityOf } from '@/lib/auth/last-identity'
import { readCreationJournal } from '@/lib/auth/create-identity'
import { PLATFORM_READ_MS, connectPlatform } from '@/lib/auth/connect'
import { withTimeout } from '@/lib/timeout'
import { KEY_ADD_FLOOR_CREDITS, KEY_REGISTER_CREDITS, KEY_RENEW_CREDITS, pushCostPhrase, typicalIssueCredits } from '@/lib/sdk'
import { writesPausedReason } from '@/lib/devnet-notice'
import { creditsAsDash, formatDate } from '@/lib/view/format'
import { cn, errorMessage, shortId } from '@/lib/utils'

type View = 'choose' | 'unlock' | 'advanced' | LoginView

export function LoginModal(): JSX.Element {
  const open = useUiStore((s) => s.loginOpen)
  const requested = useUiStore((s) => s.loginView)
  // The contract the grant view asks the wallet for, as the opener named it (captured in the
  // store when the sheet opened, so a grant landing mid-flow does not switch the target)
  const grantKind = useUiStore((s) => s.loginGrantFor) ?? 'collab'
  const grantFor = ACTIVE_NETWORK.v2?.[grantKind]
  const grantTitle = GRANT_COPY[grantKind].title
  const intent = useUiStore((s) => s.loginIntent)
  const close = useUiStore((s) => s.closeLogin)
  const { vaults, vaultsLoaded, vaultsError, reloadVaults, limitedKeys } = useAuth()
  const [view, setView] = useState<View | null>(null)
  const [unlockFor, setUnlockFor] = useState<string | null>(null)
  const hasVault = vaults.length > 0

  // Pick the view when the sheet opens: once the stored-key list has been read, so a returning
  // user lands on Unlock without the tile list flashing first (L-29). If a key shows up later
  // (another tab stored one), move from the untouched tile list to Unlock — never away from a
  // flow the user already started.
  const opened = useRef<{ hasVault: boolean } | null>(null)
  useEffect(() => {
    if (!open) {
      opened.current = null
      setView(null)
      return
    }
    if (opened.current === null) {
      if (requested === null && !vaultsLoaded && !vaultsError) return
      // Read the stored keys again (another tab may have added one), unless storage failed:
      // then the sheet's Try again does it.
      if (!vaultsError) reloadVaults()
      opened.current = { hasVault }
      setView(requested ?? (hasVault ? 'unlock' : 'choose'))
      setUnlockFor(null)
      return
    }
    if (!opened.current.hasVault && hasVault && requested === null) {
      opened.current = { hasVault }
      setView((v) => (v === 'choose' ? 'unlock' : v))
    }
  }, [open, requested, hasVault, vaultsLoaded, vaultsError, reloadVaults])

  // The last stored key was forgotten from the Unlock view: nothing is left to unlock, so the
  // sheet offers the ways to sign in (QW2-027), not "Unlock the key this browser already holds".
  useEffect(() => {
    if (open && view === 'unlock' && vaultsLoaded && !vaultsError && !hasVault) setView('choose')
  }, [open, view, vaultsLoaded, vaultsError, hasVault])

  const back = view === null || view === 'choose' || view === 'unlock' || view === 'grant' || view === 'renew' ? null : () => setView('choose')
  // Before the stored-key list is read (a few ms, or storage blocked): the Unlock line, the
  // likelier view for someone opening the sheet on a device that holds a key.
  const description = view === null ? 'Checking this browser for a stored key…' : describeView(view, limitedKeys)
  // A write asked for the sheet: say which, and what it costs once signed in (L-62).
  // Creating an identity is sign-up, and says so on every step (QW4-022), as GitHub's "Create your account" does.
  const title =
    view === 'grant' ? grantTitle : view === 'renew' ? "Renew this browser's key" : view === 'create' ? 'Create your identity' : intent ? `Sign in to ${intent.action}` : 'Sign in to Dash Forge'

  return (
    <Dialog open={open} onClose={close} title={title} description={description} className="max-w-lg">
      {intent && view !== 'grant' ? (
        <p data-testid="signin-intent" className="mb-3 rounded-md bg-anvil-100 px-3 py-2 text-dense text-anvil-700 dark:bg-anvil-800 dark:text-anvil-200">
          {intent.privateRepo
            ? 'Private repos are encrypted for their members. Import your identity with "Enable private repos" ticked: this browser then keeps your encryption key and opens the private repos you are a member of. Reading costs nothing.'
            : intent.credits !== undefined
              ? `Once you're signed in, this costs at most about ${creditsAsDash(intent.credits)} DASH, paid from your identity's balance (often less: the exact price shows before you confirm).`
              : "Once you're signed in, you see what it costs and confirm before anything is signed."}
        </p>
      ) : null}
      {vaultsError && (view === null || view === 'choose' || view === 'unlock') ? (
        <div className="mb-3">
          <StepFailed error={`Couldn't read the keys stored in this browser: ${vaultsError}`} onRetry={reloadVaults} />
        </div>
      ) : null}
      {back ? (
        // A 44 px hit area on touch screens without drawing it bigger (QW4-042: 82×20 px).
        <button type="button" onClick={back} className="hit-area mb-3 inline-flex items-center gap-1 text-dense text-anvil-500 dark:text-anvil-400 hover:text-anvil-800 dark:hover:text-anvil-100">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> All options
        </button>
      ) : null}
      {view === null && !vaultsError ? <Spinner label="Checking this browser for a stored key" /> : null}
      {view === 'unlock' ? <UnlockView initial={unlockFor} onDone={close} onOther={() => setView('choose')} onRenew={() => setView('import')} /> : null}
      {view === 'choose' ? <ChooseView onPick={setView} /> : null}
      {view === 'import' || view === 'renew' ? (
        limitedKeys ? (
          <ImportView
            renew={view === 'renew'}
            onDone={close}
            onStored={(id) => {
              setUnlockFor(id)
              setView('unlock')
            }}
          />
        ) : (
          <NotDeployedState />
        )
      ) : null}
      {view === 'create' ? <CreateIdentityFlow onDone={close} /> : null}
      {view === 'wallet' ? <WalletConnectFlow onDone={close} /> : null}
      {view === 'grant' ? <WalletConnectFlow mode="grant" contractId={grantFor} onDone={close} /> : null}
      {view === 'advanced' ? <AdvancedView onDone={close} /> : null}
    </Dialog>
  )
}

/** The sheet's description line for a view. */
function describeView(view: View, limitedKeys: boolean): string {
  if (view === 'advanced') return 'A pasted key signs for this tab only, with whatever power it has.'
  if (view === 'wallet' || view === 'grant') return 'Your wallet sends this browser a key it derives for Dash Forge. Your recovery phrase and master key stay on the phone.'
  if (!limitedKeys) return `Dash Forge isn't available on ${networkName()} yet, so there's nothing to sign in to here.`
  const limits = `at most ${BROWSER_KEY_DEFAULTS.budgetDash} DASH, only on Forge, for ${BROWSER_KEY_DEFAULTS.days} days`
  if (view === 'renew') return `A new key for this browser (${limits}) replaces the current one, which is disabled in the same update.`
  if (view === 'create' || view === 'import') return `Forge signs with a limited key: ${limits}.`
  if (view === 'unlock') return 'Unlock the key this browser already holds.'
  // The tile list: a wallet's key comes with no limits (docs/design/wallet-login.md).
  return `A new or imported identity gives this browser a limited key: ${limits}.`
}

function Tile({
  icon: Icon,
  title,
  body,
  onClick,
  testId,
  muted = false,
  highlight = false,
  pausedReason = null,
}: {
  icon: typeof Wallet
  title: string
  body: string
  onClick: () => void
  testId: string
  /**
   * An option most people cannot use here: dashed, with a grey icon, still reachable (L-62).
   * Not faded: it is an enabled button, so its text keeps the 4.5:1 contrast (QW4-041: the
   * opacity took its helper text to 3.36:1).
   */
  muted?: boolean
  /** Something this browser has in progress: outlined in the accent colour. */
  highlight?: boolean
  /** Why this option cannot be used now (the devnet is moving): disabled, with the reason as its text. */
  pausedReason?: string | null
}): JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      data-muted={muted || undefined}
      disabled={pausedReason !== null}
      onClick={onClick}
      className={cn(
        'disabled:pointer-events-none disabled:opacity-60',
        'flex w-full items-start gap-3 rounded-lg border border-anvil-200 px-3 py-3 text-left transition-colors hover:border-forge-400 hover:bg-anvil-50 dark:border-anvil-750 dark:hover:bg-anvil-850',
        muted && 'border-dashed',
        highlight && 'border-forge-500/60 bg-forge-500/5 dark:border-forge-500/50',
      )}
    >
      <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', muted ? 'text-anvil-500 dark:text-anvil-400' : 'text-forge-500')} aria-hidden />
      <span>
        <span className="block text-dense font-medium text-anvil-900 dark:text-anvil-50">{title}</span>
        <span className="block text-[12px] text-anvil-500 dark:text-anvil-400">{pausedReason ?? body}</span>
      </span>
    </button>
  )
}

function ChooseView({ onPick }: { onPick: (v: View) => void }): JSX.Element {
  const { limitedKeys } = useAuth()
  const closeLogin = useUiStore((s) => s.closeLogin)
  const walletAvailable = useWalletAvailability(limitedKeys)
  const [advanced, setAdvanced] = useState(false)
  const creating = useCreationInProgress()
  // While the devnet is moving, creating or importing an identity would be wiped with it.
  const pausedReason = writesPausedReason()
  // No forge-v2 here means no contract group to bind a key to: nothing to sign in to.
  if (!limitedKeys) return <NotDeployedState />
  // First only where Dash Wallet can answer (testnet); elsewhere last, saying why.
  const walletFirst = walletSignInSupported(ACTIVE_NETWORK.network)
  const walletTile = walletAvailable ? (
    <Tile
      testId="tile-wallet"
      icon={Wallet}
      title="Use my Dash wallet"
      body={
        walletFirst
          ? 'DashPay (Dash Wallet) on your phone: scan a QR code (or tap a link on the phone) and approve.'
          : ACTIVE_NETWORK.network === 'devnet'
            ? `Internal iOS builds only on ${ACTIVE_NETWORK.key}: released Dash Wallet apps can't answer here yet (DashConnect is testnet-only).`
            : `Not on ${ACTIVE_NETWORK.key} yet: Dash Wallet's DashConnect works on testnet only.`
      }
      muted={!walletFirst}
      onClick={() => onPick('wallet')}
    />
  ) : null
  return (
    <div className="space-y-2">
      {creating !== null ? (
        <Tile
          testId="tile-create-resume"
          icon={RotateCw}
          title="Finish creating your identity"
          body={
            creating.funded
              ? 'Started in this browser, and its deposit has arrived: type your 12 words to finish registering it. Do not send another deposit.'
              : `Started in this browser: fund deposit address ${creating.address.slice(0, 10)}… and type your 12 words to continue.`
          }
          onClick={() => onPick('create')}
          highlight
          pausedReason={pausedReason}
        />
      ) : null}
      {walletFirst ? walletTile : null}
      <Tile testId="tile-create" icon={Plus} title="Create a new identity" body={`12 words you write down, then fund it from any Dash wallet. About ${creditsAsDash(typicalIssueCredits())} DASH per issue, ${pushCostPhrase()}.`} onClick={() => onPick('create')} pausedReason={pausedReason} />
      <Tile
        testId="tile-import"
        icon={Upload}
        title="Import an identity file or recovery phrase"
        body="Your master key is used once, right now, to create a limited key for this browser. It is not stored."
        onClick={() => onPick('import')}
        pausedReason={pausedReason}
      />
      {walletFirst ? null : walletTile}
      <div className="pt-2">
        <button type="button" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)} className="hit-area text-[12px] text-anvil-500 dark:text-anvil-400 underline hover:text-anvil-800 dark:hover:text-anvil-100">
          Advanced
        </button>
        {advanced ? (
          <div className="mt-2">
            <Tile testId="tile-advanced" icon={KeyRound} title="Paste a private key" body="Developer path. The key is held in this tab only and is lost on reload." onClick={() => onPick('advanced')} />
          </div>
        ) : null}
      </div>
      {/* New to Dash (QW-013): what an identity, credits and test DASH are, before choosing a tile. */}
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
        New to Dash Forge?{' '}
        <Link href="/start/" onClick={closeLogin} className="hit-area text-forge-700 underline dark:text-forge-400" data-testid="signin-docs">
          How identities, keys and credits work
        </Link>
      </p>
    </div>
  )
}

/**
 * The deposit address of an identity creation this browser started and did not finish (its
 * journal), or null: the chooser offers to finish it first (QW2-030).
 */
function useCreationInProgress(): { readonly address: string; readonly funded: boolean } | null {
  const [state, setState] = useState<{ readonly address: string; readonly funded: boolean } | null>(null)
  useEffect(() => {
    let cancelled = false
    readCreationJournal(ACTIVE_NETWORK.network).then(
      // Funded once the deposit was locked (or the identity exists): only the words are missing.
      (j) => !cancelled && setState(j ? { address: j.depositAddress, funded: j.lockTxid != null || j.lockRaw != null || j.identityId != null } : null),
      () => undefined,
    )
    return () => {
      cancelled = true
    }
  }, [])
  return state
}

/**
 * Whether the wallet tile applies here (a wallet login contract exists on this network). When
 * Platform cannot be reached to check, the tile shows anyway: the flow behind it names what
 * failed and offers "Try again", where hiding it would fail silently.
 */
function useWalletAvailability(limitedKeys: boolean): boolean {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    if (!limitedKeys) return
    let cancelled = false
    connectPlatform(ACTIVE_NETWORK.network)
      .then((sdk) => withTimeout(walletLoginAvailable(sdk, ACTIVE_NETWORK.key), PLATFORM_READ_MS, 'Finding the wallet login contract'))
      .then(
        (ok) => !cancelled && setAvailable(ok),
        () => !cancelled && setAvailable(true),
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
        {detail ? <span className="font-mono text-[12px] text-anvil-500 dark:text-anvil-400">{detail}</span> : null}
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
  const { vaults, unlock, forget, isLoading, step, lastIdentity } = useAuth()
  const [confirm, confirmDialog] = useConfirmAction()
  // The identity asked for, else the one signed in last (QW2-025), as an account switcher does.
  const [pick, setPick] = useState(() => Math.max(0, vaults.findIndex((v) => v.identityId === (initial ?? lockedIdentityOf(vaults, lastIdentity)))))
  const [passphrase, setPassphrase] = useState('')
  const passphraseRef = useRef<HTMLInputElement>(null)
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
        <Lock className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden />
        This browser holds a key for{' '}
        {vaults.length > 1 ? (
          <select
            aria-label="Identity"
            value={pick}
            onChange={(e) => {
              setPick(Number(e.target.value))
              // Another key: its passphrase starts empty, in the field (if it stays mounted) and
              // in state (if it unmounts for a passkey-only key and comes back empty).
              if (passphraseRef.current) passphraseRef.current.value = ''
              setPassphrase('')
            }}
            className="rounded border border-anvil-300 bg-transparent px-1 font-mono coarse:h-11 coarse:text-base dark:border-anvil-700"
          >
            {vaults.map((x, i) => (
              <option key={x.identityId} value={i}>
                {shortId(x.identityId)}
              </option>
            ))}
          </select>
        ) : (
          <span className="font-mono">{shortId(v.identityId)}</span>
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
            <Input id="unlock-passphrase" ref={passphraseRef} type="password" autoComplete="current-password" onChange={(e) => setPassphrase(e.target.value)} autoFocus />
          </Field>
          <Button type="submit" variant={v.methods.includes('passkey') ? 'outline' : 'primary'} className="w-full" loading={isLoading} disabled={passphrase === '' || isLoading}>
            Unlock
          </Button>
        </form>
      ) : null}
      {/* Why a second passkey prompt follows, when one does (an unfinished renewal, D-016). */}
      {isLoading && step ? (
        <p role="status" className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="unlock-step">
          {step}
        </p>
      ) : null}
      <ErrorBox error={error} />
      {expired ? (
        <Button variant="outline" className="w-full" onClick={onRenew}>
          Renew this browser&apos;s key
        </Button>
      ) : null}
      {/* The recovery route (like "Forgot password?"): the identity file or recovery phrase
          registers a new key for this browser and disables the one it cannot open. */}
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="unlock-forgot">
        {v.methods.includes('passphrase') ? 'Forgot the passphrase' : 'Lost the passkey'}?{' '}
        <button type="button" onClick={onRenew} className="hit-area text-forge-700 underline dark:text-forge-400">
          Replace this key with your recovery phrase or identity file
        </button>
      </p>
      <div className="flex justify-between pt-1 text-[12px]">
        <button type="button" onClick={onOther} className="hit-area text-anvil-500 dark:text-anvil-400 underline">
          Other sign-in options
        </button>
        <button
          type="button"
          onClick={() => {
            void forgetConfirm(v.identityId)
              .then(confirm)
              .then((ok) => {
                if (ok) forget(v.identityId).then(() => setPick(0), (e: unknown) => setError(errorMessage(e)))
              })
          }}
          className="hit-area text-danger-700 dark:text-danger-400 underline"
        >
          Forget this key
        </button>
      </div>
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
        Stored {formatDate(v.createdAt)} · key #{v.keyId}
      </p>
      {confirmDialog}
    </div>
  )
}

function ImportView({ onDone, onStored, renew = false }: { onDone: () => void; onStored: (identityId: string) => void; renew?: boolean }): JSX.Element {
  const { importIdentity, isLoading, step, vaults, identity, controller, unlockScope, storage, keyId } = useAuth()
  const wantsPrivate = useUiStore((s) => s.loginIntent?.privateRepo === true)
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
  // A file that was not an identity file: named on the picker, so the error beside it is about it.
  const [badFile, setBadFile] = useState('')
  const [fileIdentity, setFileIdentity] = useState('')
  const [mnemonic, setMnemonic] = useState('')
  // The words live in the textarea's value property only (never a DOM attribute or text): the
  // field mounts empty (a tab switch), so the state does too; it is wiped as it detaches.
  const mnemonicRef = useRef<HTMLTextAreaElement | null>(null)
  const bindMnemonic = useCallback((el: HTMLTextAreaElement | null) => {
    if (el === null && mnemonicRef.current) mnemonicRef.current.value = ''
    else if (el !== null) setMnemonic('')
    mnemonicRef.current = el
  }, [])
  // A renewal is of the signed-in identity's key: its words are checked against it (QW3-031).
  const [identityId, setIdentityId] = useState(renew && identity !== null ? identity : '')
  const [error, setError] = useState<string | null>(null)
  // Errors show beside the button that caused them, scrolled into view: in a tall sheet the
  // button can sit at the bottom edge of a phone (or a 800 px laptop) screen.
  const errorRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (error !== null) errorRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [error])
  // Enter in a passphrase field submits (QW3-027); `submit` is declared below, so through a ref.
  const submitRef = useRef<() => void>(() => undefined)
  const { fields, protection, problem } = useProtection({ onSubmit: () => submitRef.current() })
  // Opt-in (`ux-dx-spec.md` §2.3): also keep the identity's encryption key, for private repos.
  const [enablePrivate, setEnablePrivate] = useState(wantsPrivate)
  // The identity the words found, which this browser already holds a key for: filled into the ID
  // field, and cleared with it when the words change (other words, another identity).
  const [foundId, setFoundId] = useState<string | null>(null)
  const foundStored = foundId !== null && identityId === foundId
  // A renewal is of the signed-in identity, whatever is chosen (another file is refused below).
  const who = renew && identity !== null ? identity : mode === 'file' ? fileIdentity : identityId.trim()
  const previous = who === '' ? undefined : vaults.find((v) => v.identityId === who)
  // Only a staged key (a sign-in that did not finish, D-016): it may never have reached Platform,
  // so it is no key to "replace" or to disable (QW3-007).
  const unfinished = previous?.staged === true
  // Offer Unlock for a key this device already holds, unless this is a renewal of the
  // signed-in identity (then the old key is disabled in the same update).
  const alreadyStored = previous !== undefined && !unfinished && who !== identity
  // A key this device holds for the identity is replaced (renew), which costs less than a new one.
  const renewing = previous !== undefined && !unfinished
  // A renewal from Settings with another identity's file: refused before anything is signed.
  const otherFile = renew && identity !== null && mode === 'file' && fileIdentity !== '' && fileIdentity !== identity
  // Replacing a key this tab has not unlocked drops what was sealed with it: its encryption key
  // for private repos goes unless this import brings it again (QW-052). Ticked by default then.
  // (A pasted-key session is "full" too, but it is not the vault: the vault stays locked.)
  const dropsEncryption = previous?.encryptionKey === true && !(who === identity && storage === 'vault' && unlockScope === 'full')
  // The default follows it both ways: another identity (or mode) does not inherit the tick,
  // which stores an encryption key only where the user chose to.
  // Opened to read a private repo: ticked too (QW2-016).
  useEffect(() => {
    setEnablePrivate(dropsEncryption || wantsPrivate)
  }, [dropsEncryption, wantsPrivate])
  // The renewal of a tab that holds the encryption key carries it to the new key by itself: no
  // choice to offer (QW3-031: "Enable private repos" showed unticked although key 4 was kept).
  const carriesEncryption = previous?.encryptionKey === true && !dropsEncryption && who === identity

  const onFile = async (file: File): Promise<void> => {
    setError(null)
    let text: string
    try {
      text = await file.text()
      const material = masterMaterialFromFile(text)
      // Refused as it is picked, not on submit (QW2-031): a file for another network.
      controller.checkFileNetwork(material.networkKey)
      setFileIdentity(material.identityId)
    } catch (e) {
      fileRef.current = null
      setFileChosen(false)
      setFileIdentity('')
      setFileName('')
      setBadFile(file.name)
      setError(errorMessage(e))
      return
    }
    fileRef.current = text
    setFileChosen(true)
    setFileName(file.name)
    setBadFile('')
  }

  const ready = protection !== null && !isLoading && !otherFile && (mode === 'file' ? fileChosen : mnemonic.trim() !== '')
  const submit = async (): Promise<void> => {
    if (!protection || isLoading || otherFile) return
    setError(null)
    try {
      const text = fileRef.current
      if (mode === 'file' && text === null) return
      await importIdentity(mode === 'file' ? { fileText: text as string } : { mnemonic, identityId }, protection, undefined, {
        enablePrivateRepos: enablePrivate && !carriesEncryption,
        // Signed in as the identity being imported: this is a renewal of its key.
        renew: identity !== null,
      })
      fileRef.current = null
      if (mnemonicRef.current) mnemonicRef.current.value = ''
      setMnemonic('')
      onDone()
    } catch (e) {
      // Found from the words, and already held here: fill in the identity, so the sheet offers
      // what a typed ID offers — unlock the stored key, or replace it (the way back from a
      // forgotten passphrase, QW-010). Nothing was signed.
      if (e instanceof AlreadyStoredError) {
        setIdentityId(e.identityId)
        setFoundId(e.identityId)
        return
      }
      // A reloaded tab holds the signing key only: a renewal must carry over (or disable) every
      // key and setting this vault holds, so unlock it here first, then carry on.
      if (e instanceof UnlockNeededError) {
        setUnlockFirst(true)
        return
      }
      setError(errorMessage(e))
    }
  }
  const [unlockFirst, setUnlockFirst] = useState(false)
  submitRef.current = () => {
    if (ready) void submit()
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
            className={cn('rounded px-3 py-1.5 text-dense font-medium', mode === m ? 'bg-forge-500/15 text-forge-800 dark:text-forge-400' : 'text-anvil-500 dark:text-anvil-400')}
          >
            {m === 'file' ? 'Identity file' : 'Recovery phrase'}
          </button>
        ))}
      </div>
      {mode === 'file' ? (
        <FilePicker
          label={fileName || (badFile ? 'Choose another file' : 'Choose an identity file (.json)')}
          detail={fileIdentity || (badFile ? `${badFile}: not usable (see below)` : undefined)}
          onFile={(f) => void onFile(f)}
        />
      ) : (
        <>
          <Field label="Recovery phrase (12 or 24 words)" htmlFor="import-mnemonic" hint="Used once to derive the master key; not stored.">
            {/* Uncontrolled: a controlled textarea's value is also its DOM text content. */}
            <Textarea
              id="import-mnemonic"
              ref={bindMnemonic}
              onChange={(e) => {
                setMnemonic(e.target.value)
                // Other words: the identity found from the last ones no longer applies.
                if (foundId !== null && identityId === foundId) setIdentityId('')
                setFoundId(null)
              }}
              className="min-h-[72px] font-mono"
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
          <Field
            label={renew ? 'Identity ID' : 'Identity ID (optional)'}
            htmlFor="import-id"
            hint={
              renew
                ? 'The identity signed in here: the words are checked against it.'
                : 'Leave empty: Forge finds the identity these words created. Enter it to check the words against a known identity.'
            }
          >
            <Input
              id="import-id"
              value={identityId}
              readOnly={renew && identity !== null}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  submitRef.current()
                }
              }}
              onChange={(e) => {
                setIdentityId(e.target.value)
                setFoundId(null)
              }}
              className="font-mono"
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
        </>
      )}
      {otherFile ? (
        <p role="alert" data-testid="import-other-file" className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger-700 dark:text-danger-400">
          {otherIdentityFileMessage(fileIdentity, identity as string, fileName)}
        </p>
      ) : null}
      {unfinished ? (
        <div data-testid="import-unfinished" className="rounded-md border border-anvil-200 px-3 py-2 text-dense dark:border-anvil-800">
          An earlier sign-in for this identity on this device did not finish; its key may never have reached Platform.{' '}
          <button type="button" className="text-forge-700 underline dark:text-forge-400" onClick={() => onStored(who)}>
            Unlock it
          </button>{' '}
          with the passphrase you chose then to finish it, or carry on to register a new key (a key that did reach Platform asks you to unlock first).
        </div>
      ) : null}
      {alreadyStored ? (
        <div role={foundStored ? 'status' : undefined} data-testid="import-already-stored" className="rounded-md border border-anvil-200 px-3 py-2 text-dense dark:border-anvil-800">
          {foundStored ? 'These words belong to an identity this browser already holds a key for (its ID is filled in above). ' : 'This device already holds a key for this identity. '}
          <button type="button" className="text-forge-700 underline dark:text-forge-400" onClick={() => onStored(who)}>
            Unlock it instead
          </button>{' '}
          or replace it: forgot its passphrase? Replacing registers a new key for this browser, and the old one is disabled in the same update.
        </div>
      ) : null}
      {fields}
      {carriesEncryption ? (
        <p className="rounded-md border border-anvil-200 p-3 text-dense dark:border-anvil-800" data-testid="import-carries-encryption">
          <span className="font-medium">Private repos stay enabled.</span>{' '}
          <span className="text-anvil-600 dark:text-anvil-300">The encryption key this browser holds moves to the new key.</span>
        </p>
      ) : (
      <label className="flex items-start gap-2 rounded-md border border-anvil-200 p-3 text-dense dark:border-anvil-800">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={enablePrivate}
          onChange={(e) => setEnablePrivate(e.target.checked)}
          data-testid="enable-private-repos"
        />
        <span>
          <span className="font-medium">Enable private repos</span>
          <span className="block text-[12px] text-anvil-500 dark:text-anvil-400">
            Also keep this identity&apos;s encryption key here, protected the same way. {ENCRYPTION_KEY_BLAST_RADIUS}
          </span>
          {dropsEncryption ? (
            <span className={cn('mt-1 block text-[12px]', enablePrivate ? 'text-anvil-600 dark:text-anvil-300' : 'text-caution-700 dark:text-caution-400')} data-testid="import-keeps-encryption">
              {enablePrivate
                ? 'This browser already holds your encryption key, sealed with the key being replaced: this brings it over again.'
                : 'Unticked, the encryption key this browser holds for private repos is removed with the old key. Add it again later in Settings.'}
            </span>
          ) : null}
        </span>
      </label>
      )}
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
        {renew && keyId !== null ? `Disables key #${keyId} and registers` : 'Registers'} a key that can spend at most {BROWSER_KEY_DEFAULTS.budgetDash} DASH, only on Forge, for {BROWSER_KEY_DEFAULTS.days} days
        {renewing
          ? ` (renewing: ~${creditsAsDash(KEY_RENEW_CREDITS)} DASH, one master-key signature; the old key is disabled in the same update).`
          : // Platform meters the update: an identity that already holds a Forge key (from another
            // browser or dg) pays the lower figure (QW-043). Its floor is the least one was measured to
            // cost, the low end Settings → Spend shows too (QW3-037: 0.00028 quoted, 0.000269 charged).
            ` (${creditsAsDash(KEY_ADD_FLOOR_CREDITS)}–${creditsAsDash(KEY_REGISTER_CREDITS)} DASH, one master-key signature; up to ${creditsAsDash(KEY_RENEW_CREDITS)} when the identity already has a Forge key).`}
      </p>
      {controller.supportsLimitedKeys() ? <GroupNotice check={() => controller.checkGroup()} /> : null}
      <div ref={errorRef} hidden={error === null}>
        <ErrorBox error={error} className="mt-0" />
      </div>
      <Button variant="primary" className="w-full" onClick={submit} loading={isLoading} disabled={!ready}>
        {isLoading && step ? `${step}…` : renew ? <>Renew this browser&apos;s key</> : alreadyStored ? <>Replace this browser&apos;s key</> : <>Create this browser&apos;s key</>}
      </Button>
      {problem && (fileChosen || mnemonic !== '') ? <p className="text-[12px] text-anvil-500 dark:text-anvil-400">{problem}</p> : null}
      {unlockFirst ? (
        <UnlockMore
          forgot={false}
          title="Unlock this tab to renew its key"
          testId="renew-unlock"
          then={() => {
            setUnlockFirst(false)
            void submit()
          }}
        />
      ) : null}
    </div>
  )
}

function AdvancedView({ onDone }: { onDone: () => void }): JSX.Element {
  const { loginWithRawKey, isLoading } = useAuth()
  const [identityId, setIdentityId] = useState('')
  // The pasted key lives only in the input's value property (an uncontrolled input): React
  // mirrors a controlled input's value into the `value` attribute, which put the key in the
  // DOM (and in Chrome's console warnings that print the element).
  const keyRef = useRef<HTMLInputElement | null>(null)
  const [hasKey, setHasKey] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const clearKey = (): void => {
    if (keyRef.current) keyRef.current.value = ''
    setHasKey(false)
  }
  // Wipe the field as React detaches it (a cleanup effect runs too late: the ref is null).
  const bindKey = useCallback((el: HTMLInputElement | null) => {
    if (el === null && keyRef.current) keyRef.current.value = ''
    keyRef.current = el
  }, [])
  const submit = async (): Promise<void> => {
    const key = keyRef.current?.value ?? ''
    if (isLoading || key.trim() === '') return
    setError(null)
    try {
      await loginWithRawKey(identityId, key)
      clearKey()
      onDone()
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div role="note" className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-dense text-danger-700 dark:text-danger-400">
        A pasted key has no limits Forge set: anything it can sign, this tab can sign. Never paste a master key. Prefer importing
        your identity once so Forge gets a limited key instead.
      </div>
      <Field label="Identity ID" htmlFor="adv-id">
        <Input id="adv-id" value={identityId} onChange={(e) => setIdentityId(e.target.value)} className="font-mono" spellCheck={false} autoComplete="off" />
      </Field>
      <Field label="Private key (WIF or hex)" htmlFor="adv-key" hint="HIGH or CRITICAL authentication key. Held in this tab only.">
        <Input id="adv-key" ref={bindKey} type="password" onChange={(e) => setHasKey(e.target.value.trim() !== '')} className="font-mono" spellCheck={false} autoComplete="off" />
      </Field>
      <Button type="submit" variant="danger" className="w-full" loading={isLoading} disabled={identityId.trim() === '' || !hasKey || isLoading}>
        Sign in for this tab
      </Button>
      <ErrorBox error={error} />
    </form>
  )
}
