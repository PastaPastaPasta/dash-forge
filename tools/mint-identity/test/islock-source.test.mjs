import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkIslockSource, ISLOCK_MAX_LAG_BLOCKS } from '../src/islock.mjs';

const rpc = (result, status = 200) => async () => ({ ok: status === 200, status, json: async () => ({ result }) });

test('an islock node near the tip is usable', async () => {
  assert.equal((await checkIslockSource('u', 1000, { fetchImpl: rpc(1000 - ISLOCK_MAX_LAG_BLOCKS) })).ok, true);
});

test('an islock node stuck behind the tip is not', async () => {
  const r = await checkIslockSource('u', 1594362, { fetchImpl: rpc(1577999) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /16363 behind/);
});

test('an unreachable or broken islock node is not usable', async () => {
  assert.equal((await checkIslockSource('u', 1000, { fetchImpl: rpc(null, 503) })).ok, false);
  assert.equal((await checkIslockSource('u', 1000, { fetchImpl: rpc(null) })).ok, false);
  assert.equal((await checkIslockSource('u', 1000, { fetchImpl: async () => { throw new Error('reset'); } })).ok, false);
});

test('an unknown chain tip keeps a reachable islock node', async () => {
  assert.equal((await checkIslockSource('u', undefined, { fetchImpl: rpc(5) })).ok, true);
});
