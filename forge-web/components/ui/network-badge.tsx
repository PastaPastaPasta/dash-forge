/**
 * Network badge + "not deployed" state — both driven by the build's network config.
 *
 *   - NetworkBadge: which network this build reads and writes. Shown in the header whenever
 *     the network is not mainnet, in the caution color when it is a devnet (resettable,
 *     test-only funds) and when no Dash Forge registry exists on it.
 *   - NotDeployedState: the one honest state for a network with no registry — never a
 *     silent fallback to another network's contracts.
 */

import { AlertTriangle } from 'lucide-react'
import { ACTIVE_NETWORK, NotDeployedError, type NetworkConfig } from '@/lib/constants'
import { cn } from '@/lib/utils'

/** Whether the active network has a v1 Dash Forge registry to read from. */
export function isRegistryDeployed(config: NetworkConfig = ACTIVE_NETWORK): boolean {
  return config.registryContractId !== null
}

/** Whether the active network has the forge-v2 contracts (protocol 14). */
export function isV2Deployed(config: NetworkConfig = ACTIVE_NETWORK): boolean {
  return config.v2 !== null
}

/** Whether there is anything Dash Forge to read here: a v1 registry, forge-v2, or both. */
export function isForgeDeployed(config: NetworkConfig = ACTIVE_NETWORK): boolean {
  return isRegistryDeployed(config) || isV2Deployed(config)
}

export function NetworkBadge({
  config = ACTIVE_NETWORK,
  always = false,
  className,
}: {
  config?: NetworkConfig
  /** Show even on mainnet (settings / detail rows). The header hides it on mainnet. */
  always?: boolean
  className?: string
}): JSX.Element | null {
  if (config.network === 'mainnet' && !always) return null
  const warn = config.network === 'devnet' || !isForgeDeployed(config)
  const parts = [
    config.v2 !== null ? `forge-v2 ${config.v2.core} / ${config.v2.collab}` : 'forge-v2 not deployed',
    isRegistryDeployed(config)
      ? `v1 registry ${config.registryContractId} (${config.registrySource})`
      : 'no v1 registry',
  ]
  const title = isForgeDeployed(config)
    ? `Connected to ${config.key}. ${parts.join('; ')}.`
    : `Connected to ${config.key}. Dash Forge is not deployed on this network.`
  return (
    <span
      title={title}
      data-testid="network-badge"
      className={cn(
        'rounded px-1.5 py-0.5 font-mono text-[11px] uppercase',
        warn ? 'bg-caution/10 text-caution' : 'bg-dash/10 text-dash-600 dark:text-dash-400',
        className,
      )}
    >
      {config.key}
      {isForgeDeployed(config) ? null : <span className="normal-case"> · not deployed</span>}
    </span>
  )
}

/**
 * The honest note a forge-v2 surface shows on a network without the v2 contracts (testnet
 * until protocol 14): v1 repos still read, v2 ones do not exist here yet.
 */
export function V2NotDeployedNote({ config = ACTIVE_NETWORK }: { config?: NetworkConfig }): JSX.Element {
  return (
    <p role="note" className="flex items-start gap-2 rounded-md border border-caution/30 bg-caution/5 px-3 py-2 text-dense text-anvil-700 dark:text-anvil-200">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-caution" aria-hidden />
      <span>
        forge-v2 is not deployed on {config.key} yet (it needs Platform protocol 14). The repos
        below are v1 repos: readable here, with their own contracts.
      </span>
    </p>
  )
}

/** Full-width state for a view that needs Dash Forge on a network without it. */
export function NotDeployedState({ config = ACTIVE_NETWORK }: { config?: NetworkConfig }): JSX.Element {
  return (
    <div
      role="status"
      className="flex flex-col items-center justify-center rounded-lg border border-caution/30 bg-caution/5 px-6 py-10 text-center"
    >
      <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-caution/10 text-caution">
        <AlertTriangle className="h-5 w-5" aria-hidden />
      </span>
      <h3 className="text-prose text-anvil-900 dark:text-anvil-50">
        Dash Forge is not deployed on {config.key} yet
      </h3>
      <p className="mt-1.5 max-w-md text-dense text-anvil-600 dark:text-anvil-300">
        {new NotDeployedError(config.key).message}. Nothing here is read from another network.
      </p>
    </div>
  )
}
