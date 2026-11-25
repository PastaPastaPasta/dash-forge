import { afterEach, describe, expect, it, vi } from 'vitest'
import { whyBlocked } from './probe'
import { isSafari, safariNeedsNotice, kuboUpCommand, pairWithNode, parseKuboCode, parseKuboFragment, validatePairResponse } from './kubo-connect'

vi.mock('./probe', () => ({ whyBlocked: vi.fn(async () => 'down') }))
const response = { name: 'kubo', api: 'http://127.0.0.1:5001', gateway: 'http://127.0.0.1:8080', auth: `Bearer ${'x'.repeat(43)}`, peerId: '12D3peer', version: '0.43.1' }
afterEach(() => vi.unstubAllGlobals())
function stubPermission(states: PermissionState[]): void {
  const query = vi.fn(async () => ({ state: states.shift() ?? 'granted' }))
  vi.stubGlobal('navigator', { userAgent: 'Chrome/158', permissions: { query } })
}

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
  it('rejects a response that changes the paired API port', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...response, api: 'http://127.0.0.1:6001' })))
    await expect(pairWithNode({ port: 5001, code: '7KQ2-M9XD-PF4C' })).rejects.toThrow(/different API port/)
  })
  it.each([[403, /code isn't right/], [410, /expired or was already used/]] as const)('explains HTTP %d', async (status, message) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })))
    await expect(pairWithNode({ port: 5001, code: '7KQ2-M9XD-PF4C' })).rejects.toThrow(message)
  })
  it('explains a node that is not running', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('failed') }))
    await expect(pairWithNode({ port: 5001, code: '7KQ2-M9XD-PF4C' })).rejects.toThrow(/isn't running\. Run dg ipfs up/)
  })
  it('waits on the local-network prompt without a timeout', async () => {
    stubPermission(['prompt'])
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(response))
    vi.stubGlobal('fetch', fetch)
    const onAsk = vi.fn()
    await expect(pairWithNode({ port: 5001, code: '7KQ2-M9XD-PF4C' }, onAsk)).resolves.toMatchObject({ version: '0.43.1' })
    expect(onAsk).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal)
  })
  it.each([['granted', 15_000], ['prompt', 120_000]] as const)('with access %s, times out after %d ms', async (state, ms) => {
    stubPermission([state])
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(response)))
    await pairWithNode({ port: 5001, code: '7KQ2-M9XD-PF4C' })
    expect(timeout).toHaveBeenCalledWith(ms)
    timeout.mockRestore()
  })
  it('tells a blocked permission apart from a refusing node', async () => {
    stubPermission(['denied'])
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(pairWithNode({ port: 5001, code: '7KQ2-M9XD-PF4C' })).rejects.toThrow(/site's settings/)
    expect(fetch).not.toHaveBeenCalled()
    stubPermission(['prompt', 'prompt'])
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('failed') }))
    await expect(pairWithNode({ port: 5001, code: '7KQ2-M9XD-PF4C' })).rejects.toThrow(/isn't running/)
    stubPermission(['prompt', 'prompt'])
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(30_000)
    await expect(pairWithNode({ port: 5001, code: '7KQ2-M9XD-PF4C' })).rejects.toThrow(/then choose Allow/)
    now.mockRestore()
  })
  it('asks for no flag on mainnet, and names the 0.2.0 one on testnet', async () => {
    stubPermission(['granted', 'granted'])
    vi.mocked(whyBlocked).mockResolvedValueOnce('cors')
    vi.stubGlobal('location', { origin: 'https://testnet-forge.dashhq.org' })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('failed') }))
    const error = await pairWithNode({ port: 5001, code: '7KQ2-M9XD-PF4C' }).catch((e: Error) => e)
    expect(String(error)).toMatch(/Update dg and run dg ipfs up \(with dg 0\.2\.0: dg ipfs up --origin https:\/\/testnet-forge\.dashhq\.org\)/)
    vi.mocked(whyBlocked).mockResolvedValueOnce('cors')
    stubPermission(['granted', 'granted'])
    vi.stubGlobal('location', { origin: 'https://forge.dashhq.org' })
    const mainnet = await pairWithNode({ port: 5001, code: '7KQ2-M9XD-PF4C' }).catch((e: Error) => e)
    expect(String(mainnet)).toMatch(/Update dg, run dg ipfs up/)
    expect(String(mainnet)).not.toMatch(/--origin/)
  })
  it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'https://forge.dashhq.org'])('limits the Safari notice on %s', (origin) => {
    vi.stubGlobal('navigator', { userAgent: 'Version/18.0 Safari/605.1' })
    expect(safariNeedsNotice(origin)).toBe(origin.startsWith('https:'))
  })
  it.each(['https://bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku.ipfs.dweb.link', 'https://example.ipns.dweb.link'])('offers no command on subdomain gateway %s', (origin) => {
    expect(kuboUpCommand(origin, '/settings/storage/')).toBeNull()
  })
  it('detects Safari and builds origin-specific commands', () => {
    expect(isSafari('Version/18.0 Safari/605.1')).toBe(true)
    expect(isSafari('Chrome/142 Safari/537.36')).toBe(false)
    expect(kuboUpCommand('https://forge.dashhq.org', '/settings/storage/')).toBe('dg ipfs up')
    expect(kuboUpCommand('https://testnet-forge.dashhq.org', '/settings/storage/')).toBe('dg ipfs up')
    expect(kuboUpCommand('http://localhost:3000', '/settings/storage/')).toContain('--origin')
    expect(kuboUpCommand('https://ipfs.io', '/ipfs/bafy/settings/storage/')).toBeNull()
    expect(kuboUpCommand('https://ipfs.io', '/ipns/example/settings/storage/')).toBeNull()
    expect(kuboUpCommand('null', '/settings/storage/')).toBeNull()
  })
})
