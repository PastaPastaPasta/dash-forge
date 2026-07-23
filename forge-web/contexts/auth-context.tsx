'use client'

/**
 * AuthContext — the React surface over {@link AuthController}.
 *
 * Exposes `{ identity, balance, login, logout, signer }` where `signer` is the key-free
 * {@link WriteAuth} the write paths consume (it reads the stored WIF at signing time; the key
 * never enters React state). Login imports a bridge-format identity file or a pasted WIF +
 * identity id. The SDK is obtained lazily from the process-wide `evoSdkService`, initialized on
 * the configured network with the registry contract preloaded.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { EvoSDK } from '@dashevo/evo-sdk'

import { AuthController, type AuthSession } from '../lib/auth'
import { DEFAULT_NETWORK, NETWORKS, type Network } from '../lib/constants'
import { evoSdkService, type WriteAuth } from '../lib/sdk'

async function ensureSdk(network: Network): Promise<EvoSDK> {
  const registry = NETWORKS[network].registryContractId
  const dpns = NETWORKS[network].dpnsContractId
  const contractIds = [registry, dpns].filter((id): id is string => id !== null)
  await evoSdkService.initialize({ network, contractIds, timeoutMs: 15000 })
  return evoSdkService.getSdk()
}

interface AuthContextValue {
  /** The logged-in identity id, or null. */
  readonly identity: string | null
  /** Credit balance as a decimal string (bigint-safe), or null when logged out. */
  readonly balance: string | null
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

  const session: AuthSession | null = state.session

  const value = useMemo<AuthContextValue>(
    () => ({
      identity: session?.identityId ?? null,
      balance: session?.balance ?? null,
      isLoading: state.isLoading,
      error: state.error,
      signer: controller.writeAuth,
      login,
      loginWithIdentityFile,
      refreshBalance,
      logout,
    }),
    [
      controller,
      login,
      loginWithIdentityFile,
      logout,
      refreshBalance,
      session,
      state.error,
      state.isLoading,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/** Access the auth context. Throws if used outside an {@link AuthProvider}. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (ctx === undefined) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
