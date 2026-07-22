// PIPELINED: broadcast N chunk-create STs with `window` concurrent broadcasts,
// manual sequential identity-contract nonces, WITHOUT awaiting each confirmation.
// Confirm landing by polling contractNonce; record the landing curve and compute
// sustained docs/sec. Detects nonce-gap stalls and reports failure/retry rate.
import { setup, contractNonce, broadcastBatch, pollUntil, dataContractId, ownerId, loadCreated, saveCreated } from './harness.mjs';
import { log, randomBytes, disconnectSdk } from './lib.mjs';

const WINDOW = Number(process.env.WINDOW ?? 8);
const N = Number(process.env.N ?? 16);
const { sdk, publicKey, priv } = await setup();
const balBefore = Number(await sdk.identities.balance(ownerId));
const base = await contractNonce(sdk);
const packHash = randomBytes(32);
log(`PIPELINE window=${WINDOW} N=${N}. balance=${(balBefore/1e11).toFixed(6)} tDASH base=${base}`);

const { tasks, t0, broadcastMs } = await broadcastBatch({ sdk, publicKey, priv, N, window: WINDOW, base, packHash });
const okCount = tasks.filter((t) => t.ok).length;
const failCount = N - okCount;
log(`broadcast phase: ${okCount}/${N} accepted in ${broadcastMs}ms (${(okCount/(broadcastMs/1000)).toFixed(1)} broadcasts/sec)`);
for (const t of tasks.filter((t) => !t.ok)) log(`  BROADCAST FAIL nonce=${t.nonce}: ${t.err}`);

// Record ids for deletion (only successfully-broadcast ones).
const state = loadCreated();
for (const t of tasks.filter((t) => t.ok)) state.docs.push({ docId: t.docId, phase: `pipe-w${WINDOW}`, nonce: t.nonce.toString() });
saveCreated(state);

// Poll landing curve until cn reaches base + okCount (all accepted ones land) or timeout.
const target = base + BigInt(okCount);
const curve = await pollUntil(sdk, target, t0, 180000, 500);
const finalCn = curve.length ? BigInt(curve[curve.length - 1].cn) : base;
const landed = Number(finalCn - base);
const allLandedT = finalCn >= target ? curve[curve.length - 1].t : null;

// Sustained docs/sec from first broadcast to all-landed.
const sustained = allLandedT ? landed / (allLandedT / 1000) : null;
// Landing waves: deltas between curve samples reveal per-block batching.
const waves = [];
for (let i = 1; i < curve.length; i++) waves.push({ tMs: curve[i].t, landedNow: curve[i].cn - curve[i-1].cn });

const balAfter = Number(await sdk.identities.balance(ownerId));
const result = {
  phase: 'pipeline', window: WINDOW, N,
  broadcast: { accepted: okCount, failed: failCount, broadcastMs, broadcastsPerSec: Number((okCount/(broadcastMs/1000)).toFixed(2)) },
  landing: { landed, allLandedMs: allLandedT, sustainedDocsPerSec: sustained ? Number(sustained.toFixed(3)) : null },
  waves, curve,
  costCredits: balBefore - balAfter,
};
log(`PIPELINE w=${WINDOW}: accepted ${okCount}/${N}, landed ${landed}, allLanded=${allLandedT}ms, sustained=${result.landing.sustainedDocsPerSec} docs/sec`);
console.log(JSON.stringify(result, null, 2));
await disconnectSdk();
