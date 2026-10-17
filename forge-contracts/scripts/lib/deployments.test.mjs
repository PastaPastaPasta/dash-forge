// node --test forge-contracts/scripts/lib/deployments.test.mjs
//
// The committed deployments/*.json hold the rules in lib/deployments-check.mjs, and a record the real
// deploy-v2 writes (against the fake platform) holds them too; breaking one rule at a time is caught.
// Before the registration commit (P4) only the id derivation has data in the committed records.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, test } from 'node:test';

import { SETS, formatSums, main, setSums } from '../deploy-v2.mjs';
import { createFakePlatform } from './fake-platform.mjs';
import { recordProblems } from './deployments-check.mjs';

const DEPLOYMENTS = join(SETS.devnet, '..', 'deployments');
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test('every committed deployment record holds its rules', () => {
  const files = readdirSync(DEPLOYMENTS).filter((f) => f.endsWith('.json'));
  assert.ok(files.includes('testnet.json') && files.includes('devnet-sakura.json'));
  for (const f of files) {
    const name = basename(f, '.json');
    assert.deepEqual(recordProblems({ name, dep: JSON.parse(readFileSync(join(DEPLOYMENTS, f), 'utf8')) }), [], f);
  }
});

/** A testnet record the real deploy-v2 writes, its frozen registered/testnet/ copy, and the checker's roots. */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'deployments-test-'));
  dirs.push(dir);
  const deploymentsRoot = join(dir, 'deployments');
  mkdirSync(deploymentsRoot);
  const fake = createFakePlatform();
  const sumsFile = join(dir, 'sums.txt');
  writeFileSync(sumsFile, formatSums(setSums(SETS.mainnet)));
  const git = { head: () => 'a'.repeat(40), porcelain: () => '', pushed: () => true, buildCheck: () => ({ ok: true, output: '' }) };
  await main(
    ['--network', 'testnet', '--set', 'mainnet', '--identity', fake.writeIdentity(dir), '--expect-sha256', sumsFile, '--deployer-created-height', '623900'],
    { evo: fake.evo, git, deploymentsRoot, log: () => {}, print: () => {}, sdkId: '@dashevo/evo-sdk@5.0.0-rc.3', settleMs: 0, settleTries: 1 },
  );
  const dep = JSON.parse(readFileSync(join(deploymentsRoot, 'testnet.json'), 'utf8'));
  dep.dapiAddresses = ['https://68.67.122.1:1443', 'https://68.67.122.2:22822'];
  const registeredRoot = join(dir, 'registered');
  cpSync(SETS.mainnet, join(registeredRoot, 'testnet'), { recursive: true });
  for (const f of readdirSync(join(registeredRoot, 'testnet'))) {
    cpSync(join(registeredRoot, 'testnet', f), join(registeredRoot, 'testnet', f.replace(/\.json$/, '.v1.json')));
    rmSync(join(registeredRoot, 'testnet', f));
  }
  return { dep, registeredRoot, check: (d, over = {}) => recordProblems({ name: 'testnet', dep: d, registeredRoot, ...over }) };
}
const clone = (x) => JSON.parse(JSON.stringify(x));

test('a record deploy-v2 wrote for testnet holds every rule', async () => {
  const { dep, check } = await fixture();
  assert.deepEqual(check(dep), []);
});

test('each rule is enforced', async () => {
  const { dep, check } = await fixture();
  const mutations = [
    ['an id that does not derive from owner and nonce', (d) => { d.v2.forgeCollab.identityNonce = '9'; }, /forgeCollab: contractId .* does not derive/],
    ['a group that does not derive from forge-core\'s nonce', (d) => { d.v2.forgeCore.contractGroupId = d.v2.forgeCollab.contractId; }, /forgeCore: contractGroupId .* does not derive/],
    ['a set that is not committed', (d) => { d.v2.contractsSet = 'elsewhere'; }, /"elsewhere" is not a committed set/],
    ['a source hash that is not the frozen copy', (d) => { d.v2.forgeMeta.sourceSha256 = '0'.repeat(64); }, /forgeMeta.sourceSha256 is not the sha256 of registered\/testnet\/forge-meta\.v1\.json/],
    ['a registered schema hash that is not the frozen copy', (d) => { d.v2.forgeCore.registeredSchemaHash = '0'.repeat(64); }, /forgeCore.registeredSchemaHash is not the hash of registered\/testnet\/forge-core\.v1\.json/],
    ['a ledger that goes backwards', (d) => { [d.v2.nonceLedger[1], d.v2.nonceLedger[2]] = [d.v2.nonceLedger[2], d.v2.nonceLedger[1]]; }, /does not follow/],
    ['a contract without its registered create entry', (d) => { d.v2.nonceLedger.splice(3, 1); }, /no registered create entry for forgeMeta at identity nonce 4/],
    ['a record without a ledger', (d) => { delete d.v2.nonceLedger; }, /nonceLedger is missing/],
    ['a set missing a contract', (d) => { delete d.v2.forgeMeta; }, /records forge-core, forge-collab, forge-community, but the mainnet set is .*forge-meta/],
    ['no chain id', (d) => { delete d.chainId; }, /no chainId/],
    ['a group owner that is not the deployer', (d) => { d.v2.contractGroup.owner = d.v2.forgeCollab.contractId; }, /contractGroup.owner .* is not the deployer/],
    ['a group with an admin', (d) => { d.v2.contractGroup.admins = [d.v2.forgeCollab.contractId]; }, /contractGroup.admins must be \[\]/],
    ['a contract of another owner', (d) => { d.v2.forgeCommunity.ownerId = d.v2.forgeCollab.contractId; }, /forgeCommunity.ownerId .* is not the deployer/],
    ['a DAPI seed that is not https://ipv4:port', (d) => { d.dapiAddresses.push('http://node.example:1443'); }, /dapiAddresses: http:\/\/node.example:1443 is not/],
  ];
  for (const [what, mutate, expected] of mutations) {
    const d = clone(dep);
    mutate(d);
    const problems = check(d);
    assert.ok(problems.some((p) => expected.test(p)), `${what}: ${JSON.stringify(problems)}`);
  }
});

test('a devnet record is not held to the production rules, and a record without v2 has none', async () => {
  const { dep, check } = await fixture();
  const d = clone(dep);
  delete d.chainId;
  d.dapiAddresses = ['http://localhost:2443'];
  assert.deepEqual(check(d, { name: 'devnet-test' }), [], 'a devnet name has no production rules (and no frozen copy here)');
  assert.deepEqual(check({ dapiAddresses: ['http://x'] }), []);
  // a devnet record that predates the ledger, once deploy-v2 has stamped its set and logged an update, still holds
  // (sakura's three-contract record before its 2026-10-17 switch, rebuilt from the blocks it superseded)
  const live = JSON.parse(readFileSync(join(DEPLOYMENTS, 'devnet-sakura.json'), 'utf8'));
  const was = (key) => { const { supersededAt, ...c } = live.v2[`${key}Superseded`][0]; return c; };
  const sakura = { network: 'devnet', devnetName: 'sakura', v2: { forgeCore: was('forgeCore'), forgeCollab: was('forgeCollab'), forgeCommunity: was('forgeCommunity'), contractGroupId: was('forgeCore').contractGroupId } };
  sakura.v2.contractsSet = 'devnet';
  sakura.v2.nonceLedger = [{ contractNonce: '1', kind: 'dataContractUpdate', key: 'forgeCollab', contractId: sakura.v2.forgeCollab.contractId, status: 'updated' }];
  assert.deepEqual(recordProblems({ name: 'devnet-sakura', dep: sakura }), []);
  // and the live record, now the four-contract set with its ledger
  assert.deepEqual(recordProblems({ name: 'devnet-sakura', dep: live }), []);
});
