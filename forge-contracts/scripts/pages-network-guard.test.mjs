import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { guardProblems, liveNetworkOf } from './pages-network-guard.mjs';

const dir = mkdtempSync(join(tmpdir(), 'guard-'));
const reg = (id) => ({ status: 'registered', contractId: id });
writeFileSync(join(dir, 'testnet.json'), JSON.stringify({ v2: { forgeCore: reg('a'), forgeCollab: reg('b'), contractGroupId: 'g' } }));
writeFileSync(join(dir, 'mainnet.json'), JSON.stringify({ dapiAddresses: [] }));
const g = (o) => guardProblems({ deploymentsDir: dir, devnetName: null, confirm: null, ...o });

test('a push that keeps the live network deploys', () => {
  assert.deepEqual(g({ network: 'testnet', event: 'push', liveNetwork: 'testnet' }), []);
});

test('a push that would flip the live network is refused', () => {
  const p = g({ network: 'testnet', event: 'push', liveNetwork: 'mainnet' });
  assert.equal(p.length, 1);
  assert.match(p[0], /confirm_network: testnet/);
});

test('mainnet is refused while its record is incomplete, even when confirmed', () => {
  const p = g({ network: 'mainnet', event: 'workflow_dispatch', confirm: 'mainnet', liveNetwork: 'testnet' });
  assert.equal(p.length, 1);
  assert.match(p[0], /mainnet.json is not a usable deployment/);
});

test('a confirmed manual run switches the network once the record is complete', () => {
  writeFileSync(join(dir, 'mainnet.json'), JSON.stringify({ v2: { forgeCore: reg('a'), forgeCollab: reg('b'), contractGroupId: 'g' } }));
  assert.deepEqual(g({ network: 'mainnet', event: 'workflow_dispatch', confirm: 'mainnet', liveNetwork: 'testnet' }), []);
  assert.equal(g({ network: 'mainnet', event: 'workflow_dispatch', confirm: 'testnet', liveNetwork: 'testnet' }).length, 1);
  assert.equal(g({ network: 'mainnet', event: 'push', liveNetwork: 'testnet' }).length, 1);
  assert.deepEqual(g({ network: 'mainnet', event: 'push', liveNetwork: 'mainnet' }), []);
});

test('an unreadable live site counts as a change', () => {
  assert.equal(g({ network: 'testnet', event: 'push', liveNetwork: null }).length, 1);
  assert.deepEqual(g({ network: 'testnet', event: 'workflow_dispatch', confirm: 'testnet', liveNetwork: null }), []);
});

test('a mismatched confirmation on a same-network run is refused', () => {
  assert.equal(g({ network: 'testnet', event: 'workflow_dispatch', confirm: 'mainnet', liveNetwork: 'testnet' }).length, 1);
  assert.deepEqual(g({ network: 'testnet', event: 'workflow_dispatch', liveNetwork: 'testnet' }), []);
});

test('devnet builds are keyed by name and need no record check', () => {
  assert.deepEqual(guardProblems({ deploymentsDir: dir, network: 'devnet', devnetName: 'x', event: 'push', confirm: null, liveNetwork: 'devnet-x' }), []);
});

test('reads the live manifest network, null on any failure', async () => {
  assert.equal(await liveNetworkOf('https://x.test', async () => ({ ok: true, json: async () => ({ network: 'testnet' }) })), 'testnet');
  assert.equal(await liveNetworkOf('https://x.test', async () => ({ ok: false })), null);
  assert.equal(await liveNetworkOf('https://x.test', async () => { throw new Error('down'); }), null);
  assert.equal(await liveNetworkOf('https://x.test', async () => ({ ok: true, json: async () => ({}) })), null);
});
