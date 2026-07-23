/**
 * AuthController — the headless identity session for forge-web.
 *
 * Login imports a bridge-format identity file OR a pasted WIF + identity id, stores the signing
 * key in the network-scoped keystore (never in this object's observable state), verifies the key
 * against the on-chain identity, and exposes an observable `{ identity, balance }` snapshot plus a
 * {@link WriteAuth} the WriteEngine consumes. Password-vault / passkey wrapping of the stored key
 * is the documented follow-up; M3 is direct key login.
 *
 * The controller never places a private key in its state or in any log line: the WIF lives only
 * in the keystore, and `getSigningKeyWif()` reads it on demand at signing time.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { Network } from '../constants'
import { DEFAULT_NETWORK } from '../constants'
import { WriteAuthError, findSigningKey, readIdentityBalance, type WriteAuth } from '../sdk/write'
import { normalizeToWif } from './wif'
import { parseIdentityFileText, type ParsedIdentityFile } from './identity-file'
import {
  clearPrivateKey,
  getPrivateKey,
  hasPrivateKey,
  storePrivateKey,
  storedIdentityIds,
} from './keystore'

/** The public (key-free) session snapshot. */
export interface AuthSession {
  readonly identityId: string
  /** Credit balance (bigint-safe as a decimal string; parsed by the UI). */
  readonly balance: string
  readonly network: Network
}

/** Observable controller state. Never carries private-key material. */
export interface AuthState {
  readonly session: AuthSession | null
  readonly isLoading: boolean
  readonly error: string | null
}

interface IdentitiesFetchFacade {
  fetch(identityId: string): Promise<
    | {
        readonly publicKeys: {
          keyId: number
          purposeNumber: number
          securityLevelNumber: number
          validatePrivateKey(bytes: Uint8Array, network: string): boolean
        }[]
        readonly balance: bigint
        getPublicKeyById(keyId: number): unknown
      }
    | undefined
  >
}

type Listener = (state: AuthState) => void

/** How the SDK is obtained — injected so the controller stays testable and SSR-safe. */
export type SdkProvider = () => Promise<EvoSDK>

export class AuthController {
  private state: AuthState = { session: null, isLoading: false, error: null }
  private readonly listeners = new Set<Listener>()

  constructor(
    private readonly getSdk: SdkProvider,
    private readonly network: Network = DEFAULT_NETWORK,
  ) {}

  /** Current state snapshot. */
  getState(): AuthState {
    return this.state
  }

  /** Subscribe to state changes; returns an unsubscribe fn. */
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

  /**
   * A {@link WriteAuth} bound to the current session. The WriteEngine calls
   * `getSigningKeyWif()` at signing time, which reads the keystore — throwing a
   * {@link WriteAuthError} (never returning null) if the key is absent.
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
        const wif = getPrivateKey(network, identityId)
        if (!wif) {
          throw new WriteAuthError(
            `no stored signing key for ${identityId} on ${network} — please log in again`,
          )
        }
        return wif
      },
    }
  }

  /** Whether a signing key is stored for the given identity on this network. */
  hasStoredKey(identityId: string): boolean {
    return hasPrivateKey(this.network, identityId)
  }

  /** Identity ids with a stored key on this network (for a "resume session" chooser). */
  storedIdentities(): string[] {
    return storedIdentityIds(this.network)
  }

  /**
   * Log in with an identity id + a private key (WIF or hex). The key is normalized to a
   * network WIF, verified against the on-chain identity's AUTHENTICATION keys, stored, and the
   * balance loaded. Rejects a key that does not control any usable key on the identity.
   */
  async login(identityId: string, privateKey: string): Promise<AuthSession> {
    this.setState({ isLoading: true, error: null })
    try {
      const wif = normalizeToWif(privateKey, this.network)
      const sdk = await this.getSdk()
      const identity = await (sdk as unknown as { identities: IdentitiesFetchFacade }).identities.fetch(
        identityId,
      )
      if (!identity) {
        throw new WriteAuthError(`identity ${identityId} not found on ${this.network}`)
      }
      // Require the WIF to control at least one usable (CRITICAL/HIGH) AUTHENTICATION key.
      const match = findSigningKey(identity, wif, this.network, 3)
      if (!match) {
        throw new WriteAuthError(
          'the provided key does not match any usable AUTHENTICATION key on this identity',
        )
      }
      storePrivateKey(this.network, identityId, wif)
      const balance = await readIdentityBalance(sdk, identityId)
      const session: AuthSession = {
        identityId,
        balance: balance.toString(),
        network: this.network,
      }
      this.setState({ session, isLoading: false, error: null })
      return session
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.setState({ isLoading: false, error: message })
      throw e
    }
  }

  /** Log in from bridge-format identity-file text (JSON). Extracts id + signing key, then logs in. */
  async loginWithIdentityFile(text: string): Promise<AuthSession> {
    let parsed: ParsedIdentityFile
    try {
      parsed = parseIdentityFileText(text)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.setState({ error: message })
      throw e
    }
    if (parsed.network !== null && parsed.network !== this.network) {
      const message = `identity file is for ${parsed.network}, but this app is on ${this.network}`
      this.setState({ error: message })
      throw new Error(message)
    }
    return this.login(parsed.identityId, parsed.signingKeyWif)
  }

  /** Refresh the current session's credit balance. */
  async refreshBalance(): Promise<void> {
    const session = this.state.session
    if (!session) return
    const sdk = await this.getSdk()
    const balance = await readIdentityBalance(sdk, session.identityId)
    this.setState({ session: { ...session, balance: balance.toString() } })
  }

  /** Log out: forget the session and wipe the stored signing key for this identity. */
  logout(): void {
    const session = this.state.session
    if (session) clearPrivateKey(this.network, session.identityId)
    this.setState({ session: null, error: null })
  }
}
