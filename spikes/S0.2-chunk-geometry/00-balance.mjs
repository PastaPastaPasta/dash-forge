import { getSdk, disconnectSdk, loadIdentity, log } from './lib.mjs';

const rec = loadIdentity();
log(`Identity: ${rec.identityId}`);
const sdk = await getSdk();
const bal = await sdk.identities.balance(rec.identityId);
log(`Balance: ${bal} credits (~${(Number(bal) / 1e11).toFixed(6)} DASH)`);
await disconnectSdk();
console.log(JSON.stringify({ identityId: rec.identityId, balanceCredits: Number(bal) }, null, 2));
