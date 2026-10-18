import currencies from './currencies.json'

export type Currency = keyof typeof currencies
export type Rates = Partial<Record<Currency, number>>
export type FiatSource = 'ctx' | 'coingecko'

export const FIAT_PROVIDER_HOSTS = ['rates.ctx.com', 'api.coingecko.com'] as const
const CTX_URL = 'https://rates.ctx.com/rates?source=ctx'
export const COINGECKO_URL = `https://api.coingecko.com/api/v3/simple/price?ids=dash&vs_currencies=${Object.keys(currencies).join(',').toLowerCase()}`

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && Object.hasOwn(currencies, value)
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function validRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function parseCtx(value: unknown): Rates | null {
  if (!Array.isArray(value)) return null
  const rates: Rates = {}
  for (const row of value) {
    if (!record(row) || row.baseCurrency !== 'DASH' || !isCurrency(row.quoteCurrency) || typeof row.price !== 'string' || row.price.trim() === '') continue
    const rate = Number(row.price)
    if (validRate(rate)) rates[row.quoteCurrency] = rate
  }
  return validRate(rates.USD) ? rates : null
}

export function parseCoinGecko(value: unknown): Rates | null {
  if (!record(value) || !record(value.dash)) return null
  const rates: Rates = {}
  for (const currency of Object.keys(currencies) as Currency[]) {
    const rate = value.dash[currency.toLowerCase()]
    if (validRate(rate)) rates[currency] = rate
  }
  return validRate(rates.USD) ? rates : null
}

/** Fixture overrides must stay on this site or a local development server. */
export function safeRateUrl(value: string | undefined): string | null {
  if (!value || value !== value.trim() || /[\\\s]/.test(value)) return null
  try {
    const url = new URL(value, 'https://forge.invalid/')
    if (url.username || url.password) return null
    if (!/^[a-z][a-z\d+.-]*:/i.test(value) && url.origin === 'https://forge.invalid') return value
    if (['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return url.href
  } catch { /* Invalid URLs use the real providers. */ }
  return null
}

export function fiatProviders(): readonly { url: string; source: FiatSource; parse: (value: unknown) => Rates | null }[] {
  const override = safeRateUrl(process.env.NEXT_PUBLIC_FIAT_RATE_URL)
  return override
    ? [{ url: override, source: 'ctx', parse: parseCtx }]
    : [{ url: CTX_URL, source: 'ctx', parse: parseCtx }, { url: COINGECKO_URL, source: 'coingecko', parse: parseCoinGecko }]
}
