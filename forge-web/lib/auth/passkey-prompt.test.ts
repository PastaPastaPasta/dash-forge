/**
 * One passkey prompt while an unfinished renewal (D-016) is protected with another passkey:
 * the prompt offers both passkeys and evaluates the one the user picks (`evalByCredential`),
 * two records on one passkey are opened with both salts of one assertion, and a browser that
 * returns no PRF for `evalByCredential` gets one more prompt, announced. The authenticator is
 * a fake: PRF(credential, salt) = SHA-256(credential ‖ salt).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'

import { resetMemoryStores } from '../idb'
import { encodeWif } from './wif'
import { lockVault, stageInVault, storeInVault, unlockWithPasskey, type Protection } from './vault'

const NET = 'devnet' as const
const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const wifOf = (n: number): string => encodeWif(new Uint8Array(32).fill(n), NET)

const prf = (cred: Uint8Array, salt: Uint8Array): Uint8Array => sha256(new Uint8Array([...cred, ...salt]))
const b64url = (b: Uint8Array): string => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

interface Authenticator {
  /** The credential the user picks when offered several. */
  pick: Uint8Array
  /** The browser returns no PRF results for `evalByCredential`. */
  noEvalByCredential: boolean
  prompts: number
}
const auth: Authenticator = { pick: new Uint8Array(), noEvalByCredential: false, prompts: 0 }

type PrfInputs = { first: Uint8Array; second?: Uint8Array }
function fakeGet(opts: { publicKey: { allowCredentials: { id: Uint8Array }[]; extensions: { prf: { eval?: PrfInputs; evalByCredential?: Record<string, PrfInputs> } } } }): unknown {
  auth.prompts++
  const allowed = opts.publicKey.allowCredentials.map((c) => new Uint8Array(c.id))
  const cred = allowed.length === 1 ? allowed[0]! : (allowed.find((c) => b64url(c) === b64url(auth.pick)) ?? allowed[0]!)
  const ext = opts.publicKey.extensions.prf
  const inputs = ext.eval ?? (auth.noEvalByCredential ? undefined : ext.evalByCredential?.[b64url(cred)])
  const results = inputs ? { first: prf(cred, inputs.first).buffer, ...(inputs.second ? { second: prf(cred, inputs.second).buffer } : {}) } : undefined
  return { rawId: cred.slice().buffer, getClientExtensionResults: () => ({ prf: results ? { results } : {} }) }
}

function passkey(credByte: number, saltByte: number): NonNullable<Protection['passkey']> {
  const credentialId = new Uint8Array(16).fill(credByte)
  const prfSalt = new Uint8Array(32).fill(saltByte)
  return { credentialId, prfSalt, output: prf(credentialId, prfSalt) }
}

describe('one passkey prompt with a pending renewal (D-016)', () => {
  beforeEach(() => {
    resetMemoryStores()
    lockVault()
    Object.assign(auth, { pick: new Uint8Array(), noEvalByCredential: false, prompts: 0 })
    vi.stubGlobal('window', { location: { hostname: 'forge.test', pathname: '/' }, isSecureContext: true, localStorage: { length: 0, key: () => null, removeItem: () => {} } })
    vi.stubGlobal('navigator', { credentials: { get: async (o: never) => fakeGet(o) } })
  })
  afterEach(() => vi.unstubAllGlobals())

  it("two passkeys: one prompt offers both, and the renewal's opens the renewal", async () => {
    const current = passkey(1, 10)
    const renewal = passkey(2, 20)
    await storeInVault(NET, { identityId: ID, keyId: 5, wif: wifOf(5) }, { passkey: current })
    await stageInVault(NET, { identityId: ID, keyId: 6, wif: wifOf(22) }, { passkey: renewal })
    lockVault()
    auth.pick = renewal.credentialId
    const notes: string[] = []
    expect((await unlockWithPasskey(NET, ID, (n) => notes.push(n))).keyId).toBe(6)
    expect(auth.prompts).toBe(1)
    expect(notes).toEqual([])
  })

  it("two passkeys: picking the current key's opens the current key, still one prompt", async () => {
    const current = passkey(1, 10)
    await storeInVault(NET, { identityId: ID, keyId: 5, wif: wifOf(5) }, { passkey: current })
    await stageInVault(NET, { identityId: ID, keyId: 6, wif: wifOf(22) }, { passkey: passkey(2, 20) })
    lockVault()
    auth.pick = current.credentialId
    expect((await unlockWithPasskey(NET, ID)).keyId).toBe(5)
    expect(auth.prompts).toBe(1)
  })

  it('one passkey, two salts: one assertion evaluates both', async () => {
    await storeInVault(NET, { identityId: ID, keyId: 5, wif: wifOf(5) }, { passkey: passkey(1, 10) })
    await stageInVault(NET, { identityId: ID, keyId: 6, wif: wifOf(22) }, { passkey: passkey(1, 20) })
    lockVault()
    expect((await unlockWithPasskey(NET, ID)).keyId).toBe(5)
    expect(auth.prompts).toBe(1)
  })

  it('a browser without evalByCredential: one more prompt, and the user is told why', async () => {
    const renewal = passkey(2, 20)
    await storeInVault(NET, { identityId: ID, keyId: 5, wif: wifOf(5) }, { passkey: passkey(1, 10) })
    await stageInVault(NET, { identityId: ID, keyId: 6, wif: wifOf(22) }, { passkey: renewal })
    lockVault()
    auth.pick = renewal.credentialId
    auth.noEvalByCredential = true
    const notes: string[] = []
    expect((await unlockWithPasskey(NET, ID, (n) => notes.push(n))).keyId).toBe(6)
    expect(auth.prompts).toBe(2)
    expect(notes).toEqual([expect.stringMatching(/one more passkey confirmation/)])
  })

  it('no pending renewal: a single-passkey prompt as before', async () => {
    await storeInVault(NET, { identityId: ID, keyId: 5, wif: wifOf(5) }, { passkey: passkey(1, 10) })
    lockVault()
    expect((await unlockWithPasskey(NET, ID)).keyId).toBe(5)
    expect(auth.prompts).toBe(1)
  })
})
