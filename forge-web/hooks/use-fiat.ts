'use client'

import { useSyncExternalStore } from 'react'
import {
  getFiatRates, getFiatSettings, getServerFiatRates, getServerFiatSettings,
  subscribeFiatRates, subscribeFiatSettings,
} from '@/lib/fiat/store'

const noSubscribe = (): (() => void) => () => {}

/** `eligible` false keeps this note from subscribing, so it never triggers a rate fetch. */
export function useFiat(eligible = true) {
  const settings = useSyncExternalStore(subscribeFiatSettings, getFiatSettings, getServerFiatSettings)
  const active = settings.enabled && eligible
  const rates = useSyncExternalStore(active ? subscribeFiatRates : noSubscribe, getFiatRates, getServerFiatRates)
  return { settings, rates, rate: active ? rates?.rates[settings.currency] : undefined }
}
