import { PUSH_COST_DASH, dashRange } from '@/lib/sdk/cost'
import type { Network } from '@/lib/constants'
import { FiatNote } from './fiat-note'

/** The range every summary quotes for a small push: own storage at the low end, packs on Platform at the high end. */
const SMALL_PUSH_DASH = { min: PUSH_COST_DASH.byo.min, max: PUSH_COST_DASH.platform.max } as const

/** The sign-in and funding copy, with each storage choice priced separately. */
export function PushCostText(): JSX.Element {
  return (
    <>{dashRange(PUSH_COST_DASH.byo)} DASH per push with your own storage<FiatNote dash={PUSH_COST_DASH.byo.max} range={PUSH_COST_DASH.byo.min} />, up to {PUSH_COST_DASH.platform.max}<FiatNote dash={PUSH_COST_DASH.platform.max} kind="bound" /> with packs on Platform, plus ~{PUSH_COST_DASH.perMib} DASH per MiB<FiatNote dash={PUSH_COST_DASH.perMib} /> of code stored on Platform (permanent). Each push shows its own estimate first, often above the charge
    </>
  )
}

/** One range for a small push, where a page has room for a single figure (the landing page). */
export function PushCostShort({ network }: { network: Network }): JSX.Element {
  return (
    <>a small push {SMALL_PUSH_DASH.min}{'–\u2060'}{SMALL_PUSH_DASH.max} DASH<FiatNote dash={SMALL_PUSH_DASH.max} range={SMALL_PUSH_DASH.min} network={network} /></>
  )
}

export function PushStorageHint(): JSX.Element {
  return <>Pushing code? Add your own storage first, or deposit about {PUSH_COST_DASH.perMib.toFixed(1)} DASH per MiB<FiatNote dash={Number(PUSH_COST_DASH.perMib.toFixed(1))} />.</>
}
