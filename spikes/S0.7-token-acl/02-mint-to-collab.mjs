// Experiment 2: DEPLOYER (contract owner = mint authority) mints WRITE tokens
// straight to COLLAB (the "grant"). Confirm COLLAB's token balance.
import { readFileSync } from 'node:fs';
import { getSdk, disconnectSdk, loadIdentity, fetchKeyAndSigner, log, errText, PUT_SETTINGS, STATE_FILE } from './lib.mjs';

const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
const AMOUNT = 5n; // grant enough for a couple of create ops + a delete

const deployer = loadIdentity('DEPLOYER');
const collab = loadIdentity('COLLAB');

const sdk = await getSdk();
const { publicKey, signer } = await fetchKeyAndSigner(sdk, deployer, 'CRITICAL');

log(`minting ${AMOUNT} WRITE from DEPLOYER -> COLLAB (${collab.identityId})`);
try {
  const res = await sdk.tokens.mint({
    dataContractId: state.contractId,
    tokenPosition: 0,
    amount: AMOUNT,
    identityId: deployer.identityId,   // minter (owner)
    recipientId: collab.identityId,    // grant destination
    identityKey: publicKey,
    signer,
    publicNote: 'S0.7 grant to COLLAB',
    settings: PUT_SETTINGS,
  });
  log(`mint broadcast OK: ${JSON.stringify(res, (k, v) => typeof v === 'bigint' ? v.toString() : v)}`);
} catch (e) {
  log(`MINT ERROR: ${errText(e)}`);
  await disconnectSdk();
  throw e;
}

const balMap = await sdk.tokens.balances([collab.identityId, deployer.identityId], state.tokenId);
log(`COLLAB   WRITE balance: ${balMap.get(collab.identityId)}`);
log(`DEPLOYER WRITE balance: ${balMap.get(deployer.identityId)}`);
const supply = await sdk.tokens.totalSupply(state.tokenId);
log(`total supply now: ${JSON.stringify(supply, (k, v) => typeof v === 'bigint' ? v.toString() : v)}`);
await disconnectSdk();
