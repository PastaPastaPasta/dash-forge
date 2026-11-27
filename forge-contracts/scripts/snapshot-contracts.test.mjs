// node --test forge-contracts/scripts/snapshot-contracts.test.mjs
// The offline parts of snapshot-contracts.mjs: which records it will snapshot, where, and at which
// protocol version (against a fake SDK).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { incompleteReason, resolveTarget, snapshotIds, snapshotVersion, takeSnapshot } from './snapshot-contracts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reg = (contractId) => ({ contractId, status: 'registered' });
const four = () => ({
  keyExchange: { contractId: 'KX' },
  v2: { forgeCore: reg('C'), forgeCollab: reg('L'), forgeCommunity: reg('M'), forgeMeta: reg('E'), contractGroupId: 'G' },
});

test('a complete record is snapshotted, and a four-contract one includes forge-meta', () => {
  assert.equal(incompleteReason(four()), null);
  assert.ok(snapshotIds(four()).includes('E'));
  // a record from before the community split has no forge-community
  const three = { v2: { forgeCore: reg('C'), forgeCollab: reg('L'), contractGroupId: 'G' } };
  assert.equal(incompleteReason(three), null);
});

test('a half-finished record is refused, naming the contract', () => {
  const meta = four();
  meta.v2.forgeMeta.status = 'broadcasting';
  assert.equal(incompleteReason(meta), 'forgeMeta is broadcasting');
  const noGroup = four();
  delete noGroup.v2.contractGroupId;
  assert.equal(incompleteReason(noGroup), 'records no contract group');
  const noCore = four();
  delete noCore.v2.forgeCore;
  assert.equal(incompleteReason(noCore), 'forgeCore is not recorded');
  assert.equal(incompleteReason({ dapiAddresses: [] }), 'records no forge-v2 contracts', 'the testnet record before registration');
  const noId = four();
  noId.v2.forgeCollab = { status: 'registered' };
  assert.match(incompleteReason(noId), /forgeCollab/);
});

test('the committed pair by default, a scratch record only with its own --out', () => {
  const live = resolveTarget({ network: 'testnet' }, ROOT);
  assert.equal(live.depFile, join(ROOT, 'deployments', 'testnet.json'));
  assert.equal(live.out, join(ROOT, 'deployments', 'contracts', 'testnet.json'));
  const sakura = resolveTarget({}, ROOT);
  assert.equal(sakura.key, 'devnet-sakura');
  assert.equal(sakura.out, join(ROOT, 'deployments', 'contracts', 'devnet-sakura.json'));
  const scratch = resolveTarget({ network: 'testnet', record: '/tmp/rehearsal.json', out: '/tmp/rehearsal-snapshot.json' }, ROOT);
  assert.deepEqual([scratch.depFile, scratch.out], ['/tmp/rehearsal.json', '/tmp/rehearsal-snapshot.json']);
  assert.throws(() => resolveTarget({ network: 'testnet', record: '/tmp/rehearsal.json' }, ROOT), /name the snapshot it writes with --out/);
  assert.throws(() => resolveTarget({ network: 'testnet', record: '/tmp/rehearsal.json', out: join(ROOT, 'deployments', 'contracts', 'testnet.json') }, ROOT), /outside forge-contracts\/deployments/);
  assert.throws(() => resolveTarget({ network: 'testnet', record: '/tmp/r.json', out: join(ROOT, 'Deployments', 'Contracts', 'testnet.json') }, ROOT), /outside forge-contracts\/deployments/, 'case alias');
  // naming the live record explicitly is the default
  assert.equal(resolveTarget({ network: 'testnet', record: live.depFile }, ROOT).out, live.out);
  assert.throws(() => resolveTarget({ network: 'prod' }, ROOT), /unknown network/);
  assert.throws(() => resolveTarget({ record: true }, ROOT), /take a path/);
});

test('a symlink into the committed snapshots is not a scratch location', () => {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-test-'));
  try {
    mkdirSync(join(root, 'deployments', 'contracts'), { recursive: true });
    symlinkSync(join(root, 'deployments', 'contracts'), join(root, 'elsewhere'));
    assert.throws(() => resolveTarget({ network: 'testnet', record: join(root, 'r.json'), out: join(root, 'elsewhere', 'testnet.json') }, root), /outside forge-contracts\/deployments/);
    assert.equal(resolveTarget({ network: 'testnet', record: join(root, 'r.json'), out: join(root, 'scratch.json') }, root).out, join(root, 'scratch.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A fake evo-sdk whose SDK sits at `sdkVersion` and whose proved answer names `provedVersion`. */
function fakeEvo(sdkVersion, provedVersion) {
  const made = [];
  class EvoSDK {
    constructor(options) { made.push(options); }
    async connect() {}
    version() { return sdkVersion; }
    contracts = {
      getManyWithProof: async (ids) => ({
        data: new Map(ids.map((id) => [id, { version: 1, toBytes: (v) => Uint8Array.of(v) }])),
        metadata: provedVersion === undefined ? {} : { protocolVersion: provedVersion },
      }),
    };
  }
  return { evo: { EvoSDK }, made };
}

test('the snapshot is serialized at the version the proved answer names', async () => {
  const { evo, made } = fakeEvo(15, 15);
  const { snapshot, platformVersion } = await takeSnapshot({ network: 'testnet', key: 'testnet', dep: four(), evo });
  assert.equal(platformVersion, 15);
  assert.deepEqual(snapshot.C, { version: 1, platformVersion: 15, bytes: Buffer.of(15).toString('base64') });
  assert.equal(made[0].version, undefined, 'the SDK is not pinned');
});

test('a version the network does not run is refused', async () => {
  // an SDK seeded or pinned above the network: the snapshot would raise every reader's stored version
  await assert.rejects(takeSnapshot({ network: 'mainnet', key: 'mainnet', dep: four(), evo: fakeEvo(15, 14).evo }), /mainnet runs protocol 14 but the SDK is at 15: nothing written/);
  await assert.rejects(takeSnapshot({ network: 'mainnet', key: 'mainnet', dep: four(), evo: fakeEvo(14, 13).evo }), /runs protocol 13, below 14/);
  await assert.rejects(takeSnapshot({ network: 'mainnet', key: 'mainnet', dep: four(), evo: fakeEvo(14, undefined).evo }), /named no protocol version/);
  assert.equal(snapshotVersion(14, 14, 'mainnet'), 14);
  assert.throws(() => snapshotVersion(14, 0, 'mainnet'), /named no protocol version/);
});
