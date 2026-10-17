// The identity id of an asset lock is derived before anything connects to Platform (testnet's
// InstantSend path): platform.mjs must load the wasm itself, or the first proof call fails with
// "Cannot read properties of undefined (reading '__wbindgen_malloc')". A fresh process, so no
// other test has loaded it first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { identityIdFromOutpoint } from '../src/restore.mjs';

const TXID = 'e8b43025641eea4fd21190f01bd870ef90f1a8b199d8fc3376c5b62c0b1a179d';
const PLATFORM = new URL('../src/platform.mjs', import.meta.url).href;

test('identityIdFromLock works in a process that never connected', () => {
  const script = `const p = await import(${JSON.stringify(PLATFORM)});
console.log(p.identityIdFromLock({ type: 'chain', txid: '${TXID}', coreChainLockedHeight: 1, outputIndex: 0 }));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), identityIdFromOutpoint(TXID, 0));
});
