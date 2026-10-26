// node --test forge-contracts/scripts/deploy-v2.test.mjs
//
// deploy-v2.mjs end to end against the fake platform (lib/fake-platform.mjs): the real script
// code, the committed contract files, a temp copy of deployments/, no network and no key.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { ROOM_MIN, SETS, b58encode, contractGroupId, contractId, formatSums, main, parseSums, recordedSet, setSums } from './deploy-v2.mjs';
import { createFakePlatform, fakeIdentityFile } from './lib/fake-platform.mjs';
import { recordProblems } from './lib/deployments-check.mjs';
import { scratchStampError } from './lib/target.mjs';

const MAX = 20480;
const KEYS = ['forgeCore', 'forgeCollab', 'forgeCommunity', 'forgeMeta'];
const SCHEMAS = ['forge-core', 'forge-collab', 'forge-community', 'forge-meta'];
const TESTNET_SEED = {
  dapiAddresses: ['https://68.67.122.1:1443', 'https://68.67.122.2:1443'],
  keyExchange: { contractId: '7UaqHGBJBbRLJ4fUWS45cnud8PPUugJWoGTt1SKwHJ2P', ownerId: 'hbGEcFcXKJ2W9Di24ekiozTWfFszrjqkxbjfEep3D8A', note: 'yappr' },
};
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A temp deployments/ with the testnet seed, a fake platform, and a `run` that drives the real main(). */
function setup({ platform = {}, seed = TESTNET_SEED } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-v2-test-'));
  dirs.push(dir);
  const deploymentsRoot = join(dir, 'deployments');
  mkdirSync(deploymentsRoot);
  if (seed) writeFileSync(join(deploymentsRoot, 'testnet.json'), `${JSON.stringify(seed, null, 2)}\n`);
  const fake = createFakePlatform(platform);
  const identity = fake.writeIdentity(dir);
  const sumsFile = join(dir, 'signed-sums.txt');
  writeFileSync(sumsFile, formatSums(setSums(SETS.mainnet)));
  const git = { head: () => 'a'.repeat(40), porcelain: () => '', pushed: () => true, buildCheck: () => ({ ok: true, output: '' }) };
  let tick = 0;
  const logs = [];
  const out = [];
  const ctx = {
    dir,
    deploymentsRoot,
    fake,
    git,
    logs,
    out,
    identity,
    sumsFile,
    testnetFile: join(deploymentsRoot, 'testnet.json'),
    read: (name = 'testnet.json') => JSON.parse(readFileSync(join(deploymentsRoot, name), 'utf8')),
    raw: (name = 'testnet.json') => readFileSync(join(deploymentsRoot, name), 'utf8'),
    /** the arguments of a production registration */
    prod: (...extra) => ['--network', 'testnet', '--set', 'mainnet', '--identity', identity, '--expect-sha256', sumsFile, ...extra],
    run: (argv, over = {}) => main(argv, {
      evo: fake.evo,
      git,
      now: () => new Date(Date.UTC(2026, 9, 20, 12, 0, tick++)),
      log: (m) => logs.push(m),
      print: (t) => out.push(t),
      deploymentsRoot,
      sdkId: '@dashevo/evo-sdk@5.0.0-rc.3',
      settleMs: 0,
      settleTries: 1,
      ...over,
    }),
  };
  return ctx;
}

const without = (obj, ...keys) => JSON.parse(JSON.stringify(obj, (k, v) => (keys.includes(k) ? undefined : v)));

test('a fresh testnet registration records the four contracts, the ledger and the provenance', async () => {
  const t = setup();
  await t.run(t.prod('--deployer-created-height', '623900'));
  const rec = t.read();
  const owner = t.fake.ownerId;
  const sums = setSums(SETS.mainnet);
  // top level: the network's identity, and what was there before is kept
  assert.deepEqual(Object.keys(rec).slice(0, 2), ['network', 'chainId']);
  assert.equal(rec.network, 'testnet');
  assert.equal(rec.chainId, 'dash-testnet-51');
  assert.deepEqual(rec.dapiAddresses, TESTNET_SEED.dapiAddresses);
  assert.deepEqual(rec.keyExchange, TESTNET_SEED.keyExchange);
  assert.equal(rec.v2.contractsSet, 'mainnet');
  // four contracts at identity nonces 1-4, ids derived from them, one group derived from forge-core's nonce
  const group = contractGroupId(owner, 1n);
  KEYS.forEach((key, i) => {
    const c = rec.v2[key];
    const nonce = i + 1;
    assert.equal(c.contractId, contractId(owner, BigInt(nonce)), key);
    assert.equal(c.identityNonce, String(nonce));
    assert.equal(c.ownerId, owner);
    assert.equal(c.contractGroupId, group);
    assert.equal(c.status, 'registered');
    assert.equal(c.registeredSchemaHash, c.schemaHash);
    assert.equal(c.sourceFile, `forge-contracts/contracts/mainnet/${SCHEMAS[i]}.json`);
    assert.equal(c.sourceSha256, sums[`${SCHEMAS[i]}.json`]);
    assert.equal(c.gitCommit, 'a'.repeat(40));
    assert.equal(c.gitCommitPushed, true);
    assert.match(c.transitionSha256, /^[0-9a-f]{64}$/);
    assert.match(c.documentsHash, /^[0-9a-f]{64}$/);
    assert.equal(c.roomBytes, MAX - c.sizeBytes);
    assert.ok(c.roomBytes >= ROOM_MIN);
    assert.deepEqual(Object.keys(c.provedAt).sort(), ['coreChainLockedHeight', 'epoch', 'height', 'protocolVersion', 'timeMs']);
    assert.match(c.provedAt.height, /^\d+$/);
    assert.ok(BigInt(c.costCredits) > 0n);
  });
  // the group: owner, no admins, a description naming all four
  assert.equal(rec.v2.contractGroupId, group);
  assert.deepEqual(rec.v2.contractGroup.admins, []);
  assert.equal(rec.v2.contractGroup.owner, owner);
  assert.equal(rec.v2.contractGroup.description, 'Dash Forge v2: forge-core, forge-collab, forge-community and forge-meta');
  assert.equal(rec.v2.protocolVersion, 14);
  assert.equal(rec.v2.sdk, '@dashevo/evo-sdk@5.0.0-rc.3');
  // the deployer, and a ledger of four registered creates in nonce order
  assert.deepEqual(rec.v2.deployer, {
    identityId: owner,
    assetLockTxid: 'ab'.repeat(32),
    createdAtHeight: 623900,
    note: 'custody: offline escrow (OD-2); never signs anything but Forge contract registrations and updates',
  });
  assert.deepEqual(rec.v2.restores, []);
  assert.equal(rec.v2.nonceLedger.length, 4);
  rec.v2.nonceLedger.forEach((e, i) => {
    assert.equal(e.identityNonce, String(i + 1));
    assert.equal(e.kind, 'dataContractCreate');
    assert.equal(e.key, KEYS[i]);
    assert.equal(e.status, 'registered');
    assert.equal(e.contractId, rec.v2[KEYS[i]].contractId);
    assert.equal(e.schemaHash, rec.v2[KEYS[i]].schemaHash);
    assert.equal(e.registersGroup, i === 0);
    assert.equal(e.gitCommit, 'a'.repeat(40));
    assert.equal(e.transitionSha256, rec.v2[KEYS[i]].transitionSha256);
    assert.equal(e.documentsHash, rec.v2[KEYS[i]].documentsHash);
  });
  // testnet and mainnet use SDK discovery: the recorded (stale) list is not handed to the SDK
  assert.ok(t.fake.state.sdkOptions.every((o) => o.addresses === undefined && o.network === 'testnet'));
  // the report on stdout is JSON
  assert.equal(JSON.parse(t.out.join('')).contractGroupId, group);
  // the run's lock is gone
  assert.ok(!existsSync(`${t.testnetFile}.lock`));
});

test('the record is what freeze-c1-check reads: contract ids, owners, hashes and statuses of all four', async () => {
  const t = setup();
  await t.run(t.prod());
  const v2 = t.read().v2;
  for (const key of KEYS) {
    for (const field of ['contractId', 'ownerId', 'schemaHash', 'status']) assert.ok(v2[key][field], `${key}.${field}`);
  }
});

test('rerunning the same command broadcasts nothing and changes only verifiedAt', async () => {
  const t = setup();
  await t.run(t.prod());
  const first = t.read();
  const broadcasts = t.fake.broadcasts;
  assert.equal(broadcasts, 4);
  await t.run(t.prod());
  assert.equal(t.fake.broadcasts, broadcasts);
  assert.deepEqual(without(t.read(), 'verifiedAt'), without(first, 'verifiedAt'));
});

test('a crash after the broadcast landed: the rerun completes the record without a second broadcast', async () => {
  const t = setup();
  t.fake.failNext('after');
  await assert.rejects(t.run(t.prod()), /timed out waiting/);
  let rec = t.read();
  assert.equal(rec.v2.forgeCore.status, 'broadcasting');
  assert.equal(rec.v2.nonceLedger[0].status, 'broadcasting');
  assert.equal(t.fake.broadcasts, 1);
  await t.run(t.prod());
  rec = t.read();
  assert.equal(t.fake.broadcasts, 4, 'forge-core was not broadcast twice');
  assert.equal(rec.v2.forgeCore.status, 'registered');
  assert.equal(rec.v2.forgeCore.identityNonce, '1');
  assert.ok(rec.v2.forgeCore.confirmedAt);
  assert.ok(rec.v2.forgeCore.provedAt.height);
  assert.deepEqual(rec.v2.nonceLedger.map((e) => [e.identityNonce, e.status]), [['1', 'registered'], ['2', 'registered'], ['3', 'registered'], ['4', 'registered']]);
});

test('a crash before the broadcast landed: the rerun reuses the nonce', async () => {
  const t = setup();
  t.fake.failNext('before');
  await assert.rejects(t.run(t.prod()), /connection lost/);
  const reserved = t.read().v2.forgeCore;
  assert.equal(reserved.status, 'broadcasting');
  await t.run(t.prod());
  const rec = t.read();
  assert.equal(rec.v2.forgeCore.contractId, reserved.contractId);
  assert.equal(rec.v2.forgeCore.identityNonce, '1');
  assert.equal(rec.v2.nonceLedger.length, 4, 'the reservation was rewritten, not duplicated');
  assert.ok(rec.v2.nonceLedger.every((e) => e.status === 'registered'));
});

test('something else consumed the deployer nonce: the run stops until it is acknowledged', async () => {
  const t = setup();
  t.fake.failNext('before');
  await assert.rejects(t.run(t.prod()), /connection lost/);
  t.fake.externalTransition();
  const before = t.raw();
  const broadcasts = t.fake.broadcasts;
  await assert.rejects(t.run(t.prod()), /identity nonce is 1 on chain but the ledger ends at 0.*--acknowledge-nonce 1 --note/s);
  assert.equal(t.fake.broadcasts, broadcasts, 'nothing was broadcast');
  assert.equal(t.raw(), before, 'the record is untouched by the refusal');
  // the note is required, and only a nonce that is unexplained can be acknowledged
  await assert.rejects(t.run(t.prod('--acknowledge-nonce', '1')), /--note/);
  await assert.rejects(t.run(t.prod('--acknowledge-nonce', '1', '--acknowledge-nonce', '7', '--note', 'x')), /--acknowledge-nonce 7/);
  await t.run(t.prod('--acknowledge-nonce', '1', '--note', 'IdentityUpdate: rotated CRITICAL (INC-10)'));
  const rec = t.read();
  assert.equal(rec.v2.forgeCore.identityNonce, '2', 'registered at the next free nonce');
  const ledger = rec.v2.nonceLedger.map((e) => [e.identityNonce, e.kind, e.status ?? e.note]);
  assert.deepEqual(ledger, [
    ['1', 'dataContractCreate', 'abandoned'],
    ['1', 'external', 'IdentityUpdate: rotated CRITICAL (INC-10)'],
    ['2', 'dataContractCreate', 'registered'],
    ['3', 'dataContractCreate', 'registered'],
    ['4', 'dataContractCreate', 'registered'],
    ['5', 'dataContractCreate', 'registered'],
  ]);
});

test('a record registered from one set refuses another, and testnet needs --set mainnet', async () => {
  const t = setup();
  await t.run(t.prod());
  // testnet: no --set, or the three-contract set, is refused before anything connects
  const base = ['--network', 'testnet', '--identity', t.identity, '--expect-sha256', t.sumsFile];
  await assert.rejects(t.run([...base, '--update', 'core']), /testnet registers a committed set: pass --set mainnet/);
  await assert.rejects(t.run([...base, '--set', 'devnet']), /testnet registers the four-contract set \(--set mainnet\); the three-contract set is for devnets/);
  // a devnet record that holds a forge-meta (or says contractsSet mainnet) is a mainnet-set record
  writeFileSync(join(t.deploymentsRoot, 'devnet-test.json'), JSON.stringify({ network: 'devnet', devnetName: 'test', v2: { contractsSet: 'mainnet', forgeCore: { contractId: 'X' } } }));
  const devnet = ['--network', 'devnet', '--devnet-name', 'test', '--identity', t.identity];
  await assert.rejects(t.run([...devnet, '--set', 'devnet']), /was registered from the "mainnet" set; --set devnet would register or update a different set/);
  await assert.rejects(t.run(devnet), /was registered from the "mainnet" set/);
  // the same footgun without the field: a forge-meta in the record is enough
  writeFileSync(join(t.deploymentsRoot, 'devnet-test.json'), JSON.stringify({ v2: { forgeMeta: { contractId: 'M' } } }));
  await assert.rejects(t.run([...devnet, '--update', 'core']), /was registered from the "mainnet" set/);
  // a record of another network
  writeFileSync(join(t.deploymentsRoot, 'devnet-test.json'), JSON.stringify({ network: 'testnet' }));
  await assert.rejects(t.run(devnet), /records network testnet, not devnet/);
  assert.equal(recordedSet(JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'deployments', 'devnet-sakura.json'), 'utf8'))), 'mainnet', 'sakura runs the four-contract set since rel2 (2026-10-17)');
});

test('a devnet record moves to another set only with --force-new for the whole set', async () => {
  const t = setup();
  t.fake.state.chainId = 'dash-devnet-test';
  const devnet = ['--network', 'devnet', '--devnet-name', 'test', '--identity', t.identity];
  await t.run(devnet);
  const old = t.read('devnet-test.json');
  assert.equal(old.v2.contractsSet, 'devnet');
  await assert.rejects(t.run([...devnet, '--set', 'mainnet']), /registered from the "devnet" set; --set mainnet would .*or --force-new without --only/);
  await assert.rejects(t.run([...devnet, '--set', 'mainnet', '--force-new', '--only', 'meta', '--same-group']), /registered from the "devnet" set/);
  await t.run([...devnet, '--set', 'mainnet', '--force-new']);
  const rec = t.read('devnet-test.json');
  assert.equal(rec.v2.contractsSet, 'mainnet');
  for (const key of ['forgeCore', 'forgeCollab', 'forgeCommunity']) {
    assert.equal(rec.v2[`${key}Superseded`].at(-1).contractId, old.v2[key].contractId, key);
    assert.notEqual(rec.v2[key].contractId, old.v2[key].contractId, key);
  }
  assert.equal(rec.v2.forgeMeta.status, 'registered');
  assert.equal(rec.v2.contractGroupSuperseded.at(-1).id, old.v2.contractGroupId);
  assert.notEqual(rec.v2.contractGroupId, old.v2.contractGroupId);
  // the same deployer on the same chain: one ledger, nonces 1-3 then 4-7
  assert.deepEqual(rec.v2.nonceLedger.map((e) => e.identityNonce), ['1', '2', '3', '4', '5', '6', '7']);
  assert.equal(rec.v2.forgeCore.identityNonce, '4');
  // the old set is not a set the record can go back to without another --force-new
  await assert.rejects(t.run([...devnet, '--set', 'devnet']), /registered from the "mainnet" set/);
});

/** A devnet record shaped like sakura's before its switch: the devnet set, no ledger, no deployer block, no
 * contractsSet, and the deployer's nonce 4 spent outside the record (the key-exchange copy). */
async function sakuraShaped() {
  const t = setup();
  t.fake.state.chainId = 'dash-devnet-test';
  const devnet = ['--network', 'devnet', '--devnet-name', 'test', '--identity', t.identity];
  await t.run(devnet);
  const d = t.read('devnet-test.json');
  for (const k of ['nonceLedger', 'deployer', 'restores', 'contractsSet']) delete d.v2[k];
  d.keyExchange = { contractId: 'KX', ownerId: t.fake.ownerId, identityNonce: '4' };
  writeFileSync(join(t.deploymentsRoot, 'devnet-test.json'), JSON.stringify(d, null, 2));
  t.fake.state.identities.get(t.fake.ownerId).nonce = 4n;
  return { t, old: d, switchArgs: [...devnet, '--set', 'mainnet', '--force-new'] };
}

test('sakura\'s switch: a ledger-less devnet record moves to the mainnet set at the next nonces', async () => {
  const { t, old, switchArgs } = await sakuraShaped();
  await t.run(switchArgs);
  const rec = t.read('devnet-test.json');
  assert.equal(rec.v2.contractsSet, 'mainnet');
  KEYS.forEach((key, i) => {
    assert.equal(rec.v2[key].identityNonce, String(5 + i), key);
    assert.equal(rec.v2[key].contractId, contractId(t.fake.ownerId, BigInt(5 + i)), key);
  });
  assert.equal(rec.v2.contractGroupId, contractGroupId(t.fake.ownerId, 5n));
  assert.deepEqual(rec.v2.nonceLedger.map((e) => [e.identityNonce, e.status]), [['5', 'registered'], ['6', 'registered'], ['7', 'registered'], ['8', 'registered']]);
  assert.equal(rec.v2.forgeCoreSuperseded.at(-1).contractId, old.v2.forgeCore.contractId);
  assert.deepEqual(rec.keyExchange, old.keyExchange);
  assert.deepEqual(recordProblems({ name: 'devnet-test', dep: rec }), []);
});

test('a set switch that crashed part way finishes on a rerun of the same command', async () => {
  const { t, old, switchArgs } = await sakuraShaped();
  t.fake.failIn(2, 'before'); // forge-collab's create never lands
  await assert.rejects(t.run(switchArgs));
  const mid = t.read('devnet-test.json');
  assert.equal(mid.v2.contractsSet, 'mainnet', 'the set is named before the first create');
  assert.equal(mid.v2.forgeCore.status, 'registered');
  await t.run(switchArgs);
  const rec = t.read('devnet-test.json');
  assert.equal(rec.v2.forgeCore.contractId, mid.v2.forgeCore.contractId, 'the landed forge-core is kept, not superseded again');
  assert.equal(rec.v2.forgeCoreSuperseded.length, 1);
  assert.equal(rec.v2.forgeCoreSuperseded[0].contractId, old.v2.forgeCore.contractId);
  for (const key of KEYS) assert.equal(rec.v2[key].status, 'registered', key);
  assert.deepEqual(recordProblems({ name: 'devnet-test', dep: rec }), []);
});

test('a production record never switches sets, even with --force-new --abandon-live-set', async () => {
  // a testnet record holding only the three contracts (inferred "devnet"): the set guard refuses before anything connects
  const seed = { ...TESTNET_SEED, v2: { forgeCore: { contractId: 'X', ownerId: 'O', status: 'registered' } } };
  const t = setup({ seed });
  await assert.rejects(t.run(t.prod('--force-new', '--abandon-live-set', 'testnet')), /registered from the "devnet" set; --set mainnet would register or update a different set into it\. Use --set devnet, or a scratch --record for another set\.$/);
  assert.equal(t.fake.state.broadcasts, 0);
});

test('--force-new on the live testnet record needs --abandon-live-set testnet', async () => {
  const t = setup();
  await t.run(t.prod());
  // the recorded forge-core was registered from another schema: --force-new would supersede the set
  const tampered = t.read();
  tampered.v2.forgeCore.schemaHash = '0'.repeat(64);
  writeFileSync(t.testnetFile, JSON.stringify(tampered, null, 2));
  const broadcasts = t.fake.broadcasts;
  const before = t.raw();
  await assert.rejects(t.run(t.prod('--force-new')), /--force-new on testnet supersedes the live contract set.*--abandon-live-set testnet/s);
  await assert.rejects(t.run(t.prod('--force-new', '--abandon-live-set', 'mainnet')), /--abandon-live-set testnet/);
  await assert.rejects(t.run(t.prod('--force-new', '--dry-run')), /--abandon-live-set testnet/, 'a dry run previews the same act');
  await assert.rejects(t.run(t.prod('--only', 'collab', '--force-new', '--same-group')), /--abandon-live-set testnet/);
  await assert.rejects(t.run(t.prod('--abandon-live-set', 'testnet')), /goes with --force-new/);
  assert.equal(t.fake.broadcasts, broadcasts);
  assert.equal(t.raw(), before);
  await t.run(t.prod('--force-new', '--abandon-live-set', 'testnet'));
  const rec = t.read();
  assert.equal(t.fake.broadcasts, broadcasts + 4);
  assert.equal(rec.v2.forgeCoreSuperseded.length, 1);
  assert.equal(rec.v2.forgeCoreSuperseded[0].contractId, contractId(t.fake.ownerId, 1n));
  assert.equal(rec.v2.forgeCore.identityNonce, '5');
  assert.equal(rec.v2.contractGroupSuperseded.length, 1);
  assert.equal(rec.v2.forgeMetaSuperseded.length, 1);
  // the superseded contracts keep their create entries, marked
  const old = rec.v2.nonceLedger.filter((e) => e.supersededAt);
  assert.deepEqual(old.map((e) => e.key), KEYS);
  assert.equal(rec.v2.nonceLedger.length, 8);
});

test('--force-new on a scratch record has no guard', async () => {
  const t = setup();
  const scratch = join(t.dir, 'scratch', 'rehearsal.json');
  const argv = ['--network', 'testnet', '--set', 'mainnet', '--identity', t.identity, '--record', scratch, '--scratch-on', 'testnet'];
  await t.run([...argv, '--force-new']);
  const rec = JSON.parse(readFileSync(scratch, 'utf8'));
  assert.equal(rec.v2.contractsSet, 'mainnet');
  assert.equal(rec.v2.scratchOn, 'testnet', 'a committed-set rehearsal is stamped as scratch for the live suites');
  assert.equal(scratchStampError(rec), null);
  assert.deepEqual(t.read(), TESTNET_SEED, 'the live testnet record is untouched');
  // a scratch record may not be under deployments/
  await assert.rejects(t.run([...argv.slice(0, 7), join(t.deploymentsRoot, 'rehearsal.json'), ...argv.slice(8)]), /scratch record lives outside/);
});

test('a record of another chain stops the run before anything is broadcast', async () => {
  const t = setup();
  await t.run(t.prod());
  t.fake.reset('dash-testnet-52');
  const broadcasts = t.fake.broadcasts;
  const before = t.raw();
  await assert.rejects(
    t.run(t.prod()),
    /records chain dash-testnet-51 but the network reports dash-testnet-52: Platform was reset.*deploy-v2\.mjs --replay.*--force-new --abandon-live-set testnet.*Nothing was broadcast/s
  );
  await assert.rejects(t.run(t.prod('--update', 'core')), /records chain dash-testnet-51/);
  assert.equal(t.fake.broadcasts, broadcasts);
  assert.equal(t.raw(), before);
  // the way out the message names: --force-new --abandon-live-set abandons the old chain's set
  await assert.rejects(t.run(t.prod('--force-new')), /--abandon-live-set testnet/);
  await assert.rejects(t.run(t.prod('--only', 'meta', '--force-new', '--same-group', '--abandon-live-set', 'testnet')), /--only cannot move a set to another chain/);
  await t.run(t.prod('--force-new', '--abandon-live-set', 'testnet'));
  const rec = t.read();
  assert.equal(rec.chainId, 'dash-testnet-52');
  assert.equal(rec.v2.forgeCoreSuperseded.length, 1);
  assert.equal(rec.v2.nonceLedgerSuperseded.length, 1);
  assert.equal(rec.v2.nonceLedgerSuperseded[0].chainId, 'dash-testnet-51');
  assert.equal(rec.v2.nonceLedgerSuperseded[0].entries.length, 4);
  assert.deepEqual(rec.v2.nonceLedger.map((e) => [e.identityNonce, e.status]), [['1', 'registered'], ['2', 'registered'], ['3', 'registered'], ['4', 'registered']]);
});

test('a node whose proof and status name different chains is refused before any broadcast', async () => {
  const t = setup();
  t.fake.state.proofChainId = 'dash-testnet-99';
  await assert.rejects(t.run(t.prod()), /proved chain id dash-testnet-99 differs from the node's status dash-testnet-51/);
  assert.equal(t.fake.broadcasts, 0);
  assert.deepEqual(t.read(), TESTNET_SEED);
});

test('a devnet record of another chain says to move it aside', async () => {
  const t = setup();
  writeFileSync(join(t.deploymentsRoot, 'devnet-test.json'), JSON.stringify({ network: 'devnet', devnetName: 'test', chainId: 'dash-devnet-test-old' }));
  t.fake.state.chainId = 'dash-devnet-test';
  await assert.rejects(t.run(['--network', 'devnet', '--devnet-name', 'test', '--identity', t.identity]), /Move the record aside to start over/);
});

test('a contract group with an admin is refused at verification', async () => {
  const t = setup();
  t.fake.forceAdmins(['4tQsgYvZ1sqsDVHcDXKs5jPYMRLApjrQhB45sRX7L7Wj']);
  await assert.rejects(t.run(t.prod()), /contract group \w+ has admins 4tQsg.*Forge clients refuse a group with admins/);
});

test('production preconditions: each refusal names its cause and nothing is broadcast', async () => {
  const cases = [
    ['a dirty tree', (t) => { t.git.porcelain = () => ' M forge-contracts/contracts/mainnet/forge-meta.json'; }, /the set's files differ from git HEAD; commit them first: what is registered must be in git/],
    ['a stale build', (t) => { t.git.buildCheck = () => ({ ok: false, output: 'stale: forge-contracts/contracts/mainnet/forge-core.json' }); }, /contracts\/mainnet is not the current build \(build\.py --check failed\); regenerate and commit it/],
    ['git without a HEAD', (t) => { t.git.head = () => { throw new Error('not a git repository'); }; }, /git cannot report HEAD/],
    ['no --expect-sha256', (t, argv) => argv.filter((a) => a !== '--expect-sha256' && a !== t.sumsFile), /--expect-sha256 <file> is required to register on testnet/],
    ['a wrong sum', (t) => { const sums = setSums(SETS.mainnet); sums['forge-meta.json'] = '0'.repeat(64); writeFileSync(t.sumsFile, formatSums(sums)); }, /forge-meta\.json: sha256 \w+… is not the signed 000000000000…/],
    ['a missing sum', (t) => { const sums = setSums(SETS.mainnet); delete sums['forge-community.json']; writeFileSync(t.sumsFile, formatSums(sums)); }, /forge-community\.json: no sum in --expect-sha256/],
    ['an extra sum', (t) => { writeFileSync(t.sumsFile, `${formatSums(setSums(SETS.mainnet))}${'1'.repeat(64)}  forge-extra.json\n`); }, /forge-extra\.json: signed, but not a file of this set/],
    ['a transition without room', (t) => { t.fake.state.sizeOf = (kind, json) => (json.documentSchemas.repoKey ? MAX - 1780 : 10_000); }, /forge-meta: create transition 18,700 B leaves 1,780 B of room, under the 2,000 B floor \(D44\)/],
  ];
  for (const [name, arrange, expected] of cases) {
    const t = setup();
    const argv = arrange(t, t.prod()) ?? t.prod();
    await assert.rejects(t.run(argv), expected, name);
    assert.equal(t.fake.broadcasts, 0, `${name}: nothing was broadcast`);
    assert.deepEqual(t.read(), TESTNET_SEED, `${name}: the record is untouched`);
  }
});

test('a transition without room is refused before the first contract is broadcast', async () => {
  const t = setup();
  // forge-meta is last: a per-contract check would already have registered three
  t.fake.state.sizeOf = (kind, json) => (json.documentSchemas.repoKey ? MAX - 100 : 10_000);
  await assert.rejects(t.run(t.prod()), /forge-meta: create transition/);
  assert.equal(t.fake.broadcasts, 0);
});

test('on a devnet the same preconditions are warnings', async () => {
  const t = setup();
  t.git.porcelain = () => ' M forge-contracts/contracts/mainnet/forge-meta.json';
  t.git.buildCheck = () => ({ ok: false, output: 'stale' });
  t.fake.state.sizeOf = (kind, json) => (json.documentSchemas.repoKey ? MAX - 100 : 10_000);
  t.fake.state.chainId = 'dash-devnet-test';
  await t.run(['--network', 'devnet', '--devnet-name', 'test', '--set', 'mainnet', '--identity', t.identity]);
  const rec = t.read('devnet-test.json');
  assert.equal(rec.v2.forgeMeta.status, 'registered');
  assert.equal(rec.network, 'devnet');
  assert.equal(rec.devnetName, 'test');
  assert.equal(rec.chainId, 'dash-devnet-test');
  for (const w of [/WARNING the set's files differ from git HEAD/, /WARNING .*is not the current build/, /WARNING forge-meta: create transition .* under the 2,000 B floor/]) {
    assert.ok(t.logs.some((l) => w.test(l)), String(w));
  }
  // the devnet default set is the three contracts
  const t3 = setup();
  t3.fake.state.chainId = 'dash-devnet-test';
  await t3.run(['--network', 'devnet', '--devnet-name', 'test', '--identity', t3.identity]);
  const rec3 = t3.read('devnet-test.json');
  assert.equal(rec3.v2.contractsSet, 'devnet');
  assert.equal(rec3.v2.forgeMeta, undefined);
  assert.equal(rec3.v2.contractGroup.description, 'Dash Forge v2: forge-core, forge-collab and forge-community');
  assert.deepEqual(t3.fake.state.sdkOptions[0].devnetName, 'test');
});

test('--dry-run writes nothing and prints the sums and the room per contract', async () => {
  const t = setup();
  const before = t.raw();
  // even a dirty tree and no signed sums only warn in a dry run
  t.git.porcelain = () => ' M x';
  await t.run(['--network', 'testnet', '--set', 'mainnet', '--identity', t.identity, '--dry-run']);
  assert.equal(t.raw(), before);
  assert.equal(t.fake.broadcasts, 0);
  const report = JSON.parse(t.out.join(''));
  assert.deepEqual(report.sha256, setSums(SETS.mainnet));
  assert.equal(report.steps.length, 4);
  for (const s of report.steps) {
    assert.equal(s.dryRun, true);
    assert.equal(s.roomBytes, MAX - s.sizeBytes);
  }
  assert.deepEqual(report.steps.map((s) => s.nonce), ['1', '2', '3', '4']);
  for (const [file, hex] of Object.entries(setSums(SETS.mainnet))) assert.ok(t.logs.some((l) => l.includes(`${hex}  ${file}`)), file);
  assert.ok(t.logs.some((l) => /WARNING the set's files differ/.test(l)));
});

test('--dry-run on a registered record changes nothing, even to reconcile a reservation', async () => {
  const t = setup();
  t.fake.failNext('after');
  await assert.rejects(t.run(t.prod()), /timed out/);
  const before = t.raw();
  await t.run([...t.prod(), '--dry-run']);
  assert.equal(t.raw(), before);
});

test('--print-sha256 prints the sums the owner signs and registers nothing', async () => {
  const t = setup();
  await t.run(['--print-sha256', '--set', 'mainnet']);
  assert.deepEqual(parseSums(t.out.join('')), setSums(SETS.mainnet));
  assert.deepEqual(Object.keys(parseSums(t.out.join(''))), ['forge-core.json', 'forge-collab.json', 'forge-community.json', 'forge-meta.json']);
  assert.equal(t.fake.state.sdkOptions.length, 0);
});

test('--update core on a production record: the contract-nonce ledger entry, registeredSchemaHash kept', async () => {
  const t = setup();
  await t.run(t.prod());
  const registered = t.read().v2.forgeCore;
  // pretend the chain holds an older schema than the committed file
  const tampered = t.read();
  tampered.v2.forgeCore.schemaHash = '0'.repeat(64);
  writeFileSync(t.testnetFile, JSON.stringify(tampered, null, 2));
  await t.run(t.prod('--update', 'core'));
  const rec = t.read();
  assert.equal(rec.v2.forgeCore.version, 2);
  assert.equal(rec.v2.forgeCore.schemaHash, registered.schemaHash);
  assert.equal(rec.v2.forgeCore.registeredSchemaHash, registered.schemaHash);
  assert.equal(rec.v2.forgeCore.updates.length, 1);
  assert.equal(rec.v2.forgeCore.updates[0].sourceSha256, registered.sourceSha256);
  const update = rec.v2.nonceLedger.at(-1);
  assert.deepEqual({ kind: update.kind, key: update.key, contractNonce: update.contractNonce, version: update.version, status: update.status, previousSchemaHash: update.previousSchemaHash },
    { kind: 'dataContractUpdate', key: 'forgeCore', contractNonce: '1', version: 2, status: 'updated', previousSchemaHash: '0'.repeat(64) });
  assert.equal(rec.v2.nonceLedger.length, 5);
  // an update needs the same production preconditions
  t.git.porcelain = () => ' M x';
  await assert.rejects(t.run(t.prod('--update', 'core')), /differ from git HEAD/);
});

test('--update refuses a record of the other set', async () => {
  const t = setup();
  await t.run(t.prod());
  // the footgun: the live four-contract record updated from the three-contract files
  writeFileSync(join(t.deploymentsRoot, 'devnet-test.json'), JSON.stringify({ ...t.read(), network: 'devnet', devnetName: 'test' }));
  await assert.rejects(t.run(['--network', 'devnet', '--devnet-name', 'test', '--identity', t.identity, '--update', 'core']), /registered from the "mainnet" set/);
});

test('the self-test passes for both committed sets', async () => {
  const t = setup();
  await t.run(['--self-test']);
  await t.run(['--self-test', '--contracts', SETS.mainnet]);
  assert.ok(t.logs.some((l) => /sums self-test: ok \(4 files\)/.test(l)));
  assert.ok(!existsSync(join(t.deploymentsRoot, 'devnet-sakura.json')));
});

test('flag errors', async () => {
  const t = setup();
  await assert.rejects(t.run(['--set', 'mainnet', '--contracts', SETS.mainnet, '--identity', t.identity]), /pass only one of them/);
  await assert.rejects(t.run(['--set', 'prod', '--identity', t.identity]), /--set accepts "devnet" or "mainnet"/);
  await assert.rejects(t.run(['--set', '--identity', t.identity]), /--set takes a value/);
  await assert.rejects(t.run(t.prod('--acknowledge-nonce', 'x', '--note', 'n')), /--acknowledge-nonce takes an identity nonce/);
});

test('a bare --contracts is a scratch set even when it names a committed directory', async () => {
  const t = setup();
  await t.run(t.prod());
  const before = t.raw();
  const broadcasts = t.fake.broadcasts;
  // the footgun: the live four-contract record updated from the three-contract files
  for (const dir of [SETS.devnet, SETS.mainnet]) {
    await assert.rejects(t.run(['--network', 'testnet', '--identity', t.identity, '--contracts', dir, '--update', 'core', '--expect-sha256', t.sumsFile]), /registers a scratch set: name its record with --record/);
    await assert.rejects(t.run(['--network', 'testnet', '--identity', t.identity, '--contracts', dir]), /registers a scratch set/);
  }
  await assert.rejects(t.run(['--network', 'devnet', '--identity', t.identity, '--contracts', SETS.devnet]), /registers a scratch set/);
  assert.equal(t.fake.broadcasts, broadcasts);
  assert.equal(t.raw(), before);
  // with its own record (and its own deployer) it is a scratch registration and leaves the live record alone
  const t2 = setup();
  const scratch = join(t2.dir, 'scratch.json');
  await t2.run(['--network', 'testnet', '--identity', t2.identity, '--contracts', SETS.mainnet, '--record', scratch, '--scratch-on', 'testnet']);
  assert.equal(JSON.parse(readFileSync(scratch, 'utf8')).v2.contractsDir, 'forge-contracts/contracts/mainnet');
  assert.deepEqual(t2.read(), TESTNET_SEED);
});

test('the first registration on the live record stops on nonces the deployer already spent', async () => {
  const t = setup();
  t.fake.externalTransition(2);
  await assert.rejects(t.run(t.prod()), /identity nonce is 2 on chain but the ledger ends at 0.*--acknowledge-nonce 1 --acknowledge-nonce 2 --note/s);
  assert.equal(t.fake.broadcasts, 0);
  assert.deepEqual(t.read(), TESTNET_SEED);
  await t.run(t.prod('--acknowledge-nonce', '1,2', '--note', 'identity top-ups during minting'));
  const rec = t.read();
  assert.equal(rec.v2.forgeCore.identityNonce, '3');
  assert.deepEqual(rec.v2.nonceLedger.slice(0, 2).map((e) => [e.identityNonce, e.kind]), [['1', 'external'], ['2', 'external']]);
  // a devnet record without a ledger is not held to this
  const t2 = setup();
  t2.fake.state.chainId = 'dash-devnet-test';
  t2.fake.externalTransition(2);
  await t2.run(['--network', 'devnet', '--devnet-name', 'test', '--identity', t2.identity]);
  assert.equal(t2.read('devnet-test.json').v2.forgeCore.identityNonce, '3');
});

test('a scratch registration on testnet may not use the live deployer', async () => {
  const t = setup();
  await t.run(t.prod());
  const before = t.raw();
  const broadcasts = t.fake.broadcasts;
  await assert.rejects(
    t.run(['--network', 'testnet', '--set', 'mainnet', '--identity', t.identity, '--record', join(t.dir, 'rehearsal.json'), '--scratch-on', 'testnet']),
    /is recorded in deployments\/testnet\.json \(v2\.forgeCore\.ownerId\); a scratch registration on testnet uses its own throwaway deployer identity/
  );
  assert.equal(t.fake.broadcasts, broadcasts);
  assert.equal(t.raw(), before);
});

test('a scratch registration on testnet or mainnet names the network (L6)', async () => {
  const t = setup();
  const scratch = join(t.dir, 'scratch', 'rehearsal.json');
  const argv = ['--network', 'testnet', '--set', 'mainnet', '--identity', t.identity, '--record', scratch];
  // without the flag, with the wrong network, and as a dry run: refused before anything connects
  for (const extra of [[], ['--scratch-on', 'mainnet'], ['--dry-run']]) {
    await assert.rejects(t.run([...argv, ...extra]), /registers a SCRATCH set on testnet.*never the production deployer.*re-run with --scratch-on testnet.*Nothing was broadcast/s);
  }
  await assert.rejects(t.run([...argv, '--scratch-on']), /--scratch-on takes a value/);
  assert.equal(t.fake.broadcasts, 0);
  assert.equal(existsSync(scratch), false);
  // with it: allowed, loudly
  t.logs.length = 0;
  await t.run([...argv, '--scratch-on', 'testnet']);
  assert.equal(JSON.parse(readFileSync(scratch, 'utf8')).v2.forgeCore.ownerId, t.fake.ownerId);
  assert.ok(t.logs.some((m) => /WARNING SCRATCH registration on testnet.*must NEVER use the production deployer/.test(m)));
  assert.ok(t.logs.some((m) => /records no deployer yet, so .* cannot be checked/.test(m)), 'an empty live record cannot vouch for the identity');
  // the flag does not belong anywhere else: the live record, or a devnet
  await assert.rejects(t.run(t.prod('--scratch-on', 'testnet')), /--scratch-on testnet goes with a scratch --record on testnet or mainnet; this run writes the live testnet record/);
  await assert.rejects(t.run(['--network', 'devnet', '--devnet-name', 'test', '--identity', t.identity, '--scratch-on', 'testnet']), /goes with a scratch --record on testnet or mainnet; this run/);
});

test('a scratch registration refuses any identity the live record names, and passes another', async () => {
  const OTHER = b58encode(Buffer.alloc(32, 7));
  const scratchArgs = (t) => ['--network', 'testnet', '--set', 'mainnet', '--identity', t.identity, '--record', join(t.dir, 'rehearsal.json'), '--scratch-on', 'testnet'];
  // the identity is a superseded deployer, a contract owner or the key-exchange owner of the live record: refused
  const probe = setup();
  const mine = probe.fake.ownerId;
  const seeds = {
    'a superseded deployer': { ...TESTNET_SEED, v2: { deployer: { identityId: OTHER }, deployerSuperseded: [{ identityId: mine }] } },
    'a contract owner': { ...TESTNET_SEED, v2: { deployer: { identityId: OTHER }, forgeCollab: { ownerId: mine } } },
    'the group owner': { ...TESTNET_SEED, v2: { contractGroup: { owner: mine } } },
    'an archived ledger\'s deployer': { ...TESTNET_SEED, v2: { nonceLedgerSuperseded: [{ chainId: 'dash-testnet-50', deployer: mine, entries: [] }] } },
    'a group admin': { ...TESTNET_SEED, v2: { contractGroup: { owner: OTHER, admins: [mine] } } },
    'the key-exchange owner': { ...TESTNET_SEED, keyExchange: { ...TESTNET_SEED.keyExchange, ownerId: mine } },
  };
  for (const [what, seed] of Object.entries(seeds)) {
    const t = setup({ seed });
    await assert.rejects(t.run(scratchArgs(t)), /is recorded in deployments\/testnet\.json \(.*\); a scratch registration on testnet uses its own throwaway deployer/, what);
    assert.equal(t.fake.broadcasts, 0, what);
  }
  // a live record that names another deployer: a different identity may rehearse, with the warning but not the "no deployer yet" one
  const t = setup({ seed: { ...TESTNET_SEED, v2: { deployer: { identityId: OTHER } } } });
  await t.run(scratchArgs(t));
  assert.ok(t.logs.some((m) => /WARNING SCRATCH registration on testnet/.test(m)));
  assert.ok(!t.logs.some((m) => /records no deployer yet/.test(m)));
  assert.equal(t.read().v2.deployer.identityId, OTHER, 'the live record is untouched');
});

test('a recorded group is checked before anything new enrols in it', async () => {
  const t = setup();
  await t.run(t.prod());
  const group = t.read().v2.contractGroupId;
  // a dry run and a rerun still verify cleanly
  await t.run([...t.prod(), '--dry-run']);
  // the group gains an admin on chain; forge-meta is re-registered into it
  t.fake.state.groups.get(group).adminIds = ['4tQsgYvZ1sqsDVHcDXKs5jPYMRLApjrQhB45sRX7L7Wj'];
  const tampered = t.read();
  tampered.v2.forgeMeta.schemaHash = '0'.repeat(64);
  writeFileSync(t.testnetFile, JSON.stringify(tampered, null, 2));
  const broadcasts = t.fake.broadcasts;
  await assert.rejects(t.run(t.prod('--only', 'meta', '--force-new', '--same-group', '--abandon-live-set', 'testnet')), /contract group \w+ has admins/);
  assert.equal(t.fake.broadcasts, broadcasts, 'refused before the broadcast, not after');
  // a changed description is compared with the one the group was registered with, not the code's
  t.fake.state.groups.get(group).adminIds = [];
  t.fake.state.groups.get(group).description = 'something else';
  await assert.rejects(t.run(t.prod()), /has description "something else", not "Dash Forge v2: forge-core, forge-collab, forge-community and forge-meta"/);
  const kept = t.read();
  kept.v2.contractGroup.description = 'something else';
  writeFileSync(t.testnetFile, JSON.stringify(kept, null, 2));
  await t.run(t.prod());
});

test('a malformed --deployer-created-height or a stray --note is refused before connecting', async () => {
  const t = setup();
  await assert.rejects(t.run(t.prod('--deployer-created-height', '623,900')), /--deployer-created-height takes the block height/);
  await assert.rejects(t.run(t.prod('--deployer-created-height', '0')), /--deployer-created-height takes the block height/);
  await assert.rejects(t.run(t.prod('--note', 'because')), /--note goes with --acknowledge-nonce/);
  assert.equal(t.fake.state.sdkOptions.length, 0, 'nothing connected');
});

test('a reservation the chain passed is named in the nonce refusal', async () => {
  const t = setup();
  t.fake.failNext('before');
  await assert.rejects(t.run(t.prod()), /connection lost/);
  t.fake.externalTransition();
  const reserved = t.read().v2.forgeCore.contractId;
  await assert.rejects(t.run(t.prod()), new RegExp(`reserved forgeCore ${reserved} did land and is not visible yet`));
});

test('a lagging node: a stale identity nonce is refused, never trusted, and the rerun registers the next one', async () => {
  // the stale answer after forge-core landed (nonce 0) would reserve forge-collab at forge-core's own id
  const t = setup();
  t.fake.lagAfter(1);
  await assert.rejects(t.run(t.prod()), /forgeCollab: the node reports the deployer's identity nonce as 0, but the record shows nonce 1 signed: the node is behind.*Nothing was broadcast/s);
  let rec = t.read();
  assert.equal(t.fake.broadcasts, 1);
  assert.equal(rec.v2.forgeCore.status, 'registered');
  assert.equal(rec.v2.forgeCollab, undefined, 'nothing was reserved from the stale nonce');
  assert.deepEqual(rec.v2.nonceLedger.map((e) => e.identityNonce), ['1']);
  t.fake.catchUp();
  await t.run(t.prod());
  rec = t.read();
  assert.deepEqual(KEYS.map((k) => rec.v2[k].identityNonce), ['1', '2', '3', '4']);
  assert.equal(new Set(KEYS.map((k) => rec.v2[k].contractId)).size, 4);
  // the same after forge-community (nonce 3): forge-meta is never reserved at forge-community's id
  const t2 = setup();
  t2.fake.lagAfter(3);
  await assert.rejects(t2.run(t2.prod()), /forgeMeta: the node reports the deployer's identity nonce as 2, but the record shows nonce 3 signed/);
  assert.equal(t2.read().v2.forgeMeta, undefined);
  t2.fake.catchUp();
  await t2.run(t2.prod());
  assert.equal(t2.read().v2.forgeMeta.contractId, contractId(t2.fake.ownerId, 4n));
  // a node that catches up while the run waits is used
  const t3 = setup();
  t3.fake.lagAfter(1);
  const RealSdk = t3.fake.evo.EvoSDK;
  let asked = 0;
  const evo = { ...t3.fake.evo, EvoSDK: class extends RealSdk { constructor(o) { super(o); const real = this.identities.nonce; this.identities.nonce = async (id) => { if (t3.fake.state.lag && ++asked > 1) t3.fake.catchUp(); return real(id); }; } } };
  await t3.run(t3.prod(), { evo });
  assert.deepEqual(KEYS.map((k) => t3.read().v2[k].identityNonce), ['1', '2', '3', '4']);
});

test('a reservation is completed only with its own contract: another record\'s id, or another schema, is refused', async () => {
  // the record the stale nonce wrote before the fix: forge-meta reserved at forge-community's nonce
  const t = setup();
  await t.run(t.prod());
  const good = t.read();
  const bad = structuredClone(good);
  const community = bad.v2.forgeCommunity;
  bad.v2.forgeMeta = { ...bad.v2.forgeMeta, contractId: community.contractId, identityNonce: community.identityNonce, status: 'broadcasting' };
  bad.v2.nonceLedger[3] = { ...bad.v2.nonceLedger[3], contractId: community.contractId, identityNonce: community.identityNonce, status: 'broadcasting' };
  writeFileSync(t.testnetFile, JSON.stringify(bad, null, 2));
  const before = t.raw();
  const broadcasts = t.fake.broadcasts;
  // (forge-community, reconciled first, is refused: both records claim one id)
  await assert.rejects(t.run(t.prod()), new RegExp(`forgeCommunity: the record names ${community.contractId}, which v2\\.forgeMeta and the ledger's forgeMeta create at nonce 3 also names: one nonce was reserved for two contracts`));
  assert.equal(t.raw(), before);
  // forge-meta reserved at its own nonce, but the contract there is of another schema
  const other = structuredClone(good);
  other.v2.forgeMeta = { ...other.v2.forgeMeta, status: 'broadcasting', documentsHash: '0'.repeat(64) };
  other.v2.nonceLedger[3].status = 'broadcasting';
  writeFileSync(t.testnetFile, JSON.stringify(other, null, 2));
  await assert.rejects(t.run(t.prod()), /forgeMeta: \w+ is on chain, but its schema \(\w+…\) is not the reservation's \(000000000000…\): it is not the contract this reservation broadcast/);
  // a reservation without its own documentsHash, of another schema than the current one, cannot be shown to be it
  delete other.v2.forgeMeta.documentsHash;
  other.v2.forgeMeta.schemaHash = '1'.repeat(64);
  writeFileSync(t.testnetFile, JSON.stringify(other, null, 2));
  await assert.rejects(t.run(t.prod()), /the reservation records no schema it can be compared with/);
  // one of the current schema without the field is completed as before
  other.v2.forgeMeta.schemaHash = good.v2.forgeMeta.schemaHash;
  writeFileSync(t.testnetFile, JSON.stringify(other, null, 2));
  await t.run(t.prod());
  assert.equal(t.read().v2.forgeMeta.status, 'registered');
  assert.equal(t.fake.broadcasts, broadcasts);
});

test('the ledger never rewrites a settled entry at the nonce a transition reserves', async () => {
  const t = setup();
  await t.run(t.prod());
  // a ledger that says an update of forge-core at contract nonce 1 landed, which the chain does not show
  const rec = t.read();
  rec.v2.forgeCore.schemaHash = '0'.repeat(64);
  rec.v2.nonceLedger.push({ contractNonce: '1', kind: 'dataContractUpdate', key: 'forgeCore', contractId: rec.v2.forgeCore.contractId, version: 2, status: 'updated', at: 'x' });
  writeFileSync(t.testnetFile, JSON.stringify(rec, null, 2));
  const before = t.raw();
  const broadcasts = t.fake.broadcasts;
  await assert.rejects(t.run(t.prod('--update', 'core')), /forgeCore: the ledger already holds a updated dataContractUpdate at contractNonce 1; a reservation never rewrites a settled entry/);
  assert.equal(t.fake.broadcasts, broadcasts);
  assert.equal(t.raw(), before);
});

test('--acknowledge-nonce refuses a nonce that created a contract: it was a create, not an external transition', async () => {
  const t = setup();
  t.fake.failNext('after');
  await assert.rejects(t.run(t.prod()), /timed out/);
  // a record that lost forge-core's reservation: the chain's nonce 1 is unexplained
  const rec = t.read();
  delete rec.v2.forgeCore;
  rec.v2.nonceLedger = [];
  writeFileSync(t.testnetFile, JSON.stringify(rec, null, 2));
  const before = t.raw();
  await assert.rejects(t.run(t.prod()), /--acknowledge-nonce 1 --note/);
  await assert.rejects(t.run(t.prod('--acknowledge-nonce', '1', '--note', 'a key change')), new RegExp(`--acknowledge-nonce 1: identity nonce 1 created contract ${contractId(t.fake.ownerId, 1n)}.*so it is no external transition`, 's'));
  assert.equal(t.raw(), before);
  assert.equal(t.fake.broadcasts, 1);
});

test('a new deployer after a reset: v2.deployer is its own, the old one archived', async () => {
  const t = setup();
  await t.run(t.prod('--deployer-created-height', '100'));
  const old = t.read().v2.deployer;
  // Platform resets; the owner mints a new deployer (new id, new asset lock) and abandons the old set
  const f2 = createFakePlatform({ chainId: 'dash-testnet-52', identityFile: fakeIdentityFile({ identityId: b58encode(Buffer.alloc(32, 5)), txid: 'cd'.repeat(32) }) });
  const dir2 = mkdtempSync(join(tmpdir(), 'deploy-v2-test-id2-'));
  dirs.push(dir2);
  const identity2 = f2.writeIdentity(dir2);
  await t.run(['--network', 'testnet', '--set', 'mainnet', '--identity', identity2, '--expect-sha256', t.sumsFile, '--force-new', '--abandon-live-set', 'testnet'], { evo: f2.evo });
  const v2 = t.read().v2;
  assert.equal(v2.deployer.identityId, f2.ownerId);
  assert.equal(v2.deployer.assetLockTxid, 'cd'.repeat(32));
  assert.equal(v2.deployer.createdAtHeight, null, 'the old deployer\'s height is not carried over');
  assert.deepEqual(without(v2.deployerSuperseded[0], 'supersededAt'), old);
  assert.equal(v2.nonceLedgerSuperseded[0].entries.length, 4);
  assert.equal(v2.nonceLedgerSuperseded[0].deployer, t.fake.ownerId);
});

test('another deployer on the same chain: refused, or with --force-new a new set and a ledger of its own', async () => {
  const t = setup();
  await t.run(t.prod());
  const f2 = createFakePlatform({ identityFile: fakeIdentityFile({ identityId: b58encode(Buffer.alloc(32, 6)), txid: 'ef'.repeat(32) }) });
  const dir2 = mkdtempSync(join(tmpdir(), 'deploy-v2-test-id3-'));
  dirs.push(dir2);
  const argv = ['--network', 'testnet', '--set', 'mainnet', '--identity', f2.writeIdentity(dir2), '--expect-sha256', t.sumsFile];
  const before = t.raw();
  await assert.rejects(t.run(argv, { evo: f2.evo }), new RegExp(`was registered by ${t.fake.ownerId}; ${f2.ownerId} can only register a new set into it`));
  await assert.rejects(t.run([...argv, '--update', 'core'], { evo: f2.evo }), /can only register a new set into it/);
  assert.equal(t.raw(), before);
  await t.run([...argv, '--force-new', '--abandon-live-set', 'testnet'], { evo: f2.evo });
  const v2 = t.read().v2;
  // the new deployer's nonces start at 1: the old deployer's ledger is archived, not counted
  assert.deepEqual(KEYS.map((k) => [v2[k].ownerId, v2[k].identityNonce]), KEYS.map((_, i) => [f2.ownerId, String(i + 1)]));
  assert.deepEqual(v2.nonceLedger.map((e) => e.identityNonce), ['1', '2', '3', '4']);
  assert.equal(v2.nonceLedgerSuperseded[0].deployer, t.fake.ownerId);
  assert.deepEqual(KEYS.map((k) => v2[`${k}Superseded`].length), [1, 1, 1, 1]);
});

test('an update after a same-chain supersede: each contract\'s update nonces are its own', async () => {
  const t = setup();
  await t.run(t.prod());
  const stale = (key) => { const r = t.read(); r.v2[key].schemaHash = '0'.repeat(64); writeFileSync(t.testnetFile, JSON.stringify(r, null, 2)); };
  stale('forgeCollab');
  await t.run(t.prod('--update', 'collab'));
  stale('forgeCollab');
  await t.run(t.prod('--only', 'collab', '--force-new', '--same-group', '--abandon-live-set', 'testnet'));
  stale('forgeCollab');
  await t.run(t.prod('--update', 'collab'));
  const v2 = t.read().v2;
  const updates = v2.nonceLedger.filter((e) => e.kind === 'dataContractUpdate');
  assert.deepEqual(updates.map((e) => [e.contractId, e.contractNonce, e.status]), [
    [v2.forgeCollabSuperseded[0].contractId, '1', 'updated'],
    [v2.forgeCollab.contractId, '1', 'updated'],
  ]);
});

test('--force-new with a dependent reservation that never landed: it is abandoned with the old set', async () => {
  const t = setup();
  // forge-core lands at nonce 1, forge-collab's broadcast (nonce 2) never does
  const RealSdk = t.fake.evo.EvoSDK;
  let n = 0;
  const evo = { ...t.fake.evo, EvoSDK: class extends RealSdk { constructor(o) { super(o); const b = this.stateTransitions.broadcastAndWait; this.stateTransitions.broadcastAndWait = async (st) => { if (++n === 2) t.fake.failNext('before'); return b(st); }; } } };
  await assert.rejects(t.run(t.prod(), { evo }), /connection lost/);
  const reserved = t.read().v2.forgeCollab;
  assert.equal(reserved.status, 'broadcasting');
  const tampered = t.read();
  tampered.v2.forgeCore.schemaHash = '0'.repeat(64);
  writeFileSync(t.testnetFile, JSON.stringify(tampered, null, 2));
  await t.run(t.prod('--force-new', '--abandon-live-set', 'testnet'));
  const v2 = t.read().v2;
  assert.deepEqual(KEYS.map((k) => v2[k].identityNonce), ['2', '3', '4', '5'], 'the abandoned nonce 2 is reused by the new forge-core');
  assert.equal(v2.forgeCollabSuperseded, undefined, 'a reservation that never landed is not a superseded contract');
  assert.deepEqual(v2.nonceLedger.map((e) => [e.identityNonce, e.key, e.status]), [
    ['1', 'forgeCore', 'registered'], ['2', 'forgeCollab', 'abandoned'], ['2', 'forgeCore', 'registered'],
    ['3', 'forgeCollab', 'registered'], ['4', 'forgeCommunity', 'registered'], ['5', 'forgeMeta', 'registered'],
  ]);
  assert.equal(v2.nonceLedger[1].contractId, reserved.contractId);
});

test('--acknowledge-nonce accepts the record\'s own key-exchange contract', async () => {
  const t = setup();
  await t.run(t.prod());
  // deploy-key-exchange.mjs signed nonce 5 with the deployer and recorded its contract
  const id = contractId(t.fake.ownerId, 5n);
  t.fake.state.contracts.set(id, { json: { id, documentSchemas: {} }, ownerId: t.fake.ownerId, version: 1, contractNonce: 0n });
  t.fake.externalTransition();
  const rec = t.read();
  rec.v2.forgeMeta.schemaHash = '0'.repeat(64);
  writeFileSync(t.testnetFile, JSON.stringify(rec, null, 2));
  const meta = ['--only', 'meta', '--force-new', '--same-group', '--abandon-live-set', 'testnet', '--acknowledge-nonce', '5', '--note', 'key exchange'];
  await assert.rejects(t.run(t.prod(...meta)), /identity nonce 5 created contract \w+, a contract create of the deployer's \(not the record's keyExchange\)/);
  rec.keyExchange = { ...rec.keyExchange, contractId: id };
  writeFileSync(t.testnetFile, JSON.stringify(rec, null, 2));
  await t.run(t.prod(...meta));
  const v2 = t.read().v2;
  assert.equal(v2.forgeMeta.identityNonce, '6');
  assert.deepEqual(v2.nonceLedger.at(-2), { identityNonce: '5', kind: 'external', note: 'key exchange', at: v2.nonceLedger.at(-2).at });
});

test('rerunning a --force-new that crashed part way registers the rest, without --same-group', async () => {
  const t = setup();
  await t.run(t.prod());
  const tampered = t.read();
  tampered.v2.forgeCore.schemaHash = '0'.repeat(64);
  writeFileSync(t.testnetFile, JSON.stringify(tampered, null, 2));
  const argv = t.prod('--force-new', '--abandon-live-set', 'testnet');
  // the new forge-core lands, the new forge-collab's broadcast never does
  const RealSdk = t.fake.evo.EvoSDK;
  let n = 0;
  const evo = { ...t.fake.evo, EvoSDK: class extends RealSdk { constructor(o) { super(o); const b = this.stateTransitions.broadcastAndWait; this.stateTransitions.broadcastAndWait = async (st) => { if (++n === 2) t.fake.failNext('before'); return b(st); }; } } };
  await assert.rejects(t.run(argv, { evo }), /connection lost/);
  await t.run(argv);
  const v2 = t.read().v2;
  const group = contractGroupId(t.fake.ownerId, 5n);
  assert.deepEqual(KEYS.map((k) => v2[k].identityNonce), ['5', '6', '7', '8']);
  assert.ok(KEYS.every((k) => v2[k].contractGroupId === group && v2[k].status === 'registered'));
  assert.deepEqual(KEYS.map((k) => v2[`${k}Superseded`]?.length), [1, 1, 1, 1]);
});

test('testnet and mainnet: discovery only, a chain id of the network, a proved chain', async () => {
  const t = setup();
  await assert.rejects(t.run(t.prod('--addresses', 'https://1.2.3.4:1443')), /--addresses is for a devnet; testnet uses SDK discovery/);
  t.fake.state.chainId = 'dash-devnet-sakura';
  await assert.rejects(t.run(t.prod()), /the node serves chain dash-devnet-sakura, which is not a testnet chain id/);
  t.fake.state.chainId = 'dash-testnet-51';
  await assert.rejects(t.run(['--network', 'mainnet', '--set', 'mainnet', '--identity', t.identity, '--expect-sha256', t.sumsFile]), /the node serves chain dash-testnet-51, which is not a mainnet chain id \(\^evo1\$\)/);
  t.fake.state.proofChainId = '';
  await assert.rejects(t.run(t.prod()), /could not prove the chain id of testnet \(the proof names no chain id\); testnet registration refused/);
  t.fake.state.chainId = null;
  await assert.rejects(t.run(t.prod()), /could not prove the chain id/);
  t.fake.state.proofChainId = null;
  t.fake.state.chainId = 'dash-testnet-51';
  assert.equal(t.fake.broadcasts, 0);
  assert.deepEqual(t.read(), TESTNET_SEED);
  // a devnet name is one path segment: it never reaches another network's record
  await assert.rejects(t.run(['--network', 'devnet', '--devnet-name', 'a/../testnet', '--set', 'mainnet', '--identity', t.identity]), /--devnet-name a\/\.\.\/testnet: lower-case letters, digits and dashes only/);
  await assert.rejects(t.run(['--network', 'devnet', '--devnet-name', 'Sakura', '--identity', t.identity]), /--devnet-name Sakura/);
  assert.deepEqual(t.read(), TESTNET_SEED);
});

test('the registered commit must be on origin, and one run at a time writes a record', async () => {
  const t = setup();
  t.git.pushed = () => false;
  await assert.rejects(t.run(t.prod()), /HEAD aaaaaaaaaaaa is on no branch of origin: push it first/);
  t.git.pushed = () => { throw new Error('no remote'); };
  await assert.rejects(t.run(t.prod()), /git cannot report whether HEAD is on origin/);
  assert.equal(t.fake.broadcasts, 0);
  assert.ok(!existsSync(`${t.testnetFile}.lock`), 'a refused run leaves no lock');
  t.git.pushed = () => true;
  // a lock already there (another run, or a killed one) stops the run before it reads the record
  writeFileSync(`${t.testnetFile}.lock`, 'pid 1 on elsewhere since 2026-10-20T12:00:00.000Z\n');
  await assert.rejects(t.run(t.prod()), /testnet\.json\.lock exists \(pid 1 on elsewhere since 2026-10-20T12:00:00\.000Z\): another deploy-v2 run is writing testnet\.json.*delete the lock by hand/s);
  assert.ok(existsSync(`${t.testnetFile}.lock`), 'another run\'s lock is never removed');
  // a dry run writes nothing and takes no lock
  await t.run([...t.prod(), '--dry-run']);
  rmSync(`${t.testnetFile}.lock`);
  await t.run(t.prod());
  assert.equal(t.read().v2.forgeMeta.status, 'registered');
  assert.ok(!existsSync(`${t.testnetFile}.lock`));
});
