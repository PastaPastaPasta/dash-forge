// What a deployments/<network>.json that records a forge-v2 set must satisfy, checked offline
// (deployments.test.mjs runs it on every committed record, and on fixture records with one broken rule
// each): ids derive from the owner and nonce, a named set is a committed one and its frozen copy
// (contracts/registered/<network>/) is what was registered, the nonce ledger is a straight line, and
// a testnet or mainnet record is complete (chain, one deployer, no group admins, DAPI seeds).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { DEFAULT_CONTRACTS_DIR, SETS, contractGroupId, contractId, dependentsIn, ledgerChains, loadSchema, placeholderFor, schemaHash } from '../deploy-v2.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const KEYS = { forgeCore: 'forge-core', forgeCollab: 'forge-collab', forgeCommunity: 'forge-community', forgeMeta: 'forge-meta' };
const PRODUCTION = ['testnet', 'mainnet'];
const DAPI = /^https:\/\/(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d):\d{1,5}$/;

/**
 * The problems of a record `dep` named `name` (`testnet`, `devnet-sakura`); [] when it holds. `registeredRoot`
 * is contracts/registered/ and `sets` maps a `contractsSet` to its directory.
 */
export function recordProblems({ name, dep, registeredRoot = join(DEFAULT_CONTRACTS_DIR, 'registered'), sets = SETS }) {
  const v2 = dep?.v2;
  if (!v2) return [];
  const problems = [];
  const bad = (m) => problems.push(`${name}: ${m}`);

  // ids derive from the owner and the nonce, for every recorded contract (live and superseded)
  const recorded = Object.keys(KEYS).flatMap((key) => [[key, v2[key]], ...(v2[`${key}Superseded`] ?? []).map((s) => [`${key}Superseded`, s])]).filter(([, c]) => c);
  for (const [key, c] of recorded) {
    if (c.identityNonce === undefined || !c.ownerId) continue;
    if (contractId(c.ownerId, BigInt(c.identityNonce)) !== c.contractId) bad(`${key}: contractId ${c.contractId} does not derive from owner ${c.ownerId} at nonce ${c.identityNonce}`);
    if (key.startsWith('forgeCore') && c.contractGroupId && contractGroupId(c.ownerId, BigInt(c.identityNonce)) !== c.contractGroupId) {
      bad(`${key}: contractGroupId ${c.contractGroupId} does not derive from owner ${c.ownerId} at nonce ${c.identityNonce}`);
    }
  }

  if (v2.contractsSet !== undefined) {
    const dir = sets[v2.contractsSet];
    if (!dir || !existsSync(dir)) bad(`v2.contractsSet "${v2.contractsSet}" is not a committed set (${Object.keys(sets).join(' or ')})`);
    const frozenDir = join(registeredRoot, name);
    const live = Object.entries(KEYS).filter(([key]) => v2[key]);
    for (const [key, schemaName] of live) {
      const c = v2[key];
      const frozen = join(frozenDir, `${schemaName}.v1.json`);
      if (!existsSync(frozen)) continue;
      const bytes = readFileSync(frozen);
      if (c.sourceSha256 !== undefined && c.sourceSha256 !== sha256(bytes)) bad(`${key}.sourceSha256 is not the sha256 of registered/${name}/${schemaName}.v1.json`);
      if (c.registeredSchemaHash !== undefined) {
        const ids = Object.fromEntries(Object.entries(KEYS).filter(([k]) => v2[k]?.contractId).map(([k, n]) => [placeholderFor(n), v2[k].contractId]));
        let hash;
        try { hash = schemaHash(loadSchema(schemaName, ids, bytes.toString('utf8'))); } catch (e) { bad(`${key}: registered/${name}/${schemaName}.v1.json does not load (${e.message})`); continue; }
        if (c.registeredSchemaHash !== hash) bad(`${key}.registeredSchemaHash is not the hash of registered/${name}/${schemaName}.v1.json with the recorded ids`);
      }
    }
    // the ledger: identity nonces strictly increase on each chain (a same-id restore starts a new one,
    // carrying only the creates it replayed), and every live contract has its registered create entry
    // (a devnet record may predate the ledger, or have been updated by deploy-v2 since: only a production record
    // must hold a ledger that starts with its registrations)
    const ledger = v2.nonceLedger;
    const production = PRODUCTION.includes(name);
    if (!Array.isArray(ledger)) {
      if (production) bad('v2.nonceLedger is missing from a record that names its set');
    } else {
      for (const [i, chain] of ledgerChains(v2).entries()) {
        let last = 0n;
        for (const e of chain.filter((x) => x.status !== 'abandoned')) {
          const n = BigInt(e.identityNonce);
          if (n <= last) bad(`v2.nonceLedger: identity nonce ${n} does not follow ${last}${i > 0 ? ` (on the chain of v2.restores[${i - 1}])` : ''}`);
          last = n;
        }
      }
      for (const [key] of production ? live : []) {
        const c = v2[key];
        if (c.identityNonce !== undefined && !ledger.some((e) => e.kind === 'dataContractCreate' && e.key === key && e.identityNonce === c.identityNonce && e.contractId === c.contractId && e.status === 'registered')) {
          bad(`v2.nonceLedger has no registered create entry for ${key} at identity nonce ${c.identityNonce}`);
        }
      }
    }
    if (dir && existsSync(dir)) {
      const want = ['forge-core', ...dependentsIn(dir).map((c) => c.schemaName)];
      const have = live.map(([, n]) => n);
      if (want.some((n) => !have.includes(n)) || have.some((n) => !want.includes(n))) bad(`records ${have.join(', ')}, but the ${v2.contractsSet} set is ${want.join(', ')}`);
    }
  }

  if (PRODUCTION.includes(name)) {
    if (!dep.chainId) bad('no chainId: the chain it was registered on is not pinned');
    const deployer = v2.deployer?.identityId;
    if (!deployer) bad('no v2.deployer.identityId');
    if (v2.contractGroup) {
      if (v2.contractGroup.owner !== deployer) bad(`contractGroup.owner ${v2.contractGroup.owner} is not the deployer ${deployer}`);
      if (!Array.isArray(v2.contractGroup.admins) || v2.contractGroup.admins.length > 0) bad('contractGroup.admins must be []: Forge clients refuse a group with admins');
    } else {
      bad('no v2.contractGroup');
    }
    for (const [key] of Object.entries(KEYS).filter(([k]) => v2[k])) {
      if (v2[key].ownerId !== deployer) bad(`${key}.ownerId ${v2[key].ownerId} is not the deployer ${deployer}`);
    }
    for (const a of dep.dapiAddresses ?? []) if (!DAPI.test(a)) bad(`dapiAddresses: ${a} is not https://<ipv4>:<port>`);
  }
  return problems;
}
