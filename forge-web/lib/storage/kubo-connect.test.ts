import { afterEach, describe, expect, it, vi } from 'vitest'
import { isSafari, kuboUpCommand, pairWithNode, parseKuboCode, parseKuboFragment, validatePairResponse } from './kubo-connect'

vi.mock('./probe', () => ({ whyBlocked: vi.fn(async () => 'down') }))
const response = { name: 'kubo', api: 'http://127.0.0.1:5001', gateway: 'http://127.0.0.1:8080', auth: `Bearer ${'x'.repeat(43)}`, peerId: '12D3peer', version: '0.43.1' }
afterEach(() => vi.unstubAllGlobals())

describe('loopback pairing', () => {
  it('parses only a port and a Crockford code, normalized', () => {
    expect(parseKuboFragment('#kubo=5001.7kq2m9xdpf4c')).toEqual({ port: 5001, code: '7KQ2-M9XD-PF4C' })
    for (const hash of ['#kubo=0.7KQ2-M9XD-PF4C', '#kubo=65536.7KQ2-M9XD-PF4C', '#kubo=5001.AAAA-IIII-OOOO', '#kubo=5001.7KQ2-M9XD-PF4C&x=1', '#kubo=http://evil/']) expect(parseKuboFragment(hash)).toBeNull()
    expect(parseKuboCode('7KQ2-M9XD-PF4C', 1)).not.toBeNull()
    expect(parseKuboCode('7KQ2-M9XD-PF4C', 65535)).not.toBeNull()
  })
  it('rejects nonliteral loopback origins, unsafe tokens and extra fields', () => {
    expect(validatePairResponse(response).profile.secrets.apiAuth).toBe(response.auth)
    for (const extra of [{ api: 'https://evil.example' }, { api: 'http://localhost:5001' }, { api: 'http://127.1:5001' }, { gateway: 'http://127.0.0.1:8080/' }, { gateway: 'http://127.0.0.1:0' }, { auth: 'Bearer short' }, { name: 'platform' }, { extra: true }]) expect(() => validatePairResponse({ ...response, ...extra })).toThrow(/invalid connection/)
  })
  it('pairs with a JSON POST and no cookies or redirects', async () => {
    const fetch = vi.fn(async () => Response.json(response))
    vi.stubGlobal('fetch', fetch)
    await expect(pairWithNode({ port: 5001, code: '7KQ2-M9XD-PF4C' })).resolves.toMatchObject({ version: '0.43.1' })
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:5001/dash-forge/pair', expect.objectContaining({ method: 'POST', credentials: 'omit', redirect: 'error', targetAddressSpace: 'loopback', body: '{"code":"7KQ2-M9XD-PF4C"}' }))
  })
  it.each([[403, /Wrong code/], [410, /expired/]] as const)('explains HTTP %d', async (status, message) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })))
    await expect(pairWithNode({ port: 5001, code: '7KQ2-M9XD-PF4C' })).rejects.toThrow(message)
  })
  it('explains a network or local-access failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('failed') }))
    await expect(pairWithNode({ port: 5001, code: '7KQ2-M9XD-PF4C' })).rejects.toThrow(/not running.*browser blocked/)
  })
  it('detects Safari and builds origin-specific commands', () => {
    expect(isSafari('Version/18.0 Safari/605.1')).toBe(true)
    expect(isSafari('Chrome/142 Safari/537.36')).toBe(false)
    expect(kuboUpCommand('https://forge.dashhq.org', '/settings/storage/')).toBe('dg ipfs up')
    expect(kuboUpCommand('http://localhost:3000', '/settings/storage/')).toContain('--origin')
    expect(kuboUpCommand('https://ipfs.io', '/ipfs/bafy/settings/storage/')).toBeNull()
    expect(kuboUpCommand('https://ipfs.io', '/ipns/example/settings/storage/')).toBeNull()
  })
})
