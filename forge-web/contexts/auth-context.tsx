'use client'

/**
 * AuthContext — the React surface over {@link AuthController}.
 *
 * Exposes `{ identity, balance, funds, signer, … }` where `signer` is the key-free
 * {@link WriteAuth} the write paths consume (it reads the key at signing time; the key never
 * enters React state). Every write the signer makes reports back here: it lands in the local
 * spend ledger, a toast shows what it actually cost, and the balance is re-read.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { EvoSDK } from '@dashevo/evo-sdk'

import { AuthController, type AuthSession, type LimitedKey, type LimitedKeyRequest, type Protection, type VaultInfo } from '../lib/auth'
import { DEFAULT_NETWORK, NETWORKS, type Network } from '../lib/constants'
import { ensureSdk, type SpendEvent, type WriteAuth } from '../lib/sdk'
import { recordSpend } from '../lib/spend'
import { fundsState, type FundsState, type KeyLimits } from '../lib/view/funds'
import { toast } from '../hooks/use-toasts'

/** A write kind (`create:issue`) → the toast title. */
const SPEND_TITLES: Readonly<Record<string, string>> = {
  'create:repo': 'Repository created',
  'create:maintainer': 'Maintainer added',
  'create:writer': 'Writer added',
  'create:config': 'Repository config written',
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
}

interface AuthContextValue {
  /** The logged-in identity id, or null. */
  readonly identity: string | null
  /** Credit balance as a decimal string (bigint-safe), or null when logged out. */
  readonly balance: string | null
  /** Balance and key-budget state (`ux-dx-spec.md` §4), or null when logged out. */
  readonly funds: FundsState | null
  /** The signing key's limits (a PV14 limited key), when it has any. */
  readonly keyLimits: KeyLimits | null
  readonly isLoading: boolean
  readonly error: string | null
  /** The key-free write signer for the WriteEngine, or null when logged out. */
  readonly signer: WriteAuth | null
  /** How this session's key is held: a vault-stored limited key, or a tab-only raw key. */
  readonly storage: AuthSession['storage'] | null
  /** Whether this network supports limited keys (forge-v2, protocol 14). */
  readonly limitedKeys: boolean
  /** Keys stored (encrypted) on this device for this network. */
  readonly vaults: readonly VaultInfo[]
  /** The limited-key ceremony: import an identity file or a mnemonic once. */
  importIdentity: (
    input: { fileText: string } | { mnemonic: string; identityId: string },
    protection: Protection,
    request?: LimitedKeyRequest,
  ) => Promise<void>
  adoptLimitedKey: (identityId: string, key: LimitedKey, protection: Protection) => Promise<void>
  unlock: (identityId: string, method: { passphrase: string } | 'passkey') => Promise<void>
  /** Advanced: a pasted key, for this tab only. */
  loginWithRawKey: (identityId: string, privateKey: string) => Promise<void>
  refreshBalance: () => Promise<void>
  /** Lock (keep the stored key) or sign out and forget this browser's key. */
  logout: (forget?: boolean) => void
  reloadVaults: () => void
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({
  children,
  network = DEFAULT_NETWORK,
}: {
  children: React.ReactNode
  network?: Network
}): JSX.Element {
  const controller = useMemo(() => new AuthController(() => ensureSdk(network), network), [network])
  const [state, setState] = useState(() => controller.getState())

  useEffect(() => controller.subscribe(setState), [controller])

  const [vaults, setVaults] = useState<readonly VaultInfo[]>([])
  const reloadVaults = useCallback(() => {
    controller.storedVaults().then(setVaults, () => setVaults([]))
  }, [controller])
  useEffect(reloadVaults, [reloadVaults])

  const importIdentity = useCallback<AuthContextValue['importIdentity']>(
    async (input, protection, request) => {
      await controller.importIdentity(input, protection, request)
      reloadVaults()
    },
    [controller, reloadVaults],
  )
  const adoptLimitedKey = useCallback<AuthContextValue['adoptLimitedKey']>(
    async (identityId, key, protection) => {
      await controller.adoptLimitedKey(identityId, key, protection)
      reloadVaults()
    },
    [controller, reloadVaults],
  )
  const unlock = useCallback<AuthContextValue['unlock']>(
    async (identityId, method) => {
      await controller.unlock(identityId, method)
    },
    [controller],
  )
  const loginWithRawKey = useCallback(
    async (identityId: string, privateKey: string) => {
      await controller.loginWithRawKey(identityId, privateKey)
    },
    [controller],
  )

  const refreshBalance = useCallback(async () => {
    await controller.refreshBalance()
  }, [controller])

  const logout = useCallback(
    (forget = false) => {
      void controller.logout(forget).then(reloadVaults)
    },
    [controller, reloadVaults],
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

  const session: AuthSession | null = state.session
  const sessionIdentity = session?.identityId ?? null
  const signer = useMemo<WriteAuth | null>(() => {
    const auth = sessionIdentity !== null ? controller.writeAuth : null
    return auth ? { ...auth, onSpend } : null
  }, [controller, sessionIdentity, onSpend])
  const keyLimits = session?.keyLimits ?? null
  const funds = useMemo(
    () => (session ? fundsState(BigInt(session.balance), keyLimits) : null),
    [session, keyLimits],
  )

  const value = useMemo<AuthContextValue>(
    () => ({
      identity: session?.identityId ?? null,
      balance: session?.balance ?? null,
      funds,
      keyLimits,
      isLoading: state.isLoading,
      error: state.error,
      signer,
      storage: session?.storage ?? null,
      limitedKeys: controller.supportsLimitedKeys(),
      vaults,
      importIdentity,
      adoptLimitedKey,
      unlock,
      loginWithRawKey,
      refreshBalance,
      logout,
      reloadVaults,
    }),
    [adoptLimitedKey, controller, funds, importIdentity, keyLimits, loginWithRawKey, logout, refreshBalance, reloadVaults, session, signer, state.error, state.isLoading, unlock, vaults],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/** Access the auth context. Throws if used outside an {@link AuthProvider}. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (ctx === undefined) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
