// Experiment 4: CONTRIB (holds ZERO WRITE tokens) attempts the same tokenCost.create
// refUpdate. Should be REJECTED at consensus (insufficient token balance to pay the
// tokenCost). Capture the real error text.
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { getSdk, disconnectSdk, loadIdentity, fetchKeyAndSigner, log, errText, evoSdk, PUT_SETTINGS, STATE_FILE } from './lib.mjs';

const { Document } = evoSdk;
const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
const contrib = loadIdentity('CONTRIB');

const sdk = await getSdk();
const { publicKey, signer } = await fetchKeyAndSigner(sdk, contrib, 'HIGH');

const balBefore = (await sdk.tokens.balances([contrib.identityId], state.tokenId)).get(contrib.identityId);
log(`CONTRIB WRITE balance before create: ${balBefore} (expect 0/undefined)`);

const doc = new Document({
  properties: {
    refNameHash: new Uint8Array(randomBytes(32)),
    refName: 'refs/heads/contrib',
    newOid: new Uint8Array(randomBytes(20)),
  },
  documentTypeName: 'refUpdate',
  dataContractId: state.contractId,
  ownerId: contrib.identityId,
});
log(`built refUpdate doc id: ${doc.id.toString()}`);

let result;
log('CONTRIB creating refUpdate with tokenPaymentInfo {pos:0, maxCost:1}...');
try {
  await sdk.documents.create({
    document: doc,
    identityKey: publicKey,
    signer,
    tokenPaymentInfo: { tokenContractPosition: 0, maximumTokenCost: 1n },
    settings: PUT_SETTINGS,
  });
  log('!!! UNEXPECTED: CREATE ACCEPTED (should have been rejected)');
  result = { rejected: false, error: null };
} catch (e) {
  log(`CREATE REJECTED at consensus (expected). error:`);
  log(`  ${errText(e)}`);
  result = { rejected: true, error: errText(e) };
}

const balAfter = (await sdk.tokens.balances([contrib.identityId], state.tokenId)).get(contrib.identityId);
log(`CONTRIB WRITE balance after attempt: ${balAfter}`);
state.exp4 = { ...result, balBefore: String(balBefore), balAfter: String(balAfter) };
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
await disconnectSdk();
