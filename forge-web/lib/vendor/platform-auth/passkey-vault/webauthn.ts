// WebAuthn with the PRF extension, behind a small adapter so the vault runs against a fake in tests. The passkey never signs anything
// for the vault: only its PRF output is used, to derive the HPKE recipient key. So challenges are random and nothing goes to a server.
// browserPasskeyAdapter is govhub vault/webauthn.ts plus Forge's backstop: a ceremony that outlives its timeout is aborted, so the
// prompt closes and the next attempt is not refused as "a request is already pending".
import { randomBytes } from './bytes'
import { PasskeyError } from './errors'

export interface CreatedPasskey {
  credentialId: Uint8Array
  /** The PRF output at creation, when the authenticator gives one then (many give it only on get). */
  prfOutput: Uint8Array | null
  /** Whether the authenticator said it supports PRF. */
  prfEnabled: boolean
}

export interface PasskeyAssertion {
  credentialId: Uint8Array
  /** The user handle; null when the authenticator returned none. */
  userHandle: Uint8Array | null
  /** 32 bytes. An assertion without PRF output throws PasskeyError 'no-prf' instead. */
  prfOutput: Uint8Array
}

export interface CreatePasskeyOptions {
  rpId: string
  rpName: string
  userHandle: Uint8Array
  userName: string
  /** Defaults to `userName`. */
  displayName?: string
  prfInput: Uint8Array
  /** Credentials the authenticator must not already hold (the owner's existing passkeys). */
  exclude: readonly Uint8Array[]
  signal?: AbortSignal
}

export interface GetPasskeyOptions {
  rpId: string
  prfInput: Uint8Array
  /** Restricts the ceremony to these credentials; empty for a discoverable sign-in. */
  allow: readonly Uint8Array[]
  signal?: AbortSignal
}

export interface PasskeyAdapter {
  create(o: CreatePasskeyOptions): Promise<CreatedPasskey>
  get(o: GetPasskeyOptions): Promise<PasskeyAssertion>
  /** Tells the provider a credential is useless (never stored, or removed), where the browser supports it. Best effort. */
  signalUnknown?(rpId: string, credentialId: Uint8Array): Promise<void>
}

export type CeremonyKind = 'create' | 'get'

export interface BrowserPasskeyOptions {
  /** WebAuthn `timeout`; the backstop aborts 5 s after it. Default 120 s. */
  timeoutMs?: number
  /** Maps a ceremony failure to what the app throws. Default: {@link defaultPasskeyError}. */
  mapError?: (error: unknown, kind: CeremonyKind) => unknown
}

export const DEFAULT_PASSKEY_TIMEOUT_MS = 120_000
const BACKSTOP_MS = 5_000

/** The default mapping from a WebAuthn rejection to a PasskeyError. A PasskeyError passes through. */
export function defaultPasskeyError(error: unknown): PasskeyError {
  if (error instanceof PasskeyError) return error
  const name = (error as { name?: unknown } | null)?.name
  if (name === 'NotAllowedError' || name === 'AbortError') return new PasskeyError('The passkey prompt was closed or timed out.', 'cancelled')
  if (name === 'NotSupportedError' || name === 'SecurityError') return new PasskeyError('Passkeys are not available here.', 'unsupported')
  if (name === 'InvalidStateError') return new PasskeyError('This device already holds a passkey for this account.', 'exists')
  return new PasskeyError('The passkey request failed.', 'failed')
}

/** What the browser says about PRF before trying. 'unknown' when it does not say (the actual output decides). */
export async function prfSupport(): Promise<'yes' | 'no' | 'unknown'> {
  const PKC = (globalThis as { PublicKeyCredential?: { getClientCapabilities?: () => Promise<Record<string, boolean | undefined>> } }).PublicKeyCredential
  if (!PKC || !globalThis.navigator?.credentials) return 'no'
  try {
    const caps = await PKC.getClientCapabilities?.()
    if (caps && 'extension:prf' in caps) return caps['extension:prf'] ? 'yes' : 'no'
  } catch {
    /* older browsers */
  }
  return 'unknown'
}

const buf = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer
function bytesOf(b: ArrayBuffer | ArrayBufferView | undefined | null): Uint8Array | null {
  if (!b) return null
  if (b instanceof ArrayBuffer) return new Uint8Array(b.slice(0))
  return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}

const prfExtension = (prfInput: Uint8Array): AuthenticationExtensionsClientInputs =>
  ({ prf: { eval: { first: buf(prfInput) } } }) as AuthenticationExtensionsClientInputs

const base64url = (bytes: Uint8Array): string => {
  let s = ''
  for (const x of bytes) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer | ArrayBufferView } } }

interface CredentialLike {
  rawId: ArrayBuffer
  response: { userHandle?: ArrayBuffer | null }
  getClientExtensionResults(): PrfResults
}

/**
 * Runs one ceremony with an abort backstop: past `timeoutMs + 5 s`, or when the caller's signal aborts, the ceremony's own signal
 * aborts so the browser closes the prompt. Every failure goes through `mapError`.
 */
async function ceremony<T>(
  start: (signal: AbortSignal) => Promise<T>,
  o: { timeoutMs: number; kind: CeremonyKind; signal: AbortSignal | undefined; mapError: (e: unknown, kind: CeremonyKind) => unknown },
): Promise<T> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (o.signal?.aborted) controller.abort()
  o.signal?.addEventListener('abort', onAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const backstop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PasskeyError('The passkey prompt timed out.', 'timeout')), o.timeoutMs + BACKSTOP_MS)
  })
  try {
    return await Promise.race([start(controller.signal), backstop])
  } catch (error) {
    controller.abort()
    throw o.mapError(error, o.kind)
  } finally {
    clearTimeout(timer)
    o.signal?.removeEventListener('abort', onAbort)
  }
}

export function browserPasskeyAdapter(options: BrowserPasskeyOptions = {}): PasskeyAdapter {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PASSKEY_TIMEOUT_MS
  const mapError = options.mapError ?? defaultPasskeyError
  const credentials = (kind: CeremonyKind) => {
    const c = globalThis.navigator?.credentials
    if (!c) throw mapError(new PasskeyError('Passkeys are not available in this browser.', 'unsupported'), kind)
    return c
  }

  return {
    async create(o) {
      const c = credentials('create')
      const cred = (await ceremony(
        (signal) =>
          c.create({
            signal,
            publicKey: {
              timeout: timeoutMs,
              challenge: buf(randomBytes(32)),
              rp: { id: o.rpId, name: o.rpName },
              user: { id: buf(o.userHandle), name: o.userName, displayName: o.displayName ?? o.userName },
              pubKeyCredParams: [
                { type: 'public-key', alg: -7 },
                { type: 'public-key', alg: -257 },
              ],
              authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
              excludeCredentials: o.exclude.map((id) => ({ type: 'public-key' as const, id: buf(id) })),
              extensions: prfExtension(o.prfInput),
            },
          }),
        { timeoutMs, kind: 'create', signal: o.signal, mapError },
      )) as CredentialLike | null
      if (!cred) throw mapError(new PasskeyError('No passkey was created.', 'cancelled'), 'create')
      const ext = cred.getClientExtensionResults()
      const prfOutput = bytesOf(ext.prf?.results?.first)
      return {
        credentialId: new Uint8Array(cred.rawId.slice(0)),
        prfOutput: prfOutput && prfOutput.length === 32 ? prfOutput : null,
        prfEnabled: ext.prf?.enabled === true || prfOutput !== null,
      }
    },

    async get(o) {
      const c = credentials('get')
      const cred = (await ceremony(
        (signal) =>
          c.get({
            signal,
            publicKey: {
              timeout: timeoutMs,
              challenge: buf(randomBytes(32)),
              rpId: o.rpId,
              userVerification: 'required',
              allowCredentials: o.allow.map((id) => ({ type: 'public-key' as const, id: buf(id) })),
              extensions: prfExtension(o.prfInput),
            },
          }),
        { timeoutMs, kind: 'get', signal: o.signal, mapError },
      )) as CredentialLike | null
      if (!cred) throw mapError(new PasskeyError('No passkey was chosen.', 'cancelled'), 'get')
      const credentialId = new Uint8Array(cred.rawId.slice(0))
      const prf = bytesOf(cred.getClientExtensionResults().prf?.results?.first)
      if (!prf || prf.length !== 32) {
        prf?.fill(0)
        throw mapError(new PasskeyError("This passkey's provider doesn't support the PRF extension.", 'no-prf', credentialId), 'get')
      }
      return { credentialId, userHandle: bytesOf(cred.response.userHandle), prfOutput: prf }
    },

    async signalUnknown(rpId, credentialId) {
      const PKC = (globalThis as { PublicKeyCredential?: { signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void> } })
        .PublicKeyCredential
      if (!PKC?.signalUnknownCredential) return
      try {
        await PKC.signalUnknownCredential({ rpId, credentialId: base64url(credentialId) })
      } catch {
        /* best effort */
      }
    },
  }
}
