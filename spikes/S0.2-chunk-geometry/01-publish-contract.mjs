// Register a throwaway minimal data contract on testnet.
//   blob: seq(int) + d0,d1,d2 byteArray maxItems 5120  -> 3-field payload search
//   wide: seq(int) + d byteArray maxItems 5300         -> per-field platform-cap probe
// Pass --dry to only validate local construction (no broadcast, no cost).
import { writeFileSync } from 'node:fs';
import { getSdk, disconnectSdk, loadIdentity, pickAuthKey, buildKeyAndSigner, log, evoSdk, PUT_SETTINGS } from './lib.mjs';

const DRY = process.argv.includes('--dry');
const { DataContract } = evoSdk;

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
const curNonce = await sdk.identities.nonce(ownerId);
const nextNonce = (curNonce ?? 0n) + 1n;
log(`Owner ${ownerId}, current identity nonce ${curNonce}, using ${nextNonce}`);

const contract = new DataContract({
  ownerId,
  identityNonce: nextNonce,
  schemas,
  fullValidation: true,
});
log(`Local DataContract constructed & validated. Provisional id: ${contract.id?.toString?.() ?? '(n/a)'}`);

if (DRY) {
  log('Dry run only — not broadcasting.');
  await disconnectSdk();
  process.exit(0);
}

const balBefore = Number(await sdk.identities.balance(ownerId));
log(`Balance before publish: ${balBefore} credits`);

const { publicKey, signer } = buildKeyAndSigner(critKey);
log('Publishing contract (contractPublish)...');
let published;
try {
  published = await sdk.contracts.publish({ dataContract: contract, identityKey: publicKey, signer, settings: PUT_SETTINGS });
} catch (e) {
  log(`PUBLISH ERROR: name=${e?.name} message=${e?.message} str=${String(e)}`);
  for (const p of Object.getOwnPropertyNames(e ?? {})) {
    try { log(`  prop ${p} = ${JSON.stringify(e[p])}`); } catch { log(`  prop ${p} = <unserializable>`); }
  }
  if (typeof e?.toString === 'function') log(`  toString: ${e.toString()}`);
  throw e;
}
const contractId = published.id.toString();
log(`Published contract id: ${contractId}`);

const balAfter = Number(await sdk.identities.balance(ownerId));
const cost = balBefore - balAfter;
log(`Balance after: ${balAfter} credits. Registration cost: ${cost} credits (~${(cost / 1e11).toFixed(6)} DASH)`);

const out = { contractId, ownerId, registrationCostCredits: cost, balBefore, balAfter, signingKeyId: critKey.id, signingKeyLevel: critKey.securityLevel };
writeFileSync(new URL('./contract.json', import.meta.url), JSON.stringify(out, null, 2));
await disconnectSdk();
console.log(JSON.stringify(out, null, 2));
