/**
 * What the sign-in sheet says when something is wrong (QA wave bonsia, QW-011, QW-049, QW-050,
 * QW-052, QW-053): a recovery phrase that is not one, an identity ID that cannot be one, a
 * pasted key that cannot sign (and why), a passkey prompt that failed, and whether a stored
 * key has an encryption key beside it that a locked replacement would drop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetMemoryStores } from '../idb'
import { SECURITY_LEVEL } from '../sdk/write'
import { identityIdProblem, rawKeyProblem, type RawKeyView } from './controller'
import { mnemonicProblem, quizAnswerOk } from './hd'
import { listVaults, lockVault, passkeyFailure, storeEncryptionKey, storeInVault } from './vault'
import { encodeWif } from './wif'

const NET = 'devnet' as const
const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'

describe('mnemonicProblem', () => {
  it('names the word count when it is not one a phrase can have', () => {
    expect(mnemonicProblem('foo bar baz')).toMatch(/12 or 24 words.*this has 3 words/)
    expect(mnemonicProblem('  foo  ')).toMatch(/this has 1 word\./)
    expect(mnemonicProblem('')).toMatch(/this has 0 words/)
  })

  it('a phrase of a valid length fails on its words or their order', () => {
    const twelve = Array(12).fill('abandon').join(' ')
    expect(mnemonicProblem(twelve)).toMatch(/These 12 words aren't a valid recovery phrase: a word is misspelt/)
    expect(mnemonicProblem(twelve)).toMatch(/in order/)
  })
})

describe('quizAnswerOk', () => {
  it('ignores case and surrounding spaces, and nothing else', () => {
    expect(quizAnswerOk('  Album ', 'album')).toBe(true)
    expect(quizAnswerOk('albun', 'album')).toBe(false)
    expect(quizAnswerOk('album', undefined)).toBe(false)
  })
})

describe('identityIdProblem', () => {
  it('accepts a 32-byte base58 id', () => {
    expect(identityIdProblem(ID)).toBeNull()
  })

  it('names what is wrong instead of the SDK error', () => {
    expect(identityIdProblem('')).toBe('Enter the identity ID.')
    expect(identityIdProblem('9r27eDsuXEqo')).toMatch(/too short/)
    expect(identityIdProblem(`${ID}${ID.slice(0, 6)}`)).toMatch(/too long/)
    expect(identityIdProblem('0OIl-not-base58')).toMatch(/characters an ID can't have/)
    for (const id of ['', 'x', '0OIl']) expect(identityIdProblem(id)).not.toMatch(/byte length|Identifier must/)
  })
})

describe('rawKeyProblem', () => {
  const key = (over: Partial<RawKeyView> & { mine?: boolean }): RawKeyView & { mine: boolean } => ({
    purposeNumber: 0,
    securityLevelNumber: SECURITY_LEVEL.HIGH,
    mine: false,
    ...over,
  })
  const mine = (k: { mine: boolean }): boolean => k.mine

  it('a key the identity does not have', () => {
    expect(rawKeyProblem([key({})], mine)).toMatch(/isn't one of this identity's keys/)
  })

  it('the master key: says so, and points at Import instead of a generic refusal', () => {
    const text = rawKeyProblem([key({}), key({ securityLevelNumber: SECURITY_LEVEL.MASTER, mine: true })], mine)
    expect(text).toMatch(/master key/)
    expect(text).toMatch(/Import an identity file or recovery phrase/)
  })

  it('a disabled, an expired, a non-authentication and a MEDIUM key', () => {
    expect(rawKeyProblem([key({ mine: true, disabledAt: 5n })], mine)).toMatch(/disabled/)
    expect(rawKeyProblem([key({ mine: true, expiresAt: 1_000n })], mine, 2_000)).toMatch(/expired on/)
    expect(rawKeyProblem([key({ mine: true, purposeNumber: 3, securityLevelNumber: SECURITY_LEVEL.CRITICAL })], mine)).toMatch(/transfer key, not an authentication key/)
    expect(rawKeyProblem([key({ mine: true, securityLevelNumber: SECURITY_LEVEL.MEDIUM })], mine)).toMatch(/HIGH or CRITICAL/)
  })
})

describe('passkeyFailure', () => {
  const dom = (name: string): DOMException =>
    new DOMException('The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.', name)

  it('an unlock that was not allowed: plain words, no w3.org URL', () => {
    const e = passkeyFailure(dom('NotAllowedError'), 'get') as Error
    expect(e.message).toMatch(/The passkey didn't open/)
    expect(e.message).not.toMatch(/w3\.org|NotAllowed/)
    expect(e.message.endsWith('.')).toBe(true)
  })

  it('enrolment messages leave the "use a passphrase" advice to their caller', () => {
    const e = passkeyFailure(dom('NotAllowedError'), 'create') as Error
    expect(e.message).toBe('No passkey was made: the prompt was closed or timed out')
    expect((passkeyFailure(dom('InvalidStateError'), 'create') as Error).message).toMatch(/already holds a passkey/)
  })

  it('an abort and anything unrecognised pass through unchanged', () => {
    const abort = dom('AbortError')
    expect(passkeyFailure(abort, 'get')).toBe(abort)
    const other = new Error('boom')
    expect(passkeyFailure(other, 'get')).toBe(other)
    expect(passkeyFailure('text', 'get')).toBe('text')
  })
})

describe('listVaults: whether an encryption key is sealed beside the key (QW-052)', () => {
  beforeEach(() => {
    resetMemoryStores()
    lockVault()
    vi.stubGlobal('window', { location: { hostname: 'forge.test', pathname: '/' }, isSecureContext: true, localStorage: { length: 0, key: () => null, removeItem: () => {} } })
  })
  afterEach(() => {
    lockVault()
    vi.unstubAllGlobals()
  })

  it('flags a vault that holds one, and only that vault', async () => {
    const other = 'BTJPjCLCnRaJQkqakpcdLYFsaHgFf5XSEBNxFCyYBteH'
    // A passkey (its PRF output given) seals without Argon2, which would take seconds here.
    const passkey = { credentialId: new Uint8Array(16).fill(1), prfSalt: new Uint8Array(32).fill(2), output: new Uint8Array(32).fill(3) }
    await storeInVault(NET, { identityId: other, keyId: 5, wif: encodeWif(new Uint8Array(32).fill(7), NET) }, { passkey })
    await storeInVault(NET, { identityId: ID, keyId: 5, wif: encodeWif(new Uint8Array(32).fill(5), NET) }, { passkey })
    await storeEncryptionKey(NET, ID, 4, new Uint8Array(32).fill(9))
    const byId = new Map((await listVaults(NET)).map((v) => [v.identityId, v]))
    expect(byId.get(ID)?.encryptionKey).toBe(true)
    expect(byId.get(other)?.encryptionKey).toBeUndefined()
  })
})
