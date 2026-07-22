// Experiment 7: query the TokenHistory system contract to confirm past holdings are
// reconstructable with consensus timestamps (needed for as-of-time event-fold auth).
// TokenHistory system contract id: 43gujrzZgXqcKBiScLa4T8XTDnRhenR9BLx8GWVHjPxF
//   mint.byDate               = [tokenId, $createdAt]
//   freeze.byFrozenIdentityId = [tokenId, frozenIdentityId, $createdAt]
//   destroyFrozenFunds.byFrozenIdentityId = [tokenId, frozenIdentityId, $createdAt]
import { readFileSync, writeFileSync } from 'node:fs';
import { getSdk, disconnectSdk, loadIdentity, log, errText, STATE_FILE } from './lib.mjs';

const TOKEN_HISTORY_ID = '43gujrzZgXqcKBiScLa4T8XTDnRhenR9BLx8GWVHjPxF';
const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
const collab = loadIdentity('COLLAB');
const sdk = await getSdk();
const pv = sdk.version();

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s) {
  let n = 0n; for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad b58'); n = n * 58n + BigInt(i); }
  const bytes = []; while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c === '1') bytes.unshift(0); else break; }
  return new Uint8Array(bytes);
}
const enc = (b58) => [
  { tag: 'base58', v: b58 },
  { tag: 'uint8array', v: b58decode(b58) },
  { tag: 'array', v: Array.from(b58decode(b58)) },
];

// Run a query trying multiple byteArray value encodings until one is accepted.
async function runQuery(label, docType, buildWhere, orderBy) {
  for (const e of enc(state.tokenId)) {
    const q = { dataContractId: TOKEN_HISTORY_ID, documentTypeName: docType, where: buildWhere(e.tag), limit: 50, orderBy };
    try {
      const res = await sdk.documents.query(q);
      log(`${label}: OK (tokenId as ${e.tag}) -> ${res.size} row(s)`);
      const rows = [];
      for (const [id, doc] of res) {
        if (!doc) continue;
        const p = doc.toJSON(pv);
        rows.push({ id, createdAt: String(doc.createdAt), createdAtBlockHeight: String(doc.createdAtBlockHeight), props: p });
      }
      return { queried: true, enc: e.tag, count: res.size, rows };
    } catch (err) {
      log(`${label}: tokenId-as-${e.tag} rejected: ${errText(err).slice(0, 140)}`);
    }
  }
  return { queried: false, count: 0, rows: [] };
}

// COLLAB identity value must match tokenId encoding on the compound queries; try same set.
function collabVal(tag) {
  if (tag === 'base58') return collab.identityId;
  if (tag === 'uint8array') return b58decode(collab.identityId);
  return Array.from(b58decode(collab.identityId));
}

const out = {};
out.mint = await runQuery('mint', 'mint',
  (tag) => [['tokenId', '==', enc(state.tokenId).find(e => e.tag === tag).v]],
  [['$createdAt', 'asc']]);
out.freeze = await runQuery('freeze', 'freeze',
  (tag) => [['tokenId', '==', enc(state.tokenId).find(e => e.tag === tag).v], ['frozenIdentityId', '==', collabVal(tag)]],
  [['$createdAt', 'asc']]);
out.destroyFrozenFunds = await runQuery('destroyFrozenFunds', 'destroyFrozenFunds',
  (tag) => [['tokenId', '==', enc(state.tokenId).find(e => e.tag === tag).v], ['frozenIdentityId', '==', collabVal(tag)]],
  [['$createdAt', 'asc']]);

log('\n=== TOKEN HISTORY RECONSTRUCTION (createdAt = consensus block time ms) ===');
for (const k of ['mint', 'freeze', 'destroyFrozenFunds']) {
  log(`${k}: ${out[k].count} row(s)`);
  for (const r of out[k].rows) log(`   createdAt=${r.createdAt} blockHeight=${r.createdAtBlockHeight} amount=${r.props.amount ?? r.props.destroyedAmount ?? '-'} recipient=${r.props.recipientId ?? r.props.frozenIdentityId ?? '-'}`);
}
state.exp7 = out;
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
await disconnectSdk();
