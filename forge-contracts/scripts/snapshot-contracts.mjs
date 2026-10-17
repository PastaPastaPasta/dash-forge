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
//   node scripts/snapshot-contracts.mjs [--network devnet|testnet|mainnet --devnet-name sakura]
//   node scripts/snapshot-contracts.mjs --network testnet --record <scratch record> --out <snapshot file>
//
// A record that is not complete (a contract still `broadcasting`, no contract group) is refused:
// a snapshot of half a deployment would seed a web build that cannot use it. Only a devnet passes
// its recorded DAPI addresses to the SDK; testnet and mainnet use SDK discovery (the recorded list
// of a testnet can include a node that is stuck on an older Platform version). --record <file>
// --out <file> snapshots a scratch registration (the rehearsal set) without touching the committed
// snapshots: --out is then required and must be outside forge-contracts/deployments/.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEPENDENT_CONTRACTS, META_CONTRACT, depPath, isUnder, loadEvoSdk, writeDep } from './deploy-v2.mjs';

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
  // (forge-meta only on a four-contract deployment, DESIGN rev 4.1 D44)
  const ids = [DPNS_CONTRACT_ID, dep.v2?.forgeCore?.contractId, ...[...DEPENDENT_CONTRACTS, META_CONTRACT].map((c) => dep.v2?.[c.key]?.contractId), dep.keyExchange?.contractId];
  return [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
}

/**
 * Why a record cannot be snapshotted (null when it can): every contract it records must be
 * registered and a contract group recorded, the rule forge-web's `forgeV2Ids` applies. forge-core
 * and forge-collab are always required; forge-community and forge-meta only when recorded.
 */
export function incompleteReason(dep) {
  if (!dep?.v2) return 'records no forge-v2 contracts';
  for (const [key, required] of [['forgeCore', true], ['forgeCollab', true], ['forgeCommunity', false], ['forgeMeta', false]]) {
    const r = dep.v2[key];
    if (r === undefined) {
      if (required) return `${key} is not recorded`;
      continue;
    }
    if (r.status !== 'registered' || !r.contractId) return `${key} is ${r.status ?? 'not registered'}`;
  }
  if (!dep.v2.contractGroupId) return 'records no contract group';
  return null;
}

/** The record, snapshot file and network for the arguments: the committed pair, or a scratch --record with its --out. */
export function resolveTarget(args, root = ROOT) {
  const network = args.network || 'devnet';
  if (!['devnet', 'testnet', 'mainnet'].includes(network)) throw new Error(`unknown network ${network}`);
  if (args.record === true || args.out === true) throw new Error('--record and --out each take a path');
  const devnetName = network === 'devnet' ? args['devnet-name'] || 'sakura' : undefined;
  const key = network === 'devnet' ? `devnet-${devnetName}` : network;
  const deployments = join(root, 'deployments');
  const live = depPath(network, devnetName, deployments);
  const depFile = args.record === undefined ? live : resolve(args.record);
  const scratch = depFile !== live;
  if (scratch && args.out === undefined) throw new Error(`--record ${args.record} is not the network's record: name the snapshot it writes with --out <file> (never forge-contracts/deployments/contracts/)`);
  const out = args.out === undefined ? join(deployments, 'contracts', `${key}.json`) : resolve(args.out);
  // (by real path and without case, as deploy-v2's --record check does: a symlink or a case alias must not reach the snapshots)
  if (scratch && isUnder(out, deployments)) throw new Error(`--out ${args.out}: a scratch snapshot lives outside forge-contracts/deployments/ (the committed snapshots)`);
  return { network, devnetName, key, depFile, out };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { network, devnetName, key, depFile, out } = resolveTarget(args);
  if (!existsSync(depFile)) throw new Error(`no deployment file ${depFile}`);
  const dep = JSON.parse(readFileSync(depFile, 'utf8'));
  const incomplete = incompleteReason(dep);
  if (incomplete) throw new Error(`${depFile} is a half-finished deployment (${incomplete}); finish deploy-v2 first`);
  const ids = snapshotIds(dep);
  // only a devnet has no discovery: testnet and mainnet find their nodes themselves
  const addresses = network === 'devnet' ? dep.dapiAddresses ?? dep.v2?.devnet?.addresses : undefined;

  const { EvoSDK } = await loadEvoSdk();
  const sdk = new EvoSDK({ network, trusted: true, devnetName, ...(addresses ? { addresses } : {}) });
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
  writeDep(out, snapshot);
  console.error(`wrote ${ids.length} contracts (platform version ${platformVersion}) to ${out}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(`ERROR: ${e?.message || e}`);
    process.exit(1);
  });
}
