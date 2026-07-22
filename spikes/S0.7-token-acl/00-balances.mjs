// Print DASH balances + identity ids for the three actors.
import { getSdk, disconnectSdk, loadIdentity, log } from './lib.mjs';

const sdk = await getSdk();
for (const name of ['DEPLOYER', 'COLLAB', 'CONTRIB']) {
  const rec = loadIdentity(name);
  const bal = await sdk.identities.balance(rec.identityId);
  log(`${name.padEnd(9)} ${rec.identityId}  balance=${bal} credits (~${(Number(bal) / 1e11).toFixed(6)} DASH)`);
}
await disconnectSdk();
