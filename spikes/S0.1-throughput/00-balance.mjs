import { getSdk, disconnectSdk, loadIdentity, log } from './lib.mjs';

const rec = loadIdentity();
const sdk = await getSdk();
const bal = Number(await sdk.identities.balance(rec.identityId));
log(`Identity ${rec.identityId}`);
log(`Balance: ${bal} credits = ${(bal / 1e11).toFixed(6)} tDASH`);
const idNonce = await sdk.identities.nonce(rec.identityId);
log(`Identity nonce: ${idNonce}`);
await disconnectSdk();
