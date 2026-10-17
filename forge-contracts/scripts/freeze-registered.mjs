#!/usr/bin/env node
// freeze-registered.mjs — freeze what a production network registered (CONT-03).
//
//   node forge-contracts/scripts/freeze-registered.mjs --network testnet|mainnet
//   node forge-contracts/scripts/freeze-registered.mjs --network testnet --record <scratch.json> --out <dir>
//
// Run at the registration commit (P4): for each contract deployments/<network>.json records, checks that
// its `sourceFile` still has the recorded `sourceSha256` and that the schema, with the recorded ids
// substituted, still has the recorded `registeredSchemaHash` (what the chain holds), then writes the file
// byte for byte to forge-contracts/contracts/registered/<network>/<name>.v1.json. From then on
// validate-registered.sh checks every later change of the set as an additive update of those files, and
// build.py --check keeps them equal to the build that registered them (NETWORK_REGISTRATIONS).
//
// A network's registration is frozen: a file that already holds another schema is refused, never replaced.
// With --record and --out it writes a copy for a scratch registration (the P2 rehearsal) and touches
// nothing under contracts/registered/. It prints the NETWORK_REGISTRATIONS line build.py needs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

import { DEFAULT_CONTRACTS_DIR, isUnder, loadSchema, parseArgs, placeholderFor, schemaHash } from './deploy-v2.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE_CONTRACTS = resolve(HERE, '..');
const REPO_ROOT = resolve(FORGE_CONTRACTS, '..');
const KEYS = [['forgeCore', 'forge-core'], ['forgeCollab', 'forge-collab'], ['forgeCommunity', 'forge-community'], ['forgeMeta', 'forge-meta']];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Check a record against the files it was registered from and write (or confirm) the frozen copies.
 * Returns `{ outDir, written, unchanged, registrations }`; throws, writing nothing, on any mismatch.
 */
export function freeze({ network, record, out, repoRoot = REPO_ROOT, registeredRoot = join(DEFAULT_CONTRACTS_DIR, 'registered') }) {
  if (!['testnet', 'mainnet'].includes(network)) throw new Error(`--network accepts "testnet" or "mainnet", got ${network}`);
  if ((record === undefined) !== (out === undefined)) throw new Error('--record and --out go together: a scratch copy of a scratch record');
  const scratch = record !== undefined;
  const recordFile = scratch ? resolve(record) : join(FORGE_CONTRACTS, 'deployments', `${network}.json`);
  const outDir = scratch ? resolve(out) : join(registeredRoot, network);
  if (scratch && isUnder(join(outDir, 'x'), registeredRoot)) throw new Error(`--out ${out} is under contracts/registered/: a scratch copy lives elsewhere (the frozen sets are not for rehearsals)`);
  if (!existsSync(recordFile)) throw new Error(`${recordFile} does not exist`);
  const dep = JSON.parse(readFileSync(recordFile, 'utf8'));
  const v2 = dep.v2;
  if (!v2?.forgeCore) throw new Error(`${relative(repoRoot, recordFile)} records no forge-v2 registration yet: nothing to freeze`);
  if (dep.network !== undefined && dep.network !== network) throw new Error(`${relative(repoRoot, recordFile)} records network ${dep.network}, not ${network}`);
  if (!v2.contractsSet) throw new Error(`${relative(repoRoot, recordFile)} records no v2.contractsSet: it was not registered from a committed set`);

  const ids = Object.fromEntries(KEYS.filter(([k]) => v2[k]?.contractId).map(([k, name]) => [placeholderFor(name), v2[k].contractId]));
  const plan = [];
  for (const [key, name] of KEYS) {
    const c = v2[key];
    if (!c) continue;
    if (c.status !== 'registered') throw new Error(`${key} is ${c.status} in ${relative(repoRoot, recordFile)}: finish the registration first`);
    if (!c.sourceFile || !c.sourceSha256 || !c.registeredSchemaHash) throw new Error(`${key} records no sourceFile, sourceSha256 and registeredSchemaHash: it was not registered by deploy-v2 --set`);
    const source = resolve(repoRoot, c.sourceFile);
    const bytes = readFileSync(source);
    const gitNote = c.gitCommit ? ` (run this at the registration commit ${String(c.gitCommit).slice(0, 12)})` : '';
    if (sha256(bytes) !== c.sourceSha256) throw new Error(`${c.sourceFile} is not what ${key} was registered from: sha256 ${sha256(bytes).slice(0, 12)}…, the record has ${c.sourceSha256.slice(0, 12)}…${gitNote}`);
    const hash = schemaHash(loadSchema(name, ids, bytes.toString('utf8')));
    if (hash !== c.registeredSchemaHash) throw new Error(`${c.sourceFile} with the recorded ids has schema hash ${hash.slice(0, 12)}…, but ${key} was registered with ${c.registeredSchemaHash.slice(0, 12)}…${gitNote}`);
    const target = join(outDir, `${name}.v1.json`);
    if (existsSync(target) && !readFileSync(target).equals(bytes)) {
      throw new Error(`${relative(repoRoot, target)} already holds another schema; a network's registration is frozen`);
    }
    plan.push({ name, target, bytes, exists: existsSync(target) });
  }
  const written = [];
  const unchanged = [];
  mkdirSync(outDir, { recursive: true });
  for (const p of plan) {
    if (p.exists) unchanged.push(p.target);
    else {
      writeFileSync(p.target, p.bytes);
      written.push(p.target);
    }
  }
  return { outDir, written, unchanged, registrations: `'${network}': {'set': '${v2.contractsSet}', 'since': ()},` };
}

function cli(argv) {
  const a = parseArgs(argv);
  if (!a.network || a.network === true) throw new Error('usage: freeze-registered.mjs --network testnet|mainnet [--record <file> --out <dir>]');
  if (a.record === true || a.out === true) throw new Error('--record and --out take a path');
  const r = freeze({ network: a.network, record: a.record, out: a.out });
  for (const p of r.written) console.log(`wrote ${relative(REPO_ROOT, p)}`);
  for (const p of r.unchanged) console.log(`unchanged ${relative(REPO_ROOT, p)}`);
  if (a.record === undefined) {
    console.log(`\nAdd to NETWORK_REGISTRATIONS in forge-contracts/schema/build.py (then run build.py --check):\n  ${r.registrations}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    cli(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}
