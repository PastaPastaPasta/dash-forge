// Devnet sakura in the network registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEVNETS } from '../src/config.mjs';

const deployment = JSON.parse(
  readFileSync(new URL('../../../forge-contracts/deployments/devnet-sakura.json', import.meta.url), 'utf8'),
);

test('sakura is a known devnet: 13 DAPI nodes, its quorum service and chain id', () => {
  const s = DEVNETS.sakura;
  assert.equal(s.dapiAddresses.length, 13);
  assert.ok(s.dapiAddresses.every((a) => /^https:\/\/68\.67\.122\.\d+:1443$/.test(a)));
  assert.equal(s.quorumUrl, 'https://quorums.sakura.networks.dash.org');
  // No `-g1` suffix: the chain id is not derived from the name.
  assert.equal(s.chainId, 'dash-devnet-sakura');
});

test('sakura matches its deployment record (chain id, quorum service, DAPI list)', () => {
  const s = DEVNETS.sakura;
  assert.equal(s.chainId, deployment.chainId);
  assert.equal(s.quorumUrl, deployment.quorumBaseUrl);
  assert.deepEqual(s.dapiAddresses, deployment.dapiAddresses);
});
