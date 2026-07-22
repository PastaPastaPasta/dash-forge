// Publish the throwaway single-type `chunk` contract on testnet. Records id + cost.
import { writeFileSync } from 'node:fs';
import { getSdk, disconnectSdk, loadIdentity, pickAuthKey, buildKeyAndSigner, log, evoSdk, PUT_SETTINGS, CHUNK_SCHEMAS, PV } from './lib.mjs';

// Manual DataContractCreateTransition + broadcastAndWait: the high-level
// contracts.publish() facade panics ("time not implemented on this platform")
// inside its client-side nonce-staleness pre-check under Node/wasm. The manual
// path bypasses that check and lets the network report the real consensus result.
const { DataContract, DataContractCreateTransition, PrivateKey } = evoSdk;
const rec = loadIdentity();
const ownerId = rec.identityId;
const critKey = pickAuthKey(rec, 'CRITICAL');

const sdk = await getSdk();
const curNonce = await sdk.identities.nonce(ownerId);
const nextNonce = (curNonce ?? 0n) + 1n;
log(`Owner ${ownerId}, identity nonce ${curNonce} -> ${nextNonce}`);

const contract = new DataContract({ ownerId, identityNonce: nextNonce, schemas: CHUNK_SCHEMAS, fullValidation: true, platformVersion: PV });
const contractId = contract.id.toString();
log(`Local DataContract validated. Provisional id: ${contractId}`);

const balBefore = Number(await sdk.identities.balance(ownerId));
log(`Balance before publish: ${balBefore} credits (${(balBefore / 1e11).toFixed(6)} tDASH)`);

const { publicKey } = buildKeyAndSigner(critKey);
const priv = PrivateKey.fromWIF(critKey.privateKeyWif);
const tr = new DataContractCreateTransition(contract, nextNonce, PV);
const st = tr.toStateTransition();
st.sign(priv, publicKey);
log(`Signed contract-create ST size: ${st.toBytes().length} bytes. Broadcasting...`);
await sdk.stateTransitions.broadcastAndWait(st, PUT_SETTINGS);
log(`Published contract id: ${contractId}`);

const balAfter = Number(await sdk.identities.balance(ownerId));
const cost = balBefore - balAfter;
log(`Balance after: ${balAfter} credits. Registration cost: ${cost} credits (~${(cost / 1e11).toFixed(6)} tDASH)`);

const out = { contractId, ownerId, registrationCostCredits: cost, balBefore, balAfter, signingKeyId: critKey.id, signingKeyLevel: critKey.securityLevel };
writeFileSync(new URL('./contract.json', import.meta.url), JSON.stringify(out, null, 2));
await disconnectSdk();
console.log(JSON.stringify(out, null, 2));
