// Which network and which record a live tool runs against (release plan WS-D, QA-02, QA-14).
//
// rc1-live, mv-live, rc1-empty-aggregates and rc1-fee-probe used to hard-code
// `deployments/devnet-<name>.json` and `network: 'devnet'`. They now take
//
//   --network devnet|testnet|mainnet   (default devnet)
//   --devnet-name <name>               (devnet only; default sakura; ^[a-z0-9-]+$)
//   --record <file>                    a scratch registration outside forge-contracts/deployments/
//
// and resolve the network's record the way deploy-v2.mjs does (`depPath`: devnet-<name>.json on a
// devnet, <network>.json otherwise). The production-write policy lives here, once:
//
//   - the tool's target is `--record` (a scratch registration) or, with none, the network's own
//     record in deployments/;
//   - on testnet and mainnet that record is the PRODUCTION registration, whose repos, issues and
//     keys can never be deleted. A rule suite never runs against it: `refuseProduction` throws;
//   - a "scratch" record that carries ANY id of a live registration (a contract, the contract group,
//     or a superseded one of either; testnet.json and mainnet.json both, whatever the --network) is a
//     copy of (or a splice with) the live registration, and counts as live;
//   - on testnet and mainnet a `--record` must carry the stamp deploy-v2 writes for a scratch
//     registration (`--contracts <dir> --record <file>` writes `v2.contractsDir`; a committed
//     `--set` run, the live record, writes `v2.contractsSet`). A record without it is not a scratch
//     record: a stale local copy of the live record, or an empty `{}`, would otherwise pass;
//   - a devnet's record is not production: devnets are reset and re-registered.
//   - rc1-live, rc1-empty-aggregates, rc1-fee-probe and mv-live (--live-target included) refuse
//     --network mainnet entirely for now (`refuseMainnet`): real DASH, and no mainnet plan.
//
// Pure functions over the filesystem (the deployments directory is a parameter), so the policy is
// tested offline (target.test.mjs).
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NETWORKS = ['devnet', 'testnet', 'mainnet'];
/** A network with real money and permanent documents: no rule suite runs on its live record. */
export const PRODUCTION_NETWORKS = ['testnet', 'mainnet'];
/**
 * The July-era testnet pool (DEPLOYER, TREASURY, OWNER, MAINTAINER, COLLAB, CONTRIB, FROZEN,
 * CI-RUNNER, RELAY): their keys are public (SECU-03, gap-incident GAP-09) and they predate forge-v2.
 * No tool signs as one of them on testnet or mainnet (QA-05, QA-V-05).
 */
export const JULY_POOL_IDS = new Map([
  ['8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB', 'DEPLOYER'],
  ['8igVywVvFTf8aNoaLfS9KsURfAfdHGb3gEeo3vGupZPV', 'TREASURY'],
  ['B72TJDCsaExkoET6enz6HZGvGcHiSRYupjgve9KARoGx', 'OWNER'],
  ['BESA6ZwQD2qBdA5owz6YRm95GkL46xobC4k1s8XjehtM', 'MAINTAINER'],
  ['CmGHMP2VqWZng8gtF7Nr9pPXKzmFoKpJQs4mYrCHkyVw', 'COLLAB'],
  ['6acfxhgD2c8siYVmJrHgzTE3HF5DcyU3599T4r1vPTr1', 'CONTRIB'],
  ['BSGeWyh3tQYT1p5Z7SaGpVhU4xsKzSEpQgAPZKTBmvv8', 'FROZEN'],
  ['7Tg7PXre8eQL1scWnwvXNa4jq35sbpPpXJ2NM8JxuVe3', 'CI-RUNNER'],
  ['3r5GmtjsC2terox8RgXcJh8nPsgW4vT9gT36sA9hZx15', 'RELAY'],
]);

export const DEVNET_NAME_RE = /^[a-z0-9-]+$/;
export const DEFAULT_DEVNET_NAME = 'sakura';
export const DEFAULT_DEPLOYMENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'deployments');

export function validateNetwork(network) {
  if (!NETWORKS.includes(network)) throw new Error(`--network accepts ${NETWORKS.join(', ')}, got ${JSON.stringify(network)}`);
  return network;
}

/** A devnet name becomes part of a file name: letters, digits and hyphens only. */
export function validateDevnetName(name) {
  if (typeof name !== 'string' || !DEVNET_NAME_RE.test(name)) {
    throw new Error(`--devnet-name must match ${DEVNET_NAME_RE} (lower-case letters, digits, hyphens), got ${JSON.stringify(name)}`);
  }
  return name;
}

/** deployments/<network>.json, or deployments/devnet-<name>.json: deploy-v2.mjs's depPath. */
export function liveRecordPath(deploymentsDir, network, devnetName) {
  return join(deploymentsDir, `${network === 'devnet' ? `devnet-${devnetName}` : network}.json`);
}

/** A path with its deepest existing directory resolved (symlinks) and folded to lower case (APFS and NTFS fold case). */
export function canonical(path) {
  let dir = dirname(path);
  const rest = [basename(path)];
  while (!existsSync(dir) && dirname(dir) !== dir) {
    rest.unshift(basename(dir));
    dir = dirname(dir);
  }
  return join(existsSync(dir) ? realpathSync(dir) : dir, ...rest).toLowerCase();
}
export const isUnderDir = (path, dir) => canonical(resolve(path)).startsWith(`${canonical(dir)}${sep}`);

/** The records deploy-v2 keeps a retired registration under: `v2.<key>Superseded` (a list of the old entries). */
export const SUPERSEDED_KEYS = ['forgeCoreSuperseded', 'forgeCollabSuperseded', 'forgeCommunitySuperseded', 'forgeMetaSuperseded', 'contractGroupSuperseded'];
/**
 * Every id that identifies a registered set: its contracts (core, collab, community, meta), every
 * place a record may name its contract group (`v2.contractGroupId`, `v2.contractGroup.id`,
 * `v2.forgeCore.contractGroupId`), and the same in each superseded entry (a retired contract or
 * group is still part of the registration's history and is still readable).
 */
export function setIds(rec) {
  const v2 = rec?.v2 ?? {};
  const ids = [v2.forgeCore, v2.forgeCollab, v2.forgeCommunity, v2.forgeMeta].flatMap((c) => [c?.contractId, c?.contractGroupId]);
  ids.push(v2.contractGroupId, v2.contractGroup?.id);
  for (const key of SUPERSEDED_KEYS) {
    for (const old of Array.isArray(v2[key]) ? v2[key] : []) ids.push(old?.contractId, old?.contractGroupId, old?.id);
  }
  return ids.filter((id) => typeof id === 'string' && id !== '');
}
/** True when `rec` names any contract or the contract group of `live`: a copy of (or a splice with) the live registration. */
export function sharesLiveSet(rec, live) {
  const theirs = new Set(setIds(live));
  return setIds(rec).some((id) => theirs.has(id));
}
/**
 * The production registration (deployments/testnet.json or mainnet.json, whichever the network)
 * that `rec` shares an id with, as `{ network, file }`; null when none. Every production record is
 * compared, not just the target network's: a mainnet copy passed as `--network testnet --record`
 * is still the live mainnet registration.
 */
export function productionOverlap(rec, deploymentsDir = DEFAULT_DEPLOYMENTS_DIR) {
  for (const network of PRODUCTION_NETWORKS) {
    const file = liveRecordPath(deploymentsDir, network);
    if (!existsSync(file)) continue;
    if (sharesLiveSet(rec, readJson(file, `the ${network} record`))) return { network, file };
  }
  return null;
}
/** A four-contract record (forge-meta registered): the mainnet-set layout. */
export const isFourContract = (rec) => Boolean(rec?.v2?.forgeMeta?.contractId);

/**
 * Why `rec` is not a scratch registration, or null when it is. deploy-v2 stamps a scratch run
 * (`--contracts <dir> --record <file>`) with `v2.contractsDir` and a committed-set run (the live
 * record) with `v2.contractsSet`. A record without the first, or with the second, was not written
 * by a scratch run.
 */
export function scratchStampError(rec) {
  const v2 = rec?.v2;
  if (v2?.contractsSet !== undefined) return `it carries v2.contractsSet (${JSON.stringify(v2.contractsSet)}): the stamp of a committed-set run, i.e. a live registration`;
  if (typeof v2?.contractsDir !== 'string' || v2.contractsDir === '') return 'it has no v2.contractsDir, the stamp `deploy-v2.mjs --contracts <dir> --record <file>` writes';
  return null;
}

export function readJson(file, what) {
  if (!existsSync(file)) throw new Error(`${what} ${file} does not exist`);
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${what} ${file} is not JSON: ${e.message}`);
  }
}

/**
 * Resolve the target of a live tool from its parsed `--` arguments.
 *
 * @param {object} args  parsed flags: network, devnet-name, record, live-target
 * @param {object} [opts]
 * @param {string} [opts.deploymentsDir]
 * @param {boolean} [opts.liveTargetFlag]  the tool has a `--live-target` mode: the record is then the
 *        network's own registration (no `--record`), and the tool owns what it may do there
 * @returns {{network, devnetName, label, liveFile, live, recordFile, record, scratch, liveTarget, copiesLive, overlap, production, fourContract}}
 *          `production` is true when the record is a testnet or mainnet LIVE registration (or a copy)
 */
export function resolveTarget(args, { deploymentsDir = DEFAULT_DEPLOYMENTS_DIR, liveTargetFlag = false } = {}) {
  if (args.network === true) throw new Error(`--network takes ${NETWORKS.join('|')}`);
  const network = validateNetwork(args.network === undefined ? 'devnet' : String(args.network));
  if (args['devnet-name'] === true) throw new Error('--devnet-name takes a name');
  if (network !== 'devnet' && args['devnet-name'] !== undefined) {
    throw new Error(`--devnet-name only applies to --network devnet (got --network ${network})`);
  }
  const devnetName = network === 'devnet' ? validateDevnetName(args['devnet-name'] === undefined ? DEFAULT_DEVNET_NAME : String(args['devnet-name'])) : undefined;
  if (args.record === true) throw new Error('--record takes a path');
  const liveTarget = liveTargetFlag && Boolean(args['live-target']);
  if (!liveTargetFlag && args['live-target'] !== undefined) throw new Error('--live-target is not an option of this tool');
  if (liveTarget && args.record !== undefined) {
    throw new Error("--live-target targets the network's own registration in forge-contracts/deployments/: drop --record");
  }

  const label = network === 'devnet' ? `devnet-${devnetName}` : network;
  const liveFile = liveRecordPath(deploymentsDir, network, devnetName);
  const live = readJson(liveFile, `the ${label} record`);

  let recordFile = liveFile;
  let record = live;
  let scratch = false;
  if (args.record !== undefined) {
    recordFile = resolve(String(args.record));
    if (isUnderDir(recordFile, deploymentsDir)) {
      throw new Error(`--record ${args.record}: a scratch record lives outside forge-contracts/deployments/ (the networks' records and snapshots)`);
    }
    record = readJson(recordFile, '--record');
    scratch = true;
    if (record.network !== undefined && record.network !== network) {
      throw new Error(`--record ${args.record} records network ${record.network}, not ${network}`);
    }
    if (devnetName !== undefined && record.devnetName !== undefined && record.devnetName !== devnetName) {
      throw new Error(`--record ${args.record} records devnet ${record.devnetName}, not ${devnetName}`);
    }
    if (PRODUCTION_NETWORKS.includes(network)) {
      const why = scratchStampError(record);
      if (why) {
        throw new Error(
          `--record ${args.record} is not a scratch record: ${why}. On ${network} a scratch registration is made with ` +
            `\`deploy-v2.mjs --network ${network} --contracts <dir> --record <scratch.json>\`; a copy of ${liveFile} is the live registration.`,
        );
      }
    }
  }
  // A scratch record that carries any id of the network's own registration, or of either production
  // registration, is a live registration under another name
  const copiesLive = scratch && sharesLiveSet(record, live);
  const overlap = scratch ? productionOverlap(record, deploymentsDir) : null;
  const production = (PRODUCTION_NETWORKS.includes(network) && (!scratch || copiesLive)) || overlap !== null;
  return { network, devnetName, label, liveFile, live, recordFile, record, scratch, liveTarget, copiesLive, overlap, production, fourContract: isFourContract(record) };
}

/**
 * Refuse a rule suite on the live registration of testnet or mainnet (QA-14): its documents are
 * permanent and public. Rule suites run on a scratch registration (`--record <file>`). `hint` is
 * appended for a tool with a narrower sanctioned mode (mv-live's --live-target).
 */
export function refuseProduction(target, hint = '') {
  if (!target.production) return;
  const what = target.overlap
    ? `${target.recordFile} carries an id of the live ${target.overlap.network} registration (a copy of, or a splice with, ${target.overlap.file})`
    : target.copiesLive
      ? `${target.recordFile} carries an id of the live ${target.network} registration (a copy of, or a splice with, ${target.liveFile})`
      : `${target.liveFile} is the live ${target.network} registration`;
  throw new Error(
    `refusing to run against a live registration: ${what}. Repos, issues, keys and packs written there can never be deleted. ` +
      'Rule suites run only on a scratch registration: register one outside deployments/ ' +
      `(\`python3 forge-contracts/schema/build.py --mainnet --out <dir>\`, then \`deploy-v2.mjs --network ${target.network} --contracts <dir> --record <scratch.json>\`) ` +
      `and pass \`--record <scratch.json>\`.${hint ? ` ${hint}` : ''}`,
  );
}

/**
 * rc1-live, rc1-empty-aggregates, rc1-fee-probe and mv-live (--live-target included) refuse mainnet
 * for now: there is no mainnet plan for them, and a mainnet write spends real DASH and is permanent.
 * `network` is the parsed --network value.
 */
export function refuseMainnet(network, tool) {
  if (network === 'mainnet') {
    throw new Error(`--network mainnet is not supported for ${tool}: there is no mainnet plan for it yet, and a mainnet write spends real DASH and is permanent (use --network devnet|testnet with a scratch --record)`);
  }
}

/**
 * fees2's `--baseline` must be a scratch registration other than the one under test: not a file of
 * deployments/, stamped as scratch on testnet/mainnet, and sharing no id with the live registration
 * of this network, either production registration, or the set under test.
 */
export function assertScratchBaseline(baselineFile, baseline, target, { deploymentsDir = DEFAULT_DEPLOYMENTS_DIR } = {}) {
  if (isUnderDir(baselineFile, deploymentsDir)) throw new Error(`--baseline ${baselineFile} must be a scratch record outside forge-contracts/deployments/`);
  if (PRODUCTION_NETWORKS.includes(target.network)) {
    const why = scratchStampError(baseline);
    if (why) throw new Error(`--baseline ${baselineFile} is not a scratch record: ${why}`);
  }
  if (sharesLiveSet(baseline, target.live)) throw new Error(`--baseline ${baselineFile} carries an id of the live ${target.label} registration (${target.liveFile})`);
  const overlap = productionOverlap(baseline, deploymentsDir);
  if (overlap) throw new Error(`--baseline ${baselineFile} carries an id of the live ${overlap.network} registration (${overlap.file})`);
  if (sharesLiveSet(baseline, target.record)) throw new Error(`--baseline ${baselineFile} shares an id with the set under test (${target.recordFile}): it must be another scratch set`);
}

/** The DAPI addresses to connect to: --addresses, else (devnets only) the record's, else the network's. Testnet and mainnet use SDK discovery. */
export function addressesFor(target, args) {
  if (typeof args.addresses === 'string') return args.addresses.split(',').map((s) => s.trim()).filter(Boolean);
  if (target.network !== 'devnet') return undefined;
  return target.record.dapiAddresses ?? target.live.dapiAddresses ?? target.record.v2?.devnet?.addresses ?? target.live.v2?.devnet?.addresses;
}

/** The EvoSDK constructor options for the target (a devnet names itself and its addresses; testnet and mainnet discover them). */
export function sdkOptions(target, { addresses, settings } = {}) {
  const options = { network: target.network, trusted: true };
  if (target.devnetName) options.devnetName = target.devnetName;
  if (addresses && addresses.length > 0) options.addresses = addresses;
  if (settings) options.settings = settings;
  return options;
}

/**
 * The forge-v2 contract ids a record names, by contract: core, collab and community, and meta on a
 * four-contract record (forge-meta, the mainnet set). Throws when one of the three is missing, or a
 * forge-meta entry has no id (a half-finished deploy). rc1-live and rc1-empty-aggregates route each
 * document type by what the fetched contracts declare, so either layout works (QA-03).
 */
export function contractIds(target) {
  const v2 = target.record?.v2 ?? {};
  const ids = { core: v2.forgeCore?.contractId, collab: v2.forgeCollab?.contractId, community: v2.forgeCommunity?.contractId };
  if (!ids.core || !ids.collab || !ids.community) throw new Error(`${target.recordFile} records no forge-v2 contracts (forge-core, forge-collab and forge-community under v2)`);
  if (v2.forgeMeta !== undefined) {
    if (!v2.forgeMeta?.contractId) throw new Error(`${target.recordFile} records forge-meta without a contract id: a half-finished deploy`);
    ids.meta = v2.forgeMeta.contractId;
  }
  return ids;
}

/**
 * Reject what the scripts' inline `--flag value` reducer would silently misread: `--network=testnet`
 * (read as a flag named `network=testnet`, so the run falls back to devnet), a value for a bare flag
 * (`--live-target false` is still on), a flag with no value, a positional word and a flag the tool
 * does not have. `values` take one value, `bools` take none.
 */
export function checkFlags(argv, { values = [], bools = [] }) {
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(t)}`);
    if (t.includes('=')) throw new Error(`write ${t.split('=')[0]} ${JSON.stringify(t.slice(t.indexOf('=') + 1))} with a space, not '='`);
    const name = t.slice(2);
    const next = argv[i + 1];
    const hasValue = next !== undefined && !next.startsWith('--');
    if (bools.includes(name)) {
      if (hasValue) throw new Error(`--${name} takes no value (got ${JSON.stringify(next)})`);
    } else if (values.includes(name)) {
      if (!hasValue) throw new Error(`--${name} takes a value`);
      i++;
    } else {
      throw new Error(`unknown option ${t}`);
    }
  }
}

/** Refuse a July-era identity on testnet or mainnet (a devnet never held them). */
export function assertNotJulyIdentity(target, identityId, where) {
  if (target.network === 'devnet') return;
  const role = JULY_POOL_IDS.get(String(identityId));
  if (role) {
    throw new Error(`${where}: identity ${identityId} is the July-era testnet ${role}, whose keys are public; mint a fresh identity (QA-05, QA-V-05)`);
  }
}
