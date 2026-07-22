// Register the throwaway refUpdate contract from DEPLOYER and plan the ref-name set.
// Contract has doc type refUpdate with indices (refNameHash asc, $createdAt asc) and
// ($createdAt asc). No token gating -> DEPLOYER (owner) creates all docs, delete-free.
//
// Ref-name plan: 10 distinct names; HOT = the one whose sha256 sorts SMALLEST, so under
// orderBy refNameHash asc the hot key is visited FIRST (maximal-starvation case). Cold
// keys get 1-3 rows each; hot key gets up to 150 rows (populated in two phases).
import { getSdk, disconnectSdk, loadIdentity, pickAuthKey, buildKeyAndSigner, log, evoSdk, errStr, PUT_SETTINGS, PV, REF_SCHEMAS, refHash, saveState, loadState } from './lib.mjs';

const { DataContract, DataContractCreateTransition } = evoSdk;

const rec = loadIdentity('DEPLOYER');
const ownerId = rec.identityId;

// 10 distinct ref names. Cold keys get a deterministic small row count (1..3).
// HOT is chosen below as whichever name's sha256 sorts smallest (so it sits FIRST
// under orderBy refNameHash asc — the worst case for `in`-batch starvation).
const NAMES = [
  'refs/heads/main',
  'refs/heads/develop',
  'refs/heads/release/v1',
  'refs/heads/feature/auth',
  'refs/heads/feature/api',
  'refs/tags/v1.0.0',
  'refs/tags/v1.1.0',
  'refs/heads/hotfix/x',
  'refs/heads/staging',
  'refs/heads/experimental',
];

const refs = NAMES.map((name) => ({ name, hashHex: refHash(name).toString('hex') }));
// Sort by hash ascending to see index order.
const sorted = [...refs].sort((a, b) => (a.hashHex < b.hashHex ? -1 : 1));
// HOT = smallest hash → first in asc order → will consume the budget first.
const hotHashHex = sorted[0].hashHex;
const hotName = sorted[0].name;

// Cold row counts: 1..3 cycling.
const plan = sorted.map((r, i) => ({
  name: r.name,
  hashHex: r.hashHex,
  hot: r.hashHex === hotHashHex,
  coldRows: r.hashHex === hotHashHex ? 0 : (1 + (i % 3)), // 1,2,3,1,2,3...
}));

log(`ref plan (sorted by hash asc):`);
for (const p of plan) log(`  ${p.hashHex.slice(0, 12)}… ${p.hot ? 'HOT ' : 'cold'} rows=${p.hot ? 'up to 150' : p.coldRows} ${p.name}`);

const sdk = await getSdk();
const pv = sdk.version?.() ?? PV;
log(`platform/protocol version: ${pv}`);

const curNonce = (await sdk.identities.nonce(ownerId)) ?? 0n;
const nextNonce = curNonce + 1n;
log(`DEPLOYER identity nonce ${curNonce} -> ${nextNonce}`);

let contract, contractId;
try {
  contract = new DataContract({ ownerId, identityNonce: nextNonce, schemas: REF_SCHEMAS, fullValidation: true, platformVersion: pv });
  contractId = contract.id.toString();
} catch (e) {
  log(`CONTRACT BUILD FAILED: ${errStr(e)}`);
  await disconnectSdk();
  throw e;
}
log(`built + validated contract locally. provisional id: ${contractId}`);

if (process.env.DRYRUN) {
  log('DRYRUN: skipping broadcast.');
  console.log(JSON.stringify({ contractId, ownerId, hotName, plan }, null, 2));
  await disconnectSdk();
  process.exit(0);
}

const critKey = pickAuthKey(rec, 'CRITICAL');
const { publicKey, priv } = buildKeyAndSigner(critKey);

const balBefore = Number(await sdk.identities.balance(ownerId));
log(`DEPLOYER balance before: ${balBefore} (${(balBefore / 1e11).toFixed(6)} tDASH)`);

const tr = new DataContractCreateTransition(contract, nextNonce, pv);
const st = tr.toStateTransition();
st.sign(priv, publicKey);
log(`signed DataContractCreate ST size: ${st.toBytes().length} bytes. broadcasting (broadcast-only + poll; broadcastAndWait panics 'time not implemented' under Node/wasm)...`);
await sdk.stateTransitions.broadcastStateTransition(st, { connectTimeoutMs: 15000, timeoutMs: 30000, retries: 2 });
// Poll until the contract is confirmed on-chain.
let confirmed = false;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  try {
    const c = await sdk.contracts.fetch(contractId);
    if (c) { confirmed = true; break; }
  } catch { /* not yet */ }
}
if (!confirmed) { log('WARNING: contract not confirmed on-chain after polling'); }
log(`published contract id: ${contractId} (confirmed=${confirmed})`);

const balAfter = Number(await sdk.identities.balance(ownerId));
log(`registration cost: ${balBefore - balAfter} credits (~${((balBefore - balAfter) / 1e11).toFixed(6)} tDASH)`);

const state = loadState();
state.contractId = contractId;
state.ownerId = ownerId;
state.hotName = hotName;
state.hotHashHex = hotHashHex;
state.plan = plan;
state.signingKeyId = critKey.id;
state.registrationCostCredits = balBefore - balAfter;
state.docs = state.docs || []; // [{docId, hashHex, nonce}]
saveState(state);
log('wrote state.json');
console.log(JSON.stringify({ contractId, hotName, hotHashHex, registrationCostCredits: balBefore - balAfter }, null, 2));
await disconnectSdk();
