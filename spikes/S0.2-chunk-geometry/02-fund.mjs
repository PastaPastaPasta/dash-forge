// Fund CONTRIB from TREASURY via credit transfer (faucet is rate-limited).
// Usage: node 02-fund.mjs <amountDASH>
import { readFileSync } from 'node:fs';
import { getSdk, disconnectSdk, log, evoSdk, PUT_SETTINGS } from './lib.mjs';

const amtDash = Number(process.argv[2] ?? 0.4);
const amount = BigInt(Math.round(amtDash * 1e11));
const dir = '/Users/pasta/.config/dash-forge/test-identities';
const treasury = JSON.parse(readFileSync(`${dir}/TREASURY.identity.json`, 'utf8'));
const contrib = JSON.parse(readFileSync(`${dir}/CONTRIB.identity.json`, 'utf8'));

const { IdentityPublicKey, IdentitySigner } = evoSdk;
const xferKey = treasury.identityKeys.find((k) => k.purpose === 'TRANSFER');
if (!xferKey) throw new Error('no TRANSFER key in TREASURY');

const sdk = await getSdk();
const senderIdentity = await sdk.identities.fetch(treasury.identityId);
if (!senderIdentity) throw new Error('sender identity not found on platform');

const signingKey = new IdentityPublicKey({
  keyId: xferKey.id,
  purpose: xferKey.purpose.toLowerCase(),
  securityLevel: xferKey.securityLevel.toLowerCase(),
  keyType: xferKey.keyType.toLowerCase(),
  isReadOnly: false,
  data: Buffer.from(xferKey.publicKeyHex, 'hex'),
});
const signer = new IdentitySigner();
signer.addKeyFromWif(xferKey.privateKeyWif);

const before = Number(await sdk.identities.balance(contrib.identityId));
log(`Transferring ${amtDash} DASH (${amount} credits) TREASURY -> CONTRIB...`);
const res = await sdk.identities.creditTransfer({ identity: senderIdentity, recipientId: contrib.identityId, amount, signer, signingKey, settings: PUT_SETTINGS });
log(`creditTransfer result: ${JSON.stringify(res, (k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
const after = Number(await sdk.identities.balance(contrib.identityId));
log(`CONTRIB balance ${before} -> ${after} credits (~${(after / 1e11).toFixed(6)} DASH)`);
await disconnectSdk();
