import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { groupProblems, options, parseArgs, plan } from './launch-network.mjs';

const opts = (...argv) => options(parseArgs(argv));
const labels = (o) => plan(o).map(([l]) => l);
const MAINNET = ['--network', 'mainnet', '--identity', 'd.json', '--expect-sha256', 's.txt'];

test('defaults to a dry run that broadcasts nothing', () => {
  const o = opts(...MAINNET);
  assert.equal(o.mode, 'dry-run');
  assert.deepEqual(labels(o), ['self-test', 'sums', 'dapi', 'dry-run']);
  for (const [, script, argv] of plan(o)) {
    if (script === 'deploy-v2.mjs' && !argv.includes('--self-test') && !argv.includes('--print-sha256')) assert.ok(argv.includes('--dry-run'));
  }
});

test('--execute registers once, then runs the read-only checks', () => {
  const o = opts(...MAINNET, '--execute', '--deployer-created-height', '2400000');
  assert.deepEqual(labels(o), ['self-test', 'sums', 'dapi', 'dry-run', 'register', 'c1', 'group', 'freeze', 'snapshot']);
  const register = plan(o).find(([l]) => l === 'register');
  assert.deepEqual(register[2], ['--network', 'mainnet', '--set', 'mainnet', '--identity', 'd.json', '--deployer-created-height', '2400000', '--expect-sha256', 's.txt']);
  assert.equal(register[3].confirm, true);
  assert.ok(o.record.endsWith('deployments/mainnet.json'));
});

test('--post-only needs no identity and broadcasts nothing', () => {
  const o = opts('--network', 'mainnet', '--post-only');
  assert.deepEqual(labels(o), ['c1', 'group', 'freeze', 'snapshot']);
});

test('a re-run after the registration commit does not re-freeze', () => {
  const o = opts('--network', 'testnet', '--post-only');
  assert.deepEqual(plan(o, { frozen: true }).map(([l]) => l), ['c1', 'group', 'snapshot']);
});

test('the live record needs the signed sums to register', () => {
  assert.throws(() => opts('--network', 'mainnet', '--identity', 'd.json', '--execute'), /--expect-sha256/);
});

test('a scratch rehearsal writes only its own record and output', () => {
  const o = opts('--network', 'testnet', '--identity', 's.json', '--record', '/w/rec.json', '--scratch-on', 'testnet', '--out', '/w/out', '--execute');
  const steps = plan(o);
  const register = steps.find(([l]) => l === 'register')[2];
  assert.ok(register.includes('--scratch-on') && register.includes('/w/rec.json'));
  assert.deepEqual(steps.find(([l]) => l === 'freeze')[2], ['--network', 'testnet', '--record', '/w/rec.json', '--out', '/w/out/registered']);
  assert.deepEqual(steps.find(([l]) => l === 'snapshot')[2], ['--network', 'testnet', '--record', '/w/rec.json', '--out', '/w/out/snapshot.json']);
});

test('refuses inconsistent or unknown flags', () => {
  assert.throws(() => opts('--network', 'devnet', '--identity', 'd'), /testnet\|mainnet/);
  assert.throws(() => opts('--network', 'testnet', '--identity', 'd', '--record', 'r.json'), /go together/);
  assert.throws(() => opts('--network', 'testnet', '--identity', 'd', '--record', 'r', '--scratch-on', 'mainnet', '--out', 'o'), /must equal/);
  assert.throws(() => opts('--network', 'testnet', '--identity', 'd', '--record', 'r', '--scratch-on', 'testnet'), /--out/);
  assert.throws(() => opts(...MAINNET, '--execute', '--post-only'), /exclusive/);
  assert.throws(() => parseArgs(['--network', 'mainnet', '--force-new']), /unknown flag/);
  assert.throws(() => parseArgs(['--identity']), /needs a value/);
});

test('the wrapper never forwards a superseding or replaying flag', () => {
  const src = readFileSync(new URL('./launch-network.mjs', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
  for (const f of ['--force-new', '--abandon-live-set', '--update', '--replay', '--acknowledge-nonce']) assert.ok(!code.includes(`'${f}'`), f);
});

test('group check: owner is the deployer, no admins', () => {
  const v2 = { deployer: { identityId: 'D' }, contractGroup: { id: 'G', owner: 'D' } };
  assert.deepEqual(groupProblems(v2, { ownerId: 'D', adminIds: [] }), []);
  assert.match(groupProblems(v2, { ownerId: 'X', adminIds: [] })[0], /owner is X/);
  assert.match(groupProblems(v2, { ownerId: 'D', adminIds: ['A'] })[0], /admins A/);
  assert.match(groupProblems(v2, { ownerId: 'D' })[0], /no admin list/);
  assert.match(groupProblems(v2, null)[0], /not found/);
  assert.match(groupProblems({}, null)[0], /names no contract group/);
});
