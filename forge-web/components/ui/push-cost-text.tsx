import { PUSH_COST_DASH, dashRange } from '@/lib/sdk/cost'
import { FiatNote } from './fiat-note'

/** The sign-in and funding copy, with each storage choice priced separately. */
export function PushCostText(): JSX.Element {
  return (
    <>{dashRange(PUSH_COST_DASH.byo)} DASH per push with your own storage<FiatNote dash={PUSH_COST_DASH.byo.max} range={PUSH_COST_DASH.byo.min} />, up to {PUSH_COST_DASH.platform.max}<FiatNote dash={PUSH_COST_DASH.platform.max} kind="bound" /> with packs on Platform, plus ~{PUSH_COST_DASH.perMib} DASH per MiB<FiatNote dash={PUSH_COST_DASH.perMib} /> of code stored on Platform (permanent)
    </>
  )
}

export function PushStorageHint(): JSX.Element {
  return <>Pushing code? Add your own storage first, or deposit about {PUSH_COST_DASH.perMib.toFixed(1)} DASH per MiB<FiatNote dash={Number(PUSH_COST_DASH.perMib.toFixed(1))} />.</>
}
