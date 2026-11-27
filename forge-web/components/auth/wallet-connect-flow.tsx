'use client'

/**
 * "Use my Dash wallet" with App Connect v2 (`lib/auth/app-connect-v2.ts`; docs/design/wallet-login.md).
 *
 * 1. Request: an App Connect v2 QR, "Copy link" and "Open in wallet" (on a phone the link leads and
 *    the QR sits in a disclosure; the link carries a callback to `/connect/`), with a countdown. ONE
 *    request, one approval, one key bound to the whole Forge contract group with a budget and an
 *    expiry; those terms, the anti-phishing detail ({@link ScanSafety}) and the wallet versions are
 *    under Details, with one line ({@link ScanOnlyHere}) saying where to scan (SECU-08). The poll
 *    also runs when the tab regains focus and when that page reports the wallet came back.
 * 2. Confirm: the identity that answered, shortened as the wallet's approval screen shows it (the
 *    response does not prove who answered). "That's me, continue" or "Not me, start over".
 * 3. Protect: "Add a passkey" leads; "Skip for now" keeps the spend-capped key in this browser
 *    alone; a password is under a disclosure.
 *
 * Released wallets answer App Connect v2 on the `dashpay://connect` carrier (DashPay for Android
 * 11.9.2, Dash Wallet for iOS 9.1.4; `dash-key:` is refused on mainnet;
 * on testnet, Android's testnet build is the one verified). Where v2 cannot be offered, the flow
 * says so and points at the other ways to sign in.
 *
 * `mode="renew"` renews the signed-in session's key in the wallet that granted it (origin
 * `app-connect`; on testnet any browser key, which the wallet then leaves live): the protection
 * for the new key is chosen BEFORE the code shows (the wallet disables the old key when it
 * approves), the request names the identity, and the new key is stored without a confirm step.
 *
 * Granted keys are held in refs, never React state, and dropped when the sheet closes.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Fingerprint, RefreshCw, Smartphone } from 'lucide-react'
import { FiatNote } from '@/components/ui/fiat-note'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { PendingRenewalChoiceError, PendingRenewalLockedError, UnlockNeededError, type WalletRenewalRequest } from '@/lib/auth/controller'
import { Button } from '@/components/ui/button'
import { UnlockMore } from '@/components/auth/unlock-more'
import { Field, Input } from '@/components/ui/input'
import { Qr } from '@/components/ui/qr'
import { ErrorBox, useProtection } from '@/components/auth/protection-fields'
import { Waiting } from '@/components/auth/step-status'
import { ScanOnlyHere, ScanSafety } from '@/components/auth/scan-warning'
import { enrollPasskey, passkeysAvailable, type Protection } from '@/lib/auth'
import type { UnlockKind } from '@/lib/auth/vault'
import { shortId } from '@/lib/utils'
import { ACTIVE_NETWORK } from '@/lib/constants'
import { creditsToDash } from '@/lib/sdk/cost'
import {
  PollTrigger,
  RequestExpired,
  appConnectV2Available,
  awaitV2Grant,
  disposeV2Request,
  newV2LoginRequest,
  readChainClock,
  type PollStatus,
  type V2Grant,
  type V2LoginRequest,
  recordGrantedApp,
  wipeGrant,
} from '@/lib/auth/app-connect-v2'
import { connectionId } from '@/lib/auth/connection-id'
import { callbackStatusCopy, connectCallbackUrl, listenForCallback } from '@/lib/auth/connect-callback'
import { defaultLimits } from '@/lib/auth/limited-key'
import type { ForgeIds } from '@/lib/deployments'
import { responderProfile, type ResponderProfile } from '@/lib/auth/responder-profile'
import { isAbort } from '@/lib/sdk/facade'
import { PHASE_TEXT, connectPlatform } from '@/lib/auth/connect'
import { creditsAsDash, formatDate } from '@/lib/view/format'
import { useCopy } from '@/hooks/use-copy'
import type { KeyLimits } from '@/lib/view/funds'
import { errorMessage } from '@/lib/utils'

type Sdk = Awaited<ReturnType<typeof connectPlatform>>

/** What a v2 request asks the wallet for: the budget (credits) and the proposed expiry (ms). */
interface V2Terms {
  readonly budget: bigint | null
  readonly expiresAt: number | null
}

type Step =
  /** `linkUri`: the phone's deep link (it carries the callback); `terms`: what the request asks for. */
  | { readonly kind: 'request'; readonly uri: string; readonly linkUri: string; readonly expiresAt: number; readonly terms: V2Terms }
  | {
      readonly kind: 'confirm'
      readonly profile: ResponderProfile
      /** The grant's limits (as the chain records them), and the group check's notice. */
      readonly limits: KeyLimits | null
      readonly notice: string | null
    }
  /** A locked vault holds a wallet key that a new approval would disable: unlock it first. */
  | { readonly kind: 'blocked'; readonly message: string }
  /**
   * A renewal's new key is granted (the wallet has already disabled the old one) and is being
   * stored. When storing needs a decision or an unlock (an unfinished renewal on this device, a
   * locked vault), the grant is held here to try again; closing the sheet drops it.
   */
  | { readonly kind: 'renew-store' }
  | { readonly kind: 'expired' }

/** The QR step for a request, with its primary binding's terms. */
function requestStep(req: V2LoginRequest): Step {
  const binding = req.request.authBindings[0]
  const terms: V2Terms = { budget: binding?.totalBudget ?? null, expiresAt: binding?.expiresAt ?? null }
  return { kind: 'request', uri: req.qrUri, linkUri: req.linkUri, expiresAt: req.expiresAt, terms }
}

/**
 * Poll for the wallet's v2 answer, and poll at once when the tab regains focus or becomes visible
 * (the user comes back from the wallet) or the `/connect/` page reports the wallet returned
 * (`onReturn` gets the status it carries). The request is spent however this ends.
 */
function awaitGrantWithWake(
  sdk: Parameters<typeof awaitV2Grant>[0],
  req: V2LoginRequest,
  p: Omit<Parameters<typeof awaitV2Grant>[2], 'trigger'> & { readonly onReturn?: (status: string | null) => void },
): Promise<V2Grant> {
  const { onReturn, ...rest } = p
  const trigger = new PollTrigger()
  const wake = (): void => trigger.fire()
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') trigger.fire()
  }
  let stopCallback = (): void => undefined
  const stop = (): void => {
    window.removeEventListener('focus', wake)
    document.removeEventListener('visibilitychange', onVisible)
    stopCallback()
  }
  try {
    window.addEventListener('focus', wake)
    document.addEventListener('visibilitychange', onVisible)
    stopCallback = listenForCallback(req.requestHash, (status) => {
      onReturn?.(status)
      wake()
    })
  } catch (e) {
    stop()
    disposeV2Request(req)
    return Promise.reject(e)
  }
  return awaitV2Grant(sdk, req, { ...rest, trigger }).finally(stop)
}

/**
 * A phone or tablet browser: the wallet is on this device, so a link beats a QR. Dash Wallet
 * exists for Android and iOS only, so a desktop browser gets the QR alone.
 */
function onMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData
  return uaData?.mobile ?? /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
}

export function WalletConnectFlow({
  onDone,
  mode = 'login',
  onUnlock,
}: {
  onDone: () => void
  mode?: 'login' | 'renew'
  /** Open the sheet's Unlock view (a v2 sign-in that must wait for a locked wallet key to be opened). */
  onUnlock?: () => void
}): JSX.Element {
  const { adoptWalletKeys, isLoading, vaults, unlockScope, controller, origin, identity } = useAuth()
  // Read when the request starts (a scope change must not restart a running request).
  const scopeRef = useRef(unlockScope)
  scopeRef.current = unlockScope
  const forge = ACTIVE_NETWORK.v2
  const [step, setStep] = useState<Step | null>(null)
  const [status, setStatus] = useState<PollStatus>('waiting')
  const [error, setError] = useState<string | null>(null)
  /** An unfinished renewal on this device (D-016): the choice to finish it or give it up. */
  const [pendingRenewal, setPendingRenewal] = useState<string | null>(null)
  /**
   * Giving it up needs its key opened (kept so the next renewal or revoke disables it): its own
   * passphrase or passkey, when the one chosen here is not it.
   */
  const [renewalLocked, setRenewalLocked] = useState<{ message: string; methods: readonly UnlockKind[] } | null>(null)
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
  /** The protection picked on the protect step (after "That's me"). */
  const picked = useRef<Protection | null>(null)
  /** The grant held for the confirm step. */
  const grant = useRef<V2Grant | null>(null)
  const dropGrant = useCallback(() => {
    wipeGrant(grant.current)
    grant.current = null
  }, [])
  /**
   * Whether the request asks for forge-user's encryption key (settings sync, where deployed). A
   * wallet that reports it cannot use such a request (`unsupported`, `invalid`), or a request that
   * expired unanswered, is asked once more without it (docs/design/identity-synced-state.md §8).
   */
  const syncBinding = useRef(true)
  /** The app the held grant's request named: forge-user when it asked for the sync key. */
  const grantApp = useRef<string | null>(null)
  const syncRetried = useRef(false)
  const retryWithoutSync = useCallback((): boolean => {
    if (syncRetried.current || forge?.user === undefined) return false
    syncRetried.current = true
    syncBinding.current = false
    return true
  }, [forge])
  const mobile = onMobile()
  // A renewal never weakens a key that had a passkey or passphrase.
  const heldMethods = vaults.find((v) => v.staged !== true && v.identityId === identity)?.methods ?? []
  const { fields, protection, problem } = useProtection({ allowDevice: mode !== 'renew' || heldMethods.every((m) => m === 'device') })
  /**
   * Renewal: the protection for the new key is chosen first (the wallet disables the old key when
   * it approves), then the code shows. `renewGo` flips on that choice; the protection is kept for
   * a retry. The renewal is of the signed-in session; its tab must be fully unlocked.
   */
  const [renewGo, setRenewGo] = useState(false)
  const renewProtection = useRef<NonNullable<typeof protection> | null>(null)
  const needsUnlock = mode === 'renew' && unlockScope === 'signing'
  /** A wallet renewal whose new key is not stored yet: its mark ends if the sheet closes first. */
  const renewalReq = useRef<WalletRenewalRequest | null>(null)
  /** What the wallet's return page reported (`ac`), when it was a failure. */
  const [reported, setReported] = useState<string | null>(null)
  // Read at request time, not effect deps: a change must not restart a request mid-flow (the
  // identity changes from null to the new one inside the login itself).
  const latest = useRef({ adoptWalletKeys, controller, stored: vaults.map((v) => v.identityId) })
  latest.current = { adoptWalletKeys, controller, stored: vaults.map((v) => v.identityId) }
  // The sign-in sheet: unlocking there finishes an unfinished renewal with its passphrase.
  const openLogin = useUiStore((s) => s.openLogin)
  // The sheet closes with a renewal's new key unstored (the old one is already disabled): no key
  // is being replaced after all, so other tabs stop expecting one.
  const mounted = useRef(true)
  /** A renewal's new key is being stored now: the mark ends with that attempt, not with the sheet. */
  const storing = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (renewalReq.current && !storing.current) latest.current.controller.endWalletRenewal(renewalReq.current)
    }
  }, [])

  // A reloaded tab holds the signing key only: storing the wallet's keys over the stored key
  // (carrying its grants and settings across) needs the vault open. Unlock, then carry on.
  const [unlockFirst, setUnlockFirst] = useState<(() => void) | null>(null)
  /**
   * Store the wallet's keys. `discard`: give up an unfinished renewal on this device first,
   * keeping its key (opened with `renewalUnlock` when given) for the next revoke to disable;
   * `drop`: give it up without its key.
   */
  const finish = async (discard: boolean, renewalUnlock?: { passphrase: string } | 'passkey', drop = false): Promise<void> => {
    const g = grant.current
    // A renewal stores with the protection chosen before its code showed (its fields are gone).
    const chosen = (mode === 'renew' ? renewProtection.current : null) ?? picked.current ?? protection
    if (!g) return
    if (!chosen) {
      setError('Choose how to protect the new key first.')
      return
    }
    setError(null)
    storing.current = renewalReq.current !== null
    try {
      await adoptWalletKeys(g.identityId, [g.key], chosen, {
        origin: 'app-connect',
        ...(g.syncKey ? { syncKey: g.syncKey } : {}),
        discardPendingRenewal: discard,
        ...(renewalUnlock ? { renewalUnlock } : {}),
        ...(drop ? { dropUnopened: true } : {}),
      })
      recordGrantedApp(ACTIVE_NETWORK.key, g.identityId, grantApp.current)
      dropGrant()
      // Stored: the controller already ended a wallet renewal's mark.
      renewalReq.current = null
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
      // The sheet closed while this was storing, so nothing will retry: the old key is not being replaced.
      if (!mounted.current && renewalReq.current) {
        latest.current.controller.endWalletRenewal(renewalReq.current)
        renewalReq.current = null
      }
    } finally {
      storing.current = false
    }
  }

  // The effect below stores a renewal's grant through the latest render's `finish`.
  const finishRef = useRef(finish)
  finishRef.current = finish

  useEffect(() => {
    const abort = new AbortController()
    const signal = abort.signal
    setError(null)
    setConfirmed(false)
    setStatus('waiting')
    setReported(null)
    void (async () => {
      try {
        if (!forge) throw new Error('Dash Forge is not deployed here')
        // A renewal waits for its protection (chosen before the code shows) and for a full unlock.
        if (mode === 'renew' && (!renewGo || scopeRef.current === 'signing')) return
        const sdk = await connectPlatform(ACTIVE_NETWORK.network, (p) => !signal.aborted && setPreparing(PHASE_TEXT[p]))
        if (signal.aborted) return
        if (mode === 'renew') {
          await runRenewal(sdk, forge)
          return
        }
        setPreparing('Checking what your wallet can answer')
        const notice = await groupNotice(sdk)
        if (signal.aborted) return
        await runV2Login(sdk, forge, notice)
      } catch (e) {
        if (signal.aborted || isAbort(e)) return
        if (e instanceof RequestExpired) {
          if (retryWithoutSync()) setAttempt((a) => a + 1)
          else setStep({ kind: 'expired' })
        } else {
          // A request that failed is spent (its key is gone): it must not stay up to be scanned.
          setStep((cur) => (cur?.kind === 'request' ? null : cur))
          setError(errorMessage(e))
        }
      }
    })()

    /** The group check's notice for the confirm step; throws {@link NOT_OFFERED} where v2 can't be offered. */
    async function groupNotice(sdk: Sdk): Promise<string | null> {
      const available = await appConnectV2Available(sdk, ACTIVE_NETWORK.network)
      if (available === null) throw new Error(UNREAD)
      if (!available) throw new Error(NOT_OFFERED)
      try {
        // Forge's own group check, before any code shows.
        return (await latest.current.controller.checkGroup()).notice
      } catch (e) {
        // Only Forge's refusal of the group means "no v2 here"; a failed read is shown, with Try again.
        if (errorMessage(e).startsWith('refusing to bind')) throw new Error(NOT_OFFERED)
        throw e
      }
    }

    /** What both v2 paths pass the poll: status updates only while this request is current. */
    const pollOptions = (forge: ForgeIds): Parameters<typeof awaitGrantWithWake>[2] => ({
      network: ACTIVE_NETWORK.network,
      forge,
      signal,
      onStatus: (s) => {
        if (!signal.aborted) setStatus(s)
      },
      onReturn: (status) => {
        if (signal.aborted) return
        if ((status === 'unsupported' || status === 'invalid') && retryWithoutSync()) {
          abort.abort()
          setStep(null)
          setAttempt((a) => a + 1)
          return
        }
        setReported(status)
      },
    })

    /** v2 sign-in: one request, then the confirm step (nobody is named, so anyone could answer). */
    async function runV2Login(sdk: Sdk, forge: ForgeIds, notice: string | null): Promise<void> {
      // Any approval disables the key of this browser's previous grant: a locked vault that holds
      // one is opened first, while it still can be.
      const blocker = await latest.current.controller.walletSignInBlocker()
      if (signal.aborted) return
      if (blocker !== null) {
        setStep({ kind: 'blocked', message: blocker })
        return
      }
      const { timeMs } = await readChainClock(sdk)
      if (signal.aborted) return
      const req = newV2LoginRequest(ACTIVE_NETWORK.network, forge, {
        connectionId: connectionId(ACTIVE_NETWORK.key),
        chainNow: timeMs,
        callbackUrl: connectCallbackUrl,
        sync: syncBinding.current,
      })
      setStep(requestStep(req))
      const granted = await awaitGrantWithWake(sdk, req, pollOptions(forge))
      if (signal.aborted) return
      grantApp.current = req.syncContract
      grant.current = granted
      const profile = await responderProfile(sdk, granted.identityId, ACTIVE_NETWORK.network, latest.current.stored)
      if (signal.aborted) return
      setStep({ kind: 'confirm', profile, limits: granted.key.limits, notice })
    }

    /** Renewal: the wallet that granted this browser's key grants a new one (no confirm: the identity is known). */
    async function runRenewal(sdk: Sdk, forge: ForgeIds): Promise<void> {
      if (!renewProtection.current) throw new Error('Choose how to protect the new key first.')
      const auth = latest.current.controller
      const req = await auth.walletRenewalRequest({ callbackUrl: connectCallbackUrl, sync: syncBinding.current })
      let granted: V2Grant
      try {
        if (signal.aborted) {
          disposeV2Request(req)
          auth.endWalletRenewal(req)
          return
        }
        setStep(requestStep(req))
        granted = await awaitGrantWithWake(sdk, req, pollOptions(forge))
      } catch (e) {
        // Cancelled, expired or refused: the old key is not being replaced after all.
        auth.endWalletRenewal(req)
        throw e
      }
      // The wallet has answered, so it has disabled the old key: store the new one now, even if
      // the sheet is closing. When that needs a decision or an unlock, the grant is held for it.
      renewalReq.current = req
      grantApp.current = req.syncContract
      grant.current = granted
      setStep({ kind: 'renew-store' })
      await finishRef.current(false)
    }
    return () => {
      abort.abort()
      dropGrant()
    }
    // `attempt` restarts the whole request (a new ephemeral key and QR).
  }, [attempt, forge, mode, dropGrant, renewGo, needsUnlock, retryWithoutSync])

  const restart = useCallback(() => {
    // The spent request goes off screen; the next one replaces it.
    setStep(null)
    setAttempt((a) => a + 1)
  }, [])

  if (needsUnlock) return <UnlockMore title="Unlock this tab to renew in your wallet" testId="renew-unlock" />
  // A renewal asks how to protect the new key before its code shows: the wallet disables the old
  // key as it approves, so the new one must be storable the moment the answer arrives.
  if (mode === 'renew' && !renewGo) {
    const defaults = defaultLimits()
    return (
      <div className="space-y-3" data-testid="wallet-renew-prepare">
        <p className="text-dense">Approve a new key in your wallet.</p>
        <details className="text-[12px] text-anvil-500 dark:text-anvil-400">
          <summary className="cursor-pointer coarse:py-2">Details</summary>
          <div className="space-y-1 pt-1">
            <p>
              {origin === 'app-connect'
                ? 'Approving adds a new key and disables the current one.'
                : 'Approving adds a new key beside the current one, which stays live until you revoke it.'}
            </p>
            <p data-testid="approval-terms">
              <ApprovalTerms budget={defaults.budgetCredits} expiresAt={defaults.expiresAt} />
            </p>
          </div>
        </details>
        {fields}
        <Button
          variant="primary"
          className="w-full"
          disabled={protection === null}
          onClick={() => {
            renewProtection.current = protection
            setRenewGo(true)
          }}
        >
          Continue to your wallet
        </Button>
        {problem ? <p className="text-[12px] text-anvil-500 dark:text-anvil-400">{problem}</p> : null}
      </div>
    )
  }
  if (step?.kind === 'blocked') {
    return (
      <div className="space-y-3" data-testid="wallet-blocked">
        <p className="text-dense">{step.message}</p>
        <div className="flex flex-wrap gap-2">
          {onUnlock ? (
            <Button variant="primary" onClick={onUnlock}>
              Unlock
            </Button>
          ) : null}
        </div>
      </div>
    )
  }
  /** An unfinished renewal on this device that storing the wallet's keys ran into: the choice, and its unlock. */
  const pendingRenewalUi =
    pendingRenewal !== null ? (
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
    ) : null
  if (step?.kind === 'renew-store') {
    return (
      <div className="space-y-3" data-testid="wallet-renew-store">
        <p className="text-dense">{origin === 'app-connect' ? 'Your wallet gave this browser a new key and disabled the old one. Forge has not stored the new key yet.' : 'Your wallet gave this browser a new key. Forge has not stored the new key yet.'}</p>
        {pendingRenewalUi}
        {unlockFirst ? <UnlockMore title="Unlock this tab to store the new key" testId="wallet-unlock" then={unlockFirst} /> : null}
        <ErrorBox error={error} />
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={isLoading} onClick={() => void finish(false)}>
            Store the new key
          </Button>
        </div>
      </div>
    )
  }
  if (step?.kind === 'confirm') {
    const { profile } = step
    if (confirmed) {
      return (
        <div className="space-y-3" data-testid="wallet-protect">
          <ProtectStep
            busy={isLoading}
            onPick={(p) => {
              picked.current = p
              void finish(false)
            }}
          />
          {pendingRenewalUi}
          {unlockFirst ? <UnlockMore title="Unlock this tab to finish signing in with your wallet" testId="wallet-unlock" then={unlockFirst} /> : null}
          <ErrorBox error={error} />
        </div>
      )
    }
    return (
      <div className="space-y-3" data-testid="wallet-confirm">
        <p className="text-dense">
          Signed in as <span className="font-medium">{profile.name ?? 'an identity with no username'}</span>
        </p>
        <div className="flex items-center gap-2">
          <span data-testid="granted-identity" title={profile.identityId} className="font-mono text-dense">
            {shortId(profile.identityId)}
          </span>
          <CopyId id={profile.identityId} />
        </div>
        {profile.warnings.map((w) => (
          <p key={w} role="alert" data-testid="responder-warning" className="rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense text-caution-700 dark:text-caution-400">
            {w} If you didn&apos;t expect this, someone else may have answered your code.
          </p>
        ))}
        {step.limits?.total != null ? (
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="approval-terms">
            <ApprovalTerms budget={step.limits.total} expiresAt={step.limits.expiresAt} granted />
          </p>
        ) : null}
        {step.notice ? (
          <p role="note" data-testid="group-notice" className="text-[12px] text-anvil-500 dark:text-anvil-400">
            {step.notice}
          </p>
        ) : null}
        <Button variant="primary" className="w-full" onClick={() => setConfirmed(true)} data-testid="wallet-confirm-me">
          That&apos;s me, continue
        </Button>
        {profile.warnings.length > 0 ? (
          <Button variant="outline" className="w-full" onClick={restart} data-testid="wallet-not-me">
            Not me, start over
          </Button>
        ) : (
          <button type="button" onClick={restart} className="hit-area mx-auto block text-[12px] text-anvil-500 underline dark:text-anvil-400" data-testid="wallet-not-me">
            Not me, start over
          </button>
        )}
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

  const request = step?.kind === 'request' ? step : null
  const reportedCopy = request ? callbackStatusCopy(reported) : undefined
  const openLink = request ? (
    <a
      href={request.linkUri}
      data-testid="wallet-deep-link"
      className={mobile ? MOBILE_LINK : DESKTOP_LINK}
    >
      <Smartphone className="h-4 w-4" aria-hidden /> Open in wallet
    </a>
  ) : null
  return (
    <div className="space-y-3" data-testid="wallet-request">
      {request ? (
        <p className="text-center text-[15px] font-medium">{mode === 'renew' ? 'Approve in your wallet' : 'Scan with your Dash wallet'}</p>
      ) : null}
      {request ? (
        mobile ? (
          <>
            {openLink}
            <details className="text-[12px] text-anvil-500 dark:text-anvil-400">
              <summary className="cursor-pointer coarse:py-3">Wallet on another device? Show the QR code</summary>
              <div className="pt-2">
                <Qr value={request.uri} label="Wallet login request" size={180} caption={null} />
              </div>
            </details>
          </>
        ) : (
          <>
            <Qr value={request.uri} label="Wallet login request" size={220} caption={null} />
            <p className="text-center text-dense text-anvil-600 dark:text-anvil-300">Open DashPay → Connections and scan.</p>
          </>
        )
      ) : error ? null : (
        <Waiting label={preparing} />
      )}
      {request ? <Countdown until={request.expiresAt} /> : null}
      {request && !mobile ? (
        <div className="flex justify-center gap-2">
          <CopyLink uri={request.uri} />
          {openLink}
        </div>
      ) : null}
      {request ? <ScanOnlyHere /> : null}
      {status === 'incomplete-read' && request ? (
        <p className="text-center text-[12px] text-caution-700 dark:text-caution-400" data-testid="incomplete-read">
          Still checking for your wallet&apos;s answer…
        </p>
      ) : null}
      {reportedCopy ? (
        <p role="status" data-testid="wallet-reported" className="rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense">
          {reportedCopy.title}. {reportedCopy.body}
        </p>
      ) : null}
      {request ? (
        <details className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="wallet-details">
          <summary className="cursor-pointer text-center coarse:py-2">Details</summary>
          <div className="space-y-2 pt-2">
            <p data-testid="approval-terms">
              {mode === 'renew' && origin !== 'app-connect' ? 'Approve in the wallet that holds this identity. ' : null}
              <ApprovalTerms budget={request.terms.budget} expiresAt={request.terms.expiresAt} />
            </p>
            <ScanSafety syncs={syncBinding.current && ACTIVE_NETWORK.v2?.user !== undefined} />
            {mode === 'login' ? <WalletSupportNote /> : null}
          </div>
        </details>
      ) : null}
      <ErrorBox error={error} />
      {error ? (
        <Button
          variant="primary"
          className="w-full"
          onClick={() => {
            // Once: the next request is the one without settings sync, which any wallet reads.
            retryWithoutSync()
            restart()
          }}
        >
          <RefreshCw className="h-4 w-4" aria-hidden /> Try again
        </Button>
      ) : null}
    </div>
  )
}

function CopyId({ id }: { id: string }): JSX.Element {
  const [copied, copy] = useCopy(id)
  return (
    <button
      type="button"
      className="hit-area text-anvil-500 hover:text-anvil-800 dark:text-anvil-400 dark:hover:text-anvil-100"
      aria-label={copied ? 'Copied' : 'Copy identity id'}
      onClick={() => void copy()}
    >
      <Copy className="h-3.5 w-3.5" aria-hidden />
    </button>
  )
}

const MOBILE_LINK = 'flex w-full items-center justify-center gap-2 rounded-md bg-forge-700 px-4 py-3 text-dense font-medium text-white hover:bg-forge-800'
const DESKTOP_LINK = 'inline-flex items-center gap-1.5 rounded-md border border-anvil-300 px-3 py-1.5 text-[13px] hover:bg-anvil-50 dark:border-anvil-700 dark:hover:bg-anvil-850'

/** Copies the request link (for a wallet on this device that did not open from the button). */
function CopyLink({ uri }: { uri: string }): JSX.Element {
  const [copied, copy] = useCopy(uri)
  return (
    <button
      type="button"
      data-testid="wallet-copy-link"
      onClick={() => void copy()}
      className="inline-flex items-center gap-1.5 rounded-md border border-anvil-300 px-3 py-1.5 text-[13px] hover:bg-anvil-50 dark:border-anvil-700 dark:hover:bg-anvil-850"
    >
      <Copy className="h-4 w-4" aria-hidden /> {copied ? 'Copied' : 'Copy link'}
    </button>
  )
}

/**
 * After "That's me": the key is kept by this browser unless the user adds a passkey (the obvious
 * next step) or a password. Without passkey support, Continue keeps it in this browser.
 */
function ProtectStep({ onPick, busy }: { onPick: (p: Protection) => void; busy: boolean }): JSX.Element {
  const canPasskey = passkeysAvailable()
  const [enrolling, setEnrolling] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const { fields, protection, problem: passwordProblem } = useProtection({ passwordOnly: true, onSubmit: () => savePassword() })
  const savePassword = (): void => {
    if (busy) return
    if (protection === null || protection.device) setProblem(passwordProblem ?? 'Enter a passphrase first.')
    else onPick(protection)
  }
  const addPasskey = async (): Promise<void> => {
    setEnrolling(true)
    setProblem(null)
    try {
      const p = await enrollPasskey(`Dash Forge (${new Date().toISOString().slice(0, 10)})`)
      if (p === null) setProblem("This passkey can't protect keys here. Skip for now, or use a password.")
      else onPick({ passkey: p })
    } catch (e) {
      setProblem(`${errorMessage(e, 'Passkey setup was cancelled')}. Skip for now, or use a password.`)
    } finally {
      setEnrolling(false)
    }
  }
  return (
    <>
      <p className="text-dense font-medium">{canPasskey ? 'Add a passkey?' : "You're almost in"}</p>
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
        {canPasskey ? 'Unlock Forge on this device with Touch ID, Windows Hello or a security key.' : 'Forge keeps your spend-capped key in this browser.'}
      </p>
      {canPasskey ? (
        <Button variant="primary" className="w-full" loading={enrolling || busy} onClick={() => void addPasskey()} data-testid="protect-passkey">
          <Fingerprint className="h-4 w-4" aria-hidden /> Add a passkey
        </Button>
      ) : (
        <Button variant="primary" className="w-full" loading={busy} onClick={() => onPick({ device: true })} data-testid="protect-skip">
          Continue
        </Button>
      )}
      {canPasskey ? (
        <button
          type="button"
          disabled={busy || enrolling}
          onClick={() => onPick({ device: true })}
          className="hit-area mx-auto block text-[12px] text-anvil-500 underline dark:text-anvil-400"
          data-testid="protect-skip"
        >
          Skip for now
        </button>
      ) : null}
      {problem ? <p className="text-[12px] text-caution-700 dark:text-caution-400">{problem}</p> : null}
      <details className="text-dense" data-testid="protect-password">
        <summary className="cursor-pointer text-[12px] text-anvil-600 dark:text-anvil-300 coarse:py-2">Use a password instead</summary>
        <div className="space-y-2 pt-2">
          {fields}
          <Button variant="outline" size="sm" loading={busy} onClick={savePassword} data-testid="protect-password-save">
            Save with password
          </Button>
        </div>
      </details>
    </>
  )
}

/** Why the wallet flow cannot start here: App Connect v2 is not on offer. */
const NOT_OFFERED = `Wallet sign-in isn't available on ${ACTIVE_NETWORK.key} right now. Choose another way.`

/** Platform did not answer the protocol check in time. */
const UNREAD = "Couldn't read Platform to check what your wallet can answer. Try again."

export const DASHPAY_ANDROID_RELEASES = 'https://github.com/dashpay/dash-wallet/releases/latest'

/**
 * Which wallets can answer here (docs/design/wallet-primary.md, checked 2026-11-22): App Connect
 * v2 in DashPay for Android 11.9.2 and Dash Wallet for iOS 9.1.4. On testnet only Android's
 * testnet build (an APK on the GitHub release) is verified, so only it is named there.
 */
function WalletSupportNote(): JSX.Element {
  return (
    <p data-testid="wallet-support" className="text-[12px] text-anvil-500 dark:text-anvil-400">
      {ACTIVE_NETWORK.network === 'testnet' ? (
        <>
          Works with DashPay for Android 11.9.2 or later, which reads App Connect v2 dashpay://connect codes. On testnet, use its testnet build (More → Tools → Connections): the{' '}
          <code>-testnet.apk</code> on the{' '}
          <a href={DASHPAY_ANDROID_RELEASES} target="_blank" rel="noreferrer" className="text-forge-700 underline dark:text-forge-400">
            DashPay Wallet releases (opens in a new tab)
          </a>
          .
        </>
      ) : (
        'Works with DashPay for Android 11.9.2 or later and Dash Wallet for iOS 9.1.4 or later (More → Tools → Connections), which read App Connect v2 dashpay://connect codes.'
      )}
    </p>
  )
}

/**
 * What one v2 approval covers: all of Forge, up to a budget (credits) until a date. `granted`:
 * the limits the chain records after the wallet's approval; else the ones Forge proposes, which
 * the wallet may change.
 */
function ApprovalTerms({ budget, expiresAt, granted = false }: { budget: bigint | null; expiresAt: number | null; granted?: boolean }): JSX.Element {
  const dash = budget === null ? null : creditsToDash(Number(budget))
  return (
    <>
      One approval covers all of Forge
      {dash !== null ? (
        <>
          , {granted ? 'with spending capped at' : 'spending up to'} {creditsAsDash(Number(budget))} DASH
          <FiatNote dash={dash} kind="bound" />
        </>
      ) : null}
      {expiresAt !== null ? <> until {formatDate(expiresAt)}</> : null}.{granted ? '' : ' Your wallet may offer other limits.'}
    </>
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
