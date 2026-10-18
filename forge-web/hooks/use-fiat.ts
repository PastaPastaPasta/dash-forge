'use client'

import { useSyncExternalStore } from 'react'
import {
  getFiatRates, getFiatSettings, getServerFiatRates, getServerFiatSettings,
  subscribeFiatRates, subscribeFiatSettings,
} from '@/lib/fiat/store'

const noSubscribe = (): (() => void) => () => {}

export function useFiatSettings() {
  return useSyncExternalStore(subscribeFiatSettings, getFiatSettings, getServerFiatSettings)
}

export function useFiat(eligible = true) {
  const settings = useFiatSettings()
  const rates = useSyncExternalStore(settings.enabled && eligible ? subscribeFiatRates : noSubscribe, getFiatRates, getServerFiatRates)
  return { settings, rates, rate: settings.enabled && eligible ? rates?.rates[settings.currency] : undefined }
}
