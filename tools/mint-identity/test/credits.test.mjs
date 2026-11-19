import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, parseSpec } from '../credits.mjs';

test('parseSpec splits name, file and minimum, keeping = inside the file path', () => {
  assert.deepEqual(parseSpec('OWNER=/a=b/OWNER.json=0.5', '--identity'), { name: 'OWNER', file: '/a=b/OWNER.json', min: 0.5 });
  assert.deepEqual(parseSpec('/k=.wif=1.2', '--funding', { named: false }), { name: undefined, file: '/k=.wif', min: 1.2 });
  assert.throws(() => parseSpec('OWNER=/f', '--identity'), /min DASH/);
  assert.throws(() => parseSpec('0.5', '--identity'), /min DASH/);
  assert.throws(() => parseSpec('OWNER=/f=x', '--identity'), /min DASH/);
  assert.throws(() => parseSpec('OWNER=/f=', '--identity'), /min DASH/);
  assert.throws(() => parseSpec('OWNER=/f=0x10', '--identity'), /min DASH/);
  assert.throws(() => parseSpec('cNotAKeyButShapedLikeOne', '--funding', { named: false }), (e) => !e.message.includes('cNotAKey'));
});

test('evaluate names each identity below its minimum and never fails an unreadable one', () => {
  const { short, unknown } = evaluate([
    { label: 'OWNER', id: 'a', dash: 0.0005, min: 0.5 },
    { label: 'COLLAB', id: 'b', dash: 0.8, min: 0.05 },
    { label: 'CONTRIB', id: 'c', dash: null, min: 0.05 },
  ]);
  assert.deepEqual(short.map((r) => r.label), ['OWNER']);
  assert.ok(Math.abs(short[0].shortfall - 0.4995) < 1e-12);
  assert.deepEqual(unknown.map((r) => r.label), ['CONTRIB']);
});
