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
 * Granted keys are held in refs, never React state, and dropped when the sheet closes.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw, Smartphone } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { Qr } from '@/components/ui/qr'
import { ErrorBox, useProtection } from '@/components/auth/protection-fields'
import { ACTIVE_NETWORK } from '@/lib/constants'
import { REQUEST_TTL_MS, RequestExpired, awaitRegisteredKey, awaitWalletAnswer, newLoginRequest, responseSources, walletSignInSupported, type PollStatus } from '@/lib/auth/app-connect'
import { isUnlimited, keyRegistrationUri, scopeCovers, type WalletKey } from '@/lib/auth/key-registration'
import { responderProfile, type ResponderProfile } from '@/lib/auth/responder-profile'
import { ensureSdk } from '@/lib/sdk'
import { isAbort } from '@/lib/sdk/facade'
import { formatDate } from '@/lib/view/format'
import { errorMessage } from '@/lib/utils'

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
  const { adoptWalletKeys, addWalletGrant, identity, isLoading, vaults } = useAuth()
  const forge = ACTIVE_NETWORK.v2
  const target = contractId ?? forge?.core ?? ''
  const [step, setStep] = useState<Step | null>(null)
  const [status, setStatus] = useState<PollStatus>('waiting')
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [confirmed, setConfirmed] = useState(false)
  const grant = useRef<{ identityId: string; keys: readonly WalletKey[] } | null>(null)
  const mobile = onMobile()
  const unlimited = step?.kind === 'confirm' && step.unlimited
  const { fields, protection, problem } = useProtection({ preferPasskey: unlimited })
  // Read at request time, not effect deps: a change must not restart a request mid-flow (the
  // identity changes from null to the new one inside the login itself).
  const latest = useRef({ addWalletGrant, onDone, stored: vaults.map((v) => v.identityId) })
  latest.current = { addWalletGrant, onDone, stored: vaults.map((v) => v.identityId) }
  // A grant is for the signed-in identity: a different one (or signing out) starts over.
  const grantFor = mode === 'grant' ? identity : null

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
        const sdk = await ensureSdk(ACTIVE_NETWORK.network)
        const sources = await responseSources(sdk, ACTIVE_NETWORK.key)
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
        grant.current = { identityId: answer.identityId, keys }
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
      grant.current = null
    }
    // `attempt` restarts the whole request (a new ephemeral key and QR).
  }, [attempt, forge, target, mode, grantFor])

  const restart = useCallback(() => setAttempt((a) => a + 1), [])

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
              {profile.namedAt ? <span className="ml-2 text-[12px] font-normal text-anvil-500">named {formatDate(profile.namedAt)}</span> : null}
            </div>
          ) : null}
          <div data-testid="granted-identity" className="break-all font-mono text-dense">
            {profile.identityId}
          </div>
        </div>
        {profile.warnings.map((w) => (
          <div key={w} role="alert" data-testid="responder-warning" className="flex gap-2 rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-dense text-danger">
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
          onClick={async () => {
            const g = grant.current
            if (!protection || !g) return
            try {
              await adoptWalletKeys(g.identityId, g.keys, protection)
              grant.current = null
              onDone()
            } catch (e) {
              setError(errorMessage(e))
            }
          }}
        >
          Finish signing in
        </Button>
        {problem ? <p className="text-[12px] text-anvil-500">{problem}</p> : null}
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
  return (
    <div className="space-y-3" data-testid={isRegister ? 'wallet-register' : 'wallet-request'}>
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
              className="flex w-full items-center justify-center gap-2 rounded-md bg-forge-700 px-4 py-3 text-dense font-medium text-white hover:bg-forge-800"
            >
              <Smartphone className="h-4 w-4" aria-hidden /> {isRegister ? 'Add the key in DashPay (Dash Wallet)' : 'Open in DashPay (Dash Wallet)'}
            </a>
            <details className="text-[12px] text-anvil-500">
              <summary className="cursor-pointer">Wallet on another device? Show the QR code</summary>
              <div className="pt-2">
                <Qr value={uri} label={qrLabel} size={180} />
              </div>
            </details>
          </>
        ) : (
          <Qr value={uri} label={qrLabel} size={200} />
        )
      ) : error ? null : (
        <Loader2 className="mx-auto h-5 w-5 animate-spin text-anvil-400" aria-hidden />
      )}
      {step?.kind === 'request' ? <p className="text-dense">Keep this QR code private: anyone who scans it can answer it.</p> : null}
      {status === 'incomplete-read' && step?.kind === 'request' ? (
        <p className="text-[12px] text-caution" data-testid="incomplete-read">
          Couldn&apos;t read all answer sources — retrying. Forge won&apos;t accept an answer until it has read them all.
        </p>
      ) : null}
      {step?.kind === 'request' || step?.kind === 'register' ? <Countdown until={step.expiresAt} /> : null}
      {mode === 'login' && step?.kind === 'request' ? <WalletSupportNote /> : null}
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
          ? `Dash Wallet support arrives when Forge is on testnet, where its sign-in feature (DashConnect) works; that feature is not in a released wallet yet. On ${key}, only an internal iOS build with this network's login contract entered by hand can answer.`
          : `No Dash Wallet build supports sign-in on ${key} yet: its sign-in feature (DashConnect) works on testnet only.`}{' '}
        Here, use an identity file or create an identity in the browser.
      </p>
    )
  }
  return (
    <p data-testid="wallet-support" className="text-[12px] text-anvil-500 dark:text-anvil-400">
      Works with a testnet build of the DashPay (Dash Wallet) app: More → Tools → Connections → Scan QR. That feature (DashConnect) is not in a released
      version yet, only in builds from the wallets&apos; development branches (on Android, the testnet build only). The first approval covers repositories
      and pushes; issues, pull requests and stars may take a second one.
    </p>
  )
}

/** "This key has no spending limit" (a shipped wallet's key): what it means, what to do. */
export function UnlimitedKeyWarning({ unbounded }: { unbounded: boolean }): JSX.Element {
  return (
    <div role="note" data-testid="unlimited-key-warning" className="flex gap-2 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-caution" aria-hidden />
      <span>
        This wallet key has no spending limit or expiry: anyone who copies it from this browser can spend your balance
        {unbounded ? ', on any Platform app, not only Forge' : ' on Forge'}. Disabling it on chain stops it, but this wallet derives the same key every time,
        so once it is disabled, Forge refuses wallet sign-in for this identity. Protect it with a passkey, and replace it with a limited key (Settings → This
        browser&apos;s key) when you can.
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
    <p className="text-center font-mono text-[12px] text-anvil-500" aria-live="off" data-testid="request-countdown">
      Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
    </p>
  )
}
