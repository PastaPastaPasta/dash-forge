// Experiment A — `in`-batch starvation. Run after the hot key is fully populated.
// Runs an `in` query over all ~10 refNameHash values, orderBy (refNameHash, $createdAt)
// with limit 100, in both sort directions. Buckets the returned rows per key and reports
// which keys returned ZERO rows (starved). Then runs the §3 completeness-fallback
// (per-starved-key equality limit-1) and confirms it recovers every tip.
import { getSdk, disconnectSdk, log, loadState, saveState } from './lib.mjs';
import { queryDocs, resolveForm, hashOperand, docHashHex } from './qlib.mjs';

const state = loadState();
if (!state.contractId) throw new Error('run 01/02 first');
const { contractId, hotHashHex, plan } = state;

const rowCount = {};
for (const d of state.docs) rowCount[d.hashHex] = (rowCount[d.hashHex] || 0) + 1;
const allHashes = plan.map((p) => p.hashHex);

const sdk = await getSdk();
const form = await resolveForm(sdk, contractId, hotHashHex);

async function inBatch(direction, limit) {
  const operands = allHashes.map((h) => hashOperand(h, form));
  const t0 = Date.now();
  const docs = await queryDocs(sdk, {
    dataContractId: contractId,
    documentTypeName: 'refUpdate',
    where: [['refNameHash', 'in', operands]],
    orderBy: [['refNameHash', direction], ['$createdAt', direction]],
    limit,
  });
  const ms = Date.now() - t0;
  const perKey = {};
  for (const h of allHashes) perKey[h] = 0;
  for (const d of docs) { const hex = docHashHex(d); if (hex in perKey) perKey[hex]++; }
  const starved = allHashes.filter((h) => perKey[h] === 0);
  return { direction, limit, returned: docs.length, ms, perKey, starved };
}

// §3 completeness fallback: for each starved key, equality limit-1 to fetch its tip.
async function fallback(starved, direction) {
  const recovered = [];
  let totalMs = 0;
  for (const h of starved) {
    const t0 = Date.now();
    const docs = await queryDocs(sdk, {
      dataContractId: contractId,
      documentTypeName: 'refUpdate',
      where: [['refNameHash', '==', hashOperand(h, form)]],
      orderBy: [['refNameHash', direction], ['$createdAt', direction]],
      limit: 1,
    });
    totalMs += Date.now() - t0;
    if (docs.length > 0) recovered.push(h);
  }
  return { recoveredCount: recovered.length, requested: starved.length, totalMs };
}

const results = {};
for (const dir of ['asc', 'desc']) {
  const r = await inBatch(dir, 100);
  const starvedRows = r.starved.map((h) => `${h.slice(0, 8)}…(rows=${rowCount[h] ?? 0})`);
  log(`--- in-batch orderBy ${dir}, limit 100 ---`);
  log(`  returned ${r.returned} rows in ${r.ms}ms; hot key got ${r.perKey[hotHashHex]} rows`);
  log(`  perKey: ${allHashes.map((h) => (h === hotHashHex ? 'HOT' : h.slice(0, 6)) + '=' + r.perKey[h]).join(' ')}`);
  log(`  STARVED (0 rows): ${r.starved.length}/${allHashes.length} -> ${starvedRows.join(' ') || 'none'}`);
  let fb = null;
  if (r.starved.length) {
    fb = await fallback(r.starved, dir);
    log(`  completeness-fallback: recovered ${fb.recoveredCount}/${fb.requested} starved tips in ${fb.totalMs}ms (${Math.round(fb.totalMs / Math.max(1, fb.requested))}ms/key)`);
  }
  results[dir] = { ...r, fallback: fb };
}

state.expA = results;
saveState(state);
console.log(JSON.stringify({
  asc: { returned: results.asc.returned, starved: results.asc.starved.length, hotRows: results.asc.perKey[hotHashHex], fallbackRecovered: results.asc.fallback?.recoveredCount ?? 0 },
  desc: { returned: results.desc.returned, starved: results.desc.starved.length, hotRows: results.desc.perKey[hotHashHex], fallbackRecovered: results.desc.fallback?.recoveredCount ?? 0 },
}, null, 2));
await disconnectSdk();
