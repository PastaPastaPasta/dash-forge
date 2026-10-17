// node --test forge-contracts/scripts/lib/: the seed scripts' view of a contract set agrees with
// the committed sets, so a four-contract run puts each document type in the contract that holds it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { CONTRACTS, CONTRACT_OF, META_TYPES, ROOT, contractOn, contractsIn } from './seed-io.mjs';

const typesOf = (dir, file) => Object.keys(JSON.parse(readFileSync(join(dir, file), 'utf8')).documentSchemas);

test('the default set is the three devnet contracts', () => {
  const set = contractsIn(join(ROOT, 'contracts'));
  assert.deepEqual(Object.keys(set.contracts), ['core', 'collab', 'community']);
  assert.deepEqual(set.contracts, CONTRACTS);
  assert.deepEqual(set.contractOf, CONTRACT_OF);
});

test('the committed mainnet set is four contracts, forge-meta last', () => {
  const dir = join(ROOT, 'contracts', 'mainnet');
  const { contracts, contractOf } = contractsIn(dir);
  assert.deepEqual(Object.keys(contracts), ['core', 'collab', 'community', 'meta']);
  // META_TYPES is the type list of forge-meta, no more and no fewer
  assert.deepEqual([...META_TYPES].sort(), typesOf(dir, 'forge-meta.json').sort());
  // every type resolves to the contract of its file under a record that has forge-meta
  const ids = { core: 'c', collab: 'l', community: 'm', meta: 'x' };
  for (const [c, json] of Object.entries(contracts)) {
    for (const t of Object.keys(json.documentSchemas)) {
      assert.equal(contractOf[t], c, t);
      assert.equal(contractOn(ids, t, contractOf), c, t);
    }
  }
});

test('a three-contract record keeps the moved types in their old homes', () => {
  const ids = { core: 'c', collab: 'l', community: 'm' };
  for (const t of META_TYPES) assert.equal(contractOn(ids, t), CONTRACT_OF[t], t);
});
