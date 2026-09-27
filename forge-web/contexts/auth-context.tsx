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
    options?: { readonly enablePrivateRepos?: boolean },
  ) => Promise<void>
  adoptLimitedKey: (identityId: string, key: LimitedKey, protection: Protection) => Promise<void>
  /** Store the keys a wallet granted (verified on chain) and open the session. */
  adoptWalletKeys: (identityId: string, keys: readonly WalletKey[], protection: Protection) => Promise<void>
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
  const controller = useMemo(() => new AuthController(() => ensureSdk(network), network), [network])
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
  const reloadVaults = useCallback(() => {
    controller.storedVaults().then(setVaults, () => setVaults([]))
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
      grants: session?.grants ?? null,
      unlimitedKey: session?.unlimited === true,
      unboundedKey: session?.unbounded === true,
      limitedKeys: controller.supportsLimitedKeys(),
      vaults,
      reloadVaults,
      controller,
      ...actions,
    }),
    [actions, controller, funds, keyLimits, reloadVaults, session, signer, state.error, state.isLoading, vaults],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/** Access the auth context. Throws if used outside an {@link AuthProvider}. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (ctx === undefined) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
