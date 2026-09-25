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

/** Whether the active network has a Dash Forge registry to read from. */
export function isRegistryDeployed(config: NetworkConfig = ACTIVE_NETWORK): boolean {
  return config.registryContractId !== null
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
  const warn = config.network === 'devnet' || !isRegistryDeployed(config)
  const title = isRegistryDeployed(config)
    ? `Connected to ${config.key}. Registry ${config.registryContractId} (${config.registrySource}).`
    : `Connected to ${config.key}. No Dash Forge registry is deployed on this network.`
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
      {isRegistryDeployed(config) ? null : <span className="normal-case"> · not deployed</span>}
    </span>
  )
}

/** Full-width state for a view that needs the registry on a network without one. */
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
