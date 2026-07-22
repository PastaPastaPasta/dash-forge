// SERIAL baseline: broadcast one chunk doc, poll contractNonce until it lands,
// then the next. Measures full per-doc landing latency (broadcast + block inclusion)
// and docs/sec. Records doc ids for later deletion.
import { setup, contractNonce, broadcastBatch, pollUntil, dataContractId, ownerId, loadCreated, saveCreated, sleep } from './harness.mjs';
import { log, randomBytes, disconnectSdk } from './lib.mjs';

const N = Number(process.env.N ?? 6);
const { sdk, publicKey, priv } = await setup();
const balBefore = Number(await sdk.identities.balance(ownerId));
let base = await contractNonce(sdk);
log(`SERIAL N=${N}. balance=${balBefore} (${(balBefore/1e11).toFixed(6)} tDASH) startNonce=${base}`);

const packHash = randomBytes(32);
const state = loadCreated();
const latencies = [];
const runStart = Date.now();
let landed = 0;

for (let i = 0; i < N; i++) {
  const t0 = Date.now();
  const { tasks } = await broadcastBatch({ sdk, publicKey, priv, N: 1, window: 1, base, packHash: randomBytes(32) });
  const task = tasks[0];
  if (!task.ok) { log(`  #${i} broadcast FAIL ${task.err}`); base = await contractNonce(sdk); i--; await sleep(2000); continue; }
  // poll until cn advances past base (this doc landed)
  const target = base + 1n;
  const curve = await pollUntil(sdk, target, t0, 120000);
  const cn = curve.length ? BigInt(curve[curve.length - 1].cn) : base;
  if (cn >= target) {
    const dt = Date.now() - t0;
    latencies.push(dt);
    state.docs.push({ docId: task.docId, phase: 'serial', nonce: task.nonce.toString() });
    saveCreated(state);
    landed++;
    log(`  #${i} nonce=${task.nonce} LANDED ${dt}ms (broadcast ${task.sendMs}ms)`);
    base = cn;
  } else {
    log(`  #${i} nonce=${task.nonce} TIMEOUT cn=${cn}`);
    base = await contractNonce(sdk);
  }
}

const runMs = Date.now() - runStart;
latencies.sort((a, b) => a - b);
const med = latencies[Math.floor(latencies.length / 2)];
const p90 = latencies[Math.floor(latencies.length * 0.9)] ?? latencies[latencies.length-1];
const mean = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
const balAfter = Number(await sdk.identities.balance(ownerId));
const result = {
  phase: 'serial', N, landed,
  latencyMs: { min: latencies[0], median: med, mean, p90, max: latencies[latencies.length-1] },
  runMs, docsPerSec: Number((landed / (runMs/1000)).toFixed(3)),
  costCredits: balBefore - balAfter, costPerDocCredits: Math.round((balBefore-balAfter)/Math.max(1,landed)),
};
log(`SERIAL done: ${landed}/${N} median=${med}ms p90=${p90}ms docs/sec=${result.docsPerSec} cost/doc=${result.costPerDocCredits}`);
console.log(JSON.stringify(result, null, 2));
saveCreated(state);
await disconnectSdk();
