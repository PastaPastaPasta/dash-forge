// Experiment 6: DEPLOYER destroys COLLAB's FROZEN WRITE funds (the "revoke").
// Confirm COLLAB's balance is zeroed and total supply drops accordingly.
import { readFileSync, writeFileSync } from 'node:fs';
import { getSdk, disconnectSdk, loadIdentity, fetchKeyAndSigner, tokenOp, log, PUT_SETTINGS, STATE_FILE } from './lib.mjs';

const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
const deployer = loadIdentity('DEPLOYER');
const collab = loadIdentity('COLLAB');

const sdk = await getSdk();

const balBefore = (await sdk.tokens.balances([collab.identityId], state.tokenId)).get(collab.identityId);
const supplyBefore = await sdk.tokens.totalSupply(state.tokenId);
log(`COLLAB frozen WRITE balance before destroy: ${balBefore}`);
log(`total supply before destroy: ${JSON.stringify(supplyBefore, (k, v) => typeof v === 'bigint' ? v.toString() : v)}`);

const { publicKey, signer } = await fetchKeyAndSigner(sdk, deployer, 'CRITICAL');
const r = await tokenOp('DESTROY COLLAB FROZEN FUNDS', () => sdk.tokens.destroyFrozen({
  dataContractId: state.contractId,
  tokenPosition: 0,
  authorityId: deployer.identityId,
  frozenIdentityId: collab.identityId,
  identityKey: publicKey,
  signer,
  publicNote: 'S0.7 revoke COLLAB',
  settings: PUT_SETTINGS,
}));

const balAfter = (await sdk.tokens.balances([collab.identityId], state.tokenId)).get(collab.identityId);
const supplyAfter = await sdk.tokens.totalSupply(state.tokenId);
log(`COLLAB WRITE balance after destroy: ${balAfter} (expect 0)`);
log(`total supply after destroy: ${JSON.stringify(supplyAfter, (k, v) => typeof v === 'bigint' ? v.toString() : v)}`);

state.exp6 = {
  landed: r.landed, parseBug: r.parseBug,
  balBefore: String(balBefore), balAfter: String(balAfter ?? 0),
  zeroed: (balAfter ?? 0n) === 0n || balAfter === undefined,
};
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
await disconnectSdk();
