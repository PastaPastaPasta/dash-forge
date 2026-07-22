// Isolate which call triggers the "time not implemented" wasm panic:
// broadcastStateTransition (broadcast-only) vs waitForResponse.
// Broadcast one chunk doc, then verify landing by QUERYING (read path).
import { readFileSync } from 'node:fs';
import { getSdk, disconnectSdk, loadIdentity, pickAuthKey, buildKeyAndSigner, buildChunkCreateSt, log, errStr, PUT_SETTINGS, randomBytes, evoSdk } from './lib.mjs';

const contract = JSON.parse(readFileSync(new URL('./contract.json', import.meta.url)));
const dataContractId = contract.contractId;
const rec = loadIdentity();
const ownerId = rec.identityId;
const key = pickAuthKey(rec, 'HIGH');

const sdk = await getSdk();
const { publicKey, priv } = buildKeyAndSigner(key);
const cn = await sdk.identities.contractNonce(ownerId, dataContractId);
log(`contractNonce=${cn}`);
const nonce = (cn ?? 0n) + 1n;
const packHash = randomBytes(32);
const { st, docId } = buildChunkCreateSt({ ownerId, dataContractId, packHash, seq: 0, nonce, priv, publicKey });
log(`built doc ${docId} nonce=${nonce}`);

log('calling broadcastStateTransition (broadcast-only)...');
try {
  await sdk.stateTransitions.broadcastStateTransition(st, PUT_SETTINGS);
  log('broadcastStateTransition returned OK');
} catch (e) {
  log(`broadcastStateTransition threw: ${errStr(e)}`);
}

// Poll via query (read path) to see if it landed.
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  try {
    const q = { dataContractId, documentTypeName: 'chunk', where: [['packHash', '==', Array.from(packHash)]], limit: 10 };
    const res = await sdk.documents.query(q);
    const count = res instanceof Map ? res.size : (res?.length ?? 0);
    log(`poll ${i}: query returned ${count} docs`);
    if (count > 0) { log('LANDED via broadcast-only!'); break; }
  } catch (e) {
    log(`poll ${i} query err: ${errStr(e)}`);
  }
}

const cnAfter = await sdk.identities.contractNonce(ownerId, dataContractId);
log(`contractNonce after: ${cnAfter}`);
await disconnectSdk();
