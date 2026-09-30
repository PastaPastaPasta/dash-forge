// @vitest-environment jsdom
/**
 * What this browser keeps about an identity beyond its key (QA wave 2):
 * - QW2-025: the identity signed in last, which Unlock preselects among several stored keys;
 * - QW2-028: "Sign out & forget key" removes the spend ledger, the notifications inbox and the
 *   last-used marker too, so a shared computer keeps no trace of the identity.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { idbEntries, idbPut, resetMemoryStores } from '../idb'
import { clearLedger, readBaseline, readLedger, recordSpend } from '../spend'
import { clearInbox } from '../view/inbox'
import { forgetLastIdentity, lockedIdentityOf, readLastIdentity, rememberLastIdentity } from './last-identity'

const A = 'JCuebezAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const B = 'BWv9Ku1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

afterEach(() => {
  resetMemoryStores()
  window.localStorage.clear()
})

describe('the identity signed in last', () => {
  it('is remembered per network and forgotten with its key only', () => {
    expect(readLastIdentity('devnet')).toBeNull()
    rememberLastIdentity('devnet', A)
    rememberLastIdentity('devnet', B)
    expect(readLastIdentity('devnet')).toBe(B)
    expect(readLastIdentity('testnet')).toBeNull()
    forgetLastIdentity('devnet', A)
    expect(readLastIdentity('devnet')).toBe(B)
    forgetLastIdentity('devnet', B)
    expect(readLastIdentity('devnet')).toBeNull()
  })

  it('picks the locked identity: the last used when still stored, else the first finished key', () => {
    const vaults = [{ identityId: A, staged: true as const }, { identityId: B }]
    expect(lockedIdentityOf(vaults, B)).toBe(B)
    expect(lockedIdentityOf(vaults, 'gone')).toBe(B)
    expect(lockedIdentityOf([{ identityId: A }, { identityId: B }], null)).toBe(A)
    expect(lockedIdentityOf([], A)).toBeNull()
  })
})

describe('forgetting an identity here', () => {
  it("clears its spend ledger and baseline, and leaves other identities' alone", async () => {
    const row = { network: 'devnet' as const, kind: 'issue', estimateCredits: 10, actualCredits: 9, at: 1, balanceBefore: '1000' }
    await recordSpend({ ...row, identityId: A } as unknown as Parameters<typeof recordSpend>[0])
    await recordSpend({ ...row, identityId: B } as unknown as Parameters<typeof recordSpend>[0])
    expect((await readLedger('devnet', A)).length).toBe(1)
    await clearLedger('devnet', A)
    expect(await readLedger('devnet', A)).toEqual([])
    expect(await readBaseline('devnet', A)).toBeNull()
    expect((await readLedger('devnet', B)).length).toBe(1)
  })

  it("clears its inbox (items, cursors, subscriptions), and leaves other identities' alone", async () => {
    await idbPut('inbox', `devnet:${A}:subs`, { repos: [] })
    await idbPut('inbox', `devnet:${A}:seen`, {})
    await idbPut('inbox', `devnet:${A}:item:1`, { id: '1' })
    await idbPut('inbox', `devnet:${B}:subs`, { repos: [] })
    await clearInbox('devnet', A)
    expect((await idbEntries('inbox')).map(([k]) => k)).toEqual([`devnet:${B}:subs`])
  })
})
