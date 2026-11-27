'use client'

/**
 * The sign-in sheet (`ux-dx-spec.md` §2.2), in two groups plus an Advanced disclosure and a
 * plain-English glossary (F3, 2026-11 new-user pass):
 *
 *   New to Dash: Create a new identity, badged Recommended — mnemonic + backup quiz + deposit
 *      QR, registered with a limited key inside the IdentityCreate. It ends on a "You're in"
 *      view with next steps and a check for a second payment left on the deposit address (F13, F14).
 *      On mainnet, where the wallet leads, a "Get DashPay" link under the wallet tile opens the
 *      install step (store links, then create a username in the app), whose button leads on to the
 *      wallet's code; the in-page create sits under Advanced.
 *   Already have one: a passkey from another device; Import an identity file (or mnemonic) — the
 *      master key signs one IdentityUpdate that registers a limited key for this browser, and is
 *      not stored; dg; and Use my Dash wallet — App Connect v2 (one approval covers all of Forge,
 *      with a budget and an expiry), shown where the chain supports it. The wallet leads, recommended,
 *      where a released wallet can answer (`walletSignInReady`: mainnet or testnet, at a protocol
 *      released wallets read; `lib/auth/sign-in-methods.ts`); elsewhere it is last, saying why.
 *   Advanced: paste a raw key (developer path; this tab only; red warning).
 *
 * When this device already holds an encrypted key, the sheet opens on "Unlock" instead
 * (callers can open it on a view directly: Renew opens Import, or the wallet that granted the key
 * when it came from one; a key from the older wallet code opens "Replace", the wallet first). On a
 * network without forge-v2 (no contract group to bind a key to) there is nothing to sign for:
 * Import shows "not deployed".
 */

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowLeft, ChevronDown, Compass, CopyPlus, Fingerprint, HelpCircle, KeyRound, Lock, Plus, RotateCw, Smartphone, SquareTerminal, Upload, Wallet } from 'lucide-react'
import { creditsToDash } from '@/lib/sdk/cost'
import { PushCostText } from '@/components/ui/push-cost-text'
import { FiatNote } from '@/components/ui/fiat-note'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore, type LoginView } from '@/hooks/use-ui-store'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/input'
import { ErrorBox, GroupNotice, useProtection } from '@/components/auth/protection-fields'
import { CreateIdentityFlow, type CreatedIdentity } from '@/components/auth/create-identity-flow'
import { TestCreditsBadge, isTestNetwork } from '@/components/ui/test-credits'
import { WalletConnectFlow } from '@/components/auth/wallet-connect-flow'
import { Tile } from '@/components/auth/sign-in-tile'
import { PasskeySignIn } from '@/components/auth/passkey-sign-in'
import { DgHandoffFlow, type HandoffTarget } from '@/components/auth/dg-handoff-flow'
import { KeyLifetimeSelect } from '@/components/auth/key-lifetime'
import { PhraseWarning } from '@/components/auth/phrase-warning'
import { StepFailed } from '@/components/auth/step-status'
import { forgetConfirm } from '@/components/keys-panel'
import { otherIdentityFileMessage } from '@/lib/auth/controller'
import { useConfirmAction } from '@/components/ui/confirm-action'
import { ACTIVE_NETWORK, networkName } from '@/lib/constants'
import { NotDeployedState } from '@/components/ui/network-badge'
import { BROWSER_KEY_DEFAULTS, lifetimeLabel, limitsFor, masterMaterialFromFile, type VaultInfo } from '@/lib/auth'
import { AlreadyStoredError, UnlockNeededError } from '@/lib/auth/controller'
import { UnlockMore } from '@/components/auth/unlock-more'
import { Spinner } from '@/components/ui/states'
import { signInMethods, walletLeads, type SignInGroup, type SignInMethod } from '@/lib/auth/sign-in-methods'
import { appConnectSupport } from '@/lib/auth/app-connect-v2'
import { ENCRYPTION_KEY_BLAST_RADIUS } from '@/lib/auth/encryption-key'
import { lockedIdentityOf } from '@/lib/auth/last-identity'
import { faucetUrls } from '@/lib/faucets'
import { depositBalance, readCreationJournal } from '@/lib/auth/create-identity'
import { PLATFORM_READ_MS, connectPlatform } from '@/lib/auth/connect'
import { withTimeout } from '@/lib/timeout'
import { KEY_ADD_FLOOR_CREDITS, KEY_REGISTER_CREDITS, KEY_RENEW_CREDITS, typicalIssueCredits } from '@/lib/sdk'
import { writesPausedReason } from '@/lib/devnet-notice'
import { creditsAsDash, formatDate } from '@/lib/view/format'
import { cn, errorMessage, shortId } from '@/lib/utils'
import type { UnlockMethod } from '@/lib/auth/vault'

type View = 'choose' | 'unlock' | 'advanced' | 'welcome' | 'get-dashpay' | LoginView

export function LoginModal(): JSX.Element {
  const open = useUiStore((s) => s.loginOpen)
  const requested = useUiStore((s) => s.loginView)
  const intent = useUiStore((s) => s.loginIntent)
  const close = useUiStore((s) => s.closeLogin)
  const { vaults, vaultsLoaded, vaultsError, reloadVaults, limitedKeys, origin } = useAuth()
  const [view, setView] = useState<View | null>(null)
  const [unlockFor, setUnlockFor] = useState<string | null>(null)
  // The locked key a dg handoff replaces (Unlock → "Replace this key with dg").
  const [dgReplace, setDgReplace] = useState<HandoffTarget | null>(null)
  // The identity this sheet just created: the "You're in" view's subject.
  const [created, setCreated] = useState<CreatedIdentity | null>(null)
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
      setCreated(null)
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
      setDgReplace(null)
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

  // A key this device already holds: unlock it instead.
  const toUnlock = (id: string): void => {
    setUnlockFor(id)
    setView('unlock')
  }
  const back = view === null || view === 'choose' || view === 'unlock' || view === 'renew' || view === 'wallet-renew' || view === 'wallet-replace' || view === 'welcome' ? null : () => setView('choose')
  // Before the stored-key list is read (a few ms, or storage blocked): the Unlock line, the
  // likelier view for someone opening the sheet on a device that holds a key.
  const description = view === null ? 'Checking this browser for a stored key…' : describeView(view, limitedKeys, origin !== 'app-connect')
  const title = titleFor(view, intent?.action)

  return (
    <Dialog open={open} onClose={close} title={title} description={description} className="max-w-lg">
      {intent && view !== 'welcome' ? (
        <p data-testid="signin-intent" className="mb-3 rounded-md bg-anvil-100 px-3 py-2 text-dense text-anvil-700 dark:bg-anvil-800 dark:text-anvil-200">
          {intent.privateRepo
            ? 'Private repos are encrypted for their members. Import your identity with "Read and write members-only and private content" ticked: this browser then keeps your encryption key and opens the private repos you are a member of. Reading costs nothing.'
            : intent.credits !== undefined
              ? <>Once you&apos;re signed in, this costs at most about {creditsAsDash(intent.credits)} DASH<FiatNote dash={creditsToDash(intent.credits)} kind="bound" />, paid from your identity&apos;s balance (often less: the exact price shows before you confirm).{isTestNetwork() ? <> On {networkName()} that is free test DASH.</> : null}</>
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
      {view === 'unlock' ? (
        <UnlockView
          initial={unlockFor}
          onDone={close}
          onOther={() => setView('choose')}
          onRenew={(v) => {
            // A key that came from dg is replaced with dg: the recovery phrase is not asked for.
            setDgReplace(v?.fromDg === true ? { identityId: v.identityId, keyId: v.keyId } : null)
            setView(v?.fromDg === true ? 'dg' : 'import')
          }}
        />
      ) : null}
      {view === 'choose' ? (
        <ChooseView
          onDone={close}
          onPick={(v) => {
            setDgReplace(null)
            setView(v)
          }}
        />
      ) : null}
      {view === 'import' || view === 'renew' ? (
        limitedKeys ? (
          view === 'renew' ? (
            <RenewView onDone={close} onStored={toUnlock} />
          ) : (
            <ImportView onDone={close} onStored={toUnlock} />
          )
        ) : (
          <NotDeployedState />
        )
      ) : null}
      {view === 'dg' ? limitedKeys ? <DgHandoffFlow onDone={close} {...(dgReplace !== null ? { target: dgReplace } : {})} /> : <NotDeployedState /> : null}
      {view === 'create' ? (
        <CreateIdentityFlow
          onDone={(c) => {
            setCreated(c)
            setView('welcome')
          }}
        />
      ) : null}
      {view === 'welcome' && created ? <WelcomeView created={created} onDone={close} /> : null}
      {view === 'get-dashpay' ? <GetDashPayView onHaveIt={() => setView('wallet')} /> : null}
      {view === 'wallet' ? <WalletConnectFlow onDone={close} onUnlock={() => setView('unlock')} onGetDashPay={ACTIVE_NETWORK.network === 'mainnet' ? () => setView('get-dashpay') : undefined} /> : null}
      {view === 'wallet-renew' || view === 'wallet-replace' ? (
        <>
          <WalletConnectFlow mode={view === 'wallet-renew' ? 'renew' : 'login'} onDone={close} onUnlock={() => setView('unlock')} />
          <div className={cn('mt-3 border-t border-anvil-200 pt-3 dark:border-anvil-800', ACTIVE_NETWORK.network === 'mainnet' && 'hidden')}>
            <button type="button" data-testid="renew-with-file-instead" onClick={() => setView('renew')} className="hit-area text-[12px] text-anvil-500 underline hover:text-anvil-800 dark:text-anvil-400 dark:hover:text-anvil-100">
              {view === 'wallet-renew' ? 'Renew with identity file or recovery phrase instead' : 'Use your identity file or recovery phrase instead'}
            </button>
          </div>
        </>
      ) : null}
      {view === 'advanced' ? <AdvancedView onDone={close} /> : null}
    </Dialog>
  )
}

/**
 * The sheet's title. A write asked for the sheet: say which (L-62). Creating an identity is
 * sign-up, and says so on every step (QW4-022), as GitHub's "Create your account" does.
 */
function titleFor(view: View | null, action: string | undefined): string {
  switch (view) {
    case 'wallet-replace':
      return "Replace this browser's key"
    case 'renew':
      return "Renew this browser's key"
    case 'wallet-renew':
      return "Renew this browser's key in your wallet"
    case 'create':
      return 'Create your identity'
    case 'welcome':
      return "You're in"
    case 'dg':
      return 'Sign in with dg'
    case 'get-dashpay':
      return 'Get DashPay'
    default:
      return action ? `Sign in to ${action}` : 'Sign in to Dash Forge'
  }
}

/** The sheet's description line for a view. */
function describeView(view: View, limitedKeys: boolean, notWalletGrant: boolean): ReactNode {
  if (view === 'welcome') return 'Your identity is registered and this browser is signed in. Pick a first step, or close this and look around.'
  if (view === 'advanced') return 'A pasted key signs for this tab only, with whatever power it has.'
  if (view === 'wallet' || view === 'get-dashpay') return null
  if (view === 'wallet-replace') {
    return "This browser's key came from your wallet's older code, with no spending limit or only part of Forge. One approval gives a limited key for all of Forge. The current key stays live until Revoke on Platform disables it."
  }
  if (view === 'wallet-renew') {
    // A key a passkey or the master key brought here is not this browser's own wallet grant: the
    // wallet adds a new one and leaves it.
    return notWalletGrant ? 'Your wallet adds a new key for this browser.' : 'Your wallet adds a new key for this browser and disables the current one.'
  }
  if (!limitedKeys) return `Dash Forge isn't available on ${networkName()} yet, so there's nothing to sign in to here.`
  const base = <>at most {BROWSER_KEY_DEFAULTS.budgetDash} DASH<FiatNote dash={BROWSER_KEY_DEFAULTS.budgetDash} kind="bound" />, only on Forge</>
  // Import, renew and dg offer a lifetime picker; creating an identity does not.
  const limits = <>{base}, for {BROWSER_KEY_DEFAULTS.days} days by default (up to a year)</>
  const fixedLimits = <>{base}, for {BROWSER_KEY_DEFAULTS.days} days; you can renew it for up to a year later</>
  if (view === 'renew') return <>A new key for this browser ({limits}) replaces the current one, which is disabled in the same update.</>
  if (view === 'dg') return <>dg registers a limited key for this browser ({limits}). Your recovery phrase stays out of the browser.</>
  if (view === 'import') return <>This browser gets its own Forge key: it can spend {limits}.</>
  if (view === 'create') return <>This browser gets its own Forge key: it can spend {fixedLimits}.</>
  if (view === 'unlock') return null
  // The tile list: one short line; the key's limits are under Other ways to sign in.
  return 'Your keys stay in your wallet or on this device.'
}

/** The browser key's limits, shown with the other ways in. Creating fixes the lifetime (renewable later); importing lets you pick up to a year at once (Q5-C04). */
function KeyLimitsNote(): JSX.Element {
  return (
    <p data-testid="signin-key-limits" className="text-[12px] text-anvil-500 dark:text-anvil-400">
      This browser gets its own Forge key. It spends at most {BROWSER_KEY_DEFAULTS.budgetDash} DASH<FiatNote dash={BROWSER_KEY_DEFAULTS.budgetDash} kind="bound" />, only on Forge. It lasts {BROWSER_KEY_DEFAULTS.days} days by default, and up to a year.
    </p>
  )
}

function ChooseView({ onPick, onDone }: { onPick: (v: View) => void; onDone: () => void }): JSX.Element {
  const { limitedKeys } = useAuth()
  const closeLogin = useUiStore((s) => s.closeLogin)
  const { available: walletAvailable, v2: walletV2, releasedWallet } = useWalletAvailability(limitedKeys)
  const [advanced, setAdvanced] = useState(false)
  const [more, setMore] = useState(false)
  const creating = useCreationInProgress()
  // While writes are paused (a devnet move, or the operator's PAGES_NOTICE=paused), no identity is
  // created, imported or given a wallet key here.
  const pausedReason = writesPausedReason()
  // No forge-v2 here means no contract group to bind a key to: nothing to sign in to.
  if (!limitedKeys) return <NotDeployedState />
  const network = ACTIVE_NETWORK.network
  const methods = signInMethods({ network, walletAvailable, walletV2, releasedWallet, creating: creating !== null })
  // The wallet leads only where a wallet a newcomer can install answers; elsewhere it is last,
  // saying why, so the first thing a newcomer tries is not a dead end (F3).
  const walletFirst = walletLeads({ network, walletV2, releasedWallet })
  const recommended = { label: 'Recommended', tone: 'recommended' } as const
  const tile = ({ id, recommended: isRecommended }: SignInMethod): ReactNode => {
    switch (id) {
      case 'resume-create':
        return creating === null ? null : (
          <Tile
            key={id}
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
        )
      case 'wallet':
        return (
          <Tile
            key={id}
            testId="tile-wallet"
            icon={Wallet}
            title="Use my Dash wallet"
            body={
              walletFirst
                ? network === 'testnet'
                  ? "DashPay on your phone (its testnet build): scan a QR code (or tap a link on the phone) and approve once for all of Forge. Your recovery phrase stays on the phone."
                  : 'DashPay (Dash Wallet) on your phone: scan a QR code (or tap a link on the phone) and approve once for all of Forge.'
                : network === 'devnet'
                  ? `Test wallets only on ${ACTIVE_NETWORK.key}: released Dash Wallet apps carry no devnet's settings.`
                  : walletV2 && !releasedWallet
                    ? `Released DashPay builds can't sign in on ${networkName()} since it moved to Platform protocol 15. Use another way until a DashPay update ships.`
                    : "Wallet sign-in isn't available here right now. Use another way."
            }
            muted={!walletFirst}
            badge={walletFirst ? (isRecommended ? recommended : null) : { label: 'Not available yet', tone: 'waiting' }}
            onClick={() => onPick('wallet')}
            // The wallet broadcasts a key-adding update for Forge: paused with every other write.
            pausedReason={pausedReason}
          />
        )
      case 'get-dashpay':
        // Its last step opens the wallet's code, which broadcasts a key-adding update: paused with the wallet tile.
        return pausedReason ? null : (
          <button
            key={id}
            type="button"
            data-testid="tile-get-dashpay"
            onClick={() => onPick('get-dashpay')}
            className="hit-area flex w-full items-center gap-1.5 px-1 text-left text-dense text-forge-700 underline dark:text-forge-400"
          >
            <Smartphone className="h-3.5 w-3.5 shrink-0" aria-hidden />
            No DashPay yet? Get it first
          </button>
        )
      case 'create':
        return (
          <Fragment key={id}>
            <Tile
              testId="tile-create"
              icon={Plus}
              title="Create a new identity"
              body={
                isTestNetwork(network)
                  ? `Write down 12 words, lock this browser with a passkey or passphrase, then fund it with free test DASH${faucetUrls().length > 0 ? ' from the faucet' : ''}. Takes a few minutes.`
                  : 'Write down 12 words, lock this browser with a passkey or passphrase, then fund it from any Dash wallet.'
              }
              badge={isRecommended ? recommended : null}
              highlight={isRecommended}
              onClick={() => onPick('create')}
              pausedReason={pausedReason}
            />
            <p data-testid="tile-create-cost" className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-anvil-500 dark:text-anvil-400">
              <TestCreditsBadge />
              <span>
                About {creditsAsDash(typicalIssueCredits())} DASH per issue<FiatNote dash={creditsToDash(typicalIssueCredits())} />, <PushCostText />.
              </span>
            </p>
          </Fragment>
        )
      case 'passkey':
        // A passkey added on another device: reads only, so it is offered even while writes are paused.
        return <PasskeySignIn key={id} onDone={onDone} onUnlock={() => onPick('unlock')} />
      case 'import':
        return (
          <Tile
            key={id}
            testId="tile-import"
            icon={Upload}
            title="Use my recovery phrase or identity file"
            body="Forge uses your 12 words (or file) once, to give this browser its own key, then forgets them."
            onClick={() => onPick('import')}
            pausedReason={pausedReason}
          />
        )
      case 'dg':
        return (
          <Tile
            key={id}
            testId="tile-dg"
            icon={SquareTerminal}
            title="Use dg on your computer"
            body="Already signed in to the dg command line? Run one command there. Your recovery phrase stays out of the browser."
            onClick={() => onPick('dg')}
            pausedReason={pausedReason}
          />
        )
      case 'raw-key':
        return <Tile key={id} testId="tile-advanced" icon={KeyRound} title="Paste a private key" body="Developer path. The key is held in this tab only and is lost on reload." onClick={() => onPick('advanced')} />
      default: {
        const unknown: never = id
        return unknown
      }
    }
  }
  const group = (g: SignInGroup): ReactNode[] => methods.filter((m) => m.group === g).map(tile)
  const advancedTiles = group('advanced')
  return (
    <div className="space-y-2">
      {group('primary')}
      <div className="pt-2">
        <button
          type="button"
          data-testid="signin-more"
          aria-expanded={more}
          aria-controls="signin-more-panel"
          onClick={() => setMore((o) => !o)}
          className="hit-area flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-dense font-medium text-anvil-600 hover:text-anvil-900 dark:text-anvil-300 dark:hover:text-anvil-100"
        >
          <span className="flex-1">Other ways to sign in</span>
          <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 transition-transform', more && 'rotate-180')} aria-hidden />
        </button>
        <div id="signin-more-panel" hidden={!more} className="mt-2 space-y-2">
          {group('more')}
          <KeyLimitsNote />
          {advancedTiles.length > 0 ? (
            <div className="pt-2">
              <button type="button" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)} className="hit-area text-[12px] text-anvil-500 dark:text-anvil-400 underline hover:text-anvil-800 dark:hover:text-anvil-100">
                Advanced
              </button>
              {advanced ? <div className="mt-2">{advancedTiles}</div> : null}
            </div>
          ) : null}
          <SignInHelp onLeave={closeLogin} />
        </div>
      </div>
    </div>
  )
}

/** The words the sheet uses, in plain English, without leaving it (F3; QW-013 linked out instead). */
const GLOSSARY: readonly (readonly [string, string])[] = [
  ['Identity', 'Your Dash account. Your 12 words (or identity file) control it; nobody, Forge included, can reset it or take it away.'],
  ['Recovery phrase', 'Those 12 words. Write them on paper and keep them offline: anyone who has them controls the identity.'],
  ['Master key', 'The all-powerful key your 12 words make. Forge uses it once, to set up this browser’s key, and never stores it.'],
  ['This browser’s key', `A key just for Forge, kept in this browser. It can spend at most ${BROWSER_KEY_DEFAULTS.budgetDash} DASH and expires (after ${BROWSER_KEY_DEFAULTS.days} days by default), so a lost or shared computer can’t empty your identity.`],
  ['Passkey', 'Your device’s fingerprint, face or PIN unlock. Here it locks this browser’s key. Your fingerprint or face never leaves the device.'],
  ['Credits', 'What writes cost, paid from your identity’s balance; every write shows its price first. Reading and cloning are free.'],
]

function SignInHelp({ onLeave }: { onLeave: () => void }): JSX.Element {
  return (
    <details data-testid="signin-help" className="group rounded-md border border-anvil-200 text-[12px] dark:border-anvil-800">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-anvil-600 coarse:py-3 dark:text-anvil-300 [&::-webkit-details-marker]:hidden">
        <HelpCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="flex-1">New to Dash Forge? What these words mean</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <dl className="space-y-2 border-t border-anvil-200 px-3 py-2 dark:border-anvil-800">
        {GLOSSARY.map(([term, meaning]) => (
          <div key={term}>
            <dt className="font-medium text-anvil-800 dark:text-anvil-100">{term}</dt>
            <dd className="text-anvil-600 dark:text-anvil-300">{meaning}</dd>
          </div>
        ))}
        {isTestNetwork() ? (
          <div>
            <dt className="font-medium text-anvil-800 dark:text-anvil-100">Test DASH</dt>
            <dd className="text-anvil-600 dark:text-anvil-300">
              On {networkName()} everything is paid with free test DASH from a faucet. Dollar figures in brackets show what the same thing would cost on mainnet.
            </dd>
          </div>
        ) : null}
      </dl>
      <p className="px-3 pb-2">
        <Link href="/start/" onClick={onLeave} className="hit-area text-forge-700 underline dark:text-forge-400" data-testid="signin-docs">
          More in Getting started
        </Link>
      </p>
    </details>
  )
}

/**
 * After a new identity registers (F14): next steps instead of the anonymous landing page, and a
 * check of the deposit address for a payment that arrived after the lock (F13: a second payment
 * there was silently left behind; the discard path warned, the success path did not).
 */
function WelcomeView({ created, onDone }: { created: CreatedIdentity; onDone: () => void }): JSX.Element {
  const leftover = useLeftoverDeposit(created.deposit)
  const depositAddress = typeof created.deposit === 'object' ? created.deposit?.depositAddress : undefined
  const steps = [
    { href: '/new/', icon: Plus, title: 'Create your first repo', body: 'Name it, then push to it with git.', testId: 'welcome-new-repo' },
    { href: '/mirror/', icon: CopyPlus, title: 'Import from GitHub', body: 'Mirror a repo you already have, with its issues.', testId: 'welcome-mirror' },
    { href: '/explore/', icon: Compass, title: 'Browse repos', body: 'See what others have built here.', testId: 'welcome-explore' },
  ] as const
  return (
    <div className="space-y-3" data-testid="signup-welcome">
      <p className="text-dense">
        Signed in as <span className="font-mono">{shortId(created.identityId)}</span>.
      </p>
      <ul className="space-y-2">
        {steps.map(({ href, icon: Icon, title, body, testId }) => (
          <li key={href}>
            <Link
              href={href}
              onClick={onDone}
              data-testid={testId}
              className="flex w-full items-start gap-3 rounded-lg border border-anvil-200 px-3 py-3 text-left transition-colors hover:border-forge-400 hover:bg-anvil-50 dark:border-anvil-750 dark:hover:bg-anvil-850"
            >
              <Icon className="mt-0.5 h-5 w-5 shrink-0 text-forge-500" aria-hidden />
              <span>
                <span className="block text-dense font-medium text-anvil-900 dark:text-anvil-50">{title}</span>
                <span className="mt-0.5 block text-[12px] text-anvil-500 dark:text-anvil-400">{body}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {leftover.kind === 'checking' ? (
        <p role="status" className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="welcome-deposit-checking">
          Checking your deposit address for any extra payment (up to a minute)…
        </p>
      ) : leftover.kind === 'held' ? (
        <div role="alert" data-testid="welcome-leftover" className="flex gap-2 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense text-caution-700 dark:text-caution-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            {(leftover.duffs / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')} DASH<FiatNote dash={leftover.duffs / 1e8} balance /> is still on the deposit address{' '}
            <span className="break-all font-mono">{depositAddress}</span>: it wasn&apos;t included in your identity and
            isn&apos;t in your balance. Only your 12 words can recover it, with tools outside Forge.
          </span>
        </div>
      ) : leftover.kind === 'unknown' ? (
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="welcome-deposit-unknown">
          Couldn&apos;t check the deposit address for a second payment. If you paid it more than once, the extra stays there, and only your 12 words can recover it.
        </p>
      ) : null}
      <Button variant="outline" className="w-full" onClick={onDone} data-testid="welcome-done">
        Done
      </Button>
    </div>
  )
}

type Leftover = { readonly kind: 'checking' | 'none' | 'unknown' } | { readonly kind: 'held'; readonly duffs: number }

/** What the finished creation's deposit address still holds, once (nothing to check without its record). */
function useLeftoverDeposit(deposit: CreatedIdentity['deposit']): Leftover {
  const [state, setState] = useState<Leftover>(deposit === null ? { kind: 'none' } : deposit === 'unreadable' ? { kind: 'unknown' } : { kind: 'checking' })
  useEffect(() => {
    if (deposit === null || deposit === 'unreadable') return
    let cancelled = false
    depositBalance(ACTIVE_NETWORK.network, deposit, { countLock: true }).then(
      (duffs) => !cancelled && setState(duffs > 0 ? { kind: 'held', duffs } : { kind: 'none' }),
      () => !cancelled && setState({ kind: 'unknown' }),
    )
    return () => {
      cancelled = true
    }
  }, [deposit])
  return state
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
 * Whether the wallet tile applies here: the chain supports App Connect v2 (`v2`: one approval for
 * all of Forge), the only wallet sign-in left. When Platform cannot be reached to check, the tile
 * shows anyway (`available` without `v2`): the flow behind it names what failed and offers "Try
 * again", where hiding it would fail silently.
 */
function useWalletAvailability(limitedKeys: boolean): { readonly available: boolean; readonly v2: boolean; readonly releasedWallet: boolean } {
  const [state, setState] = useState({ available: false, v2: false, releasedWallet: false })
  useEffect(() => {
    if (!limitedKeys) return
    let cancelled = false
    connectPlatform(ACTIVE_NETWORK.network)
      .then(async (sdk) => {
        // A check that could not finish shows the tile anyway (see above).
        const support = await withTimeout(appConnectSupport(sdk, ACTIVE_NETWORK.network), PLATFORM_READ_MS, 'Checking what your wallet can answer').catch(() => null)
        return { available: support?.v2 !== false, v2: support?.v2 === true, releasedWallet: support?.releasedWallet === true }
      })
      .then(
        (next) => !cancelled && setState(next),
        () => !cancelled && setState({ available: true, v2: false, releasedWallet: false }),
      )
    return () => {
      cancelled = true
    }
  }, [limitedKeys])
  return state
}

/** The store pages of DashPay (Android, `hashengineering.darkcoin.wallet`) and of DashPay – Dash Wallet (iOS). */
export const DASHPAY_GOOGLE_PLAY = 'https://play.google.com/store/apps/details?id=hashengineering.darkcoin.wallet'
export const DASHPAY_APP_STORE = 'https://apps.apple.com/app/id1206647026'

/** Mainnet's way in for someone without DashPay: install it and create a username there, then scan Forge's code. */
function GetDashPayView({ onHaveIt }: { onHaveIt: () => void }): JSX.Element {
  const store = 'inline-flex items-center justify-center rounded-md border border-anvil-300 px-3 py-2 text-dense font-medium hover:border-forge-400 dark:border-anvil-700'
  return (
    <div className="space-y-4" data-testid="get-dashpay">
      <ol className="space-y-3 text-dense">
        <li>
          <p className="font-medium">1. Install DashPay on your phone</p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <a data-testid="get-dashpay-android" href={DASHPAY_GOOGLE_PLAY} target="_blank" rel="noreferrer" className={store}>
              Google Play
            </a>
            <a data-testid="get-dashpay-ios" href={DASHPAY_APP_STORE} target="_blank" rel="noreferrer" className={store}>
              App Store
            </a>
          </div>
        </li>
        <li>
          <p className="font-medium">2. Create your username in DashPay</p>
          <p className="mt-1 text-anvil-600 dark:text-anvil-300">That is your Dash identity. Its recovery phrase stays on the phone.</p>
        </li>
        <li>
          <p className="font-medium">3. Approve Forge&apos;s request in DashPay</p>
        </li>
      </ol>
      <Button variant="primary" className="w-full" data-testid="get-dashpay-continue" onClick={onHaveIt}>
        I have DashPay: show the code
      </Button>
    </div>
  )
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

function UnlockView({
  initial,
  onDone,
  onOther,
  onRenew,
}: {
  initial: string | null
  onDone: () => void
  onOther: () => void
  onRenew: (v?: VaultInfo) => void
}): JSX.Element {
  const { vaults, unlock, forget, isLoading, step, lastIdentity } = useAuth()
  const [confirm, confirmDialog] = useConfirmAction()
  // The identity asked for, else the one signed in last (QW2-025), as an account switcher does.
  const [pick, setPick] = useState(() => Math.max(0, vaults.findIndex((v) => v.identityId === (initial ?? lockedIdentityOf(vaults, lastIdentity)))))
  const [passphrase, setPassphrase] = useState('')
  const passphraseRef = useRef<HTMLInputElement>(null)
  // An error belongs to the key it came from: after a pick or a forget, another key shows none.
  const [failure, setFailure] = useState<{ id: string; text: string } | null>(null)
  const v = vaults[pick] ?? vaults[0]
  const error = failure !== null && failure.id === v?.identityId ? failure.text : null
  const setError = (text: string | null): void => setFailure(text === null || !v ? null : { id: v.identityId, text })
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
  const go = async (method: UnlockMethod): Promise<void> => {
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
  // A wallet's key (or one a passkey restored) the wallet disconnected: renewing can't bring it
  // back, so the way on is to forget it and sign in again.
  const disconnected = v.disconnected === true || (error !== null && /disconnected in your wallet/i.test(error))
  const expired = !disconnected && error !== null && /no longer usable|renew/i.test(error)
  const forgetIt = (then?: () => void): void => {
    void forgetConfirm(v.identityId, { disabled: disconnected })
      .then(confirm)
      .then((ok) => {
        if (ok)
          forget(v.identityId).then(
            () => {
              setPick(0)
              then?.()
            },
            (e: unknown) => setError(errorMessage(e)),
          )
      })
  }
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
              // An error (a disconnected key above all) is about the key it came from.
              setError(null)
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
      {v.methods.includes('device') ? (
        <Button variant={disconnected ? 'outline' : 'primary'} className="w-full" onClick={() => go('device')} loading={isLoading} disabled={isLoading} data-testid="unlock-device">
          Unlock
        </Button>
      ) : null}
      {v.methods.includes('passkey') ? (
        <Button variant={disconnected ? 'outline' : 'primary'} className="w-full" onClick={() => go('passkey')} loading={isLoading} disabled={isLoading}>
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
          <Button type="submit" variant={v.methods.includes('passkey') || disconnected ? 'outline' : 'primary'} className="w-full" loading={isLoading} disabled={passphrase === '' || isLoading}>
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
      {disconnected ? (
        <div role="alert" data-testid="unlock-disconnected" className="space-y-2 rounded-md border border-caution/40 bg-caution/10 p-3 text-dense">
          <p>
            {v.fromAppConnect === true || (error !== null && /^this key was disconnected in your wallet/i.test(error))
              ? 'This key was disconnected in your wallet, so sign in again.'
              : 'This key was disabled on Platform (disconnected in your wallet, or revoked from another device), so sign in again.'}{' '}
            It can&apos;t sign anything now.
          </p>
          <Button variant="primary" className="w-full" onClick={() => forgetIt(onOther)}>
            Forget this key and sign in again
          </Button>
        </div>
      ) : null}
      {/* Any other failure (a wrong passphrase, a forget that failed) still shows. */}
      <ErrorBox error={disconnected && error !== null && /so sign in again/i.test(error) ? null : error} />
      {expired ? (
        <Button variant="outline" className="w-full" onClick={() => onRenew(v)}>
          Renew this browser&apos;s key
        </Button>
      ) : null}
      {/* The recovery route (like "Forgot password?"): the identity file or recovery phrase
          registers a new key for this browser and disables the one it cannot open. */}
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="unlock-forgot">
        {v.methods.includes('passphrase') ? 'Forgot the passphrase' : v.methods.includes('passkey') ? 'Lost the passkey' : 'Key not working'}?{' '}
        {ACTIVE_NETWORK.network === 'mainnet' && !v.fromDg ? (
          <button type="button" onClick={onOther} className="hit-area text-forge-700 underline dark:text-forge-400">
            Sign in again with your wallet
          </button>
        ) : (
          <button type="button" onClick={() => onRenew(v)} className="hit-area text-forge-700 underline dark:text-forge-400">
            {v.fromDg ? 'Replace this key with dg' : 'Replace this key with your recovery phrase or identity file'}
          </button>
        )}
      </p>
      <div className="flex justify-between pt-1 text-[12px]">
        <button type="button" onClick={onOther} className="hit-area text-anvil-500 dark:text-anvil-400 underline">
          Other sign-in options
        </button>
        <button
          type="button"
          onClick={() => forgetIt()}
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

/**
 * Renew: with `dg` (no recovery phrase in the browser) or with the identity file or phrase. A key
 * that came from `dg` renews with `dg` by default (TS-06), so the phrase is asked for only when
 * the user picks it.
 */
function RenewView({ onDone, onStored }: { onDone: () => void; onStored: (identityId: string) => void }): JSX.Element {
  const { vaults, identity } = useAuth()
  const fromDg = vaults.find((v) => v.identityId === identity)?.fromDg === true
  const [how, setHow] = useState<'dg' | 'master'>(fromDg ? 'dg' : 'master')
  const options = [
    ['dg', 'With dg'],
    ['master', 'With identity file or phrase'],
  ] as const
  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="Renew with" className="inline-flex rounded-md border border-anvil-200 p-0.5 dark:border-anvil-750">
        {options.map(([m, label]) => (
          <button
            key={m}
            role="tab"
            aria-selected={how === m}
            type="button"
            data-testid={`renew-with-${m}`}
            onClick={() => setHow(m)}
            className={cn('rounded px-3 py-1.5 text-dense font-medium coarse:min-h-11', how === m ? 'bg-forge-500/15 text-forge-800 dark:text-forge-400' : 'text-anvil-500 dark:text-anvil-400')}
          >
            {label}
          </button>
        ))}
      </div>
      {how === 'dg' ? <DgHandoffFlow renew onDone={onDone} /> : <ImportView renew onDone={onDone} onStored={onStored} />}
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
  const [days, setDays] = useState<number>(BROWSER_KEY_DEFAULTS.days)
  // Errors show beside the button that caused them, scrolled into view: in a tall sheet the
  // button can sit at the bottom edge of a phone (or a 800 px laptop) screen.
  const errorRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (error !== null) errorRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [error])
  // Enter in a passphrase field submits (QW3-027); `submit` is declared below, so through a ref.
  const submitRef = useRef<() => void>(() => undefined)
  // Opt-in (`ux-dx-spec.md` §2.3): also keep the identity's encryption key, for private repos.
  const [enablePrivate, setEnablePrivate] = useState(wantsPrivate)
  // Kept by this browser alone only when nothing else is: no encryption key, and a renewal never
  // weakens a key that had a passkey or passphrase.
  const heldMethods = vaults.find((v) => v.identityId === identity && v.staged !== true)?.methods ?? []
  const allowDevice = !enablePrivate && !(renew && heldMethods.some((m) => m !== 'device'))
  const { fields, protection, problem } = useProtection({ onSubmit: () => submitRef.current(), allowDevice })
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
  // choice to offer (QW3-031: the encryption-key box showed unticked although key 4 was kept).
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
      await importIdentity(mode === 'file' ? { fileText: text as string } : { mnemonic, identityId }, protection, limitsFor(days), {
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
          <PhraseWarning />
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
      <KeyLifetimeSelect id="import-days" value={days} onChange={setDays} />
      {carriesEncryption ? (
        <p className="rounded-md border border-anvil-200 p-3 text-dense dark:border-anvil-800" data-testid="import-carries-encryption">
          <span className="font-medium">Members-only and private content stays readable.</span>{' '}
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
          <span className="font-medium">Read and write members-only and private content</span>
          <span className="block text-[12px] text-anvil-500 dark:text-anvil-400">
            Also keep this identity&apos;s encryption key here, protected the same way. It opens members-only content in public repos and the private repos you belong to. {ENCRYPTION_KEY_BLAST_RADIUS}
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
        {renew && keyId !== null ? `Disables key #${keyId} and registers` : 'Registers'} a key that can spend at most {BROWSER_KEY_DEFAULTS.budgetDash} DASH<FiatNote dash={BROWSER_KEY_DEFAULTS.budgetDash} kind="bound" />, only on Forge, for {lifetimeLabel(days)}
        {renewing
          ? <> (renewing: ~{creditsAsDash(KEY_RENEW_CREDITS)} DASH<FiatNote dash={creditsToDash(KEY_RENEW_CREDITS)} />, one master-key signature; the old key is disabled in the same update).</>
          : // Platform meters the update: an identity that already holds a Forge key (from another
            // browser or dg) pays the lower figure (QW-043). Its floor is the least one was measured to
            // cost, the low end Settings → Spend shows too (QW3-037: 0.00028 quoted, 0.000269 charged).
            <> ({creditsAsDash(KEY_ADD_FLOOR_CREDITS)}–{creditsAsDash(KEY_REGISTER_CREDITS)} DASH<FiatNote dash={creditsToDash(KEY_REGISTER_CREDITS)} range={creditsToDash(KEY_ADD_FLOOR_CREDITS)} />, one master-key signature; up to {creditsAsDash(KEY_RENEW_CREDITS)}<FiatNote dash={creditsToDash(KEY_RENEW_CREDITS)} kind="bound" /> when the identity already has a Forge key).</>}
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
