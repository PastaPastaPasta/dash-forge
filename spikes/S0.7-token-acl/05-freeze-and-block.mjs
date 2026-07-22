// Experiment 5 (KEY FINDING): DEPLOYER freezes COLLAB's WRITE balance, then COLLAB
// attempts (a) a new tokenCost.create refUpdate and (b) a tokenCost.delete of its
// earlier doc. BOTH must be REJECTED at consensus — a frozen identity can neither
// spend to create NOR spend to delete. This is the availability-protection finding.
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { getSdk, disconnectSdk, loadIdentity, fetchKeyAndSigner, tokenOp, log, errText, evoSdk, PUT_SETTINGS, STATE_FILE } from './lib.mjs';

const { Document } = evoSdk;
const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
const deployer = loadIdentity('DEPLOYER');
const collab = loadIdentity('COLLAB');
const exp5 = {};

const sdk = await getSdk();

// --- (0) FREEZE COLLAB (DEPLOYER = freeze authority = ContractOwner) ---
{
  const { publicKey, signer } = await fetchKeyAndSigner(sdk, deployer, 'CRITICAL');
  const r = await tokenOp('FREEZE COLLAB', () => sdk.tokens.freeze({
    dataContractId: state.contractId,
    tokenPosition: 0,
    authorityId: deployer.identityId,
    frozenIdentityId: collab.identityId,
    identityKey: publicKey,
    signer,
    publicNote: 'S0.7 suspend COLLAB',
    settings: PUT_SETTINGS,
  }));
  exp5.freeze = { landed: r.landed, parseBug: r.parseBug };
}

// verify frozen status via query
const infoMap = await sdk.tokens.identityTokenInfos(collab.identityId, [state.tokenId]);
const info = infoMap.get(state.tokenId);
const isFrozen = info?.isFrozen;
log(`COLLAB token info isFrozen = ${isFrozen}`);
const balFrozen = (await sdk.tokens.balances([collab.identityId], state.tokenId)).get(collab.identityId);
log(`COLLAB WRITE balance while frozen = ${balFrozen} (funds still present, just frozen)`);
exp5.frozenConfirmed = isFrozen === true;
exp5.balanceWhileFrozen = String(balFrozen);

// --- (a) COLLAB attempts a NEW create while frozen ---
{
  const { publicKey, signer } = await fetchKeyAndSigner(sdk, collab, 'HIGH');
  const doc = new Document({
    properties: { refNameHash: new Uint8Array(randomBytes(32)), refName: 'refs/heads/frozen-create', newOid: new Uint8Array(randomBytes(20)) },
    documentTypeName: 'refUpdate', dataContractId: state.contractId, ownerId: collab.identityId,
  });
  log('(a) COLLAB (frozen) attempts refUpdate CREATE...');
  try {
    await sdk.documents.create({ document: doc, identityKey: publicKey, signer, tokenPaymentInfo: { tokenContractPosition: 0, maximumTokenCost: 1n }, settings: PUT_SETTINGS });
    log('(a) !!! UNEXPECTED: create ACCEPTED while frozen');
    exp5.frozenCreate = { rejected: false, error: null };
  } catch (e) {
    log(`(a) CREATE REJECTED (expected). error:`);
    log(`    ${errText(e)}`);
    exp5.frozenCreate = { rejected: true, error: errText(e) };
  }
}

// --- (b) COLLAB attempts to DELETE its earlier (exp3) doc while frozen ---
{
  const { publicKey, signer } = await fetchKeyAndSigner(sdk, collab, 'HIGH');
  log(`(b) COLLAB (frozen) attempts DELETE of earlier doc ${state.collabDocId}...`);
  try {
    await sdk.documents.delete({
      document: { id: state.collabDocId, ownerId: collab.identityId, dataContractId: state.contractId, documentTypeName: 'refUpdate' },
      identityKey: publicKey,
      signer,
      tokenPaymentInfo: { tokenContractPosition: 0, maximumTokenCost: 1n },
      settings: PUT_SETTINGS,
    });
    log('(b) !!! UNEXPECTED: delete ACCEPTED while frozen');
    exp5.frozenDelete = { rejected: false, error: null };
  } catch (e) {
    log(`(b) DELETE REJECTED (expected). error:`);
    log(`    ${errText(e)}`);
    exp5.frozenDelete = { rejected: true, error: errText(e) };
  }
}

state.exp5 = exp5;
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
log(`\nSUMMARY: frozen=${exp5.frozenConfirmed}  create-blocked=${exp5.frozenCreate.rejected}  delete-blocked=${exp5.frozenDelete.rejected}`);
await disconnectSdk();
