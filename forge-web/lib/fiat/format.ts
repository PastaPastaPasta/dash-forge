import type { Network } from '../constants'
import currencies from './currencies.json'
import { isCurrency, validRate, type Currency } from './providers'

export type FiatKind = 'estimate' | 'bound' | 'exact'

export function formatFiat(amount: number, currency: Currency): string | null {
  if (!Number.isFinite(amount) || !isCurrency(currency)) return null
  const digits = currencies[currency]
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency, currencyDisplay: 'symbol',
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(amount)
}

export function fiatText(dash: number, opts: {
  kind?: FiatKind
  /** Lower end of a DASH range; dash is the upper end. */
  range?: number
  network: Network
  rate: number | undefined
  currency: Currency
}): string | null {
  if (!validRate(opts.rate) || !isCurrency(opts.currency) || !Number.isFinite(dash)) return null
  const amount = dash * opts.rate
  const formatted = formatFiat(amount, opts.currency)
  if (formatted === null) return null
  const unit = 10 ** -currencies[opts.currency]
  const kind = opts.kind ?? 'estimate'
  let text: string
  if (opts.range !== undefined) {
    if (!Number.isFinite(opts.range) || opts.range < 0 || opts.range > dash) return null
    const low = opts.range * opts.rate
    const lowText = formatFiat(low, opts.currency)
    if (lowText === null) return null
    if (lowText === formatted) return fiatText(dash, { ...opts, range: undefined })
    else if (low < unit) text = `≤ ${formatted}`
    else text = `${kind === 'exact' ? '' : '≈ '}${lowText}–${formatted}`
  } else if (amount === 0) text = formatted
  else if (amount > 0 && amount < unit) text = `< ${formatFiat(unit, opts.currency)}`
  else if (kind === 'bound') text = `≤ ${formatted}`
  else text = `${kind === 'estimate' ? '≈ ' : ''}${formatted}`
  return `${text}${opts.network === 'mainnet' ? '' : ' on mainnet'}`
}
