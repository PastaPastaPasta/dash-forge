import { afterEach, describe, expect, it, vi } from 'vitest'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { PasskeyError } from './errors'
import { parseUserHandle, userHandleFor } from './user-handle'
import { browserPasskeyAdapter, defaultPasskeyError, prfSupport } from './webauthn'
import { fakePasskeyAdapter } from './__fixtures__/fake-passkey'

const H = (label: string) => sha256(new TextEncoder().encode(label))
const identity = H('identity')
const contract = H('contract')
const ab = (b: Uint8Array) => b.slice().buffer as ArrayBuffer
const bytes = (b: BufferSource | undefined) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : null)

function credential(o: { rawId: Uint8Array; prf?: Uint8Array | null; enabled?: boolean; userHandle?: Uint8Array | null }) {
  return {
    rawId: ab(o.rawId),
    response: { userHandle: o.userHandle ? ab(o.userHandle) : null },
    getClientExtensionResults: () => ({ prf: { enabled: o.enabled, results: o.prf ? { first: ab(o.prf) } : undefined } }),
  }
}

function stubCredentials(impl: { create?: (o: CredentialCreationOptions) => Promise<unknown>; get?: (o: CredentialRequestOptions) => Promise<unknown> }) {
  const create = vi.fn(impl.create ?? (async () => null))
  const get = vi.fn(impl.get ?? (async () => null))
  vi.stubGlobal('navigator', { credentials: { create, get } })
  return { create, get }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const createOptions = { rpId: 'forge.dashhq.org', rpName: 'Dash Forge', userHandle: userHandleFor(identity, contract), userName: 'alice', prfInput: H('prf input'), exclude: [H('old').slice(0, 16)] }

describe('user handle', () => {
  it('is identity ‖ contract, 64 bytes, and parses back to the identity', () => {
    const handle = userHandleFor(identity, contract)
    expect(handle.length).toBe(64)
    expect(bytesToHex(handle)).toBe(bytesToHex(identity) + bytesToHex(contract))
    expect(bytesToHex(parseUserHandle(handle, contract))).toBe(bytesToHex(identity))
  })

  it("refuses a missing or short handle as 'not-vault' and another contract's as 'other-vault'", () => {
    const codeOf = (h: Uint8Array | null) => {
      try {
        parseUserHandle(h, contract)
      } catch (e) {
        return e instanceof PasskeyError ? e.code : 'other'
      }
      return 'ok'
    }
    expect(codeOf(null)).toBe('not-vault')
    expect(codeOf(H('a local-only passkey: random 32-byte user.id'))).toBe('not-vault')
    expect(codeOf(new Uint8Array(65))).toBe('not-vault')
    expect(codeOf(userHandleFor(identity, H('testnet contract')))).toBe('other-vault')
    expect(() => userHandleFor(identity.slice(0, 31), contract)).toThrow(/32 bytes/)
  })
})

describe('browserPasskeyAdapter', () => {
  it('creates a discoverable, user-verified passkey with the PRF evaluated and the exclude list', async () => {
    const rawId = H('cred').slice(0, 20)
    const { create } = stubCredentials({ create: async () => credential({ rawId, enabled: true }) })
    const made = await browserPasskeyAdapter({ timeoutMs: 1000 }).create(createOptions)
    expect(bytesToHex(made.credentialId)).toBe(bytesToHex(rawId))
    expect(made.prfOutput).toBeNull()
    expect(made.prfEnabled).toBe(true)
    const pk = create.mock.calls[0]![0].publicKey!
    expect(pk.rp).toEqual({ id: 'forge.dashhq.org', name: 'Dash Forge' })
    expect(bytesToHex(bytes(pk.user.id)!)).toBe(bytesToHex(createOptions.userHandle))
    expect(pk.user.displayName).toBe('alice')
    expect(pk.timeout).toBe(1000)
    expect(pk.authenticatorSelection).toEqual({ residentKey: 'required', requireResidentKey: true, userVerification: 'required' })
    expect(pk.excludeCredentials!.map((c) => bytesToHex(bytes(c.id)!))).toEqual([bytesToHex(createOptions.exclude[0]!)])
    const ext = pk.extensions as { prf: { eval: { first: BufferSource } } }
    expect(bytesToHex(bytes(ext.prf.eval.first)!)).toBe(bytesToHex(createOptions.prfInput))
  })

  it('returns a create-time PRF output when the authenticator gives one', async () => {
    const prf = H('prf at create')
    stubCredentials({ create: async () => credential({ rawId: H('c').slice(0, 16), prf }) })
    const made = await browserPasskeyAdapter().create(createOptions)
    expect(bytesToHex(made.prfOutput!)).toBe(bytesToHex(prf))
    expect(made.prfEnabled).toBe(true)
  })

  it('gets an assertion restricted to the allow list, with the user handle and PRF output', async () => {
    const rawId = H('cred').slice(0, 20)
    const prf = H('prf')
    const handle = userHandleFor(identity, contract)
    const { get } = stubCredentials({ get: async () => credential({ rawId, prf, userHandle: handle }) })
    const a = await browserPasskeyAdapter().get({ rpId: 'localhost', prfInput: H('in'), allow: [rawId] })
    expect(bytesToHex(a.credentialId)).toBe(bytesToHex(rawId))
    expect(bytesToHex(a.userHandle!)).toBe(bytesToHex(handle))
    expect(bytesToHex(a.prfOutput)).toBe(bytesToHex(prf))
    const pk = get.mock.calls[0]![0].publicKey!
    expect(pk.rpId).toBe('localhost')
    expect(pk.userVerification).toBe('required')
    expect(pk.allowCredentials!.map((c) => bytesToHex(bytes(c.id)!))).toEqual([bytesToHex(rawId)])
  })

  it("throws 'no-prf' with the credential id when the assertion has no PRF output", async () => {
    const rawId = H('cred').slice(0, 20)
    stubCredentials({ get: async () => credential({ rawId, prf: null, userHandle: null }) })
    const err = await browserPasskeyAdapter().get({ rpId: 'localhost', prfInput: H('in'), allow: [] }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PasskeyError)
    expect((err as PasskeyError).code).toBe('no-prf')
    expect(bytesToHex((err as PasskeyError).credentialId!)).toBe(bytesToHex(rawId))
  })

  it('maps browser rejections, and lets the app map them itself', async () => {
    const notAllowed = Object.assign(new Error('see https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client'), { name: 'NotAllowedError' })
    stubCredentials({ get: async () => Promise.reject(notAllowed) })
    await expect(browserPasskeyAdapter().get({ rpId: 'x', prfInput: H('i'), allow: [] })).rejects.toMatchObject({ code: 'cancelled' })
    const mapError = vi.fn((e: unknown, kind: string) => new Error(`${kind}: ${(e as Error).name}`))
    await expect(browserPasskeyAdapter({ mapError }).get({ rpId: 'x', prfInput: H('i'), allow: [] })).rejects.toThrow('get: NotAllowedError')
    expect(defaultPasskeyError(Object.assign(new Error(), { name: 'SecurityError' })).code).toBe('unsupported')
    expect(defaultPasskeyError(new Error('x')).code).toBe('failed')
    expect(defaultPasskeyError(Object.assign(new Error(), { name: 'InvalidStateError' })).code).toBe('exists')
  })

  it("refuses with 'unsupported' where there is no WebAuthn", async () => {
    vi.stubGlobal('navigator', {})
    await expect(browserPasskeyAdapter().create(createOptions)).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('aborts a ceremony that outlives its timeout (the backstop), so the prompt closes', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    stubCredentials({
      create: (o) => {
        signal = o.signal ?? undefined
        return new Promise(() => {})
      },
    })
    const pending = browserPasskeyAdapter({ timeoutMs: 1000 }).create(createOptions).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5999)
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const err = await pending
    expect((err as PasskeyError).code).toBe('timeout')
    expect(signal?.aborted).toBe(true)
  })

  it("aborts the ceremony when the caller's signal aborts", async () => {
    let signal: AbortSignal | undefined
    stubCredentials({
      get: (o) => {
        signal = o.signal ?? undefined
        return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
      },
    })
    const outer = new AbortController()
    const pending = browserPasskeyAdapter().get({ rpId: 'x', prfInput: H('i'), allow: [], signal: outer.signal }).catch((e: unknown) => e)
    outer.abort()
    expect(((await pending) as PasskeyError).code).toBe('cancelled')
    expect(signal?.aborted).toBe(true)
  })

  it('signals an unknown credential as base64url, where supported', async () => {
    const signalUnknownCredential = vi.fn(async () => {})
    vi.stubGlobal('PublicKeyCredential', { signalUnknownCredential })
    await browserPasskeyAdapter().signalUnknown!('localhost', Uint8Array.of(0xfb, 0xff, 0x01))
    expect(signalUnknownCredential).toHaveBeenCalledWith({ rpId: 'localhost', credentialId: '-_8B' })
    vi.stubGlobal('PublicKeyCredential', {})
    await expect(browserPasskeyAdapter().signalUnknown!('localhost', Uint8Array.of(1))).resolves.toBeUndefined()
  })
})

describe('prfSupport', () => {
  it("reads the client capabilities, else says 'unknown'; 'no' without WebAuthn", async () => {
    vi.stubGlobal('navigator', { credentials: {} })
    vi.stubGlobal('PublicKeyCredential', { getClientCapabilities: async () => ({ 'extension:prf': true }) })
    expect(await prfSupport()).toBe('yes')
    vi.stubGlobal('PublicKeyCredential', { getClientCapabilities: async () => ({ 'extension:prf': false }) })
    expect(await prfSupport()).toBe('no')
    vi.stubGlobal('PublicKeyCredential', {})
    expect(await prfSupport()).toBe('unknown')
    vi.stubGlobal('PublicKeyCredential', undefined)
    expect(await prfSupport()).toBe('no')
  })
})

describe('fakePasskeyAdapter', () => {
  it('PRF = HMAC(secret, input); discoverable get picks the last passkey; exclude refuses a held one', async () => {
    const fake = fakePasskeyAdapter({ prfAtCreate: true })
    const made = await fake.create(createOptions)
    const c = fake.credentials[0]!
    expect(bytesToHex(made.prfOutput!)).toBe(bytesToHex(hmac(sha256, c.secret, createOptions.prfInput)))
    const a = await fake.get({ rpId: createOptions.rpId, prfInput: createOptions.prfInput, allow: [] })
    expect(bytesToHex(a.prfOutput)).toBe(bytesToHex(made.prfOutput!))
    await expect(fake.create({ ...createOptions, exclude: [made.credentialId] })).rejects.toThrow(/already holds/)
    await expect(fake.get({ rpId: 'other.example', prfInput: createOptions.prfInput, allow: [] })).rejects.toMatchObject({ code: 'cancelled' })
  })
})
