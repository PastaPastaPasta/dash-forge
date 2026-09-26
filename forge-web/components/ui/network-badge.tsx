/**
 * Network badge + "not deployed" state — both driven by the build's network config.
 *
 *   - NetworkBadge: which network this build reads and writes. Shown in the header whenever
 *     the network is not mainnet: a devnet as `devnet · <name>` in the caution color
 *     (resettable, test funds only), and in the caution color too when forge-v2 is not
 *     deployed on the network.
 *   - NotDeployedState: the one honest state for a network without forge-v2 — never a
 *     silent fallback to another network's contracts.
 */

import { AlertTriangle } from 'lucide-react'
import { ACTIVE_NETWORK, NotDeployedError, type NetworkConfig } from '@/lib/constants'
import { cn } from '@/lib/utils'

/** Whether Dash Forge (the forge-v2 contracts) is deployed on the network. */
export function isForgeDeployed(config: NetworkConfig = ACTIVE_NETWORK): boolean {
  return config.v2 !== null
}

/** The badge label: `devnet · moutai`, `testnet`, `mainnet`. */
export function networkLabel(config: NetworkConfig = ACTIVE_NETWORK): string {
  return config.network === 'devnet' && config.devnetName !== null
    ? `devnet · ${config.devnetName}`
    : config.network
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
  const deployed = isForgeDeployed(config)
  const devnet = config.network === 'devnet'
  const where = devnet
    ? `Connected to devnet ${config.devnetName ?? ''}, a development network that can be reset at any time; its funds are test funds only.`
    : `Connected to ${config.key}.`
  const title = deployed
    ? `${where} forge-core ${config.v2?.core}, forge-collab ${config.v2?.collab}.`
    : `${where} Dash Forge is not deployed on this network.`
  return (
    <span
      title={title}
      data-testid="network-badge"
      className={cn(
        'whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[11px] uppercase',
        devnet || !deployed ? 'bg-caution/10 text-caution' : 'bg-dash/10 text-dash-600 dark:text-dash-400',
        className,
      )}
    >
      {networkLabel(config)}
      {deployed ? null : <span className="normal-case"> · not deployed</span>}
    </span>
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
        Dash Forge is not deployed on {config.key}
      </h3>
      <p className="mt-1.5 max-w-md text-dense text-anvil-600 dark:text-anvil-300">
        {new NotDeployedError(config.key).message}. Nothing here is read from another network.
      </p>
    </div>
  )
}
