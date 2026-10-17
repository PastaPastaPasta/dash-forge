// node --test forge-contracts/scripts/lib/freeze-registered.test.mjs
//
// freeze-registered.mjs on a record the real deploy-v2 wrote (against the fake platform): the frozen copy
// is the registered file byte for byte, a changed source or an existing different copy is refused, and a
// scratch copy never lands under contracts/registered/.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, test } from 'node:test';

import { SETS, formatSums, main, setSums } from '../deploy-v2.mjs';
import { freeze } from '../freeze-registered.mjs';
import { createFakePlatform } from './fake-platform.mjs';

const REPO = join(SETS.devnet, '..', '..');
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A scratch record (outside deployments/) of the committed four-contract set, and a repo root holding a copy of the set. */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'freeze-test-'));
  dirs.push(dir);
  const deploymentsRoot = join(dir, 'deployments');
  mkdirSync(deploymentsRoot);
  const fake = createFakePlatform();
  const sumsFile = join(dir, 'sums.txt');
  writeFileSync(sumsFile, formatSums(setSums(SETS.mainnet)));
  const git = { head: () => 'a'.repeat(40), porcelain: () => '', pushed: () => true, buildCheck: () => ({ ok: true, output: '' }) };
  const record = join(dir, 'scratch', 'rehearsal.json');
  await main(
    ['--network', 'testnet', '--set', 'mainnet', '--identity', fake.writeIdentity(dir), '--record', record, '--scratch-on', 'testnet'],
    { evo: fake.evo, git, deploymentsRoot, log: () => {}, print: () => {}, sdkId: '@dashevo/evo-sdk@5.0.0-rc.3', settleMs: 0, settleTries: 1 },
  );
  return { dir, record, registeredRoot: join(dir, 'registered') };
}
const name = (f) => f.split('/').at(-1);

test('the frozen copy is the registered file, byte for byte; a rerun changes nothing', async () => {
  const t = await fixture();
  const out = join(t.dir, 'frozen');
  const first = freeze({ network: 'testnet', record: t.record, out, registeredRoot: t.registeredRoot });
  assert.deepEqual(first.written.map(name), ['forge-core.v1.json', 'forge-collab.v1.json', 'forge-community.v1.json', 'forge-meta.v1.json']);
  for (const f of ['forge-core', 'forge-collab', 'forge-community', 'forge-meta']) {
    assert.ok(readFileSync(join(out, `${f}.v1.json`)).equals(readFileSync(join(SETS.mainnet, `${f}.json`))), f);
  }
  assert.equal(first.registrations, "'testnet': {'set': 'mainnet', 'since': ()},");
  const second = freeze({ network: 'testnet', record: t.record, out, registeredRoot: t.registeredRoot });
  assert.deepEqual([second.written.length, second.unchanged.length], [0, 4]);
});

test('another schema in the way, a changed source or a wrong record are refused, writing nothing', async () => {
  const t = await fixture();
  const out = join(t.dir, 'frozen');
  mkdirSync(out);
  writeFileSync(join(out, 'forge-collab.v1.json'), '{}');
  assert.throws(() => freeze({ network: 'testnet', record: t.record, out, registeredRoot: t.registeredRoot }), /forge-collab\.v1\.json already holds another schema; a network's registration is frozen/);
  assert.equal(readFileSync(join(out, 'forge-collab.v1.json'), 'utf8'), '{}');
  assert.throws(() => readFileSync(join(out, 'forge-core.v1.json')), /ENOENT/, 'nothing written before every check passed');

  // a source that is no longer what was registered (a repo root with an edited copy)
  const fakeRepo = join(t.dir, 'repo');
  mkdirSync(join(fakeRepo, 'forge-contracts', 'contracts', 'mainnet'), { recursive: true });
  for (const f of ['forge-core', 'forge-collab', 'forge-community', 'forge-meta']) {
    writeFileSync(join(fakeRepo, 'forge-contracts', 'contracts', 'mainnet', `${f}.json`), readFileSync(join(SETS.mainnet, `${f}.json`), 'utf8') + (f === 'forge-meta' ? ' ' : ''));
  }
  assert.throws(
    () => freeze({ network: 'testnet', record: t.record, out: join(t.dir, 'frozen2'), repoRoot: fakeRepo, registeredRoot: t.registeredRoot }),
    /forge-contracts\/contracts\/mainnet\/forge-meta\.json is not what forgeMeta was registered from.*registration commit aaaaaaaaaaaa/,
  );

  assert.throws(() => freeze({ network: 'devnet', record: t.record, out }), /accepts "testnet" or "mainnet"/);
  assert.throws(() => freeze({ network: 'testnet', record: t.record }), /--record and --out go together/);
  assert.throws(() => freeze({ network: 'mainnet', record: t.record, out: join(t.dir, 'x'), registeredRoot: t.registeredRoot }), /records network testnet, not mainnet/);
  // the live record has no registration yet: nothing to freeze
  assert.throws(() => freeze({ network: 'testnet', registeredRoot: t.registeredRoot }), /records no forge-v2 registration yet: nothing to freeze/);
});

test('a scratch copy never goes under contracts/registered/', async () => {
  const t = await fixture();
  assert.throws(() => freeze({ network: 'testnet', record: t.record, out: join(t.registeredRoot, 'testnet'), registeredRoot: t.registeredRoot }), /under contracts\/registered\//);
  assert.equal(relative(REPO, SETS.mainnet), 'forge-contracts/contracts/mainnet');
});
