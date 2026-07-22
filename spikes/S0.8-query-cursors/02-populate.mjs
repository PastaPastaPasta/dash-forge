// Populate the skewed dataset. Idempotent-ish, driven by env HOT_TARGET (total hot rows).
//   HOT_TARGET=3   node 02-populate.mjs   # phase 1: cold keys (once) + 3 hot rows
//   HOT_TARGET=150 node 02-populate.mjs   # phase 2: top hot key up to 150 rows
// Broadcasts creates with a concurrency window and manual sequential nonces, then polls
// the identity-contract nonce until all land.
import { getSdk, disconnectSdk, loadIdentity, pickAuthKey, buildKeyAndSigner, buildRefCreateSt, contractNonce, pollNonce, log, errStr, BROADCAST_SETTINGS, loadState, saveState, sleep } from './lib.mjs';

const HOT_TARGET = Number(process.env.HOT_TARGET ?? 3);
const WINDOW = Number(process.env.WINDOW ?? 12);

const state = loadState();
if (!state.contractId) throw new Error('run 01-register.mjs first');
const { contractId, ownerId, hotHashHex, plan } = state;
state.docs = state.docs || [];

const rec = loadIdentity('DEPLOYER');
const sdk = await getSdk(); // must connect (init wasm) BEFORE constructing IdentityPublicKey
const { publicKey, priv } = buildKeyAndSigner(pickAuthKey(rec, 'HIGH'));

// Build the work list of (hashHex, refName) rows still to create.
const nameByHash = Object.fromEntries(plan.map((p) => [p.hashHex, p.name]));
const countByHash = {};
for (const d of state.docs) countByHash[d.hashHex] = (countByHash[d.hashHex] || 0) + 1;

const work = [];
// Cold keys: create up to coldRows each (only fills the gap if partially done).
if (!state.coldDone) {
  for (const p of plan) {
    if (p.hot) continue;
    const have = countByHash[p.hashHex] || 0;
    for (let i = have; i < p.coldRows; i++) work.push({ hashHex: p.hashHex, name: p.name });
  }
}
// Hot key: fill up to HOT_TARGET.
{
  const have = countByHash[hotHashHex] || 0;
  for (let i = have; i < HOT_TARGET; i++) work.push({ hashHex: hotHashHex, name: nameByHash[hotHashHex] });
}

if (work.length === 0) { log('nothing to create'); await disconnectSdk(); process.exit(0); }
log(`creating ${work.length} docs (window=${WINDOW}). cold${state.coldDone ? ' already done' : ''}, hot target ${HOT_TARGET}`);

// The identity-contract nonce only permits a limited look-ahead (~24). Broadcasting
// all remaining work at once is rejected "nonce too far in future" — so process the
// work list in chunks, polling each chunk to land before the next.
const CHUNK = Number(process.env.CHUNK ?? 18);
let totalCreated = 0;
for (let off = 0; off < work.length; off += CHUNK) {
  const slice = work.slice(off, off + CHUNK);
  const base = await contractNonce(sdk, ownerId, contractId);
  const tasks = slice.map((w, i) => ({
    ...w,
    nonce: base + 1n + BigInt(i),
    ...buildRefCreateSt({ ownerId, dataContractId: contractId, refNameHash: Buffer.from(w.hashHex, 'hex'), refName: w.name, nonce: base + 1n + BigInt(i), priv, publicKey }),
    ok: null, err: null,
  }));
  const t0 = Date.now();
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const task = tasks[next++];
      try { await sdk.stateTransitions.broadcastStateTransition(task.st, BROADCAST_SETTINGS); task.ok = true; }
      catch (e) { task.ok = false; task.err = errStr(e); }
    }
  }
  await Promise.all(Array.from({ length: WINDOW }, () => worker()));
  const okCount = tasks.filter((t) => t.ok).length;
  for (const t of tasks.filter((t) => !t.ok)) log(`  create FAIL nonce=${t.nonce}: ${t.err.slice(0, 80)}`);
  const cn = await pollNonce(sdk, ownerId, contractId, base + BigInt(okCount), 240000);
  await sleep(1500);
  for (const t of tasks) {
    if (t.ok && t.nonce <= cn) { state.docs.push({ docId: t.docId, hashHex: t.hashHex, nonce: t.nonce.toString() }); totalCreated++; }
  }
  saveState(state);
  log(`  chunk [${off}..${off + slice.length}) landed ${okCount}/${slice.length} in ${Date.now() - t0}ms; total created ${totalCreated}`);
}
const okCount = totalCreated;
if (!state.coldDone) state.coldDone = true;
saveState(state);

const finalCounts = {};
for (const d of state.docs) finalCounts[d.hashHex] = (finalCounts[d.hashHex] || 0) + 1;
log(`total docs recorded: ${state.docs.length}`);
console.log(JSON.stringify({ created: okCount, totalDocs: state.docs.length, hotRows: finalCounts[hotHashHex], distinctKeys: Object.keys(finalCounts).length }, null, 2));
await disconnectSdk();
