// DELETE all recorded docs to reclaim storage credits, confirming refund via balance.
// Deletes are broadcast with manual sequential nonces (same nonce space as creates)
// and confirmed by polling contractNonce. Also sweeps orphans found via index query.
import { readFileSync } from 'node:fs';
import { setup, contractNonce, dataContractId, ownerId, loadCreated, saveCreated, pollUntil, sleep } from './harness.mjs';
import { buildChunkDeleteSt, log, errStr, disconnectSdk } from './lib.mjs';

const WINDOW = Number(process.env.DEL_WINDOW ?? 8);
const { sdk, publicKey, priv } = await setup();
const balBefore = Number(await sdk.identities.balance(ownerId));
let base = await contractNonce(sdk);
log(`DELETE: balance=${balBefore} (${(balBefore/1e11).toFixed(6)} tDASH) startNonce=${base} window=${WINDOW}`);

// Gather ids: from state file + orphan sweep via pack_seq index walk.
const state = loadCreated();
const ids = new Set(state.docs.map((d) => d.docId));
try {
  const res = await sdk.documents.query({ dataContractId, documentTypeName: 'chunk', orderBy: [['packHash', 'asc'], ['seq', 'asc']], limit: 100 });
  const found = res instanceof Map ? [...res.keys()] : (res ?? []).map((d) => d.id?.toString?.());
  for (const id of found) ids.add(id);
  log(`index-walk found ${found.length} docs on-chain; total unique to delete: ${ids.size}`);
} catch (e) { log(`orphan query err: ${errStr(e)}`); }

const idList = [...ids];
if (idList.length === 0) { log('nothing to delete'); await disconnectSdk(); process.exit(0); }

// Broadcast deletes with window concurrency, manual nonces base+1..base+M.
const tasks = idList.map((docId, i) => ({ docId, nonce: base + 1n + BigInt(i), ok: null, err: null }));
const t0 = Date.now();
let next = 0;
async function worker() {
  while (next < tasks.length) {
    const task = tasks[next++];
    const { st } = buildChunkDeleteSt({ ownerId, dataContractId, docId: task.docId, nonce: task.nonce, priv, publicKey });
    try { await sdk.stateTransitions.broadcastStateTransition(st, { connectTimeoutMs: 15000, timeoutMs: 30000, retries: 2 }); task.ok = true; }
    catch (e) { task.ok = false; task.err = errStr(e); }
  }
}
await Promise.all(Array.from({ length: WINDOW }, () => worker()));
const okCount = tasks.filter((t) => t.ok).length;
log(`broadcast ${okCount}/${tasks.length} deletes in ${Date.now()-t0}ms; polling for landing...`);
for (const t of tasks.filter((t) => !t.ok)) log(`  delete FAIL nonce=${t.nonce}: ${t.err}`);

const target = base + BigInt(okCount);
const curve = await pollUntil(sdk, target, t0, 180000);
await sleep(3000);
const balAfter = Number(await sdk.identities.balance(ownerId));
const cnAfter = await contractNonce(sdk);
const refund = balAfter - balBefore;
log(`DELETE done: cnAfter=${cnAfter}. balance ${balBefore} -> ${balAfter}. REFUND=${refund} credits (${(refund/1e11).toFixed(6)} tDASH)`);
log(`  per-doc net refund: ${Math.round(refund/Math.max(1,okCount))} credits over ${okCount} deletes`);

// Clear state file for docs we deleted.
const remaining = state.docs.filter((d) => !tasks.find((t) => t.ok && t.docId === d.docId));
saveCreated({ docs: remaining });
console.log(JSON.stringify({ deleted: okCount, balBefore, balAfter, refund, cnAfter: cnAfter.toString(), landingCurve: curve }, null, 2));
await disconnectSdk();
