// node --test forge-contracts/scripts/lib/refresh-dapi.test.mjs
// refresh-dapi.mjs without a network: a trimmed `/masternodes` body, an injected fetch and probe.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { candidates, diffLists, judgeProbes, main, mapLimit, median, platformUrl, sortUrls, versionAtLeast } from '../refresh-dapi.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BODY = JSON.parse(readFileSync(join(HERE, 'fixtures', 'masternodes-testnet.json'), 'utf8'));

const RC3_1443 = 'https://68.67.122.3:1443';
const RC3_22822 = 'https://173.199.119.242:22822';
const RC3_NO_LIST = 'https://203.0.113.9:1443';
const STUCK_413 = 'https://206.245.167.63:1443';

test('versionAtLeast compares major.minor and treats a missing version as too old', () => {
  assert.ok(versionAtLeast('5.0.0-rc.3', '5.0'));
  assert.ok(versionAtLeast('5.1.0', '5.0'));
  assert.ok(versionAtLeast('6.0.0', '5.9'));
  assert.ok(!versionAtLeast('4.1.2', '5.0'));
  assert.ok(!versionAtLeast(undefined, '5.0'));
  assert.ok(!versionAtLeast('unreleased', '5.0'));
  assert.throws(() => versionAtLeast('5.0.0', 'five'), /bad version floor/);
});

test('platformUrl takes platform_https, else the address host with platformHTTPPort', () => {
  assert.equal(platformUrl({ addresses: { platform_https: ['1.2.3.4:22822'] }, address: '1.2.3.4:19999', platformHTTPPort: 1443 }), 'https://1.2.3.4:22822');
  assert.equal(platformUrl({ addresses: {}, address: '1.2.3.4:19999', platformHTTPPort: 22822 }), 'https://1.2.3.4:22822');
  assert.equal(platformUrl({ addresses: {}, address: '[::]:0', platformHTTPPort: 1443 }), null);
  assert.equal(platformUrl({ addresses: {}, address: '1.2.3.4:19999' }), null);
});

test('the captured /masternodes body yields exactly the rc.3 nodes', () => {
  const { urls, skipped } = candidates(BODY);
  assert.deepEqual(urls, sortUrls([RC3_1443, RC3_22822, RC3_NO_LIST]));
  // the stuck 4.1.2 node passes the service's own ENABLED + versionCheck filter, and is dropped here
  assert.ok(skipped.some((s) => s.url === STUCK_413 && /4\.1\.2/.test(s.reason)));
  assert.ok(skipped.some((s) => /unreported/.test(s.reason)));
  // a POSE_BANNED node is not even reported as skipped
  assert.equal(skipped.length, 2);
});

test('a body the service did not mean to send is refused', () => {
  assert.throws(() => candidates({ success: false, data: [] }), /unexpected/);
  assert.throws(() => candidates({ success: true }), /unexpected/);
});

test('median is the lower middle', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 2);
});

const ok = (url, over = {}) => ({ url, protocol: 14, chainId: 'dash-testnet-51', height: 1000, ...over });

test('judgeProbes drops protocol 13, a wrong chain, an unreachable node and a stuck one', () => {
  const results = [
    ok('https://a:1'),
    ok('https://b:1', { height: 1010 }),
    ok('https://c:1', { height: 990 }),
    ok('https://old:1', { protocol: 13 }),
    ok('https://other:1', { chainId: 'dash-devnet-x' }),
    ok('https://stuck:1', { height: 400 }),
    { url: 'https://down:1', error: 'timed out' },
  ];
  const v = judgeProbes(results, { chainId: 'dash-testnet-51', maxLag: 20 });
  assert.deepEqual(v.kept, ['https://a:1', 'https://b:1', 'https://c:1']);
  assert.deepEqual(
    v.rejected.map((r) => r.url).sort(),
    ['https://down:1', 'https://old:1', 'https://other:1', 'https://stuck:1'],
  );
  assert.match(v.rejected.find((r) => r.url === 'https://stuck:1').reason, /median/);
});

test('the median-height rule is within maxLag, both ways, and the chain defaults to the majority', () => {
  const results = [ok('https://a:1', { height: 1000 }), ok('https://b:1', { height: 1020 }), ok('https://c:1', { height: 1021 }), ok('https://d:1', { height: 1000, chainId: 'odd' })];
  // median of [1000, 1000, 1020, 1021] is 1000
  const v = judgeProbes(results, { maxLag: 20 });
  assert.equal(v.chainId, 'dash-testnet-51');
  assert.equal(v.medianHeight, 1000);
  assert.deepEqual(v.kept, ['https://a:1', 'https://b:1']);
  assert.deepEqual(v.rejected.map((r) => r.url).sort(), ['https://c:1', 'https://d:1']);
});

test('nothing answers: nothing is kept', () => {
  const v = judgeProbes([{ url: 'https://a:1', error: 'x' }], {});
  assert.deepEqual(v.kept, []);
});

test('mapLimit keeps order and never exceeds the limit', async () => {
  let live = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    peak = Math.max(peak, ++live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.ok(peak <= 3);
});

test('diffLists names what a write adds and removes', () => {
  assert.deepEqual(diffLists(['a', 'b'], ['b', 'c']), { added: ['c'], removed: ['a'] });
});

// ---- the command, with an injected fetch and probe ------------------------------------------------

const fetchFn = async () => ({ ok: true, status: 200, json: async () => BODY });

function deploymentsDir(addresses, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'refresh-dapi-'));
  writeFileSync(join(dir, 'testnet.json'), `${JSON.stringify({ dapiAddresses: addresses, keyExchange: { contractId: 'x' }, ...extra }, null, 2)}\n`);
  return dir;
}
const probeAll = (over = {}) => async (url) => ok(url, over[url] ?? {});

test('no flag: prints the sorted list and writes nothing', async () => {
  const dir = deploymentsDir([STUCK_413]);
  const r = await main(['--network', 'testnet'], { fetchFn, probe: probeAll(), deploymentsDir: dir });
  assert.equal(r.code, 0);
  assert.deepEqual(r.stdout, sortUrls([RC3_1443, RC3_22822, RC3_NO_LIST]));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'testnet.json'), 'utf8')).dapiAddresses, [STUCK_413]);
});

test('the probe drops a candidate that reports protocol 13', async () => {
  const r = await main(['--network', 'testnet'], { fetchFn, probe: probeAll({ [RC3_22822]: { protocol: 13 } }), deploymentsDir: deploymentsDir([]) });
  assert.deepEqual(r.stdout, sortUrls([RC3_1443, RC3_NO_LIST]));
});

test('--write replaces only dapiAddresses and refuses fewer than --min', async () => {
  const dir = deploymentsDir([RC3_1443, STUCK_413]);
  const refused = await main(['--network', 'testnet', '--write'], { fetchFn, probe: probeAll(), deploymentsDir: dir });
  assert.equal(refused.code, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'testnet.json'), 'utf8')).dapiAddresses, [RC3_1443, STUCK_413]);

  const wrote = await main(['--network', 'testnet', '--write', '--min', '3'], { fetchFn, probe: probeAll(), deploymentsDir: dir });
  assert.equal(wrote.code, 0);
  const after = JSON.parse(readFileSync(join(dir, 'testnet.json'), 'utf8'));
  assert.deepEqual(after.dapiAddresses, sortUrls([RC3_1443, RC3_22822, RC3_NO_LIST]));
  assert.deepEqual(after.keyExchange, { contractId: 'x' });
  assert.deepEqual(Object.keys(after), ['dapiAddresses', 'keyExchange']);
});

test('--check exits 1 naming a recorded seed that reports protocol 13, 0 when all pass', async () => {
  const bad = deploymentsDir([RC3_1443, RC3_22822, STUCK_413]);
  const failed = await main(['--network', 'testnet', '--check'], {
    probe: probeAll({ [STUCK_413]: { protocol: 13, chainId: 'unknown', height: 0 } }),
    deploymentsDir: bad,
  });
  assert.equal(failed.code, 1);
  const good = deploymentsDir([RC3_1443, RC3_22822]);
  assert.equal((await main(['--network', 'testnet', '--check'], { probe: probeAll(), deploymentsDir: good })).code, 0);
});

test('--check --no-probe judges the recorded list by the service list alone', async () => {
  const args = ['--network', 'testnet', '--check', '--no-probe'];
  assert.equal((await main(args, { fetchFn, deploymentsDir: deploymentsDir([RC3_1443, RC3_22822]) })).code, 0);
  assert.equal((await main(args, { fetchFn, deploymentsDir: deploymentsDir([RC3_1443, STUCK_413]) })).code, 1);
});

test('--write and --check together, and an unknown network, are refused', async () => {
  await assert.rejects(main(['--network', 'testnet', '--write', '--check'], {}), /exclusive/);
  await assert.rejects(main(['--network', 'devnet'], {}), /testnet or mainnet/);
});

// ---- the recorded lists (offline: shape only; `--check` is the live probe) ----------------------------

test('every recorded dapiAddresses list is a set of https://host:port, with no duplicates', () => {
  const dir = join(HERE, '..', '..', 'deployments');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const { dapiAddresses } = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (dapiAddresses === undefined) continue;
    for (const u of dapiAddresses) assert.match(u, /^https:\/\/[A-Za-z0-9.-]+:\d+$/, `${f}: ${u}`);
    assert.equal(new Set(dapiAddresses).size, dapiAddresses.length, `${f}: a seed is listed twice`);
  }
});

test('the testnet list keeps enough seeds that --write would have accepted it', () => {
  const { dapiAddresses } = JSON.parse(readFileSync(join(HERE, '..', '..', 'deployments', 'testnet.json'), 'utf8'));
  assert.ok(dapiAddresses.length >= 8, `testnet records ${dapiAddresses.length} seeds`);
});

test('--write refuses an unprobed list', async () => {
  await assert.rejects(main(['--network', 'testnet', '--write', '--no-probe'], { fetchFn: async () => { throw new Error('no fetch expected'); } }), /--write records only probed nodes/);
});
