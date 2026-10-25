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
 * The QR step opens with {@link ScanOnlyHere}: the request does not say who shows it, so the
 * user is told to scan only a code on this site's own address (SECU-08).
 *
 * Dash Wallet answers on testnet only (`walletSignInSupported`); elsewhere the sheet says so.
 *
 * App Connect v2 (`lib/auth/app-connect-v2.ts`) comes first where the network and the chain allow
 * it: ONE request, one approval, one key bound to the whole Forge contract group with a budget
 * and an expiry, so no guided grants follow. A link switches to the v1 flow above for wallets
 * that do not speak v2 (the two never share a QR: a v1-only wallet refuses `v=2`). The phone's
 * deep link carries a callback to `/connect/`; the poll also runs when the tab regains focus and
 * when that page reports the wallet came back (`lib/auth/connect-callback.ts`). Without an
 * identity hint the confirm step stays ("A wallet answered for this identity").
 *
 * `mode="renew"` renews the signed-in session's key in the wallet that granted it (origin
 * `app-connect`): the protection for the new key is chosen BEFORE the code shows (the wallet
 * disables the old key when it approves), the request names the identity, and the new key is
 * stored without a confirm step.
 *
 * `mode="grant"` asks the signed-in identity's wallet for a key on another contract (a shipped
 * wallet grants one contract per approval) and adds it to the session: no confirmation step,
 * since only answers from the signed-in identity are read.
 *
 * Granted keys are held in refs, never React state, and dropped when the sheet closes. So is the
 * encryption key the wallet's login key stands for: signing in (or a grant) seals it into the vault
 * beside the wallet key when it is the identity's (DESIGN D27), and the bytes are wiped once the
 * sheet is done.
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
import {
  PollTrigger,
  appConnectV2Available,
  awaitV2Grant,
  disposeV2Request,
  newV2LoginRequest,
  readChainClock,
  type V2Grant,
  type V2LoginRequest,
} from '@/lib/auth/app-connect-v2'
import { connectionId } from '@/lib/auth/connection-id'
import { callbackStatusCopy, connectCallbackUrl, listenForCallback } from '@/lib/auth/connect-callback'
import { defaultLimits } from '@/lib/auth/limited-key'
import { GRANT_COPY, isUnlimited, keyRegistrationUri, scopeCovers, type WalletKey } from '@/lib/auth/key-registration'
import { contractKind, type ForgeIds } from '@/lib/deployments'
import { responderProfile, type ResponderProfile } from '@/lib/auth/responder-profile'
import { isAbort } from '@/lib/sdk/facade'
import { PHASE_TEXT, connectPlatform, withPlatformRead } from '@/lib/auth/connect'
import { creditsAsDash, formatDate } from '@/lib/view/format'
import type { KeyLimits } from '@/lib/view/funds'
import { cn, errorMessage } from '@/lib/utils'

/** The wallet link where a wallet can answer (the main action), and where none can (secondary). */
const DEEP_LINK_PRIMARY = 'bg-forge-700 text-white hover:bg-forge-800'
const DEEP_LINK_SECONDARY =
  'border border-anvil-300 text-anvil-800 hover:bg-anvil-100 dark:border-anvil-700 dark:text-anvil-100 dark:hover:bg-anvil-800'

/** A small underlined text button under the code (the older/newer code links). */
const TEXT_BUTTON = 'hit-area block text-[12px] text-anvil-500 underline hover:text-anvil-800 dark:text-anvil-400 dark:hover:text-anvil-100'

type Sdk = Awaited<ReturnType<typeof connectPlatform>>

/** What a v2 request asks the wallet for: the budget (credits) and the proposed expiry (ms). */
interface V2Terms {
  readonly budget: bigint | null
  readonly expiresAt: number | null
}

type Step =
  /** `linkUri`: the phone's deep link (v2: it carries the callback); `v2`: the App Connect v2 request. */
  | { readonly kind: 'request'; readonly uri: string; readonly linkUri?: string; readonly expiresAt: number; readonly v2?: V2Terms }
  | { readonly kind: 'register'; readonly uri: string; readonly expiresAt: number }
  | {
      readonly kind: 'confirm'
      readonly profile: ResponderProfile
      readonly unlimited: boolean
      readonly unbounded: boolean
      /** A v2 grant's limits (as the chain records them), and the group check's notice. */
      readonly v2?: { readonly limits: KeyLimits | null; readonly notice: string | null }
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

/** The request's primary binding as {@link V2Terms}. */
function termsOf(req: V2LoginRequest): V2Terms {
  const binding = req.request.authBindings[0]
  return { budget: binding?.totalBudget ?? null, expiresAt: binding?.expiresAt ?? null }
}

/**
 * Poll for the wallet's v2 answer, and poll at once when the tab regains focus or becomes visible
 * (the user comes back from the wallet) or the `/connect/` page reports the wallet returned
 * (`onReturn` gets the status it carries). The request is spent however this ends.
 */
export function awaitGrantWithWake(
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
  contractId,
  onUnlock,
}: {
  onDone: () => void
  mode?: 'login' | 'grant' | 'renew'
  contractId?: string
  /** Open the sheet's Unlock view (a v2 sign-in that must wait for a locked wallet key to be opened). */
  onUnlock?: () => void
}): JSX.Element {
  const { adoptWalletKeys, addWalletGrant, identity, isLoading, vaults, unlockScope, controller } = useAuth()
  // Read when the request starts (a scope change must not restart a running request).
  const scopeRef = useRef(unlockScope)
  scopeRef.current = unlockScope
  const forge = ACTIVE_NETWORK.v2
  const target = contractId ?? forge?.core ?? ''
  /** What a grant for `target` covers, for the copy (a grant is for one Forge contract). */
  const grantWhat = GRANT_COPY[(forge && contractKind(forge, target)) || 'collab'].what
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
  /** The answer held for the confirm step: a v1 answer (its key bytes are wiped) or a v2 grant (`answer: null`). */
  const grant = useRef<{ identityId: string; keys: readonly WalletKey[]; answer: WalletAnswer | null } | null>(null)
  /** Wipe the held answer's private key bytes and drop the grant. */
  const dropGrant = useCallback(() => {
    if (grant.current?.answer) wipeAnswer(grant.current.answer)
    grant.current = null
  }, [])
  const mobile = onMobile()
  const unlimited = step?.kind === 'confirm' && step.unlimited
  const { fields, protection, problem } = useProtection({ preferPasskey: unlimited })
  /**
   * The wallet-login version the user asked for with "Show the older code" (v1), and whether a v2
   * request was on offer here at all (then the v1 code links back to it).
   */
  const [olderCode, setOlderCode] = useState(false)
  const [v2Offered, setV2Offered] = useState(false)
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
  const latest = useRef({ addWalletGrant, adoptWalletKeys, onDone, controller, stored: vaults.map((v) => v.identityId) })
  latest.current = { addWalletGrant, adoptWalletKeys, onDone, controller, stored: vaults.map((v) => v.identityId) }
  // A grant is for the signed-in identity: a different one (or signing out) starts over.
  const grantFor = mode === 'grant' ? identity : null
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
      await adoptWalletKeys(g.identityId, g.keys, chosen, {
        discardPendingRenewal: discard,
        ...(renewalUnlock ? { renewalUnlock } : {}),
        ...(drop ? { dropUnopened: true } : {}),
        // A v1 answer brings the wallet's encryption key; a v2 grant has none and is stored as App Connect's.
        ...(g.answer ? { encryptionKeys: g.answer.encryptionKeys, justRegistered: g.answer.kind === 'register' } : { origin: 'app-connect' as const }),
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
        if (mode === 'grant' && !grantFor) throw new Error('Sign in (or unlock) first: the approval is added to the signed-in identity.')
        // A grant is sealed with the vault: a reloaded (signing-only) tab unlocks first (below).
        if (mode === 'grant' && scopeRef.current === 'signing') return
        // A renewal waits for its protection (chosen before the code shows) and for a full unlock.
        if (mode === 'renew' && (!renewGo || scopeRef.current === 'signing')) return
        const sdk = await connectPlatform(ACTIVE_NETWORK.network, (p) => !signal.aborted && setPreparing(PHASE_TEXT[p]))
        if (signal.aborted) return
        if (mode === 'renew') {
          await runRenewal(sdk, forge, signal)
          return
        }
        // App Connect v2 first where the network and the chain allow it, unless the user asked
        // for the older code (a wallet without v2 refuses a v2 request).
        if (mode === 'login' && !olderCode) {
          setPreparing('Checking what your wallet can answer')
          const v2 = await v2Offer(sdk)
          if (signal.aborted) return
          if (v2.available) {
            await runV2Login(sdk, forge, signal, v2.notice)
            return
          }
        }
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
            if (!key) throw new Error(`The wallet's answer does not cover ${grantWhat.toLowerCase()}. Try again, or sign in with your identity file.`)
            // Its first approval registered an encryption key too: the sign-in keeps it.
            await latest.current.addWalletGrant(answer.identityId, key, target, { encryptionKeys: answer.encryptionKeys, justRegistered: answer.kind === 'register' })
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
        else {
          // A v2 request that failed is spent (its key is gone): it must not stay up to be scanned.
          setStep((cur) => (cur?.kind === 'request' && cur.v2 ? null : cur))
          setError(errorMessage(e))
        }
      }
    })()

    /** Whether a v2 request can be offered here, and the group check's notice for the confirm step. */
    async function v2Offer(sdk: Sdk): Promise<{ available: boolean; notice: string | null }> {
      if (!(await appConnectV2Available(sdk, ACTIVE_NETWORK.network))) return { available: false, notice: null }
      // On offer here from now on: if what follows fails, the older code is still one click away.
      if (!signal.aborted) setV2Offered(true)
      try {
        // Forge's own group check, before any code shows.
        const check = await latest.current.controller.checkGroup()
        return { available: true, notice: check.notice }
      } catch (e) {
        // Only Forge's refusal of the group means "no v2 here"; a failed read is shown, with Try again.
        if (errorMessage(e).startsWith('refusing to bind')) {
          if (!signal.aborted) setV2Offered(false)
          return { available: false, notice: null }
        }
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
    async function runV2Login(sdk: Sdk, forge: ForgeIds, aborted: AbortSignal, notice: string | null): Promise<void> {
      // Any approval disables the key of this browser's previous grant: a locked vault that holds
      // one is opened first, while it still can be.
      const blocker = await latest.current.controller.walletSignInBlocker()
      if (aborted.aborted) return
      if (blocker !== null) {
        setStep({ kind: 'blocked', message: blocker })
        return
      }
      const { timeMs } = await readChainClock(sdk)
      if (aborted.aborted) return
      const req = newV2LoginRequest(ACTIVE_NETWORK.network, forge, {
        connectionId: connectionId(ACTIVE_NETWORK.key),
        chainNow: timeMs,
        callbackUrl: connectCallbackUrl,
      })
      setStep({ kind: 'request', uri: req.qrUri, linkUri: req.linkUri, expiresAt: req.expiresAt, v2: termsOf(req) })
      const granted = await awaitGrantWithWake(sdk, req, pollOptions(forge))
      if (aborted.aborted) return
      grant.current = { identityId: granted.identityId, keys: [granted.key], answer: null }
      const profile = await responderProfile(sdk, granted.identityId, ACTIVE_NETWORK.network, latest.current.stored)
      if (aborted.aborted) return
      setStep({ kind: 'confirm', profile, unlimited: false, unbounded: false, v2: { limits: granted.key.limits, notice } })
    }

    /** Renewal: the wallet that granted this browser's key grants a new one (no confirm: the identity is known). */
    async function runRenewal(sdk: Sdk, forge: ForgeIds, aborted: AbortSignal): Promise<void> {
      if (!renewProtection.current) throw new Error('Choose how to protect the new key first.')
      const auth = latest.current.controller
      const req = await auth.walletRenewalRequest({ callbackUrl: connectCallbackUrl })
      let granted: V2Grant
      try {
        if (aborted.aborted) {
          disposeV2Request(req)
          auth.endWalletRenewal(req)
          return
        }
        setStep({ kind: 'request', uri: req.qrUri, linkUri: req.linkUri, expiresAt: req.expiresAt, v2: termsOf(req) })
        granted = await awaitGrantWithWake(sdk, req, pollOptions(forge))
      } catch (e) {
        // Cancelled, expired or refused: the old key is not being replaced after all.
        auth.endWalletRenewal(req)
        throw e
      }
      // The wallet has answered, so it has disabled the old key: store the new one now, even if
      // the sheet is closing. When that needs a decision or an unlock, the grant is held for it.
      renewalReq.current = req
      grant.current = { identityId: granted.identityId, keys: [granted.key], answer: null }
      setStep({ kind: 'renew-store' })
      await finishRef.current(false)
    }
    return () => {
      abort.abort()
      dropGrant()
    }
    // `attempt` restarts the whole request (a new ephemeral key and QR).
  }, [attempt, forge, target, mode, grantFor, dropGrant, grantWhat, olderCode, renewGo, needsUnlock])

  const restart = useCallback(() => {
    // The spent request goes off screen; the next one replaces it.
    setStep(null)
    setAttempt((a) => a + 1)
  }, [])
  /** Switch between the v2 and the older code: the old request goes off screen at once (its key is spent). */
  const switchCode = (older: boolean): void => {
    setStep(null)
    setOlderCode(older)
  }

  // A reloaded tab holds the signing key only; an approval is stored with the rest of the vault.
  if (mode === 'grant' && unlockScope === 'signing') {
    return <UnlockMore title="Unlock this tab to add the approval" testId="grant-unlock" />
  }
  if (needsUnlock) return <UnlockMore title="Unlock this tab to renew in your wallet" testId="renew-unlock" />
  // A renewal asks how to protect the new key before its code shows: the wallet disables the old
  // key as it approves, so the new one must be storable the moment the answer arrives.
  if (mode === 'renew' && !renewGo) {
    const defaults = defaultLimits()
    return (
      <div className="space-y-3" data-testid="wallet-renew-prepare">
        <p className="text-dense">
          Your wallet gave this browser its key. A new request goes to the same wallet: when you approve, it adds a new key and disables the
          current one.
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
          <Button variant="outline" onClick={() => switchCode(true)}>
            Show the older code instead
          </Button>
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
        <p className="text-dense">Your wallet gave this browser a new key and disabled the old one. Forge has not stored the new key yet.</p>
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
        {step.unlimited ? <UnlimitedKeyWarning unbounded={step.unbounded} /> : null}
        {step.v2 ? (
          <>
            {step.v2.limits?.total != null ? (
              <p className="text-dense" data-testid="approval-terms">
                <ApprovalTerms budget={step.v2.limits.total} expiresAt={step.v2.limits.expiresAt} granted />
              </p>
            ) : null}
            {step.v2.notice ? (
              <p role="note" data-testid="group-notice" className="rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-[12px]">
                {step.v2.notice}
              </p>
            ) : null}
          </>
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

  const uri = step?.kind === 'request' || step?.kind === 'register' ? step.uri : null
  const isRegister = step?.kind === 'register'
  const qrLabel = isRegister ? 'Wallet key registration request' : 'Wallet login request'
  // Where no released wallet can answer (a devnet, mainnet), that comes first and the wallet
  // link is secondary: a big primary button that cannot work is a dead end (QW2-029).
  const v2 = step?.kind === 'request' ? step.v2 : undefined
  const reportedCopy = step?.kind === 'request' ? callbackStatusCopy(reported) : undefined
  // The phone's deep link may carry the callback the QR leaves out.
  const linkUri = step?.kind === 'request' && step.linkUri ? step.linkUri : uri
  // A v2 request is the one on offer where it shows, so its link leads even where no released
  // wallet answers yet; a v1 request keeps the dead-end rule above.
  const supported = walletSignInSupported(ACTIVE_NETWORK.network) || v2 !== undefined
  const supportNote = mode === 'login' && step?.kind === 'request' ? <WalletSupportNote protocol={v2 ? 'v2' : 'v1'} /> : null
  // Said where the QR is on screen: a phone's QR sits in a collapsed disclosure.
  const qrPrivate = step?.kind === 'request' ? <p className="text-dense">Keep this QR code private: anyone who scans it can answer it.</p> : null
  return (
    <div className="space-y-3" data-testid={isRegister ? 'wallet-register' : 'wallet-request'}>
      {supported ? null : supportNote}
      {mode === 'grant' && !isRegister ? (
        <p className="text-dense">Approve {grantWhat.toLowerCase()} for this identity in your wallet.</p>
      ) : null}
      {v2 ? (
        <p className="text-dense" data-testid="approval-terms">
          {mode === 'renew' ? 'Approve the renewal in the wallet that gave this browser its key. ' : 'Approve in your wallet. '}
          <ApprovalTerms budget={v2.budget} expiresAt={v2.expiresAt} />
        </p>
      ) : null}
      {isRegister ? (
        <p className="text-dense">
          <span className="font-medium">One more step, first time only.</span> Your wallet approved, and now it has to add Forge&apos;s key to your identity.{' '}
          {mobile ? 'Open it in the wallet again.' : 'Scan this second code with the wallet.'}
        </p>
      ) : null}
      {step?.kind === 'request' || isRegister ? <ScanOnlyHere /> : null}
      {uri ? (
        mobile ? (
          <>
            <a
              href={linkUri ?? uri}
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
      {reportedCopy ? (
        <p role="status" data-testid="wallet-reported" className="rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense">
          {reportedCopy.title}. {reportedCopy.body}
        </p>
      ) : null}
      {mode === 'login' && v2 ? (
        <button type="button" data-testid="older-code" onClick={() => switchCode(true)} className={TEXT_BUTTON}>
          Using a Dash Wallet build without App Connect v2? Show the older code
        </button>
      ) : null}
      {mode === 'login' && step?.kind === 'request' && !v2 && v2Offered ? (
        <button type="button" data-testid="newer-code" onClick={() => switchCode(false)} className={TEXT_BUTTON}>
          Wallet supports App Connect v2? Show the newer code
        </button>
      ) : null}
      <ErrorBox error={error} />
      {error ? (
        <Button variant="outline" className="w-full" onClick={restart}>
          <RefreshCw className="h-4 w-4" aria-hidden /> Try again
        </Button>
      ) : null}
      {mode === 'login' && error && v2Offered && !olderCode ? (
        <button type="button" data-testid="older-code-error" onClick={() => switchCode(true)} className={TEXT_BUTTON}>
          Show the older code instead
        </button>
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
export function WalletSupportNote({ protocol = 'v1' }: { protocol?: 'v1' | 'v2' } = {}): JSX.Element {
  const { network, key } = ACTIVE_NETWORK
  if (protocol === 'v2') {
    return (
      <p data-testid="wallet-support" className="text-[12px] text-anvil-500 dark:text-anvil-400">
        Needs a Dash Wallet build that supports App Connect v2, which may be a development build. Wallets without it can answer the older code.
      </p>
    )
  }
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
      Works with a testnet development build of the Dash Wallet app: More → Tools → Connections → Scan QR. No released version has it yet. On iOS, each
      Forge contract needs its own approval.
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
