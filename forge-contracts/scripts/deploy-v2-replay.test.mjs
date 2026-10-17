// node --test forge-contracts/scripts/deploy-v2-replay.test.mjs
//
// The same-id restore (deploy-v2.mjs --replay, CNT-02, CNT-15) end to end against the fake
// platform: a Platform reset that keeps Core, the deployer re-created from its asset lock (same
// id), and the record's set registered again at the recorded nonces, so every contract and the
// group keep their ids. No network, no key, a temp copy of deployments/.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

import { MAX_NONCE_GAP, SETS, contractGroupId, contractId, formatSums, main, nonceGapProblem, planReplay, setSums } from './deploy-v2.mjs';
import { createFakePlatform } from './lib/fake-platform.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const KEYS = ['forgeCore', 'forgeCollab', 'forgeCommunity', 'forgeMeta'];
const NAMES = ['forge-core', 'forge-collab', 'forge-community', 'forge-meta'];
const OLD = 'dash-testnet-51';
const NEW = 'dash-testnet-52';
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tempDir = (tag) => { const d = mkdtempSync(join(tmpdir(), `deploy-v2-replay-${tag}-`)); dirs.push(d); return d; };

function setup({ platform = {} } = {}) {
  const dir = tempDir('t');
  const deploymentsRoot = join(dir, 'deployments');
  const registeredRoot = join(dir, 'registered');
  mkdirSync(deploymentsRoot);
  writeFileSync(join(deploymentsRoot, 'testnet.json'), '{}\n');
  const fake = createFakePlatform({ chainId: OLD, ...platform });
  const identity = fake.writeIdentity(dir);
  const sumsFile = join(dir, 'signed-sums.txt');
  writeFileSync(sumsFile, formatSums(setSums(SETS.mainnet)));
  // git at the recorded commit is the working tree (the committed set); a test can tamper with it
  const shown = [];
  const git = {
    head: () => 'a'.repeat(40),
    porcelain: () => '',
    pushed: () => true,
    buildCheck: () => ({ ok: true, output: '' }),
    show: (commit, path) => { shown.push(`${commit}:${path}`); return readFileSync(join(REPO, path)); },
  };
  let tick = 0;
  const logs = [];
  const t = {
    dir, deploymentsRoot, registeredRoot, fake, git, logs, identity, sumsFile, shown,
    file: join(deploymentsRoot, 'testnet.json'),
    read: () => JSON.parse(readFileSync(join(deploymentsRoot, 'testnet.json'), 'utf8')),
    raw: () => readFileSync(join(deploymentsRoot, 'testnet.json'), 'utf8'),
    write: (rec) => writeFileSync(join(deploymentsRoot, 'testnet.json'), `${JSON.stringify(rec, null, 2)}\n`),
    prod: (...extra) => ['--network', 'testnet', '--set', 'mainnet', '--identity', identity, '--expect-sha256', sumsFile, ...extra],
    replay: (...extra) => t.prod('--replay', '--replay-from-chain', OLD, ...extra),
    run: (argv, over = {}) => main(argv, {
      evo: fake.evo, git, deploymentsRoot, registeredRoot,
      now: () => new Date(Date.UTC(2026, 9, 21, 12, 0, tick++)),
      log: (m) => logs.push(m), print: () => {},
      sdkId: '@dashevo/evo-sdk@5.0.0-rc.3', settleMs: 0, settleTries: 1,
      ...over,
    }),
  };
  return t;
}

const ids = (rec) => Object.fromEntries(KEYS.map((k) => [k, rec.v2[k].contractId]));

test('a Platform reset: the restored deployer replays the set, and every contract and the group keep their ids', async () => {
  const t = setup();
  await t.run(t.prod());
  const before = t.read();
  // the same chain: nothing to replay
  await t.run(t.replay());
  assert.equal(t.fake.broadcasts, 4);
  assert.ok(t.logs.some((m) => /nothing to replay: the network is still dash-testnet-51/.test(m)));

  t.fake.reset(NEW); // a new chain id, empty state; the deployer re-created from its asset lock (mint.mjs restore)
  await t.run(t.replay('--dry-run'));
  assert.equal(t.fake.broadcasts, 4, 'a dry run broadcasts nothing');
  assert.equal(t.raw(), `${JSON.stringify(before, null, 2)}\n`, 'a dry run writes nothing');

  await t.run(t.replay());
  assert.equal(t.fake.broadcasts, 8);
  const rec = t.read();
  assert.deepEqual(ids(rec), ids(before));
  const owner = t.fake.ownerId;
  KEYS.forEach((k, i) => {
    assert.equal(rec.v2[k].contractId, contractId(owner, BigInt(i + 1)));
    assert.equal(rec.v2[k].registeredSchemaHash, before.v2[k].registeredSchemaHash);
    assert.equal(rec.v2[k].identityNonce, before.v2[k].identityNonce);
    assert.ok(rec.v2[k].restoredAt);
    assert.ok(t.fake.state.contracts.has(rec.v2[k].contractId), `${k} is on the new chain`);
    assert.deepEqual(t.fake.state.memberships.get(rec.v2[k].contractId), [before.v2.contractGroupId]);
  });
  assert.equal(rec.v2.contractGroupId, contractGroupId(owner, 1n));
  assert.equal(rec.v2.contractGroupId, before.v2.contractGroupId);
  const group = t.fake.state.groups.get(rec.v2.contractGroupId);
  assert.deepEqual([group.ownerId, group.adminIds, group.description], [owner, [], before.v2.contractGroup.description]);
  // the record moved to the new chain; the ledger is untouched; the restore is recorded
  assert.equal(rec.chainId, NEW);
  assert.deepEqual(rec.v2.nonceLedger, before.v2.nonceLedger);
  assert.equal(rec.v2.restores.length, 1);
  const r = rec.v2.restores[0];
  assert.deepEqual({ from: r.fromChainId, to: r.toChainId, replayed: r.replayed, updates: r.updatesReplayed, nonces: r.replayedNonces, ledgerLength: r.ledgerLength, notReplayed: r.notReplayed },
    { from: OLD, to: NEW, replayed: KEYS, updates: 0, nonces: ['1', '2', '3', '4'], ledgerLength: 4, notReplayed: [] });
  assert.deepEqual(Object.keys(r.provedAt), KEYS);
  // the schemas came from git at the recorded commit (each pass, the production preflight included, reads them)
  assert.deepEqual([...new Set(t.shown)], NAMES.map((n) => `${'a'.repeat(40)}:forge-contracts/contracts/mainnet/${n}.json`));

  // rerunning the replay, or a normal run, sends nothing
  await t.run(t.replay());
  await t.run(t.prod());
  assert.equal(t.fake.broadcasts, 8);
  assert.ok(t.logs.some((m) => /nothing to replay: the network is still dash-testnet-52/.test(m)));
});

test('refusals before anything is broadcast', async () => {
  const t = setup();
  await t.run(t.prod());
  t.fake.reset(NEW, { deployer: false });
  const before = t.raw();
  await assert.rejects(t.run(t.prod('--replay')), /--replay needs --replay-from-chain/);
  await assert.rejects(t.run(t.prod('--replay', '--replay-from-chain', 'dash-testnet-50')), /registered on chain dash-testnet-51, not dash-testnet-50/);
  await assert.rejects(t.run(t.prod('--replay-from-chain', OLD)), /--replay-from-chain goes with --replay/);
  await assert.rejects(t.run(t.replay('--force-new', '--abandon-live-set', 'testnet')), /--replay runs alone/);
  await assert.rejects(t.run(t.replay('--update', 'core')), /--replay runs alone/);
  // the deployer is not restored yet: say how
  await assert.rejects(t.run(t.replay()), /not found on testnet: restore it from escrow first \(node tools\/mint-identity\/mint\.mjs restore/);
  t.fake.restoreDeployer();
  // the production refusals of a registration apply
  await assert.rejects(t.run(['--network', 'testnet', '--set', 'mainnet', '--identity', t.identity, '--replay', '--replay-from-chain', OLD]), /testnet replay refused.*--expect-sha256 <file> is required/s);
  const wrong = join(t.dir, 'wrong-sums.txt');
  writeFileSync(wrong, formatSums({ ...setSums(SETS.mainnet), 'forge-meta.json': '0'.repeat(64) }));
  await assert.rejects(t.run(['--network', 'testnet', '--set', 'mainnet', '--identity', t.identity, '--expect-sha256', wrong, '--replay', '--replay-from-chain', OLD]), /forge-meta\.json: sha256 .* is not the signed/);
  t.git.porcelain = () => ' M forge-contracts/contracts/mainnet/forge-core.json';
  await assert.rejects(t.run(t.replay()), /differ from git HEAD/);
  t.git.porcelain = () => '';
  assert.equal(t.fake.broadcasts, 4);
  assert.equal(t.raw(), before);
});

test('the sums checked are the recorded ones: a set changed since registration still replays what was registered', async () => {
  const t = setup();
  await t.run(t.prod());
  t.fake.reset(NEW);
  // the committed files moved on (a later additive update): their sums are not the recorded ones
  const rec = t.read();
  for (const k of KEYS) rec.v2[k].sourceSha256 = rec.v2[k].sourceSha256.replace(/^./, (c) => (c === '0' ? '1' : '0'));
  t.write(rec);
  // the signed sums (of the current files) no longer match what the record says was registered
  await assert.rejects(t.run(t.replay()), /--expect-sha256: forge-core\.json: sha256/);
  const recorded = join(t.dir, 'recorded-sums.txt');
  writeFileSync(recorded, formatSums(Object.fromEntries(KEYS.map((k, i) => [`${NAMES[i]}.json`, rec.v2[k].sourceSha256]))));
  // and git at the recorded commit does not hash to them either: refused before signing
  await assert.rejects(t.run(['--network', 'testnet', '--set', 'mainnet', '--identity', t.identity, '--expect-sha256', recorded, '--replay', '--replay-from-chain', OLD]),
    /forgeCore create \(nonce 1\) from a{12}:forge-contracts\/contracts\/mainnet\/forge-core\.json has sha256 .* not the recorded .*not the bytes registered/);
  assert.equal(t.fake.broadcasts, 4);
});

test('a source edited by one byte is refused before anything is signed, frozen copies first', async () => {
  const t = setup();
  await t.run(t.prod());
  t.fake.reset(NEW);
  const before = t.raw();
  // git returns a forge-community edited by one byte
  const show = t.git.show;
  t.git.show = (commit, path) => {
    const b = Buffer.from(show(commit, path));
    if (path.endsWith('forge-community.json')) b[b.length - 2] = 0x20;
    return b;
  };
  await assert.rejects(t.run(t.replay()), /forgeCommunity create \(nonce 3\) from .* not the bytes registered/);
  assert.equal(t.fake.broadcasts, 4, 'not even forge-core was sent');
  assert.equal(t.raw(), before);
  // B4's frozen registered/<network>/ copies are read first: an edited one is refused, a correct one is used
  t.git.show = () => { throw new Error('git must not be asked'); };
  const frozen = join(t.registeredRoot, 'testnet');
  mkdirSync(frozen, { recursive: true });
  for (const n of NAMES) cpSync(join(SETS.mainnet, `${n}.json`), join(frozen, `${n}.v1.json`));
  const meta = join(frozen, 'forge-meta.v1.json');
  const good = readFileSync(meta);
  writeFileSync(meta, Buffer.concat([good, Buffer.from(' ')]));
  await assert.rejects(t.run(t.replay()), /forgeMeta create \(nonce 4\) from .*registered\/testnet\/forge-meta\.v1\.json has sha256/);
  assert.equal(t.fake.broadcasts, 4);
  writeFileSync(meta, good);
  await t.run(t.replay());
  assert.equal(t.fake.broadcasts, 8);
  assert.equal(t.read().chainId, NEW);
});

test('an external transition and an abandoned reservation leave a gap the replay keeps', async () => {
  const t = setup();
  t.fake.failNext('before');
  await assert.rejects(t.run(t.prod()), /connection lost/);
  t.fake.externalTransition();
  await t.run(t.prod('--acknowledge-nonce', '1', '--note', 'IdentityUpdate: rotated CRITICAL (INC-10)'));
  const before = t.read();
  assert.deepEqual(KEYS.map((k) => before.v2[k].identityNonce), ['2', '3', '4', '5']);
  t.fake.reset(NEW);
  await t.run(t.replay());
  const rec = t.read();
  assert.deepEqual(ids(rec), ids(before));
  assert.equal(rec.v2.contractGroupId, contractGroupId(t.fake.ownerId, 2n));
  assert.equal(t.fake.state.identities.get(t.fake.ownerId).nonce, 5n);
  assert.deepEqual(rec.v2.restores[0].notReplayed.map((e) => [e.identityNonce, e.kind, e.status ?? e.note]), [
    ['1', 'dataContractCreate', 'abandoned'],
    ['1', 'external', 'IdentityUpdate: rotated CRITICAL (INC-10)'],
  ]);
  assert.ok(t.logs.some((m) => /WARNING 1 external transition\(s\) of the old chain are not redone .*rotated CRITICAL/.test(m)));
});

test('after a restore, the old chain\'s transitions past the last replayed nonce do not count', async () => {
  const t = setup();
  await t.run(t.prod());
  // an acknowledged key rotation after the set, at nonce 5, on the old chain
  const rec = t.read();
  rec.v2.nonceLedger.push({ identityNonce: '5', kind: 'external', note: 'IdentityUpdate: rotated CRITICAL', at: '2026-10-21T00:00:00.000Z' });
  t.write(rec);
  t.fake.reset(NEW);
  await t.run(t.replay());
  assert.equal(t.fake.state.identities.get(t.fake.ownerId).nonce, 4n);
  // a later create on the new chain takes nonce 5 (the node is not "behind" the old chain's 5)
  const stale = t.read();
  stale.v2.forgeMeta.schemaHash = '0'.repeat(64);
  t.write(stale);
  await t.run(t.prod('--only', 'meta', '--force-new', '--same-group', '--abandon-live-set', 'testnet'));
  const after = t.read();
  assert.equal(after.v2.forgeMeta.identityNonce, '5');
  assert.equal(after.v2.forgeMeta.contractId, contractId(t.fake.ownerId, 5n));
  assert.deepEqual(after.v2.nonceLedger.slice(-2).map((e) => [e.identityNonce, e.kind]), [['5', 'external'], ['5', 'dataContractCreate']]);
});

test('the nonce window: forge-core at nonce 24 replays, at 25 the restore is impossible', async () => {
  for (const [externals, ok] of [[23, true], [24, false]]) {
    const t = setup();
    t.fake.externalTransition(externals);
    const acks = Array.from({ length: externals }, (_, i) => String(i + 1)).join(',');
    await t.run(t.prod('--acknowledge-nonce', acks, '--note', 'test transitions'));
    const before = t.read();
    assert.equal(before.v2.forgeCore.identityNonce, String(externals + 1));
    t.fake.reset(NEW);
    if (ok) {
      await t.run(t.replay());
      assert.deepEqual(ids(t.read()), ids(before));
    } else {
      await assert.rejects(t.run(t.replay()),
        /forgeCore needs identity nonce 25 but the deployer's is 0: nonce gap 25 exceeds the protocol's window of 24.*same-id restore is impossible; register a new set instead \(--force-new --abandon-live-set testnet\)/s);
      assert.equal(t.fake.broadcasts, 4);
    }
  }
  assert.equal(MAX_NONCE_GAP, 24n);
  assert.equal(nonceGapProblem([{ key: 'a', nonce: 1n }, { key: 'b', nonce: 25n }], 0n), null);
  assert.match(nonceGapProblem([{ key: 'a', nonce: 1n }, { key: 'b', nonce: 26n }], 0n), /b needs identity nonce 26 but the deployer's is 1: nonce gap 25/);
  assert.match(nonceGapProblem([{ key: 'a', nonce: 1n }], 1n), /not past the deployer's 1/);
});

test('a replay that crashed part way is resumed by the same command, nothing sent twice', async () => {
  for (const mode of ['before', 'after']) {
    const t = setup();
    await t.run(t.prod());
    const before = t.read();
    t.fake.reset(NEW);
    t.fake.failIn(2, mode); // forge-collab's create
    await assert.rejects(t.run(t.replay()), mode === 'before' ? /connection lost/ : /timed out/);
    const half = t.read();
    assert.equal(half.chainId, OLD, 'the record moves chain only when the replay is done');
    assert.ok(half.v2.forgeCore.restoredAt);
    // (a second create at forge-core's nonce would be refused by the node: the resume must skip it)
    await t.run(t.replay());
    assert.equal(t.fake.broadcasts, mode === 'before' ? 9 : 8, mode);
    const rec = t.read();
    assert.deepEqual(ids(rec), ids(before));
    assert.equal(rec.chainId, NEW);
    assert.equal(rec.v2.restores.length, 1);
    assert.ok(t.logs.some((m) => /forgeCore: \w+ is on this chain already \(a resumed replay\)/.test(m)));
  }
});

test('a reset that kept the chain id on testnet is refused; a devnet keeps its id across a reset and replays', async () => {
  const t = setup();
  await t.run(t.prod());
  t.fake.reset(OLD);
  await assert.rejects(t.run(t.replay()), /the network still reports dash-testnet-51, the record's chain, yet forgeCore, forgeCollab, forgeCommunity, forgeMeta is not on it: this is no Platform reset/);
  assert.equal(t.fake.broadcasts, 4);

  // a devnet such as sakura (`dash-devnet-sakura`, no generation suffix): a scratch rehearsal record
  const d = setup({ platform: { chainId: 'dash-devnet-test' } });
  writeFileSync(join(d.deploymentsRoot, 'devnet-test.json'), JSON.stringify({ network: 'devnet', devnetName: 'test', chainId: 'dash-devnet-test' }));
  const scratch = join(d.dir, 'rehearsal.json');
  const dev = (...extra) => ['--network', 'devnet', '--devnet-name', 'test', '--set', 'mainnet', '--record', scratch, '--identity', d.identity, ...extra];
  await d.run(dev());
  const before = JSON.parse(readFileSync(scratch, 'utf8'));
  d.fake.reset('dash-devnet-test');
  await d.run(dev('--replay', '--replay-from-chain', 'dash-devnet-test'));
  const rec = JSON.parse(readFileSync(scratch, 'utf8'));
  assert.deepEqual(ids(rec), ids(before));
  assert.deepEqual([rec.v2.restores[0].fromChainId, rec.v2.restores[0].toChainId], ['dash-devnet-test', 'dash-devnet-test']);
  assert.ok(d.logs.some((m) => /WARNING the devnet still reports chain dash-devnet-test/.test(m)));
  await d.run(dev('--replay', '--replay-from-chain', 'dash-devnet-test'));
  assert.equal(d.fake.broadcasts, 8, 'a finished replay is not run again');
});

test('recorded updates are replayed after their create, in ledger order, to the recorded schema', async () => {
  const t = setup();
  // a scratch set on testnet whose forge-core is later updated from a second directory
  const v1 = tempDir('v1');
  const v2dir = tempDir('v2');
  cpSync(SETS.mainnet, v1, { recursive: true });
  cpSync(SETS.mainnet, v2dir, { recursive: true });
  const core = JSON.parse(readFileSync(join(v2dir, 'forge-core.json'), 'utf8'));
  const [firstType] = Object.keys(core.documentSchemas);
  core.documentSchemas.replayProbe = structuredClone(core.documentSchemas[firstType]);
  writeFileSync(join(v2dir, 'forge-core.json'), `${JSON.stringify(core, null, 2)}\n`);
  const scratch = join(t.dir, 'scratch.json');
  const argv = (dir, ...extra) => ['--network', 'testnet', '--contracts', dir, '--record', scratch, '--identity', t.identity, ...extra];
  await t.run(argv(v1));
  await t.run(argv(v2dir, '--update', 'core'));
  const before = JSON.parse(readFileSync(scratch, 'utf8'));
  assert.equal(before.v2.forgeCore.version, 2);
  t.fake.reset(NEW);
  await t.run(argv(v2dir, '--replay', '--replay-from-chain', OLD));
  const rec = JSON.parse(readFileSync(scratch, 'utf8'));
  assert.deepEqual(ids(rec), ids(before));
  assert.equal(t.fake.state.contracts.get(rec.v2.forgeCore.contractId).version, 2);
  assert.ok(t.fake.state.contracts.get(rec.v2.forgeCore.contractId).json.documentSchemas.replayProbe);
  assert.equal(rec.v2.restores[0].updatesReplayed, 1);
  assert.equal(rec.v2.forgeCore.schemaHash, before.v2.forgeCore.schemaHash);
  // the v1 file the create was registered from is gone: the replay cannot rebuild it
  t.fake.reset('dash-testnet-53');
  rmSync(join(v1, 'forge-core.json'));
  await assert.rejects(t.run(argv(v2dir, '--replay', '--replay-from-chain', NEW)), /forgeCore create \(nonce 1\) was registered from .*forge-core\.json, which is gone/);
});

test('planReplay refuses a record it cannot replay', async () => {
  const t = setup();
  await t.run(t.prod());
  const base = t.read();
  const plan = (mutate, fromChain = OLD) => {
    const dep = structuredClone(base);
    mutate(dep);
    return () => planReplay(dep, { recordKeys: KEYS, fromChain, recordName: 'deployments/testnet.json' });
  };
  assert.equal(plan(() => {})().ops.length, 4);
  assert.throws(plan((d) => { delete d.v2.nonceLedger; }), /has no nonceLedger to replay/);
  assert.throws(plan((d) => { delete d.chainId; }), /records no chainId/);
  assert.throws(plan((d) => { delete d.v2.deployer; }), /records no v2\.deployer/);
  assert.throws(plan((d) => { d.v2.forgeMeta.status = 'broadcasting'; }), /v2\.forgeMeta broadcasting, not registered/);
  assert.throws(plan((d) => { d.v2.forgeCore.pendingUpdate = { version: 2 }; }), /pending update of v2\.forgeCore/);
  assert.throws(plan((d) => { d.v2.nonceLedger.splice(1, 1); }), /0 registered ledger creates of v2\.forgeCollab/);
  assert.throws(plan((d) => { d.v2.nonceLedger.push({ ...d.v2.nonceLedger[0], identityNonce: '9', key: 'forgeCore', status: 'broadcasting' }); }), /still broadcasting \(nonce 9\)/);
  assert.throws(plan((d) => { d.v2.forgeMeta.contractGroupId = 'X'; }), /v2\.forgeMeta in contract group X/);
  assert.throws(plan(() => {}, 'dash-testnet-7'), /registered on chain dash-testnet-51, not dash-testnet-7/);
  assert.throws(() => planReplay(base, { recordKeys: KEYS.slice(0, 3), fromChain: OLD }), /records v2\.forgeMeta, which the set has no file for/);
});
