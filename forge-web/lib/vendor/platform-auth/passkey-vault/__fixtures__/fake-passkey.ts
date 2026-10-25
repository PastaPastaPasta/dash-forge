// A software authenticator for tests: PRF = HMAC-SHA256(credential secret, input). Discoverable credentials, exclude lists,
// allow lists, PRF at create or only at get, no PRF at all, and scripted failures.
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesEqual, randomBytes } from '../bytes'
import { PasskeyError } from '../errors'
import type { CreatePasskeyOptions, GetPasskeyOptions, PasskeyAdapter } from '../webauthn'

export interface FakeCredential {
  rpId: string
  credentialId: Uint8Array
  userHandle: Uint8Array
  userName: string
  secret: Uint8Array
}

export interface FakePasskeyOptions {
  /** The authenticator evaluates PRF at all (default true). */
  prf?: boolean
  /** It also returns the PRF output at creation (default false: many only give it on get). */
  prfAtCreate?: boolean
  /** Credential id length (default 32). */
  credentialIdLength?: number
  /**
   * Each create is on another authenticator (a phone, a laptop, a security key), all reachable from this browser: no exclude-list
   * refusal and no replacement by user handle. Default false (one authenticator).
   */
  multiDevice?: boolean
}

export interface FakePasskeyAdapter extends PasskeyAdapter {
  readonly credentials: FakeCredential[]
  /** Credentials the adapter was told are unknown. */
  readonly signalled: Uint8Array[]
  readonly calls: { create: CreatePasskeyOptions[]; get: GetPasskeyOptions[] }
  /** The credential a discoverable get picks next (default: the last created for the RP). */
  choose(credentialId: Uint8Array | null): void
  /** The next create or get rejects with this. */
  failNext(error: unknown): void
  /** The next get returns this user handle instead of the credential's. */
  overrideNextHandle(handle: Uint8Array | null): void
  /** The PRF output this credential gives for `input` (what the authenticator would). */
  prfOf(credentialId: Uint8Array, input: Uint8Array): Uint8Array
  options: FakePasskeyOptions
}

export function fakePasskeyAdapter(options: FakePasskeyOptions = {}): FakePasskeyAdapter {
  const credentials: FakeCredential[] = []
  const signalled: Uint8Array[] = []
  const calls = { create: [] as CreatePasskeyOptions[], get: [] as GetPasskeyOptions[] }
  let chosen: Uint8Array | null = null
  let failure: { error: unknown } | null = null
  let handleOverride: { handle: Uint8Array | null } | null = null

  const takeFailure = () => {
    if (!failure) return
    const { error } = failure
    failure = null
    throw error
  }
  const find = (id: Uint8Array) => credentials.find((c) => bytesEqual(c.credentialId, id))
  const prf = (c: FakeCredential, input: Uint8Array) => hmac(sha256, c.secret, input)

  const adapter: FakePasskeyAdapter = {
    credentials,
    signalled,
    calls,
    options,
    choose(id) {
      chosen = id
    },
    failNext(error) {
      failure = { error }
    },
    overrideNextHandle(handle) {
      handleOverride = { handle }
    },
    prfOf(id, input) {
      const c = find(id)
      if (!c) throw new Error('no such credential')
      return prf(c, input)
    },

    async create(o) {
      calls.create.push(o)
      takeFailure()
      if (!options.multiDevice && credentials.some((c) => c.rpId === o.rpId && o.exclude.some((id) => bytesEqual(id, c.credentialId)))) {
        throw new PasskeyError('This authenticator already holds a passkey for this account.', 'exists')
      }
      // providers replace a discoverable credential with the same RP and user handle
      for (let i = credentials.length - 1; i >= 0 && !options.multiDevice; i -= 1) {
        const c = credentials[i]
        if (c && c.rpId === o.rpId && bytesEqual(c.userHandle, o.userHandle)) credentials.splice(i, 1)
      }
      const c: FakeCredential = {
        rpId: o.rpId,
        credentialId: randomBytes(options.credentialIdLength ?? 32),
        userHandle: o.userHandle.slice(),
        userName: o.userName,
        secret: randomBytes(32),
      }
      credentials.push(c)
      const supports = options.prf ?? true
      return {
        credentialId: c.credentialId.slice(),
        prfOutput: supports && options.prfAtCreate ? prf(c, o.prfInput) : null,
        prfEnabled: supports,
      }
    },

    async get(o) {
      calls.get.push(o)
      takeFailure()
      const candidates = credentials.filter((c) => c.rpId === o.rpId && (o.allow.length === 0 || o.allow.some((id) => bytesEqual(id, c.credentialId))))
      const c = (chosen && candidates.find((x) => bytesEqual(x.credentialId, chosen as Uint8Array))) || candidates[candidates.length - 1]
      chosen = null
      if (!c) throw new PasskeyError('The passkey prompt was closed or timed out.', 'cancelled')
      if (!(options.prf ?? true)) throw new PasskeyError("This passkey's provider doesn't support the PRF extension.", 'no-prf', c.credentialId.slice())
      const userHandle = handleOverride ? handleOverride.handle : c.userHandle.slice()
      handleOverride = null
      return { credentialId: c.credentialId.slice(), userHandle, prfOutput: prf(c, o.prfInput) }
    },

    async signalUnknown(rpId, credentialId) {
      signalled.push(credentialId.slice())
      const i = credentials.findIndex((c) => c.rpId === rpId && bytesEqual(c.credentialId, credentialId))
      if (i >= 0) credentials.splice(i, 1)
    },
  }
  return adapter
}
