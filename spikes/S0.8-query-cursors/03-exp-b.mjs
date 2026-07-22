// Experiment B — skip-scan distinct-ref enumeration seek cost.
//   LABEL=early node 03-exp-b.mjs   # run when hot key has few rows
//   LABEL=late  node 03-exp-b.mjs   # run when hot key has ~150 rows
// Enumerates distinct refNameHash via `refNameHash > last` orderBy refNameHash LIMIT 1.
// Measures per-hop latency and correlates it with the row-count of the key at each
// boundary, to prove the seek is O(log n) (flat) rather than O(rows-of-hot-key).
import { getSdk, disconnectSdk, log, loadState, saveState, sleep } from './lib.mjs';
import { queryDocs, resolveForm, hashOperand, docHashHex } from './qlib.mjs';

const LABEL = process.env.LABEL || 'run';
const REPEATS = Number(process.env.REPEATS ?? 3); // per-hop repeats to average out network jitter

const state = loadState();
if (!state.contractId) throw new Error('run 01/02 first');
const { contractId, hotHashHex } = state;

// actual per-key row counts (from recorded docs)
const rowCount = {};
for (const d of state.docs) rowCount[d.hashHex] = (rowCount[d.hashHex] || 0) + 1;

const sdk = await getSdk();
const form = await resolveForm(sdk, contractId, hotHashHex);

// Try orderBy on refNameHash only; fall back to including $createdAt if the index
// path rejects a bare-leading-component orderBy.
async function hop(lastHex) {
  const where = lastHex ? [['refNameHash', '>', hashOperand(lastHex, form)]] : [];
  const orderVariants = [
    [['refNameHash', 'asc']],
    [['refNameHash', 'asc'], ['$createdAt', 'asc']],
  ];
  let lastErr;
  for (const orderBy of orderVariants) {
    try {
      const t0 = Date.now();
      const docs = await queryDocs(sdk, { dataContractId: contractId, documentTypeName: 'refUpdate', where, orderBy, limit: 1 });
      const ms = Date.now() - t0;
      return { docs, ms, orderBy };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// Full enumeration with per-hop timing.
async function enumerate() {
  const hops = [];
  let last = null;
  for (let i = 0; i < 50; i++) {
    // repeat the same hop to get a stable latency
    let best = Infinity; let sample = null;
    for (let r = 0; r < REPEATS; r++) {
      const { docs, ms } = await hop(last);
      sample = docs;
      if (ms < best) best = ms;
    }
    if (sample.length === 0) { hops.push({ hop: i, empty: true, ms: best }); break; }
    const hex = docHashHex(sample[0]);
    hops.push({ hop: i, hashHex: hex, rowsAtKey: rowCount[hex] ?? '?', ms: best });
    last = hex;
  }
  return hops;
}

log(`--- skip-scan enumeration [${LABEL}] (hot key rows=${rowCount[hotHashHex]}) ---`);
const hops = await enumerate();
const distinct = hops.filter((h) => !h.empty).length;
for (const h of hops) {
  if (h.empty) { log(`  hop ${h.hop}: EMPTY (terminator) ${h.ms}ms`); continue; }
  const hot = h.hashHex === hotHashHex ? ' <== HOT' : '';
  log(`  hop ${h.hop}: ${h.hashHex.slice(0, 12)}… rowsAtKey=${h.rowsAtKey} ${h.ms}ms${hot}`);
}
const coldMs = hops.filter((h) => !h.empty && h.hashHex !== hotHashHex).map((h) => h.ms);
const hotHop = hops.find((h) => h.hashHex === hotHashHex);
const advanceHop = hops.find((h, i) => i > 0 && hops[i - 1]?.hashHex === hotHashHex); // hop that seeks PAST hot
const avg = (a) => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null;
const summary = {
  label: LABEL,
  hotRows: rowCount[hotHashHex],
  distinctEnumerated: distinct,
  hopsTotal: hops.length,
  hotHopMs: hotHop?.ms ?? null,
  advancePastHotMs: advanceHop?.ms ?? null,
  coldHopMsAvg: avg(coldMs),
  coldHopMsMin: coldMs.length ? Math.min(...coldMs) : null,
  coldHopMsMax: coldMs.length ? Math.max(...coldMs) : null,
};
log(`SUMMARY[${LABEL}]: distinct=${distinct} hotHop=${summary.hotHopMs}ms advancePastHot=${summary.advancePastHotMs}ms coldAvg=${summary.coldHopMsAvg}ms`);

state.expB = state.expB || {};
state.expB[LABEL] = { summary, hops };
saveState(state);
console.log(JSON.stringify(summary, null, 2));
await disconnectSdk();
