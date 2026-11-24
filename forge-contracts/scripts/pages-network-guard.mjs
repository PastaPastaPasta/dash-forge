#!/usr/bin/env node
// pages-network-guard.mjs -- the Pages deploy's gate on the network the hosted site serves
// (docs/launch/mainnet-runbook.md). pages.yml runs it before the build:
//
//   PAGES_BUILD_NETWORK=mainnet PAGES_EVENT=push PAGES_CONFIRM= PAGES_SITE_URL=https://forge.dashhq.org \
//     node forge-contracts/scripts/pages-network-guard.mjs
//
// A testnet or mainnet build needs that network's deployment record to be complete, so the hosted
// site can never go live on "not deployed". A deploy that changes the network the live site serves
// (its /forge-manifest.json `network`), mainnet included, runs only from a manual workflow_dispatch
// whose `confirm_network` input names the new network. A push to master that would flip it fails. A
// live site that cannot be read counts as a change, so the first deploy of a network is manual too.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { notDeployedReason } from './check-release-network.mjs';

const DEPLOYMENTS = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'deployments');

/** The build's network key as the manifest names it: `testnet`, `mainnet`, `devnet-<name>`. */
export function buildKey(network, devnetName) {
  return network === 'devnet' && devnetName ? `devnet-${devnetName}` : network;
}

/** The problems that stop this deploy ([] lets it run). */
export function guardProblems({ network, devnetName, event, confirm, liveNetwork, deploymentsDir = DEPLOYMENTS }) {
  const key = buildKey(network, devnetName);
  const problems = [];
  if (network === 'testnet' || network === 'mainnet') {
    const why = notDeployedReason(network, deploymentsDir);
    if (why) problems.push(`forge-contracts/deployments/${network}.json is not a usable deployment (${why}); register and merge the record before the site builds ${network}.`);
  }
  if (liveNetwork !== key) {
    const live = liveNetwork ? `serves ${liveNetwork}` : 'could not be read';
    if (event !== 'workflow_dispatch' || confirm !== key) {
      problems.push(
        `the live site ${live} and this build is ${key}: changing the network the site serves needs a manual run ` +
          `(Actions -> "Deploy forge-web to Pages" -> Run workflow on master, confirm_network: ${key}).`
      );
    }
  } else if (event === 'workflow_dispatch' && confirm && confirm !== key) {
    problems.push(`confirm_network is ${confirm} but this build is ${key} (PAGES_NETWORK); set the variable first.`);
  }
  return problems;
}

export async function liveNetworkOf(siteUrl, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(new URL('/forge-manifest.json', siteUrl), { signal: AbortSignal.timeout(20000), headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) return null;
    const m = await res.json();
    return typeof m?.network === 'string' ? m.network : null;
  } catch {
    return null;
  }
}

async function main(env = process.env) {
  const liveNetwork = await liveNetworkOf(env.PAGES_SITE_URL || 'https://forge.dashhq.org');
  const args = { network: env.PAGES_BUILD_NETWORK, devnetName: env.PAGES_DEVNET_NAME || null, event: env.PAGES_EVENT, confirm: env.PAGES_CONFIRM || null, liveNetwork };
  const problems = guardProblems(args);
  console.log(`live site network: ${liveNetwork ?? 'unknown'}; this build: ${buildKey(args.network, args.devnetName)}; event: ${args.event}`);
  for (const p of problems) console.log(`::error title=Pages network guard::${p}`);
  return problems.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
}
