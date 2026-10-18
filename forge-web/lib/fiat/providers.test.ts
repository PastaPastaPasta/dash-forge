import { describe, expect, it, vi } from 'vitest'
import { COINGECKO_URL, FIAT_PROVIDER_HOSTS, fiatProviders, parseCoinGecko, parseCtx, safeRateUrl } from './providers'
import currencies from './currencies.json'

const row = (quoteCurrency: string, price: unknown, baseCurrency = 'DASH') => ({ baseCurrency, quoteCurrency, price, retrieved: 'never parse this' })

describe('fiat providers', () => {
  it('accepts CTX string rates, ignoring other assets and unsupported currencies', () => {
    expect(parseCtx([row('USD', '48.03'), row('EUR', '44'), row('USD', '100', 'BTC'), row('XAU', '2')])).toEqual({ USD: 48.03, EUR: 44 })
  })
  it.each([[], {}, null, [row('EUR', '40')], [row('USD', 'no')], [row('USD', 40)], [row('USD', '')], [row('USD', '0')], [row('USD', '-1')], [row('USD', 'Infinity')]])('rejects malformed CTX bodies or a missing valid USD row: %j', (body) => {
    expect(parseCtx(body)).toBeNull()
  })
  it('accepts only finite positive CoinGecko numbers for the fixed currency table', () => {
    expect(parseCoinGecko({ dash: { usd: 40, eur: 36, btc: 0.1, jpy: -1, cad: '50' } })).toEqual({ USD: 40, EUR: 36 })
  })
  it.each([[], {}, null, { dash: {} }, { dash: { eur: 36 } }, { dash: { usd: '40' } }, { dash: { usd: Infinity } }, { dash: { last_updated_at: 123 } }])('rejects incomplete CoinGecko bodies: %j', (body) => {
    expect(parseCoinGecko(body)).toBeNull()
  })
  it('requests all 34 currencies in one identical fallback URL', () => {
    expect(Object.keys(currencies)).toHaveLength(34)
    expect(new URL(COINGECKO_URL).searchParams.get('vs_currencies')?.split(',')).toEqual(Object.keys(currencies).map((code) => code.toLowerCase()))
    expect(FIAT_PROVIDER_HOSTS).toEqual(['rates.ctx.com', 'api.coingecko.com'])
  })
  it.each(['/__e2e/fiat-rates.json', './rates.json', 'rates.json', 'http://127.0.0.1:4321/rates', 'http://[::1]/rates', 'https://localhost/rates'])('permits local fixture overrides: %s', (url) => {
    expect(safeRateUrl(url)).not.toBeNull()
  })
  it.each(['https://example.com/rates', '//evil.example/rates', '/\\evil.example/rates', 'javascript:alert(1)', 'file:///tmp/rates', 'https://localhost.evil/rates', 'http://user:pass@localhost/rates', ' https://localhost/rates', 'https://127.0.0.2/rates'])('ignores unsafe overrides: %s', (url) => {
    expect(safeRateUrl(url)).toBeNull()
  })
  it('uses one CTX-format provider for a valid build override', () => {
    vi.stubEnv('NEXT_PUBLIC_FIAT_RATE_URL', '/__e2e/fiat-rates.json')
    expect(fiatProviders()).toEqual([{ url: '/__e2e/fiat-rates.json', source: 'ctx', parse: parseCtx }])
    vi.unstubAllEnvs()
  })
})
