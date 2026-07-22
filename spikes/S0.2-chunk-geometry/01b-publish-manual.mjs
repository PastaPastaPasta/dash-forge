// Publish the throwaway contract via a MANUALLY built + signed state transition,
// broadcast through stateTransitions.broadcastAndWait. This bypasses the evo-sdk
// contractPublish() client-side fee pre-check, letting the network report the
// real consensus fee/requirement. Also prints the signed ST byte size.
import { writeFileSync } from 'node:fs';
import { getSdk, disconnectSdk, loadIdentity, pickAuthKey, buildKeyAndSigner, log, evoSdk, PUT_SETTINGS } from './lib.mjs';

const { DataContract, DataContractCreateTransition, PrivateKey } = evoSdk;

const schemas = {
  blob: {
    type: 'object',
    properties: {
      seq: { type: 'integer', position: 0 },
      d0: { type: 'array', byteArray: true, maxItems: 5120, position: 1 },
      d1: { type: 'array', byteArray: true, maxItems: 5120, position: 2 },
      d2: { type: 'array', byteArray: true, maxItems: 5120, position: 3 },
    },
    required: ['seq'],
    additionalProperties: false,
  },
  wide: {
    type: 'object',
    properties: {
      seq: { type: 'integer', position: 0 },
      d: { type: 'array', byteArray: true, maxItems: 5300, position: 1 },
    },
    required: ['seq'],
    additionalProperties: false,
  },
};

const rec = loadIdentity();
const ownerId = rec.identityId;
const critKey = pickAuthKey(rec, 'CRITICAL');

const sdk = await getSdk();
const w = await sdk.getWasmSdkConnected();
const pv = sdk.version();
log(`platform/protocol version: ${pv}`);

const nextNonce = ((await sdk.identities.nonce(ownerId)) ?? 0n) + 1n;
log(`using identity nonce ${nextNonce}`);

const contract = new DataContract({ ownerId, identityNonce: nextNonce, schemas, fullValidation: true, platformVersion: pv });
const provisionalId = contract.id.toString();
log(`provisional contract id: ${provisionalId}`);

const tr = new DataContractCreateTransition(contract, nextNonce, pv);
const st = tr.toStateTransition();

const { publicKey } = buildKeyAndSigner(critKey);
const priv = PrivateKey.fromWIF(critKey.privateKeyWif);
st.sign(priv, publicKey);
const stBytes = st.toBytes();
log(`signed contract-create ST size: ${stBytes.length} bytes`);

const balBefore = Number(await sdk.identities.balance(ownerId));
log(`balance before: ${balBefore}`);

log('broadcasting...');
try {
  const result = await sdk.stateTransitions.broadcastAndWait(st, PUT_SETTINGS);
  log(`broadcast OK`);
  const balAfter = Number(await sdk.identities.balance(ownerId));
  const cost = balBefore - balAfter;
  log(`balance after: ${balAfter}. actual cost: ${cost} credits (~${(cost / 1e11).toFixed(6)} DASH)`);
  const out = { contractId: provisionalId, ownerId, registrationCostCredits: cost, balBefore, balAfter, contractCreateStBytes: stBytes.length, signingKeyId: critKey.id };
  writeFileSync(new URL('./contract.json', import.meta.url), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  log(`BROADCAST ERROR: name=${e?.name} message=${e?.message}`);
  throw e;
} finally {
  await disconnectSdk();
}
