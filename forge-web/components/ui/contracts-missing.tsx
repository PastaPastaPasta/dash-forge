'use client'

/**
 * "This build's contracts are not on the network": the network answered a read with "contract
 * not found" (`lib/sdk/contract-missing.ts`). On a devnet that means it was reset and Dash Forge
 * has not been deployed on it again yet; anywhere else, that this build names contracts its
 * network does not have. No retry can fix either, so this state offers none as its main action:
 * a reload picks up a new build once one is published. The raw error stays behind Details.
 *
 * Detected once, app-wide (`useContractsMissing` in hooks/use-sdk.ts): the app shell shows this
 * state in place of the page instead of each view failing with its own read error.
 *
 * devnet moutai is a special case, not a generic reset: it was upgraded in place to Platform
 * v4.2.0-beta.7, which retired every contract this build reads, and the forge is moving to a new
 * devnet (bonsia) rather than being redeployed on moutai. This is gated on the same detected
 * condition — devnet moutai's contracts missing — not a hard-coded date, so it stops matching on
 * its own once bonsia becomes the default network.
 */

import { Unplug } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ACTIVE_NETWORK, type NetworkConfig } from '@/lib/constants'

/** The network as a person reads it: `devnet moutai`, `testnet`, `mainnet`. */
function networkName(config: NetworkConfig): string {
  return config.network === 'devnet' && config.devnetName !== null ? `devnet ${config.devnetName}` : config.network
}

export function ContractsMissingState({
  detail,
  config = ACTIVE_NETWORK,
}: {
  /** The raw error, shown only under Details. */
  detail: string
  config?: NetworkConfig
}): JSX.Element {
  const devnet = config.network === 'devnet'
  const where = networkName(config)
  const movingToBonsia = devnet && config.devnetName === 'moutai'
  return (
    <div
      role="alert"
      data-testid="contracts-missing"
      className="mx-auto flex max-w-2xl flex-col items-center justify-center rounded-lg border border-caution/30 bg-caution/5 px-6 py-10 text-center"
    >
      <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-caution/10 text-caution-700 dark:text-caution-400">
        <Unplug className="h-5 w-5" aria-hidden />
      </span>
      <h2 className="text-prose font-medium text-anvil-900 dark:text-anvil-50">
        {movingToBonsia
          ? 'Dash Forge is moving to a new devnet'
          : devnet
            ? `Dash Forge isn't deployed on ${where} right now`
            : `This build's contracts were not found on ${where}`}
      </h2>
      <p className="mt-1.5 max-w-md text-dense text-anvil-600 dark:text-anvil-300">
        {movingToBonsia
          ? 'Devnet moutai was upgraded to Platform v4.2.0-beta.7, which retired the old contracts. The forge is being re-registered on devnet bonsia with a new contract design; repos will be back shortly.'
          : devnet
            ? `${where} is a development network, and devnets are reset from time to time. This one was most likely reset, so the contracts Dash Forge reads are gone until it is redeployed. This page works again once a build with the new contracts is published.`
            : `${where} has no contracts with the ids this build reads, so nothing can be read here. The build may be misconfigured or made for another network.`}
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
        <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
          Reload for a newer build
        </Button>
        <a
          href="https://github.com/PastaPastaPasta/dash-forge#readme"
          className="text-dense text-forge-700 underline dark:text-forge-400"
        >
          Dash Forge on GitHub
        </a>
      </div>
      <details className="mt-4 w-full max-w-md text-left text-dense text-anvil-600 dark:text-anvil-300">
        <summary className="w-fit cursor-pointer coarse:-mx-2 coarse:flex coarse:min-h-11 coarse:min-w-11 coarse:items-center coarse:px-2">
          Details
        </summary>
        <div className="mt-1 space-y-1 break-words font-mono text-[12px]">
          {config.v2 !== null ? (
            <p>
              This build reads forge-core {config.v2.core} and forge-collab {config.v2.collab} on {config.key}.
            </p>
          ) : null}
          <p>{detail}</p>
        </div>
      </details>
    </div>
  )
}
