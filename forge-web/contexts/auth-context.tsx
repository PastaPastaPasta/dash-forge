'use client'

/**
 * AuthContext — the React surface over {@link AuthController}.
 *
 * Exposes `{ identity, balance, funds, signer, … }` where `signer` is the key-free
 * {@link WriteAuth} the write paths consume (it reads the key at signing time; the key never
 * enters React state). Every write the signer makes reports back here: it lands in the local
 * spend ledger, a toast shows what it actually cost, and the balance is re-read.
 */

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
import { MissingGrantError } from '../lib/auth/controller'
import type { WalletKey } from '../lib/auth/key-registration'
import { useUiStore } from '../hooks/use-ui-store'
import { DEFAULT_NETWORK, type Network } from '../lib/constants'
import { type SpendEvent, type WriteAuth } from '../lib/sdk'
import { connectPlatform } from '../lib/auth/connect'
import { recordSpend } from '../lib/spend'
import { errorMessage } from '../lib/utils'
import { fundsState, nextFundsChange, type FundsState, type KeyLimits } from '../lib/view/funds'
import { toast } from '../hooks/use-toasts'

/** setTimeout's longest delay (about 24.8 days); a later change is re-armed from there. */
const MAX_TIMER_MS = 2 ** 31 - 1

/** A write kind (`create:issue`) → the toast title. */
const SPEND_TITLES: Readonly<Record<string, string>> = {
  'create:repo': 'Repository created',
  'create:maintainer': 'Maintainer added',
  'create:writer': 'Writer added',
  'create:config': 'Repository config written',
  'create:repoKey': 'Repo key handed out',
  'create:issue': 'Issue created',
  'create:comment': 'Comment posted',
  'create:event': 'State event recorded',
  'create:authorEvent': 'State event recorded',
  'create:review': 'Review submitted',
  'create:release': 'Release published',
  'create:star': 'Starred',
  'create:follow': 'Following',
  'delete:star': 'Unstarred',
  'delete:follow': 'Unfollowed',
  'delete:maintainer': 'Maintainer removed',
  'delete:writer': 'Writer removed',
  'key:register': "This browser's key registered",
  'key:renew': "This browser's key renewed",
  'key:topup': 'Key budget topped up',
  'key:revoke': 'Key disabled on chain',
  'key:encryption': 'Encryption key registered',
  'identity:create': 'Identity created',
}

const NONE: readonly number[] = []

interface AuthContextValue {
  /** The logged-in identity id, or null. */
  readonly identity: string | null
  /** Credit balance as a decimal string (bigint-safe), or null when logged out. */
  readonly balance: string | null
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
  /** The limited-key ceremony: import an identity file or a mnemonic once. */
  importIdentity: (
    input: { fileText: string } | { mnemonic: string; identityId: string },
    protection: Protection,
    request?: LimitedKeyRequest,
    options?: { readonly enablePrivateRepos?: boolean; readonly renew?: boolean },
  ) => Promise<void>
  adoptLimitedKey: (identityId: string, key: LimitedKey, protection: Protection) => Promise<void>
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
      adoptWalletKeys: withReload(controller.adoptWalletKeys.bind(controller)),
      addWalletGrant: withReload(controller.addWalletGrant.bind(controller)),
      unlock: withReload(controller.unlock.bind(controller)),
      loginWithRawKey: withReload(controller.loginWithRawKey.bind(controller)),
      refreshBalance: () => controller.refreshBalance(),
      logout: () => controller.logout(),
      forget: withReload(controller.forget.bind(controller)),
      revokeStored: withReload(controller.revokeStored.bind(controller)),
      topUpKey: (input: MasterInput, request: TopUpRequest) => controller.topUpKey(input, request),
    }),
    [controller, withReload],
  )

  const onSpend = useCallback(
    (event: SpendEvent) => {
      const refused = event.kind.startsWith('refused:')
      toast({
        title: refused ? 'Platform refused that write' : SPEND_TITLES[event.kind] ?? 'Write confirmed',
        credits: event.actualCredits ?? null,
        ...(refused ? { tone: 'warn' as const, detail: 'A refused write still pays its processing fee.' } : {}),
      })
      void recordSpend(event).catch(() => undefined)
      void controller.refreshBalance().catch(() => undefined)
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

  const value = useMemo<AuthContextValue>(
    () => ({
      identity: session?.identityId ?? null,
      balance: session?.balance ?? null,
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
      reloadVaults,
      controller,
      ...actions,
    }),
    [actions, controller, funds, keyLimits, reloadVaults, session, signer, state.error, state.isLoading, state.step, vaults, vaultsError, vaultsLoaded],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/** Access the auth context. Throws if used outside an {@link AuthProvider}. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (ctx === undefined) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
