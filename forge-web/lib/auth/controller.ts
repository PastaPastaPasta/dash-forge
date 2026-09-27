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
 * A key a shipped Dash wallet granted is bound to ONE Forge contract (or, from the Android
 * wallet, to none) and has no budget or expiry (docs/design/wallet-login.md). So a session holds
 * up to one key per contract: the vault's main key plus sealed extra grants, and
 * `getSigningKeyWif(contractId)` picks the key whose bounds cover that contract, or throws
 * {@link MissingGrantError} (the UI then asks the wallet for that contract) rather than sign a
 * write consensus would refuse and charge for.
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
import { DEPLOYMENTS, groupTrust, type ForgeIds, type GroupTrust } from '../deployments'
import { assertGroupHolds, type GroupCheck } from './group-trust'
import { SECURITY_LEVEL, WriteAuthError, findSigningKey, readIdentityBalance, type WriteAuth } from '../sdk/write'
import { authSdk, type WasmIdentity } from '../sdk/facade'
import type { KeyLimits } from '../view/funds'
import { normalizeToWif } from './wif'
import { identityFileMatchesNetwork, masterMaterialFromFile } from './identity-file'
import { deriveMasterKey, isValidMnemonic } from './hd'
import { checkWalletKey, hasNoLimits, keyScope, scopeCovers, type KeyScope, type WalletKey } from './key-registration'
import { encryptionMaterialFromFile, importEncryptionKey, wipeMaterial, type EncryptionMaterial } from './encryption-key'
import {
  disableHeldKeys,
  isForgeBrowserKey,
  readKeyLimits,
  registerLimitedKey,
  revokeLimitedKey,
  topUpLimitedKey,
  type HeldKey,
  type LimitedKey,
  type LimitedKeyRequest,
  type TopUpRequest,
} from './limited-key'
import {
  VaultLockedError,
  addExtraKey,
  forgetVault,
  hasExtraKeys,
  holdForSession,
  listVaults,
  lockVault,
  onVaultLock,
  clearSignedWrites,
  storeInVault,
  unlockWithPasskey,
  unlockWithPassphrase,
  unlockedSecret,
  type ExtraKey,
  type Protection,
  type StoreOutcome,
  type VaultInfo,
  type VaultSecret,
} from './vault'

/** The notice when a renewal could not carry the encryption key over. */
const ENCRYPTION_KEY_DROPPED =
  'Your encryption key for private repos was sealed with the previous key, which was locked when you renewed it, so it was not carried over. Add it again in Settings → Keys → Enable private repos.'

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
  /** Which Forge contracts this session's keys can sign on. */
  readonly grants?: { readonly core: boolean; readonly collab: boolean }
  /**
   * A key this session holds has no budget or no expiry (a shipped wallet's key): whoever copies
   * it can spend until it is disabled. The UI warns.
   */
  readonly unlimited?: boolean
  /** A key this session holds has no contract bounds: it could sign outside Forge too. */
  readonly unbounded?: boolean
}

/** A write to a Forge contract no key of this session covers: ask the wallet for that grant. */
export class MissingGrantError extends WriteAuthError {
  constructor(readonly contractId: string) {
    super('This sign-in only covers repositories and pushes. Approve issues, pull requests and stars in your wallet too.')
    this.name = 'MissingGrantError'
  }
}

/** Observable controller state. Never carries private-key material. */
export interface AuthState {
  readonly session: AuthSession | null
  readonly isLoading: boolean
  readonly error: string | null
  /** Something the user should know after a sign-in step succeeded (null when nothing). */
  readonly notice?: string | null
}

type Listener = (state: AuthState) => void

/** Where a one-time master key comes from: an identity file, or the recovery phrase. */
export type MasterInput = { fileText: string } | { mnemonic: string }

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

  /** The UI showed the notice: clear it, so the next one (even the same text) shows too. */
  clearNotice(): void {
    if (this.state.notice) this.setState({ notice: null })
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

  /** The group's trust root as the bundled deployment pins it (`groupTrust`). */
  groupTrust(): GroupTrust {
    const trust = groupTrust(DEPLOYMENTS[NETWORKS[this.network].key])
    if (!trust) throw new Error(`forge-v2 is not deployed on ${NETWORKS[this.network].key}: limited keys need its contract group`)
    return trust
  }

  /**
   * Check the group on chain before offering to bind a key to it: throws a refusal, or returns
   * the members this build does not know (shown on the key-creation screen).
   */
  async checkGroup(): Promise<GroupCheck> {
    return assertGroupHolds(await this.getSdk(), this.group(), this.groupTrust())
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
    const pick = (contractId?: string): string => {
      // The session as it is now, not as it was when this signer was made.
      const current = this.state.session
      if (!current || current.identityId !== identityId) throw new WriteAuthError('this browser is signed out — sign in to sign')
      const secret = unlockedSecret(network, identityId)
      if (!secret) throw new WriteAuthError('this browser is locked — unlock it to sign')
      // A pasted key (tab-only, advanced) is the user's own choice of power: no scoping.
      if (current.storage !== 'vault') return secret.wif
      // A vault key only ever signs on Forge's two contracts, named by the write.
      const forge = NETWORKS[network].v2
      if (forge === null || (contractId !== forge.core && contractId !== forge.collab)) {
        throw new WriteAuthError(`this browser's key signs only Dash Forge writes${contractId ? ` (not ${contractId})` : ''}`)
      }
      if (this.scopes.main && scopeCovers(this.scopes.main, forge, contractId)) return secret.wif
      const extra = secret.extra?.find((e) => {
        const scope = this.scopes.extra.get(e.keyId)
        return scope !== undefined && scopeCovers(scope, forge, contractId)
      })
      if (extra) return extra.wif
      throw new MissingGrantError(contractId)
    }
    return { identityId, network, getSigningKeyWif: pick }
  }

  /** The verified scopes of the open session's keys (main, and extra grants by key id). */
  private scopes: { main: KeyScope | null; extra: Map<number, KeyScope> } = { main: null, extra: new Map() }

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
  private async open(secret: VaultSecret, storage: AuthSession['storage'], knownLimits?: KeyLimits, lockOnFailure = true): Promise<AuthSession> {
    try {
      const sdk = await this.getSdk()
      const identity = await authSdk(sdk).identities.fetch(secret.identityId)
      if (!identity) throw new WriteAuthError(`identity ${secret.identityId} not found on ${this.network}`)
      const match = await findSigningKey(identity, secret.wif, this.network, SECURITY_LEVEL.HIGH)
      if (!match) throw new KeyNotUsableError()
      const keyLimits = knownLimits ?? (await readKeyLimits(sdk, secret.identityId, match.keyId).catch(() => null))
      let extra: Pick<AuthSession, 'grants' | 'unlimited' | 'unbounded'> = {}
      if (storage === 'vault') {
        const forge = NETWORKS[this.network].v2
        if (!forge) throw new KeyNotUsableError(`Dash Forge is not deployed on ${NETWORKS[this.network].key}`)
        extra = await this.verifyScopes(identity, secret, match.keyId, forge)
      }
      const session: AuthSession = {
        identityId: secret.identityId,
        balance: identity.balance.toString(),
        network: this.network,
        keyLimits,
        keyId: match.keyId,
        storage,
        ...extra,
      }
      this.setState({ session })
      return session
    } catch (e) {
      if (lockOnFailure) lockVault()
      throw e
    }
  }

  /**
   * Work out what the vault's keys may sign: the main key must be inside Forge's contracts
   * (a key on an old contract group, or another app's, opens no session), and each extra grant
   * that is still live, HIGH, controlled by its stored key and inside one Forge contract is kept.
   */
  private async verifyScopes(
    identity: WasmIdentity,
    secret: VaultSecret,
    keyId: number,
    forge: ForgeIds,
  ): Promise<Pick<AuthSession, 'grants' | 'unlimited' | 'unbounded'>> {
    const mainKey = identity.publicKeys.find((k) => k.keyId === keyId)
    if (!mainKey) throw new KeyNotUsableError()
    const main = keyScope(mainKey, forge)
    if (main === null) {
      const bounds = mainKey.contractBounds?.toJSON()
      throw new KeyNotUsableError(
        bounds?.$type === 'contractGroup'
          ? "this browser's key is bound to an old dash-forge contract group — renew it"
          : "this browser's key is bound to contracts outside Dash Forge",
      )
    }
    const extraScopes = new Map<number, KeyScope>()
    let core = main.core
    let collab = main.collab
    let unbounded = main.unbounded
    let unlimited = hasNoLimits(mainKey)
    for (const e of secret.extra ?? []) {
      const k = identity.publicKeys.find((x) => x.keyId === e.keyId)
      if (!k) continue
      let scope: KeyScope
      try {
        // A malformed or stale grant is skipped, never a reason to fail the unlock.
        scope = checkWalletKey(k, e.wif, forge, this.network)
      } catch {
        continue
      }
      extraScopes.set(e.keyId, scope)
      core ||= scope.core
      collab ||= scope.collab
      unbounded ||= scope.unbounded
      unlimited ||= hasNoLimits(k)
    }
    this.scopes = { main, extra: extraScopes }
    return { grants: { core, collab }, unlimited, unbounded }
  }

  /**
   * Store a freshly registered limited key in the vault and open its session. If the key is
   * stored but the session cannot open yet (a read failed), say so: the key is safe and
   * unlocking will continue.
   */
  private async adopt(identityId: string, key: LimitedKey, protection: Protection): Promise<AuthSession> {
    const secret: VaultSecret = { identityId, keyId: key.keyId, wif: key.wif }
    const outcome = await storeInVault(this.network, secret, protection)
    this.noteDropped(
      outcome,
      'Your storage settings were sealed with the previous key, which was locked when you renewed it, so they could not be carried over. Add your storage again in Settings → Storage.',
    )
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
    options: { readonly enablePrivateRepos?: boolean } = {},
  ): Promise<AuthSession> {
    return this.run(async () => {
      let identityId: string
      let masterWif: string | null
      // Opt-in (`ux-dx-spec.md` §2.3): the identity's ENCRYPTION key from the same file or
      // phrase, checked against the identity and sealed beside the limited key.
      let material: EncryptionMaterial | { mnemonic: string } | null = null
      if (options.enablePrivateRepos === true) {
        material = 'fileText' in input ? encryptionMaterialFromFile(input.fileText) : { mnemonic: input.mnemonic }
      }
      try {
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
      // Renewing also disables the wallet keys this browser holds for the identity (a shipped
      // wallet's keys have no limits: replacing them is how they get limits). That needs them
      // unlocked: replacing a locked wallet-key vault would forget keys it cannot disable.
      if (previous) await this.assertUnlockedIfWalletKeys(sdk, identityId, previous.keyId)
      const held = this.heldKeys(identityId)
      const key = await registerLimitedKey(sdk, {
        network: this.network,
        identityId,
        masterWif,
        group: this.group(),
        ...(previous ? { replaceKeyId: previous.keyId } : {}),
        ...(held.length ? { disableHeld: held } : {}),
        trust: this.groupTrust(),
        ...(request ? { request } : {}),
      })
      masterWif = null
      const session = await this.adopt(identityId, key, protection)
      if (material !== null) await this.enableEncryption(identityId, material)
      return session
      } finally {
        if (material !== null && 'keys' in material) wipeMaterial(material)
      }
    })
  }

  /** Tell the user what a renewal could not carry over (one notice, both parts). */
  private noteDropped(outcome: StoreOutcome, storageText: string): void {
    const parts = [...(outcome.storageSettingsDropped ? [storageText] : []), ...(outcome.encryptionKeyDropped ? [ENCRYPTION_KEY_DROPPED] : [])]
    if (parts.length > 0) this.setState({ notice: parts.join(' ') })
  }

  /**
   * Seal the identity's encryption key into the vault from an identity file's material or a
   * recovery phrase. Signing in never fails on it: when the identity has no usable encryption
   * key (or the material cannot open one), the user is told how to add one.
   */
  private async enableEncryption(identityId: string, material: EncryptionMaterial | { mnemonic: string }): Promise<void> {
    const core = NETWORKS[this.network].v2?.core
    if (core === undefined) return
    try {
      const keyId = await importEncryptionKey(await this.getSdk(), this.network, identityId, core, material)
      if (keyId === null) {
        this.setState({
          notice:
            'This identity has no encryption key that your file or phrase can open, so private repos are not enabled yet. Settings → Keys → Enable private repos registers one (one master-key signature).',
        })
      }
    } catch (e) {
      this.setState({ notice: `Signed in, but private repos could not be enabled: ${errorMessage(e)}` })
    }
  }

  /** Refuse an identity file made for another network (a testnet key on a devnet build). */
  checkFileNetwork(networkKey: string | null): void {
    const buildKey = NETWORKS[this.network].key
    if (!identityFileMatchesNetwork(networkKey, buildKey)) {
      throw new Error(`identity file is for ${networkKey}, but this app is on ${buildKey}`)
    }
  }

  /** Adopt a limited key obtained elsewhere (identity creation). */
  async adoptLimitedKey(identityId: string, key: LimitedKey, protection: Protection): Promise<AuthSession> {
    return this.run(() => this.adopt(identityId, key, protection))
  }

  /**
   * Adopt the keys a wallet granted (verified on chain by the caller): the first is the vault's
   * main key, each further one is kept as the grant for the contract it covers.
   */
  async adoptWalletKeys(identityId: string, keys: readonly WalletKey[], protection: Protection): Promise<AuthSession> {
    return this.run(async () => {
      const [main, ...rest] = keys
      if (!main) throw new Error('the wallet granted no key')
      const forge = NETWORKS[this.network].v2
      if (!forge) throw new Error(`Dash Forge is not deployed on ${NETWORKS[this.network].key}`)
      const previous = (await listVaults(this.network)).find((v) => v.identityId === identityId)
      if (previous) await this.assertUnlockedIfWalletKeys(await this.getSdk(), identityId, previous.keyId)
      // Nothing this browser holds for the identity is dropped: the keys it held before stay
      // beside the new ones (a returning login keeps its forge-collab grant; a key the new
      // grant supersedes is still held, so a later revoke can disable it). Stale ones fall
      // out at the next unlock.
      const fresh = new Set([main.keyId, ...rest.map((k) => k.keyId)])
      const kept: ExtraKey[] = this.heldKeys(identityId)
        .filter((h) => !fresh.has(h.keyId))
        .map((h) => ({ contractId: 'contractId' in h ? h.contractId : forge.core, keyId: h.keyId, wif: h.wif }))
      const extra = [...rest.map((k) => toExtraKey(k, forge)), ...kept]
      const secret: VaultSecret = { identityId, keyId: main.keyId, wif: main.wif, ...(extra.length ? { extra } : {}) }
      this.noteDropped(
        await storeInVault(this.network, secret, protection),
        'Your storage settings could not be carried over to the new key. Add your storage again in Settings → Storage.',
      )
      try {
        return await this.open(secret, 'vault', main.limits ?? undefined)
      } catch (e) {
        throw new Error(`Key saved on this device, but signing in did not finish (${errorMessage(e)}). Unlock to continue.`)
      }
    })
  }

  /**
   * Add a wallet grant for another Forge contract to the signed-in identity (a shipped wallet
   * grants one contract per approval). The key must belong to the session's identity.
   */
  async addWalletGrant(identityId: string, key: WalletKey, requested: string): Promise<AuthSession> {
    return this.run(async () => {
      const session = this.state.session
      const forge = NETWORKS[this.network].v2
      if (!session || session.identityId !== identityId || session.storage !== 'vault' || !forge) {
        throw new Error('sign in with this identity first')
      }
      if (!scopeCovers(key.scope, forge, requested)) throw new Error('the wallet granted a key that does not cover what was asked for; try again')
      await addExtraKey(this.network, identityId, toExtraKey(key, forge, requested))
      const secret = unlockedSecret(this.network, identityId)
      if (!secret) throw new VaultLockedError('unlock to continue')
      try {
        const opened = await this.open(secret, 'vault', session.keyLimits ?? undefined, false)
        const want = requested === forge.collab ? 'collab' : 'core'
        if (!opened.grants?.[want]) throw new Error('the granted key is not live on the identity yet')
        return opened
      } catch (e) {
        // The grant is stored; keep the session that was working and say what failed.
        this.setState({ session })
        throw new Error(`The approval was saved, but checking it on Platform failed (${errorMessage(e)}). It will be checked again when you next unlock.`)
      }
    })
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
  async revokeStored(identityId: string, input: MasterInput): Promise<void> {
    return this.run(async () => {
      const stored = (await listVaults(this.network)).find((v) => v.identityId === identityId)
      if (!stored) throw new Error('no key for this identity is stored here')
      const sdk = await this.getSdk()
      await this.assertUnlockedIfWalletKeys(sdk, identityId, stored.keyId)
      let masterWif: string | null = await this.masterWifFor(identityId, input)
      const held = this.heldKeys(identityId)
      if (held.length > 1 || (held.length === 1 && this.state.session?.unlimited)) {
        // Wallet keys (and any Forge key beside them): disable every key this browser holds.
        await disableHeldKeys(sdk, { network: this.network, identityId, masterWif, keys: held })
      } else {
        await revokeLimitedKey(sdk, { network: this.network, identityId, masterWif, keyId: stored.keyId })
      }
      masterWif = null
      await this.forget(identityId)
    })
  }

  /**
   * Raise the limits of the key this session signs with (`IdentityKeyLimitsUpdate`): the
   * identity file or phrase supplies the master key, which signs once and is not retained.
   * The key id and the stored private key do not change. The session's `keyLimits` are
   * replaced with what the chain now shows.
   */
  async topUpKey(input: MasterInput, request: TopUpRequest): Promise<KeyLimits> {
    return this.run(async () => {
      const session = this.state.session
      if (!session || session.storage !== 'vault' || session.keyId === undefined) {
        throw new Error("only a stored Forge browser key can be topped up; sign in with your identity first")
      }
      const { identityId, keyId } = session
      let masterWif: string | null = await this.masterWifFor(identityId, input)
      const limits = await topUpLimitedKey(await this.getSdk(), { network: this.network, identityId, masterWif, keyId, request })
      masterWif = null
      const current = this.state.session
      if (current?.identityId === identityId && current.keyId === keyId) this.setState({ session: { ...current, keyLimits: limits } })
      return limits
    })
  }

  /**
   * Every key this browser holds for `identityId` (the vault's main key and its wallet grants),
   * with the private keys that prove it, while that vault is unlocked; [] otherwise. A renewal
   * or revoke passes them all to the master-key update, which disables only live HIGH keys the
   * stored private key controls ({@link heldToDisable}).
   */
  private heldKeys(identityId: string): (HeldKey | ExtraKey)[] {
    const secret = this.unlockedVaultSecret(identityId)
    if (!secret) return []
    return [{ keyId: secret.keyId, wif: secret.wif }, ...(secret.extra ?? [])].filter((k) => k.keyId >= 0)
  }

  /**
   * The unlocked secret of `identityId` when it is the VAULT's (a signed-in vault session), else
   * null. A pasted raw key (tab-only, key id -1) is also held unlocked, but it is not the vault:
   * it must never be stored, carried into a vault, or stand in for an unlocked vault.
   */
  private unlockedVaultSecret(identityId: string): VaultSecret | null {
    const session = this.state.session
    if (session?.identityId !== identityId || session.storage !== 'vault') return null
    const secret = unlockedSecret(this.network, identityId)
    return secret && secret.keyId >= 0 ? secret : null
  }

  /**
   * Replacing or revoking a stored vault must not forget a live key it cannot disable. A vault
   * whose main key is a Forge browser key and that holds no wallet grants is fine locked (the
   * renewal disables that key by id). Any other (a wallet key, or wallet grants beside it)
   * must be unlocked first, so every key it holds is disabled in the same update.
   */
  private async assertUnlockedIfWalletKeys(sdk: EvoSDK, identityId: string, storedKeyId: number): Promise<void> {
    if (this.unlockedVaultSecret(identityId)) return
    const identity = await authSdk(sdk).identities.fetch(identityId)
    const k = identity?.publicKeys.find((x) => x.keyId === storedKeyId)
    const liveOther = k !== undefined && k.disabledAt === undefined && !isForgeBrowserKey(k)
    if (liveOther || (await hasExtraKeys(this.network, identityId))) {
      throw new VaultLockedError(
        'This device holds wallet keys for this identity. Unlock first (Sign in → Unlock), so they can be disabled on chain in the same update; otherwise they would stay live after this device forgets them.',
      )
    }
  }

  /**
   * The master key (WIF) of `identityId` from an identity file or recovery phrase. The caller
   * drops it as soon as it has signed. A file for another identity or network is refused.
   */
  private async masterWifFor(identityId: string, input: MasterInput): Promise<string> {
    let masterWif: string | null
    if ('fileText' in input) {
      const m = masterMaterialFromFile(input.fileText)
      if (m.identityId !== identityId) throw new Error('that identity file is for another identity')
      this.checkFileNetwork(m.networkKey)
      masterWif = m.masterWif ?? (m.mnemonic ? (await deriveMasterKey(m.mnemonic, this.network)).wif : null)
    } else {
      if (!(await isValidMnemonic(input.mnemonic))) throw new Error('those words are not a valid recovery phrase')
      masterWif = (await deriveMasterKey(input.mnemonic, this.network)).wif
    }
    if (!masterWif) throw new Error('no master key found')
    return masterWif
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

/**
 * A wallet grant as kept in the vault, under the contract it was asked for when its scope
 * covers that one (a group-bound or unbounded key answering a forge-collab request is the
 * forge-collab grant), else under the one Forge contract it covers.
 */
function toExtraKey(key: WalletKey, forge: ForgeIds, requested?: string): ExtraKey {
  const contractId = requested !== undefined && scopeCovers(key.scope, forge, requested) ? requested : key.scope.core ? forge.core : forge.collab
  return { contractId, keyId: key.keyId, wif: key.wif }
}
