/**
 * AuthController — the headless identity session for forge-web (`ux-dx-spec.md` §2).
 *
 * A session is an identity plus the key this browser signs with. The key is one of:
 *   - a PV14 **limited key** (the normal case): registered by importing an identity file or
 *     mnemonic (the master key signs one IdentityUpdate and is not retained), created with a new
 *     identity, or granted by a wallet through App Connect. It lives encrypted in the
 *     {@link ./vault} and, unlocked, only in that module's memory;
 *   - an **advanced raw key** pasted by a developer: held for this tab only (never stored),
 *     with a warning in the UI.
 *
 * The controller's observable state never carries key material. `writeAuth.getSigningKeyWif()`
 * reads the unlocked key at signing time and throws once the vault is locked.
 *
 * Earlier builds stored WIFs in plain `localStorage` (`forge_key_*`); on construction every
 * such entry is deleted.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { Network } from '../constants'
import { DEFAULT_NETWORK, NETWORKS } from '../constants'
import { errorMessage } from '../utils'
import { SECURITY_LEVEL, WriteAuthError, findSigningKey, readIdentityBalance, type WriteAuth } from '../sdk/write'
import { authSdk } from '../sdk/facade'
import type { KeyLimits } from '../view/funds'
import { normalizeToWif } from './wif'
import { identityFileMatchesNetwork, masterMaterialFromFile } from './identity-file'
import { deriveMasterKey, isValidMnemonic } from './hd'
import { readKeyLimits, registerLimitedKey, revokeLimitedKey, type LimitedKey, type LimitedKeyRequest } from './limited-key'
import {
  VaultLockedError,
  forgetVault,
  holdForSession,
  listVaults,
  lockVault,
  onVaultLock,
  clearSignedWrites,
  storeInVault,
  unlockWithPasskey,
  unlockWithPassphrase,
  unlockedSecret,
  type Protection,
  type VaultInfo,
  type VaultSecret,
} from './vault'

/** The public (key-free) session snapshot. */
export interface AuthSession {
  readonly identityId: string
  /** Credit balance (bigint-safe as a decimal string; parsed by the UI). */
  readonly balance: string
  readonly network: Network
  /** The signing key's budget and expiry, when it is a PV14 limited key. */
  readonly keyLimits?: KeyLimits | null
  /** The signing key's id on the identity. */
  readonly keyId?: number
  /** `vault`: a stored limited key; `session`: a tab-only key (advanced raw key). */
  readonly storage: 'vault' | 'session'
}

/** Observable controller state. Never carries private-key material. */
export interface AuthState {
  readonly session: AuthSession | null
  readonly isLoading: boolean
  readonly error: string | null
}

type Listener = (state: AuthState) => void

/** How the SDK is obtained — injected so the controller stays testable and SSR-safe. */
export type SdkProvider = () => Promise<EvoSDK>

/** Delete keys an earlier build left in plain localStorage. */
export function purgeLegacyKeystore(): void {
  if (typeof window === 'undefined') return
  try {
    const s = window.localStorage
    const doomed: string[] = []
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i)
      if (k?.startsWith('forge_key_')) doomed.push(k)
    }
    for (const k of doomed) s.removeItem(k)
  } catch {
    /* storage disabled */
  }
}

export class AuthController {
  private state: AuthState = { session: null, isLoading: false, error: null }
  private readonly listeners = new Set<Listener>()

  constructor(
    private readonly getSdk: SdkProvider,
    private readonly network: Network = DEFAULT_NETWORK,
  ) {
    purgeLegacyKeystore()
    // The 12-hour auto-lock ends the session too, so the UI offers Unlock instead of a
    // signed-in header whose every write fails.
    onVaultLock(() => {
      if (this.state.session?.storage === 'vault' || this.state.session?.storage === 'session') {
        this.setState({ session: null })
      }
    })
  }

  getState(): AuthState {
    return this.state
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private setState(patch: Partial<AuthState>): void {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l(this.state)
  }

  /** The dash-forge contract group this network's keys are bound to. */
  private group(): string {
    const v2 = NETWORKS[this.network].v2
    if (!v2) throw new Error(`forge-v2 is not deployed on ${NETWORKS[this.network].key}: limited keys need its contract group`)
    return v2.group
  }

  /** forge-core and forge-collab, which the group must hold. */
  forgeContracts(): readonly string[] {
    const v2 = NETWORKS[this.network].v2
    return v2 ? [v2.core, v2.collab] : []
  }

  /** Whether this network supports limited keys (protocol 14 + a forge-v2 group). */
  supportsLimitedKeys(): boolean {
    return NETWORKS[this.network].v2 !== null
  }

  /**
   * A {@link WriteAuth} bound to the current session. `getSigningKeyWif()` reads the unlocked
   * key at signing time, throwing a {@link WriteAuthError} when the vault has locked.
   */
  get writeAuth(): WriteAuth | null {
    const session = this.state.session
    if (!session) return null
    const network = this.network
    const identityId = session.identityId
    return {
      identityId,
      network,
      getSigningKeyWif(): string {
        const secret = unlockedSecret(network, identityId)
        if (!secret) throw new WriteAuthError('this browser is locked — unlock it to sign')
        return secret.wif
      },
    }
  }

  /** Vaults stored on this device for this network (for the unlock chooser). */
  storedVaults(): Promise<VaultInfo[]> {
    return listVaults(this.network)
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    this.setState({ isLoading: true, error: null })
    try {
      const v = await fn()
      this.setState({ isLoading: false })
      return v
    } catch (e) {
      this.setState({ isLoading: false, error: errorMessage(e) })
      throw e
    }
  }

  /**
   * Open a session for an unlocked secret: re-verify the key on chain, load balance + limits.
   * On failure the unlocked key is dropped again, so no key sits in memory without a session.
   */
  private async open(secret: VaultSecret, storage: AuthSession['storage'], knownLimits?: KeyLimits): Promise<AuthSession> {
    try {
      const sdk = await this.getSdk()
      const identity = await authSdk(sdk).identities.fetch(secret.identityId)
      if (!identity) throw new WriteAuthError(`identity ${secret.identityId} not found on ${this.network}`)
      const match = await findSigningKey(identity, secret.wif, this.network, SECURITY_LEVEL.HIGH)
      if (!match) throw new KeyNotUsableError()
      // A vault key is a limited key: bound to a group that no longer holds the forge contracts
      // (they were re-registered), it would open a session whose every write is refused.
      if (storage === 'vault') {
        const bounds = identity.publicKeys.find((k) => k.keyId === match.keyId)?.contractBounds?.toJSON()
        if (bounds?.$type === 'contractGroup' && bounds.id !== this.group()) {
          throw new KeyNotUsableError("this browser's key is bound to an old dash-forge contract group — renew it")
        }
      }
      const keyLimits = knownLimits ?? (await readKeyLimits(sdk, secret.identityId, match.keyId).catch(() => null))
      const session: AuthSession = {
        identityId: secret.identityId,
        balance: identity.balance.toString(),
        network: this.network,
        keyLimits,
        keyId: match.keyId,
        storage,
      }
      this.setState({ session })
      return session
    } catch (e) {
      lockVault()
      throw e
    }
  }

  /**
   * Store a freshly registered limited key in the vault and open its session. If the key is
   * stored but the session cannot open yet (a read failed), say so: the key is safe and
   * unlocking will continue.
   */
  private async adopt(identityId: string, key: LimitedKey, protection: Protection): Promise<AuthSession> {
    const secret: VaultSecret = { identityId, keyId: key.keyId, wif: key.wif }
    await storeInVault(this.network, secret, protection)
    try {
      return await this.open(secret, 'vault', key.limits)
    } catch (e) {
      throw new Error(`Key saved on this device, but signing in did not finish (${errorMessage(e)}). Unlock to continue.`)
    }
  }

  /**
   * Store a key in the vault before it is registered on chain (identity creation). It stays
   * unlocked for the {@link openStored} that follows; a failed run calls {@link logout}.
   */
  async persistKey(secret: VaultSecret, protection: Protection): Promise<void> {
    await storeInVault(this.network, secret, protection)
  }

  /**
   * Import an identity file or mnemonic once: its master key signs one IdentityUpdate that
   * registers a limited key for this browser (disabling the key this device held for it
   * before, when renewing), and is not retained. Only the limited key is kept, encrypted under
   * `protection`.
   */
  async importIdentity(
    input: { fileText: string } | { mnemonic: string; identityId: string },
    protection: Protection,
    request?: LimitedKeyRequest,
  ): Promise<AuthSession> {
    return this.run(async () => {
      let identityId: string
      let masterWif: string | null
      if ('fileText' in input) {
        const m = masterMaterialFromFile(input.fileText)
        this.checkFileNetwork(m.networkKey)
        identityId = m.identityId
        masterWif = m.masterWif ?? (m.mnemonic ? (await deriveMasterKey(m.mnemonic, this.network)).wif : null)
      } else {
        if (!(await isValidMnemonic(input.mnemonic))) throw new Error('those words are not a valid recovery phrase')
        identityId = input.identityId.trim()
        masterWif = (await deriveMasterKey(input.mnemonic, this.network)).wif
      }
      if (!masterWif) throw new Error('no master key found')
      const previous = (await listVaults(this.network)).find((v) => v.identityId === identityId)
      const sdk = await this.getSdk()
      const key = await registerLimitedKey(sdk, {
        network: this.network,
        identityId,
        masterWif,
        group: this.group(),
        ...(previous ? { replaceKeyId: previous.keyId } : {}),
        contracts: this.forgeContracts(),
        ...(request ? { request } : {}),
      })
      masterWif = null
      return this.adopt(identityId, key, protection)
    })
  }

  /** Refuse an identity file made for another network (a testnet key on a devnet build). */
  checkFileNetwork(networkKey: string | null): void {
    const buildKey = NETWORKS[this.network].key
    if (!identityFileMatchesNetwork(networkKey, buildKey)) {
      throw new Error(`identity file is for ${networkKey}, but this app is on ${buildKey}`)
    }
  }

  /** Adopt a limited key obtained elsewhere (identity creation, App Connect). */
  async adoptLimitedKey(identityId: string, key: LimitedKey, protection: Protection): Promise<AuthSession> {
    return this.run(() => this.adopt(identityId, key, protection))
  }

  /** Open the session of a key already in the vault and unlocked (identity creation). */
  async openStored(identityId: string, method: { passphrase: string } | 'passkey' | null, limits?: KeyLimits): Promise<AuthSession> {
    return this.run(async () => {
      const secret =
        unlockedSecret(this.network, identityId) ??
        (method === 'passkey'
          ? await unlockWithPasskey(this.network, identityId)
          : method !== null
            ? await unlockWithPassphrase(this.network, identityId, method.passphrase)
            : null)
      if (!secret) throw new VaultLockedError('unlock to continue')
      return this.open(secret, 'vault', limits)
    })
  }

  /** Unlock a stored vault and open its session. */
  async unlock(identityId: string, method: { passphrase: string } | 'passkey'): Promise<AuthSession> {
    return this.run(async () => {
      const secret =
        method === 'passkey'
          ? await unlockWithPasskey(this.network, identityId)
          : await unlockWithPassphrase(this.network, identityId, method.passphrase)
      return this.open(secret, 'vault')
    })
  }

  /**
   * Advanced: sign with a pasted private key for this tab only (never stored). The key must
   * control a HIGH or CRITICAL authentication key of the identity; MASTER keys are refused.
   */
  async loginWithRawKey(identityId: string, privateKey: string): Promise<AuthSession> {
    return this.run(async () => {
      const wif = normalizeToWif(privateKey, this.network)
      const secret: VaultSecret = { identityId: identityId.trim(), keyId: -1, wif }
      // HIGH or CRITICAL only (the sheet says so): findSigningKey with CRITICAL..HIGH.
      const sdk = await this.getSdk()
      const identity = await authSdk(sdk).identities.fetch(secret.identityId)
      if (!identity || !(await findSigningKey(identity, wif, this.network, SECURITY_LEVEL.HIGH))) {
        throw new WriteAuthError('that key does not control a usable (HIGH or CRITICAL) authentication key of this identity')
      }
      holdForSession(this.network, secret)
      try {
        return await this.open(secret, 'session')
      } catch (e) {
        if (e instanceof KeyNotUsableError) {
          throw new WriteAuthError('that key does not control a usable (HIGH or CRITICAL) authentication key of this identity')
        }
        throw e
      }
    })
  }

  /** Refresh the balance and the key's remaining budget. */
  async refreshBalance(): Promise<void> {
    const session = this.state.session
    if (!session) return
    const sdk = await this.getSdk()
    const [balance, keyLimits] = await Promise.all([
      readIdentityBalance(sdk, session.identityId),
      session.keyId === undefined ? Promise.resolve(null) : readKeyLimits(sdk, session.identityId, session.keyId).catch(() => session.keyLimits ?? null),
    ])
    const current = this.state.session
    if (current?.identityId !== session.identityId) return
    this.setState({ session: { ...current, balance: balance.toString(), keyLimits } })
  }

  /** Lock (keep the stored key; unlock to continue). The session ends with it. */
  logout(): void {
    lockVault()
    clearSignedWrites()
    this.setState({ session: null, error: null })
  }

  /**
   * Disable this device's key for `identityId` on chain (the identity file or phrase supplies
   * the master key, used once), then forget it here. Forgetting alone does not revoke.
   */
  async revokeStored(identityId: string, input: { fileText: string } | { mnemonic: string }): Promise<void> {
    return this.run(async () => {
      const stored = (await listVaults(this.network)).find((v) => v.identityId === identityId)
      if (!stored) throw new Error('no key for this identity is stored here')
      let masterWif: string | null
      if ('fileText' in input) {
        const m = masterMaterialFromFile(input.fileText)
        if (m.identityId !== identityId) throw new Error('that identity file is for another identity')
        this.checkFileNetwork(m.networkKey)
        masterWif = m.masterWif ?? (m.mnemonic ? (await deriveMasterKey(m.mnemonic, this.network)).wif : null)
      } else {
        masterWif = (await deriveMasterKey(input.mnemonic, this.network)).wif
      }
      if (!masterWif) throw new Error('no master key found')
      await revokeLimitedKey(await this.getSdk(), { network: this.network, identityId, masterWif, keyId: stored.keyId })
      masterWif = null
      await this.forget(identityId)
    })
  }

  /** Delete the stored key of `identityId` from this device (ending its session if open). */
  async forget(identityId: string): Promise<void> {
    if (this.state.session?.identityId === identityId) this.logout()
    await forgetVault(this.network, identityId)
  }
}

/** The key opened no longer controls a usable key on the identity (disabled, expired, wrong). */
export class KeyNotUsableError extends WriteAuthError {
  constructor(message = "this browser's key is no longer usable on the identity (disabled or expired) — renew it") {
    super(message)
    this.name = 'KeyNotUsableError'
  }
}
