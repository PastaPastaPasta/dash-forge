// deploy-user.mjs / deploy-org.mjs (lib/group-contract.mjs) against an in-memory platform
// (lib/fake-platform.mjs): no SDK, no network, no key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { b58encode, contractId } from '../deploy-v2.mjs';
import { createFakePlatform } from './fake-platform.mjs';
import { deployGroupContract } from './group-contract.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORG = { recordKey: 'org', schemaFile: 'contracts/org/forge-org.json', label: 'forge-org' };
const GROUP = b58encode(Buffer.alloc(32, 4));

function setup() {
  const fake = createFakePlatform();
  const root = mkdtempSync(join(tmpdir(), 'group-contract-'));
  mkdirSync(join(root, 'deployments'));
  cpSync(join(ROOT, 'contracts', 'org'), join(root, 'contracts', 'org'), { recursive: true });
  fake.state.groups.set(GROUP, { ownerId: fake.ownerId, adminIds: [] });
  fake.externalTransition(5);
  const depFile = join(root, 'deployments', 'testnet.json');
  const write = (extra = {}) => writeFileSync(depFile, JSON.stringify({ network: 'testnet', v2: { contractGroupId: GROUP, forgeCore: { ownerId: fake.ownerId } }, ...extra }));
  write();
  const identity = fake.writeIdentity(root);
  const run = (...flags) => deployGroupContract(['--network', 'testnet', '--identity', identity, ...flags], ORG, { evo: fake.evo, root, settleMs: 1 });
  const record = () => JSON.parse(readFileSync(depFile, 'utf8')).org;
  return { fake, depFile, write, run, record };
}

test('registers into the group at the next nonce and records it', async () => {
  const t = setup();
  await t.run();
  const r = t.record();
  assert.equal(r.status, 'registered');
  assert.equal(r.identityNonce, '6');
  assert.equal(r.contractId, contractId(t.fake.ownerId, 6n));
  assert.deepEqual(t.fake.state.memberships.get(r.contractId), [GROUP]);
  assert.equal(existsSync(`${t.depFile}.lock`), false);
  await t.run();
  assert.equal(t.fake.broadcasts, 1, 'a rerun after success broadcasts nothing');
});

test('a dry run writes nothing and broadcasts nothing', async () => {
  const t = setup();
  await t.run('--dry-run');
  assert.equal(t.record(), undefined);
  assert.equal(t.fake.broadcasts, 0);
});

test('an unconfirmed reservation is retried at its own nonce, never at a fresh one', async () => {
  const t = setup();
  t.fake.failNext('before');
  await assert.rejects(t.run(), /connection lost/);
  assert.equal(t.record().status, 'broadcasting');
  const reserved = t.record();
  await t.run();
  assert.equal(t.record().status, 'registered');
  assert.equal(t.record().contractId, reserved.contractId);
  assert.equal(t.fake.state.contracts.size, 1);
});

test('a reservation that lands during the rerun is not registered twice', async () => {
  const t = setup();
  t.fake.failNext('before');
  await assert.rejects(t.run(), /connection lost/);
  const reserved = t.record();
  const { evo, state, ownerId } = t.fake;
  const Real = evo.EvoSDK;
  evo.EvoSDK = class extends Real {
    constructor(o) {
      super(o);
      const groupInfo = this.contractGroups.info;
      // the first create lands after the rerun checked its nonce, before it builds the retry
      this.contractGroups.info = async (id) => {
        state.contracts.set(reserved.contractId, { json: JSON.parse(readFileSync(join(ROOT, ORG.schemaFile), 'utf8')), ownerId, version: 1 });
        state.identities.get(ownerId).nonce = BigInt(reserved.identityNonce);
        return groupInfo(id);
      };
    }
  };
  await assert.rejects(t.run(), /invalid identity nonce/);
  assert.equal(state.contracts.size, 1, 'no second contract');
  assert.equal(state.contracts.has(contractId(ownerId, BigInt(reserved.identityNonce) + 1n)), false);
  evo.EvoSDK = Real;
  await t.run();
  assert.equal(t.record().status, 'registered');
  assert.equal(t.record().contractId, reserved.contractId);
});

test('a recorded contract that is not this schema stops the run', async () => {
  const t = setup();
  const id = contractId(t.fake.ownerId, 3n);
  t.fake.state.contracts.set(id, { json: { documentSchemas: { state: {} } }, ownerId: t.fake.ownerId, version: 1 });
  t.write({ org: { contractId: id, contractGroupId: GROUP, identityNonce: '3', status: 'broadcasting' } });
  await assert.rejects(t.run(), /differs from the committed forge-org/);
  assert.equal(t.record().status, 'broadcasting');
  assert.equal(t.fake.broadcasts, 0);
});

test('--emit needs a file name', async () => {
  await assert.rejects(deployGroupContract(['--emit'], ORG), /needs a file name/);
});
