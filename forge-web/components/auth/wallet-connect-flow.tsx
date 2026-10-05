'use client'

/**
 * "Use my Dash wallet" (`ux-dx-spec.md` §2.2 tile 1; docs/design/wallet-login.md).
 *
 * 1. Request: a `dash-key:` QR (and, on a phone, an "Open in DashPay (Dash Wallet)" link: both wallets
 *    register the scheme) asking for a key bound to one Forge contract, with a countdown.
 * 2. Key registration, first time only: a legacy wallet answers with a key that is not on its
 *    identity yet, so a second QR/link (`dash-st:`) asks it to register the key.
 * 3. Confirm: the identity that answered. The response does not prove who answered: anyone who
 *    saw the QR could, and on the legacy contract the FIRST answer is the only one Forge can see.
 *    So the user compares the username and id with what the wallet's approval screen showed (the
 *    username and a shortened id), and is warned when the identity has no username, a brand-new
 *    one, or is not the one this device already holds. A key without a budget or expiry is
 *    flagged, and a passkey is the default protection.
 *
 * Dash Wallet answers on testnet only (`walletSignInSupported`); elsewhere the sheet says so.
 *
 * `mode="grant"` asks the signed-in identity's wallet for a key on another contract (a shipped
 * wallet grants one contract per approval) and adds it to the session: no confirmation step,
 * since only answers from the signed-in identity are read.
 *
 * Granted keys are held in refs, never React state, and dropped when the sheet closes. So is the
 * encryption key the wallet's login key stands for: signing in seals it into the vault beside the
 * wallet key when it is the identity's (DESIGN D27), and the bytes are wiped once the sheet is done.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, RefreshCw, Smartphone } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { PendingRenewalChoiceError, PendingRenewalLockedError, UnlockNeededError } from '@/lib/auth/controller'
import { Button } from '@/components/ui/button'
import { UnlockMore } from '@/components/auth/unlock-more'
import { Field, Input } from '@/components/ui/input'
import { Qr } from '@/components/ui/qr'
import { ErrorBox, useProtection } from '@/components/auth/protection-fields'
import { Waiting } from '@/components/auth/step-status'
import { ACTIVE_NETWORK } from '@/lib/constants'
import {
  REQUEST_TTL_MS,
  RequestExpired,
  awaitRegisteredKey,
  awaitWalletAnswer,
  newLoginRequest,
  responseSources,
  walletSignInSupported,
  wipeAnswer,
  type PollStatus,
  type WalletAnswer,
} from '@/lib/auth/app-connect'
import { isUnlimited, keyRegistrationUri, scopeCovers, type WalletKey } from '@/lib/auth/key-registration'
import { responderProfile, type ResponderProfile } from '@/lib/auth/responder-profile'
import { isAbort } from '@/lib/sdk/facade'
import { PHASE_TEXT, connectPlatform, withPlatformRead } from '@/lib/auth/connect'
import { formatDate } from '@/lib/view/format'
import { cn, errorMessage } from '@/lib/utils'

/** The wallet link where a wallet can answer (the main action), and where none can (secondary). */
const DEEP_LINK_PRIMARY = 'bg-forge-700 text-white hover:bg-forge-800'
const DEEP_LINK_SECONDARY =
  'border border-anvil-300 text-anvil-800 hover:bg-anvil-100 dark:border-anvil-700 dark:text-anvil-100 dark:hover:bg-anvil-800'

type Step =
  | { readonly kind: 'request'; readonly uri: string; readonly expiresAt: number }
  | { readonly kind: 'register'; readonly uri: string; readonly expiresAt: number }
  | { readonly kind: 'confirm'; readonly profile: ResponderProfile; readonly unlimited: boolean; readonly unbounded: boolean }
  | { readonly kind: 'expired' }

/**
 * A phone or tablet browser: the wallet is on this device, so a link beats a QR. Dash Wallet
 * exists for Android and iOS only, so a desktop browser gets the QR alone.
 */
function onMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData
  return uaData?.mobile ?? /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
}

export function WalletConnectFlow({ onDone, mode = 'login', contractId }: { onDone: () => void; mode?: 'login' | 'grant'; contractId?: string }): JSX.Element {
  const { adoptWalletKeys, addWalletGrant, identity, isLoading, vaults, unlockScope } = useAuth()
  // Read when the request starts (a scope change must not restart a running request).
  const scopeRef = useRef(unlockScope)
  scopeRef.current = unlockScope
  const forge = ACTIVE_NETWORK.v2
  const target = contractId ?? forge?.core ?? ''
  const [step, setStep] = useState<Step | null>(null)
  const [status, setStatus] = useState<PollStatus>('waiting')
  const [error, setError] = useState<string | null>(null)
  /** An unfinished renewal on this device (D-016): the choice to finish it or give it up. */
  const [pendingRenewal, setPendingRenewal] = useState<string | null>(null)
  /**
   * Giving it up needs its key opened (kept so the next renewal or revoke disables it): its own
   * passphrase or passkey, when the one chosen here is not it.
   */
  const [renewalLocked, setRenewalLocked] = useState<{ message: string; methods: readonly ('passkey' | 'passphrase')[] } | null>(null)
  // The renewal's passphrase lives only in the input's value property (an uncontrolled input):
  // React mirrors a controlled input's value into the `value` attribute, which puts it in the DOM.
  const renewalPassphraseRef = useRef<HTMLInputElement | null>(null)
  const [hasRenewalPassphrase, setHasRenewalPassphrase] = useState(false)
  // Wipe the field as React detaches it (a cleanup effect runs too late: the ref is null); a
  // remounted field is empty, and so is the flag.
  const bindRenewalPassphrase = useCallback((el: HTMLInputElement | null) => {
    if (el === null && renewalPassphraseRef.current) renewalPassphraseRef.current.value = ''
    if (el === null) setHasRenewalPassphrase(false)
    renewalPassphraseRef.current = el
  }, [])
  // What the request is waiting for before its QR can show.
  const [preparing, setPreparing] = useState(PHASE_TEXT.connecting)
  const [attempt, setAttempt] = useState(0)
  const [confirmed, setConfirmed] = useState(false)
  const grant = useRef<{ identityId: string; keys: readonly WalletKey[]; answer: WalletAnswer } | null>(null)
  /** Wipe the held answer's private key bytes and drop the grant. */
  const dropGrant = useCallback(() => {
    if (grant.current) wipeAnswer(grant.current.answer)
    grant.current = null
  }, [])
  const mobile = onMobile()
  const unlimited = step?.kind === 'confirm' && step.unlimited
  const { fields, protection, problem } = useProtection({ preferPasskey: unlimited })
  // Read at request time, not effect deps: a change must not restart a request mid-flow (the
  // identity changes from null to the new one inside the login itself).
  const latest = useRef({ addWalletGrant, onDone, stored: vaults.map((v) => v.identityId) })
  latest.current = { addWalletGrant, onDone, stored: vaults.map((v) => v.identityId) }
  // A grant is for the signed-in identity: a different one (or signing out) starts over.
  const grantFor = mode === 'grant' ? identity : null
  // The sign-in sheet: unlocking there finishes an unfinished renewal with its passphrase.
  const openLogin = useUiStore((s) => s.openLogin)

  /**
   * Store the wallet's keys. `discard`: give up an unfinished renewal on this device first,
   * keeping its key (opened with `renewalUnlock` when given) for the next revoke to disable;
   * `drop`: give it up without its key.
   */
  // A reloaded tab holds the signing key only: storing the wallet's keys over the stored key
  // (carrying its grants and settings across) needs the vault open. Unlock, then carry on.
  const [unlockFirst, setUnlockFirst] = useState<(() => void) | null>(null)
  const finish = async (discard: boolean, renewalUnlock?: { passphrase: string } | 'passkey', drop = false): Promise<void> => {
    const g = grant.current
    if (!protection || !g) return
    setError(null)
    try {
      await adoptWalletKeys(g.identityId, g.keys, protection, {
        discardPendingRenewal: discard,
        ...(renewalUnlock ? { renewalUnlock } : {}),
        ...(drop ? { dropUnopened: true } : {}),
        encryptionKeys: g.answer.encryptionKeys,
        justRegistered: g.answer.kind === 'register',
      })
      dropGrant()
      setPendingRenewal(null)
      setRenewalLocked(null)
      if (renewalPassphraseRef.current) renewalPassphraseRef.current.value = ''
      setHasRenewalPassphrase(false)
      onDone()
    } catch (e) {
      if (e instanceof PendingRenewalChoiceError) setPendingRenewal(e.message)
      else if (e instanceof PendingRenewalLockedError) setRenewalLocked({ message: e.message, methods: e.methods })
      else if (e instanceof UnlockNeededError) setUnlockFirst(() => () => {
        setUnlockFirst(null)
        void finish(discard, renewalUnlock, drop)
      })
      else setError(errorMessage(e))
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    const signal = controller.signal
    setError(null)
    setConfirmed(false)
    setStatus('waiting')
    void (async () => {
      try {
        if (!forge) throw new Error('Dash Forge is not deployed here')
        if (mode === 'grant' && !grantFor) throw new Error('Sign in (or unlock) first: the approval is added to the signed-in identity.')
        // A grant is sealed with the vault: a reloaded (signing-only) tab unlocks first (below).
        if (mode === 'grant' && scopeRef.current === 'signing') return
        const sdk = await connectPlatform(ACTIVE_NETWORK.network, (p) => !signal.aborted && setPreparing(PHASE_TEXT[p]))
        if (signal.aborted) return
        setPreparing('Finding the wallet login contract')
        const sources = await withPlatformRead(responseSources(sdk, ACTIVE_NETWORK.key), 'Finding the wallet login contract')
        if (signal.aborted) return
        if (sources.length === 0) throw new Error(`No wallet login contract is available on ${ACTIVE_NETWORK.key}.`)
        const req = newLoginRequest(ACTIVE_NETWORK.network, target)
        setStep({ kind: 'request', uri: req.uri, expiresAt: req.expiresAt })
        const answer = await awaitWalletAnswer(sdk, req, {
          network: ACTIVE_NETWORK.network,
          forge,
          sources,
          signal,
          onStatus: setStatus,
          ...(mode === 'grant' && grantFor ? { identityId: grantFor } : {}),
        })
        let keys: readonly WalletKey[]
        // Its private key bytes are wiped here unless the confirm step holds them (`grant`).
        let held = false
        try {
          if (answer.kind === 'register') {
            // First login from this wallet: QR #2 registers the key, then wait for it on chain.
            const until = Date.now() + REQUEST_TTL_MS
            const uri = await keyRegistrationUri(sdk, { identityId: answer.identityId, keys: answer.keys, contractId: target, network: ACTIVE_NETWORK.network })
            if (signal.aborted) return
            setStep({ kind: 'register', uri, expiresAt: until })
            keys = [await awaitRegisteredKey(sdk, { identityId: answer.identityId, wif: answer.wif, network: ACTIVE_NETWORK.network, forge, until, signal })]
          } else {
            keys = answer.keys
          }
          if (signal.aborted) return
          if (mode === 'grant') {
            // The key that covers what was asked for (a wallet may grant several, or the wrong one).
            const key = keys.find((k) => scopeCovers(k.scope, forge, target))
            if (!key) throw new Error("The wallet's answer does not cover issues and pull requests. Try again, or sign in with your identity file.")
            await latest.current.addWalletGrant(answer.identityId, key, target)
            if (signal.aborted) return
            latest.current.onDone()
            return
          }
          grant.current = { identityId: answer.identityId, keys, answer }
          held = true
        } finally {
          if (!held) wipeAnswer(answer)
        }
        const profile = await responderProfile(sdk, answer.identityId, ACTIVE_NETWORK.network, latest.current.stored)
        if (signal.aborted) return
        setStep({ kind: 'confirm', profile, unlimited: keys.some(isUnlimited), unbounded: keys.some((k) => k.scope.unbounded) })
      } catch (e) {
        if (signal.aborted || isAbort(e)) return
        if (e instanceof RequestExpired) setStep({ kind: 'expired' })
        else setError(errorMessage(e))
      }
    })()
    return () => {
      controller.abort()
      dropGrant()
    }
    // `attempt` restarts the whole request (a new ephemeral key and QR).
  }, [attempt, forge, target, mode, grantFor, dropGrant])

  const restart = useCallback(() => setAttempt((a) => a + 1), [])

  // A reloaded tab holds the signing key only; an approval is stored with the rest of the vault.
  if (mode === 'grant' && unlockScope === 'signing') {
    return <UnlockMore title="Unlock this tab to add the approval" testId="grant-unlock" />
  }
  if (step?.kind === 'confirm') {
    const { profile } = step
    return (
      <div className="space-y-3" data-testid="wallet-confirm">
        <p className="text-dense">
          A wallet answered for this identity.{' '}
          <span className="font-medium">
            Your wallet&apos;s approval screen showed your username and the start and end of your identity id: check they match the ones below.
          </span>
        </p>
        <div className="rounded-md border border-anvil-200 px-3 py-2 dark:border-anvil-800">
          {profile.name ? (
            <div className="text-dense font-medium">
              {profile.name}
              {profile.namedAt ? <span className="ml-2 text-[12px] font-normal text-anvil-500 dark:text-anvil-400">named {formatDate(profile.namedAt)}</span> : null}
            </div>
          ) : null}
          <div data-testid="granted-identity" className="break-all font-mono text-dense">
            {profile.identityId}
          </div>
        </div>
        {profile.warnings.map((w) => (
          <div key={w} role="alert" data-testid="responder-warning" className="flex gap-2 rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-dense text-danger-700 dark:text-danger-400">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{w}</span>
          </div>
        ))}
        {step.unlimited ? <UnlimitedKeyWarning unbounded={step.unbounded} /> : null}
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
          Anyone who saw your QR code could have answered first with their own identity; this wallet protocol cannot tell. Only you can, by comparing the
          username and id above with what your wallet showed.
        </p>
        <label className="flex items-start gap-2 text-dense">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1" />
          <span>This is my identity: it matches what my wallet showed. (If it does not, close this and start again.)</span>
        </label>
        {fields}
        <Button
          variant="primary"
          className="w-full"
          loading={isLoading}
          disabled={!confirmed || protection === null || isLoading}
          onClick={() => void finish(false)}
        >
          Finish signing in
        </Button>
        {pendingRenewal !== null ? (
          <div role="alert" className="space-y-2 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense text-caution-700 dark:text-caution-400" data-testid="pending-renewal-choice">
            <p>{pendingRenewal}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => openLogin()}>
                Finish the renewal (unlock)
              </Button>
              <Button variant="danger" size="sm" loading={isLoading} onClick={() => void finish(true)}>
                Continue with the wallet
              </Button>
            </div>
            {renewalLocked !== null ? (
              <div className="space-y-2 border-t border-caution/30 pt-2" data-testid="pending-renewal-unlock">
                <p>{renewalLocked.message}</p>
                {renewalLocked.methods.includes('passphrase') ? (
                  <Field label="The renewal's passphrase" htmlFor="renewal-passphrase">
                    <Input id="renewal-passphrase" ref={bindRenewalPassphrase} type="password" autoComplete="off" onChange={(e) => setHasRenewalPassphrase(e.target.value !== '')} />
                  </Field>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {renewalLocked.methods.includes('passphrase') ? (
                    <Button variant="outline" size="sm" loading={isLoading} disabled={!hasRenewalPassphrase} onClick={() => void finish(true, { passphrase: renewalPassphraseRef.current?.value ?? '' })}>
                      Keep its key and continue
                    </Button>
                  ) : null}
                  {renewalLocked.methods.includes('passkey') ? (
                    <Button variant="outline" size="sm" loading={isLoading} onClick={() => void finish(true, 'passkey')}>
                      Use its passkey and continue
                    </Button>
                  ) : null}
                  <Button variant="danger" size="sm" loading={isLoading} onClick={() => void finish(true, undefined, true)}>
                    Continue without it
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        {problem ? <p className="text-[12px] text-anvil-500 dark:text-anvil-400">{problem}</p> : null}
        {unlockFirst ? <UnlockMore title="Unlock this tab to finish signing in with your wallet" testId="wallet-unlock" then={unlockFirst} /> : null}
        <ErrorBox error={error} />
      </div>
    )
  }

  if (step?.kind === 'expired') {
    return (
      <div className="space-y-3">
        <p className="text-dense">The request expired before a wallet answered.</p>
        <Button variant="primary" className="w-full" onClick={restart}>
          <RefreshCw className="h-4 w-4" aria-hidden /> New request
        </Button>
      </div>
    )
  }

  const uri = step?.kind === 'request' || step?.kind === 'register' ? step.uri : null
  const isRegister = step?.kind === 'register'
  const qrLabel = isRegister ? 'Wallet key registration request' : 'Wallet login request'
  // Where no released wallet can answer (a devnet, mainnet), that comes first and the wallet
  // link is secondary: a big primary button that cannot work is a dead end (QW2-029).
  const supported = walletSignInSupported(ACTIVE_NETWORK.network)
  const supportNote = mode === 'login' && step?.kind === 'request' ? <WalletSupportNote /> : null
  // Said where the QR is on screen: a phone's QR sits in a collapsed disclosure.
  const qrPrivate = step?.kind === 'request' ? <p className="text-dense">Keep this QR code private: anyone who scans it can answer it.</p> : null
  return (
    <div className="space-y-3" data-testid={isRegister ? 'wallet-register' : 'wallet-request'}>
      {supported ? null : supportNote}
      {mode === 'grant' && !isRegister ? (
        <p className="text-dense">Approve issues, pull requests, reviews and stars for this identity in your wallet.</p>
      ) : null}
      {isRegister ? (
        <p className="text-dense">
          <span className="font-medium">One more step, first time only.</span> Your wallet approved, and now it has to add Forge&apos;s key to your identity.{' '}
          {mobile ? 'Open it in the wallet again.' : 'Scan this second code with the wallet.'}
        </p>
      ) : null}
      {uri ? (
        mobile ? (
          <>
            <a
              href={uri}
              data-testid="wallet-deep-link"
              data-primary={supported || undefined}
              className={cn(
                'flex w-full items-center justify-center gap-2 rounded-md px-4 py-3 text-dense font-medium',
                supported ? DEEP_LINK_PRIMARY : DEEP_LINK_SECONDARY,
              )}
            >
              <Smartphone className="h-4 w-4" aria-hidden /> {isRegister ? 'Add the key in DashPay (Dash Wallet)' : 'Open in DashPay (Dash Wallet)'}
            </a>
            <details className="text-[12px] text-anvil-500 dark:text-anvil-400">
              <summary className="cursor-pointer coarse:py-3">Wallet on another device? Show the QR code</summary>
              <div className="space-y-2 pt-2">
                <Qr value={uri} label={qrLabel} size={180} />
                {qrPrivate}
              </div>
            </details>
          </>
        ) : (
          <>
            <Qr value={uri} label={qrLabel} size={200} />
            {qrPrivate}
          </>
        )
      ) : error ? null : (
        <Waiting label={preparing} />
      )}
      {status === 'incomplete-read' && step?.kind === 'request' ? (
        <p className="text-[12px] text-caution-700 dark:text-caution-400" data-testid="incomplete-read">
          Couldn&apos;t read all answer sources — retrying. Forge won&apos;t accept an answer until it has read them all.
        </p>
      ) : null}
      {step?.kind === 'request' || step?.kind === 'register' ? <Countdown until={step.expiresAt} /> : null}
      {supported ? supportNote : null}
      <ErrorBox error={error} />
      {error ? (
        <Button variant="outline" className="w-full" onClick={restart}>
          <RefreshCw className="h-4 w-4" aria-hidden /> Try again
        </Button>
      ) : null}
    </div>
  )
}

/**
 * Which wallets can answer here, from the wallets' sources (docs/design/wallet-login.md,
 * "Compatibility matrix"). Nothing more is claimed: DashConnect is in both wallets' development
 * branches (dash-wallet `master`, dashwallet-ios `develop`), in neither's latest release
 * (v11.9.0, v9.0.2), and answers on testnet (plus devnets in internal iOS builds).
 */
export function WalletSupportNote(): JSX.Element {
  const { network, key } = ACTIVE_NETWORK
  if (!walletSignInSupported(network)) {
    return (
      <p role="note" data-testid="wallet-support" className="rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-[12px]">
        {network === 'devnet'
          ? `Dash Wallet support arrives when Forge is on testnet, where its sign-in feature works. No released wallet has it yet. On ${key}, only an internal iOS build can answer.`
          : `No Dash Wallet build supports sign-in on ${key} yet: its sign-in feature (DashConnect) works on testnet only.`}{' '}
        Here, sign in with your identity file or recovery phrase, or create an identity in the browser.
      </p>
    )
  }
  return (
    <p data-testid="wallet-support" className="text-[12px] text-anvil-500 dark:text-anvil-400">
      Works with a testnet development build of the Dash Wallet app: More → Tools → Connections → Scan QR. No released version has it yet. The first
      approval covers repos and pushes. Issues, pull requests and stars may ask again.
    </p>
  )
}

/** "This key has no spending limit" (a shipped wallet's key): what it means, what to do. */
export function UnlimitedKeyWarning({ unbounded }: { unbounded: boolean }): JSX.Element {
  return (
    <div role="note" data-testid="unlimited-key-warning" className="flex gap-2 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-caution-700 dark:text-caution-400" aria-hidden />
      <span>
        This wallet key has no spending limit or expiry. Anyone who copies it from this browser can spend your balance
        {unbounded ? ' on any Platform app' : ' on Forge'}. Protect it with a passkey and replace it with a limited key soon, in
        Settings → This browser&apos;s key.
      </span>
    </div>
  )
}

function Countdown({ until }: { until: number }): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const left = Math.max(0, Math.round((until - now) / 1000))
  return (
    <p className="text-center font-mono text-[12px] text-anvil-500 dark:text-anvil-400" aria-live="off" data-testid="request-countdown">
      Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
    </p>
  )
}
