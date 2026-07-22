// Experiment 3: COLLAB (holds WRITE tokens) creates a tokenCost.create refUpdate
// document. Should SUCCEED at consensus and DECREMENT COLLAB's WRITE balance by 1.
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { getSdk, disconnectSdk, loadIdentity, fetchKeyAndSigner, log, errText, evoSdk, PUT_SETTINGS, STATE_FILE } from './lib.mjs';

const { Document } = evoSdk;
const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
const collab = loadIdentity('COLLAB');

const sdk = await getSdk();
const pv = sdk.version();
const { publicKey, signer } = await fetchKeyAndSigner(sdk, collab, 'HIGH');

const balBefore = (await sdk.tokens.balances([collab.identityId], state.tokenId)).get(collab.identityId);
log(`COLLAB WRITE balance before create: ${balBefore}`);

const props = {
  refNameHash: new Uint8Array(randomBytes(32)),
  refName: 'refs/heads/main',
  newOid: new Uint8Array(randomBytes(20)),
};
const doc = new Document({
  properties: props,
  documentTypeName: 'refUpdate',
  dataContractId: state.contractId,
  ownerId: collab.identityId,
});
const docId = doc.id.toString();
log(`built refUpdate doc id: ${docId}`);

log('creating refUpdate with tokenPaymentInfo {pos:0, maxCost:1}...');
try {
  await sdk.documents.create({
    document: doc,
    identityKey: publicKey,
    signer,
    tokenPaymentInfo: { tokenContractPosition: 0, maximumTokenCost: 1n },
    settings: PUT_SETTINGS,
  });
  log('CREATE broadcast OK — ACCEPTED at consensus');
} catch (e) {
  log(`CREATE ERROR: ${errText(e)}`);
  await disconnectSdk();
  throw e;
}

const balAfter = (await sdk.tokens.balances([collab.identityId], state.tokenId)).get(collab.identityId);
log(`COLLAB WRITE balance after create: ${balAfter} (expect ${balBefore - 1n})`);

state.collabDocId = docId;
state.collabDocProps = { refName: props.refName };
state.exp3 = { balBefore: String(balBefore), balAfter: String(balAfter), spent: String(balBefore - balAfter), accepted: true };
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
log(`saved collab doc id to state.json`);
await disconnectSdk();
