#!/usr/bin/env node
// Snapshot the contracts a web build reads into forge-contracts/deployments/contracts/<key>.json.
//
// forge-web seeds evo-sdk's contract cache from this file (`contracts.addKnown`), so a page
// needs no `getDataContract` request before its first query (platform-parity-spec §3.4). The
// SDK persists fetched contracts only on mainnet and testnet, so without a snapshot every
// devnet page load fetched DPNS, forge-core and forge-collab again.
//
// The file maps contract id -> { version, platformVersion, bytes }: the contract's own version,
// the platform version the bytes were serialized with, and the Platform-serialized bytes
// (base64). The contracts come from one proved `getDataContracts` request.
//
// Re-run after deploy-v2.mjs registers new contracts. `lib/sdk/contract-seed.test.ts` in
// forge-web fails while the snapshot and the deployment file disagree.
//
//   node scripts/snapshot-contracts.mjs [--network devnet --devnet-name bonsia]
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEPENDENT_CONTRACTS, loadEvoSdk, writeDep } from './deploy-v2.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
/** The DPNS system contract: the same id on every network (rs-dpp `dpns_contract::ID_BYTES`). */
const DPNS_CONTRACT_ID = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    out[argv[i].slice(2)] = next !== undefined && !next.startsWith('--') ? argv[++i] : true;
  }
  return out;
}

/** The contract ids a web build of this deployment reads. */
export function snapshotIds(dep) {
  const ids = [DPNS_CONTRACT_ID, dep.v2?.forgeCore?.contractId, ...DEPENDENT_CONTRACTS.map((c) => dep.v2?.[c.key]?.contractId), dep.keyExchange?.contractId];
  return [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const network = args.network || 'devnet';
  const devnetName = network === 'devnet' ? args['devnet-name'] || 'bonsia' : undefined;
  const key = network === 'devnet' ? `devnet-${devnetName}` : network;
  const depFile = join(ROOT, 'deployments', `${key}.json`);
  if (!existsSync(depFile)) throw new Error(`no deployment file ${depFile}`);
  const dep = JSON.parse(readFileSync(depFile, 'utf8'));
  const ids = snapshotIds(dep);
  const addresses = dep.dapiAddresses ?? dep.v2?.devnet?.addresses;

  const { EvoSDK } = await loadEvoSdk();
  const sdk = new EvoSDK({ network, trusted: true, devnetName, addresses });
  await sdk.connect();
  const platformVersion = sdk.version();
  const contracts = await sdk.contracts.getMany(ids);

  const snapshot = {};
  for (const id of ids) {
    const contract = contracts.get(id);
    if (!contract) throw new Error(`${id} is not on ${key}`);
    snapshot[id] = {
      version: contract.version,
      platformVersion,
      bytes: Buffer.from(contract.toBytes(platformVersion)).toString('base64'),
    };
  }
  const out = join(ROOT, 'deployments', 'contracts', `${key}.json`);
  writeDep(out, snapshot);
  console.error(`wrote ${ids.length} contracts (platform version ${platformVersion}) to ${out}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(`ERROR: ${e?.message || e}`);
    process.exit(1);
  });
}
