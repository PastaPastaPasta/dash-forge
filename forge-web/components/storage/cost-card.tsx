/**
 * The cost comparison card of the storage wizard (`ux-dx-spec.md` §3.1 step 5), always
 * visible: what a repo costs with its packs in your bucket versus on Platform. Platform fees
 * are the measured per-push manifest + ref costs; bucket prices are the providers' public
 * list prices, rounded, and say so.
 */

import { BYO_PUSH_DASH as PER_PUSH_DASH, CREDITS_PER_DASH, estimateChunkCredits } from '@/lib/sdk/cost'
import { dashToUsd, formatDash } from '@/lib/view/format'
import { ScrollRegion } from '@/components/ui/scroll-region'

const MIB = 1024 * 1024

export function CostCard(): JSX.Element {
  const platform50 = estimateChunkCredits(50 * MIB) / CREDITS_PER_DASH
  const perMib = estimateChunkCredits(MIB) / CREDITS_PER_DASH
  const pushes = PER_PUSH_DASH * 10
  const rows: [string, string, string, string][] = [
    ['Your R2 bucket', `manifest + refs ≈ ${formatDash(PER_PUSH_DASH)} DASH / push`, '≈ $0.001', `≈ ${formatDash(pushes)} DASH ≈ ${dashToUsd(pushes)} + $0.00`],
    ['Your B2 / S3 bucket', 'same', '≈ $0.0003 / $0.001', `≈ ${formatDash(pushes)} DASH + < $0.01`],
    ['Dash Platform', `${formatDash(perMib)} DASH / MiB, permanent`, '0', `≈ ${formatDash(platform50)} DASH ≈ ${dashToUsd(platform50)} first upload, then ${formatDash(perMib)} DASH per pushed MiB`],
  ]
  return (
    <section aria-labelledby="cost-card-title" className="rounded-lg border border-anvil-200 bg-white p-4 dark:border-anvil-750 dark:bg-anvil-900">
      <h2 id="cost-card-title" className="mb-2 text-dense font-medium text-anvil-500 dark:text-anvil-400">
        What it costs
      </h2>
      <ScrollRegion label="Cost table" className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-left text-[12px]">
          <thead className="text-anvil-500 dark:text-anvil-400">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">Where</th>
              <th scope="col" className="py-1 pr-3 font-medium">One-time (Platform fees)</th>
              <th scope="col" className="py-1 pr-3 font-medium">Monthly</th>
              <th scope="col" className="py-1 font-medium">50 MiB repo, 10 pushes/month</th>
            </tr>
          </thead>
          <tbody className="font-mono text-anvil-700 dark:text-anvil-200">
            {rows.map(([where, once, monthly, example]) => (
              <tr key={where} className="border-t border-anvil-100 dark:border-anvil-850">
                <th scope="row" className="py-1.5 pr-3 font-sans font-medium">{where}</th>
                <td className="py-1.5 pr-3">{once}</td>
                <td className="py-1.5 pr-3">{monthly}</td>
                <td className="py-1.5">{example}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      <p className="mt-2 text-[11px] text-anvil-500 dark:text-anvil-400">
        Platform figures are estimates from measured fees; bucket prices are the providers’ list prices, rounded. USD is indicative.
      </p>
    </section>
  )
}
