/**
 * The scripted App Connect v2 wallet's own request checks (e2e/wallet-responder-v2.ts): they must
 * accept exactly the request Forge makes, and refuse what a real wallet would, so an e2e that
 * passes with it is not passing on a lax stand-in. The chain half (the identity update and the
 * published response) runs only in the live specs.
 */

import { describe, expect, it } from 'vitest'

import { v2RequestRefusal } from '../../e2e/wallet-responder-v2'
import type { ForgeIds } from '../deployments'
import { KeySecurityLevel, type AppConnectRequest } from '../vendor/platform-auth/app-connect'
import { forgeV2Request } from './app-connect-v2'

const FORGE: ForgeIds = {
  core: 'A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1',
  collab: 'C1zHeeG7EUudXdB5ZyDQnXVU35hrCfvd1fRCybXEqaPS',
  community: 'C1zHeeG7EUudXdB5ZyDQnXVU35hrCfvd1fRCybXEqaPS',
  group: '6dV3kMBWHGR7pLKrHToMBQgbTpjqeE2VAyCEWmLbrkWC',
}
const NOW = 1_800_000_000_000
const request = (): AppConnectRequest =>
  forgeV2Request(FORGE, { appEphemeralPubKey: new Uint8Array(33).fill(2), connectionId: new Uint8Array(16).fill(7), chainNow: NOW, now: NOW })
const check = (req: AppConnectRequest, now = NOW) => v2RequestRefusal(req, { now, groupId: FORGE.group, expectLabel: 'Dash Forge' })

describe('the scripted v2 wallet accepts exactly what Forge asks for', () => {
  it('accepts Forge\'s request, and a renewal naming the identity', () => {
    expect(check(request())).toBeNull()
    expect(check({ ...request(), identityHint: new Uint8Array(32).fill(5) })).toBeNull()
  })

  it('refuses a stale or a future request (wallet rule 2)', () => {
    expect(check(request(), NOW + 11 * 60_000)).toEqual({ status: 'stale', why: 'request is stale' })
    expect(check(request(), NOW - 3 * 60_000)).toEqual({ status: 'stale', why: 'request is future' })
    expect(check(request(), NOW + 9 * 60_000)).toBeNull()
  })

  it('refuses another group, another level, no budget, no expiry, an encryption binding, MODE', () => {
    const base = request()
    const binding = base.authBindings[0]!
    expect(check({ ...base, authBindings: [{ ...binding, id: new Uint8Array(32).fill(9) }] })?.why).toMatch(/Forge contract group/)
    expect(check({ ...base, authBindings: [{ ...binding, securityLevel: KeySecurityLevel.CRITICAL }] })?.why).toMatch(/other than HIGH/)
    const { totalBudget: _budget, ...noBudget } = binding
    void _budget
    expect(check({ ...base, authBindings: [noBudget] })?.why).toMatch(/budget/)
    const { expiresAt: _expiry, ...noExpiry } = binding
    void _expiry
    expect(check({ ...base, authBindings: [noExpiry] })?.why).toMatch(/expiry/)
    expect(check({ ...base, authBindings: [{ ...binding, expiresAt: NOW - 1 }] })?.why).toMatch(/expiry/)
    expect(check({ ...base, encBindings: [{ contractId: new Uint8Array(32).fill(1), purpose: 1 }] })?.why).toMatch(/encryption/)
    expect(check({ ...base, mode: 'renew' })?.status).toBe('unsupported')
    expect(check({ ...base, label: 'Evil' })?.why).toMatch(/label/)
  })
})
