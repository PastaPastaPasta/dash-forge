// Offline tests for `mint.mjs restore` (src/restore.mjs): the same-id restore of an escrowed
// identity after a Platform reset. Every network call is a stub; nothing is broadcast. The phrase
// is the published BIP39 test vector (holds no funds) and the asset-lock txid is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as evo from '@dashevo/evo-sdk';
import { TESTNET, resolveNetwork } from '../src/config.mjs';
import { createRole } from '../src/flow.mjs';
import { buildIdentityBackup } from '../src/backup.mjs';
import { InsightError } from '../src/insight.mjs';
import { lockProofFor } from '../src/lock.mjs';
import { identityIdFromLock } from '../src/platform.mjs';
import { checkEscrow, identityIdFromOutpoint, restoreIdentity } from '../src/restore.mjs';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote';
const TXID = 'e8b43025641eea4fd21190f01bd870ef90f1a8b199d8fc3376c5b62c0b1a179d';
const MINT = fileURLToPath(new URL('../mint.mjs', import.meta.url));

/** An escrowed identity file as mint writes it (keys from PHRASE, a made-up asset lock). */
function escrow(network = TESTNET, over = {}) {
  const role = createRole('DEPLOYER', network, PHRASE);
  role.txid = TXID;
  role.identityId = identityIdFromOutpoint(TXID, 0);
  return { ...buildIdentityBackup(role, network), ...over };
}

/** Stubs for every network call, counting them. */
function stubs(over = {}) {
  const calls = [];
  const note = (name, value) => (...a) => { calls.push([name, ...a]); return typeof value === 'function' ? value(...a) : value; };
  const deps = {
    getTransaction: note('getTransaction', { txid: TXID, confirmations: 90000, blockheight: 1_100_000 }),
    describeIdentity: note('describeIdentity', null),
    obtainAssetLock: note('obtainAssetLock', (opts) => ({ type: 'chain', txid: opts.txid, coreChainLockedHeight: 1_100_000, outputIndex: 0 })),
    identityIdFromLock: (lock) => identityIdFromOutpoint(lock.txid, lock.outputIndex),
    registerIdentity: note('registerIdentity', () => ({ identityId: identityIdFromOutpoint(TXID, 0), balance: 29_000_000 })),
    ...over,
  };
  return { deps, calls, names: () => calls.map((c) => c[0]) };
}

test('the identity id derives from the asset-lock outpoint exactly as the SDK derives it', async () => {
  await evo.EvoSDK.getLatestVersionNumber(); // (initializes the wasm; no network)
  for (const vout of [0, 1, 7]) {
    assert.equal(identityIdFromOutpoint(TXID, vout), identityIdFromLock({ type: 'chain', txid: TXID, coreChainLockedHeight: 1, outputIndex: vout }));
  }
  assert.equal(identityIdFromOutpoint(TXID, 0), 'CQ8zY4WasGSoEfSPQ1ytoH1zRQVW2iZda6z3su2ffsMJ');
  assert.throws(() => identityIdFromOutpoint('xyz'), /not a transaction id/);
});

test('restore proves the lock by its block, even on testnet, and registers the file\'s keys under the same id', async () => {
  const s = stubs();
  const record = escrow();
  const result = await restoreIdentity({ record, network: TESTNET, deps: s.deps });
  assert.equal(result.status, 'restored');
  assert.equal(result.identityId, record.identityId);
  assert.deepEqual(s.names(), ['getTransaction', 'describeIdentity', 'obtainAssetLock', 'registerIdentity']);
  assert.equal(s.calls[2][1].proof, 'chain');
  const reg = s.calls[3][1];
  assert.equal(reg.lock.type, 'chain');
  assert.equal(reg.lock.txid, TXID);
  assert.deepEqual(reg.identityKeys.map((k) => k.publicKeyHex), record.identityKeys.map((k) => k.publicKeyHex));
  // the lock option itself: testnet proves by InstantSend unless told otherwise; a devnet always by its block
  assert.equal(lockProofFor(TESTNET), 'instant');
  assert.equal(lockProofFor(TESTNET, { proof: 'chain' }), 'chain');
  assert.equal(lockProofFor(resolveNetwork({ network: 'devnet', devnetName: 'sakura' })), 'chain');
  assert.throws(() => lockProofFor(TESTNET, { proof: 'instant' }), /only 'chain'/);
});

test('a wrong or edited file is refused before any network call, and the phrase is never echoed', async () => {
  const words = [...new Set(`${PHRASE} ${OTHER}`.split(' '))];
  const cases = [
    [{ mnemonic: OTHER }, /does not rebuild its deposit address/],
    [{ mnemonic: OTHER, depositAddress: undefined, assetLockKey: null }, /does not rebuild its identity keys|does not rebuild its identity key 0/],
    [{ identityKeys: escrow().identityKeys.slice(0, 4) }, /identity keys \(4 in the file, 5 rebuilt\)/],
    [{ identityId: identityIdFromOutpoint(TXID, 1) }, /asset lock e8b4.*:0 creates identity CQ8z\w+, not the file's/],
    [{ txid: undefined }, /no asset-lock txid/],
    [{ identityId: undefined }, /pending mint/],
    [{ mnemonic: undefined }, /holds no mnemonic/],
    [{ mnemonic: 'abandon abandon abandon' }, /not valid BIP39/],
  ];
  for (const [over, pattern] of cases) {
    const s = stubs();
    await assert.rejects(restoreIdentity({ record: escrow(TESTNET, over), network: TESTNET, deps: s.deps }),
      (err) => pattern.test(err.message) && !words.some((w) => err.message.includes(w)));
    assert.deepEqual(s.calls, [], JSON.stringify(Object.keys(over)));
  }
  // --expect-id is checked too
  const s = stubs();
  await assert.rejects(restoreIdentity({ record: escrow(), network: TESTNET, expectId: 'Bogus', deps: s.deps }), /not --expect-id Bogus/);
  assert.deepEqual(s.calls, []);
  assert.equal(checkEscrow(escrow(), TESTNET).identityId, identityIdFromOutpoint(TXID, 0));
});

test('already on this chain with the file\'s keys: nothing is registered; with other keys: refused', async () => {
  const record = escrow();
  const keys = record.identityKeys.map((k) => ({ id: k.id, purpose: k.purpose, securityLevel: k.securityLevel, dataHex: k.publicKeyHex, disabled: false }));
  const same = stubs({ describeIdentity: () => ({ identityId: record.identityId, balance: 5, keys }) });
  const result = await restoreIdentity({ record, network: TESTNET, deps: same.deps });
  assert.equal(result.status, 'already-restored');
  assert.equal(result.balance, 5);
  assert.ok(!same.names().includes('registerIdentity'));
  assert.ok(!same.names().includes('obtainAssetLock'));
  const other = stubs({ describeIdentity: () => ({ identityId: record.identityId, balance: 5, keys: keys.map((k, i) => (i === 2 ? { ...k, dataHex: `03${'11'.repeat(32)}` } : k)) }) });
  await assert.rejects(restoreIdentity({ record, network: TESTNET, deps: other.deps }), /exists on this chain with other keys.*impossible: mint a new deployer and register a new set/s);
  assert.ok(!other.names().includes('registerIdentity'));
});

test('Core reset, an unmined lock, a consumed lock and an unreachable Core are told apart', async () => {
  const record = escrow();
  const run = (over) => { const s = stubs(over); return [restoreIdentity({ record, network: TESTNET, deps: s.deps }), s]; };
  let [p, s] = run({ getTransaction: () => { throw new InsightError('Failed to get transaction: 404 Not Found', 404); } });
  await assert.rejects(p, /does not know asset-lock tx e8b4\w+: Core was reset too.*A same-id restore is impossible/s);
  assert.deepEqual(s.names(), []);
  [p] = run({ getTransaction: () => { throw new Error(`Transaction ${TXID} not found`); } });
  await assert.rejects(p, /Core was reset too/);
  [p] = run({ getTransaction: () => ({ txid: TXID, confirmations: 0, blockheight: undefined }) });
  await assert.rejects(p, /is not mined on Core testnet.*Core was reset/s);
  [p] = run({ getTransaction: () => { throw new InsightError('Failed to get transaction: 503', 503); } });
  await assert.rejects(p, /cannot read asset-lock tx .* from Core .*retry/);
  [p] = run({ registerIdentity: () => { throw new Error(`Asset lock transaction ${TXID} output 0 already completely used`); } });
  await assert.rejects(p, /already consumed on this chain .*cannot be re-created\. A same-id restore is impossible/s);
  // the SDK's id must agree before anything registers
  [p, s] = run({ identityIdFromLock: () => 'SomethingElse' });
  await assert.rejects(p, /the SDK derives SomethingElse/);
  assert.ok(!s.names().includes('registerIdentity'));
});

test('the CLI refuses mainnet and a missing --identity before any network call, exit 1, no key printed', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mint-restore-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = (...argv) => {
    try {
      execFileSync(process.execPath, [MINT, 'restore', ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
      return { code: 0, stderr: '' };
    } catch (err) {
      return { code: err.status, stderr: String(err.stderr) };
    }
  };
  const file = join(dir, 'DEPLOYER.identity.json');
  writeFileSync(file, JSON.stringify(escrow()));
  const main = join(dir, 'MAIN.identity.json');
  writeFileSync(main, JSON.stringify({ ...escrow(), network: 'mainnet' }));
  const wrong = join(dir, 'WRONG.identity.json');
  writeFileSync(wrong, JSON.stringify(escrow(TESTNET, { mnemonic: OTHER })));
  for (const [argv, pattern] of [
    [[], /--identity <escrowed identity file> is required/],
    [['--identity', file, '--network', 'mainnet'], /mainnet restore is not supported by mint-identity yet/],
    [['--identity', main], /mainnet restore is not supported by mint-identity yet/],
    [['--identity', file, '--network', 'devnet', '--devnet-name', 'sakura'], /is a testnet identity, but --network selects devnet-sakura/],
    [['--identity', wrong], /does not rebuild its deposit address/],
    [['--identity', file, '--out', file], /--out must not be the escrowed file itself/],
  ]) {
    const { code, stderr } = cli(...argv);
    assert.equal(code, 1, argv.join(' '));
    assert.match(stderr, pattern);
    assert.ok(!PHRASE.split(' ').some((w) => stderr.includes(` ${w} `)) && !stderr.includes('privateKey'), 'no phrase or key in the output');
    for (const k of escrow().identityKeys) assert.ok(!stderr.includes(k.privateKeyWif));
  }
});
