import { getSdk, disconnectSdk, loadIdentity, log } from './lib.mjs';

const rec = loadIdentity();
const sdk = await getSdk();
const bal = Number(await sdk.identities.balance(rec.identityId));
log(`Balance: ${bal} credits (${(bal / 1e11).toFixed(6)} tDASH)`);
log(`Identity nonce: ${await sdk.identities.nonce(rec.identityId)}`);

for (const id of process.argv.slice(2)) {
  try {
    const c = await sdk.contracts.fetch(id);
    log(`Contract ${id}: ${c ? 'EXISTS' : 'NOT FOUND'}`);
    if (c) {
      const cn = await sdk.identities.contractNonce(rec.identityId, id);
      log(`  identity-contract nonce for owner: ${cn}`);
    }
  } catch (e) {
    log(`Contract ${id}: fetch error ${e?.message ?? e}`);
  }
}
await disconnectSdk();
