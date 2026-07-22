// Delete all recorded refUpdate docs to reclaim storage; confirm refund via balance.
// Also sweeps any on-chain docs not in state (via reflog index walk) so nothing is left.
import { getSdk, disconnectSdk, loadIdentity, pickAuthKey, buildKeyAndSigner, buildRefDeleteSt, contractNonce, pollNonce, log, errStr, BROADCAST_SETTINGS, loadState, saveState, sleep } from './lib.mjs';
import { queryDocs } from './qlib.mjs';

const WINDOW = Number(process.env.WINDOW ?? 12);
const state = loadState();
if (!state.contractId) throw new Error('no state');
const { contractId, ownerId } = state;

const rec = loadIdentity('DEPLOYER');
const sdk = await getSdk(); // connect (init wasm) BEFORE constructing IdentityPublicKey
const { publicKey, priv } = buildKeyAndSigner(pickAuthKey(rec, 'HIGH'));

const ids = new Set((state.docs || []).map((d) => d.docId));
// sweep on-chain via reflog ($createdAt) index, paging by startAfter
try {
  let startAfter;
  for (let page = 0; page < 20; page++) {
    const res = await sdk.documents.query({ dataContractId: contractId, documentTypeName: 'refUpdate', orderBy: [['$createdAt', 'asc']], limit: 100, startAfter });
    const docs = res instanceof Map ? [...res.values()].filter(Boolean) : (res ?? []);
    if (docs.length === 0) break;
    for (const d of docs) ids.add(d.id.toString());
    startAfter = docs[docs.length - 1].id.toString();
    if (docs.length < 100) break;
  }
} catch (e) { log(`sweep err: ${errStr(e)}`); }

const idList = [...ids];
log(`deleting ${idList.length} docs (window=${WINDOW})`);
if (idList.length === 0) { await disconnectSdk(); process.exit(0); }

const balBefore = Number(await sdk.identities.balance(ownerId));
log(`balance before ${balBefore}`);

// Chunk to respect the ~24 identity-contract-nonce look-ahead cap.
const CHUNK = Number(process.env.CHUNK ?? 18);
let okCount = 0;
const deletedIds = new Set();
for (let off = 0; off < idList.length; off += CHUNK) {
  const slice = idList.slice(off, off + CHUNK);
  const base = await contractNonce(sdk, ownerId, contractId);
  const tasks = slice.map((docId, i) => ({
    docId, nonce: base + 1n + BigInt(i),
    ...buildRefDeleteSt({ ownerId, dataContractId: contractId, docId, nonce: base + 1n + BigInt(i), priv, publicKey }),
    ok: null, err: null,
  }));
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const task = tasks[next++];
      try { await sdk.stateTransitions.broadcastStateTransition(task.st, BROADCAST_SETTINGS); task.ok = true; }
      catch (e) { task.ok = false; task.err = errStr(e); }
    }
  }
  await Promise.all(Array.from({ length: WINDOW }, () => worker()));
  const ok = tasks.filter((t) => t.ok).length;
  const cn = await pollNonce(sdk, ownerId, contractId, base + BigInt(ok), 240000);
  await sleep(1500);
  for (const t of tasks) if (t.ok && t.nonce <= cn) { deletedIds.add(t.docId); okCount++; }
  log(`  chunk [${off}..${off + slice.length}) deleted ${ok}/${slice.length}; total ${okCount}`);
}
await sleep(2000);
const balAfter = Number(await sdk.identities.balance(ownerId));
const refund = balAfter - balBefore;
log(`deletes done. balance ${balBefore} -> ${balAfter}. REFUND=${refund} credits (${(refund / 1e11).toFixed(6)} tDASH)`);

state.docs = (state.docs || []).filter((d) => !deletedIds.has(d.docId));
state.deleteRefundCredits = (state.deleteRefundCredits || 0) + refund;
saveState(state);
console.log(JSON.stringify({ deleted: okCount, refund, balBefore, balAfter, remaining: state.docs.length }, null, 2));
await disconnectSdk();
