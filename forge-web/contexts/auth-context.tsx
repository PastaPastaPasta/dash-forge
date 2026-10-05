'use client'

/**
 * AuthContext — the React surface over {@link AuthController}.
 *
 * Exposes `{ identity, balance, funds, signer, … }` where `signer` is the key-free
 * {@link WriteAuth} the write paths consume (it reads the key at signing time; the key never
 * enters React state). Every write the signer makes reports back here: it lands in the local
 * spend ledger, a toast shows what it actually cost, and the balance is re-read.
 */

import type { HandoffRequest } from '@/lib/auth/key-handoff'
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import {
  AuthController,
  type AuthSession,
  type LimitedKey,
  type LimitedKeyRequest,
  type MasterInput,
  type Protection,
  type TopUpRequest,
  type VaultInfo,
} from '../lib/auth'
import { MissingGrantError, UnlockNeededError } from '../lib/auth/controller'
import type { WalletKey } from '../lib/auth/key-registration'
import { useUiStore } from '../hooks/use-ui-store'
import { DEFAULT_NETWORK, type Network } from '../lib/constants'
import { type SpendEvent, type WriteAuth } from '../lib/sdk'
import { connectPlatform } from '../lib/auth/connect'
import { recordSpend } from '../lib/spend'
import { lockedIdentityOf, readLastIdentity } from '../lib/auth/last-identity'
import { errorMessage } from '../lib/utils'
import { fundsState, nextFundsChange, type FundsState, type KeyLimits } from '../lib/view/funds'
import { toast } from '../hooks/use-toasts'
import { toastSpend } from '../lib/spend-toast'

/** setTimeout's longest delay (about 24.8 days); a later change is re-armed from there. */
const MAX_TIMER_MS = 2 ** 31 - 1

const NONE: readonly number[] = []

interface AuthContextValue {
  /** The logged-in identity id, or null. */
  readonly identity: string | null
  /** Credit balance as a decimal string (bigint-safe), or null when logged out. */
  readonly balance: string | null
  /**
   * When this tab read `balance` from Platform (client ms), or null while a reload still shows
   * the kept session's balance (or when logged out).
   */
  readonly balanceReadAt: number | null
  /** Balance and key-budget state (`ux-dx-spec.md` §4), or null when logged out. */
  readonly funds: FundsState | null
  /** The signing key's limits (a PV14 limited key), when it has any. */
  readonly keyLimits: KeyLimits | null
  /** The signing key's id on the identity, when signed in. */
  readonly keyId: number | null
  /** Keys held only for the next renewal or revoke to disable ({@link AuthSession.heldOnly}). */
  readonly heldOnly: readonly number[]
  readonly isLoading: boolean
  /** The step a running sign-in is on, for the sheet (null when none). */
  readonly step: string | null
  readonly error: string | null
  /** The key-free write signer for the WriteEngine, or null when logged out. */
  readonly signer: WriteAuth | null
  /** How this session's key is held: a vault-stored limited key, or a tab-only raw key. */
  readonly storage: AuthSession['storage'] | null
  /** Whether this network supports limited keys (forge-v2, protocol 14). */
  readonly limitedKeys: boolean
  /** Keys stored (encrypted) on this device for this network. */
  readonly vaults: readonly VaultInfo[]
  /** Why the stored-key list could not be read (null when it was). */
  readonly vaultsError: string | null
  /** Whether the stored-key list has been read at least once. */
  readonly vaultsLoaded: boolean
  /**
   * A session an earlier page load kept is still being picked up (a reload, a new tab): show
   * neither "Sign in" nor "Unlock" yet.
   */
  readonly resuming: boolean
  /**
   * This browser holds a key but the session is locked (12 hours up, Lock, "Ask to unlock on
   * every visit"): every page offers Unlock, and write buttons open it.
   */
  readonly locked: boolean
  /**
   * The identity signed in last on this device (null when none was recorded): the Unlock sheet
   * preselects it among several stored keys.
   */
  readonly lastIdentity: string | null
  /**
   * While {@link locked}: the identity the Unlock would open (the last used, else the first
   * stored), so a page can say "Unlock to merge" to a member rather than look signed out.
   */
  readonly lockedIdentity: string | null
  /**
   * `signing`: this tab resumed a kept session and holds the spend-capped signing key only
   * (private repos, storage settings and wallet grants ask to unlock); `full`: an interactive
   * unlock; null when signed out.
   */
  readonly unlockScope: 'full' | 'signing' | null
  /** The limited-key ceremony: import an identity file or a mnemonic once. */
  importIdentity: (
    input: { fileText: string } | { mnemonic: string; identityId: string },
    protection: Protection,
    request?: LimitedKeyRequest,
    options?: { readonly enablePrivateRepos?: boolean; readonly renew?: boolean },
  ) => Promise<void>
  adoptLimitedKey: (identityId: string, key: LimitedKey, protection: Protection) => Promise<void>
  /** Keep the key `dg auth keys add --for-browser` sealed to this tab's request (`lib/auth/key-handoff`). */
  adoptHandoffKey: (reply: string, request: HandoffRequest, protection: Protection, options?: { readonly renew?: boolean }) => Promise<void>
  /** Store the keys a wallet granted (verified on chain) and open the session. */
  adoptWalletKeys: (identityId: string, keys: readonly WalletKey[], protection: Protection, options?: Parameters<AuthController['adoptWalletKeys']>[3]) => Promise<void>
  /** Add a wallet grant for another Forge contract to the signed-in identity. */
  addWalletGrant: (identityId: string, key: WalletKey, requested: string) => Promise<void>
  /** Which Forge contracts the session's keys cover, and whether a held key is unlimited. */
  readonly grants: AuthSession['grants'] | null
  readonly unlimitedKey: boolean
  readonly unboundedKey: boolean
  unlock: (identityId: string, method: { passphrase: string } | 'passkey') => Promise<void>
  /** Advanced: a pasted key, for this tab only. */
  loginWithRawKey: (identityId: string, privateKey: string) => Promise<void>
  refreshBalance: () => Promise<void>
  /** Lock: end the session, keep the stored key (unlock to continue). */
  logout: () => void
  /** Delete the stored key of `identityId` from this device (does not revoke it on chain). */
  forget: (identityId: string) => Promise<void>
  /** Disable this device's key on chain with the master key (file or phrase), then forget it. */
  revokeStored: (identityId: string, input: MasterInput) => Promise<void>
  /** Raise this browser key's budget / expiry in place (the master key signs once). */
  topUpKey: (input: MasterInput, request: TopUpRequest) => Promise<KeyLimits>
  /** Register a CI runner key (not stored here; shown once). The master key signs once. */
  createRunnerKey: (input: MasterInput, request: LimitedKeyRequest) => Promise<LimitedKey>
  reloadVaults: () => void
  /** The headless controller (identity creation stores its key before registering it). */
  readonly controller: AuthController
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({
  children,
  network = DEFAULT_NETWORK,
}: {
  children: React.ReactNode
  network?: Network
}): JSX.Element {
  // Bounded: a hung download or connect fails the sign-in step with a named error, never a
  // button that spins forever.
  const controller = useMemo(() => new AuthController(() => connectPlatform(network), network), [network])
  const [state, setState] = useState(() => controller.getState())

  useEffect(() => controller.subscribe(setState), [controller])
  // Follow locks and the other tabs (subscribed here, so an instance StrictMode discards holds
  // no listener), and pick up the session an earlier page load kept (until it locks).
  useEffect(() => {
    const detach = controller.attach()
    void controller.resume()
    return detach
  }, [controller])
  const resuming = state.resuming

  // A notice from a sign-in step (e.g. storage settings that could not survive a key renewal).
  const notice = state.notice ?? null
  useEffect(() => {
    if (!notice) return
    const title = /carried over/i.test(notice)
      ? 'Not carried over to the new key'
      : /private repos/i.test(notice)
        ? 'Private repos not enabled'
        : 'Sign-in notice'
    toast({ title, tone: 'warn', detail: notice })
    controller.clearNotice()
  }, [notice, controller])

  const [vaults, setVaults] = useState<readonly VaultInfo[]>([])
  // Why the stored-key list could not be read (storage blocked by another tab, say): the last
  // list read stays, so a stored key never silently turns into "no key here".
  const [vaultsError, setVaultsError] = useState<string | null>(null)
  // The list has been read successfully at least once. The sheet also proceeds on `vaultsError`:
  // a caller waiting on this flag alone would wait forever while storage is blocked.
  const [vaultsLoaded, setVaultsLoaded] = useState(false)
  // Only the latest read may update the list: an older read that fails after a newer one
  // succeeded must not report a failure.
  const vaultRead = useRef(0)
  const reloadVaults = useCallback(() => {
    const read = ++vaultRead.current
    controller.storedVaults().then(
      (v) => {
        if (read !== vaultRead.current) return
        setVaults(v)
        setVaultsError(null)
        setVaultsLoaded(true)
      },
      (e: unknown) => {
        if (read === vaultRead.current) setVaultsError(errorMessage(e))
      },
    )
  }, [controller])
  useEffect(reloadVaults, [reloadVaults])

  // Every sign-in path ends with a reload of the stored-key list, success or not: a key stored
  // before a later step failed must show up in Unlock.
  const withReload = useCallback(
    <A extends unknown[]>(fn: (...args: A) => Promise<unknown>) =>
      async (...args: A): Promise<void> => {
        try {
          await fn(...args)
        } finally {
          reloadVaults()
        }
      },
    [reloadVaults],
  )
  const actions = useMemo(
    () => ({
      importIdentity: withReload(controller.importIdentity.bind(controller)),
      adoptLimitedKey: withReload(controller.adoptLimitedKey.bind(controller)),
      adoptHandoffKey: withReload(controller.adoptHandoffKey.bind(controller)),
      adoptWalletKeys: withReload(controller.adoptWalletKeys.bind(controller)),
      addWalletGrant: withReload(controller.addWalletGrant.bind(controller)),
      unlock: withReload(controller.unlock.bind(controller)),
      loginWithRawKey: withReload(controller.loginWithRawKey.bind(controller)),
      refreshBalance: () => controller.refreshBalance(),
      logout: () => controller.logout(),
      forget: withReload(controller.forget.bind(controller)),
      revokeStored: withReload(controller.revokeStored.bind(controller)),
      topUpKey: (input: MasterInput, request: TopUpRequest) => controller.topUpKey(input, request),
      createRunnerKey: (input: MasterInput, request: LimitedKeyRequest) => controller.createRunnerKey(input, request),
    }),
    [controller, withReload],
  )

  const onSpend = useCallback(
    (event: SpendEvent) => {
      toastSpend(event, event.actualCredits ?? null)
      // The row first, then the balance: a refresh that lands before the row would let Settings →
      // Spend reconcile a balance with this write in it against a ledger without it.
      void recordSpend(event)
        .catch(() => undefined)
        .then(() => controller.refreshBalance())
        .catch(() => undefined)
    },
    [controller],
  )
  // Identity updates the controller pays for (key register, renew, top-up, revoke) reach the
  // same ledger and toast as document writes.
  useEffect(() => {
    controller.setSpendListener(onSpend)
    return () => controller.setSpendListener(null)
  }, [controller, onSpend])

  const session: AuthSession | null = state.session
  const sessionIdentity = session?.identityId ?? null
  const signer = useMemo<WriteAuth | null>(() => {
    const auth = sessionIdentity !== null ? controller.writeAuth : null
    if (!auth) return null
    return {
      ...auth,
      onSpend,
      // A write to a contract no held key covers (a wallet granted forge-core only): open the
      // one-tap wallet grant for it; the write itself fails with the reason, and can be retried.
      getSigningKeyWif: (contractId?: string): string => {
        try {
          return auth.getSigningKeyWif(contractId)
        } catch (e) {
          if (e instanceof MissingGrantError) useUiStore.getState().openLogin('grant')
          else if (e instanceof UnlockNeededError) useUiStore.getState().openLogin('unlock')
          throw e
        }
      },
    }
  }, [controller, sessionIdentity, onSpend])
  const keyLimits = session?.keyLimits ?? null
  // The funds state depends on the clock (a key expires, or comes within a week of it): wake
  // up at the next such moment and judge again, so the pill turns red when the key expires,
  // not at the next reload (D-042).
  const [clock, setClock] = useState(() => Date.now())
  useEffect(() => {
    const at = nextFundsChange(keyLimits, clock)
    if (at === null) return
    const timer = setTimeout(() => setClock(Date.now()), Math.min(Math.max(0, at - Date.now()) + 50, MAX_TIMER_MS))
    return () => clearTimeout(timer)
  }, [keyLimits, clock])
  const funds = useMemo(
    () => (session ? fundsState(BigInt(session.balance), keyLimits, clock) : null),
    [session, keyLimits, clock],
  )
  // Re-read when a session opens (the controller records it) or the stored keys change (a
  // forget drops it). localStorage, so read in the browser only.
  const [lastIdentity, setLastIdentity] = useState<string | null>(null)
  useEffect(() => {
    setLastIdentity(readLastIdentity(network))
  }, [network, sessionIdentity, vaults])

  const locked = session === null && !resuming && vaults.length > 0
  const value = useMemo<AuthContextValue>(
    () => ({
      identity: session?.identityId ?? null,
      balance: session?.balance ?? null,
      balanceReadAt: session?.balanceReadAt ?? null,
      funds,
      keyLimits,
      keyId: session?.keyId ?? null,
      heldOnly: session?.heldOnly ?? NONE,
      isLoading: state.isLoading,
      step: state.step ?? null,
      error: state.error,
      signer,
      storage: session?.storage ?? null,
      grants: session?.grants ?? null,
      unlimitedKey: session?.unlimited === true,
      unboundedKey: session?.unbounded === true,
      limitedKeys: controller.supportsLimitedKeys(),
      vaults,
      vaultsError,
      vaultsLoaded,
      resuming,
      locked,
      lastIdentity,
      lockedIdentity: locked ? lockedIdentityOf(vaults, lastIdentity) : null,
      unlockScope: session === null ? null : state.scope ?? null,
      reloadVaults,
      controller,
      ...actions,
    }),
    [actions, controller, funds, keyLimits, lastIdentity, locked, reloadVaults, resuming, session, signer, state.error, state.isLoading, state.scope, state.step, vaults, vaultsError, vaultsLoaded],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/** Access the auth context. Throws if used outside an {@link AuthProvider}. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (ctx === undefined) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
