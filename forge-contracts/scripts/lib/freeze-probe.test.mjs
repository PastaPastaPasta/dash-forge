// The freeze fee probes differ in the gated item alone (node --test; no network).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { schemaHash } from './rc2-probe.mjs';
import { CONFIG_PROBES, DOCS_OF, EVENT_PROBES, FREEZE_DOCS, PROBES, emitted, materialize, probeSchemas } from './freeze-probe.mjs';

const schemas = probeSchemas();
const indices = (p, type) => schemas[p].documentSchemas[type].indices;
const named = (p, type, name) => indices(p, type).find((i) => i.name === name);
const without = (p, type, name) => {
  const s = JSON.parse(JSON.stringify(schemas[p].documentSchemas[type]));
  s.indices = s.indices.filter((i) => i.name !== name);
  return s;
};

test('the event probes carry the candidate byKind index, a $createdAt-widened one, or none', () => {
  assert.equal(named('EV-NONE', 'event', 'byKind'), undefined);
  assert.deepEqual(named('EV-KIND', 'event', 'byKind').properties, [{ repoId: 'asc' }, { kind: 'asc' }]);
  assert.deepEqual(named('EV-KINDT', 'event', 'byKind').properties, [{ repoId: 'asc' }, { kind: 'asc' }, { $createdAt: 'asc' }]);
  for (const p of EVENT_PROBES) assert.deepEqual(Object.keys(schemas[p].documentSchemas), ['event']);
});

test('the event probes are otherwise identical, down to their defs', () => {
  const base = JSON.stringify(schemas['EV-NONE'].documentSchemas.event);
  assert.equal(JSON.stringify(without('EV-KIND', 'event', 'byKind')), base);
  assert.equal(JSON.stringify(without('EV-KINDT', 'event', 'byKind')), base);
  for (const p of EVENT_PROBES) assert.deepEqual(schemas[p].schemaDefs, schemas['EV-NONE'].schemaDefs);
});

test('the config probes differ in config.created being rangeCountable alone', () => {
  assert.equal(named('CFG-NONE', 'config', 'created').rangeCountable, undefined);
  assert.equal(named('CFG-COUNT', 'config', 'created').rangeCountable, true);
  const plain = (p) => {
    const s = JSON.parse(JSON.stringify(schemas[p].documentSchemas.config));
    delete s.indices.find((i) => i.name === 'created').rangeCountable;
    return JSON.stringify(s);
  };
  assert.equal(plain('CFG-COUNT'), plain('CFG-NONE'));
  assert.deepEqual(named('CFG-COUNT', 'config', 'created').properties, [{ repoId: 'asc' }, { $createdAt: 'asc' }]);
  for (const p of CONFIG_PROBES) assert.deepEqual(Object.keys(schemas[p].documentSchemas), ['config']);
  assert.deepEqual(schemas['CFG-COUNT'].schemaDefs, schemas['CFG-NONE'].schemaDefs);
});

test('no probe keeps a reference, a contract placeholder or a rule that reads a total', () => {
  for (const p of PROBES) {
    const text = JSON.stringify(schemas[p]);
    assert.ok(!text.includes('refersTo') && !text.includes('ownerRefersTo'), `${p}: a reference left`);
    assert.ok(!/CONTRACT_ID/.test(text), `${p}: a contract placeholder`);
    assert.ok(!/countOf|sumOf/.test(text), `${p}: a rule that reads a total`);
  }
});

test('emitted vectors name every document of a probe, materialize keeps fixed values, hashes tell probes apart', () => {
  for (const p of PROBES) {
    const { contract, vectors } = emitted(p, schemas[p]);
    assert.equal(contract.$formatVersion, '1');
    assert.deepEqual(vectors.map((v) => v.type), DOCS_OF[p].map((d) => FREEZE_DOCS[d].type));
    for (const v of vectors) assert.ok(schemas[p].documentSchemas[v.type], `${p}: vector for a type the probe lacks`);
  }
  const R = Buffer.alloc(32, 9);
  const label = materialize(FREEZE_DOCS.label.doc, { repoId: R }, (n) => Buffer.alloc(n, 1));
  assert.equal(label.repoId, R);
  assert.equal(label.targetId.length, 32);
  assert.equal(label.kind, 4);
  assert.equal(materialize(FREEZE_DOCS.pin.doc, { repoId: R }, (n) => Buffer.alloc(n, 1)).kind, 19);
  assert.equal(new Set(PROBES.map((p) => schemaHash(schemas[p]))).size, PROBES.length);
});
