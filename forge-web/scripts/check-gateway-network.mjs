#!/usr/bin/env node
/**
 * Refuse to build the web app for one network with a forge-gateway that serves another. The build
 * bakes `NEXT_PUBLIC_GATEWAY_URL` into every public repository's clone box and share link, and a
 * gateway resolves `owner/name` on its own network: a mainnet build left with the testnet gateway
 * would hand out `git clone https://…/alice/project.git` lines that fetch testnet's alice/project.
 *
 * The gateway names its network in `GET /readyz` (`"network": "testnet"`, the deployment key). A
 * different key fails the build. A gateway that cannot be reached, or does not say, only warns, so
 * a gateway outage does not hold up a Pages deploy.
 *
 * Usage (the build's environment): node scripts/check-gateway-network.mjs
 */

import { fileURLToPath } from 'node:url'

/** The deployment key a build targets, as lib/constants.ts resolves it: `testnet`, `mainnet`, `devnet-<name>`. */
export function buildNetworkKey(env) {
  const devnet = env.NEXT_PUBLIC_DEVNET_NAME?.trim() || ''
  const kind = (env.NEXT_PUBLIC_NETWORK?.trim() || (devnet ? 'devnet' : 'testnet')).toLowerCase()
  return kind === 'devnet' ? `devnet-${devnet}` : kind
}

/** `{ level: 'ok' | 'warning' | 'error', message }` for the build `env`. */
export async function checkGatewayNetwork(env, fetchImpl = fetch) {
  const url = env.NEXT_PUBLIC_GATEWAY_URL?.trim().replace(/\/+$/, '') || ''
  if (url === '') return { level: 'ok', message: 'no gateway configured' }
  const want = buildNetworkKey(env)
  let network
  try {
    const res = await fetchImpl(`${url}/readyz`, { signal: AbortSignal.timeout(15_000) })
    network = (await res.json())?.network
  } catch (e) {
    return { level: 'warning', message: `could not read ${url}/readyz (${e instanceof Error ? e.message : e}); the gateway's network is unchecked` }
  }
  if (typeof network !== 'string') return { level: 'warning', message: `${url}/readyz names no network; the gateway's network is unchecked` }
  if (network !== want) {
    return {
      level: 'error',
      message: `the gateway ${url} serves ${network}, but this build is for ${want}: point the site's gateway variable (PAGES_GATEWAY_URL, or TESTNET_SITE_GATEWAY_URL for the testnet site) at a ${want} gateway, or unset it`,
    }
  }
  return { level: 'ok', message: `the gateway ${url} serves ${want}` }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { level, message } = await checkGatewayNetwork(process.env)
  process.stdout.write(level === 'ok' ? `check-gateway-network: ${message}\n` : `::${level}::${message}\n`)
  if (level === 'error') process.exit(1)
}
