// Devnet bonsia in the network registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEVNETS } from '../src/config.mjs';

test('bonsia is a known devnet: 13 DAPI nodes, its quorum service and chain id', () => {
  const b = DEVNETS.bonsia;
  assert.equal(b.dapiAddresses.length, 13);
  assert.ok(b.dapiAddresses.every((a) => /^https:\/\/68\.67\.122\.\d+:1443$/.test(a)));
  assert.equal(b.quorumUrl, 'https://quorums.bonsia.networks.dash.org');
  assert.equal(b.chainId, 'dash-devnet-bonsia-g1');
});
