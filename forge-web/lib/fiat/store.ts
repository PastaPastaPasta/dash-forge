import { fiatProviders, isCurrency, validRate, type Currency, type FiatSource, type Rates } from './providers'

export const FIAT_SETTINGS_KEY = 'forge:fiat:v1'
export const FIAT_RATES_KEY = 'forge:fiat-rates:v1'
export const FRESH_MS = 10 * 60_000
export const USABLE_MS = 24 * 60 * 60_000
export const BACKOFF_MS = 2 * 60_000
export const TIMEOUT_MS = 5_000

export interface FiatSettings { readonly enabled: boolean; readonly currency: Currency }
export interface FiatRates { readonly v: 1; readonly source: FiatSource; readonly fetchedAt: number; readonly rates: Rates }
export const SERVER_FIAT_SETTINGS: FiatSettings = { enabled: true, currency: 'USD' }

let settings = SERVER_FIAT_SETTINGS
let rates: FiatRates | null = null
let initialized = false
let failedAt: number | null = null
let inFlight: Promise<void> | null = null
let controller: AbortController | null = null
let fiatFetch: typeof fetch = (...args) => fetch(...args)
const rateListeners = new Set<() => void>()
const settingsListeners = new Set<() => void>()

function read(key: string): unknown {
  try { return JSON.parse(window.localStorage.getItem(key) ?? 'null') } catch { return null }
}

function write(key: string, value: unknown): void {
  try { window.localStorage.setItem(key, JSON.stringify(value)) } catch { /* Prices work without storage. */ }
}

function readSettings(): FiatSettings {
  const value = read(FIAT_SETTINGS_KEY)
  if (value && typeof value === 'object' && 'v' in value && value.v === 1 && 'enabled' in value && typeof value.enabled === 'boolean' && 'currency' in value && isCurrency(value.currency)) {
    return { enabled: value.enabled, currency: value.currency }
  }
  return SERVER_FIAT_SETTINGS
}

function readRates(): FiatRates | null {
  const value = read(FIAT_RATES_KEY) as Partial<FiatRates> | null
  if (!value || value.v !== 1 || !['ctx', 'coingecko'].includes(value.source ?? '') || typeof value.fetchedAt !== 'number' || !Number.isFinite(value.fetchedAt) || value.fetchedAt > Date.now() || Date.now() - value.fetchedAt >= USABLE_MS || !value.rates || typeof value.rates !== 'object' || Array.isArray(value.rates)) return null
  const clean: Rates = {}
  for (const [code, rate] of Object.entries(value.rates)) {
    if (isCurrency(code) && validRate(rate)) clean[code] = rate
  }
  return validRate(clean.USD) ? { v: 1, source: value.source as FiatSource, fetchedAt: value.fetchedAt, rates: clean } : null
}

function emitRates(): void { rateListeners.forEach((listener) => listener()) }

function applySettings(next: FiatSettings): void {
  if (next.enabled === settings.enabled && next.currency === settings.currency) return
  settings = next
  if (!settings.enabled) controller?.abort()
  settingsListeners.forEach((listener) => listener())
  emitRates()
}

function applyRates(next: FiatRates | null): void {
  if (JSON.stringify(next) === JSON.stringify(rates)) return
  rates = next
  emitRates()
}

function onStorage(event: StorageEvent): void {
  if (event.key === FIAT_SETTINGS_KEY || event.key === null) applySettings(readSettings())
  if (event.key === FIAT_RATES_KEY || event.key === null) applyRates(readRates())
  if (event.key === FIAT_SETTINGS_KEY || event.key === null) refresh()
}

function onVisibility(): void {
  if (!document.hidden) refresh()
}

function initialize(): void {
  if (initialized || typeof window === 'undefined') return
  initialized = true
  settings = readSettings()
  rates = readRates()
  window.addEventListener('storage', onStorage)
  document.addEventListener('visibilitychange', onVisibility)
}

export function getFiatSettings(): FiatSettings { return settings }
// No timer fires at 24 h: the next render checks expiry, and becoming visible rechecks it.
export function getFiatRates(): FiatRates | null {
  return settings.enabled && rates && Date.now() - rates.fetchedAt < USABLE_MS ? rates : null
}
export function getServerFiatRates(): null { return null }
export function getServerFiatSettings(): FiatSettings { return SERVER_FIAT_SETTINGS }

export function subscribeFiatSettings(listener: () => void): () => void {
  initialize()
  settingsListeners.add(listener)
  return () => { settingsListeners.delete(listener) }
}

export function subscribeFiatRates(listener: () => void): () => void {
  initialize()
  rateListeners.add(listener)
  refresh()
  return () => { rateListeners.delete(listener) }
}

export function setFiatSettings(next: Partial<FiatSettings>): void {
  initialize()
  const updated = { ...settings, ...next }
  if (typeof updated.enabled !== 'boolean' || !isCurrency(updated.currency)) return
  applySettings(updated)
  write(FIAT_SETTINGS_KEY, { v: 1, ...settings })
  refresh()
}

async function fetchRates(): Promise<void> {
  for (const provider of fiatProviders()) {
    if (!settings.enabled || rateListeners.size === 0) return
    const abort = new AbortController()
    controller = abort
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const parsed = await Promise.race([
        (async () => {
          const response = await fiatFetch(provider.url, { signal: abort.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' })
          return response.ok ? provider.parse(await response.json()) : null
        })(),
        new Promise<never>((_, reject) => {
          abort.signal.addEventListener('abort', () => reject(new Error('Fiat rate request aborted')), { once: true })
          timeout = setTimeout(() => abort.abort(), TIMEOUT_MS)
        }),
      ])
      if (!parsed) continue
      if (!settings.enabled || abort.signal.aborted) return
      failedAt = null
      const next: FiatRates = { v: 1, source: provider.source, fetchedAt: Date.now(), rates: parsed }
      applyRates(next)
      write(FIAT_RATES_KEY, next)
      return
    } catch { /* Offline, malformed responses and timeouts try the next provider. */ }
    finally { clearTimeout(timeout); if (controller === abort) controller = null }
  }
  if (settings.enabled) failedAt = Date.now()
}

function refresh(): void {
  if (!initialized || !settings.enabled || rateListeners.size === 0 || document.hidden || inFlight) return
  const cached = readRates()
  if (cached && (!rates || cached.fetchedAt > rates.fetchedAt)) applyRates(cached)
  if (rates && Date.now() - rates.fetchedAt >= USABLE_MS) applyRates(null)
  if (rates && Date.now() - rates.fetchedAt < FRESH_MS) return
  if (failedAt !== null && Date.now() - failedAt < BACKOFF_MS) return
  inFlight = fetchRates().catch(() => { failedAt = Date.now() }).finally(() => { inFlight = null })
}

/** All tests install a rejecting fetcher; individual tests supply local response fixtures. */
export function __setFiatFetchForTests(fetcher: typeof fetch): void { fiatFetch = fetcher }
