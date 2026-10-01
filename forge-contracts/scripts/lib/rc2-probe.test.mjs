// The RC2 fee probes differ in the gated item alone (node --test; no network).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PROBES, RC2_DOCS, REVIEW_PROBES, emitted, indexNames, materialize, probeSchemas, schemaHash } from './rc2-probe.mjs';

const schemas = probeSchemas();
const withoutIndex = (schema, type, names) => {
  const s = JSON.parse(JSON.stringify(schema.documentSchemas[type]));
  s.indices = s.indices.filter((i) => !names.includes(i.name));
  return s;
};

test('each review probe carries exactly its gated indexes', () => {
  assert.deepEqual(indexNames(schemas.ALL, 'review'), ['patch', 'verdicts', 'toAuthor', 'author']);
  assert.deepEqual(indexNames(schemas.S2, 'review'), ['patch', 'verdicts', 'toAuthor']);
  assert.deepEqual(indexNames(schemas.S3, 'review'), ['patch', 'verdicts', 'author']);
  assert.deepEqual(indexNames(schemas.NONE, 'review'), ['patch', 'verdicts']);
});

test('the review probes are otherwise identical, down to their defs', () => {
  const base = JSON.stringify(schemas.NONE.documentSchemas.review);
  assert.equal(JSON.stringify(withoutIndex(schemas.ALL, 'review', ['toAuthor', 'author'])), base);
  assert.equal(JSON.stringify(withoutIndex(schemas.S2, 'review', ['toAuthor'])), base);
  assert.equal(JSON.stringify(withoutIndex(schemas.S3, 'review', ['author'])), base);
  for (const p of REVIEW_PROBES) {
    assert.deepEqual(Object.keys(schemas[p].documentSchemas), ['patch', 'review']);
    assert.deepEqual(schemas[p].documentSchemas.patch, schemas.NONE.documentSchemas.patch);
    assert.deepEqual(schemas[p].schemaDefs, schemas.NONE.schemaDefs);
  }
});

test('S2 keeps the reference its derived index reads; nothing else refers anywhere', () => {
  for (const p of PROBES) {
    const review = schemas[p].documentSchemas.review;
    if (review) {
      assert.equal(review.properties.patchId.refersTo.documentType, 'patch');
      assert.equal(review.properties.patchId.refersTo.contractId, undefined);
    }
    const rest = JSON.stringify({ ...schemas[p], documentSchemas: { ...schemas[p].documentSchemas, review: review && { ...review, properties: { ...review.properties, patchId: {} } } } });
    assert.ok(!rest.includes('refersTo'), `${p}: a reference left outside review.patchId`);
    assert.ok(!/countOf|sumOf/.test(rest), `${p}: a rule that reads a total`);
  }
});

test('C1: FUSED is the fused star alone, SPLIT is star + starBeat with the same star otherwise', () => {
  assert.deepEqual(Object.keys(schemas.FUSED.documentSchemas), ['star']);
  assert.ok(schemas.FUSED.documentSchemas.star.indices.find((i) => i.name === 'byWeek')?.outlivesDelete);
  assert.deepEqual(Object.keys(schemas.SPLIT.documentSchemas), ['star', 'starBeat']);
  assert.deepEqual(indexNames(schemas.SPLIT, 'star'), ['byRepo', 'byOwner']);
  assert.deepEqual(indexNames(schemas.FUSED, 'star'), ['byRepo', 'byOwner', 'byWeek']);
  assert.deepEqual(schemas.FUSED.schemaDefs, schemas.SPLIT.schemaDefs);
});

test('a probe is the same whatever the FLAGS defaults: each sets every gated flag', () => {
  // probeSchemas passes each probe's own `on` list; the build sees the rest of the three as off
  const seen = [];
  probeSchemas((on) => {
    seen.push(on);
    return { collab: { schemaDefs: {}, documentSchemas: { review: { properties: { patchId: {} }, indices: [] } } }, community: { schemaDefs: {}, documentSchemas: { star: { properties: {}, indices: [] } } } };
  });
  assert.deepEqual(seen, [['review_to_author', 'review_author'], ['review_to_author'], ['review_author'], [], ['fused_star'], []]);
});

test('emitted vectors name every type, materialize keeps fixed values, hashes tell schemas apart', () => {
  for (const p of PROBES) {
    const { contract, vectors } = emitted(p, schemas[p]);
    assert.equal(contract.$formatVersion, '1');
    assert.deepEqual(vectors.map((v) => v.type), Object.keys(schemas[p].documentSchemas));
  }
  const R = Buffer.alloc(32, 9);
  const doc = materialize(RC2_DOCS.review, { repoId: R }, (n) => Buffer.alloc(n, 1));
  assert.equal(doc.repoId, R);
  assert.equal(doc.commitOid.length, 20);
  assert.equal(doc.patchId.length, 32);
  assert.equal(doc.verdict, 3);
  assert.equal(new Set(PROBES.map((p) => schemaHash(schemas[p]))).size, PROBES.length);
});
