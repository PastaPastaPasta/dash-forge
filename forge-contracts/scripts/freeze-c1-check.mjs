// The freeze candidate's C1 check: fetch the four contracts a scratch record registered and compare
// each with the candidate JSON in <dir> (`build.py --mainnet --out <dir>`), ids substituted:
//   - the registered config is $formatVersion 2, readonly false, no moderation (canBeDeleted false,
//     no keepsHistory), and equals the JSON's config block (keys the node adds are null);
//   - each documentSchemas / schemaDefs block equals the JSON's, key for key;
//   - owner, version 1, the recorded group.
//
//   node forge-contracts/scripts/freeze-c1-check.mjs --record <record.json> --contracts <dir> \
//        [--network devnet|testnet|mainnet] [--devnet-name sakura] [--report <file.json>]
//
// Read only. Exit 0 when every check passes, 1 otherwise.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DEPENDENT_CONTRACTS, META_CONTRACT, loadEvoSdk, loadSchema, placeholderFor, schemaHash } from './deploy-v2.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, t, i, a) => (t.startsWith('--') ? [...acc, [t.slice(2), a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true]] : acc), []));
if (!args.record || !args.contracts) {
  console.error('usage: freeze-c1-check.mjs --record <record.json> --contracts <dir> [--network devnet|testnet|mainnet] [--devnet-name sakura] [--report <file>]');
  process.exit(2);
}
const rec = JSON.parse(readFileSync(String(args.record), 'utf8')).v2;
const dir = String(args.contracts);
const network = String(args.network || 'devnet');
if (!['devnet', 'testnet', 'mainnet'].includes(network)) throw new Error(`--network ${network}: devnet, testnet or mainnet`);
const devnetName = args['devnet-name'] || 'sakura';
const deploymentFile = network === 'devnet' ? `devnet-${devnetName}.json` : `${network}.json`;
const SETS = [{ key: 'forgeCore', schemaName: 'forge-core' }, ...DEPENDENT_CONTRACTS, META_CONTRACT];
const subs = Object.fromEntries(SETS.filter((c) => rec[c.key]?.contractId).map((c) => [placeholderFor(c.schemaName), rec[c.key].contractId]));

// canonical JSON: keys sorted, so a reordered object is not a difference
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const sha = (v) => createHash('sha256').update(JSON.stringify(canon(v))).digest('hex');

const evo = await loadEvoSdk();
const addresses = rec.dapiAddresses ?? JSON.parse(readFileSync(new URL(`../deployments/${deploymentFile}`, import.meta.url), 'utf8')).dapiAddresses;
const sdk = new evo.EvoSDK({ network, ...(network === 'devnet' ? { devnetName } : {}), trusted: true, addresses, settings: { timeoutMs: 60000 } });
await sdk.connect();

const out = [];
const check = (contract, name, pass, detail = '') => {
  out.push({ contract, name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${contract}] ${name}${detail ? `: ${detail}` : ''}`);
};

for (const c of SETS) {
  const r = rec[c.key];
  const want = loadSchema(c.schemaName, subs, readFileSync(join(dir, `${c.schemaName}.json`), 'utf8'));
  const fetched = await sdk.contracts.fetch(r.contractId);
  if (!fetched) { check(c.schemaName, 'registered on chain', false, r.contractId); continue; }
  const got = fetched.toJSON();
  check(c.schemaName, 'registered on chain', true, `${r.contractId} version ${got.version}`);
  check(c.schemaName, 'owner is the scratch deployer and version is 1', got.ownerId === r.ownerId && Number(got.version) === 1, `${got.ownerId} v${got.version}`);
  const cfg = got.config ?? {};
  check(c.schemaName, 'config $formatVersion 2', String(cfg.$formatVersion) === '2', String(cfg.$formatVersion));
  check(c.schemaName, 'readonly false', cfg.readonly === false, String(cfg.readonly));
  check(c.schemaName, 'canBeDeleted false, keepsHistory false (no moderation)', cfg.canBeDeleted === false && cfg.keepsHistory === false, JSON.stringify({ canBeDeleted: cfg.canBeDeleted, keepsHistory: cfg.keepsHistory }));
  // the node adds the keys the JSON leaves out, as null (bounded-key requirements); anything else is a difference
  const extra = Object.keys(cfg).filter((k) => !(k in want.config));
  check(c.schemaName, 'config keys beyond the JSON block are unset defaults (null)', extra.every((k) => cfg[k] === null || cfg[k] === undefined), JSON.stringify(Object.fromEntries(extra.map((k) => [k, cfg[k]]))));
  // every config key the JSON states matches (booleans and the format version, as strings)
  const cfgDiff = Object.keys(want.config).filter((k) => String(want.config[k]) !== String(cfg[k]));
  check(c.schemaName, 'config equals the JSON block', cfgDiff.length === 0, cfgDiff.map((k) => `${k}: json ${want.config[k]} chain ${cfg[k]}`).join('; '));
  const wantTypes = Object.keys(want.documentSchemas).sort();
  const gotTypes = Object.keys(got.documentSchemas ?? {}).sort();
  check(c.schemaName, 'same document types', same(wantTypes, gotTypes), `${gotTypes.length} types on chain, ${wantTypes.length} in the JSON`);
  const diffTypes = wantTypes.filter((t) => !same(want.documentSchemas[t], got.documentSchemas?.[t]));
  check(c.schemaName, 'every documentSchema equals the JSON (ids substituted)', diffTypes.length === 0, diffTypes.length ? `differs: ${diffTypes.join(', ')}` : `sha256 ${sha(got.documentSchemas).slice(0, 12)} == ${sha(want.documentSchemas).slice(0, 12)}`);
  check(c.schemaName, 'schemaDefs equal the JSON', same(want.schemaDefs ?? {}, got.schemaDefs ?? {}));
  check(c.schemaName, 'recorded schemaHash is the substituted JSON\'s', r.schemaHash === schemaHash(want), r.schemaHash.slice(0, 12));
}
const failed = out.filter((o) => !o.pass);
console.log(JSON.stringify({ passed: out.length - failed.length, total: out.length, failed }));
if (args.report) writeFileSync(String(args.report), `${JSON.stringify({ record: rec, results: out }, null, 2)}\n`);
process.exit(failed.length ? 1 : 0);
