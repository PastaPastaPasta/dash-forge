'use client'

import { useFiat } from '@/hooks/use-fiat'
import currencies from '@/lib/fiat/currencies.json'
import { fiatText } from '@/lib/fiat/format'
import { isCurrency } from '@/lib/fiat/providers'
import { setFiatSettings } from '@/lib/fiat/store'

export function PricesPanel(): JSX.Element {
  const { settings, rates, rate } = useFiat()
  const price = fiatText(1, { network: 'mainnet', rate, currency: settings.currency })
  const minutes = rates ? Math.max(0, Math.floor((Date.now() - rates.fetchedAt) / 60_000)) : 0
  const age = minutes === 0 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`
  return (
    <div className="space-y-3 text-dense">
      <label className="flex items-center gap-2 coarse:min-h-11">
        <input type="checkbox" checked={settings.enabled} onChange={(e) => setFiatSettings({ enabled: e.target.checked })} data-testid="fiat-enabled" />
        Show amounts in my currency beside DASH
      </label>
      <label className="flex flex-wrap items-center gap-2">
        Currency
        <select value={settings.currency} onChange={(e) => { if (isCurrency(e.target.value)) setFiatSettings({ currency: e.target.value }) }} data-testid="fiat-currency" className="rounded-md border border-anvil-300 bg-white px-3 py-2 dark:border-anvil-700 dark:bg-anvil-950 coarse:min-h-11">
          {Object.keys(currencies).map((code) => <option key={code} value={code}>{code}</option>)}
        </select>
      </label>
      <p data-testid="fiat-provenance" className="text-[12px] text-anvil-500 dark:text-anvil-400">
        {price && rates ? `1 DASH ${price} · from ${rates.source === 'ctx' ? 'CTX' : 'CoinGecko'} · updated ${age}` : 'unavailable right now'}
      </p>
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
        Prices from <a href="https://ctx.com/" target="_blank" rel="noreferrer noopener" className="underline">CTX</a>, with CoinGecko as a fallback.{' '}
        <a href="https://www.coingecko.com/" target="_blank" rel="noreferrer noopener" className="underline">Data provided by CoinGecko</a>.
        {' '}Estimates use today&apos;s price. These providers see your IP address, standard browser headers and that the request comes from this site. Turn prices off above to stop requests.
      </p>
    </div>
  )
}
