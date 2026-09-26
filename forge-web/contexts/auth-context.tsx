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

import { AuthController, type AuthSession } from '../lib/auth'
import { DEFAULT_NETWORK, NETWORKS, type Network } from '../lib/constants'
import { evoSdkService, type SpendEvent, type WriteAuth } from '../lib/sdk'
import { recordSpend } from '../lib/spend'
import { fundsState, type FundsState, type KeyLimits } from '../lib/view/funds'
import { toast } from '../hooks/use-toasts'

async function ensureSdk(network: Network): Promise<EvoSDK> {
  const { registryContractId, dpnsContractId, v2 } = NETWORKS[network]
  const contractIds = [registryContractId, dpnsContractId, v2?.core, v2?.collab].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  )
  await evoSdkService.initialize({ network, contractIds, timeoutMs: 15000 })
  return evoSdkService.getSdk()
}

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
  login: (identityId: string, privateKey: string) => Promise<void>
  loginWithIdentityFile: (text: string) => Promise<void>
  refreshBalance: () => Promise<void>
  logout: () => void
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

  const login = useCallback(
    async (identityId: string, privateKey: string) => {
      await controller.login(identityId, privateKey)
    },
    [controller],
  )

  const loginWithIdentityFile = useCallback(
    async (text: string) => {
      await controller.loginWithIdentityFile(text)
    },
    [controller],
  )

  const refreshBalance = useCallback(async () => {
    await controller.refreshBalance()
  }, [controller])

  const logout = useCallback(() => {
    controller.logout()
  }, [controller])

  const onSpend = useCallback(
    (event: SpendEvent) => {
      toast({ title: SPEND_TITLES[event.kind] ?? 'Write confirmed', credits: event.actualCredits ?? null })
      void (async () => {
        let after: bigint | null = null
        try {
          await controller.refreshBalance()
          after = BigInt(controller.getState().session?.balance ?? '0')
        } catch {
          /* the ledger still records the row */
        }
        await recordSpend(event, after).catch(() => undefined)
      })()
    },
    [controller],
  )

  const session: AuthSession | null = state.session
  const writeAuth = session ? controller.writeAuth : null
  const signer = useMemo<WriteAuth | null>(
    () => (writeAuth ? { ...writeAuth, getSigningKeyWif: writeAuth.getSigningKeyWif, onSpend } : null),
    // `writeAuth` is rebuilt per render; the session identity is what it depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session?.identityId, onSpend],
  )
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
      login,
      loginWithIdentityFile,
      refreshBalance,
      logout,
    }),
    [funds, keyLimits, login, loginWithIdentityFile, logout, refreshBalance, session, signer, state.error, state.isLoading],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/** Access the auth context. Throws if used outside an {@link AuthProvider}. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (ctx === undefined) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
