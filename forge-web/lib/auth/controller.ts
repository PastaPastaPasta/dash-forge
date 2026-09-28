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
import { stepClock, timed } from '../step-timing'
import { DEPLOYMENTS, groupTrust, type ForgeIds, type GroupTrust } from '../deployments'
import { assertGroupHolds, type GroupCheck } from './group-trust'
import { SECURITY_LEVEL, WriteAuthError, findSigningKey, measureActual, readIdentityBalance, serialized, type SpendEvent, type WriteAuth } from '../sdk/write'
import { KEY_LIMITS_UPDATE_CREDITS, KEY_REGISTER_CREDITS, KEY_RENEW_CREDITS } from '../sdk/cost'
import { authSdk, type WasmIdentity } from '../sdk/facade'
import type { HeldBrowserKey } from './create-identity'
import type { KeyLimits } from '../view/funds'
import { controlsKey, normalizeToWif } from './wif'
import { retryWhileMissing } from '../view/retry'
import { identityFileMatchesNetwork, masterMaterialFromFile } from './identity-file'
import { deriveMasterKey, isValidMnemonic } from './hd'
import { identityOfMasterKey } from './identity-lookup'
import { PLATFORM_READ_MS } from './connect'
import { withTimeout } from '../timeout'
import { checkWalletKey, hasNoLimits, keyScope, scopeCovers, type KeyScope, type WalletKey } from './key-registration'
import { PRIVATE_REPOS_FLOW, encryptionMaterialFromFile, importEncryptionKey, wipeMaterial, type EncryptionMaterial } from './encryption-key'
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
  stageInVault,
  hasStaged,
  recoverStaged,
  abandonStaged,
  openStaged,
  forgetPasskeyOutputs,
  stagedInfo,
  unlockWithProtection,
  type RecoverResult,
  type StagedKeyState,
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
  /**
   * Keys this browser holds only so the next renewal or revoke disables them (a renewal given
   * up for a wallet sign-in, D-016), by key id. They never sign.
   */
  readonly heldOnly?: readonly number[]
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
  /** The step a running sign-in is on ("Registering the key on Platform"), for the sheet. */
  readonly step?: string | null
}

type Listener = (state: AuthState) => void

/**
 * A Forge action on the identity itself that the balance pays for (`ux-dx-spec.md` §4 rule 3:
 * the spend ledger records it, so reconciliation does not count it as "unexplained"). Platform
 * meters these (storage + processing, no flat fee); the cost is measured from the balance.
 */
export type KeySpendKind = 'key:register' | 'key:renew' | 'key:topup' | 'key:revoke' | 'key:encryption' | 'identity:create'

/** The pre-sign estimate per kind (credits); 0 where none was ever measured. */
export const KEY_SPEND_ESTIMATES: Readonly<Record<KeySpendKind, number>> = {
  'key:register': KEY_REGISTER_CREDITS,
  'key:renew': KEY_RENEW_CREDITS,
  'key:topup': KEY_LIMITS_UPDATE_CREDITS,
  'key:revoke': 0,
  'key:encryption': 0,
  'identity:create': 0,
}

/**
 * A charge to report: its kind, the key it concerns, and the balance right before it (for an
 * identity creation, the asset lock's credit value: the fee comes out of the lock).
 */
export interface KeyCharge {
  readonly kind: KeySpendKind
  readonly keyId: number | null
  readonly balanceBefore: bigint | null
}

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

  private spendListener: ((event: SpendEvent) => void) | null = null

  /** Told about every identity update this controller pays for (the spend ledger listens). */
  setSpendListener(listener: ((event: SpendEvent) => void) | null): void {
    this.spendListener = listener
  }

  /**
   * Report a charge made outside {@link charged} (identity creation, whose fee comes out of the
   * asset lock): the balance change from `balanceBefore`, measured as `write.ts` measures a
   * document write (read until it moves; null when it did not in time).
   */
  reportCharge(identityId: string, charge: KeyCharge): void {
    const before = charge.balanceBefore
    if (!this.spendListener || before === null) return
    void this.getSdk()
      .then((sdk) => measureActual(sdk, identityId, before))
      .then((actualCredits) => this.emitSpend(identityId, charge, actualCredits))
      .catch(() => undefined)
  }

  /**
   * Run a master-key identity update as this identity's only writer and record what it cost.
   * The balance is read before the update and measured after it while the writer lock is
   * still held, so a document write queued behind it cannot fold into this row (or this fee
   * into its). An update that returns `false` sent nothing (a revoke of an already disabled
   * key) and is not recorded; a failed one is recorded only if the balance moved (it landed,
   * or paid a fee).
   */
  private async charged<T>(identityId: string, kind: KeySpendKind, keyIdOf: (result: T | null) => number | null, update: () => Promise<T>): Promise<T> {
    const sdk = await this.getSdk()
    return serialized(identityId, async () => {
      const before = await readIdentityBalance(sdk, identityId).catch(() => null)
      const listening = before !== null && this.spendListener !== null
      let result: T
      try {
        result = await update()
      } catch (e) {
        // One read, no polling: most failures happen before anything is sent, and the error
        // should not wait on a balance that will not move.
        if (listening) {
          const now = await readIdentityBalance(sdk, identityId).catch(() => null)
          if (now !== null && now !== before) this.emitSpend(identityId, { kind, keyId: keyIdOf(null), balanceBefore: before }, Number(before! - now))
        }
        throw e
      }
      if (listening && result !== false) {
        const actualCredits = await measureActual(sdk, identityId, before).catch(() => null)
        this.emitSpend(identityId, { kind, keyId: keyIdOf(result), balanceBefore: before }, actualCredits)
      }
      return result
    })
  }

  private emitSpend(identityId: string, { kind, keyId, balanceBefore }: KeyCharge, actualCredits: number | null): void {
    this.spendListener?.({
      identityId,
      network: this.network,
      kind,
      repo: null,
      documentId: keyId === null ? 'identity' : `key-${keyId}`,
      estimateCredits: KEY_SPEND_ESTIMATES[kind],
      actualCredits,
      balanceBefore,
    })
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
        if (e.holdOnly) return false
        const scope = this.scopes.extra.get(e.keyId)
        return scope !== undefined && scopeCovers(scope, forge, contractId)
      })
      if (extra) return extra.wif
      throw new MissingGrantError(contractId)
    }
    return { identityId, network, getSigningKeyWif: pick }
  }

  /** Times the named steps of the running sign-in (`lib/step-timing.ts`, L-20); one clock per run. */
  private stepTimer = stepClock('sign-in')

  /** The verified scopes of the open session's keys (main, and extra grants by key id). */
  private scopes: { main: KeyScope | null; extra: Map<number, KeyScope> } = { main: null, extra: new Map() }

  /** Vaults stored on this device for this network (for the unlock chooser). */
  storedVaults(): Promise<VaultInfo[]> {
    return listVaults(this.network)
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    this.stepTimer = stepClock('sign-in')
    this.setState({ isLoading: true, error: null, step: null })
    try {
      const v = await fn()
      this.setState({ isLoading: false, step: null })
      return v
    } catch (e) {
      this.setState({ isLoading: false, error: errorMessage(e), step: null })
      throw e
    } finally {
      this.stepTimer(null)
    }
  }

  /** Name the step a running sign-in is on. */
  private step(text: string): void {
    this.stepTimer(text)
    this.setState({ step: text })
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
      // Held to be disabled later: listed while still live on the identity.
      const heldOnly = (secret.extra ?? [])
        .filter((e) => e.holdOnly && identity.publicKeys.some((k) => k.keyId === e.keyId && k.disabledAt === undefined))
        .map((e) => e.keyId)
      const session: AuthSession = {
        identityId: secret.identityId,
        balance: identity.balance.toString(),
        network: this.network,
        keyLimits,
        keyId: match.keyId,
        storage,
        ...extra,
        ...(heldOnly.length ? { heldOnly } : {}),
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
      // Held only to be disabled later: it grants nothing.
      if (e.holdOnly) continue
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
   * Move a registered key into the vault's main record. Registered and staged (D-016) but not
   * moved: the key is safe on this device, and the next unlock finishes the move.
   */
  private async commitKey(secret: VaultSecret, protection: Protection): Promise<StoreOutcome> {
    try {
      return await storeInVault(this.network, secret, protection)
    } catch (e) {
      if (await hasStaged(this.network, secret.identityId).catch(() => false)) {
        throw new Error(`The new key is registered and saved on this device, but finishing sign-in failed (${errorMessage(e)}). Unlock to continue.`)
      }
      throw e
    }
  }

  /**
   * Store a freshly registered limited key in the vault and open its session. If the key is
   * stored but the session cannot open yet (a read failed), say so: the key is safe and
   * unlocking will continue.
   */
  private async adopt(identityId: string, key: LimitedKey, protection: Protection, committed?: StoreOutcome): Promise<AuthSession> {
    const secret: VaultSecret = { identityId, keyId: key.keyId, wif: key.wif }
    const outcome = committed ?? (await this.commitKey(secret, protection))
    this.noteDropped(
      outcome,
      'Your storage settings were sealed with the previous key, which was locked when you renewed it, so they could not be carried over. Add your storage again in Settings → Storage.',
    )
    if (outcome.readBackFailed) {
      this.setState({ notice: "Signed in, but this browser may not keep the key after it closes (its storage did not read back). Keep your identity file or recovery phrase handy." })
    }
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
  async persistKey(secret: VaultSecret, protection: Protection, options: { readonly staged?: boolean } = {}): Promise<void> {
    if (options.staged) await stageInVault(this.network, secret, protection)
    else await storeInVault(this.network, secret, protection)
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
    options: {
      readonly enablePrivateRepos?: boolean
      /** Replace the key this browser holds for the identity (renewal), even when found by words. */
      readonly renew?: boolean
    } = {},
  ): Promise<AuthSession> {
    return this.run(async () => {
      let identityId: string
      let foundByWords = false
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
        this.step('Checking the recovery phrase')
        if (!(await isValidMnemonic(input.mnemonic))) throw new Error('those words are not a valid recovery phrase')
        const master = await deriveMasterKey(input.mnemonic, this.network)
        masterWif = master.wif
        identityId = input.identityId.trim()
        // The words alone: the identity is the one holding their master key.
        if (identityId === '') {
          this.step('Finding the identity of these words')
          identityId = await withTimeout(
            identityOfMasterKey(await this.getSdk(), master.publicKeyHex, this.network),
            PLATFORM_READ_MS,
            'Finding the identity of these words',
          )
          foundByWords = true
        }
      }
      if (!masterWif) throw new Error('no master key found')
      this.step("Checking this browser's stored keys")
      const previous = (await listVaults(this.network)).find((v) => v.identityId === identityId)
      // Found from the words, and this browser already holds a key for it: the user never saw
      // the "Unlock it instead" choice, so don't turn signing back in into a paid renewal.
      if (foundByWords && previous && options.renew !== true) throw new AlreadyStoredError(identityId)
      this.step('Connecting to Dash Platform')
      const sdk = await this.getSdk()
      // Renewing also disables the wallet keys this browser holds for the identity (a shipped
      // wallet's keys have no limits: replacing them is how they get limits). That needs them
      // unlocked: replacing a locked wallet-key vault would forget keys it cannot disable.
      if (previous) await this.assertUnlockedIfWalletKeys(sdk, identityId, previous.keyId)
      const held = this.heldKeys(identityId)
      this.step('Registering the key on Platform')
      // The master key lives in this closure until the update is signed (a JS string cannot be
      // wiped; nothing else keeps a reference to it).
      const signWith = masterWif
      // D-016: stage (store and read back) → the identity update that registers the key and
      // disables the old key and wallet grants → commit to the main record, all under this
      // identity's one writer lock, so another tab cannot stage or commit in between. If this
      // browser cannot keep the key, nothing changes on chain. A failure after the stage keeps
      // it: the next unlock asks Platform whether it was registered, and adopts it or keeps
      // waiting (it is only dropped on proof it never was).
      const { key, committed } = await this.charged(identityId, previous ? 'key:renew' : 'key:register', (r) => r?.key.keyId ?? null, async () => {
        const registered = await registerLimitedKey(sdk, {
          network: this.network,
          identityId,
          masterWif: signWith,
          group: this.group(),
          ...(previous ? { replaceKeyId: previous.keyId } : {}),
          ...(held.length ? { disableHeld: held } : {}),
          trust: this.groupTrust(),
          ...(request ? { request } : {}),
          persist: (k) => stageInVault(this.network, { identityId, keyId: k.keyId, wif: k.wif }, protection),
        })
        this.step(protection.passkey ? 'Saving the key with your passkey' : 'Saving the key in this browser')
        return { key: registered, committed: await this.commitKey({ identityId, keyId: registered.keyId, wif: registered.wif }, protection) }
      })
      const session = await this.adopt(identityId, key, protection, committed)
      if (material !== null) {
        this.step('Enabling private repos')
        await this.enableEncryption(identityId, material)
      }
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
      const sdk = await timed(PRIVATE_REPOS_FLOW, 'connect', () => this.getSdk())
      const keyId = await importEncryptionKey(sdk, this.network, identityId, core, material)
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

  /**
   * Run a paid identity update made elsewhere (Settings → Keys registering an encryption key)
   * through the ledger: as this identity's only writer, with its cost measured and recorded.
   * `update` resolves with whether it sent anything.
   */
  chargedUpdate(identityId: string, kind: KeySpendKind, update: () => Promise<boolean>): Promise<boolean> {
    return this.charged(identityId, kind, () => null, update)
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
  async adoptWalletKeys(
    identityId: string,
    keys: readonly WalletKey[],
    protection: Protection,
    options: {
      /** Give up this device's unfinished renewal (the user chose the wallet). */
      readonly discardPendingRenewal?: boolean
      /** The renewal's own passphrase or passkey, when the protection chosen here is not it. */
      readonly renewalUnlock?: { passphrase: string } | 'passkey'
      /** Give it up even though it cannot be opened (its key then stays live until it expires). */
      readonly dropUnopened?: boolean
    } = {},
  ): Promise<AuthSession> {
    return this.run(async () => {
      const [main, ...rest] = keys
      if (!main) throw new Error('the wallet granted no key')
      const forge = NETWORKS[this.network].v2
      if (!forge) throw new Error(`Dash Forge is not deployed on ${NETWORKS[this.network].key}`)
      const previous = (await listVaults(this.network)).find((v) => v.identityId === identityId && v.staged !== true)
      if (previous) await this.assertUnlockedIfWalletKeys(await this.getSdk(), identityId, previous.keyId)
      // An unfinished renewal here (D-016): the user chooses to finish it (unlock) or to carry
      // on with the wallet, which gives it up. Never a silent overwrite, never a dead end. Its
      // key may already be registered: it is kept beside the wallet's keys (never to sign), so
      // the next renewal or revoke disables it, and its staged record goes only in the write
      // that stores it. As this identity's one writer: no other tab's stage is dropped instead.
      return serialized(identityId, async () => {
        try {
          return await this.storeWalletKeys(identityId, main, rest, forge, protection, options)
        } finally {
          forgetPasskeyOutputs()
        }
      })
    })
  }

  private async storeWalletKeys(
    identityId: string,
    main: WalletKey,
    rest: readonly WalletKey[],
    forge: ForgeIds,
    protection: Protection,
    options: Parameters<AuthController['adoptWalletKeys']>[3] = {},
  ): Promise<AuthSession> {
    const pending = await stagedInfo(this.network, identityId)
    let given: ExtraKey | null = null
    if (pending !== null) {
      if (options.discardPendingRenewal !== true) throw new PendingRenewalChoiceError(pending.keyId)
      const staged =
        (await openStaged(this.network, identityId, protection).catch(() => null)) ??
        (options.renewalUnlock !== undefined ? await openStaged(this.network, identityId, options.renewalUnlock, true).catch(() => null) : null)
      if (staged === null && options.dropUnopened !== true) throw new PendingRenewalLockedError(pending.keyId, pending.methods, options.renewalUnlock !== undefined)
      if (staged !== null) given = { contractId: forge.core, keyId: staged.keyId, wif: staged.wif, holdOnly: true }
    }
    // Nothing this browser holds for the identity is dropped: the keys it held before stay
    // beside the new ones (a returning login keeps its forge-collab grant; a key the new
    // grant supersedes is still held, so a later revoke can disable it). Stale ones fall
    // out at the next unlock.
    const fresh = new Set([main.keyId, ...rest.map((k) => k.keyId)])
    const held: ExtraKey[] = this.heldKeys(identityId).map((h) => ('contractId' in h ? h : { contractId: forge.core, keyId: h.keyId, wif: h.wif }))
    const kept = [...held, ...(given ? [given] : [])].filter((h, i, all) => !fresh.has(h.keyId) && all.findIndex((x) => x.keyId === h.keyId) === i)
    const extra = [...rest.map((k) => toExtraKey(k, forge)), ...kept]
    const secret: VaultSecret = { identityId, keyId: main.keyId, wif: main.wif, ...(extra.length ? { extra } : {}) }
    this.noteDropped(
      await storeInVault(this.network, secret, protection, pending !== null ? { dropStagedKeyId: pending.keyId } : {}),
      'Your storage settings could not be carried over to the new key. Add your storage again in Settings → Storage.',
    )
    try {
      return await this.open(secret, 'vault', main.limits ?? undefined)
    } catch (e) {
      throw new Error(`Key saved on this device, but signing in did not finish (${errorMessage(e)}). Unlock to continue.`)
    }
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
          ? await unlockWithPasskey(this.network, identityId, (why) => this.step(why))
          : method !== null
            ? await unlockWithPassphrase(this.network, identityId, method.passphrase)
            : null)
      if (!secret) throw new VaultLockedError('unlock to continue')
      if (method !== null) {
        const { secret: finished } = await this.finishStagedRenewal(identityId, method)
        if (finished) return this.open(finished, 'vault')
      }
      return this.open(secret, 'vault', limits)
    })
  }

  /** Unlock a stored vault and open its session. */
  async unlock(identityId: string, method: { passphrase: string } | 'passkey'): Promise<AuthSession> {
    return this.run(async () => {
      // Connect first: a connect that times out then fails before the passphrase (Argon2id)
      // or passkey prompt, so "Try again" does not ask for them twice.
      this.step('Connecting to Dash Platform')
      await this.getSdk()
      this.step(method === 'passkey' ? 'Unlocking with your passkey' : 'Unlocking')
      // Opens the main record, or the staged one when the method is the renewal's (D-016).
      const secret =
        method === 'passkey'
          ? await unlockWithPasskey(this.network, identityId, (why) => this.step(why))
          : await unlockWithPassphrase(this.network, identityId, method.passphrase)
      const { secret: finished, status } = await this.finishStagedRenewal(identityId, method)
      if (finished) return this.open(finished, 'vault')
      const main = (await listVaults(this.network)).find((v) => v.identityId === identityId && v.staged !== true)
      if (main === undefined || secret.keyId !== main.keyId) {
        // What opened is the staged key, not adopted: no session to open with it. Say why.
        lockVault()
        throw new VaultLockedError(stagedUnlockMessage(status, main !== undefined))
      }
      return this.open(secret, 'vault')
    })
  }

  /**
   * A renewal or first import this device did not live to finish (the tab closed, or storing
   * failed, after the key was staged and registered; D-016) is finished here: when Platform has
   * the staged key live it becomes this browser's key. Called on every unlock and on a
   * restored session. Returns the adopted secret, or null (nothing staged, or not visible yet).
   * Throws when `method` does not open the staged record: the user chose another passphrase or
   * passkey for that renewal, and is told to use it (never a silent fallback to the old key).
   */
  async finishStagedRenewal(
    identityId: string,
    method: { passphrase: string } | 'passkey',
  ): Promise<{ readonly secret: VaultSecret | null; readonly status: RecoverResult['status'] | 'none' }> {
    if (!(await hasStaged(this.network, identityId).catch(() => false))) return { secret: null, status: 'none' }
    const r = await recoverStaged(this.network, identityId, method, (s) => this.stagedKeyState(s))
    switch (r.status) {
      case 'adopted':
        this.noteDropped(
          r.outcome,
          'Your storage settings were sealed with the key a renewal replaced, so they could not be carried over. Add your storage again in Settings → Storage.',
        )
        return { secret: r.secret, status: r.status }
      case 'locked':
        // Opened the current key; the renewal was protected differently. Keep working with the
        // current key and say how to finish the renewal (never a dead end).
        this.setState({
          notice:
            "This device has an unfinished key renewal, protected with another passphrase or passkey than this one. Lock and unlock with that one to finish it, or discard it in Settings → Keys.",
        })
        break
      case 'conflict':
        this.setState({
          notice:
            'This device has an unfinished key renewal from before your latest sign-in. It was kept; finish or discard it in Settings → Keys.',
        })
        break
    }
    return { secret: null, status: r.status }
  }

  /**
   * Give up this device's unfinished renewal. `unlockWith` (the renewal's own passphrase or
   * passkey) opens its key first, and it is kept beside the signed-in key, never to sign, so the
   * next renewal or revoke disables it; the staged record goes only once that is stored.
   * Without it (the user no longer has that passphrase), a key that was registered stays valid
   * on chain, unused, until it expires.
   */
  async abandonPendingRenewal(identityId: string, unlockWith?: { passphrase: string } | 'passkey'): Promise<void> {
    await serialized(identityId, async () => {
      const pending = await stagedInfo(this.network, identityId)
      if (pending === null) return
      if (unlockWith !== undefined) {
        if (this.unlockedVaultSecret(identityId) === null) throw new VaultLockedError('unlock this browser\'s key first')
        const forge = NETWORKS[this.network].v2
        const staged = await openStaged(this.network, identityId, unlockWith, true).finally(forgetPasskeyOutputs)
        if (staged === null || !forge) throw new PendingRenewalLockedError(pending.keyId, pending.methods, true)
        await addExtraKey(this.network, identityId, { contractId: forge.core, keyId: staged.keyId, wif: staged.wif, holdOnly: true })
        const session = this.state.session
        const identity = await authSdk(await this.getSdk()).identities.fetch(identityId).catch(() => undefined)
        const live = identity?.publicKeys.some((k) => k.keyId === staged.keyId && k.disabledAt === undefined) ?? false
        if (session?.identityId === identityId && live) {
          this.setState({ session: { ...session, heldOnly: [...new Set([...(session.heldOnly ?? []), staged.keyId])] } })
        }
      }
      await abandonStaged(this.network, identityId, pending.keyId)
    })
  }

  /**
   * The key this device stores for `identityId`, opened with the protection just chosen (a
   * create sheet reopened after its identity landed, L-06): the run checks it on chain and keeps
   * it instead of paying for a renewal. Null when none is stored or the protection does not
   * open it. The key stays unlocked for the {@link openStored} that follows; a failed run locks.
   */
  async storedKeyFor(identityId: string, protection: Protection): Promise<HeldBrowserKey | null> {
    const secret = await unlockWithProtection(this.network, identityId, protection).catch(() => null)
    if (secret === null) return null
    // Every other key held here (wallet grants, a renewal given up): a renewal from the sheet
    // disables them in the same update, as any renewal does, so none is left live unheld.
    const alsoHeld = (secret.extra ?? []).map((e) => ({ keyId: e.keyId, wif: e.wif }))
    return { keyId: secret.keyId, wif: secret.wif, ...(alsoHeld.length ? { alsoHeld } : {}) }
  }

  /** This device's unfinished renewal for `identityId`, if any (Settings → Keys shows it). */
  pendingRenewal(identityId: string): ReturnType<typeof stagedInfo> {
    return stagedInfo(this.network, identityId)
  }

  /**
   * What Platform says about a staged key: live, provably never registered, or not known.
   * "Never" needs proof: its key id is held on the identity by a different public key (another
   * update took the id, so this key can never be added under it). Anything else, including
   * "not there yet", is unknown: a node a block behind, or an update still in flight, must not
   * make this device delete a key it paid to register. Read a few times, as after a write.
   */
  private async stagedKeyState(secret: VaultSecret): Promise<StagedKeyState> {
    const sdk = await this.getSdk()
    // The key under the staged id, read a few times (a node a block behind shows none yet).
    const atId = await retryWhileMissing(async () => {
      const identity = await authSdk(sdk).identities.fetch(secret.identityId)
      return identity?.publicKeys.find((k) => k.keyId === secret.keyId) ?? null
    }, 4).catch(() => null)
    if (atId === null) return 'unknown'
    // This key under its id: the renewal landed. Live, or since expired or disabled, it was
    // registered and replaced the old key either way; adopting it lets a later renewal replace
    // it the normal way.
    return controlsKey(atId, secret.wif, this.network) ? 'registered' : 'never'
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
      const masterWif = await this.masterWifFor(identityId, input)
      const held = this.heldKeys(identityId)
      await this.charged(identityId, 'key:revoke', () => stored.keyId, () =>
        held.length > 1 || (held.length === 1 && this.state.session?.unlimited)
          ? // Wallet keys (and any Forge key beside them): disable every key this browser holds.
            disableHeldKeys(sdk, { network: this.network, identityId, masterWif, keys: held })
          : revokeLimitedKey(sdk, { network: this.network, identityId, masterWif, keyId: stored.keyId }),
      )
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
      const masterWif = await this.masterWifFor(identityId, input)
      const sdk = await this.getSdk()
      const limits = await this.charged(identityId, 'key:topup', () => keyId, () =>
        topUpLimitedKey(sdk, { network: this.network, identityId, masterWif, keyId, request }),
      )
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

/**
 * Why a passphrase or passkey that opened only the staged renewal (D-016) opens no session,
 * from what finishing it found. `hasMain`: an earlier key is stored and still opens.
 */
function stagedUnlockMessage(status: RecoverResult['status'] | 'none', hasMain: boolean): string {
  const earlier = hasMain
    ? 'Unlock with your earlier passphrase or passkey to keep using the current key.'
    : 'Sign in again with your identity file or recovery phrase.'
  switch (status) {
    case 'discarded':
      return `That passphrase or passkey was for a key renewal that never reached Platform, so it was discarded. ${earlier}`
    case 'conflict':
      return 'That passphrase or passkey is for an unfinished key renewal from before your latest sign-in. It was kept: unlock with your current passphrase or passkey, then finish or discard it in Settings → Keys.'
    default:
      return hasMain
        ? `That passphrase or passkey is the one for this device's unfinished key renewal, which Platform does not show yet. Try again in a minute, or: ${earlier}`
        : "This device's new key is not on Platform yet (its registration may still be arriving). Try unlocking again in a minute; if it never appears, sign in again with your identity file or recovery phrase."
  }
}

/**
 * A wallet sign-in found an unfinished key renewal on this device: the UI offers to finish it
 * (unlock with its passphrase or passkey) or to continue with the wallet and give it up.
 */
export class PendingRenewalChoiceError extends Error {
  constructor(readonly keyId: number) {
    super(
      `This device has an unfinished key renewal (key ${keyId}). Finish it by unlocking with the passphrase or passkey you chose for it, or continue with your wallet: this browser then keeps the renewal's key only so that your next key renewal or "Revoke on chain" (Settings → Keys) disables it. It never signs.`,
    )
    this.name = 'PendingRenewalChoiceError'
  }
}

/**
 * Continuing with the wallet needs the unfinished renewal's key opened, to keep it for the next
 * revoke or renewal to disable: the protection chosen for the wallet is not the renewal's.
 */
export class PendingRenewalLockedError extends Error {
  constructor(
    readonly keyId: number,
    readonly methods: readonly ('passkey' | 'passphrase')[],
    readonly retried: boolean,
  ) {
    super(
      `${retried ? "That did not open the renewal's key. " : ''}To keep the renewal's key (key ${keyId}) so your next renewal or revoke disables it, enter the passphrase or use the passkey you chose for that renewal. Without it, the key stays valid on Platform, unused, until it expires.`,
    )
    this.name = 'PendingRenewalLockedError'
  }
}

/** Signing in from the words found an identity this browser already holds a key for. */
export class AlreadyStoredError extends Error {
  constructor(readonly identityId: string) {
    super(`This browser already holds a key for ${identityId}. Unlock it instead, or renew it from Settings.`)
    this.name = 'AlreadyStoredError'
  }
}

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
