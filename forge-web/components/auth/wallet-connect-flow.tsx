'use client'

/**
 * "Use my Dash wallet" with App Connect v2 (`lib/auth/app-connect-v2.ts`; docs/design/wallet-login.md).
 *
 * 1. Request: an App Connect v2 QR (and, on a phone, an "Open in DashPay (Dash Wallet)" link that
 *    carries a callback to `/connect/`), with a countdown. ONE request, one approval, one key bound
 *    to the whole Forge contract group with a budget and an expiry. The poll also runs when the tab
 *    regains focus and when that page reports the wallet came back (`lib/auth/connect-callback.ts`).
 * 2. Confirm: the identity that answered. The response does not prove who answered: anyone who
 *    saw the QR could. So the user compares the username and id with what the wallet's approval
 *    screen showed (the username and a shortened id), and is warned when the identity has no
 *    username, a brand-new one, or is not the one this device already holds.
 *
 * The QR step opens with {@link ScanOnlyHere}: the request does not say who shows it, so the
 * user is told to scan only a code on this site's own address (SECU-08).
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
import { AlertTriangle, RefreshCw, Smartphone } from 'lucide-react'
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
import { ScanOnlyHere } from '@/components/auth/scan-warning'
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
} from '@/lib/auth/app-connect-v2'
import { connectionId } from '@/lib/auth/connection-id'
import { callbackStatusCopy, connectCallbackUrl, listenForCallback } from '@/lib/auth/connect-callback'
import { defaultLimits } from '@/lib/auth/limited-key'
import type { ForgeIds } from '@/lib/deployments'
import { responderProfile, type ResponderProfile } from '@/lib/auth/responder-profile'
import { isAbort } from '@/lib/sdk/facade'
import { PHASE_TEXT, connectPlatform } from '@/lib/auth/connect'
import { creditsAsDash, formatDate } from '@/lib/view/format'
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
  const { adoptWalletKeys, isLoading, vaults, unlockScope, controller, origin } = useAuth()
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
  /** The grant held for the confirm step. */
  const grant = useRef<V2Grant | null>(null)
  const dropGrant = useCallback(() => {
    grant.current = null
  }, [])
  const mobile = onMobile()
  const { fields, protection, problem } = useProtection()
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
    const chosen = (mode === 'renew' ? renewProtection.current : null) ?? protection
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
        discardPendingRenewal: discard,
        ...(renewalUnlock ? { renewalUnlock } : {}),
        ...(drop ? { dropUnopened: true } : {}),
      })
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
        if (e instanceof RequestExpired) setStep({ kind: 'expired' })
        else {
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
        if (!signal.aborted) setReported(status)
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
      })
      setStep(requestStep(req))
      const granted = await awaitGrantWithWake(sdk, req, pollOptions(forge))
      if (signal.aborted) return
      grant.current = granted
      const profile = await responderProfile(sdk, granted.identityId, ACTIVE_NETWORK.network, latest.current.stored)
      if (signal.aborted) return
      setStep({ kind: 'confirm', profile, limits: granted.key.limits, notice })
    }

    /** Renewal: the wallet that granted this browser's key grants a new one (no confirm: the identity is known). */
    async function runRenewal(sdk: Sdk, forge: ForgeIds): Promise<void> {
      if (!renewProtection.current) throw new Error('Choose how to protect the new key first.')
      const auth = latest.current.controller
      const req = await auth.walletRenewalRequest({ callbackUrl: connectCallbackUrl })
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
      grant.current = granted
      setStep({ kind: 'renew-store' })
      await finishRef.current(false)
    }
    return () => {
      abort.abort()
      dropGrant()
    }
    // `attempt` restarts the whole request (a new ephemeral key and QR).
  }, [attempt, forge, mode, dropGrant, renewGo, needsUnlock])

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
        <p className="text-dense">
          {origin === 'app-connect'
            ? 'Your wallet gave this browser its key. A new request goes to the same wallet: when you approve, it adds a new key and disables the current one.'
            : origin === 'passkey'
              ? 'A passkey brought this key here. If a wallet made it, approve a new request there: it adds a key, and this one stays live until Revoke on Platform or a renewal with your identity file disables it.'
              : "Your wallet didn't make this browser's key, so approving adds a new key beside it: the current one stays live until Revoke on Platform or a renewal with your identity file disables it."}
        </p>
        <p className="text-dense" data-testid="approval-terms">
          <ApprovalTerms budget={defaults.budgetCredits} expiresAt={defaults.expiresAt} />
        </p>
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
        {step.limits?.total != null ? (
          <p className="text-dense" data-testid="approval-terms">
            <ApprovalTerms budget={step.limits.total} expiresAt={step.limits.expiresAt} granted />
          </p>
        ) : null}
        {step.notice ? (
          <p role="note" data-testid="group-notice" className="rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-[12px]">
            {step.notice}
          </p>
        ) : null}
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
        {pendingRenewalUi}
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

  const request = step?.kind === 'request' ? step : null
  const reportedCopy = request ? callbackStatusCopy(reported) : undefined
  // Said where the QR is on screen: a phone's QR sits in a collapsed disclosure.
  const qrPrivate = <p className="text-dense">Keep this QR code private: anyone who scans it can answer it.</p>
  return (
    <div className="space-y-3" data-testid="wallet-request">
      {request ? (
        <p className="text-dense" data-testid="approval-terms">
          {mode === 'renew'
            ? origin === 'app-connect'
              ? 'Approve the renewal in the wallet that gave this browser its key. '
              : 'Approve in the wallet that holds this identity. '
            : 'Approve in your wallet. '}
          <ApprovalTerms budget={request.terms.budget} expiresAt={request.terms.expiresAt} />
        </p>
      ) : null}
      {request ? <ScanOnlyHere /> : null}
      {request ? (
        mobile ? (
          <>
            <a
              href={request.linkUri}
              data-testid="wallet-deep-link"
              className="flex w-full items-center justify-center gap-2 rounded-md bg-forge-700 px-4 py-3 text-dense font-medium text-white hover:bg-forge-800"
            >
              <Smartphone className="h-4 w-4" aria-hidden /> Open in DashPay (Dash Wallet)
            </a>
            <details className="text-[12px] text-anvil-500 dark:text-anvil-400">
              <summary className="cursor-pointer coarse:py-3">Wallet on another device? Show the QR code</summary>
              <div className="space-y-2 pt-2">
                <Qr value={request.uri} label="Wallet login request" size={180} />
                {qrPrivate}
              </div>
            </details>
          </>
        ) : (
          <>
            <Qr value={request.uri} label="Wallet login request" size={200} />
            {qrPrivate}
          </>
        )
      ) : error ? null : (
        <Waiting label={preparing} />
      )}
      {status === 'incomplete-read' && request ? (
        <p className="text-[12px] text-caution-700 dark:text-caution-400" data-testid="incomplete-read">
          Couldn&apos;t read all answer sources — retrying. Forge won&apos;t accept an answer until it has read them all.
        </p>
      ) : null}
      {request ? <Countdown until={request.expiresAt} /> : null}
      {mode === 'login' && request ? <WalletSupportNote /> : null}
      {reportedCopy ? (
        <p role="status" data-testid="wallet-reported" className="rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense">
          {reportedCopy.title}. {reportedCopy.body}
        </p>
      ) : null}
      <ErrorBox error={error} />
      {error ? (
        <Button variant="outline" className="w-full" onClick={restart}>
          <RefreshCw className="h-4 w-4" aria-hidden /> Try again
        </Button>
      ) : null}
    </div>
  )
}

/** Why the wallet flow cannot start here: App Connect v2 is not on offer. */
const NOT_OFFERED = `Wallet sign-in needs App Connect v2, which can't be offered on ${ACTIVE_NETWORK.key} right now. Sign in with your recovery phrase or identity file, or create an identity in the browser.`

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
